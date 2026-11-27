import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OperationsBook, beijingDay } from "../src/operations-book.mjs";
import { sampleLedger } from "../src/operations-finance.mjs";
import { AccountTestChat } from "../src/account-test-chat.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-ops-"));
let now = Date.parse("2026-01-03T11:00:00Z");
const file = path.join(dir, "ops.sqlite");
let b = new OperationsBook(file, () => now);
b.open();
try {
  const before = "2026-01-02T15:59:00Z",
    added = "2026-01-02T16:00:00Z",
    acct = "owner@example.test",
    ns = "pool";
  assert.equal(beijingDay(before), "2026-01-02");
  assert.equal(beijingDay(added), "2026-01-03");
  const pool = "activity-fixture";
  const row = { id: 9, email: acct, ip: "192.0.2.10", lastUsedAt: before };
  const t = Date.parse(added);
  b.proxyActivity.observe(pool, 1, [row, { ...row, id: 10 }], t);
  assert.deepEqual(b.proxyActivity.byIp(pool).get(row.ip), { historicalAccountCount: 1, lastRequestAt: null });
  const used = new Date(t + 1000).toISOString();
  b.proxyActivity.observe(pool, 2, [{ ...row, lastUsedAt: used }, { ...row, email: "another@example.test", id: 11 }], t + 2000);
  b.proxyActivity.noteBinding(pool, row.ip, acct.toUpperCase());
  assert.deepEqual(b.proxyActivity.byIp(pool).get(row.ip), { historicalAccountCount: 2, lastRequestAt: used });
  const other = { ...row, ip: "192.0.2.20", lastUsedAt: used };
  b.proxyActivity.observe(pool, 3, [other], t + 3000);
  b.proxyActivity.observe(pool, 2, [row], t + 4000);
  assert.deepEqual(b.proxyActivity.byIp(pool).get(other.ip), { historicalAccountCount: 1, lastRequestAt: null });
  b.proxyActivity.observe(pool, 4, [{ ...other, lastUsedAt: 'invalid' }], t + 5000);
  assert.equal(b.proxyActivity.byIp(pool).get(other.ip).lastRequestAt, null);
  b.proxyActivity.observe(pool, 5, [], t + 6000);
  const backfill = { ...row, ip: '192.0.2.30', lastUsedAt: used, accountUpdatedAt: added, proxyUpdatedAt: before };
  b.proxyActivity.observe(pool, 6, [backfill], t + 7000);
  assert.equal(b.proxyActivity.byIp(pool).get(backfill.ip).lastRequestAt, used);
  assert.equal(b.proxyActivity.byIp("other-backend").size, 0);
  const accountIps = [
    { ipAddress: "192.0.2.10", lastRequestAt: used },
    { ipAddress: "192.0.2.30", lastRequestAt: used },
    { ipAddress: "192.0.2.20", lastRequestAt: null },
  ];
  assert.deepEqual(b.proxyActivity.byAccount(pool, acct.toUpperCase()), accountIps);
  b.proxyActivity.noteBinding(pool, "192.0.2.40", "renamed@example.test");
  b.proxyActivity.noteBinding(pool, row.ip, "renamed@example.test");
  b.proxyActivity.observe(pool, 7, [{ ...row, id: 99, email: "unrelated@example.test", ip: "192.0.2.99" }], t + 8000);
  assert.deepEqual(b.proxyActivity.byAccount(pool, acct), accountIps, "remote deletion keeps only this account's history");
  assert.deepEqual(b.proxyActivity.byAccount(pool, [acct, "renamed@example.test", acct]), [
    ...accountIps, { ipAddress: "192.0.2.40", lastRequestAt: null },
  ], "former/current email histories merge by exit and preserve request times");
  assert.deepEqual(b.proxyActivity.byAccount("other-backend", acct), []);
  assert.deepEqual(b.proxyActivity.byAccount(pool, "unknown@example.test"), []);
  b.savePolicy(ns, 12, "test-ip", added, {
    allocationPaused: true,
    ipCostCny: "3.81",
  });
  b.savePolicy(ns, 13, "test-ip", added, {
    allocationPaused: false,
    ipCostCny: "3.81",
  });
  assert(b.isBlocked(ns, 12));
  assert(!b.isBlocked(ns, 13));
  assert.equal(b.policy(ns, 13, "test-ip").ipCostCny, 3.81);
  b.savePolicy(ns, 12, "test-ip", added, { ipCostCny: 4.5 });
  assert(b.isBlocked(ns, 12), 'cost synchronization must preserve manual pause');
  assert.equal(b.policy(ns, 13, "test-ip").ipCostCny, 4.5, 'shared exit IP cost');
  b.savePolicy(ns, 13, "test-ip", added, { allocationPaused: true });
  assert.equal(b.policy(ns, 13, "test-ip").ipCostCny, 4.5, 'participation change preserves cost');
  assert.throws(() => b.savePolicy(ns, 12, "test-ip", added, {}), /分配状态/);
  b.savePolicy(ns, 13, "test-ip", added, { allocationPaused: false, ipCostCny: 3.81 });
  b.pause(acct, true);
  b.close();
  b = new OperationsBook(file, () => now);
  b.open();
  assert.deepEqual(b.proxyActivity.byIp(pool).get(row.ip), { historicalAccountCount: 3, lastRequestAt: used });
  assert.deepEqual(b.proxyActivity.byAccount(pool, acct), accountIps, "account IP history survives restart");
  assert(b.paused(acct));
  assert(b.isBlocked(ns, 12));
  assert.equal(b.ledger().ipCount, 1);
  const seen = [];
  let fail = false,
    usd = 1.25;
  const run = () =>
    sampleLedger({
      book: b,
      settle: true,
      config: { baseUrl: ns, adminApiKey: "fixture" },
      namespace: ns,
      listing: async () => ({
        complete: true,
        accounts: [
          {
            id: 7,
            email: acct,
            type: "oauth",
            platform: "openai",
            created_at: added,
          },
          {
            id: 8,
            email: "old@example.test",
            type: "oauth",
            platform: "openai",
            created_at: before,
          },
          { id: 99, type: "apikey", platform: "openai" },
        ],
      }),
      proxies: async () => [],
      jobs: () => [
        {
          email: acct,
          resultSaved: true,
          createdAt: added,
          accountCostCny: 2.1,
        },
        {
          email: "old@example.test",
          resultSaved: true,
          createdAt: before,
          accountCostCny: 88,
        },
      ],
      emailOf: (r) => r.email,
      ipOf: (p) => p.ip,
      rate: 2,
      request: async (c, url) => {
        const q = new URL(url, "https://mock.invalid").searchParams;
        seen.push(q.get("account_id"));
        assert.equal(q.get("timezone"), "Asia/Shanghai");
        assert.equal(q.get("start_date"), q.get("end_date"));
        if (fail && q.get("account_id") === "7") throw Error();
        return { total_actual_cost: usd };
      },
    });
  const d = await run();
  assert.deepEqual(seen.sort(), ["7", "8"]);
  assert.equal(d.accountCostCents, 210);
  assert.equal(d.ipCostCents, 381);
  assert.equal(d.incomeCents, 500);
  assert.equal(d.profitCents, -91);
  fail = true;
  const partial = await run();
  assert.equal(partial.complete, false);
  assert.equal(partial.incomeCents, 500);
  now += 24 * 3600000;
  fail = false;
  usd = 2;
  await run();
  const closed = b.ledger("2026-01-03");
  assert.equal(closed.incomeCents, 800);
  assert(closed.closedAt);
  b.savePolicy(ns, 12, "test-ip", added, {
    allocationPaused: true,
    ipCostCny: 999,
  });
  usd = 3;
  await run();
  assert.deepEqual(b.ledger("2026-01-03"), closed);
  b.recordQuality(acct, added, "error");
  assert.equal(b.quality(acct, added).kind, "unknown");
  b.recordQuality(acct, added, "match");
  assert.equal(b.quality(acct, added).kind, "normal");
  b.recordQuality(acct, "2026-01-02T16:15:00Z", "mismatch");
  b.recordQuality(acct, "2026-01-02T16:18:00Z", "mismatch");
  assert.equal(b.quality(acct, added).minutesAfterJoin, 15);
  b.recordQuality(acct, "2026-01-02T17:15:00Z", "match");
  assert.equal(b.quality(acct, added).minutesToRecovery, 60);
  const repeatedAt = "2026-01-02T18:00:00.000Z";
  b.db.prepare("INSERT INTO quality VALUES(?,?,?)").run(acct, "2026-01-02T15:40:00.000Z", "match");
  for (let n = 0; n < 52; n++) {
    b.recordQuality(acct, repeatedAt, "unknown", { id: `inconclusive-${n}`, method: "candy", source: "manual" });
  }
  b.recordQuality(acct, repeatedAt, "mismatch", { id: "degraded-again", method: "fingerprint", source: "scheduled" });
  b.recordQuality(acct, repeatedAt, "error", { id: "unavailable", method: "fingerprint", source: "scheduled" });
  b.recordQuality(acct, repeatedAt, "error", { id: "unavailable" });
  assert.equal(b.quality(acct, added).currentStatus, "mismatch");
  assert.equal(b.quality(acct, added).lastCheckedAt, repeatedAt);
  b.close();
  b.open();
  const quality = b.quality(acct, added);
  assert.deepEqual(quality.timeline.map(item => [item.previousStatus,item.status]), [[null,"match"],["match","mismatch"],["mismatch","match"],["match","mismatch"]]);
  assert.equal(quality.timeline[0].at, "2026-01-02T15:40:00.000Z");
  assert.equal(quality.timeline.at(-1).method, "fingerprint");
  const recent = b.qualityPage(acct);
  const earlier = b.qualityPage(acct, recent.nextBefore);
  assert.equal(recent.records.length, 50);
  assert.equal(earlier.nextBefore, null);
  assert.equal(new Set([...recent.records, ...earlier.records].map(row => row.id)).size, 60);
  assert.deepEqual(recent.records.slice(0, 2).map(row => row.status), ["error", "mismatch"]);
  assert.throws(() => b.qualityPage(acct, "wrong"), /分页参数无效/);
  b.recordQuality("regex-only@example.test", repeatedAt, "match", {id:"regex-pass",method:"regex",source:"manual"});
  assert.equal(b.qualityPage("regex-only@example.test").records[0].method, "regex");
  let finish, captured;
  const gate = new Promise((r) => (finish = r)),
    target = { pool: ns, id: "7" };
  const chat = new AccountTestChat(b, {
    catalog: async () => ["chat-test"],
    send: async (t, m, q, signal, msgs) => {
      assert.equal(t.id, "7");
      captured = msgs;
      await gate;
      return "fixture answer";
    },
  });
  const body = {
    id: randomUUID(),
    conversationId: randomUUID(),
    model: "chat-test",
    question: "first question",
  };
  await chat.start(acct, target, body);
  await chat.start(acct, target, body);
  assert.equal(chat.list(acct).length, 1);
  assert.equal(chat.list(acct)[0].state, "running");
  await assert.rejects(
    chat.start(acct, target, { ...body, id: randomUUID() }),
    /进行/,
  );
  finish();
  await chat.work.get(acct).done;
  assert.equal(chat.list(acct)[0].answer, "fixture answer");
  await chat.start(acct, target, {
    ...body,
    id: randomUUID(),
    question: "follow up",
  });
  await chat.work.get(acct)?.done;
  assert.deepEqual(
    captured.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.equal(captured[1].content, "fixture answer");
  const nextConversation = randomUUID();
  await chat.start(acct, target, { ...body, id: randomUUID(), conversationId: nextConversation, question: "independent question" });
  await chat.work.get(acct)?.done;
  assert.deepEqual(captured, [{ role: "user", content: "independent question" }]);
  assert.equal(chat.conversation(acct, ns, "7", body.conversationId).turns.length, 2);
  assert.equal(chat.conversation(acct, ns, "7", null).conversationId, nextConversation);
  assert.deepEqual(chat.conversation(acct, ns, "8", nextConversation).turns, []);
  assert.deepEqual(chat.conversation(acct, "other-pool", "7", nextConversation).turns, []);
  assert.deepEqual(chat.list("other@example.test"), []);
  await assert.rejects(
    chat.start(acct, target, { ...body, id: randomUUID(), model: "made-up" }),
    /模型目录/,
  );
  await chat.stop();
  const id = randomUUID();
  b.db
    .prepare(
      "INSERT INTO chats(id,account,pool,remote,model,question,state,created) VALUES(?,?,?,?,?,?,'running',?)",
    )
    .run(id, acct, ns, "7", "m", "q", added);
  b.close();
  b = new OperationsBook(file, () => now);
  b.open();
  assert.equal(
    b.db.prepare("SELECT state FROM chats WHERE id=?").get(id).state,
    "interrupted",
  );
  const reopened = new AccountTestChat(b, {});
  assert.equal(reopened.conversation(acct, ns, "7", "legacy").turns[0].state, "interrupted");
  console.log(
    "HELPER_OPS_PASS durable policies, Shanghai inventory and settlement, partial finance, quality transitions, background conversation, idempotency and restart",
  );
} finally {
  b.close();
  await fs.rm(dir, { recursive: true, force: true });
}
