import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/console-app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function recoverSub2ApiAuthorization(');
const end = source.indexOf('  async function synchronizePoolRefresh(', start);
const create = new Function('scope', `with (scope) { return (${source.slice(start, end).trim()}); }`);

function fixture({ enabled = true, status = 'active', manuallyDisabled = false, degradationPaused = false } = {}) {
  const row = { id: 7, email: 'cache@example.test', status, schedulable: enabled, error_message: status === 'error' ? '401 token_revoked' : '' };
  const job = { poolRefreshRecovery: null }, writes = [];
  let oldCache = true, failClear = false;
  const scope = {
    overloadCooldown: { lock: (_email, run) => run(), isPaused: () => false, isManuallyDisabled: () => manuallyDisabled },
    degradationCooldown: { isPaused: () => degradationPaused },
    accountAutomationBlocked: () => false, sub2ApiAccountEmail: account => account.email,
    monitorBackendIdentity: () => 'backend', sessionResetAutomationPaused: () => false,
    sub2ApiAccountSchedulable: account => account.schedulable,
    saveJobMetadata: async () => {},
    requestSub2Api: async (_config, route, options = {}) => {
      if (route.endsWith('/clear-error')) {
        oldCache = false; row.status = 'active';
        if (failClear) { failClear = false; throw Error('clear response lost'); }
      } else if (route.endsWith('/schedulable')) {
        row.schedulable = JSON.parse(options.body).schedulable; writes.push(row.schedulable);
      }
      return { data: { ...row } };
    },
  };
  const recover = create(scope);
  return { row, job, writes, stale: () => oldCache, failNextClear: () => { failClear = true; },
    run: () => recover({}, row.id, row.email, { recoveryJob: job, freshCredentials: true }) };
}

for (const enabled of [true, false]) {
  const test = fixture({ enabled });
  await test.run();
  assert.equal(test.stale(), false, 'fresh OAuth left an active row using its old runtime token');
  assert.equal(test.row.schedulable, enabled, 'cache invalidation changed scheduling preference');
}
const uncertain = fixture({ enabled: false }); uncertain.failNextClear();
await assert.rejects(uncertain.run(), /response lost/);
assert.equal(uncertain.row.schedulable, false);
assert.equal(Object.values(uncertain.job.poolRefreshRecovery)[0].schedulable, false);
await uncertain.run();
assert.equal(uncertain.row.schedulable, false, 'retry enabled an originally disabled active row');
assert.equal(uncertain.job.poolRefreshRecovery, null);
for (const manuallyDisabled of [false, true]) {
  const test = fixture({ enabled: false, status: 'error', manuallyDisabled });
  await test.run();
  assert.equal(test.stale(), false);
  assert.equal(test.row.schedulable, !manuallyDisabled, 'authorization recovery ignored explicit disable');
}
for (const status of ['active', 'error']) {
  const test = fixture({ enabled: false, status, degradationPaused: true });
  await test.run();
  assert.equal(test.stale(), false, 'cooldown prevented credential cache invalidation');
  assert.equal(test.row.schedulable, false, 'credential recovery resumed a cooling account');
  assert(!test.writes.includes(true), 'credential recovery briefly enabled a cooling account');
}
console.log('OAUTH_CREDENTIAL_CACHE_PASS active enabled/disabled cache invalidation; uncertain-clear durable disabled intent; auth-error recovery; manual-disable and degradation cooldown preserved');
