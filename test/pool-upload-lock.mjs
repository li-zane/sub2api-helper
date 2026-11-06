import assert from "node:assert/strict";
import { PoolUploadLocks, poolUploadIdempotencyKey, uniquePoolUploadAccounts } from "../src/pool-upload-lock.mjs";

const config = { baseUrl: "https://pool.example.test/", adminApiKey: "first-fixture-key" };
const email = "fixture@example.test", pause = () => new Promise(resolve => setTimeout(resolve, 2));
const locks = new PoolUploadLocks();
let rows = [], created = 0, updated = 0;
async function writeAccount() {
  const snapshot = rows.slice();
  await pause();
  if (snapshot.some(row => row.email === email)) updated++;
  else { await pause(); rows.push({ id: ++created, email }); }
}
if (process.argv.includes("--baseline")) {
  await Promise.all([writeAccount(), writeAccount()]);
  assert.equal(rows.length, 2);
  console.log("POOL_UPLOAD_BASELINE_REPRODUCED concurrent list-before-create requests created 2 same-email rows");
  process.exitCode = 1;
} else {
  await Promise.all(Array.from({ length: 20 }, (_, n) => locks.run({ ...config, adminApiKey: `fixture-key-${n}` }, [n % 2 ? email.toUpperCase() : email], writeAccount)));
  assert.equal(rows.length, 1); assert.equal(created, 1); assert.equal(updated, 19); assert.equal(locks.tails.size, 0);

  let active = 0, maxActive = 0;
  const work = async () => { active++; maxActive = Math.max(maxActive, active); await pause(); active--; };
  await Promise.all([locks.run(config, ["one@example.test"], work), locks.run(config, ["two@example.test"], work)]);
  assert.equal(maxActive, 2, "different accounts should remain concurrent");
  maxActive = 0;
  await Promise.all([locks.run(config, [email], work), locks.run({ baseUrl: "https://other.example.test" }, [email], work)]);
  assert.equal(maxActive, 2, "different backends should remain concurrent");

  let bulkActive = 0, bulkMax = 0;
  const bulk = async () => { bulkActive++; bulkMax = Math.max(bulkMax, bulkActive); await pause(); bulkActive--; };
  await Promise.all([locks.run(config, ["one@example.test", "two@example.test"], bulk), locks.run(config, ["two@example.test", "one@example.test"], bulk)]);
  assert.equal(bulkMax, 1); assert.equal(locks.tails.size, 0);
  await assert.rejects(locks.run(config, [email], () => { throw Error("fixture rejection"); }), /fixture rejection/);
  await locks.run(config, [email], () => "released"); assert.equal(locks.tails.size, 0);

  const a = { platform: "openai", type: "oauth", credentials: { email, access_token: "fixture-secret-not-logged" }, group_ids: [1, 2] };
  const b = { platform: "openai", type: "oauth", credentials: { email: "other@example.test", access_token: "fixture-other-not-logged" }, group_ids: [] };
  const reordered = { credentials: { access_token: "fixture-secret-not-logged", email }, group_ids: [1, 2], type: "oauth", platform: "openai" };
  assert.equal(poolUploadIdempotencyKey(config, [a, b]), poolUploadIdempotencyKey({ ...config, baseUrl: "https://POOL.example.test:443" }, [b, reordered]));
  assert(poolUploadIdempotencyKey(config, [a]).length <= 64);
  assert.notEqual(poolUploadIdempotencyKey(config, [a]), poolUploadIdempotencyKey(config, [a], "confirmed-recreation-generation"));
  assert.notEqual(poolUploadIdempotencyKey(config, [a]), poolUploadIdempotencyKey(config, [{ ...a, group_ids: [3] }]));
  assert.equal(uniquePoolUploadAccounts([a, reordered]).length, 1);
  assert.throws(() => uniquePoolUploadAccounts([a, { ...a, credentials: { email, access_token: "different-fixture-token" } }]), error => error.status === 409 && error.code === "POOL_UPLOAD_DUPLICATE_EMAIL");
  await assert.rejects(locks.run(config, [""], work), /POOL_UPLOAD_EMAIL_INVALID/);
  await assert.rejects(locks.run({ baseUrl: "https://user:password@pool.example.test" }, [email], work), /POOL_UPLOAD_BACKEND_INVALID/);
  assert.equal(locks.tails.size, 0);
  console.log("POOL_UPLOAD_LOCK_PASS one creation across 20 concurrent uploads; backend/email normalization; different-account/backend concurrency; overlapping-batch order; failure release; stable retry keys; duplicate-payload controls");
}
