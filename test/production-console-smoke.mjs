import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-production-"));
const listener = http.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
  env: { ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root, SUB2API_MONITOR_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let logs = ""; child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
const exited = new Promise(r => child.once("exit", r));
try {
  let boot; const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { boot = await (await fetch(base + "/api/bootstrap")).json(); break; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 100));
  }
  assert(boot?.token, logs);
  const html = await (await fetch(base)).text(); assert.match(html, /assets\/index-/); assert(!html.includes("@vite/client"));
  const asset = html.match(/src="([^"]+\.js)"/)[1]; assert.equal((await fetch(base + asset)).status, 200);
  for (const url of ["/@vite/client", "/src/main.jsx", "/@fs/etc/passwd", "/.env"]) assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await fetch(base + "/api/jobs")).status, 403);
  assert.equal((await fetch(base + "/api/jobs", { headers: { "x-console-token": boot.token } })).status, 200);
  console.log("production console smoke passed: built assets, no Vite/HMR/source, authenticated APIs, shutdown");
} finally { child.kill("SIGTERM"); await exited; await fs.rm(root, { recursive: true, force: true }); }
