import assert from "node:assert/strict";
import { poolCreateAccount, poolBatchResult } from "../src/pool-batch-result.mjs";
const account = { name: "[Free] fixture@example.test", proxy_id: 0, credentials: { email: "fixture@example.test" } };
const direct = poolCreateAccount(account);
assert(!Object.hasOwn(direct, "proxy_id")); assert.equal(account.proxy_id, 0);
assert(!Object.hasOwn(poolCreateAccount({ ...account, proxy_id: null }), "proxy_id"));
assert.equal(poolCreateAccount({ ...account, proxy_id: 32 }).proxy_id, 32);
const rejected = { success: 0, failed: 1, results: [{ name: account.name, success: false, error: "fixture proxy FK rejected" }] };
assert.equal(poolBatchResult({ data: rejected }, account).error, "fixture proxy FK rejected");
assert.equal(poolBatchResult(rejected, account).rejected, true);
assert.equal(poolBatchResult(rejected, account).noCommit, false, "item failure may follow a committed row");
const fk = { ...rejected, results: [{ ...rejected.results[0], error: 'ent: constraint failed: pq: insert or update on table "accounts" violates foreign key constraint "accounts_proxy_id_fkey"' }] };
assert.equal(poolBatchResult(fk, account).noCommit, true);
for (const bad of [null, {}, { ...rejected, success: 1 }, { ...rejected, failed: 0 },
  { ...rejected, accounts: [{ id: 3 }] }, { ...rejected, results: [...rejected.results, ...rejected.results] },
  ...[{ name: "other" }, { success: "false" }, { id: 3 }, { error: null }].map(patch => ({ ...rejected, results: [{ ...rejected.results[0], ...patch }] }))]) {
  assert.equal(poolBatchResult(bad, account).rejected, false, "ambiguous/contradictory receipt rotated key");
}
for (const id of [1, "42"]) assert.deepEqual(poolBatchResult({ data: { results: [{ name: account.name, success: true, id }] } }, account).ids, [String(id)]);
for (const id of [0, -1, "01", true, "bad", Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(poolBatchResult({ results: [{ name: account.name, success: true, id }] }, account).ids, []);
console.log("POOL_BATCH_RESULT_PASS create-only zero-FK omission; real per-item success IDs; strict explicit rejection; ambiguous receipts preserve original intent");
