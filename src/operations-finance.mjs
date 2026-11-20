import { beijingDay, cents } from "./operations-book.mjs";
import { normalizeUsageTotals } from "./sub2api-usage-totals.mjs";

// Same account identities, actual-cost field and CNY multiplier as the account
// list. Its lifetime total isn't a daily figure: ask that very same endpoint
// for the selected Shanghai business day, never subtract lifetime snapshots.
export async function sampleLedger({
  book,
  config,
  namespace,
  listing,
  proxies,
  jobs,
  emailOf,
  ipOf,
  request,
  rate,
  settle = false,
}) {
  if (!config?.baseUrl || !config.adminApiKey)
    throw Object.assign(Error("请先配置号池"), { status: 409 });
  const day = book.today(),
    at = new Date(book.now()).toISOString();
  const [accounts, ips] = await Promise.all([listing(config), proxies(config)]);
  if (!accounts.complete)
    throw Object.assign(Error("号池账号列表不完整，保留上次账本"), {
      status: 502,
    });
  const rows = accounts.accounts.filter((r) => r.type === "oauth");
  const local = new Map();
  for (const j of jobs()) {
    const old = local.get(j.email.toLowerCase());
    if (!old || j.createdAt < old.createdAt)
      local.set(j.email.toLowerCase(), j);
  }
  for (const p of ips)
    book.seeIp(namespace, ipOf(p), p.created_at || p.createdAt);
  for (const p of book.db
    .prepare("SELECT ip,added,cost FROM ips WHERE pool=?")
    .all(namespace))
    book.expense("ip", namespace + ":" + p.ip, p.added, p.cost);
  const poolEmails = new Set(
    rows
      .map(emailOf)
      .filter(Boolean)
      .map((x) => x.toLowerCase()),
  );
  for (const [key, j] of local)
    if (j.resultSaved || poolEmails.has(key))
      book.expense("account", key, j.createdAt, cents(j.accountCostCny || 0));
  const ids = [
    ...new Set(
      rows.map((r) => String(r.id)).filter((n) => /^[1-9]\d*$/.test(n)),
    ),
  ];
  for (const r of rows) {
    const email = emailOf(r)?.toLowerCase();
    if (!local.has(email))
      book.expense(
        "account",
        email || namespace + ":" + r.id,
        r.created_at || r.createdAt,
        0,
      );
  }
  if (settle) {
    const prev = book.db
      .prepare(
        "SELECT day,rate FROM period_close WHERE day<? AND pool=? AND closed IS NULL ORDER BY day LIMIT 1",
      )
      .get(day, namespace);
    if (prev) {
      const keys = book.db
        .prepare("SELECT entity FROM income WHERE day=?")
        .all(prev.day)
        .map((r) => r.entity);
      const archived = keys
        .filter((k) => k.startsWith(namespace + ":"))
        .map((k) => k.slice(namespace.length + 1))
        .filter((k) => /^[1-9]\d*$/.test(k));
      for (const r of rows)
        if (beijingDay(r.created_at || r.createdAt) === prev.day)
          archived.push(String(r.id));
      const last = await readDay([...new Set(archived)], prev.day);
      // An incomplete final read leaves the last snapshot intact for retry.
      if (last.complete && keys.every((k) => k.startsWith(namespace + ":")))
        book.recordIncome(prev.day, last.observations, prev.rate, true, {
          pool: namespace,
          close: true,
        });
    }
  }
  const result = await readDay(ids, day);
  if (day !== book.today()) return book.ledger(); // don't apply an old response to a new day
  book.recordIncome(day, result.observations, rate, result.complete, {
    pool: namespace,
  });
  return book.ledger(day);
  async function readDay(ids, day) {
    let ix = 0,
      complete = true;
    const observations = [];
    async function worker() {
      while (ix < ids.length) {
        const id = ids[ix++];
        let usd = null;
        try {
          const q = new URLSearchParams({
            account_id: id,
            start_date: day,
            end_date: day,
            timezone: "Asia/Shanghai",
          });
          usd = normalizeUsageTotals(
            await request(config, "/api/v1/admin/usage/stats?" + q, {
              timeoutMs: 10000,
            }),
            at,
          ).userCost;
        } catch {
          /* Never turn an upstream failure into zero revenue. */
        }
        if (usd === null) complete = false;
        observations.push([namespace + ":" + id, usd]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(ids.length, 3) }, worker));
    return { observations, complete };
  }
}
