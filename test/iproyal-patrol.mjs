import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIproyalPatrol, dashboardSource, indexInventory } from '../src/iproyal-patrol.mjs';
import { createProxyEditor } from '../src/sub2api-proxy-edit.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iproyal-patrol-'));
try {
  const cred = path.join(root, 'connection.json');
  await fs.writeFile(cred, JSON.stringify({ bearer: 'fixture-only', cookie: 'fixture=x' }));
  const rows = ['192.0.2.21', '192.0.2.2', '192.0.2.9'].map((ip, i) => ({
    id: i + 1, ip, order_id: i < 2 ? 901 : 902, password: 'never-cache-this',
  }));
  const calls = [];
  let broken = false;
  let inventoryFails = false;
  const source = () => dashboardSource(cred, async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://apid.iproyal.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-only');
    assert.equal(init.headers.Cookie, 'fixture=x');
    if (u.pathname.endsWith('/proxies')) {
      const page = Number(u.searchParams.get('page'));
      calls.push('page' + page);
      return Response.json({ data: page === 1 ? rows.slice(0, 2) : rows.slice(2),
        meta: { total: inventoryFails ? 8 : 3, current_page: page, last_page: 2 } });
    }
    if (!u.pathname.endsWith('/bandwidth')) {
      const order = Number(u.pathname.split('/').at(-1));
      return Response.json({ id: order, amount: 10, amount_with_vat: 12.15,
        order_product: { quantity: order === 901 ? 2 : 1, expire_date: order === 901 ? '2026-12-22T08:27:22.000000Z' : null,
          product_plan: { duration: 30, price: 1.8 } } });
    }
    const order = u.pathname.split('/').at(-2);
    calls.push(order);
    if (broken && order === '902') return new Response('', { status: 401 });
    return Response.json({ gb_limit: 100, gb_used: order === '901' ? 10 : 105, gb_balance: order === '901' ? 90 : 0 });
  });
  const nodes = rows.map(({ ip, id }) => ({ id, host: ip, name: 'old', password: 'secret', status: 'active' }));
  nodes.push({ id: 4, host: '198.51.100.4', name: 'keep' });
  const writes = [];
  const editor = createProxyEditor({ request: async (_c, p, opts) => {
    const node = nodes.find(n => n.id === Number(p.split('/').at(-1)));
    if (opts?.method === 'PUT') {
      const fields = JSON.parse(opts.body);
      assert.deepEqual(Object.keys(fields), ['name']);
      Object.assign(node, fields);
      writes.push(node.id);
    }
    return { data: { ...node } };
  } });
  const config = { baseUrl: 'http://fixture', adminApiKey: 'test' };
  const options = { root, source, target: () => ({ key: 'pool' }), canRun: () => true,
    list: async () => nodes.map(n => ({ ...n })),
    rename: (_ctx, n, name) => editor.renameForInventory(config, n, name, n => n.host) };
  let patrol = createIproyalPatrol(options);
  await patrol.load();
  await patrol.run();
  assert.deepEqual(calls, []);
  await patrol.configure(true);
  await Promise.all([patrol.run(), patrol.run()]);
  assert.deepEqual(calls, ['page1', 'page2', '901', '902']);
  assert.deepEqual(nodes.map(n => n.name), ['901-2', '901-1', '902', 'keep']);
  assert.equal(patrol.lookup('pool', rows[2].ip).gb_balance, 0);
  assert.equal(patrol.lookup('pool', rows[0].ip).cost.usdPerIp, 6.075);
  assert.equal(patrol.lookup('pool', rows[0].ip).expiresAt, '2026-12-22T08:27:22.000Z');
  assert.equal(patrol.lookup('pool', rows[1].ip).expiresAt, '2026-12-22T08:27:22.000Z');
  assert.equal(patrol.lookup('pool', rows[2].ip).expiresAt, undefined);
  assert.equal(patrol.lookup('other', rows[2].ip), null);
  assert.equal(patrol.lookup('pool', nodes[3].host).status, 'unmatched');
  assert(!/never-cache-this|fixture-only|fixture=x/.test(await fs.readFile(path.join(root, 'iproyal-cache.json'), 'utf8')));
  await patrol.stop();
  patrol = createIproyalPatrol(options);
  await patrol.load();
  calls.length = 0;
  broken = true;
  await patrol.run();
  assert.deepEqual(calls, ['901', '902']);
  assert.equal(patrol.lookup('pool', rows[2].ip).gb_balance, 0);
  assert.equal(patrol.lookup('pool', rows[2].ip).stale, true);
  assert.match(patrol.status().message, /401/);
  assert.equal(writes.length, 3);
  nodes.push({ id: 5, host: '198.51.100.5', name: 'new' });
  inventoryFails = true;
  await patrol.run();
  assert.equal(patrol.lookup('pool', nodes[4].host), null);
  assert.equal(patrol.lookup('pool', rows[0].ip).gb_balance, 90);
  const slots = {};
  const pair = rows.slice(0, 2).map(r => ({ ip: r.ip, order: '901' }));
  const original = indexInventory(pair, slots);
  const added = indexInventory([{ ip: '192.0.2.1', order: '901' }, ...pair.reverse()], slots);
  assert.equal(added['192.0.2.2'].name, original['192.0.2.2'].name);
  assert.equal(added['192.0.2.2'].ipCount, 3);
  assert.equal(added['192.0.2.1'].name, '901-3');
  assert(indexInventory([...pair, { ip: rows[0].ip, order: '999' }], slots)[rows[0].ip].ambiguous);
  await patrol.configure(false);
  calls.length = 0;
  await patrol.run();
  assert.deepEqual(calls, []);
  await patrol.stop();
  console.log('IPROYAL_PATROL_PASS');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
