import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubscriptionHistory } from "../src/subscription-history.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-subscription-notices-"));
let now = "2026-11-16T00:00:00Z";
const file = path.join(dir, "history.json");
const store = new SubscriptionHistory(file, { now: () => now });
const initial = { email: "change@example.test", planType: "team", accountBanned: false, remark: "original", userCostUsd: 1 };
const reconcile = changes => store.reconcile([{ ...initial, ...changes }], [initial.email]);
const read = () => store.list(7)[0];
try {
  await reconcile({}); assert.equal(read().lastChange ?? null, null, "initial paid account is not a subscription change");
  now = "2026-11-16T01:00:00Z";
  await reconcile({ planType: "free" });
  const first = read();
  assert(first.lastChange, "subscription change must be recorded separately from general updates");
  assert.equal(first.lastChange.at, now); assert.equal(first.lastChange.unread, true);
  assert.deepEqual(first.lastChange.types, ["subscription"]);
  assert.equal(first.lastChange.fromPlanType, "team"); assert.equal(first.lastChange.toPlanType, "free");
  const revision = first.lastChange.revision;
  assert.equal(store.list(7)[0].lastChange.unread, true, "GET/list silently consumed a change");
  now = "2026-11-16T02:00:00Z";
  await reconcile({ planType: "Free", remark: "updated", userCostUsd: 2 });
  assert.equal(read().lastChange.revision, revision); assert.equal(read().lastChange.at, first.lastChange.at);
  assert.equal(read().updatedAt, now, "financial changes must still sync");
  assert.equal(await store.markSeen([{ id: first.id, revision }]), 1);
  assert.equal(read().lastChange.unread, false);
  const restored = new SubscriptionHistory(file, { now: () => now }); await restored.load();
  assert.equal(restored.list(7)[0].lastChange.unread, false, "read state did not survive restart");
  now = "2026-11-16T03:00:00Z";
  await reconcile({ planType: "free", accountBanned: true });
  const banned = read(); assert.equal(banned.accountBanned, true); assert.equal(banned.lastChange.unread, true);
  assert.deepEqual(banned.lastChange.types, ["banned"]); assert.equal(banned.lastChange.at, now);
  assert(banned.lastChange.revision > revision);
  assert.equal(await store.markSeen([{ id: banned.id, revision }]), 0, "old acknowledgement consumed a newer ban");
  assert.equal(await store.markSeen([{ id: banned.id, revision: banned.lastChange.revision + 1 }]), 0, "future acknowledgement consumed an unseen change");
  assert.equal(read().lastChange.unread, true);
  const banAt = banned.lastChange.at;
  now = "2026-11-16T04:00:00Z";
  await reconcile({ planType: null, accountBanned: true });
  assert.equal(read().planType.toLowerCase(), "free"); assert.equal(read().lastChange.at, banAt, "unknown plan created a false transition");
  await store.reconcile([], []); assert.equal(read().present, false); assert.equal(read().lastChange.at, banAt);
  await store.markSeen([{ id: banned.id, revision: banned.lastChange.revision }]);
  now = "2026-11-16T05:00:00Z";
  await reconcile({ planType: "plus", accountBanned: false });
  const recovered = read(); assert.deepEqual(recovered.lastChange.types, ["subscription", "recovered"]);
  assert.equal(recovered.lastChange.unread, true); assert.equal(recovered.accountBanned, false);
  // A concurrent stale acknowledgement must serialize behind new observations.
  await Promise.all([reconcile({ planType: "business", accountBanned: false }), store.markSeen([{ id: recovered.id, revision: recovered.lastChange.revision }])]);
  assert.equal(read().lastChange.toPlanType, "business"); assert.equal(read().lastChange.unread, true);
  // Failed persistence must not publish an acknowledgement or lose a change.
  const beforeFailure = JSON.stringify(read());
  const blocked = path.join(dir, "blocked"); await fs.writeFile(blocked, "fixture"); store.file = path.join(blocked, "history.json");
  await assert.rejects(store.markSeen([{ id: read().id, revision: read().lastChange.revision }]));
  assert.equal(JSON.stringify(read()), beforeFailure); store.file = file;
  // Existing version-1 records can establish a ban without inventing plan changes.
  const legacyFile = path.join(dir, "legacy.json");
  await fs.writeFile(legacyFile, JSON.stringify({ version: 1, records: [{ email: initial.email, planType: "team", lastPaidPlanType: "team", credentials: {} }] }));
  const legacy = new SubscriptionHistory(legacyFile, { now: () => now }); await legacy.load();
  await legacy.reconcile([{ ...initial, accountBanned: true }], [initial.email]);
  assert.deepEqual(legacy.list(7)[0].lastChange.types, ["banned"]);
  await store.reconcile([{ email: "new-banned@example.test", planType: "plus", accountBanned: true }], [initial.email, "new-banned@example.test"]);
  assert.equal(store.list(7).find(r => r.email === "new-banned@example.test").lastChange.unread, true);
  console.log("SUBSCRIPTION_NOTICES_PASS plan/ban/recovery timestamps; no financial/case/unknown noise; persistent read state; stale/future/concurrent ack guards; failed-write retention; legacy/new bans; deletion retention");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
