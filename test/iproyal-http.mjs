import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createConsoleApp } from '../src/console-app.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iproyal-http-'));
const node = { id: 17, name: 'original', host: '203.0.113.17', port: 8080, protocol: 'http', status: 'active', created_at: new Date().toISOString() };
const writes = [];
const boundAccount = { id: 1, platform: 'openai', type: 'oauth', status: 'active', proxy_id: 17, credentials: { email: 'existing@example.test' } };
const remote = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://fixture');
  let data = {};
  if (pathname.endsWith('/proxies/17')) {
    if (req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body);
      writes.push(patch);
      Object.assign(node, patch);
    }
    data = node;
  } else if (pathname.endsWith('/proxies')) data = { items: [node], total: 1 };
  else if (pathname.endsWith('/proxies/all')) data = [node];
  else if (pathname.endsWith('/accounts')) data = { items: [boundAccount], total: 1, pages: 1 };
  else if (pathname.endsWith('/groups/all')) data = [];
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data }));
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
let balance = 0;
const source = async () => ({
  identity: 'fixture', inventory: async () => [node.host, '203.0.113.18', '203.0.113.19'].map(ip => ({ ip, order: '8123' })),
  bandwidth: async () => ({ gb_limit: 100, gb_used: 100 - balance, gb_balance: balance }),
  orderCost: async () => ({ amountUsd: 9, quantity: 3, days: 30, usdPerIp: 3 }),
});
await fs.mkdir(path.join(root, 'web', 'dist'), { recursive: true });
await fs.writeFile(path.join(root, 'web', 'dist', 'index.html'), '<title>fixture</title>');
const app = createConsoleApp({ production: true, port: 0, webRoot: path.join(root, 'web'), outputRoot: root, iproyalSource: source });
try {
  const { urls: [base] } = await app.start();
  const { token } = await fetch(base + '/api/bootstrap').then(r => r.json());
  const api = async (route, method = 'GET', body) => {
    const res = await fetch(base + route, { method, headers: { 'x-console-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert(res.ok, `${method} ${route} ${res.status}`);
    return res.json();
  };
  const route = '/api/iproyal/patrol';
  const policy = '/api/sub2api/proxies/17/allocation';
  const listing = () => api('/api/sub2api/options', 'POST', { includeInactiveProxies: true });
  const settled = async () => { for (let i = 0; i < 200 && (await api(route)).running; i++) await new Promise(r => setTimeout(r, 10)); };
  assert.equal((await fetch(base + route)).status, 403);
  assert.equal((await api(route)).enabled, false);
  assert.deepEqual(await api('/api/iproyal/test-connection', 'POST'), { ipCount: 3, orderCount: 1, bandwidthChecked: true });
  assert.equal(writes.length, 0);
  await api('/api/sub2api/settings', 'POST', { config: { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: 'fixture' } });
  await api(route, 'PUT', { enabled: true });
  await settled();
  assert.deepEqual(writes, [{ name: '8123-1' }]);
  assert.equal((await listing()).proxies[0].iproyal.gb_balance, 0);
  assert.equal((await listing()).proxies[0].name, '8123-1');
  assert.equal((await listing()).proxies[0].availableForBinding, true);
  await api(policy, 'PUT', { allocationPaused: true, ipCostCny: 1 });
  await api(route, 'PUT', { intervalMinutes: 13, autoPause: true, thresholdGbPerIp: 10, syncCost: true, usdToCny: 7 });
  await settled();
  let record = (await listing()).proxies[0];
  assert.equal(record.iproyal.thresholdGb, 30);
  assert.equal(record.iproyal.autoAllocationPaused, true);
  assert.equal(record.ipCostCny, 21);
  assert.equal(record.allocationPaused, true, 'cost synchronization must preserve manual pause');
  assert.equal(record.availableForBinding, false);
  await api(policy, 'PUT', { allocationPaused: false });
  assert.equal((await api(policy)).ipCostCny, 21);
  assert.equal((await listing()).proxies[0].availableForBinding, false, 'manual unpause must respect automatic gate');
  await api('/api/task-settings', 'POST', { accountProxyMode: 'sub2api' });
  const blocked = await fetch(base + '/api/jobs/batch', { method: 'POST',
    headers: { 'x-console-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'new@example.test' }) });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /没有允许新分配的代理/);
  assert.equal(boundAccount.proxy_id, 17, 'automatic gate must preserve existing remote bindings');
  assert(writes.every(patch => Object.keys(patch).join() === 'name'), 'inspection must not disable nodes');
  balance = 31; await api(route, 'POST'); await settled();
  assert.equal((await listing()).proxies[0].availableForBinding, true);
  await api(policy, 'PUT', { allocationPaused: true });
  await api(route, 'PUT', { autoPause: false }); await settled();
  assert.equal((await listing()).proxies[0].availableForBinding, false, 'disabling auto pause preserves manual choice');
  assert.equal((await api(route)).intervalMinutes, 13);
  assert.equal((await api(route, 'PUT', { enabled: false })).enabled, false);
  console.log('IPROYAL_HTTP_PASS');
} finally {
  await app.stop();
  await new Promise(resolve => remote.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
