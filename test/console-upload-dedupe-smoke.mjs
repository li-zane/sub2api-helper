import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { PoolUploadIntents } from "../src/pool-upload-intents.mjs";
import { spawn } from "node:child_process";

const project = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-upload-dedupe-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let rows = [], nextId = 100, heldCommit = null, holdFirst = true, dropUncertain = true, hideUncertain = false;
let hidePartial = true;
let dropPendingBody = true, hidePendingBody = false, dropPendingVisible = true, dropPendingDeleted = true;
const creates = [], updates = [], idempotency = new Map();
const pool = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const json = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.method === "GET" && url.pathname === "/api/v1/admin/accounts") {
    const visible = rows.filter(row => !(hidePartial && row.credentials?.email === "partial-failure@example.test") && !(hideUncertain && row.credentials?.email === "uncertain@example.test") &&
      !(hidePendingBody && row.credentials?.email === "pending-body@example.test"));
    return json(200, { data: { items: visible, pages: 1, total: visible.length } });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/admin/groups/all") return json(200, { data: [{ id: 1, name: "fixture", platform: "openai", status: "active" }] });
  if (req.method === "GET" && url.pathname === "/api/v1/admin/proxies/all") return json(200, { data: [] });
  const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (match) {
    const row = rows.find(row => row.id === Number(match[1]));
    if (!row) return json(404, { message: "not found" });
    if (req.method === "PUT") { updates.push(row.id); Object.assign(row, body, { updated_at: new Date().toISOString() }); }
    return json(200, { data: row });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/admin/accounts/batch") {
    const key = req.headers["idempotency-key"], emails = body.accounts.map(account => account.credentials?.email);
    creates.push({ key, emails, accounts: structuredClone(body.accounts) });
    const fingerprint = JSON.stringify(body);
    const cached = idempotency.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) return json(409, { message: "idempotency payload differs" });
      hideUncertain = false;
      if (emails.includes("pending-body@example.test")) hidePendingBody = false;
      return json(200, cached.response);
    }
    if (body.accounts[0].proxy_id === 0) {
      const response = { data: { success: 0, failed: 1, results: [{ name: body.accounts[0].name, success: false, error: 'ent: constraint failed: pq: insert or update on table "accounts" violates foreign key constraint "accounts_proxy_id_fkey"'  }] } };
      idempotency.set(key, { fingerprint, response });
      return json(200, response);
    }
    const commit = () => {
      const created = body.accounts.map(account => ({ ...structuredClone(account), id: nextId++, created_at: new Date().toISOString() }));
      rows.push(...created);
      const response = { data: { success: created.length, failed: 0, results: created.map(row => ({ name: row.name, id: row.id, success: true })) } };
      idempotency.set(key, { fingerprint, response });
      return response;
    };
    if (emails.includes("race@example.test") && holdFirst) {
      holdFirst = false;
      heldCommit = () => json(200, commit());
      return;
    }
    if (emails.includes("partial-failure@example.test")) {
      commit(); // Simulate Create committing before BindGroups returns an error.
      const response = { data: { success: 0, failed: 1, results: [{ name: body.accounts[0].name, success: false, error: "group binding FK failed after insert" }] } };
      idempotency.set(key, { fingerprint, response });
      return json(200, response);
    }
    const response = commit();
    if (emails.includes("uncertain@example.test") && dropUncertain) {
      dropUncertain = false; hideUncertain = true; res.destroy(); return;
    }
    if (emails.includes("pending-body@example.test") && dropPendingBody) {
      dropPendingBody = false; hidePendingBody = true; res.destroy(); return;
    }
    if (emails.includes("pending-visible@example.test") && dropPendingVisible) {
      dropPendingVisible = false; res.destroy(); return;
    }
    if (emails.includes("pending-deleted@example.test") && dropPendingDeleted) {
      dropPendingDeleted = false; res.destroy(); return;
    }
    return json(200, response);
  }
  json(404, { message: "unexpected fixture endpoint" });
});

