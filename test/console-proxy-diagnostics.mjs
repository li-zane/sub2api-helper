import './legacy-import-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createConsoleApp } from '../src/console-app.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-diagnostics-http-'));
const id = '11111111-1111-4111-8111-000000000001', email = 'diagnostic@example.test';
const nodes = [{ id: 1, name: 'Seattle', protocol: 'http', host: 'fixture.test', port: 8080, status: 'active', ip_address: '198.51.100.1' }];
const account = { id: 1, platform: 'openai', type: 'oauth', status: 'active', proxy_id: 1, credentials: { email }, extra: { email } };
const calls = [], writes = [];
let app, base, headers;
const pool = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://fixture'); let data;
  if (url.pathname === '/api/v1/admin/proxies' && req.method === 'POST') {
    const node = { ...JSON.parse(raw), id: nodes.length + 1, status: 'active' }; nodes.push(node); data = node;
  } else if (url.pathname === '/api/v1/admin/proxies') data = { items: nodes, total: nodes.length };
  else if (url.pathname === '/api/v1/admin/proxies/all') data = nodes;
  else if (url.pathname === '/api/v1/admin/accounts') data = { items: [account], total: 1, pages: 1 };
  else if (url.pathname === '/api/v1/admin/accounts/1') { data = account; if (req.method !== 'GET') writes.push(raw); }
  else if (url.pathname.startsWith('/api/v1/admin/groups/all')) data = [];
  else if (url.pathname.startsWith('/api/v1/admin/proxies/')) data = nodes.find(node => node.id === Number(url.pathname.split('/').at(-1)));
  else data = {};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data }));
});
const wait = async fn => { for (let end = Date.now() + 10000; Date.now() < end;) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('fixture timed out'); };
const request = async (route, body) => {
  const res = await fetch(base + route, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data;
};
const start = async () => {
  app = createConsoleApp({ production: true, port: 0, outputRoot: root, webRoot: path.join(root, 'web'),
    proxyQualityService: { async check(url) {
      calls.push(url);
      await new Promise(r => setTimeout(r, 30));
      return { checkedAt: new Date().toISOString(), status: 'ok', stable: true, successCount: 2, sampleCount: 2,
        latencyMs: 21, chatgpt: { status: 'ok', httpStatus: 200, latencyMs: 40 },
        exits: [{ ip: new URL(url).hostname === 'fixture.test' ? '198.51.100.1' : '198.51.100.2', countryCode: 'US', country: 'United States', region: 'Washington', city: 'Seattle', riskScore: 3 }] };
    }, async close() {} },
  });
  base = (await app.start()).urls[0];
  headers = { 'content-type': 'application/json', 'x-console-token': (await (await fetch(base + '/api/bootstrap')).json()).token };
};
try {
  await new Promise(r => pool.listen(0, '127.0.0.1', r));
  await fs.mkdir(path.join(root, 'web/dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'web/dist/index.html'), '<title>Diagnostics test</title>');
  await fs.mkdir(path.join(root, id));
  await fs.writeFile(path.join(root, id, 'job-meta.json'), JSON.stringify({ version: 1, email, status: 'failed', assigned_proxy_id: 1,
    proxy_url: 'http://fixture.test:8080/', bound_ip: '198.51.100.1', created_at: new Date().toISOString() }));
  await start();
  const config = { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: 'fixture-key' };
  await request('/api/sub2api/settings', { config });
  await request('/api/sub2api/options', {});
  await wait(async () => (await request('/api/sub2api/options', {})).proxies[0].city === 'Seattle');
  assert.equal(calls.length, 1, 'missing bound-account report is automatically tested once');
  const history = (await request(`/api/jobs/${id}/proxy-history`)).history;
  assert.equal(history[0].quality.exits[0].city, 'Seattle');
  assert.equal(history[0].nodes[0].name, 'Seattle');
  const created = await request('/api/sub2api/proxies', { requestId: 'diagnostic-import-0001', proxies: [{ name: 'Imported', protocol: 'http', host: 'imported.test', port: 8080 }] });
  assert.equal(created.created, 1);
  await wait(async () => (await request('/api/sub2api/options', {})).proxies[1]?.quality?.status === 'ok');
  assert.equal(calls.length, 2, 'newly imported unbound node is automatically checked');
  await app.stop(); await start();
  const restored = await request('/api/sub2api/options', {});
  assert.equal(restored.proxies[0].city, 'Seattle'); assert.equal(restored.proxies[1].city, 'Seattle');
  assert.equal(calls.length, 2, 'restart does not repeat existing reports');
  await request('/api/proxy-quality/check', { target: 'sub2api', proxyId: 1 });
  assert.equal(calls.length, 3, 'manual retest refreshes report');
  nodes[0].host = 'changed.test';
  await request('/api/sub2api/options', {});
  await wait(async () => (await request('/api/sub2api/options', {})).proxies[0].detectedIpAddress === '198.51.100.2');
  assert.equal(calls.length, 4, 'connection changes trigger one fresh measurement');
  assert.equal(account.proxy_id, 1); assert.equal(writes.length, 0, 'diagnostics never change account route');
  assert.equal((await fetch(base + `/api/jobs/${id}/proxy-history`)).status, 403);
  console.log('PROXY_DIAGNOSTICS_HTTP_PASS initial account backfill; import detection; results/city/history persisted; restart; manual retest; connection edit; no binding mutation; auth');
} finally {
  await app?.stop(); await new Promise(r => pool.close(r)); await fs.rm(root, { recursive: true, force: true });
}
