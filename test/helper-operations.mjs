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
  b.pause(acct, true);
  b.close();
  b = new OperationsBook(file, () => now);
  b.open();
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
  console.log(
    "HELPER_OPS_PASS durable policies, Shanghai inventory and settlement, partial finance, quality transitions, background conversation, idempotency and restart",
  );
} finally {
  b.close();
  await fs.rm(dir, { recursive: true, force: true });
}
