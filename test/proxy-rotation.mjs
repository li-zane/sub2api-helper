import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ProxyRotation, rankRotationExits, rebindPoolProxies } from "../src/proxy-rotation.mjs";
import { normalizeProxyRotation } from "../shared/proxy-rotation-settings.mjs";

const proxies = [
  { id: 1, ip: "a" }, { id: 2, ip: "a" }, { id: 3, ip: "b" },
  { id: 4, ip: "c" }, { id: 5, ip: "d" }, { id: 6, ip: "e", blocked: true },
];
const activity = new Map([
  ["b", { historicalAccountCount: 5 }],
  ["c", { historicalAccountCount: 2, lastRequestAt: "2026-11-25T00:00:00Z" }],
  ["d", { historicalAccountCount: 2, lastRequestAt: "2026-11-20T00:00:00Z" }],
]);
const args = { proxies, currentIps: new Set(["a"]), occupiedIps: new Set(["d"]), activity, ipOf: p => p.ip, available: p => !p.blocked };
assert.deepEqual(rankRotationExits(args).map(p => p.id), [4, 3, 5], "free before occupied, then distinct history");
assert.deepEqual(rankRotationExits({ ...args, occupiedIps: new Set(["b", "c", "d"]) }).map(p => p.id), [5, 4, 3], "all occupied: history then oldest request");
assert.deepEqual(rankRotationExits({ ...args, currentIps: new Set(), activity: new Map() }).map(p => p.id), [1, 3, 4, 5], "protocol aliases share an exit");
assert.throws(() => normalizeProxyRotation({ intervalMinutes: 0 }));
assert.throws(() => normalizeProxyRotation({ enabled: "yes" }));

const original = [1, 2].map(id => ({ id, platform: "openai", type: "oauth", proxy_id: id, credentials: { email: "a@example.test", access_token: "keep" } }));
let rows, local, writes, fail, external;
const reset = () => { rows = structuredClone(original); local = 1; writes = []; fail = null; external = false; };
const bind = () => rebindPoolProxies({
  rows: structuredClone(rows), proxyId: 3,
  read: async id => structuredClone(rows.find(r => r.id === id)),
  write: async (id, proxy) => {
    writes.push([id, proxy]);
    if (id === 2 && proxy === 3 && fail === "remote") throw Error("fixture remote failure");
    if (id === 2 && proxy === 3 && external) { rows[0].proxy_id = 9; throw Error("external edit"); }
    rows.find(r => r.id === id).proxy_id = proxy;
    if (id === 2 && proxy === 3 && fail === "ambiguous") throw Error("fixture lost response after write");
  },
  saveLocal: async () => { local = 3; if (fail === "local") throw Error("fixture local failure"); },
  restoreLocal: async () => { local = 1; },
});
reset(); await bind();
assert.deepEqual(rows.map(r => r.proxy_id), [3, 3]); assert.equal(local, 3);
assert.deepEqual(rows.map(r => r.credentials), original.map(r => r.credentials));
for (const scenario of ["remote", "ambiguous", "local"]) {
  reset(); fail = scenario; await assert.rejects(bind(), /fixture/);
  assert.deepEqual(rows, original, scenario + " compensation"); assert.equal(local, 1);
}
reset(); external = true; await assert.rejects(bind(), /部分绑定回退待确认/);
assert.equal(rows[0].proxy_id, 9, "rollback preserves concurrent external edits");

let time = 0, enabled = true, paused = false, busy = false, verdict = "match", calls = [], release;
let settings = normalizeProxyRotation({ enabled, intervalMinutes: 1, rotateMismatched: false });
const db = new DatabaseSync(":memory:");
const accounts = [{ email: "a@example.test" }, { email: "b@example.test" }];
const options = {
  getSettings: () => settings, canRun: () => !paused,
  getAccounts: () => ({ pool: "pool", accounts }),
  eligible: () => !busy && (verdict === "match" ? settings.rotateMatched : settings.rotateMismatched),
  rotate: async (account, value) => { calls.push([account.email, value.relogin]); if (release) await new Promise(resolve => { release = resolve; }); return true; },
  now: () => time, tickMs: 1000000,
};
let scheduler = new ProxyRotation(options); scheduler.load(db); scheduler.start(); await scheduler.tick();
assert.equal(calls.length, 0, "first enable waits a full interval");
time = 60000; busy = true; await scheduler.tick(); assert.equal(calls.length, 0);
busy = false; paused = true; await scheduler.tick(); assert.equal(calls.length, 0);
paused = false; verdict = "mismatch"; await scheduler.tick(); assert.equal(calls.length, 0);
verdict = "match"; await scheduler.tick(); assert.deepEqual(calls, [[accounts[0].email, false], [accounts[1].email, false]]);
await scheduler.stop(); scheduler = new ProxyRotation(options); scheduler.load(db); scheduler.start(); await scheduler.tick();
assert.equal(calls.length, 2, "restart preserves deadlines");
settings = { ...settings, intervalMinutes: 2, relogin: true }; scheduler.reset(); await scheduler.tick();
time = 179999; await scheduler.tick(); assert.equal(calls.length, 2, "interval edits reset full delay");
time = 180000; release = true; const work = scheduler.tick(); assert.equal(scheduler.tick(), work, "ticks do not overlap");
await Promise.resolve(); assert.equal(calls.length, 3);
const stop = scheduler.stop(); release(); await stop;
assert.equal(calls.length, 3, "stop drains work and skips remaining accounts");
assert.equal(calls.at(-1)[1], true);
settings = { ...settings, enabled: false }; scheduler.start(); time += 500000; await scheduler.tick(); await scheduler.stop();
assert.equal(calls.length, 3, "disabled scheduler does not rotate");
settings = { ...settings, enabled: true }; scheduler.reset();
let attempts = 0, failures = 0;
scheduler.rotate = async () => { attempts++; throw Error("fixture retry"); };
scheduler.onError = () => { failures++; };
scheduler.start(); await scheduler.tick(); time += 120000; await scheduler.tick();
assert.equal(attempts, 2); assert.equal(failures, 2);
await scheduler.tick(); assert.equal(attempts, 2, "failed accounts back off instead of retrying each scan");
await scheduler.stop();
db.close();
console.log("PROXY_ROTATION_PASS exit ranking; shared IPs; verified binding; compensation; external edits; deadlines; restart; selection; pause; stop");
