import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-remarks-test-"));
const output = path.join(temp, "output");
const id = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const email = "remark@example.com";
const secret = "JBSWY3DPEHPK3PXP";
const records = [71, 72].map((id) => ({ id, platform: "openai", type: "oauth", name: email, status: "active", notes: "原有备注", credentials: { email, provider_field: "keep" }, extra: { email }, group_ids: [] }));
records.push({ ...records[0], id: 73, notes: "其他账号", credentials: { email: "other@example.com" } });
const puts = [];
const creates = [];
let failId = null;
let incomplete = false;
let delayedRead = null;
let child;
let headers;
let logs = "";
const remote = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET") {
    const account = records.find(account => req.url === `/api/v1/admin/accounts/${account.id}`);
    if (account) return res.end(JSON.stringify({ data: account }));
    const response = JSON.stringify({ data: { items: incomplete ? null : records, pages: 1, total: records.length } });
    if (delayedRead) {
      const barrier = delayedRead;
      delayedRead = null;
      barrier.started();
      await barrier.wait;
    }
    return res.end(response);
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const record = records.find((account) => req.url === `/api/v1/admin/accounts/${account.id}`);
  if (record && req.method === "PUT") {
    if (record.id === failId) { res.statusCode = 500; return res.end(JSON.stringify({ error: "fixture update failed" })); }
    puts.push({ id: record.id, body });
    Object.assign(record, body);
    return res.end(JSON.stringify({ data: record }));
  }
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") {
    creates.push(...body.accounts);
    for (const account of body.accounts) records.push({ ...account, id: Math.max(...records.map(record => record.id)) + 1 });
    return res.end(JSON.stringify({ success: body.accounts.length }));
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture-admin-key", groupIds: [] };
const slot = http.createServer();
await new Promise((resolve) => slot.listen(0, "127.0.0.1", resolve));
const port = slot.address().port;
await new Promise((resolve) => slot.close(resolve));
const base = `http://127.0.0.1:${port}`;