async function safeListen(server) {
  while (true) {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    if (port > 10080) return port;
    await new Promise(resolve => server.close(resolve));
  }
}
const poolUrl = `http://127.0.0.1:${await safeListen(pool)}`;
const listener = http.createServer(), port = await safeListen(listener); await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`, ids = Array.from({ length: 14 }, (_, n) => `11111111-1111-4111-8111-${String(n + 1).padStart(12, "0")}`);
const cases = [["race@example.test", "race-token"], ["batch@example.test", "batch-token"], ["batch@example.test", "batch-token"],
  ["mixed@example.test", "mixed-token"], ["uncertain@example.test", "uncertain-token"], ["conflict@example.test", "first-token"], ["conflict@example.test", "second-token"],
  ["pending-body@example.test", "old-body-token"], ["pending-body@example.test", "new-body-token"], ["pending-visible@example.test", "visible-token"],
  ["pending-deleted@example.test", "deleted-token"], ["legacy-direct@example.test", "legacy-token"], ["new-direct@example.test", "new-token"], ["partial-failure@example.test", "partial-token"]];
for (const [n, [email, token]] of cases.entries()) {
  const dir = path.join(temp, ids[n]); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true,
    last_operation_type: "relogin", created_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-01T00:01:00Z" }));
  await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ name: `oauth---${email}`, platform: "openai", type: "oauth",
    credentials: { email, access_token: token, refresh_token: `${token}-refresh`, plan_type: "free" }, extra: { email, plan_type: "free" } }] }));
}
// Simulate an old-version uncertain request with the broken zero foreign key.
const oldIntentStore = new PoolUploadIntents({ filePath: path.join(temp, "pool-upload-intents.json") });
const legacyAccount = { name: "oauth---legacy-direct@example.test", platform: "openai", type: "oauth", proxy_id: 0,
  credentials: { email: "legacy-direct@example.test", access_token: "legacy-token", refresh_token: "legacy-token-refresh", plan_type: "free" }, extra: {} };
const legacyIntent = await oldIntentStore.prepare({ baseUrl: poolUrl }, legacyAccount);
let output = "", headers, child;
const wait = async fn => { const end = Date.now() + 20000; while (Date.now() < end) { const result = await fn().catch(() => null); if (result) return result; if (child && child.exitCode !== null) throw Error("fixture helper exited\n" + output); await pause(30); } throw Error("fixture wait timeout\n" + output); };
async function upload(selected) {
  const r = await fetch(base + "/api/sub2api/upload", { method: "POST", headers, body: JSON.stringify({ ids: selected, config: { baseUrl: poolUrl, adminApiKey: "fixture-admin-key", groupIds: [1], proxyId: "direct" } }) });
  return { status: r.status, data: await r.json() };
}
async function startHelper() {
  child = spawn(process.execPath, [process.env.UPLOAD_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: project, windowsHide: true, env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp,
      LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const boot = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stopHelper() {
  if (child?.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; }
}
try {
  await startHelper();

  let firstResult;
  const first = upload([ids[0]]).then(result => { firstResult = result; return result; });
  await wait(async () => heldCommit !== null || firstResult);
  if (!heldCommit) throw new Error("First fixture upload exited before create hold: " + JSON.stringify(firstResult));
  let secondDone = false; const second = upload([ids[0]]).then(result => { secondDone = true; return result; });
  if (process.argv.includes("--baseline")) {
    await wait(async () => creates.length >= 2); heldCommit(); heldCommit = null;
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.equal(rows.filter(row => row.credentials?.email === "race@example.test").length, 2);
    console.log("UPLOAD_DEDUPE_BASELINE_REPRODUCED two manual uploads overlapped list-before-create and created 2 same-email OAuth rows");
    process.exitCode = 1;
  } else {
    await pause(1000);
    assert.equal(creates.length, 1, "second same-email upload entered create before first critical section finished");
    assert.equal(secondDone, false, "same-email upload completed while the first creation was uncommitted");
    heldCommit(); heldCommit = null;
    assert.equal((await first).status, 200); assert.equal((await second).status, 200);
    assert.equal(rows.filter(row => row.credentials?.email === "race@example.test").length, 1);

    assert.equal((await upload([ids[1], ids[2]])).status, 200);
    assert.equal(rows.filter(row => row.credentials?.email === "batch@example.test").length, 1, "same-email jobs were placed twice into a single create batch");
    const createsBeforeConflict = creates.length;
    assert.equal((await upload([ids[5], ids[6]])).status, 409, "conflicting same-email credentials must not pick an arbitrary record");
    assert.equal(creates.length, createsBeforeConflict);

    const apiKey = { id: 500, name: "mixed@example.test", platform: "openai", type: "apikey", status: "active", schedulable: true,
      credentials: { email: "mixed@example.test", api_key: "fixture-key-untouched" }, extra: {} };
    rows.push(apiKey); const originalApiKey = JSON.stringify(apiKey);
    assert.equal((await upload([ids[3]])).status, 200);
    assert.equal(JSON.stringify(apiKey), originalApiKey, "OAuth upload overwrote an API-key account sharing the email");
    assert.equal(rows.filter(row => row.credentials?.email === "mixed@example.test" && row.type === "oauth").length, 1);
    assert.equal((await upload([ids[3]])).status, 200); assert(!updates.includes(500));

    const uncertain = await upload([ids[4]]); assert(uncertain.status >= 400, "fixture commit-disconnect must surface failure");
    assert.equal((await upload([ids[4]])).status, 200);
    const uncertainCalls = creates.filter(call => call.emails.includes("uncertain@example.test"));
    assert.equal(uncertainCalls.length, 2); assert.equal(uncertainCalls[0].key, uncertainCalls[1].key, "commit-unknown retry changed idempotency key");
    assert.equal(rows.filter(row => row.credentials?.email === "uncertain@example.test").length, 1);

    const confirmedBefore = rows.find(row => row.credentials?.email === "race@example.test");
    const confirmedKeyBefore = creates.find(call => call.emails.includes("race@example.test")).key;
    rows = rows.filter(row => row.id !== confirmedBefore.id); // External pool deletion, not a helper request.
    assert.equal((await upload([ids[0]])).status, 200);
    const recreated = rows.filter(row => row.credentials?.email === "race@example.test");
    assert.equal(recreated.length, 1, "confirmed external deletion replayed cached success without recreating a row");
    assert.notEqual(recreated[0].id, confirmedBefore.id, "external deletion reused a deleted account ID");
    assert.notEqual(creates.filter(call => call.emails.includes("race@example.test")).at(-1).key, confirmedKeyBefore,
      "confirmed external deletion must start a new creation intent/key even for identical payload");

    const oldBody = await upload([ids[7]]);
    assert(oldBody.status >= 400, "pending-body fixture must commit and disconnect");
    await stopHelper(); await startHelper(); // Recover durable original body/key in a fresh helper process.
    assert.equal((await upload([ids[8]])).status, 200);
    const pendingBodyCalls = creates.filter(call => call.emails.includes("pending-body@example.test"));
    assert.equal(pendingBodyCalls.length, 2, "pending old intent should replay its original request before applying new body");
    assert.equal(pendingBodyCalls[0].key, pendingBodyCalls[1].key, "pending payload change generated a duplicate-create key");
    assert.deepEqual(pendingBodyCalls[0].accounts, pendingBodyCalls[1].accounts, "pending retry changed its frozen request body");
    const pendingBodyRows = rows.filter(row => row.credentials?.email === "pending-body@example.test");
    assert.equal(pendingBodyRows.length, 1, "pending-body recovery created another OAuth row");
    assert.equal(pendingBodyRows[0].credentials.access_token, "new-body-token", "latest payload was lost after recovery of the old pending body");
    assert(updates.includes(pendingBodyRows[0].id), "new payload must update the recovered existing row");

    const pendingVisible = await upload([ids[9]]);
    assert(pendingVisible.status >= 400, "pending-visible fixture must commit and disconnect");
    assert.equal((await upload([ids[9]])).status, 200, "visible pending creation should recover via normal listing/update");
    const visibleBefore = rows.find(row => row.credentials?.email === "pending-visible@example.test");
    const visibleKeyBefore = creates.find(call => call.emails.includes("pending-visible@example.test")).key;
    assert(visibleBefore && updates.includes(visibleBefore.id));
    rows = rows.filter(row => row.id !== visibleBefore.id);
    assert.equal((await upload([ids[9]])).status, 200);
    const visibleRecreated = rows.filter(row => row.credentials?.email === "pending-visible@example.test");
    assert.equal(visibleRecreated.length, 1,
      "normal listing/update left intent pending: external deletion replayed cached success without recreating a row");
    assert.notEqual(visibleRecreated[0].id, visibleBefore.id);
    assert.notEqual(creates.filter(call => call.emails.includes("pending-visible@example.test")).at(-1).key, visibleKeyBefore,
      "listing-confirmed pending intent must receive a fresh key after external deletion");

    assert((await upload([ids[10]])).status >= 400, "pending-deleted fixture must commit and disconnect");
    rows = rows.filter(row => row.credentials?.email !== "pending-deleted@example.test");
    assert((await upload([ids[10]])).status >= 400, "cached success for a deleted pending row must not be reported as an upload success");
    assert.equal((await upload([ids[10]])).status, 200);
    const deletedCalls = creates.filter(call => call.emails.includes("pending-deleted@example.test"));
    assert.equal(deletedCalls.length, 3);
    assert.equal(deletedCalls[0].key, deletedCalls[1].key, "unknown commit must first replay its durable original key");
    assert.notEqual(deletedCalls[1].key, deletedCalls[2].key, "confirmed absent cached row must use a fresh creation generation");
    assert.equal(rows.filter(row => row.credentials?.email === "pending-deleted@example.test").length, 1);

    const rejected = await upload([ids[11]]);
    assert(rejected.status >= 400);
    assert.match(rejected.data.error, /POOL_UPLOAD_REJECTED:.*accounts_proxy_id_fkey/, "actual batch item rejection was hidden");
    assert.equal(rows.filter(row => row.credentials?.email === "legacy-direct@example.test").length, 0);
    const rejectedStore = JSON.parse(await fs.readFile(path.join(temp, "pool-upload-intents.json"), "utf8"));
    assert.equal(Object.values(rejectedStore.entries).find(e => e.email === "legacy-direct@example.test").state, "rejected");
    await stopHelper(); await startHelper();
    assert.equal((await upload([ids[11]])).status, 200, "confirmed rejection did not allow corrected creation after restart");
    const legacyCalls = creates.filter(call => call.emails.includes("legacy-direct@example.test"));
    assert.equal(legacyCalls.length, 2); assert.equal(legacyCalls[0].key, legacyIntent.key);
    assert.equal(legacyCalls[0].accounts[0].proxy_id, 0, "unknown old intent must first replay unchanged");
    assert.notEqual(legacyCalls[0].key, legacyCalls[1].key);
    assert(!Object.hasOwn(legacyCalls[1].accounts[0], "proxy_id"), "corrected direct create sent zero FK");
    assert.equal(rows.filter(row => row.credentials?.email === "legacy-direct@example.test").length, 1);
    assert.equal((await upload([ids[12]])).status, 200);
    assert(!Object.hasOwn(creates.find(call => call.emails.includes("new-direct@example.test")).accounts[0], "proxy_id"));
    assert.equal((await upload([ids[12]])).status, 200);
    assert.equal(rows.find(row => row.credentials?.email === "new-direct@example.test").proxy_id, 0, "existing direct update must retain unbind semantics");

    assert((await upload([ids[13]])).status >= 400);
    assert((await upload([ids[13]])).status >= 400);
    const partialCalls = creates.filter(call => call.emails.includes("partial-failure@example.test"));
    assert.equal(partialCalls.length, 2); assert.equal(partialCalls[0].key, partialCalls[1].key, "post-insert failure changed key and risked duplicate creation");
    assert.equal(rows.filter(row => row.credentials?.email === "partial-failure@example.test").length, 1);
    hidePartial = false;
    assert.equal((await upload([ids[13]])).status, 200);
    assert.equal(rows.filter(row => row.credentials?.email === "partial-failure@example.test").length, 1);

    console.log("UPLOAD_DEDUPE_HTTP_PASS post-insert group-failure keeps original key; real results receipts; direct-create zero-FK omission; legacy explicit-rejection restart recovery with new key; held-create serialization; same-email batch collapse/conflict409; API-key/OAuth isolation; commit-unknown stable-key retry; confirmed and listing-recovered external deletion with fresh keys; process-restart pending-body recovery and latest-body update; cached deleted-ID rejection then new-generation recreation");
  }
} finally {
  if (heldCommit) { heldCommit(); heldCommit = null; }
  await stopHelper();
  pool.closeAllConnections?.(); await new Promise(resolve => pool.close(resolve)); await fs.rm(temp, { recursive: true, force: true });
}
