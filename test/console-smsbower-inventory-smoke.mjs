import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { smsBowerModesFixture } from "./smsbower-modes-fixture.mjs";
const root = path.resolve(import.meta.dirname, ".."), dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-sms-inventory-"));
const calls = []; let mode = "normal", child, logs = "";
const sms = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture"), { catalog, prices } = smsBowerModesFixture();
  if (u.searchParams.has("serviceId")) { assert(!u.searchParams.has("api_key")); calls.push("catalog"); if (mode === "catalog-fail") { res.writeHead(503); return res.end("down"); } return res.end(JSON.stringify(catalog)); }
  const action = u.searchParams.get("action"); calls.push(action); assert.equal(action, "getPricesV3", "estimate must not buy, poll or cancel numbers");
  if (mode === "leak") { res.writeHead(502); return res.end("private-fixture-key failed"); }
  if (mode === "invalid") return res.end("invalid");
  res.end(JSON.stringify(mode === "empty" ? {} : u.searchParams.has("country") ? { [u.searchParams.get("country")]: prices[u.searchParams.get("country")] } : prices));
});
const listen = async server => { await new Promise(r => server.listen(0, "127.0.0.1", r)); return server.address().port; };
await listen(sms); const socket = http.createServer(), port = await listen(socket); await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`, endpoint = "/api/sms-providers/smsbower/inventory";
let headers = { "content-type": "application/json" };
const config = { apiKey: "private-fixture-key", service: "dr", country: "1001", maxPrice: "0.04" };
const post = async (c, route = endpoint, h = headers) => { const r = await fetch(base + route, { method: "POST", headers: h, body: JSON.stringify({ config: c }) }); return { status: r.status, data: await r.json() }; };
try {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: dir, LOCALAPPDATA: dir, SMSBOWER_API_BASE: `http://127.0.0.1:${sms.address().port}/api`, SMSBOWER_CATALOG_BASE: `http://127.0.0.1:${sms.address().port}/catalog`, SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", d => logs += d); child.stderr.on("data", d => logs += d);
  let bootstrap; for (const end = Date.now() + 15000; Date.now() < end;) { try { const r = await fetch(base + "/api/bootstrap"); if (r.ok) { bootstrap = await r.json(); break; } } catch {} await new Promise(r => setTimeout(r, 40)); }
  assert(bootstrap, logs); assert.equal((await post(config)).status, 403); assert.equal(calls.length, 0); headers["x-console-token"] = bootstrap.token;
  const fixed = await post(config); assert.equal(fixed.status, 200); assert.equal(fixed.data.estimate.totalCount, 60); assert(Date.parse(fixed.data.fetchedAt));
  const global = await post({ ...config, selectionMode: "global", country: "" }); assert.equal(global.status, 200); assert.equal(global.data.estimate.totalCount, 96); assert.deepEqual(global.data.estimate.byRank, { gold: 22, silver: 31, bronze: 43 }); assert(!JSON.stringify(global).includes(config.apiKey));
  for (const patch of [{ maxPrice: "" }, { maxPrice: "0" }, { maxPrice: "0.0000001" }, { selectionMode: "invalid" }, { country: "bad" }, { apiKey: "x" }]) { const before = calls.length; assert.equal((await post({ ...config, ...patch })).status, 400); assert.equal(calls.length, before); }
  assert.equal((await post({ apiKey: config.apiKey, serviceId: "fixture" }, "/api/sms-providers/luban/inventory")).status, 400);
  mode = "empty"; assert.equal((await post(config)).data.estimate.totalCount, 0);
  for (const failure of ["leak", "invalid", "catalog-fail"]) { mode = failure; const result = await post(config); assert.equal(result.status, 502); assert(!JSON.stringify(result).includes(config.apiKey)); assert(!result.data.estimate); }
  assert(calls.every(c => ["getPricesV3", "catalog"].includes(c))); assert(!logs.includes(config.apiKey)); assert(!(await fs.readdir(dir)).includes("sms-provider-settings.json"));
  console.log("SMSBOWER_INVENTORY_HTTP_PASS auth=403 fixed=60 global=96 validation=400 upstream=502 sanitized=true no_fake_zero=true paid_calls=0 settings_unchanged=true");
} finally {
  if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
  sms.closeAllConnections(); await new Promise(r => sms.close(r)); assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true });
}
