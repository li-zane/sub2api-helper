import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIproyalPatrol } from '../src/iproyal-patrol.mjs';
import { iproyalSettings } from '../shared/iproyal-settings.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iproyal-controls-'));
let patrol;
try {
  for (const patch of [{ intervalMinutes: 0 }, { intervalMinutes: 1.1 }, { intervalMinutes: 1441 },
    { thresholdGbPerIp: -1 }, { syncCost: true }, { usdToCny: 0 }, { autoPause: 1 }]) {
    assert.throws(() => iproyalSettings(patch), e => e.status === 400);
  }
  // Only one of five supplier IPs is in the pool, through two protocols.
  const nodes = [1, 2].map(id => ({ id, host: '192.0.2.1', name: 'order-' + id }));
  let balance = 50, broken = false, priceBroken = false, time = 1000000, timer;
  const costs = [];
  const options = { root, target: () => ({ key: 'pool' }), canRun: () => true, now: () => time,
    setTimer: (callback, ms) => (timer = { callback, ms }), clearTimer: () => { timer = null; },
    list: async () => nodes, rename: async (_c, node, name) => { node.name = name; },
    syncCost: async (_c, node, cost) => costs.push({ id: node.id, cost }),
    source: async () => ({ identity: 'account',
      inventory: async () => Array.from({ length: 5 }, (_, i) => ({ ip: `192.0.2.${i + 1}`, order: '900' })),
      bandwidth: async () => { if (broken) throw Error('private detail'); return { gb_balance: balance, gb_limit: 100, gb_used: 100 - balance }; },
      orderCost: async () => { if (priceBroken) throw Error('private detail'); return { amountUsd: 12.15, quantity: 5, days: 30, usdPerIp: 2.43 }; },
    }),
  };
  patrol = createIproyalPatrol(options);
  await patrol.load(); patrol.start();
  await patrol.configure({ enabled: true, intervalMinutes: 7, autoPause: true, thresholdGbPerIp: 10, syncCost: true, usdToCny: 7.2 });
  await patrol.run();
  assert.equal(timer.ms, 420000);
  assert.equal(patrol.status().nextRunAt, time + 420000);
  assert.equal(patrol.lookup('pool', nodes[0].host).thresholdGb, 50);
  assert.equal(patrol.lookup('pool', nodes[0].host).ipCount, 5);
  assert(patrol.isBlocked('pool', 1)); assert(patrol.isBlocked('pool', 2));
  assert(!patrol.isBlocked('other-pool', 1));
  assert.deepEqual(costs, [{ id: 1, cost: 17.5 }], 'once per exit IP with cent rounding');
  balance = 51; time += 420000;
  timer.callback(); await patrol.run();
  assert(!patrol.isBlocked('pool', 1), 'replenishment clears only automatic gate');
  balance = 0; await patrol.run();
  assert(patrol.isBlocked('pool', 1));
  broken = true; priceBroken = true;
  const costCount = costs.length;
  await patrol.run();
  assert(patrol.isBlocked('pool', 1), 'API failure preserves last known gate');
  assert.equal(costs.length, costCount, 'stale price must not overwrite local cost');
  assert(patrol.lookup('pool', nodes[0].host).costStale);
  assert(!patrol.status().message.includes('private detail'));
  await patrol.stop();
  patrol = createIproyalPatrol(options); await patrol.load();
  assert(patrol.isBlocked('pool', 2), 'gate persists across restart');
  await patrol.configure({ autoPause: false, intervalMinutes: 2 }); await patrol.run();
  assert(!patrol.isBlocked('pool', 1));
  assert.equal(patrol.status().intervalMinutes, 2);
  await patrol.configure({ enabled: false });
  assert.equal(timer, null);
  assert.equal(patrol.lookup('pool', nodes[0].host), null);
  await patrol.stop();
  // Legacy settings load with defaults; disabling during a request prevents writes.
  const delayedRoot = path.join(root, 'delayed'); await fs.mkdir(delayedRoot);
  await fs.writeFile(path.join(delayedRoot, 'iproyal-settings.json'), JSON.stringify({ enabled: true }));
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const delayedWrites = [];
  patrol = createIproyalPatrol({ ...options, root: delayedRoot,
    syncCost: async () => delayedWrites.push('cost'), rename: async () => delayedWrites.push('name'),
    source: async () => ({ identity: 'delayed', inventory: async () => [{ ip: nodes[0].host, order: '999' }],
      bandwidth: async () => { entered(); await held; return { gb_balance: 0 }; } }),
  });
  await patrol.load(); assert.equal(patrol.status().intervalMinutes, 5);
  const running = patrol.run(); await waiting;
  const disabling = patrol.configure({ enabled: false });
  // The persisted switch changes before configure waits for the pending read.
  for (let i = 0; i < 200 && patrol.status().enabled; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(patrol.status().enabled, false);
  release(); await running; await disabling;
  assert.deepEqual(delayedWrites, []);
  assert(!patrol.isBlocked('pool', 1));
  console.log('IPROYAL_CONTROLS_PASS');
} finally { await patrol?.stop(); await fs.rm(root, { recursive: true, force: true }); }
