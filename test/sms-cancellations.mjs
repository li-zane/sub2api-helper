import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SmsCancellations } from "../src/sms-cancellations.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-cancel-outbox-")), filePath = path.join(root, "cancellations.json");
let now = 0, calls = 0;
const record = { jobId: "fixture-job", providerId: "smsbower", requestId: "fixture-order" };
try {
  const store = new SmsCancellations({ filePath, now: () => now, retryMs: 100, getClient: () => null });
  await assert.rejects(store.cancel(record, { apiKey: "fixture-key-never-persist", release: async () => {
    calls++; assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).pending.length, 1, "cancel was not durable before supplier call");
    throw Error("EARLY_CANCEL_DENIED");
  } }));
  assert.equal(store.count(record.jobId), 1);
  assert(!(await fs.readFile(filePath, "utf8")).includes("fixture-key-never-persist"));
  const restarted = new SmsCancellations({ filePath, now: () => now, retryMs: 100, getClient: provider => {
    assert.equal(provider, "smsbower"); return { release: async id => { assert.equal(id, record.requestId); calls++; } };
  } });
  await restarted.load(); await restarted.retry(); assert.equal(calls, 1, "retry ignored backoff");
  now = 100; await restarted.retry(); assert.equal(calls, 2); assert.equal(restarted.count(record.jobId), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).pending, []);
  await restarted.cancel(record, { release: async () => { throw Object.assign(Error("already absent"), { code: "NO_ACTIVATION" }); } });
  assert.equal(restarted.count(record.jobId), 0);
  await Promise.all([1, 2, 3].map(n => restarted.cancel({ ...record, requestId: "order-" + n }, { release: async () => {} })));
  let released = 0;
  const concurrent = new SmsCancellations({ filePath, getClient: () => null });
  const save = concurrent.save.bind(concurrent);
  concurrent.save = async () => { await new Promise(r => setTimeout(r, 20)); return save(); };
  const client = { release: async () => {
    released++;
    assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).pending.length, 1, "duplicate cancel bypassed pending durability");
    await new Promise(r => setTimeout(r, 40));
  } };
  await Promise.all([concurrent.cancel(record, client), concurrent.cancel(record, client)]);
  assert.equal(released, 1, "concurrent cleanup released the same order twice");
  await concurrent.stop();
  await restarted.stop(); assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).pending, []);
  console.log("SMS_CANCEL_OUTBOX_PASS durable-before-release; denied/timeout retained; private no-credentials record; restart and bounded retry; already-absent completion; concurrent orders and same-order deduplication");
} finally { await fs.rm(root, { recursive: true, force: true }); }
