import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observeIpUsage, usageWindow } from '../src/iproyal-ip-usage.mjs';
import { createIproyalPatrol, dashboardSource } from '../src/iproyal-patrol.mjs';
import { iproyalSettings } from '../shared/iproyal-settings.mjs';
import { rankRotationExits } from '../src/proxy-rotation.mjs';

const config = iproyalSettings({ enabled: true, usageCooldownEnabled: true, usageThreshold: 50, usageUnit: 'MB', usageCooldownMinutes: 60 });
for (const patch of [{ usageCooldownEnabled: 1 }, { usageThreshold: 0 }, { usageThreshold: -1 }, { usageUnit: 'TB' },
  { usageCooldownMinutes: 0 }, { usageCooldownMinutes: 1.1 }, { usageCooldownMinutes: 43201 }]) assert.throws(() => iproyalSettings(patch));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iproyal-ip-usage-'));
let patrol;
try {
  let time = Date.parse('2026-11-28T01:00:00Z'), counts = { '192.0.2.1': 5000, '192.0.2.2': 1000 }, broken = false, owner = 'account', pool = 'pool';
  const nodes = [{ id: 1, host: '192.0.2.1', name: 'one' }, { id: 2, host: '192.0.2.1', name: 'alias' }, { id: 3, host: '192.0.2.2', name: 'two' }];
  const sample = (value, window = usageWindow(time)) => {
    const days = {};
    for (let at = Date.parse(window.from); at <= Date.parse(window.to); at += 86400000) days[new Date(at).toISOString().slice(0, 10)] = 0;
    days[window.to] = value;
    return { ...window, days };
  };
  const reads = [], writes = [];
  const options = { root, target: () => ({ key: pool }), canRun: () => true, now: () => time,
    list: async () => nodes, rename: async (_c, node, name) => { writes.push('name'); node.name = name; },
    source: async () => ({ identity: owner, inventory: async () => Object.keys(counts).map(ip => ({ ip, order: '900' })),
      bandwidth: async () => ({ gb_balance: 500, gb_used: 98765, gb_limit: 100000 }),
      ipUsage: async (order, ip, window) => { reads.push(ip); if (broken) throw Error('private detail'); return sample(counts[ip], window); } }),
  };
  patrol = createIproyalPatrol(options); await patrol.load(); await patrol.configure(config); await patrol.run();
  const record = ip => patrol.lookup(pool, ip);
  assert.equal(reads.length, 2, 'one read per IP across protocol aliases');
  assert.equal(record('192.0.2.1').ipUsage.deltaMb, null, 'first read is baseline, not 5000 MB recent traffic');
  time += 300000; counts['192.0.2.1'] += 50; counts['192.0.2.2'] += 3;
  await patrol.run(); assert(!patrol.isBlocked(pool, 1), 'equal threshold does not exceed');
  assert.equal(record('192.0.2.1').ipUsage.deltaMb, 50);
  time += 300000; counts['192.0.2.1'] += 50.01; await patrol.run();
  const until = record('192.0.2.1').ipUsage.cooldownUntil;
  assert(patrol.isBlocked(pool, 1) && patrol.isBlocked(pool, 2));
  assert(!patrol.isBlocked(pool, 3), 'shared order does not pause other IPs');
  const rank = () => rankRotationExits({ proxies: nodes, currentIps: new Set(['other']), currentCities: new Set(['Seattle']),
    occupiedIps: new Set(), activity: new Map(), ipOf: n => n.host, cityOf: () => 'Seattle', available: n => !patrol.isBlocked(pool, n.id) }).map(n => n.id);
  assert.deepEqual(rank(), [3], 'same-city rotation excludes cooled aliases');
  await patrol.stop(); patrol = createIproyalPatrol(options); await patrol.load();
  assert(patrol.isBlocked(pool, 1), 'cooldown survives restart');
  time += 300000; counts['192.0.2.1'] += 100; await patrol.run();
  assert.equal(record('192.0.2.1').ipUsage.cooldownUntil, until, 'active cooldown deadline does not slide');
  broken = true; time += 300000; await patrol.run();
  assert(record('192.0.2.1').ipUsage.stale); assert(patrol.isBlocked(pool, 1));
  assert(!patrol.status().message.includes('private detail'));
  time = until; assert(!patrol.isBlocked(pool, 1), 'expiry works without another upstream fetch');
  assert.deepEqual(rank(), [1, 3]);
  broken = false; await patrol.run(); assert(!patrol.isBlocked(pool, 1), 'identical cumulative usage does not retrigger');
  assert.equal(record('192.0.2.1').ipUsage.deltaMb, 0);
  counts['192.0.2.1'] += 60; time += 300000; await patrol.run(); assert(patrol.isBlocked(pool, 1));
  await patrol.configure({ usageCooldownEnabled: false }); await patrol.run(); assert(!patrol.isBlocked(pool, 1));
  counts['192.0.2.1'] += 1000;
  await patrol.configure({ usageCooldownEnabled: true }); await patrol.run(); assert(!patrol.isBlocked(pool, 1), 'reenable starts a baseline');
  counts['192.0.2.1'] = 1; time += 300000; await patrol.run();
  assert.equal(record('192.0.2.1').ipUsage.baselineReason, 'reset'); assert(!patrol.isBlocked(pool, 1));
  owner = 'different-account'; counts['192.0.2.1'] = 10000; await patrol.run();
  assert.equal(record('192.0.2.1').ipUsage.baselineReason, 'initial'); assert(!patrol.isBlocked(pool, 1));
  pool = 'different-pool'; await patrol.run(); assert.equal(record('192.0.2.1').ipUsage.baselineReason, 'initial');
  assert(!patrol.isBlocked('pool', 1));
  time += 7 * 86400000; await patrol.run(); assert.equal(record('192.0.2.1').ipUsage.baselineReason, 'gap');
  assert(writes.every(v => v === 'name'), 'existing routes and enabled statuses remain unchanged');

  const yesterday = Date.parse('2026-11-28T15:55:00Z'), nextDay = yesterday + 600000;
  const first = observeIpUsage(null, sample(500, usageWindow(yesterday)), config, yesterday);
  const next = sample(12, usageWindow(nextDay)); next.days['2026-11-28'] = 550;
  const midnight = observeIpUsage(first, next, config, nextDay);
  assert.equal(midnight.deltaMb, 62, 'midnight rollover includes delayed previous-day and new-day traffic');
  const gbConfig = { ...config, usageUnit: 'GB' }, gbFirst = observeIpUsage(null, sample(5000), gbConfig, time);
  assert.equal(observeIpUsage(gbFirst, sample(55000), gbConfig, time + 1).cooldownUntil, 0);
  assert(observeIpUsage(gbFirst, sample(55000.01), gbConfig, time + 1).cooldownUntil > time);

  const credential = path.join(root, 'fixture.json'); await fs.writeFile(credential, JSON.stringify({ bearer: 'fixture-only' }));
  let invalid = false;
  const api = await dashboardSource(credential, async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://apid.iproyal.com'); assert.equal(parsed.pathname, '/v1/orders/900/data-usage');
    assert.equal(parsed.searchParams.get('ip_addresses[]'), '192.0.2.1');
    assert.equal(parsed.searchParams.get('measurement_unit'), 'MB'); assert.equal(parsed.searchParams.get('time_zone'), 'Asia/Shanghai');
    assert.equal(init.redirect, 'error');
    const days = sample(12).days; if (invalid) delete days[usageWindow(time).from];
    return Response.json({ data: days, remaining: { gb_used: 999999 } });
  });
  assert.equal((await api.ipUsage('900', '192.0.2.1', usageWindow(time))).days[usageWindow(time).to], 12);
  invalid = true; await assert.rejects(api.ipUsage('900', '192.0.2.1', usageWindow(time)), e => e.status === 502);
  await assert.rejects(api.ipUsage('900', 'bad', usageWindow(time)), e => e.status === 400);
  await assert.rejects(api.ipUsage('900', '192.0.2.1', { from: '2026-99-99', to: '2026-11-28' }), e => e.status === 400);
  console.log('IPROYAL_IP_USAGE_PASS per-IP API; first baseline; strict threshold; aliases; order isolation; restart; fixed cooldown; expiry; stale reads; reenable; counter reset; midnight; long gap; GB conversion; same-city ranking');
} finally { await patrol?.stop(); await fs.rm(root, { recursive: true, force: true }); }
