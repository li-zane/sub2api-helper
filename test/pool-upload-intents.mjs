import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PoolUploadIntents } from "../src/pool-upload-intents.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "helper-upload-intents-"));
const filePath = path.join(directory, "intents.json");
const config = { baseUrl: "https://pool.example.test/api/", adminApiKey: "fixture-admin-key-never-persisted" };
const email = "fixture@example.test";
const payload = {
  platform: "openai", type: "oauth", name: `oauth--${email}`,
  credentials: { email, access_token: "synthetic-original-token" }, group_ids: [1, 2], enabled: true,
};
const changed = { ...payload, credentials: { email, access_token: "synthetic-new-token" }, group_ids: [3] };
let passed = 0;
async function check(name, action) { await action(); passed++; console.log(`PASS ${name}`); }

try {
  let initial;
  await check("pending body and key are durable before prepare resolves", async () => {
    const store = new PoolUploadIntents({ filePath });
    initial = await store.prepare(config, payload);
    assert.match(initial.id, /^[a-f0-9-]{36}$/);
    assert.match(initial.key, /^helper-upload-v1-[a-f0-9]{40}$/);
    assert.deepEqual(initial.account, payload);
    assert.deepEqual(initial.existingIds, []);
    assert.equal(initial.payloadChanged, false);
    const raw = await fs.readFile(filePath, "utf8");
    assert(raw.includes(initial.key));
    assert(raw.includes("synthetic-original-token"));
    assert(!raw.includes(config.adminApiKey));
    assert(!raw.includes(config.baseUrl));
    if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  });
  await check("restart and API-key changes retain pending initial body and key", async () => {
    const restarted = new PoolUploadIntents({ filePath });
    const next = await restarted.prepare({ ...config, baseUrl: "https://POOL.example.test:443/api", adminApiKey: "new-key" }, changed);
    assert.equal(next.id, initial.id);
    assert.equal(next.key, initial.key);
    assert.deepEqual(next.account, payload);
    assert.equal(next.payloadChanged, true);
    next.account.credentials.access_token = "caller-mutated-token";
    assert.deepEqual((await restarted.prepare(config, payload)).account, payload);
  });
  await check("confirmed existing remote IDs block a second creation", async () => {
    const store = new PoolUploadIntents({ filePath });
    const confirmed = await store.confirm(config, email, initial.id, [12, "12", "13"]);
    assert.deepEqual(confirmed.existingIds, ["12", "13"]);
    const calls = [];
    const current = await store.prepare(config, changed, { lookupAccount: async id => {
      calls.push(id);
      return id === "12" ? { id: 12, email } : null;
    } });
    assert.deepEqual(calls, ["12", "13"]);
    assert.equal(current.id, initial.id);
    assert.deepEqual(current.existingIds, ["12"]);
    assert.equal(current.payloadChanged, true);
  });
  await check("a known existing ID still prevents creation when another lookup fails", async () => {
    const current = await new PoolUploadIntents({ filePath }).prepare(config, changed, { lookupAccount: async id => {
      if (id === "12") throw Error("synthetic network failure");
      return { id: 13 };
    } });
    assert.equal(current.id, initial.id);
    assert.deepEqual(current.existingIds, ["13"]);
  });
  await check("network failures and ambiguous results preserve confirmed generation", async () => {
    const store = new PoolUploadIntents({ filePath });
    const before = await fs.readFile(filePath, "utf8");
    await assert.rejects(store.prepare(config, changed, { lookupAccount: async () => { throw Error("synthetic network failure"); } }), /synthetic network failure/);
    await assert.rejects(store.prepare(config, changed, { lookupAccount: async () => undefined }), /POOL_UPLOAD_LOOKUP_INVALID/);
    await assert.rejects(store.prepare(config, changed), /POOL_UPLOAD_LOOKUP_REQUIRED/);
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  });
  let recreated;
  await check("all old IDs explicitly absent allow new generation and latest body", async () => {
    recreated = await new PoolUploadIntents({ filePath }).prepare(config, changed, { lookupAccount: async id => {
      if (id === "12") throw Object.assign(Error("not found"), { status: 404 });
      return null;
    } });
    assert.notEqual(recreated.id, initial.id);
    assert.notEqual(recreated.key, initial.key);
    assert.deepEqual(recreated.account, changed);
    assert.deepEqual(recreated.existingIds, []);
    assert.equal(recreated.payloadChanged, false);
    assert.equal((await new PoolUploadIntents({ filePath }).prepare(config, payload)).id, recreated.id);
  });
  await check("only current generation and positive native IDs may be confirmed", async () => {
    const store = new PoolUploadIntents({ filePath });
    await assert.rejects(store.confirm(config, email, initial.id, [42]), /POOL_UPLOAD_INTENT_STALE/);
    for (const ids of [[], [0], [-1], [true], [null], ["01"], ["1.5"], [Number.MAX_SAFE_INTEGER + 1]]) {
      await assert.rejects(store.confirm(config, email, recreated.id, ids), /POOL_UPLOAD_IDS_INVALID/);
    }
    assert.equal((await store.prepare(config, changed)).id, recreated.id);
    await store.confirm(config, email.toUpperCase(), recreated.id, [42]);
    assert.deepEqual((await store.confirm(config, email, recreated.id, ["43"])).existingIds, ["42", "43"]);
  });
  await check("backend path, host and emails are isolated, API keys are not", async () => {
    const store = new PoolUploadIntents({ filePath });
    for (const baseUrl of ["https://other.example.test/api", "https://pool.example.test/other"]) {
      const other = await store.prepare({ ...config, baseUrl }, payload);
      assert.notEqual(other.id, recreated.id);
      assert.deepEqual(other.existingIds, []);
    }
    const otherEmail = await store.prepare(config, { ...payload, credentials: { email: "second@example.test", access_token: "synthetic" } });
    assert.notEqual(otherEmail.id, recreated.id);
  });
  await check("global file queue prevents lost writes across separate instances", async () => {
    const pairs = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const account = { ...payload, credentials: { email: `parallel-${index}@example.test`, access_token: "synthetic" } };
      const next = await new PoolUploadIntents({ filePath }).prepare(config, account);
      return { account, next };
    }));
    await Promise.all(pairs.map(({ account, next }, index) =>
      new PoolUploadIntents({ filePath }).confirm(config, account.credentials.email, next.id, [index + 100])));
    for (const { account, next } of pairs) {
      const existing = await new PoolUploadIntents({ filePath }).prepare(config, account, { lookupAccount: async id => ({ id }) });
      assert.equal(existing.id, next.id);
      assert.equal(existing.existingIds.length, 1);
    }
    const repeated = await Promise.all(Array.from({ length: 8 }, () => new PoolUploadIntents({ filePath }).prepare(config, {
      ...payload, credentials: { email: "same-concurrent@example.test", access_token: "synthetic" },
    })));
    assert.equal(new Set(repeated.map(record => record.id)).size, 1);
  });
  await check("forgetEmail clears that email across backends and preserves others", async () => {
    const store = new PoolUploadIntents({ filePath });
    assert.equal(await store.forgetEmail(email.toUpperCase()), 3);
    assert.equal(await store.forgetEmail(email), 0);
    const next = await store.prepare(config, payload);
    assert.notEqual(next.id, recreated.id);
    const recordCount = Object.keys(JSON.parse(await fs.readFile(filePath, "utf8")).entries).length;
    assert.equal(recordCount, 23);
  });
  await check("bad or unreadable files never reset an uncertain intent", async () => {
    const badFile = path.join(directory, "bad.json");
    await fs.writeFile(badFile, "{malformed existing content");
    await assert.rejects(new PoolUploadIntents({ filePath: badFile }).prepare(config, payload), /POOL_UPLOAD_INTENTS_INVALID/);
    assert.equal(await fs.readFile(badFile, "utf8"), "{malformed existing content");
    const unreadable = path.join(directory, "not-a-file");
    await fs.mkdir(unreadable);
    await assert.rejects(new PoolUploadIntents({ filePath: unreadable }).prepare(config, payload));
    assert((await fs.stat(unreadable)).isDirectory());
    const wrongVersion = path.join(directory, "version.json");
    await fs.writeFile(wrongVersion, JSON.stringify({ version: 2, entries: {} }));
    await assert.rejects(new PoolUploadIntents({ filePath: wrongVersion }).prepare(config, payload), /POOL_UPLOAD_INTENTS_INVALID/);
  });
  await check("JSON payload and backend values reject coercions", async () => {
    const store = new PoolUploadIntents({ filePath });
    for (const invalid of [undefined, NaN, Infinity, new Date(), () => {}, [undefined], new Array(1)]) {
      await assert.rejects(store.prepare(config, { ...payload, invalid }), /POOL_UPLOAD_PAYLOAD_INVALID/);
    }
    const cycle = { ...payload }; cycle.self = cycle;
    await assert.rejects(store.prepare(config, cycle), /POOL_UPLOAD_PAYLOAD_INVALID/);
    await assert.rejects(store.prepare(config, { ...payload, credentials: { email: true } }), /POOL_UPLOAD_EMAIL_INVALID/);
    for (const baseUrl of [true, "not-url", "ftp://pool.example.test", "https://user:pass@pool.example.test", "https://pool.example.test?a=1"]) {
      await assert.rejects(store.prepare({ baseUrl }, payload), /POOL_UPLOAD_BACKEND_INVALID/);
    }
    assert.throws(() => new PoolUploadIntents({ filePath: false }), /POOL_UPLOAD_INTENTS_PATH_INVALID/);
    // A rejected queued operation must not poison the next operation.
    assert((await store.prepare(config, payload)).key);
  });
  await check("observing pending remote rows preserves frozen body and permits later recreation", async () => {
    const observedFile = path.join(directory, "observed-pending.json");
    const store = new PoolUploadIntents({ filePath: observedFile });
    const pending = await store.prepare(config, payload);
    const observed = await store.observeExisting(config, changed, [201, "201", "202"]);
    assert.equal(observed.id, pending.id);
    assert.equal(observed.key, pending.key);
    assert.deepEqual(observed.account, payload);
    assert.deepEqual(observed.existingIds, ["201", "202"]);
    assert.equal(observed.payloadChanged, true);
    assert.equal(Object.values(JSON.parse(await fs.readFile(observedFile, "utf8")).entries)[0].state, "confirmed");
    const recreated = await new PoolUploadIntents({ filePath: observedFile }).prepare(config, changed, {
      lookupAccount: async () => null,
    });
    assert.notEqual(recreated.id, pending.id);
    assert.notEqual(recreated.key, pending.key);
    assert.deepEqual(recreated.account, changed);
  });
  await check("observing without an old intent saves confirmed state and merges later observations", async () => {
    const observedFile = path.join(directory, "observed-new.json");
    const store = new PoolUploadIntents({ filePath: observedFile });
    const observed = await store.observeExisting(config, changed, [301]);
    assert.deepEqual(observed.account, changed);
    assert.deepEqual(observed.existingIds, ["301"]);
    assert.equal(observed.payloadChanged, false);
    const repeated = await new PoolUploadIntents({ filePath: observedFile }).observeExisting(config, payload, [302]);
    assert.equal(repeated.id, observed.id);
    assert.equal(repeated.key, observed.key);
    assert.deepEqual(repeated.account, changed);
    assert.deepEqual(repeated.existingIds, ["301", "302"]);
    assert.equal(repeated.payloadChanged, true);
    await Promise.all(Array.from({ length: 8 }, (_, index) => new PoolUploadIntents({ filePath: observedFile }).observeExisting(config, payload, [400 + index])));
    const current = await store.prepare(config, payload, { lookupAccount: async id => ({ id }) });
    assert.equal(current.id, observed.id);
    assert.deepEqual(current.existingIds, ["301", "302", ...Array.from({ length: 8 }, (_, index) => String(400 + index))]);
  });
  await check("invalid observed IDs and corrupt files never overwrite existing records", async () => {
    const observedFile = path.join(directory, "observed-invalid.json");
    const store = new PoolUploadIntents({ filePath: observedFile });
    await store.observeExisting(config, payload, [501]);
    const before = await fs.readFile(observedFile, "utf8");
    for (const ids of [[], [0], [true], ["01"], [501, -2], [null]]) {
      await assert.rejects(store.observeExisting(config, changed, ids), /POOL_UPLOAD_IDS_INVALID/);
      assert.equal(await fs.readFile(observedFile, "utf8"), before);
    }
    const absentFile = path.join(directory, "observed-not-created.json");
    await assert.rejects(new PoolUploadIntents({ filePath: absentFile }).observeExisting(config, payload, []), /POOL_UPLOAD_IDS_INVALID/);
    await assert.rejects(fs.stat(absentFile), error => error.code === "ENOENT");
    await fs.writeFile(observedFile, "{synthetic-corrupt-record");
    await assert.rejects(store.observeExisting(config, changed, [502]), /POOL_UPLOAD_INTENTS_INVALID/);
    assert.equal(await fs.readFile(observedFile, "utf8"), "{synthetic-corrupt-record");
  });
  await check("explicit rejection persists and permits a corrected fresh generation", async () => {
    const rejectedFile = path.join(directory, "rejected.json"), store = new PoolUploadIntents({ filePath: rejectedFile });
    const old = await store.prepare(config, payload);
    await store.reject(config, email, old.id);
    const saved = Object.values(JSON.parse(await fs.readFile(rejectedFile, "utf8")).entries)[0];
    assert.equal(saved.state, "rejected"); assert(saved.rejectedAt); assert.deepEqual(saved.remoteIds, []);
    const next = await new PoolUploadIntents({ filePath: rejectedFile }).prepare(config, changed);
    assert.notEqual(next.key, old.key); assert.notEqual(next.id, old.id); assert.deepEqual(next.account, changed);
    await assert.rejects(store.reject(config, email, old.id), /POOL_UPLOAD_INTENT_STALE/);
    assert.equal((await store.prepare(config, changed)).key, next.key);
    await store.confirm(config, email, next.id, [601]);
    await assert.rejects(store.reject(config, email, next.id), /POOL_UPLOAD_INTENT_STALE/);
    assert.deepEqual((await store.prepare(config, payload, { lookupAccount: async id => ({ id }) })).existingIds, ["601"]);
  });
  console.log(`POOL_UPLOAD_INTENTS_PASS ${passed}/${passed} durable pending retries; confirmed-ID checks; recreation generations; strict inputs; backend isolation; global queue; deletion cleanup; observed-listing confirmation`);
} finally {
  const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  assert(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith("helper-upload-intents-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
