import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelFingerprintService } from "../src/model-fingerprint.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-paused-history-")), email = "paused@example.test";
let now = Date.parse("2026-11-07T00:00:00Z");
const options = { filePath: root + "/fingerprint.json", getContext: () => ({ backend: "fixture", config: {}, jobs: [], profiles: [] }), listTargets: async () => [], now: () => now };
let service = new ModelFingerprintService(options);
try {
  await service.load();
  const old = ["match", "mismatch", "unknown", "match", "error", "match"].map((status, i) => ({ status, checkedAt: new Date(Date.parse("2026-11-01T06:00:00Z") - i * 3600000).toISOString() }));
  service.accounts.set(email, { override: { enabled: true }, recentResults: old, history: [], result: { ...old[0], models: [], signature: service.signature(email, "free") } });
  await service.persist();
  const before = service.snapshot(email, "free").recentResults;
  const controller = new AbortController(); service.active.set(email, controller); service.invalidateAccount(email); assert.equal(controller.signal.aborted, true); service.active.delete(email);
  await service.saveOverride(email, { enabled: false }, { notify: false });
  assert.equal(service.snapshot(email, "free").enabled, false);
  assert.deepEqual(service.snapshot(email, "free").recentResults, before, "pause cleared or restamped the previous rounds");
  now += 30 * 86400000; await service.stop(); service = new ModelFingerprintService(options); await service.load();
  assert.deepEqual(service.snapshot(email, "free").recentResults, before, "idle time/restart expired the last six rounds");
  const next = { status: "mismatch", checkedAt: new Date(now).toISOString(), models: [], signature: service.signature(email, "free") };
  service.recordResult(service.accounts.get(email), next); await service.persist();
  assert.deepEqual(service.snapshot(email, "free").recentResults, [{ checkedAt: next.checkedAt, status: next.status }, ...before.slice(0, 5)], "a real result did not advance exactly one slot");
  console.log("FINGERPRINT_PAUSED_HISTORY_PASS cancellation/disable/poll/restart/30-day idle preserve last six timestamps and statuses; only a new record advances history");
} finally { await service.stop(); assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
