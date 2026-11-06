import assert from "node:assert/strict";
import { LoginTimeouts } from "../src/login-timeout.mjs";
import { normalizeLoginTimeoutMinutes, normalizeSmsTimeoutMinutes } from "../web/src/login-settings.mjs";

assert.equal(normalizeLoginTimeoutMinutes(), 3);
for (const value of [0, 1441, 1.5, null, "3", false, NaN, Infinity]) assert.throws(() => normalizeLoginTimeoutMinutes(value));
for (const value of [1, 3, 1440]) assert.equal(normalizeLoginTimeoutMinutes(value), value);
let now = 0, minutes = 3, nextId = 0;
const timers = new Map(), expired = [];
const clock = new LoginTimeouts({ getMinutes: () => minutes, onTimeout: (job, entry) => expired.push({ id: job.id, ...entry, job: undefined }),
  now: () => now, setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: now + delay }); return id; }, clearTimer: id => timers.delete(id) });
const tick = end => { now = end; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } };
const job = { id: "one" };
clock.start(job, "web_login"); tick(179999); assert.equal(expired.length, 0); tick(180000);
assert.equal(expired.length, 1); assert.equal(expired[0].mode, "web_login"); assert.equal(clock.entries.size, 0);
clock.start(job, "full"); const stale = [...timers.values()][0].fn; clock.stop(job); clock.start(job, "full"); stale();
assert.equal(expired.length, 1, "an old callback expired a replacement attempt");
tick(240000); minutes = 5; clock.reschedule(); tick(360000); assert.equal(expired.length, 1);
minutes = 1; clock.reschedule(); tick(360000); assert.equal(expired.length, 2, "settings change reset elapsed time");
for (const mode of ["web_login", "full", "refresh", "totp_setup", "password_add"]) { clock.start({ id: mode }, mode); }
assert.equal(clock.entries.size, 5); clock.close(); assert.equal(timers.size, 0);
clock.start(job, "full"); clock.stop(job); tick(9999999); assert.equal(expired.length, 2);
now = 0; minutes = 3; clock.start(job, "refresh"); tick(60000);
const oldPhase = [...timers.values()][0].fn;
clock.pause(job); tick(3600000); clock.resume(job, "full"); oldPhase();
assert.equal(expired.length, 2, "stale timer crossed a queue pause");
tick(3719999); assert.equal(expired.length, 2); tick(3720000); assert.equal(expired.length, 3, "automatic retry received a fresh budget");
console.log("LOGIN_TIMEOUT_PASS default 3 minutes; strict validation; exact deadline; no stage reset; live grow/shrink; stale attempt isolation; completion/cancel/shutdown cleanup");

assert.equal(normalizeSmsTimeoutMinutes(), 10);
for (const v of [0, 1441, 1.5, null, "10", true]) assert.throws(() => normalizeSmsTimeoutMinutes(v));
now = 0; minutes = 3; let smsMinutes = 10;
const smsClock = new LoginTimeouts({ getMinutes: () => minutes, getSmsMinutes: () => smsMinutes, now: () => now,
  onTimeout: (j, e) => expired.push({ id: j.id, phase: e.phase }),
  setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: now + delay }); return id; }, clearTimer: id => timers.delete(id) });
smsClock.start(job, "full"); tick(120000); const loginTimer = [...timers.values()][0].fn;
assert.equal(smsClock.enterSms(job), true); assert.equal(smsClock.remaining(job), 600000); loginTimer();
const before = expired.length; tick(300000); assert.equal(expired.length, before);
assert.equal(smsClock.enterSms(job), false); assert.equal(smsClock.remaining(job), 420000);
minutes = 1; smsClock.reschedule(); tick(400000); assert.equal(expired.length, before, "login settings switched SMS phase back");
smsClock.pause(job); tick(900000); smsClock.resume(job, "full");
assert.equal(smsClock.entries.get(job.id).phase, "sms"); assert.equal(smsClock.remaining(job), 320000);
tick(1219999); assert.equal(expired.length, before); tick(1220000); assert.equal(expired.at(-1).phase, "sms");
now=0; smsClock.start(job,"full"); smsClock.enterSms(job); tick(60000); smsMinutes=2; smsClock.reschedule(); tick(120000);
assert.equal(expired.at(-1).phase,"sms"); smsClock.close();
console.log("SMS_DEADLINE_PASS default10; one-time latch; no return after OTP; no resend/replacement reset; queue pause; live setting changes preserve phase; canceled login callbacks cannot expire SMS");
