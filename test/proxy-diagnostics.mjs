import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ProxyDiagnostics, confirmedExit } from '../src/proxy-diagnostics.mjs';
import { rankRotationExits, rotationCityKey } from '../src/proxy-rotation.mjs';
import { proxyMatches } from '../web/src/proxy-search.mjs';

const db = new DatabaseSync(':memory:');
const calls = [], finished = [];
const report = (ip, city = 'Seattle') => ({ checkedAt: new Date().toISOString(), status: 'ok', stable: true,
  successCount: 2, sampleCount: 2, exits: [{ ip, countryCode: 'US', country: 'United States', region: 'Washington', city, riskScore: 7 }] });
let held;
const service = { async check(url) { calls.push(url); if (held) await held.promise; return url.includes('bad')
  ? { checkedAt: new Date().toISOString(), status: 'failed', stable: null, exits: [] } : report('198.51.100.' + new URL(url).port); }, async close() {} };
const create = () => { const d = new ProxyDiagnostics({ service, onResult: (...args) => finished.push(args) }); d.load(db); return d; };
let diagnostics = create();
const node = { id: 1, name: 'Seattle HTTP', protocol: 'http', host: 'fixture.test', port: 80, ipAddress: '198.51.100.80', url: 'http://user:secret@fixture.test:80/' };
held = Promise.withResolvers();
diagnostics.enqueue('a', [node, node]);
await Promise.resolve();
assert.equal(calls.length, 1);
const duplicate = diagnostics.check('a', node);
assert.equal(diagnostics.summary('a', node).qualityPending, true);
held.resolve(); await duplicate; await diagnostics.worker; held = null;
diagnostics.enqueue('a', [node]); await diagnostics.worker;
assert.equal(calls.length, 1, 'observing a saved result does not retest');
assert.equal(finished.length, 1);
assert.equal(diagnostics.summary('a', node).city, 'Seattle');
assert(!JSON.stringify(diagnostics.exit('a', node.ipAddress)).includes('secret'));
await diagnostics.close(); diagnostics = create();
assert.equal(diagnostics.summary('a', node).city, 'Seattle', 'reload preserves report');
assert.equal(diagnostics.get('b', node), null, 'backends isolated');
assert.equal(diagnostics.get('a', { ...node, url: 'http://changed.test/' }), null, 'connection edit invalidates result');
assert.equal(diagnostics.get('a', { ...node, ipAddress: '198.51.100.99' }), null, 'declared exit change invalidates result');
assert.equal(diagnostics.get('a', { ...node, name: 'Renamed' }).status, 'ok', 'renaming preserves measurement');
const bad = { ...node, id: 2, url: 'http://bad.test/' };
diagnostics.enqueue('a', [bad]); await diagnostics.worker; diagnostics.enqueue('a', [bad]); await diagnostics.worker;
assert.equal(calls.length, 2, 'failed attempts remain saved');
assert.equal(diagnostics.summary('a', bad).city, null);
const changed = { ...report('198.51.100.80'), stable: false, exits: [...report('198.51.100.80').exits, ...report('198.51.100.81', 'Portland').exits] };
diagnostics.save('a', node, changed);
assert.equal(confirmedExit(changed), null, 'unstable exit has no confirmed location');
assert.equal(diagnostics.summary('a', node).city, null);
const city = rotationCityKey(report('a').exits[0]);
assert.equal(city, rotationCityKey({ countryCode: 'us', region: ' Washington ', city: 'SEATTLE' }));
assert.notEqual(city, rotationCityKey({ countryCode: 'CA', region: 'Washington', city: 'Seattle' }));
assert.equal(rotationCityKey({ city: 'Seattle' }), null);
const candidates = [
  { id: 1, ip: 'a', city }, { id: 2, ip: 'b', city: 'different' }, { id: 3, ip: 'c', city },
  { id: 4, ip: 'd', city }, { id: 5, ip: 'e', city: null }, { id: 6, ip: 'c', city },
];
const args = { proxies: candidates, currentIps: new Set(['a']), currentCities: new Set([city]),
  occupiedIps: new Set(['d']), activity: new Map(), ipOf: p => p.ip, cityOf: p => p.city, available: () => true };
assert.deepEqual(rankRotationExits(args).map(p => p.id), [3, 4], 'same city before occupancy ranking and shared exit dedupe');
for (const currentCities of [new Set(), new Set([null]), new Set([city, 'other'])]) assert.deepEqual(rankRotationExits({ ...args, currentCities }), []);
assert.deepEqual(rankRotationExits({ ...args, available: p => p.city !== city }), [], 'no cross-city fallback');
assert(proxyMatches({ ipAddress: 'a', nodes: [{ name: 'Seattle HTTP', id: 7 }], quality: report('a') }, 'Seattle 7'));
assert(!proxyMatches({ nodes: [{ name: 'Seattle' }] }, 'Portland'));
await diagnostics.close(); db.close();
console.log('PROXY_DIAGNOSTICS_PASS dedupe; persisted success/failure; reload; connection invalidation; backend isolation; private fields; stable city; same-city ranking; no fallback; search');
