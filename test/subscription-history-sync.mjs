import assert from "node:assert/strict";
import { createSubscriptionHistorySync } from "../src/subscription-history-sync.mjs";

function fixture() {
  const job = { email: "fixture@example.test", outputPath: "job/export.json", planType: "team", remark: "original" };
  let reads = 0, version = 1, active = 0, fail = false, committed;
  const observed = [], barriers = new Map();
  const history = {
    has: () => false,
    async reconcile(items, emails) {
      assert.equal(++active, 1, "history writes must not overlap");
      try {
        observed.push({ remark: items[0]?.remark, emails });
        const barrier = barriers.get(observed.length);
        barrier?.entered.resolve();
        await barrier?.release.promise;
        if (fail) throw Error("fixture write failed");
        committed = items[0];
      } finally {
        active--;
      }
    },
  };
  const service = createSubscriptionHistorySync({
    history, listJobs: () => [job], readCredentialHistory: async () => [],
    getPlanType: job => job.planType, isAccountBlocked: () => false,
    getUserCost: () => 0, accountEmail: account => account.email,
    files: {
      stat: async () => ({ mtimeMs: version, size: 100 }),
      async readFile() {
        reads++;
        return JSON.stringify({ type: "sub2api-data", accounts: [
          { email: job.email, credentials: { access_token: `fixture-${version}` } },
          { email: "unrelated@example.test", credentials: { access_token: "unrelated-fixture" } },
        ] });
      },
    },
  });
  return {
    ...service, job, observed,
    get reads() { return reads; },
    get committed() { return committed; },
    changeExportOnDisk: () => { version++; },
    failReconcile: value => { fail = value; },
    pause(round) {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      barriers.set(round, { entered, release });
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

// Each late request joins a scan after reconcile has already started.
{
  const fixtureSync = fixture();
  const paused = fixtureSync.pause(1);
  const first = fixtureSync.ensureFresh();
  await paused.entered;
  const pending = [first];
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    pending.push(fixtureSync.ensureFresh());
    assert.strictEqual(pending.at(-1), first);
  }
  assert.strictEqual(fixtureSync.waitForIdle(), first);
  paused.release();
  await Promise.all(pending);
  assert.deepEqual(fixtureSync.observed, [{ remark: "original", emails: [fixtureSync.job.email] }]);
  assert.equal(fixtureSync.waitForIdle(), undefined);
  console.log("SUBSCRIPTION_SYNC_READ_ONLY reads=5 scans=1 settled=5");
}

{
  const fixtureSync = fixture();
  const firstScan = fixtureSync.pause(1);
  const secondScan = fixtureSync.pause(2);
  const first = fixtureSync.ensureFresh();
  await firstScan.entered;
  fixtureSync.job.remark = "first mutation";
  fixtureSync.invalidate();
  fixtureSync.job.remark = "latest mutation";
  fixtureSync.invalidate();
  const writeBarrier = fixtureSync.ensureFresh();
  assert.strictEqual(fixtureSync.ensureFresh(), writeBarrier);
  firstScan.release();
  await secondScan.entered;
  assert.strictEqual(fixtureSync.waitForIdle(), writeBarrier);
  assert.strictEqual(fixtureSync.ensureFresh(), writeBarrier);
  assert.equal(fixtureSync.committed.remark, "original");
  secondScan.release();
  await Promise.all([first, writeBarrier]);
  assert.equal(fixtureSync.committed.remark, "latest mutation");
  assert.deepEqual(fixtureSync.observed.map(({ remark }) => remark), ["original", "latest mutation"]);
  assert.equal(fixtureSync.reads, 1, "unchanged exports must not be parsed twice");
  assert.deepEqual(JSON.parse(fixtureSync.committed.credentials.sub2apiJson).accounts.map(account => account.email), [fixtureSync.job.email]);
  console.log("SUBSCRIPTION_SYNC_MUTATION writes=2 scans=2 latest=committed");

  fixtureSync.job.remark = "retry";
  fixtureSync.failReconcile(true);
  fixtureSync.invalidate();
  await assert.rejects(fixtureSync.ensureFresh(), /fixture write failed/);
  assert.equal(fixtureSync.waitForIdle(), undefined);
  assert.equal(fixtureSync.committed.remark, "latest mutation");
  fixtureSync.failReconcile(false);
  fixtureSync.changeExportOnDisk();
  await fixtureSync.ensureFresh();
  assert.equal(fixtureSync.committed.remark, "retry");
  assert.equal(fixtureSync.reads, 2, "an idle read must discover external changes without explicit invalidation");
  assert.equal(JSON.parse(fixtureSync.committed.credentials.sub2apiJson).accounts[0].credentials.access_token, "fixture-2");
  fixtureSync.forgetExport(fixtureSync.job.outputPath);
  await fixtureSync.ensureFresh();
  assert.equal(fixtureSync.reads, 3, "deletion can release cached export data");
}

{
  const fixtureSync = fixture();
  const firstScan = fixtureSync.pause(1);
  const secondScan = fixtureSync.pause(2);
  const first = fixtureSync.ensureFresh();
  await firstScan.entered;
  fixtureSync.job.remark = "prior to deletion";
  fixtureSync.invalidate();
  firstScan.release();
  await secondScan.entered;
  fixtureSync.job.deleted = true;
  fixtureSync.invalidate();
  const writeBarrier = fixtureSync.ensureFresh();
  secondScan.release();
  await Promise.all([first, writeBarrier]);
  assert.deepEqual(fixtureSync.observed, [
    { remark: "original", emails: [fixtureSync.job.email] },
    { remark: "prior to deletion", emails: [fixtureSync.job.email] },
    { remark: undefined, emails: [] },
  ]);
}

console.log("SUBSCRIPTION_SYNC_PASS serialized publication; change during follow-up; retry after failed write; export cache; idle drain");
