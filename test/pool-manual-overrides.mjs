import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelFingerprintService } from "../src/model-fingerprint.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-manual-values-")), email = "manual@example.test";
let plan = "free", backend = "fixture", answer = "最终答案：21", samples = 0, failSample = false;
const account = { id: 1, type: "oauth", status: "active", priority: 10, concurrency: 4, credentials: { email }, group_ids: [] };
const targets = [{ id: 1, email, profileId: "default" }];
const writes = [], options = {
  filePath: path.join(root, "state.json"), getContext: () => ({ backend, config: { baseUrl: "https://fixture", adminApiKey: "fixture" }, profiles: [], jobs: [{ email, planType: plan }] }),
  listTargets: async () => targets, getAccount: async () => structuredClone(account),
  getPoolNumberDefaults: async () => plan === "free" ? { priority: 10, concurrency: 4 } : { priority: 20, concurrency: 8 },
  updatePriority: async (_config, id, value) => { writes.push([id, "priority", value]); account.priority = value; },
  updateConcurrency: async (_config, id, value) => { writes.push([id, "concurrency", value]); account.concurrency = value; },
  sample: async () => { samples++; if (failSample) throw Error("fixture overload"); return answer; },
};
let service = new ModelFingerprintService(options);
const run = () => service.run(email, plan, { manual: true });
const manual = (field, value) => service.manualPoolNumber(email, field, async record => { await record(1); account[field] = value; }, { value, planType: plan, backend });
const restart = async () => { await service.stop(); service = new ModelFingerprintService(options); await service.load(); };
const values = () => [account.priority, account.concurrency];
const profileWrite = body => service.poolAccountUpdate(email, 1, backend, body, update => Object.assign(account, update), { updateBase: true, planType: plan });
try {
  await service.saveSettings({ models: ["fixture"], enabledPlanTypes: ["free", "team"], testSequence: { first: "candy", fingerprint: 0, candy: 1 },
    failureRetries: 0, matchedPriority: { enabled: true, value: 1 }, matchedConcurrency: { enabled: true, value: 30 } });
  await run(); assert.deepEqual(values(), [1, 30]);
  await manual("priority", 7); await manual("concurrency", 11);
  await run(); assert.deepEqual(values(), [7, 11], "repeated pass overwrote manual values");
  const firstSamples = samples;
  await restart(); await service.reconcile(email, plan, targets); assert.deepEqual(values(), [7, 11]); assert.equal(samples, firstSamples);
  await profileWrite({ priority: 2, concurrency: 99, name: "changed profile" });
  assert.deepEqual(values(), [7, 11]); assert.equal(account.name, "changed profile");
  await service.poolAccountUpdate(email, 1, backend, { priority: 100, concurrency: 1, credentials: { email, access_token: "new-token" } }, body => Object.assign(account, body));
  assert.deepEqual(values(), [7, 11]); assert.equal(account.credentials.access_token, "new-token");
  for (answer of ["没有最终答案", "最终答案：21"]) { await run(); assert.deepEqual(values(), [7, 11]); }
  failSample = true; await run().catch(() => {}); assert.deepEqual(values(), [7, 11], "failed detection changed manual values");
  failSample = false;
  answer = "没有最终答案";
  for (let n = 0; n < 7; n++) await run();
  await restart(); await profileWrite({ priority: 2, concurrency: 99 });
  assert.deepEqual(values(), [7, 11], "rotating six unknown rounds erased the last definitive state");
  answer = "最终答案：21";
  await service.saveSettings({ ...service.settings, matchedPriority: { enabled: true, value: 2 }, matchedConcurrency: { enabled: true, value: 40 } });
  await service.reconcile(email, plan, targets); assert.deepEqual(values(), [7, 11]);
  answer = "最终答案：22"; await run(); assert.deepEqual(values(), [10, 4], "changed verdict did not restore plan baseline");
  answer = "最终答案：21"; await run(); assert.deepEqual(values(), [2, 40]);
  await manual("priority", 0); await run(); assert.deepEqual(values(), [0, 40], "priority exception suppressed automatic concurrency");
  plan = "team"; await service.observePlan(email, plan);
  await profileWrite({ priority: 20, concurrency: 8 }); assert.deepEqual(values(), [20, 8], "changed subscription retained old manual override");
  await run(); assert.deepEqual(values(), [2, 40]);
  await manual("priority", 6); await manual("concurrency", 9);
  // A plan flip followed by a return must release an exception even when the
  // account did not run an inference or pool write during the intermediate plan.
  await service.observePlan(email, "free"); await service.observePlan(email, "team");
  await profileWrite({ priority: 20, concurrency: 8 }); assert.deepEqual(values(), [20, 8]);
  await run(); assert.deepEqual(values(), [2, 40]);
  await service.manualPriority(email, async record => { await record(1); account.priority = 5; throw Error("response lost"); }, { value: 5, planType: plan, backend }).catch(() => {});
  await restart(); await run(); assert.equal(account.priority, 5, "uncertain committed edit lost durable protection");
  const before = structuredClone(service.accounts.get(email)), file = service.filePath;
  await fs.writeFile(path.join(root, "blocked"), "fixture"); service.filePath = path.join(root, "blocked", "state.json");
  await assert.rejects(manual("concurrency", 12)); assert.equal(account.concurrency, 40);
  assert.deepEqual(service.accounts.get(email), before, "failed intent persistence published uncommitted manual state");
  service.filePath = file;
  // Plan-only accounts have no prior fingerprint entry. They need the same
  // persistent protection, including default-off policies and zero values.
  await service.saveSettings({ ...service.settings, matchedPriority: { enabled: false, value: 2 }, matchedConcurrency: { enabled: false, value: 40 } });
  await service.manualPoolNumber("unscored@example.test", "concurrency", async record => { await record(1); account.concurrency = 0; }, { value: 0, planType: "team", backend });
  await restart(); await service.poolAccountUpdate("unscored@example.test", 1, backend, { concurrency: 20 }, body => Object.assign(account, body), { planType: "team" });
  assert.equal(account.concurrency, 0);
  await service.poolAccountUpdate("unscored@example.test", 1, backend, { priority: 3 }, body => Object.assign(account, body), { planType: "free" });
  await service.poolAccountUpdate("unscored@example.test", 1, backend, { priority: 20 }, body => Object.assign(account, body), { planType: "team" });
  await service.poolAccountUpdate("unscored@example.test", 1, backend, { concurrency: 8 }, body => Object.assign(account, body), { planType: "team" });
  assert.equal(account.concurrency, 8, "plan transition observed by priority-only sync did not release concurrency exception");
  backend = "other";
  await service.poolAccountUpdate("unscored@example.test", 1, backend, { concurrency: 3 }, body => Object.assign(account, body), { planType: "team" });
  assert.equal(account.concurrency, 3, "manual exception crossed backend boundary");
  console.log("POOL_MANUAL_OVERRIDES_PASS same verdict/restart/profile/date/OAuth/unknown preserve; real verdict/plan transition releases; independent fields; zero; no prior detection; durable before write; failed-store rollback; backend isolation");
} finally { await service.stop(); await fs.rm(root, { recursive: true, force: true }); }
