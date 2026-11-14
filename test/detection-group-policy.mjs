import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelFingerprintService } from '../src/model-fingerprint.mjs';
import { CANDY_PROMPT } from '../src/candy-test.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-detection-policy-'));
let phase = 'match', groupWrites = 0;
const email = 'policy@example.test', account = { id: 9, type: 'oauth', status: 'active', concurrency: 3, credentials: { access_token: 'fixture' }, group_ids: ['10', '99'] };
const options = {
  filePath: path.join(dir, 'state.json'),
  getContext: () => ({ backend: 'fixture', config: { baseUrl: 'https://fixture', adminApiKey: 'fixture' }, profiles: [], jobs: [{ email, planType: 'free' }] }),
  listTargets: async () => [{ id: 9, email }], getAccount: async () => structuredClone(account),
  sample: async (_c, _a, model, prompt) => prompt === CANDY_PROMPT ? `最终答案：${phase === 'mismatch' || phase === 'mixed' && model === 'second' ? 22 : 21}` : Array.from({ length: 100 }, (_, i) => i + 1).join(','),
  challenges: () => [1, 2, 3].map(i => ({ prompt: 'fingerprint-' + i, expected_count: 100 })),
  detectorLoader: async () => ({ analyze: () => ({ decision: 'scored', used_outputs: 3, probability_status: 'reference_calibrated', probability: .99, prediction: phase === 'mismatch' ? 'other' : 'fixture', results: [{ model: 'fixture' }, { model: 'other' }] }) }),
  updateGroups: async () => { groupWrites++; },
  updateConcurrency: async (_c, _id, value) => { account.concurrency = value; },
};
let service = new ModelFingerprintService(options);
const run = async (method, status) => {
  phase = status;
  await service.saveOverride(email, { testSequence: { first: method, fingerprint: method === 'fingerprint' ? 1 : 0, candy: method === 'candy' ? 1 : 0 } });
  return service.run(email, 'free', { manual: true });
};
try {
  await service.saveSettings({ models: ['fixture'], enabledPlanTypes: ['free'], matchedConcurrency: { enabled: true, value: 20 }, groupPolicies: { default: { 20: 'verified' } } });
  for (const [first, second] of [['fingerprint', 'candy'], ['candy', 'fingerprint']]) {
    assert.equal((await run(first, 'match')).result.status, 'match'); assert.equal(account.concurrency, 20);
    assert.equal((await run(second, 'mismatch')).result.status, 'mismatch'); assert.equal(account.concurrency, 3, 'new explicit failure supersedes the previous method');
    assert.equal((await run(second, 'match')).result.status, 'match'); assert.equal(account.concurrency, 20, 'either method passes independently');
  }
  await service.saveSettings({ ...service.settings, models: ['fixture', 'second'] });
  assert.equal((await run('candy', 'mixed')).result.status, 'mismatch'); assert.equal(account.concurrency, 3, 'every configured model in the current round must pass');
  assert.equal(groupWrites, 0); assert.deepEqual(account.group_ids, ['10', '99']);
  assert.deepEqual(service.filterGroups(email, 'free', 'default', ['10', '20', '99']), ['10', '20', '99'], 'group profile membership is unconditional');
  await service.stop();
  const saved = JSON.parse(await fs.readFile(options.filePath, 'utf8'));
  saved.groupPolicyVersion = 2; saved.settings.groupPolicies = { default: { 20: 'verified' } }; saved.accounts[email].groupSyncPending = true; saved.accounts[email].groupSyncError = 'stale group error';
  await fs.writeFile(options.filePath, JSON.stringify(saved));
  service = new ModelFingerprintService(options); await service.load();
  const migrated = JSON.parse(await fs.readFile(options.filePath, 'utf8'));
  assert.equal(migrated.settings.groupPolicies, undefined); assert.equal(migrated.accounts[email].groupSyncPending, undefined); assert.equal(migrated.accounts[email].groupSyncError, undefined);
  assert(service.history(email, 'free').records.length > 0, 'migration preserves test history');
  console.log('PASS: fingerprint/candy share latest-round concurrency policy, all-model verdict, retired group writes, legacy pending-policy cleanup and history retention');
} finally { await service.stop(); await fs.rm(dir, { recursive: true, force: true }); }
