import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { usageRestricted, codexStatusEligible, codexStatusBlockReason } from "../web/src/codex-eligibility.mjs";
import { OverloadCooldown } from "../src/overload-cooldown.mjs";
import { ModelFingerprintService } from "../src/model-fingerprint.mjs";
const ready = { sub2apiInPool: true, sub2apiEnabled: true };
for (const usage of [{ limitReached: true }, { allowed: false }, { credits: { overageLimitReached: true } }, { primary: { usedPercent: 100 } }, { secondary: { usedPercent: 101 } }, { quotaRestricted: true }, { allowed: true, limitReached: false, primary: { usedPercent: 100 } }]) {
  assert.equal(usageRestricted(usage), true); assert.equal(codexStatusEligible({ ...ready, sub2apiUsage: usage }), false); assert.match(codexStatusBlockReason({ ...ready, sub2apiUsage: usage }), /限额/);
}
for (const usage of [null, {}, { allowed: null, limitReached: null }, { primary: { usedPercent: 99.9 } }, { primary: { usedPercent: NaN } }, { credits: { balance: "0", hasCredits: false } }, { credits: { balance: "0", unlimited: true } }]) {
  assert.equal(usageRestricted(usage), false); assert.equal(codexStatusEligible({ ...ready, sub2apiUsage: usage }), true);
}
for (const job of [{}, { sub2apiInPool: null }, { sub2apiInPool: false, sub2apiEnabled: true }, { sub2apiInPool: true, sub2apiEnabled: false }, { ...ready, sub2apiQuotaRestricted: true }, { ...ready, sub2apiRateLimited: true }, { ...ready, autoRepairBlocked: true }]) assert.equal(codexStatusEligible(job), false);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-codex-quota-")), filePath = root + "/cooldown.json", email = "quota@example.test";
let now = Date.parse("2026-11-07T00:00:00Z"), writes = [], record = { id: "7", enabled: false, canCount: false };
const config = { baseUrl: "https://fixture.test", adminApiKey: "fixture" };
const options = { filePath, getConfig: () => config, backendIdentity: c => c.baseUrl, getSettings: () => ({ windowMinutes: 15, threshold: 5, cooldownMinutes: 30 }), listAccounts: async () => new Map([[email, [record]]]), now: () => now,
  request: async (_config, url, options) => { assert(url.endsWith("/7/schedulable"), "restricted cooldown must not query overload statistics"); writes.push(JSON.parse(options.body).schedulable); record.enabled = writes.at(-1); return {}; } };
try {
  await fs.writeFile(filePath, JSON.stringify({ version: 1, accounts: { [email]: { enabled: true, phase: "cooling", backend: config.baseUrl, resumeAccountIds: ["7"], coolingUntil: new Date(now + 1800000).toISOString() } } }));
  let service = new OverloadCooldown(options); await service.load(); await service.stopDetection(email);
  assert.equal(service.snapshot(email).enabled, false); assert.equal(service.accounts.get(email).resumeAccountIds.length, 1);
  service = new OverloadCooldown(options); await service.load(); service.stopped = false;
  await service.checkAccount(email, config, [record]); assert.deepEqual(writes, [], "quota pause resumed the pool early");
  now += 1800001; await service.checkAccount(email, config, [record]); assert.deepEqual(writes, [true]);
  assert.equal(service.snapshot(email).enabled, false); assert.equal(service.accounts.get(email).resumeAccountIds.length, 0);
  let samples = 0, recovered = [], notifications = 0;
  const fingerprint = new ModelFingerprintService({ filePath: root + "/fingerprint.json", getContext: () => ({ config, backend: "fixture", profiles: [], jobs: [] }),
    listTargets: async () => [{ id: "7", email }], getAccount: async () => ({ id: "7", type: "oauth", status: "active", schedulable: true, credentials: { email }, group_ids: [] }),
    sample: async () => { samples++; throw Object.assign(new Error("fixture quota"), { fingerprintFailure: true, code: "QUOTA", httpStatus: 400, retryable: false, upstreamCode: "usage_limit_reached" }); },
    updateGroups: async () => assert.fail("quota must not change groups"), detectorLoader: async () => ({ analyze: () => assert.fail("quota is not a fingerprint score") }),
    onChange: () => notifications++, onAccountFailure: async (_email, failure) => recovered.push(failure) });
  await fingerprint.load(); await fingerprint.saveSettings({ ...fingerprint.settings, models: [{ model: "first", expected: "first" }, { model: "second", expected: "second" }] });
  await fingerprint.run(email, "free", { manual: true });
  assert.equal(samples, 1, "non-429 quota continued to another sample/model"); assert.equal(recovered.length, 1); assert.equal(recovered[0].code, "QUOTA");
  const beforeNotify = notifications; await fingerprint.saveOverride(email, { enabled: false }, { notify: false }); assert.equal(notifications, beforeNotify, "internal stop invalidated the fresh pool snapshot"); await fingerprint.stop();
  console.log("CODEX_QUOTA_GATE_PASS restriction flags/windows; zero balance and unknown data are not exhaustion; pool/enabled/ban/429 gates; no early cooldown resume; durable restore preserved; non-429 QUOTA stops first sample/model; quiet internal stop preserves status cache");
} finally { assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
