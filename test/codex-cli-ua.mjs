import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCliUaSettings, probeCliUserAgent } from "../src/codex-cli-ua.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-ua-test-"));
const ua = "codex_cli_rs/0.165.0 (Alpine Linux 3.24.1; x86_64) unknown (codex_cli_rs; 0.165.0)";
let config = { baseUrl: "http://gateway.invalid", adminApiKey: "private-admin-key" };
let time = Date.now(), probeCount = 0, reads = 0, puts = 0, probeFailure = false, reject = false, ignore = false, changeConfig = false;
let settings = { openai_codex_user_agent: "old-UA", site_name: "preserve", nested: { value: 7 } };
const fetchImpl = async (url, options) => {
  assert.equal(new URL(url).pathname, "/api/v1/admin/settings");
  assert.equal(options.headers["x-api-key"], "private-admin-key");
  assert.equal(options.redirect, "error");
  if (reject) return new Response('{"message":"private-admin-key"}', { status: 403 });
  if (options.method === "PUT") {
    puts++; const body = JSON.parse(options.body);
    assert.equal(body.site_name, "preserve"); assert.deepEqual(body.nested, { value: 7 });
    if (!ignore) settings = body;
  } else { reads++; if (changeConfig) config = { ...config, baseUrl: "http://changed.invalid" }; }
  return Response.json({ code: 0, data: settings });
};
const service = createCliUaSettings({ root, getConfig: () => config, fetchImpl, now: () => time, cacheMs: 1000,
  probe: async () => { probeCount++; await new Promise(r => setTimeout(r, 15)); if (probeFailure) throw new Error("secret CLI stderr"); return ua; } });
const input = data => ({ contextId: data.contextId, cliUserAgent: data.cli.userAgent, gatewayUserAgent: data.gateway.userAgent });
try {
  let closed = 0;
  assert.equal(await probeCliUserAgent({ root, openSession: async () => ({ userAgent: ua,
    request() { throw new Error("no login RPC allowed"); }, async close() { closed++; } }) }), ua);
  await assert.rejects(probeCliUserAgent({ root, openSession: async () => ({ userAgent: "invalid", async close() { closed++; } }) }));
  assert.equal(closed, 2);
  await assert.rejects(probeCliUserAgent({ root, openSession: async () => ({ userAgent: ua, async close() { throw new Error("cleanup failed"); } }) }), /cleanup failed/);

  const snapshots = await Promise.all([service.read(), service.read(), service.read()]);
  assert.equal(probeCount, 1); assert.equal(puts, 0); assert.equal(reads, 3);
  const snapshot = snapshots[0]; assert.equal(snapshot.matches, false);
  assert(!JSON.stringify(snapshot).includes(config.adminApiKey));
  await service.read(); assert.equal(probeCount, 1);
  await service.read({ refreshCli: true }); assert.equal(probeCount, 2);
  time += 1001; await service.read(); assert.equal(probeCount, 3);
  await assert.rejects(service.sync({ ...input(snapshot), cliUserAgent: "arbitrary-UA" }), { status: 409 });
  assert.equal(puts, 0);
  const synced = await service.sync(input(snapshot)); assert.equal(synced.matches, true); assert.equal(synced.changed, true); assert.equal(puts, 1);
  await service.sync(input(snapshot)); assert.equal(puts, 1, "idempotent duplicate confirmation");

  settings.openai_codex_user_agent = "externally changed";
  await assert.rejects(service.sync(input(snapshot)), { status: 409 }); assert.equal(puts, 1);
  let current = await service.read();
  ignore = true; await assert.rejects(service.sync(input(current)), /读回/); ignore = false;
  const putCount = puts;
  config = { ...config }; await assert.rejects(service.sync(input(current)), { status: 409 }); assert.equal(puts, putCount);
  current = await service.read(); changeConfig = true;
  await assert.rejects(service.sync(input(current)), { status: 409 }); changeConfig = false; assert.equal(puts, putCount);

  reject = true; const unavailable = await service.read();
  assert.equal(unavailable.cli.userAgent, ua); assert.match(unavailable.gateway.error, /403/);
  assert(!JSON.stringify(unavailable).includes("private-admin-key")); reject = false;
  probeFailure = true; const missing = await service.read({ refreshCli: true });
  assert.equal(missing.cli.userAgent, null); assert(missing.cli.error); assert(!JSON.stringify(missing).includes("secret CLI stderr"));
  config = null; const unconfigured = await service.read(); assert.equal(unconfigured.gateway.configured, false);
  await assert.rejects(service.sync(input(snapshot)), { status: 409 });
  console.log("CLI_UA_SETTINGS_PASS read-only comparison, shared probe/cache, refresh/expiry, manual sync, idempotency, stale config/UA rejection, field preservation, readback, errors, cleanup");
} finally { await fs.rm(root, { recursive: true, force: true }); }
