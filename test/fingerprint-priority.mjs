import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelFingerprintService, normalizeFingerprintSettings } from '../src/model-fingerprint.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-fingerprint-priority-'));
let answer = '最终答案：21', samples = 0, writes = [], failId = null, backend = 'fixture', failAfterWrite = false, blocked = false;
const accounts = new Map([1, 2].map(id => [id, { id, type: 'oauth', priority: id + 8, concurrency: id + 2, credentials: { email: 'a@test' }, group_ids: [10] }]));
const targets = [...accounts.keys()].map(id => ({ id, email: 'a@test', profileId: 'default' }));
const options = {
  filePath: path.join(directory, 'state.json'),
  getContext: () => ({ backend, config: { baseUrl: 'https://fixture.test', adminApiKey: 'fixture' }, profiles: [], jobs: [{ email: 'a@test', planType: 'free' }] }),
  listTargets: async () => targets, getAccount: async (_config, id) => structuredClone(accounts.get(Number(id))),
  updateConcurrency: async (_config, id, value) => { accounts.get(Number(id)).concurrency = value; },
  updatePriority: async (_config, id, value) => {
    if (Number(id) === failId) throw Error('private upstream detail');
    writes.push([Number(id), value]); accounts.get(Number(id)).priority = value;
    if (failAfterWrite) { failAfterWrite = false; throw Error('response lost after commit'); }
  },
  sample: async () => { samples++; return answer; }, isBlocked: () => blocked,
};
let service = new ModelFingerprintService(options);
const values = field => [...accounts.values()].map(a => a[field]);
const reconcile = () => service.reconcile('a@test', 'free', targets);
const save = patch => service.saveSettings({ ...service.settings, ...patch });
const restart = async () => { await service.stop(); service = new ModelFingerprintService(options); await service.load(); };
try {
  assert.deepEqual(normalizeFingerprintSettings().matchedPriority, { enabled: false, value: 1 }, 'independent priority defaults must be exposed');
  for (const matchedPriority of [null, {}, { enabled: 'yes', value: 1 }, { enabled: true, value: -1 },
    { enabled: true, value: 1.5 }, { enabled: true, value: 10001 }, { enabled: true, value: '1' }]) {
    assert.throws(() => normalizeFingerprintSettings({ matchedPriority }), /优先级/);
  }
  await save({ models: ['fixture'], enabledPlanTypes: ['free'], testSequence: { first: 'candy', fingerprint: 0, candy: 1 },
    matchedConcurrency: { enabled: true, value: 30 }, matchedPriority: { enabled: true, value: 0 } });
  await service.run('a@test', 'free', { manual: true });
  assert.deepEqual(values('priority'), [0, 0]); assert.deepEqual(values('concurrency'), [30, 30]);
  assert.deepEqual(Object.values(service.accounts.get('a@test').priorityOverrides).map(o => o.baseValue), [9, 10]);
  const { matchedPriority, ...legacyPayload } = service.settings;
  await service.saveSettings(legacyPayload); assert.deepEqual(service.settings.matchedPriority, matchedPriority, 'old client save reset priority policy');
  answer = '缺少最终答案'; await service.run('a@test', 'free', { manual: true });
  assert.deepEqual(values('priority'), [0, 0], 'unknown evidence restored priority');
  answer = '最终答案：22'; await service.run('a@test', 'free', { manual: true });
  assert.deepEqual(values('priority'), [9, 10], 'explicit mismatch must restore each row baseline');
  assert.deepEqual(values('concurrency'), [3, 4]);
  answer = '最终答案：21'; failId = 2;
  const failed = await service.run('a@test', 'free', { manual: true });
  assert(failed.prioritySyncPending && failed.prioritySyncError); assert(!failed.prioritySyncError.includes('private'));
  assert.equal(failed.concurrencySyncError, null); assert.deepEqual(values('concurrency'), [30, 30], 'priority failure blocked independent concurrency');
  const beforeRetry = samples; failId = null; await restart(); await reconcile();
  assert.equal(samples, beforeRetry, 'restart retry ran inference again'); assert.deepEqual(values('priority'), [0, 0]);
  assert.equal(service.history('a@test', 'free').prioritySyncError, null);
  await service.manualPriority('a@test', async record => { accounts.get(1).priority = 7; await record(1); });
  await save({ maxConcurrentAccounts: 4 }); await reconcile(); assert.equal(accounts.get(1).priority, 7);
  await restart(); await reconcile(); assert.equal(accounts.get(1).priority, 7, 'restart overwrote manual priority');
  await service.run('a@test', 'free', { manual: true }); assert.deepEqual(values('priority'), [0, 0]);
  await service.manualConcurrency('a@test', async record => { accounts.get(1).concurrency = 22; await record(1); });
  assert.equal(service.accounts.get('a@test').priorityOverrides[1].baseValue, 7, 'manual concurrency cleared priority ownership');
  accounts.get(2).priority = 8;
  await save({ matchedPriority: { enabled: false, value: 0 } }); await reconcile();
  assert.deepEqual(values('priority'), [7, 8], 'disable overwrote manual/external edits'); assert.deepEqual(values('concurrency'), [22, 30]);
  await save({ matchedPriority: { enabled: true, value: 2 } }); await service.run('a@test', 'free', { manual: true });
  const write = body => { Object.assign(accounts.get(1), body); };
  await service.poolAccountUpdate('a@test', 1, backend, { priority: 6, concurrency: 12 }, write, { updateBase: true });
  assert.equal(accounts.get(1).priority, 2, 'profile/date sync overwrote managed priority'); assert.equal(accounts.get(1).concurrency, 30);
  await service.poolAccountUpdate('a@test', 1, backend, { priority: 100, concurrency: 1, credentials: { email: 'a@test', access_token: 'new' } }, write);
  assert.equal(accounts.get(1).priority, 2, 'OAuth upload overwrote managed priority');
  await save({ enabledPlanTypes: [] }); await reconcile();
  assert.deepEqual(values('priority'), [6, 8], 'allowlist removal did not restore latest profile/date baseline');
  assert.deepEqual(values('concurrency'), [12, 4]);
  await save({ enabledPlanTypes: ['free'], matchedPriority: { enabled: true, value: 10000 }, matchedConcurrency: { enabled: false, value: 30 } });
  failAfterWrite = true; await service.run('a@test', 'free', { manual: true }); await restart(); await reconcile();
  assert.deepEqual(values('priority'), [10000, 10000], 'ambiguous successful write lost intent across restart');
  backend = 'other'; await save({ matchedPriority: { enabled: false, value: 10000 } }); const count = writes.length; await reconcile();
  assert.equal(writes.length, count, 'priority ownership crossed backend boundary');
  backend = 'fixture'; service.accounts.get('a@test').prioritySyncPending = true; await reconcile();
  assert.deepEqual(values('priority'), [6, 8]);
  await save({ matchedPriority: { enabled: true, value: 1 } }); blocked = true; await reconcile(); assert.deepEqual(values('priority'), [6, 8], 'blocked account was modified');
  blocked = false; await reconcile(); assert.deepEqual(values('priority'), [1, 1]);
  console.log('FINGERPRINT_PRIORITY_PASS defaults/validation; pass/unknown/mismatch; independent concurrency; durable per-row baselines; partial/crash retries; manual/external edits; profile/date/OAuth preservation; allowlist removal; backend/block guards; legacy saves');
} finally { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }
