import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..'), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-deleted-groups-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, output = '', headers, nextId = 100, hideRace = false;
const rows = [], posts = [], puts = [], groups = new Set([1, 77, 99]);
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
const pool = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture'), chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  if (req.method === 'GET' && url.pathname === '/api/v1/admin/groups/all') return json(res, { data: [...groups].map(id => ({ id, platform: id === 77 ? 'composite' : 'openai', name: `Group ${id}` })) });
  if (req.method === 'GET' && url.pathname === '/api/v1/admin/accounts') return json(res, { data: { items: rows.filter(row => !hideRace || row.credentials.email !== 'hidden@example.test'), pages: 1, total: rows.length - (hideRace ? 1 : 0) } });
  if (req.method === 'GET' && url.pathname === '/api/v1/admin/proxies/all') return json(res, []);
  const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (match) {
    const row = rows.find(row => row.id === Number(match[1]));
    if (!row) return json(res, { message: 'not found' }, 404);
    if (req.method === 'PUT') {
      puts.push(structuredClone(body));
      if (body.group_ids?.some(id => !groups.has(Number(id)))) return json(res, { code: 'GROUP_NOT_FOUND', message: 'group not found' }, 404);
      Object.assign(row, body);
    }
    return json(res, { data: row });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/admin/accounts/batch') {
    const account = structuredClone(body.accounts[0]);
    posts.push({ account, key: req.headers['idempotency-key'] });
    const row = { ...account, id: nextId++, created_at: new Date().toISOString(), status: 'active', schedulable: true };
    rows.push(row);
    if (['race@example.test', 'hidden@example.test', 'race-http@example.test'].includes(account.credentials.email)) {
      groups.delete(77);
      hideRace = account.credentials.email === 'hidden@example.test';
      if (account.credentials.email === 'race-http@example.test') return json(res, { code: 'GROUP_NOT_FOUND', message: 'group not found after Create' }, 404);
      return json(res, { data: { success: 0, failed: 1, results: [{ name: account.name, success: false, error: 'GROUP_NOT_FOUND: group deleted after account Create' }] } });
    }
    if (account.group_ids?.some(id => !groups.has(Number(id)))) return json(res, { code: 'GROUP_NOT_FOUND', message: 'group not found' }, 404);
    return json(res, { data: { created: 1, accounts: [row] } });
  }
  return json(res, { message: 'unexpected fixture request' }, 404);
});
async function listen(server) {
  for (;;) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; if (port > 10080) return port; await new Promise(resolve => server.close(resolve)); }
}
const poolUrl = `http://127.0.0.1:${await listen(pool)}`, listener = http.createServer(), port = await listen(listener);
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`, ids = [];
for (const [index, email] of ['existing@example.test', 'fresh@example.test', 'race@example.test', 'hidden@example.test', 'race-http@example.test'].entries()) {
  const id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, dir = path.join(temp, id); ids.push(id);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'job-meta.json'), JSON.stringify({ email, status: 'completed', plan_type: 'free', result_saved: true, created_at: '2026-11-15T00:00:00Z' }));
  const account = { name: email, platform: 'openai', type: 'oauth', credentials: { email, access_token: 'new-token', refresh_token: 'new-refresh', plan_type: 'free' }, extra: { email, plan_type: 'free' } };
  await fs.writeFile(path.join(dir, 'sub2api-import-oauth.json'), JSON.stringify({ type: 'sub2api-data', accounts: [account] }));
  if (!index) rows.push({ ...account, id: nextId++, group_ids: [1, 99], proxy_id: 4, credentials: { ...account.credentials, access_token: 'old-token' }, extra: { ...account.extra, preserved: true }, status: 'active', schedulable: true });
}
await fs.writeFile(path.join(temp, 'sub2api-settings.json'), JSON.stringify({ version: 2, config: { baseUrl: poolUrl, adminApiKey: 'fixture-key', groupIds: [1, 35] },
  profiles: [{ id: 'default', groupIds: [1, 35] }, { id: 'secondary', groupIds: [35, 77] }, { id: 'all-deleted', groupIds: [35] }], activeProfileId: 'default' }));
const wait = async fn => { for (const deadline = Date.now() + 20000; Date.now() < deadline;) { const value = await fn().catch(() => null); if (value) return value; if (child?.exitCode != null) throw Error(output); await pause(40); } throw Error('fixture timeout\n' + output); };
async function api(route, body) {
  const response = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const upload = (index, groupIds) => api('/api/sub2api/upload', { ids: [ids[index]], config: { baseUrl: poolUrl, adminApiKey: 'fixture-key', groupIds } });
try {
  child = spawn(process.execPath, [process.env.GROUP_REFERENCE_TEST_SERVER || 'src/console-server.mjs', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', ONBOARDING_OUTPUT_ROOT: temp, LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, 'credentials'), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, 'credentials'), TOSUB2_CREDENTIAL_KEY: 'ab'.repeat(32), SUB2API_MONITOR_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const bootstrap = await wait(async () => { const response = await fetch(base + '/api/bootstrap'); return response.ok ? response.json() : null; });
  headers = { 'x-console-token': bootstrap.token, 'content-type': 'application/json' };
  const existing = await upload(0, [1, 35]);
  if (process.argv.includes('--baseline')) {
    assert.equal(existing.status, 502); assert.match(existing.data.error, /group not found|GROUP_NOT_FOUND/);
    assert.equal(rows[0].credentials.access_token, 'old-token');
    console.log('DELETED_GROUP_BASELINE_REPRODUCED group=35 credentials_update=blocked remote_code=GROUP_NOT_FOUND');
    process.exitCode = 1;
  } else {
    assert.equal(existing.status, 200, JSON.stringify(existing.data));
    assert.equal(rows[0].credentials.access_token, 'new-token'); assert.equal(rows[0].proxy_id, 4); assert.equal(rows[0].extra.preserved, true);
    const saved = JSON.parse(await fs.readFile(path.join(temp, 'sub2api-settings.json'), 'utf8'));
    assert.deepEqual(saved.config.groupIds, [1]); assert.deepEqual(saved.profiles.find(p => p.id === 'secondary').groupIds, [77]);
    assert.deepEqual(saved.profiles.find(p => p.id === 'all-deleted').groupIds, [35], 'cleanup must not turn a scoped monitor into an all-groups monitor');
    assert.equal((await upload(1, [1, 35])).status, 200);
    assert.deepEqual(posts.at(-1).account.group_ids, [1], 'new create still references deleted group');
    assert.equal((await upload(2, [1, 77])).status, 200, 'partially committed create was not recovered');
    assert.equal(posts.filter(p => p.account.credentials.email === 'race@example.test').length, 1);
    assert.deepEqual(rows.find(r => r.credentials.email === 'race@example.test').group_ids, [1]);
    groups.add(77);
    const hidden = await upload(3, [1, 77]);
    assert.equal(hidden.status, 502); assert.match(hidden.data.error, /POOL_UPLOAD_GROUPS_PENDING/);
    assert.equal(posts.filter(p => p.account.credentials.email === 'hidden@example.test').length, 1);
    hideRace = false;
    assert.equal((await upload(3, [1])).status, 200);
    assert.equal(posts.filter(p => p.account.credentials.email === 'hidden@example.test').length, 1, 'retry created a duplicate account');
    groups.add(77);
    assert.equal((await upload(4, [1, 77])).status, 200, 'HTTP GROUP_NOT_FOUND after partial create was not recovered');
    assert.equal(posts.filter(p => p.account.credentials.email === 'race-http@example.test').length, 1);
    assert.deepEqual(rows.find(r => r.credentials.email === 'race-http@example.test').group_ids, [1]);
    assert(puts.some(body => body.group_ids?.includes(35)), 'fixture did not exercise reactive PUT retry');
    console.log('DELETED_GROUP_HTTP_PASS existing_credentials=true new_create_preflight=true partial_create_recovered=true duplicate_creates=0 hidden_create_preserved=true proxy_unchanged=true config_persisted=true monitor_scope_preserved=true');
  }
} finally {
  if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; }
  pool.closeAllConnections?.(); await new Promise(resolve => pool.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
