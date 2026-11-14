import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelFingerprintService, normalizeFingerprintSettings } from '../src/model-fingerprint.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-fingerprint-concurrency-'));
const settings = { models: ['fixture'], enabledPlanTypes: ['free'], testSequence: { first: 'candy', fingerprint: 0, candy: 1 }, matchedConcurrency: { enabled: true, value: 20 } };
let answer = '最终答案：21', samples = 0, writes = [], failId = null, backend = 'fixture', failAfterWrite = false;
const accounts = new Map([1, 2].map(id => [id, { id, type: 'oauth', status: 'active', schedulable: true, concurrency: id + 2, credentials: { email: 'a@test' }, group_ids: [10, 20] }]));
const targets = [...accounts.keys()].map(id => ({ id, email: 'a@test', profileId: 'default' }));
const options = {
  filePath: path.join(directory, 'state.json'),
  getContext: () => ({ backend, config: { baseUrl: 'https://fixture', adminApiKey: 'fixture' }, profiles: [], jobs: [{ email: 'a@test', planType: 'free' }] }),
  listTargets: async () => targets, getAccount: async (_config, id) => structuredClone(accounts.get(Number(id))),
  updateConcurrency: async (_config, id, value) => {
    if (Number(id) === failId) throw Error('private fixture upstream failure');
    writes.push([Number(id), value]); accounts.get(Number(id)).concurrency = value;
    if (failAfterWrite) { failAfterWrite = false; throw Error('response lost after commit'); }
  },
  sample: async () => { samples++; return answer; },
};
let service = new ModelFingerprintService(options);
const reconcile = () => service.reconcile('a@test', 'free', targets);
const save = patch => service.saveSettings({ ...service.settings, ...patch });
try {
  assert.deepEqual(normalizeFingerprintSettings({ planDefaults: { free: true, business: false } }).enabledPlanTypes, ['free']);
  assert.deepEqual(normalizeFingerprintSettings({ enabledPlanTypes: [], planDefaults: { free: true }, groupPolicies: { legacy: { 1: 'verified' } } }).enabledPlanTypes, []);
  assert.throws(() => normalizeFingerprintSettings({ groupPolicies: { bad: 'ignored' } }));
  for (const patch of [{ enabledPlanTypes: [''] }, { enabledPlanTypes: 'free' }, { matchedConcurrency: { enabled: 'yes', value: 2 } }, { matchedConcurrency: { enabled: true, value: -1 } }, { matchedConcurrency: { enabled: true, value: 1.5 } }, { matchedConcurrency: { enabled: true, value: 10001 } }]) assert.throws(() => normalizeFingerprintSettings(patch));
  await service.saveSettings(settings);
  await service.saveOverride('b@test', { enabled: true });
  assert.equal(service.snapshot('b@test', 'business').enabled, false, 'per-account override cannot bypass PlanType allowlist');
  let state = await service.run('a@test', 'free', { manual: true });
  assert.equal(state.result.status, 'match'); assert.deepEqual([...accounts.values()].map(a => a.concurrency), [20, 20]);
  assert.deepEqual([...accounts.values()].map(a => a.group_ids), [[10, 20], [10, 20]], 'no conditional group writes');
  assert.deepEqual(Object.values(service.accounts.get('a@test').concurrencyOverrides).map(o => o.baseValue), [3, 4]);
  answer = '无最终答案'; await service.run('a@test', 'free', { manual: true });
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [20, 20], 'unknown evidence preserves overrides');
  answer = '最终答案：22'; await service.run('a@test', 'free', { manual: true });
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [3, 4], 'mismatch restores each remote row independently');
  answer = '最终答案：21'; failId = 2;
  state = await service.run('a@test', 'free', { manual: true });
  assert.equal(state.concurrencySyncPending, true); assert(state.concurrencySyncError); assert(!state.concurrencySyncError.includes('private'));
  const beforeRetry = samples; failId = null;
  await service.stop(); service = new ModelFingerprintService(options); await service.load();
  await reconcile(); assert.equal(samples, beforeRetry, 'partial write retries across restart without inference');
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [20, 20]);
  assert.equal(service.snapshot('a@test', 'free').concurrencySyncError, null);
  await save({ matchedConcurrency: { enabled: true, value: 30 } }); await reconcile();
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [30, 30]);
  // Manual helper edits win until a new genuine round.
  await service.manualConcurrency('a@test', async record => { accounts.get(1).concurrency = 7; await record(1); });
  await save({ maxConcurrentAccounts: 4 }); await reconcile(); assert.equal(accounts.get(1).concurrency, 7);
  await service.stop(); service = new ModelFingerprintService(options); await service.load(); await reconcile(); assert.equal(accounts.get(1).concurrency, 7);
  await service.run('a@test', 'free', { manual: true }); assert.equal(accounts.get(1).concurrency, 30);
  // External pool edit must not be overwritten by restore, either.
  accounts.get(2).concurrency = 8;
  await save({ matchedConcurrency: { enabled: false, value: 30 } }); await reconcile();
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [7, 8]);
  await save({ matchedConcurrency: { enabled: true, value: 40 } });
  await service.run('a@test', 'free', { manual: true });
  const writeProfile = body => { Object.assign(accounts.get(1), body); };
  await service.poolAccountUpdate('a@test', 1, backend, { concurrency: 12, name: 'new profile' }, writeProfile, { updateBase: true });
  assert.equal(accounts.get(1).concurrency, 40, 'profile changes preserve active special concurrency');
  await service.poolAccountUpdate('a@test', 1, backend, { concurrency: 1, credentials: { email: 'a@test', access_token: 'new' } }, writeProfile);
  assert.equal(accounts.get(1).concurrency, 40, 'OAuth refresh preserves special concurrency and baseline');
  await save({ enabledPlanTypes: [] }); await reconcile();
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [12, 8], 'removing PlanType restores new profile baseline');
  assert.equal(service.snapshot('a@test', 'free').enabled, false);
  await save({ enabledPlanTypes: ['free'], matchedConcurrency: { enabled: true, value: 0 } });
  failAfterWrite = true; await service.run('a@test', 'free', { manual: true });
  await service.stop(); service = new ModelFingerprintService(options); await service.load(); await reconcile();
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [0, 0], 'zero concurrency and ambiguous successful writes survive restart');
  backend = 'other'; await save({ matchedConcurrency: { enabled: false, value: 0 } }); const beforeBackend = writes.length; await reconcile();
  assert.equal(writes.length, beforeBackend, 'ownership cannot write to another backend with the same account ID');
  backend = 'fixture'; service.accounts.get('a@test').concurrencySyncPending = true; await reconcile();
  assert.deepEqual([...accounts.values()].map(a => a.concurrency), [12, 8]);
  let parallelWrites = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const concurrentWrites = [1, 2].map(id => service.poolAccountUpdate('unmanaged@test', id, backend, { concurrency: 5 }, async () => { parallelWrites++; await gate; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parallelWrites, 2, 'default-off policy must not serialize ordinary profile network requests');
  release(); await Promise.all(concurrentWrites);
  console.log('PASS: PlanType allowlist migration, candy pass/mismatch/unknown, per-row concurrency baselines, restart/partial-write retries, manual/external edits, profile/OAuth preservation, allowlist removal, zero and backend isolation');
} finally { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }
