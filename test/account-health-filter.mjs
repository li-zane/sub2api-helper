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
for (const source of ['manual', 'cooldown']) {
  const failedReset = { status: 'failed', source, poolPauseActive: true };
  assert.equal(accountHealth(valid, { inPool: true, remoteStatus: 'active' }, false, failedReset), 'abnormal', source + ' failed reset was masked by valid Web/active pool');
  assert.equal(accountHealth({ ...valid, sessionReset: { status: 'failed', source, poolPaused: true } }), 'abnormal');
  for (const status of ['queued', 'logging_out', 'cooling', 'authorizing', 'syncing', 'completed']) {
    assert.equal(accountHealth(valid, {}, false, { ...failedReset, status }), 'normal', 'pending/successful reset is not a failed reset');
  }
  assert.equal(accountHealth(valid, {}, false, { ...failedReset, poolPauseActive: false }), 'normal', 'resolved historical failure is not abnormal');
}
console.log('ACCOUNT_HEALTH_FILTER_PASS abnormal=banned/web_expired/pool_error/unresolved_relogin excluded=quota/429/manual_pause/normal_cooldown/historical_failure');
