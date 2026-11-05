import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-direct-ip-"));
const pool = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: req.url.startsWith("/api/v1/admin/accounts") ? { items: [], total: 0, pages: 1 } : [] }));
});
await new Promise(r => pool.listen(0, "127.0.0.1", r));
const marker = path.join(root, "lookups.txt"), preload = path.join(root, "preload.mjs");
await fs.writeFile(preload, `import fs from 'node:fs/promises';
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
 if (/^https:\\/\\/(api\\.ipify\\.org|icanhazip\\.com)/.test(String(url))) {
  await fs.appendFile(${JSON.stringify(marker)}, 'lookup\\n');
  await new Promise(r => setTimeout(r, 50));
  return Response.json({ip:'198.51.100.8'});
 }
 return original(url, options);
};`);
const listener = http.createServer();
await new Promise(r => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "src/console-server.mjs", "--port", String(port)], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" },
});
let logs = ""; child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
const exited = new Promise(r => child.once("exit", r));
try {
  let boot;
  for (let n = 0; n < 150; n++) {
    try { boot = await (await fetch(base + "/api/bootstrap")).json(); break; } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  assert(boot?.token, logs);
  assert.equal((await fetch(base + "/api/direct-ip")).status, 403);
  const options = await fetch(base + "/api/sub2api/options", { method: "POST", headers: { "x-console-token": boot.token, "content-type": "application/json" }, body: JSON.stringify({ config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture" } }) });
  assert.equal(options.status, 200);
  assert.equal((await options.json()).directIp, null);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  const results = await Promise.all(Array.from({ length: 8 }, async () => {
    const response = await fetch(base + "/api/direct-ip", { headers: { "x-console-token": boot.token } });
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.deepEqual(results, Array(8).fill({ ip: "198.51.100.8" }));
  assert.equal(await fs.readFile(marker, "utf8"), "lookup\n");
  console.log("DIRECT_IP_API_PASS unauthenticated=403; options never starts IP lookup; authenticated=200; eight clients share one server lookup; no external network");
} finally {
  child.kill("SIGTERM"); await exited;
  await new Promise(r => pool.close(r));
  await fs.rm(root, { recursive: true, force: true });
}
