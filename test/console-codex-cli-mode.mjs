import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createConsoleApp } from "../src/console-app.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-cli-mode-"));
const wrapper = path.join(root, "worker.mjs"), trace = path.join(root, "trace.jsonl");
const ua = "codex_cli_rs/0.165.0 (Alpine Linux 3.24.1; x86_64) unknown (codex_cli_rs; 0.165.0)";
let probes = 0, uaPuts = 0;
let gatewaySettings = { openai_codex_user_agent: "old-UA", site_name: "preserve" };
const pool = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/v1/admin/settings") {
    assert.equal(req.headers["x-api-key"], "fixture-key");
    if (req.method === "PUT") { uaPuts++; gatewaySettings = JSON.parse(Buffer.concat(chunks)); }
    res.end(JSON.stringify({ code: 0, data: gatewaySettings })); return;
  }
  res.end(JSON.stringify({ code: 0, data: req.url.startsWith("/api/v1/admin/accounts") ? { items: [], total: 0, pages: 1 } : [] }));
});
let app;
try {
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
    import {seedWebSession} from ${JSON.stringify(new URL("./account-web-fixture.mjs", import.meta.url).href)};
    const arg=k=>process.argv[process.argv.indexOf(k)+1];const output=arg('--sub2api-out');
    const email=process.env.TOSUB2_CLI_PROFILE_EMAIL;
    await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({mode:process.env.TOSUB2_CODEX_AUTH_MODE,
      root:process.env.TOSUB2_CLI_PROFILE_ROOT,email,base:process.env.TOSUB2_OAUTH_BASE_URL,
      hasGatewayKey:process.env.TOSUB2_OAUTH_ADMIN_KEY==='fixture-key',proxy:process.env.CHATGPT_PROXY_URL})+'\\n');
    await fs.writeFile(output,JSON.stringify({type:'sub2api-data',version:1,accounts:[{platform:'openai',type:'oauth',
      credentials:{email,access_token:'fixture-access',refresh_token:'fixture-refresh',plan_type:'plus'},extra:{auth_provider:'codex_cli'}}]}));
    await seedWebSession(output);console.log('[ok] Saved sub2api import: '+output);
    if(process.connected)process.disconnect();process.stdin.destroy();`);
  process.env.ONBOARDING_PROTOCOL_SCRIPT = wrapper;
  process.env.LOCALAPPDATA = root;
  process.env.TOSUB2_CREDENTIAL_KEY = "ab".repeat(32);
  process.env.SUB2API_MONITOR_ENABLED = "0";
  await new Promise(resolve => pool.listen(0, "127.0.0.1", resolve));
  const poolBase = `http://127.0.0.1:${pool.address().port}`;
  app = createConsoleApp({ host: "127.0.0.1", port: 0, production: true, outputRoot: path.join(root, "data"), cliUaProbe: async () => { probes++; return ua; } });
  const { urls: [base] } = await app.start();
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(r => r.json());
  const headers = { "x-console-token": bootstrap.token, "content-type": "application/json" };
  const post = async (endpoint, body) => {
    const response = await fetch(base + endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const uaRead = "/api/codex-cli/ua/read", uaSync = "/api/codex-cli/ua/sync";
  assert.equal((await fetch(base + uaRead, { method: "POST", body: "{}" })).status, 403);
  assert.equal(probes, 0);
  assert.equal((await fetch(base + uaSync, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "{}" })).status, 403);
  const unconfigured = await post(uaRead, {});
  assert.equal(unconfigured.body.gateway.configured, false); assert.equal(unconfigured.body.cli.userAgent, ua);
  assert.equal((await post("/api/task-settings", { codexAuthMode: "cli" })).status, 409);
  assert.equal((await post("/api/sub2api/settings", { config: { baseUrl: poolBase, adminApiKey: "fixture-key", groupIds: [] } })).status, 200);
  const comparison = (await post(uaRead, {})).body;
  assert.equal(comparison.matches, false); assert.equal(probes, 1); assert.equal(uaPuts, 0);
  assert(!JSON.stringify(comparison).includes("fixture-key"));
  const confirmation = { contextId: comparison.contextId, cliUserAgent: comparison.cli.userAgent, gatewayUserAgent: comparison.gateway.userAgent };
  assert.equal((await post(uaSync, { ...confirmation, cliUserAgent: "browser-injected-UA" })).status, 409);
  const synced = await post(uaSync, confirmation);
  assert.equal(synced.status, 200); assert.equal(synced.body.matches, true); assert.equal(uaPuts, 1);
  assert.equal(gatewaySettings.site_name, "preserve");
  assert.equal((await post(uaSync, confirmation)).body.changed, false); assert.equal(uaPuts, 1);
  await post(uaRead, { refreshCli: true }); assert.equal(probes, 2);
  assert.equal((await post("/api/task-settings", { codexAuthMode: "cli" })).status, 200);
  const created = await post("/api/jobs", { email: "routing@example.test" });
  assert.equal(created.status, 201);
  let job;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    job = (await fetch(`${base}/api/jobs`, { headers }).then(r => r.json())).jobs.find(j => j.id === created.body.job.id);
    if (["completed", "failed"].includes(job?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job?.status, "completed", JSON.stringify(job));
  const calls = (await fs.readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls, [{ mode: "cli", root: path.join(root, "data", "codex-cli-profiles"), email: "routing@example.test", base: poolBase, hasGatewayKey: true, proxy: "" }]);
  assert(!JSON.stringify(job).includes("fixture-key"));
  const imported = JSON.parse(await fs.readFile(path.join(root, "data", job.id, "sub2api-import-oauth.json"), "utf8"));
  assert.equal(imported.accounts[0].extra.auth_provider, "codex_cli");
  assert.equal(uaPuts, 1, "worker authorization never triggers a UA write");
  console.log("CONSOLE_CLI_MODE_PASS authenticated UA comparison/manual sync, cross-site guard, cached probe, setting guard, worker mode, shared lock directory, account key, gateway config, completed export");
} finally {
  await app?.stop(); pool.closeAllConnections();
  await new Promise(resolve => pool.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
