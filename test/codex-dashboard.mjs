import assert from 'node:assert/strict';
import { overloadDashboard, overloadEnergy } from '../web/src/codex-dashboard.mjs';

const points = [0, 1, 2, 3, 4, 5].map((count, i) => ({ count, requestCount: 1000, start: i, end: i + 1 }));
const cooldown = { settings: { windowMinutes: 15, threshold: 5 }, windowCount: 2 };
const dashboard = overloadDashboard({ points }, cooldown);
assert.equal(dashboard.quarter.count, 2, 'use rolling window for current 15min');
assert.equal(dashboard.quarter.limit, 5);
assert.equal(dashboard.total.count, 15, 'sum all six overload counts, excluding request counts');
assert.equal(dashboard.total.limit, 15, '90min threshold must be three times current threshold');
assert.equal(overloadDashboard({ points }, { ...cooldown, settings: { ...cooldown.settings, threshold: 10 } }).total.limit, 30);
assert.equal(overloadDashboard({ points }, { ...cooldown, lastError: 'unavailable' }).quarter.count, 5, 'fallback to last complete interval');
assert.equal(overloadDashboard({ points: points.slice(1) }, cooldown).total.count, null, 'partial intervals are not a 90min total');
assert.equal(overloadDashboard({ points: [...points.slice(1), { count: null }] }, cooldown).total.count, null);
assert.equal(overloadDashboard({ points: [{ count: 999 }, ...points] }, cooldown).total.count, 15, 'only six chart intervals count');
assert.equal(overloadDashboard(null, null).quarter.count, null);
assert.equal(overloadDashboard(null, null).total.limit, null);
const currentPoints = points.map((p,i)=>({...p,start:new Date(Date.UTC(2026,10,10,0,i*15)).toISOString(),end:new Date(Date.UTC(2026,10,10,0,(i+1)*15)).toISOString()}));
assert.equal(overloadDashboard({points:currentPoints},{...cooldown,lastCheckedAt:'2026-11-10T01:00:00Z'}).quarter.count,5,'stale cooldown must not replace newer count sync');
assert.equal(overloadDashboard({points:currentPoints},{...cooldown,lastCheckedAt:'2026-11-10T01:31:00Z'}).quarter.count,2,'newer rolling cooldown count remains useful');
assert.equal(overloadDashboard({points:currentPoints},{...cooldown,enabled:false,lastCheckedAt:'2026-11-10T01:31:00Z'}).quarter.count,5,'disabled cooldown cannot override synced count');
assert.equal(overloadEnergy(0, 5).tone, 'zero');
assert.equal(overloadEnergy(0, 5).color, 'var(--emerald)');
assert.equal(overloadEnergy(1, 5).ratio, 0.2);
assert.equal(overloadEnergy(1, 5).color, 'hsl(36 90% 48%)');
assert.equal(overloadEnergy(4, 5).color, 'hsl(9 90% 48%)');
assert.equal(overloadEnergy(5, 5).tone, 'full');
assert.equal(overloadEnergy(5, 5).color, 'hsl(0 90% 48%)');
assert.equal(overloadEnergy(100, 5).ratio, 1, 'bar cannot exceed track');
for (const [count, limit, enabled] of [[null, 5, true], [NaN, 5, true], [-1, 5, true], [2, 0, true], [2, null, true], [2, 5, false]]) {
  const state = overloadEnergy(count, limit, enabled);
  assert.equal(state.known, false);
  assert.equal(state.tone, 'unknown');
  assert.equal(state.ratio, 0);
}
console.log('CODEX_DASHBOARD_PASS rolling/fallback; six-interval totals; dynamic thresholds; green/yellow/red; saturation; missing/disabled states');
