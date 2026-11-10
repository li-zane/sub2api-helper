import assert from 'node:assert/strict';
import { accountHealth } from '../src/account-health.mjs';

const valid = { status: 'completed', resultSaved: true, webSessionStatus: 'valid' };
for (const pool of [
  { rateLimited: true }, { quotaRestricted: true }, { usage: { primary: { usedPercent: 100 } } },
  { inPool: true, enabled: false, remoteStatus: 'disabled' }, { remoteStatus: 'expired' },
]) assert.equal(accountHealth(valid, pool), 'normal', 'quota, throttling and manual pause are not account errors');
for (const field of ['loginAutomationPause', 'webSessionMaintenancePause', 'poolRefreshError']) {
  assert.equal(accountHealth({ ...valid, [field]: 'fixture' }), 'normal', field + ' must not become an account error');
}
assert.equal(accountHealth({ ...valid, webSessionStatus: 'unavailable' }), 'normal', 'credential read failure is not a confirmed expired session');
assert.equal(accountHealth({ status: 'failed' }), 'pending', 'historical task failure is not account health');
assert.equal(accountHealth({ status: 'mfa_failed' }), 'pending');
assert.equal(accountHealth({ ...valid, status: 'banned' }), 'abnormal');
assert.equal(accountHealth(valid, {}, true), 'abnormal');
assert.equal(accountHealth({ ...valid, webSessionStatus: 'expired' }), 'abnormal');
assert.equal(accountHealth(valid, { inPool: true, remoteStatus: 'error' }), 'abnormal');
assert.equal(accountHealth({ status: 'queued' }), 'pending');
console.log('ACCOUNT_HEALTH_FILTER_PASS abnormal=banned/web_expired/pool_error excluded=quota/429/paused/historical_failure');
