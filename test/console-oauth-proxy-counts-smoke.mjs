import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-oauth-proxy-counts-"));
const proxies = [
  { id: 1, host: "proxy-a.test", port: 8080, ip_address: "198.51.100.10" },
  { id: 2, host: "proxy-a2.test", port: 8080, ip_address: "198.51.100.10" },
  { id: 3, host: "proxy-b.test", port: 8080, ip_address: "198.51.100.20" },
];
const accounts = [
  { id: 1, platform: "openai", type: "apikey", proxy_id: 3, credentials: { email: "collision@example.test" } },
  { id: 2, platform: "openai", type: "apikey", proxy_id: 3 },
  { id: 3, platform: "openai", type: "apikey", proxy_id: null },
  { id: 4, platform: "openai", type: "oauth", proxy_id: 1, credentials: { email: "pool@example.test" } },
  { id: 5, platform: "openai", type: "oauth", proxy_id: null, credentials: { email: "direct@example.test" } },
  { id: 6, platform: "openai", type: "oauth", proxy_id: 3, credentials: { email: "POOL@example.test" } },
  { id: 7, platform: "anthropic", type: "oauth", proxy_id: 1, credentials: { email: "other-platform@example.test" } },
];
const remote = http.createServer((req, res) => {
  assert.equal(req.method, "GET", "distribution checks must not mutate pool accounts");
  const route = new URL(req.url, "http://fixture").pathname;
  res.setHeader("content-type", "application/json");
  const data = route === "/api/v1/admin/proxies/all" ? proxies
    : route === "/api/v1/admin/groups/all" ? []
    : route === "/api/v1/admin/accounts" ? { items: accounts, total: accounts.length, pages: 1 }
    : null;
  res.statusCode = data === null ? 404 : 200;
  res.end(JSON.stringify({ data }));
});
const freePort = async () => {
  const listener = http.createServer();
  await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  return port;
};
await new Promise(r => remote.listen(0, "127.0.0.1", r));
const pool = `http://127.0.0.1:${remote.address().port}`;
try {
  for (const mode of ["global", "sub2api", "plan"]) {
    const root = path.join(temp, mode);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "task-settings.json"), JSON.stringify({ maxActiveJobs: 4, accountProxyMode: mode, codexAuthMode: "local", accountProxyCooldownMinutes: 60 }));
    const locals = [
      { email: "pool@example.test", proxy: 3, saved: true },
      { email: "local@example.test", proxy: 1, saved: true },
      { email: "collision@example.test", proxy: 1, saved: true },
      { email: "local-direct@example.test", proxy: null, saved: true },
      { email: "canceled-bound@example.test", proxy: 3, saved: false },
      { email: "canceled-direct@example.test", proxy: null, saved: false },
    ];
    for (const [index, job] of locals.entries()) {
      const dir = path.join(root, `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email: job.email, status: job.saved ? "completed" : "canceled", result_saved: job.saved, assigned_proxy_id: job.proxy, authorization_proxy_selected: true, created_at: "2026-11-01T00:00:00Z" }));
      if (job.saved) await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email: job.email, access_token: "fixture", refresh_token: "fixture" } }] }));
    }
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [process.env.OAUTH_PROXY_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" },
    });
    let logs = "";
    child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
    const exited = new Promise(r => child.once("exit", r));
    try {
      let boot;
      for (let n = 0; n < 150; n++) {
        try { boot = await (await fetch(base + "/api/bootstrap")).json(); break; } catch {}
        if (child.exitCode !== null) throw new Error(logs);
        await new Promise(r => setTimeout(r, 100));
      }
      assert(boot?.token, logs);
      const response = await fetch(base + "/api/sub2api/options", { method: "POST", headers: { "x-console-token": boot.token, "content-type": "application/json" }, body: JSON.stringify({ config: { baseUrl: pool, adminApiKey: "fixture" } }) });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      const counts = result.proxies.map(p => p.accountCount);
      const expected = mode === "global" ? [1, 1, 0] : [2, 2, 1];
      console.log(JSON.stringify({ mode, counts, directAccountCount: result.directAccountCount }));
      assert.deepEqual(counts, expected, "proxy counts must include only OpenAI OAuth accounts, deduplicate emails, and exclude incomplete local tasks");
      assert.equal(result.directAccountCount, mode === "global" ? 1 : 2, "unassigned count must exclude API Key and incomplete local tasks");
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }
  console.log("OAUTH_PROXY_COUNTS_PASS global/sub2api/plan; API Key excluded; shared IPs and emails deduplicated; incomplete local tasks excluded");
} finally {
  await new Promise(r => remote.close(r));
  await fs.rm(temp, { recursive: true, force: true });
}
