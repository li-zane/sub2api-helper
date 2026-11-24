import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createConsoleApp } from '../src/console-app.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iproyal-http-'));
const node = { id: 17, name: 'original', host: '203.0.113.17', port: 8080, protocol: 'http', status: 'active' };
const writes = [];
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
  else if (pathname.endsWith('/accounts')) data = { items: [], total: 0, pages: 1 };
  else if (pathname.endsWith('/groups/all')) data = [];
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data }));
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const source = async () => ({
  identity: 'fixture', inventory: async () => [{ ip: node.host, order: '8123' }],
  bandwidth: async () => ({ gb_limit: 100, gb_used: 101, gb_balance: 0 }),
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
  assert.equal((await fetch(base + route)).status, 403);
  assert.equal((await api(route)).enabled, false);
  assert.deepEqual(await api('/api/iproyal/test-connection', 'POST'), { ipCount: 1, orderCount: 1, bandwidthChecked: true });
  assert.equal(writes.length, 0);
  await api('/api/sub2api/settings', 'POST', { config: { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: 'fixture' } });
  await api(route, 'PUT', { enabled: true });
  for (let i = 0; i < 200 && (await api(route)).running; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(writes, [{ name: '8123' }]);
  const listing = await api('/api/sub2api/options', 'POST', { includeInactiveProxies: true });
  assert.equal(listing.proxies[0].iproyal.gb_balance, 0);
  assert.equal(listing.proxies[0].name, '8123');
  assert.equal((await api(route, 'PUT', { enabled: false })).enabled, false);
  console.log('IPROYAL_HTTP_PASS');
} finally {
  await app.stop();
  await new Promise(resolve => remote.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
