import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createConsoleApp } from "../src/console-app.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ops-http-")),
  id = crypto.randomUUID(),
  email = "operations@example.test",
  proxy = {
    id: 7,
    ip_address: "192.0.2.9",
    name: "test",
    protocol: "http",
    host: "test.invalid",
    port: 81,
    status: "active",
    created_at: new Date().toISOString(),
  };
const remote = {
  id: 3,
  name: email,
  email,
  platform: "openai",
  type: "oauth",
  status: "active",
  schedulable: true,
  proxy_id: null,
  credentials: { email },
  extra: {},
};
const models = ["text-a", "text-b", "codex-auto-review", "gpt-reserve"];
let syncCalls = 0, configuredListCalls = 0, credentialExports = 0, failSync = false;
let answer,
  sampled = 0;
const pending = new Promise((r) => (answer = r));
const pool = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  if (p === "/api/v1/admin/accounts/3/models/sync-upstream") {
    syncCalls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-api-key"], "fixture");
    assert.deepEqual(JSON.parse(body), {});
    res.setHeader("content-type", "application/json");
    if (failSync) {
      res.writeHead(403);
      res.end(JSON.stringify({ message: "private-fixture-error" }));
    } else {
      res.end(JSON.stringify({ code: 0, data: { models, metadata: { "mapping-only": {} } } }));
    }
    return;
  }
  if (/\/accounts\/\d+\/models$/.test(p)) configuredListCalls++;
  if (p === "/api/v1/admin/accounts/data" || p === "/api/v1/admin/proxies/data") credentialExports++;
  if (p === "/api/v1/admin/accounts/data") {
    assert.equal(new URL(req.url, "http://localhost").searchParams.get("ids"), "3");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 0, data: { accounts: [
      { ...remote, credentials: { email, access_token:"fixture-for-the-fake-sampler" } }
    ], proxies: [] } }));
    return;
  }
  const data =
    p === "/api/v1/admin/accounts"
      ? { items: [remote], total: 1, pages: 1 }
      : p.endsWith("/accounts/3/models")
        ? [{ id: "mapping-only" }]
        : p.endsWith("/accounts/3")
          ? remote
          : p.endsWith("/proxies/all")
            ? [proxy]
            : p.endsWith("/proxies")
              ? { items: [proxy], total: 1 }
              : p.endsWith("/usage/stats")
                ? { total_actual_cost: 7.75 }
                : p.includes("/groups")
                  ? []
                  : {};
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: 0, data }));
});
await new Promise((r) => pool.listen(0, "127.0.0.1", r));
const poolUrl = "http://127.0.0.1:" + pool.address().port;
let app;
try {
  const dir = path.join(root, id),
    webRoot = path.join(root, "web");
  await fs.mkdir(dir);
  await fs.mkdir(path.join(webRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(webRoot, "dist", "index.html"),
    "<!doctype html><title>fixture</title>",
  );
  const created = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, "job-meta.json"),
    JSON.stringify({
      version: 1,
      email,
      status: "completed",
      result_saved: true,
      created_at: created,
      plan_type: "plus",
    }),
  );
  await fs.writeFile(
    path.join(dir, "sub2api-import-oauth.json"),
    JSON.stringify({
      type: "sub2api-data",
      accounts: [
        { credentials: { email, access_token: "fixture", plan_type: "plus" } },
      ],
    }),
  );
  app = createConsoleApp({
    production: true,
    outputRoot: root,
    webRoot,
    port: 0,
    accountChatSampler: async (c, a, m, q, sig, opts) => {
      sampled++;
      assert.equal(c.baseUrl, poolUrl);
      assert.equal(a.id, 3);
      assert.equal(m, "text-b");
      assert.equal(opts.upstreamModel, true);
      assert.equal(opts.messages.at(-1).content, q);
      await pending;
      return "answer to " + q;
    },
  });
  const {
      urls: [base],
    } = await app.start(),
    token = (await fetch(base + "/api/bootstrap").then((r) => r.json())).token;
  async function api(p, body, method = body === undefined ? "GET" : "POST") {
    const r = await fetch(base + p, {
      method,
      headers: { "x-console-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { code: r.status, data: await r.json() };
  }
  const setup = await api("/api/sub2api/settings", {
    config: { baseUrl: poolUrl, adminApiKey: "fixture" },
    profiles: [],
    planTypeBindings: {},
  });
  assert.equal(setup.code, 200, JSON.stringify(setup.data));
  const policy = "/api/sub2api/proxies/7/allocation";
  assert.equal((await api(policy)).data.allocationPaused, false);
  assert.equal(
    (await api(policy, { allocationPaused: true, ipCostCny: 3.5 }, "PUT")).data
      .allocationPaused,
    true,
  );
  assert.equal(
    (await api("/api/jobs/" + id + "/inspection-pause", { paused: true })).data
      .job.inspectionPaused,
    true,
  );
  assert.equal(
    (await api("/api/jobs/" + id + "/chat/models?remoteId=99")).code,
    409,
  );
  const catalogPath = "/api/jobs/" + id + "/chat/models";
  const baselineExports = credentialExports;
  assert.equal(syncCalls, 0);
  assert.equal((await fetch(base+catalogPath, {method:"POST"})).status, 403);
  assert.equal((await api(catalogPath, {remoteId: "99"})).code, 409);
  assert.equal(syncCalls, 0, "unauthorized/mismatched requests must not query another account");
  const native = await api(catalogPath, { remoteId: "3" });
  assert.equal(native.code, 200);
  assert.deepEqual(native.data, { id: "3", source:"sub2api-sync-upstream", models, hasWarnings:false });
  assert.deepEqual((await api(catalogPath + "?remoteId=3")).data.models, models);
  assert.equal(syncCalls, 1, "GET and chat validation share only the matching account's cache");
  assert.equal(credentialExports, baselineExports, "discovery must not export an account or proxy secret");
  assert.equal((await api("/api/jobs/"+id+"/chat", {
    id:crypto.randomUUID(), remoteId:"3", model:"mapping-only", question:"fixture",
  })).code, 400);
  assert.equal(sampled, 0);
  failSync = true;
  const failed = await api(catalogPath, {remoteId:"3"});
  assert.equal(failed.code, 502);
  assert.match(failed.data.error, /HTTP 403/);
  assert(!failed.data.error.includes("private-fixture-error"));
  assert.equal((await api(catalogPath + "?remoteId=3")).code, 502, "no stale fallback");
  failSync = false;
  assert.deepEqual((await api(catalogPath, {remoteId:"3"})).data.models, models);
  assert.equal(configuredListCalls, 0);
  assert.equal(credentialExports, baselineExports);
  const filtered=(await api("/api/jobs?status=inspection_paused")).data;
  assert.equal(filtered.jobs.length,1);
  assert.equal(filtered.jobs[0].displayStatus,"inspection_paused");
  assert.equal(filtered.jobs[0].status,"completed","presentation must not change runtime status");
  assert(filtered.filterOptions.statuses.includes("inspection_paused"));
  assert.equal((await api("/api/project-update")).data.current,JSON.parse(await fs.readFile(new URL("../package.json",import.meta.url),"utf8")).version);
  assert.equal((await fetch(base+"/api/project-update/install",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,403);
  assert.equal((await api("/api/project-update/install",{confirm:false})).code,400);
  const start = await api("/api/jobs/" + id + "/chat", {
    id: crypto.randomUUID(),
    remoteId: "3",
    model: "text-b",
    question: "fixture question",
  });
  assert.equal(start.code, 202, JSON.stringify(start));
  assert.equal(
    (await api("/api/jobs/" + id + "/chat")).data.turns[0].state,
    "running",
  );
  assert.equal((await api("/api/jobs")).code, 200);
  answer();
  let t;
  for (let i = 0; i < 50; i++) {
    [t] = (await api("/api/jobs/" + id + "/chat")).data.turns;
    if (t.state !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(t.answer, "answer to fixture question");
  assert.equal(sampled, 1);
  const fin = await api("/api/finance/daily", {});
  assert.equal(fin.code, 200);
  assert.equal(fin.data.ipCostCents, 350);
  assert.equal(fin.data.incomeCents, 775);
  assert.equal((await api("/api/finance/daily?day=2000-01-01", {})).code, 409);
  console.log(
    "HELPER_OPS_HTTP_PASS authorization, persisted pause, node policy, private accounting, native account upstream sync, pinned background chat and interactive list",
  );
} finally {
  answer();
  await app?.stop();
  pool.closeAllConnections?.();
  await new Promise((r) => pool.close(r));
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
