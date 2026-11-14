import './legacy-import-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-account-concurrency-'));
const rows = [1, 2].map(id => ({ id, name: 'concurrency@example.test', platform: 'openai', type: 'oauth', status: 'active', schedulable: true, concurrency: 3, priority: 9, credentials: { email: 'concurrency@example.test', plan_type: 'free' }, extra: {}, group_ids: [] }));
const writes = []; let failId = null, child, headers, logs = '';
const pool = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  const send = data => res.end(JSON.stringify({ data }));
  if (req.url.startsWith('/api/v1/admin/accounts?')) return send({ items: rows, pages: 1, total: rows.length });
  const row = rows.find(r => req.url === `/api/v1/admin/accounts/${r.id}`);
  if (row && req.method === 'PUT') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (row.id === failId) { res.statusCode = 503; return res.end('{"error":"fixture write failed"}'); }
    writes.push([row.id, body]); Object.assign(row, body); return send(row);
  }
  if (row) return send(row);
  return send([]);
});
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
await listen(pool); const slot = http.createServer(); await listen(slot); const port = slot.address().port; await new Promise(resolve => slot.close(resolve));
const base = `http://127.0.0.1:${port}`;
const post = async (route, body, expected = 200) => {
  const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) }); const data = await r.json();
  assert.equal(r.status, expected, JSON.stringify(data)); return data;
};
const get = async route => { const r = await fetch(base + route, { headers }); assert.equal(r.status, 200); return r.json(); };
const refresh = () => get('/api/sub2api/account-status?refresh=1');
try {
  const noPoolId = '11111111-1111-4111-8111-111111111111';
  await fs.mkdir(path.join(output, noPoolId));
  await fs.writeFile(path.join(output, noPoolId, 'job-meta.json'), JSON.stringify({ email: 'not-in-pool@example.test', status: 'failed', created_at: new Date().toISOString() }));
  child = spawn(process.execPath, ['src/console-server.mjs', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, NODE_ENV: 'test', ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: output, SUB2API_MONITOR_ENABLED: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => logs += c); child.stderr.on('data', c => logs += c);
  let bootstrap;
  for (let i = 0; i < 150; i++) { try { bootstrap = await (await fetch(base + '/api/bootstrap')).json(); break; } catch { await new Promise(r => setTimeout(r, 80)); } }
  assert(bootstrap, logs); assert.equal(bootstrap.features.sub2apiAccountConcurrency, true);
  headers = { 'x-console-token': bootstrap.token, 'content-type': 'application/json' };
  await post('/api/sub2api/settings', { config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: 'fixture-key' } });
  let status = (await refresh()).accounts[rows[0].name]; assert.equal(status.concurrency, 3);
  let jobs = await get('/api/jobs'); const job = jobs.jobs.find(j => j.email === rows[0].name); assert(job);
  assert.equal(job.sub2apiConcurrency, 3); assert.equal(jobs.selection.find(j => j.id === job.id).sub2apiConcurrency, 3);
  const route = `/api/sub2api/accounts/${job.id}/concurrency`;
  assert.equal((await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"concurrency":2}' })).status, 403);
  for (const concurrency of [null, '', true, false, -1, 1.5, 10001, 'not-a-number', [], {}]) await post(route, { concurrency }, 400);
  await post(`/api/sub2api/accounts/${noPoolId}/concurrency`, { concurrency: 7 }, 409);
  await post('/api/sub2api/accounts/22222222-2222-4222-8222-222222222222/concurrency', { concurrency: 7 }, 404);
  const result = await post(route, { concurrency: 0 }); assert.equal(result.updated, 2); assert.equal(result.status.concurrency, 0);
  assert.deepEqual(rows.map(r => r.concurrency), [0, 0]); assert(writes.every(([, b]) => Object.keys(b).join() === 'concurrency'));
  rows.forEach(r => r.concurrency = 8); status = (await refresh()).accounts[rows[0].name]; assert.equal(status.concurrency, 8, 'remote-to-helper sync');
  assert.equal((await get('/api/jobs')).jobs.find(j => j.id === job.id).sub2apiConcurrency, 8);
  rows[1].concurrency = 9; assert.equal((await refresh()).accounts[rows[0].name].concurrency, null, 'mixed duplicate values are not misrepresented');
  failId = 2; await post(route, { concurrency: 12 }, 502); assert.equal((await refresh()).accounts[rows[0].name].concurrency, null);
  failId = null; await post(route, { concurrency: 12 }); assert.deepEqual(rows.map(r => r.concurrency), [12, 12]);
  await post(`/api/jobs/${job.id}/model-fingerprint`, { enabled: true }, 409);
  await post('/api/model-fingerprint/settings', { settings: { enabledPlanTypes: ['free'], matchedConcurrency: { enabled: false, value: 10 } } });
  await post(`/api/jobs/${job.id}/model-fingerprint`, { enabled: true });
  assert.equal((await get('/api/jobs')).jobs.find(j => j.id === job.id).modelFingerprint.enabled, true);
  await post('/api/task-settings', { modelFingerprint: { intervalMinutes: 30 } });
  const settings = (await get('/api/model-fingerprint/settings')).settings; assert.deepEqual(settings.enabledPlanTypes, ['free']); assert.deepEqual(settings.matchedConcurrency, { enabled: false, value: 10 });
  console.log('PASS: authenticated concurrency API, strict validation, zero, duplicate-row updates, two-way polling/selection, partial failures/retry, PlanType enable gate and settings round-trip');
} finally {
  if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  pool.closeAllConnections(); await new Promise(resolve => pool.close(resolve)); await fs.rm(output, { recursive: true, force: true });
}
