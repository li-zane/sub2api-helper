import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountSessionResets, sessionResetPending, resetCredentialUpdate, normalizeSessionResetDelay } from "../src/account-session-reset.mjs";
import { OverloadCooldown, normalizeOverloadCooldown } from "../src/overload-cooldown.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-session-reset-")), email = "reset@example.test";
try {
  let store = new AccountSessionResets(path.join(dir, "reset.json")); await store.load();
  await store.begin(email, { id: "fixture", proxyId: 3, proxyUrl: "http://fixture:8080", accountIds: ["7"] });
  assert(sessionResetPending(store.get(email))); assert(!JSON.stringify(store.publicState(email)).includes("proxyUrl"));
  assert.throws(() => store.begin(email, { id: "duplicate" }));
  assert.equal(normalizeSessionResetDelay(), 0);
  for (const value of [0, 1, 43200]) assert.equal(normalizeSessionResetDelay(value), value);
  for (const value of [-1, 43201, 0.1, "1", null, true]) assert.throws(() => normalizeSessionResetDelay(value));
  await store.save(email, { status: "cooling", cooldownMinutes: 1, resumeAt: "2026-11-13T12:00:00Z" });
  assert(sessionResetPending(store.get(email)));
  const cooling = new AccountSessionResets(path.join(dir, "reset.json")); await cooling.load();
  assert.equal(cooling.publicState(email).resumeAt, "2026-11-13T12:00:00Z");
  await store.save(email, { status: "authorizing", logoutCompletedAt: new Date().toISOString() });
  store = new AccountSessionResets(path.join(dir, "reset.json")); await store.load();
  assert.equal(store.get(email).id, "fixture"); assert(store.get(email).logoutCompletedAt);
  await store.complete(email); assert(!sessionResetPending(store.get(email)));
  await store.remove(email); assert.equal(store.get(email), null);
  const remote = { proxy_id: 3, group_ids: [1], schedulable: false, priority: 8, credentials: { email, access_token: "old", custom: "retain" } };
  const update = resetCredentialUpdate({ credentials: { email, access_token: "new", refresh_token: "new-refresh", plan_type: "free" } }, remote);
  assert.equal(update.credentials.access_token, "new"); assert.equal(update.credentials.custom, "retain");
  for (const key of ["proxy_id", "group_ids", "schedulable", "priority"]) assert(!Object.hasOwn(update, key));
  assert.throws(() => resetCredentialUpdate({ credentials: { access_token: "partial" } }, remote));
  assert.equal(normalizeOverloadCooldown({ reauthorizeAfterCooldown: true }).reauthorizeAfterCooldown, true);
  for (const value of ["true", 1, null]) assert.throws(() => normalizeOverloadCooldown({ reauthorizeAfterCooldown: value }));

  let now = Date.parse("2026-11-13T12:00:00Z"), result = { status: "pending" }, enabled = false, callbackCount = 0;
  const config = { baseUrl: "fixture", adminApiKey: "fixture" }, mutations = [], rules = { windowMinutes: 15, threshold: 4, cooldownMinutes: 1, reauthorizeAfterCooldown: true };
  const options = { filePath: path.join(dir, "cooldown.json"), getConfig: () => config, backendIdentity: () => "fixture",
    getSettings: () => rules, now: () => now, setTimer: () => ({ unref() {} }), clearTimer() {},
    listAccounts: async () => new Map([[email, [{ id: "7", enabled }]]]),
    beforeResume: (_email, event) => { assert.equal(event.backend, "fixture"); callbackCount++; return result; },
    request: async (_config, _url, options) => { enabled = JSON.parse(options.body).schedulable; mutations.push(enabled); } };
  let cooldown = new OverloadCooldown(options);
  cooldown.accounts.set(email, { enabled: true, backend: "fixture", phase: "cooling", resumeAccountIds: ["7"], coolingUntil: new Date(now - 1).toISOString() });
  cooldown.stopped = false; await cooldown.refresh();
  assert.deepEqual(mutations, []); assert.equal(cooldown.snapshot(email).phase, "refreshing");
  const requestId = cooldown.accounts.get(email).resetRequestId; assert(requestId);
  await cooldown.stop(); cooldown = new OverloadCooldown(options); await cooldown.load(); cooldown.stopped = false;
  result = { status: "failed", error: "fixture login failed" }; await cooldown.refresh();
  assert.deepEqual(mutations, []); assert.equal(cooldown.accounts.get(email).resetRequestId, requestId); assert.match(cooldown.snapshot(email).lastError, /login failed/);
  result = { status: "completed" }; await cooldown.refresh();
  assert.deepEqual(mutations, [true]); assert.equal(cooldown.snapshot(email).phase, "idle");
  const callsBefore = callbackCount;
  cooldown.accounts.set(email, { enabled: false, backend: "fixture", phase: "resuming", resumeAccountIds: ["7"], coolingUntil: new Date(now - 1).toISOString() });
  enabled = false; await cooldown.refresh(); assert.equal(callbackCount, callsBefore, "disabling cooldown bypasses optional reset");
  await cooldown.stop();
  console.log("SESSION_RESET_PASS durable stages/private route; credentials-only update; strict optional flag; cooldown waits for successful reset; failed/restarted reset stays paused; switch-off restores");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
