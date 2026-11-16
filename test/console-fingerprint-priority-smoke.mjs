import './legacy-import-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const output = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-priority-console-'));
const account = { id: 42, name: 'priority@example.test', platform: 'openai', type: 'oauth', status: 'active', schedulable: true,
  priority: 9, concurrency: 3, created_at: '2026-11-01T00:00:00Z', group_ids: [], extra: {},
  credentials: { email: 'priority@example.test', plan_type: 'free', access_token: 'fixture-access', chatgpt_account_id: 'fixture-account' } };
let child, headers, logs = '', answer = '最终答案：21', samples = 0;
const writes = [];
const pool = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  res.setHeader('content-type', 'application/json');
  const send = value => res.end(JSON.stringify({ data: value }));
  if (req.url === '/responses') {
    assert.equal(req.headers.authorization, 'Bearer fixture-access'); samples++;
    res.setHeader('content-type', 'text/event-stream');
    return res.end([{ type: 'response.output_text.delta', delta: answer }, { type: 'response.completed', response: {} }]
      .map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  }
  if (req.url.startsWith('/api/v1/admin/accounts?')) return send({ items: [account], total: 1, pages: 1 });
  if (req.url === '/api/v1/admin/accounts/42') {
    if (req.method === 'PUT') { const body = JSON.parse(raw); writes.push(body); Object.assign(account, body); }
    return send(account);
  }
  return send([]);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(pool); const slot = http.createServer(); await listen(slot); const port = slot.address().port; await new Promise(resolve => slot.close(resolve));
const base = `http://127.0.0.1:${port}`, poolUrl = `http://127.0.0.1:${pool.address().port}`;
const waitFor = async predicate => {
  for (const end = Date.now() + 15000; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error('priority fixture timeout\n' + logs);
};
async function start() {
  child = spawn(process.execPath, ['src/console-server.mjs', '--host', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test', ONBOARDING_OUTPUT_ROOT: output,
      LOCALAPPDATA: output, SUB2API_MONITOR_ENABLED: '0', TOSUB2_FINGERPRINT_TEST_URL: poolUrl + '/responses' },
  });
  child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  await waitFor(async () => { try { const r = await fetch(base + '/api/bootstrap'); const data = await r.json(); headers = { 'content-type': 'application/json', 'x-console-token': data.token }; return Boolean(data.token); } catch { return false; } });
}
async function stop() { if (child && child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; } }
async function api(route, body, expected = 200) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
}
async function runCheck(job) {
  const before = (await api('/api/jobs')).jobs.find(j => j.id === job.id).modelFingerprint.result?.id;
  await api(`/api/jobs/${job.id}/model-fingerprint/check`, {}, 202);
  let state;
  await waitFor(async () => {
    state = (await api('/api/jobs')).jobs.find(j => j.id === job.id).modelFingerprint;
    return state.phase === 'idle' && state.result && state.result.id !== before;
  });
  return state;
}
const config = { baseUrl: poolUrl, adminApiKey: 'fixture-key', priority: null, importDatePriority: { enabled: true, min: 5, max: 5 } };
const policy = { models: ['fixture-model'], enabledPlanTypes: ['free'], intervalMinutes: 360,
  testSequence: { first: 'candy', fingerprint: 0, candy: 1 }, matchedPriority: { enabled: true, value: 1 } };
try {
  await start(); await api('/api/sub2api/settings', { config });
  await api('/api/task-settings', { monitoring: { fingerprintScanIntervalSeconds: 1 } });
  assert.equal(account.priority, 5);
  const job = (await api('/api/jobs')).jobs.find(job => job.email === account.name); assert(job);
  for (const matchedPriority of [null, { enabled: true, value: -1 }, { enabled: 'yes', value: 1 }, { enabled: true, value: 1.5 }, { enabled: true, value: 10001 }]) {
    await api('/api/model-fingerprint/settings', { settings: { ...policy, matchedPriority } }, 400);
  }
  await api('/api/model-fingerprint/settings', { settings: policy });
  await runCheck(job);
  await waitFor(() => account.priority === 1);
  await waitFor(async () => (await api('/api/jobs')).jobs.find(j => j.id === job.id).modelFingerprint.phase === 'idle');
  config.importDatePriority = { enabled: true, min: 7, max: 7 };
  await api('/api/sub2api/settings', { config }); assert.equal(account.priority, 1, 'date rule overwrote matched priority');
  const beforePoll = writes.length;
  for (let n = 0; n < 3; n++) {
    const state = await api('/api/sub2api/account-status?refresh=1'); assert.equal(state.accounts[account.name].priority, 1, 'status misrepresented applied priority');
  }
  assert.equal(writes.length, beforePoll, 'date polling repeatedly rewrote the same managed priority');
  const beforeRestart = samples; await stop(); await start();
  await api('/api/sub2api/account-status?refresh=1'); assert.equal(account.priority, 1); assert.equal(samples, beforeRestart, 'restart repeated inference');
  await api('/api/model-fingerprint/settings', { settings: { ...policy, matchedPriority: { enabled: false, value: 1 } } });
  await waitFor(async () => { await api('/api/jobs'); return account.priority === 7; });
  config.importDatePriority.enabled = false; await api('/api/sub2api/settings', { config });
  await api(`/api/sub2api/accounts/${job.id}/priority`, { priority: 4 }); assert.equal(account.priority, 4);
  await api('/api/model-fingerprint/settings', { settings: { ...policy, matchedPriority: { enabled: true, value: 0 } } });
  for (let n = 0; n < 5; n++) {
    await api('/api/task-settings', { modelFingerprint: { maxConcurrentAccounts: n % 2 ? 3 : 4 } });
    await runCheck(job); assert.equal(account.priority, 0, 'policy/cache refresh race lost manual detection');
  }
  await api(`/api/sub2api/accounts/${job.id}/priority`, { priority: 6 });
  await api('/api/task-settings', { modelFingerprint: { maxConcurrentAccounts: 4 } });
  assert.deepEqual((await api('/api/model-fingerprint/settings')).settings.matchedPriority, { enabled: true, value: 0 });
  assert.equal(account.priority, 6, 'unrelated settings overwrote a successful manual priority edit');
  await runCheck(job); assert.equal(account.priority, 0);
  answer = '最终答案：22'; await runCheck(job);
  assert.equal(account.priority, 6, 'mismatch did not restore manual baseline'); assert.equal(account.concurrency, 3);
  const state = (await api('/api/jobs')).jobs.find(j => j.id === job.id);
  assert.equal(state.sub2apiPriority, 6); assert.equal(state.modelFingerprint.prioritySyncPending, false); assert.equal(state.modelFingerprint.prioritySyncError, null);
  console.log('FINGERPRINT_PRIORITY_HTTP_PASS settings validation; real sampler to mock pool; date rule precedence/no repeat writes; restart; disable restores date baseline; manual priority ownership; task preservation; zero; mismatch restores; status sync');
} finally {
  await stop(); pool.closeAllConnections(); await new Promise(resolve => pool.close(resolve)); await fs.rm(output, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
