import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-proxy-edit-'));
const proxies = [{ id: 7, name: 'Original', protocol: 'socks5h', host: 'proxy.test', port: 1080,
  username: 'original-user', password: 'private-original', status: 'active', expires_at: '2020-01-01T00:00:00Z',
  fallback_mode: 'proxy', backup_proxy_id: 8, ip_address: '203.0.113.7' }];
const writes = [];
const deletes = [];
const locallyBoundProxy = { id: 12, name: 'Local fixture', protocol: 'http', host: 'local.test', port: 8080 };
let deleteMode = '', backupUsesNode = false, failPagedList = false;
let rejectWrite = false, uncertainWrite = false, failList = false, child, logs = '';
const remote = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  assert.equal(req.headers['x-api-key'], 'fixture-key');
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/api/v1/admin/proxies/7') {
    if (!proxies.length) { res.writeHead(404); return res.end('{}'); }
    if (req.method === 'DELETE') {
      deletes.push(7);
      if (deleteMode === 'in-use') {
        res.writeHead(409); return res.end(JSON.stringify({ code: 'PROXY_IN_USE', message: 'private-original' }));
      }
      if (deleteMode === 'refused') return res.end(JSON.stringify({ code: 'FIXTURE_REJECTED', message: 'private-original' }));
      proxies.pop();
      if (deleteMode === 'uncertain') { res.writeHead(503); return res.end('{}'); }
      return res.end(JSON.stringify({ code: 0, data: { message: 'Proxy deleted successfully' } }));
    }
    if (req.method === 'PUT') {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); writes.push(body);
      if (rejectWrite) { res.writeHead(400); return res.end(JSON.stringify({ message: 'private-original private-new upstream echo' })); }
      Object.assign(proxies[0], body);
      if (uncertainWrite) { res.writeHead(500); return res.end('{}'); }
    }
    return res.end(JSON.stringify({ data: proxies[0] }));
  }
  if (url.pathname === '/api/v1/admin/proxies/12') {
    if (req.method === 'DELETE') deletes.push(12);
    return res.end(JSON.stringify({ data: locallyBoundProxy }));
  }
  if (/\/proxies\/\d+$/.test(url.pathname)) { res.writeHead(404); return res.end('{}'); }
  if (url.pathname.endsWith('/admin/proxies') && req.method === 'GET') {
    const items = backupUsesNode ? [...proxies, { id: 8, status: 'inactive', backup_proxy_id: 7 }] : proxies;
    return res.end(JSON.stringify({ data: { items, total: failPagedList ? items.length + 1 : items.length } }));
  }
  if (url.pathname.endsWith('/proxies/all') && failList) { res.writeHead(503); return res.end('{}'); }
  const data = url.pathname.endsWith('/proxies/all') ? proxies : url.pathname.endsWith('/groups/all') ? []
    : url.pathname.endsWith('/accounts') ? { items: [], total: 0, pages: 1 } : {};
  res.end(JSON.stringify({ data }));
});
const freePort = async () => { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
await new Promise(r => remote.listen(0, '127.0.0.1', r));
try {
  const localJob = path.join(temp, '11111111-1111-4111-8111-000000000012');
  await fs.mkdir(localJob);
  await fs.writeFile(path.join(localJob, 'job-meta.json'), JSON.stringify({
    version: 1, email: 'locally-bound@example.test', status: 'completed', assigned_proxy_id: 12,
  }));
  const base = `http://127.0.0.1:${await freePort()}`;
  child = spawn(process.execPath, ['src/console-server.mjs', '--host', '127.0.0.1', '--port', new URL(base).port], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', ONBOARDING_OUTPUT_ROOT: temp,
      LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: temp + '/credentials', TOSUB2_MAC_CREDENTIAL_ROOT: temp + '/credentials',
      TOSUB2_CREDENTIAL_KEY: 'ab'.repeat(32), SUB2API_MONITOR_ENABLED: '0' },
  });
  child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  let token;
  for (const end = Date.now() + 20000; Date.now() < end;) {
    try { token = (await (await fetch(base + '/api/bootstrap')).json()).token; if (token) break; } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await new Promise(r => setTimeout(r, 50));
  }
  assert(token, logs);
  const api = async (route, method = 'GET', body, authenticated = true) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-console-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: 'fixture-key' };
  await api('/api/sub2api/settings', 'POST', { config });
  const first = await api('/api/sub2api/proxies/7');
  assert.equal(first.status, 200, `PROXY_EDIT_ENDPOINT_MISSING actual=${first.status}`);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.data.proxy.username, 'original-user'); assert.equal(first.data.proxy.hasPassword, true);
  assert(!JSON.stringify(first.data).includes('private-original'));
  assert.equal((await api('/api/sub2api/proxies/7', 'GET', undefined, false)).status, 403);
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', {}, false)).status, 403);
  assert.equal((await api('/api/sub2api/proxies/999')).status, 404);
  assert.equal((await api('/api/sub2api/proxies/0')).status, 400);
  let current = first.data;
  const draft = () => ({ name: current.proxy.name, protocol: current.proxy.protocol, host: current.proxy.host,
    port: current.proxy.port, username: current.proxy.username, revision: current.revision });
  const before = writes.length;
  for (const change of [{ port: 0 }, { protocol: 'ftp' }, { host: 'invalid/path' }, { name: '' }, { username: '', password: 'private-new' }, { revision: '' }]) {
    assert.equal((await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), ...change })).status, 400);
  }
  assert.equal(writes.length, before, 'invalid editor input reached the pool');
  const updated = await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), name: 'Renamed', protocol: 'https', host: 'new.test', port: 8443 });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.equal(proxies[0].name, 'Renamed'); assert.equal(proxies[0].password, 'private-original');
  assert.equal(proxies[0].expires_at, '2020-01-01T00:00:00Z'); assert.equal(proxies[0].status, 'active');
  assert.equal(proxies[0].fallback_mode, 'proxy'); assert.equal(proxies[0].backup_proxy_id, 8);
  assert(!Object.hasOwn(writes.at(-1), 'expires_at')); assert(!Object.hasOwn(writes.at(-1), 'status'));
  assert(!JSON.stringify(updated.data).includes('private-original'));
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), name: 'Stale' })).status, 409);
  current = (await api('/api/sub2api/proxies/7')).data;
  const concurrent = await Promise.all(['One', 'Two'].map(name => api('/api/sub2api/proxies/7', 'PUT', { ...draft(), name })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  current = (await api('/api/sub2api/proxies/7')).data;
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), password: 'private-new' })).status, 200);
  assert.equal(proxies[0].password, 'private-new');
  current = (await api('/api/sub2api/proxies/7')).data;
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), username: '', password: '' })).status, 200);
  assert.equal(proxies[0].username, ''); assert.equal(proxies[0].password, '');
  current = (await api('/api/sub2api/proxies/7')).data;
  rejectWrite = true;
  const rejected = await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), name: 'Rejected' });
  assert.equal(rejected.status, 502); assert(!JSON.stringify(rejected.data).includes('private-')); rejectWrite = false;
  uncertainWrite = true;
  const oldDraft = { ...draft(), name: 'Committed but timeout' };
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', oldDraft)).status, 502); uncertainWrite = false;
  const count = writes.length;
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', oldDraft)).status, 409);
  assert.equal(writes.length, count, 'uncertain write was blindly replayed');
  current = (await api('/api/sub2api/proxies/7')).data; failList = true;
  assert.equal((await api('/api/sub2api/proxies/7', 'PUT', { ...draft(), name: 'Saved despite refresh failure' })).status, 200);
  failList = false;
  const list = await api('/api/sub2api/options', 'POST', {});
  assert.equal(list.data.proxies[0].name, 'Saved despite refresh failure');
  assert(!JSON.stringify(list.data).includes('private-')); assert.equal(proxies.length, 1);
  console.log('PROXY_EDIT_API_PASS auth=true validation=true name_and_connection=true preserve_password=true explicit_clear=true metadata_unchanged=true stale_conflict=true concurrent_conflict=true no_blind_retry=true cache_refreshed=true');

  assert.equal((await api('/api/sub2api/proxies/7', 'DELETE', {}, false)).status, 403);
  const remove = (revision = current.revision) => api('/api/sub2api/proxies/7', 'DELETE', { revision });
  const missingRevision = await remove('');
  assert.equal(missingRevision.status, 400, `PROXY_DELETE_VALIDATION actual=${missingRevision.status}`);
  assert.equal((await remove()).status, 409, 'stale confirmation did not block delete');
  current = (await api('/api/sub2api/proxies/7')).data;
  await api('/api/sub2api/settings', 'POST', { config: { ...config, proxyId: '7' } });
  const profileBlocked = await remove();
  assert.equal(profileBlocked.status, 409); assert.match(profileBlocked.data.error, /配置方案/);
  await api('/api/sub2api/settings', 'POST', { config: { ...config, proxyId: '' } });
  const local = await api('/api/sub2api/proxies/12');
  const localBlocked = await api('/api/sub2api/proxies/12', 'DELETE', { revision: local.data.revision });
  assert.equal(localBlocked.status, 409); assert.match(localBlocked.data.error, /本地账号已绑定/);
  backupUsesNode = true;
  const backupBlocked = await remove();
  assert.equal(backupBlocked.status, 409); assert.match(backupBlocked.data.error, /备用代理/);
  backupUsesNode = false;
  failPagedList = true;
  assert.equal((await remove()).status, 502);
  failPagedList = false;
  assert.equal(deletes.length, 0, 'local rejection sent a remote DELETE');
  deleteMode = 'in-use';
  const bound = await remove();
  assert.equal(bound.status, 409); assert.match(bound.data.error, /号池仍有账号/);
  deleteMode = 'refused';
  assert.equal((await remove()).status, 502);
  assert.equal(proxies.length, 1);
  deleteMode = 'uncertain';
  assert.equal((await remove()).status, 502);
  assert.equal((await remove()).status, 404);
  assert.equal(deletes.length, 3, 'uncertain deletion was sent again for a missing node');
  deleteMode = '';
  proxies.push({ id: 7, name: 'Replacement node', protocol: 'https', host: 'replacement.test', port: 8443, status: 'active' });
  assert.equal((await remove()).status, 409, 'stale confirmation deleted a replacement');
  current = (await api('/api/sub2api/proxies/7')).data;
  const [firstDelete, duplicateDelete] = await Promise.all([remove(), remove()]);
  assert.deepEqual([firstDelete.status, duplicateDelete.status].sort(), [200, 404]);
  assert.deepEqual((firstDelete.status === 200 ? firstDelete : duplicateDelete).data, { deleted: true, id: 7 });
  assert.equal(deletes.length, 4);
  assert.deepEqual((await api('/api/sub2api/options', 'POST', {})).data.proxies, []);
  console.log('PROXY_DELETE_API_PASS auth revision references remote-conflict uncertain-result duplicate-delete list-refresh');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  if (child?.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; }
  await new Promise(r => remote.close(r)); await fs.rm(temp, { recursive: true, force: true });
}
