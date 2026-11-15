import assert from 'node:assert/strict';
import { Sub2ApiGroupReferences } from '../src/sub2api-group-references.mjs';

const config = { baseUrl: 'https://fixture.test', adminApiKey: 'fixture' }, results = [];
const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, error: error.message }); } };
const missing = () => Object.assign(Error('group does not exist'), { remoteCode: 'GROUP_NOT_FOUND' });
function fixture({ fail, malformed, available = [1, 77], onCatalog } = {}) {
  let reads = 0, changes = 0;
  const guard = new Sub2ApiGroupReferences({
    request: async (_config, url) => {
      reads++;
      if (fail && url.includes('composite')) throw Error('transient fixture error');
      if (malformed) return { data: { items: [] } };
      return { data: available.map(id => ({ id, platform: id === 77 ? 'composite' : 'openai' })) };
    },
    onCatalog: async (...args) => { changes++; await onCatalog?.(...args); },
  });
  return { guard, reads: () => reads, changes: () => changes };
}
await test('deleted-reference-filter-preserves-valid-openai-and-composite-groups', async () => {
  const f = fixture(), value = await f.guard.resolve(config, [1, 35, 77]);
  assert.deepEqual(value.ids, [1, 77]); assert.deepEqual(value.missing, [35]); assert.equal(value.confirmed, true);
});
for (const mode of ['fail', 'malformed']) await test(mode + '-catalog-preserves-original-references', async () => {
  const f = fixture({ [mode]: true }), value = await f.guard.resolve(config, [1, 35]);
  assert.deepEqual(value.ids, [1, 35]); assert.equal(value.confirmed, false); assert.equal(f.changes(), 0);
});
await test('successful-empty-catalog-is-distinct-from-an-unavailable-catalog', async () => {
  const f = fixture({ available: [] }); assert.deepEqual((await f.guard.resolve(config, [35])).missing, [35]);
});
await test('explicitly-truncated-catalog-never-removes-a-reference', async () => {
  let changes = 0;
  const guard = new Sub2ApiGroupReferences({ request: async () => ({ data: [{ id: 1 }], total: 2 }), onCatalog: async () => { changes++; } });
  assert.deepEqual((await guard.resolve(config, [1, 35])).ids, [1, 35]); assert.equal(changes, 0);
});
await test('put-retries-on-typed-missing-group-and-preserves-other-fields', async () => {
  const f = fixture(), sends = [], body = { group_ids: [1, 35], credentials: { access_token: 'fixture' }, proxy_id: 4, extra: { preserve: true } }, options = { method: 'PUT', body: JSON.stringify(body) };
  await f.guard.write(config, '/api/v1/admin/accounts/100', options, async (_config, _url, input) => { sends.push(JSON.parse(input.body)); if (sends.length === 1) throw missing(); return { ok: true }; });
  assert.equal(sends.length, 2); assert.deepEqual(sends[1], { ...body, group_ids: [1] }); assert.deepEqual(JSON.parse(options.body), body);
});
await test('all-deleted-put-targets-do-not-clear-unrelated-memberships', async () => {
  const f = fixture(), sends = [];
  await f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: JSON.stringify({ group_ids: [35], proxy_id: 4 }) }, async (_config, _url, options) => { sends.push(JSON.parse(options.body)); if (sends.length === 1) throw missing(); });
  assert.deepEqual(sends[1], { proxy_id: 4 });
});
await test('legacy-text-group-error-is-rechecked-against-the-catalog', async () => {
  const f = fixture(); let writes = 0;
  await f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: '{"group_ids":[1,35]}' }, async (_config, _url, options) => {
    if (++writes === 1) throw Error('Sub2API group not found');
    assert.deepEqual(JSON.parse(options.body).group_ids, [1]);
  });
  assert.equal(writes, 2);
});
await test('explicit-empty-group-write-remains-an-explicit-clear', async () => {
  const f = fixture(); let calls = 0;
  await f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: '{"group_ids":[]}' }, async (_config, _url, options) => { calls++; assert.deepEqual(JSON.parse(options.body).group_ids, []); });
  assert.equal(calls, 1); assert.equal(f.reads(), 0);
});
await test('unknown-catalog-never-retries-a-write-or-cleans-settings', async () => {
  const f = fixture({ fail: true }); let writes = 0;
  await assert.rejects(f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: '{"group_ids":[35]}' }, async () => { writes++; throw missing(); }));
  assert.equal(writes, 1); assert.equal(f.changes(), 0);
});
await test('unrelated-errors-do-not-trigger-group-recovery', async () => {
  const f = fixture(); let writes = 0;
  await assert.rejects(f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: '{"group_ids":[35]}' }, async () => { writes++; throw Error('fixture 429'); }), /429/);
  assert.equal(writes, 1); assert.equal(f.reads(), 0);
});
await test('batch-create-is-never-blindly-reposted', async () => {
  const f = fixture(); let writes = 0;
  await assert.rejects(f.guard.write(config, '/api/v1/admin/accounts/batch', { method: 'POST', body: '{"accounts":[{"group_ids":[35]}]}' }, async () => { writes++; throw missing(); }));
  assert.equal(writes, 1); assert.equal(f.reads(), 0);
});
await test('retry-is-bounded-when-another-group-disappears', async () => {
  const f = fixture(); let writes = 0;
  await assert.rejects(f.guard.write(config, '/api/v1/admin/accounts/100', { method: 'PUT', body: '{"group_ids":[1,35]}' }, async () => { writes++; throw missing(); }));
  assert.equal(writes, 2);
});
await test('positive-catalog-cache-and-inflight-reads-are-shared', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 20 }, () => f.guard.resolve(config, [1, 77])));
  assert.equal(f.reads(), 2); await f.guard.resolve(config, [1]); assert.equal(f.reads(), 2);
});
await test('catalog-cache-is-isolated-by-backend-and-admin-key', async () => {
  const f = fixture(); await f.guard.resolve(config, [1]);
  await f.guard.resolve({ ...config, adminApiKey: 'other' }, [1]);
  await f.guard.resolve({ ...config, baseUrl: 'https://other.test' }, [1]); assert.equal(f.reads(), 6);
});
await test('cached-negative-lookup-rechecks-before-removing-a-new-group', async () => {
  const available = [1], f = fixture({ available }); await f.guard.resolve(config, [1]); available.push(35);
  const value = await f.guard.resolve(config, [1, 35]); assert.deepEqual(value.ids, [1, 35]); assert.equal(f.changes(), 0);
});
for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'}: ${result.name}${result.error ? ' — ' + result.error : ''}`);
const passed = results.filter(result => result.passed).length;
console.log(`GROUP_REFERENCE_REGRESSION ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