async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  for (let index = 0; index < 150; index++) {
    try {
      const data = await (await fetch(`${base}/api/bootstrap`)).json();
      headers = { "x-console-token": data.token, "content-type": "application/json" };
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(logs);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}
async function post(route, body, expected = 200) {
  const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
async function batch(line) { return post("/api/jobs/batch", { text: line }, 201); }
async function remark(text, expected) { return post(`/api/jobs/${id}/remark`, { remark: text }, expected); }
async function refresh() {
  const response = await fetch(`${base}/api/sub2api/account-status?refresh=1`, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function localJob() { return (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs.find((job) => job.id === id); }

try {
  for (const [jobId, jobEmail] of [[id, email], [newId, "new@example.com"]]) {
    const dir = path.join(output, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ email: jobEmail, status: "completed", pool_only: true, created_at: new Date().toISOString() }));
    await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ name: jobEmail, platform: "openai", type: "oauth", credentials: { email: jobEmail }, extra: { email: jobEmail } }] }));
  }
  await fs.writeFile(path.join(output, "sub2api-settings.json"), JSON.stringify(config));
  await fs.writeFile(path.join(output, "account-tag-options.json"), JSON.stringify({
    merchants: ["旧商家"], trips: ["旧车次"], removed: { validities: ["长效", "轮转"] },
  }));
  await start();
  await refresh();
  assert.equal((await localJob()).remark, "原有备注", "first pool sync imports complete notes");
  const tags = (patch, expected) => post("/api/jobs/" + id + "/tags", patch, expected);
  const tagOptions = async () => {
    const response = await fetch(base + "/api/account-tag-options", { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const legacyOptions = await tagOptions();
  assert(legacyOptions.merchants.includes("旧商家"));
  assert(legacyOptions.trips.includes("旧车次"));
  assert.deepEqual(legacyOptions.validities, ["长效", "轮转"]);
  async function removeTagOption(field, value, expected = 200) {
    const response = await fetch(base + "/api/account-tag-options", {
      method: "DELETE", headers, body: JSON.stringify({ field, value }),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const manual = " 康神头车非轮；客服说周五复查。\n  [自留]  请保留  ";
  assert.deepEqual((await remark(manual)).job.accountTags, { merchant: "康神", trip: "头车", validity: "长效", stopAt: "" });
  const tagged = await tags({ merchant: "新商家" });
  assert.equal(tagged.job.remark, manual + " [商家] 新商家, [车次] 头车, [时效] 长效。");
  assert.equal(records[0].notes, tagged.job.remark);
  await Promise.all([tags({ trip: "夜班车" }), tags({ validity: "轮转", stopAt: "2026-12-01T08:30" })]);
  const rotating = await localJob();
  assert.equal(rotating.remark, manual + " [商家] 新商家, [车次] 夜班车, [时效] 轮转, [停止时间] 2026-12-01 08:30。");
  await tags({ stopAt: "2026-02-30T08:30" }, 400);
  await tags({ merchant: "会,破坏分隔" }, 400);
  assert.equal((await localJob()).remark, rotating.remark);
  records[1].notes += "后补的文字";
  const longLived = await tags({ validity: "长效" });
  assert.equal(longLived.job.accountTags.stopAt, "");
  assert.equal(records[0].notes, manual + " [商家] 新商家, [车次] 夜班车, [时效] 长效。");
  assert.equal(records[1].notes, records[0].notes + "后补的文字");
  assert.equal(longLived.job.remark, records[1].notes);
  await tags({ merchant: "", trip: "", validity: "" });
  assert.equal(records[0].notes, manual);
  assert.equal(records[1].notes, manual + "后补的文字");
  await stop(); await start();
  assert.deepEqual((await localJob()).accountTags, { merchant: "", trip: "", validity: "", stopAt: "" });
  const rememberedOptions = await tagOptions();
  assert(["旧商家", "新商家"].every(value => rememberedOptions.merchants.includes(value)));
  assert(["旧车次", "夜班车"].every(value => rememberedOptions.trips.includes(value)));
  assert.deepEqual(rememberedOptions.validities, ["长效", "轮转"]);
  console.log("PASS: legacy catalogs without validity options retain saved merchants and trips through updates and restart");
  const withOptions = await tags({ merchant: "康神", trip: "夜班车", validity: "长效" });
  assert(!(await removeTagOption("merchant", "康神")).merchants.includes("康神"));
  assert(!(await removeTagOption("trip", "夜班车")).trips.includes("夜班车"));
  await removeTagOption("validity", "长效", 400);
  await removeTagOption("validity", "任意值", 400);
  assert.equal((await localJob()).remark, withOptions.job.remark);
  assert.deepEqual((await localJob()).accountTags, withOptions.job.accountTags);
  await tags({ validity: "轮转" });
  await stop(); await start();
  const hiddenOptions = await tagOptions();
  assert(!hiddenOptions.merchants.includes("康神") && !hiddenOptions.trips.includes("夜班车"));
  assert.deepEqual(hiddenOptions.validities, ["长效", "轮转"]);
  assert.equal((await localJob()).accountTags.merchant, "康神");
  assert.equal((await localJob()).accountTags.trip, "夜班车");
  await tags({ trip: "夜班车" });
  const restoredOptions = await tagOptions();
  assert(!restoredOptions.merchants.includes("康神") && restoredOptions.trips.includes("夜班车"));
  await removeTagOption("validity", "轮转", 400);
  const rotatingAfterRejection = await tags({ stopAt: "2026-12-01T08:30" });
  assert.equal(rotatingAfterRejection.job.accountTags.validity, "轮转");
  assert.equal(rotatingAfterRejection.job.accountTags.stopAt, "2026-12-01T08:30");
  assert.deepEqual((await tagOptions()).validities, ["长效", "轮转"]);
  console.log("PASS: fixed validity options ignore legacy removals and reject deletion");
  console.log("PASS: removing default and custom options preserves account tags and remarks, survives restart, and supports explicit re-creation");
  console.log("PASS: legacy aliases, custom choices across restarts, concurrent tag edits, rotation deadlines, per-record notes and clearing");
  const unauthorized = await fetch(`${base}/api/jobs/${id}/remark`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"remark":"forbidden"}' });
  assert.equal(unauthorized.status, 403);
  const first = await batch(`${email}----password(with-brackets)----${secret}(首批(测试)----A)`);
  assert.equal(first.jobs[0].remark, "首批(测试)----A");
  assert.equal(first.jobs[0].hasTotpKey, true);
  assert.equal(first.remarkSync.updated, 2);
  assert.equal(records[0].notes, "首批(测试)----A", "local save replaces the full note field");
  assert.equal(records[2].notes, "其他账号");
  assert(puts.every(({ body }) => Object.keys(body).join() === "notes"));
  const creds = await (await fetch(`${base}/api/jobs/${id}/credentials`, { headers })).json();
  assert.equal(creds.credentials.password, "password(with-brackets)");
  assert.equal(creds.credentials.totpSecret, secret);
  await batch(`${email}----password(with-brackets)----${secret}`);
  const preserved = await batch(email);
  assert.equal(preserved.jobs[0].remark, "首批(测试)----A", "omitting a remark must preserve it");
  assert.equal(preserved.jobs[0].hasTotpKey, true);
  const fullwidth = await batch(`${email}----password(with-brackets)----${secret}（中文括号）`);
  assert.equal(fullwidth.jobs[0].remark, "中文括号");
  const count = puts.length;
  await remark("中文括号");
  assert.equal(puts.length, count, "repeat save must not duplicate notes");
  await remark("x".repeat(2001), 400);
  await remark(17, 400);
  await remark("空字符\u0000备注", 400);
  await post(`/api/jobs/${id}/remark`, {}, 400);
  failId = 72;
  const partial = await remark("可重试备注");
  assert.equal(partial.job.remark, "可重试备注");
  assert.equal(partial.sub2api.updated, 1);
  assert.equal(partial.sub2api.failed, 1);
  assert(partial.sub2api.error);
  assert.equal((await localJob()).remarkSyncPending, true);
  await refresh();
  assert.equal((await localJob()).remark, "可重试备注", "failed local save must survive polling");
  failId = null;
  await refresh();
  assert.equal((await localJob()).remarkSyncPending, false);
  assert(records.slice(0, 2).every((account) => account.notes === "可重试备注"));
  records[1].notes = "远端编辑\n多行内容";
  const remoteEdit = await refresh();
  assert.equal(remoteEdit.accounts[email].remark, "远端编辑\n多行内容");
  assert.equal((await localJob()).remark, "远端编辑\n多行内容");
  await refresh();
  assert.equal((await localJob()).remark, "远端编辑\n多行内容", "duplicate records must not make notes oscillate");
  const remoteMultilineExport = await (await fetch(`${base}/api/jobs/${id}/download`, { headers })).json();
  assert.equal(remoteMultilineExport.accounts[0].notes, "远端编辑\n多行内容");
  records[1].notes = null;
  await refresh();
  assert.equal((await localJob()).remark, "", "remote clear must clear local notes");
  await remark("本地多行\n第二行");
  assert(records.slice(0, 2).every((account) => account.notes === "本地多行\n第二行"));
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  delayedRead = { started: readStarted, wait: new Promise((resolve) => { releaseRead = resolve; }) };
  const staleRefresh = refresh();
  await started;
  await remark("并发保存的新备注");
  releaseRead();
  await staleRefresh;
  assert.equal((await localJob()).remark, "并发保存的新备注", "an older in-flight pool read must not overwrite a completed local save");
  incomplete = true;
  const beforeIncomplete = puts.length;
  assert((await remark("列表不完整")).sub2api.error);
  assert.equal(puts.length, beforeIncomplete);
  await stop();
  await start();
  const restored = (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs.find((job) => job.id === id);
  assert.equal(restored.remark, "列表不完整");
  assert.equal(restored.remarkSyncPending, true, "pending local note survives restart");
  incomplete = false;
  await refresh();
  assert(records.slice(0, 2).every((account) => account.notes === "列表不完整"));
  await remark("中文括号");
  await post("/api/sub2api/upload", { ids: [id], config });
  assert(records.slice(0, 2).every((account) => account.notes === "中文括号"));
  records[0].notes = "上传前号池新备注";
  await post("/api/sub2api/upload", { ids: [id], config });
  assert.equal(records[0].notes, "上传前号池新备注", "routine upload must preserve a newer pool edit");
  await refresh();
  assert.equal((await localJob()).remark, "上传前号池新备注");
  await remark("中文括号");
  const source = await (await fetch(`${base}/api/jobs/export-source`, { method: "POST", headers, body: JSON.stringify({ ids: [id] }) })).text();
  assert(source.includes(`${secret}(中文括号)`));
  const download = await (await fetch(`${base}/api/jobs/${id}/download`, { headers })).json();
  assert.equal(download.accounts[0].notes, "中文括号");
  const downloadBatch = await (await fetch(`${base}/api/jobs/download-batch`, { method: "POST", headers, body: JSON.stringify({ ids: [id] }) })).json();
  assert.equal(downloadBatch.accounts[0].notes, "中文括号");
  await post(`/api/jobs/${newId}/remark`, { remark: "新号备注" });
  await post("/api/sub2api/upload", { ids: [newId], config });
  assert.equal(creates.at(-1).notes, "新号备注");
  await remark("");
  assert(records.slice(0, 2).every((account) => account.notes === ""), "local clear must clear the pool notes");
  await post("/api/mail-request-config", { config: { method: "POST", url: "https://mail.example.test/messages", headers: {} } });
  const postMail = await batch(`${email}----password(with-brackets)----mailbox_id=fixture----${secret}(POST备注)`);
  assert.equal(postMail.jobs[0].remark, "POST备注");
  assert.equal(postMail.jobs[0].hasTotpKey, true);
  console.log("PASS: bidirectional notes, remote/local edits and clears, multiline notes, stable duplicate selection, pending-write polling/restart/retry, concurrent stale read, routine upload preserves newer pool edit, suffix parsing, password parentheses, authentication, validation, incomplete listing, export/download, existing/new upload, POST mail mode");
} finally {
  await stop();
  await new Promise((resolve) => remote.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
