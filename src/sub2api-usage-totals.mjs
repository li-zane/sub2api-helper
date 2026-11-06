import { createHash } from "node:crypto";
import { DEFAULT_POOL_SYNC_CONCURRENCY } from "./pool-network.mjs";

const amount = value => value === null || value === undefined || typeof value === "boolean" || String(value).trim() === ""
  ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function normalizeUsageTotals(payload, fetchedAt) {
  const data = payload?.data ?? payload;
  const totals = {
    accountCost: amount(data?.total_account_cost),
    userCost: amount(data?.total_actual_cost),
    tokens: amount(data?.total_tokens),
    fetchedAt, stale: false,
  };
  if ([totals.accountCost, totals.userCost, totals.tokens].every(value => value === null)) throw new Error("Sub2API 累计统计缺少数据");
  return totals;
}

export function combineUsageTotals(ids, records) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return null;
  const values = unique.map(id => records.get(id));
  const sum = field => values.some(value => value?.[field] == null) ? null : values.reduce((total, value) => total + value[field], 0);
  const times = values.map(value => value?.fetchedAt).filter(Boolean).sort();
  return { accountCost: sum("accountCost"), userCost: sum("userCost"), tokens: sum("tokens"),
    fetchedAt: times[0] || null, stale: values.some(value => !value || value.stale),
  };
}

// All-history accounting is separate from upstream 5h/7d quota snapshots.
// Bound concurrency and cache both successful and failed attempts to avoid fan-out on list polling.
export function createUsageTotalsReader({ request, ttlMs = 60_000, concurrency = DEFAULT_POOL_SYNC_CONCURRENCY, isBlocked = () => false, getSettings = () => ({ ttlMs, concurrency }), now = Date.now }) {
  let backend = "", cache = new Map(), inflight = new Map(), active = 0;
  const queue = [];
  function schedule(action) {
    return new Promise((resolve, reject) => {
      queue.push({ action, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < getSettings().concurrency && queue.length) {
      const task = queue.shift(); active++;
      Promise.resolve().then(task.action).then(task.resolve, task.reject).finally(() => { active--; pump(); });
    }
  }
  async function read(config, accountIds, { forceRefresh = false } = {}) {
    const identity = createHash("sha256").update(`${config.baseUrl}\n${config.adminApiKey}`).digest("hex");
    if (identity !== backend) { backend = identity; cache = new Map(); inflight = new Map(); }
    const currentCache = cache, currentInflight = inflight;
    const ids = [...new Set(accountIds.map(String).filter(id => /^[1-9]\d*$/.test(id)))];
    return new Map(await Promise.all(ids.map(async id => {
      if (isBlocked(id)) return [id, null];
      const saved = currentCache.get(id);
      if (!forceRefresh && saved && now() - saved.checkedAt < getSettings().ttlMs) return [id, saved.value];
      if (!currentInflight.has(id)) {
        const task = schedule(async () => {
          if (isBlocked(id)) return null;
          let value;
          try {
            const query = new URLSearchParams({ account_id: id, start_date: "1970-01-01", end_date: new Date(now()).toISOString().slice(0, 10), timezone: "UTC" });
            if (forceRefresh) query.set("nocache", "true");
            const payload = await request(config, `/api/v1/admin/usage/stats?${query}`, { timeoutMs: 10_000 });
            value = normalizeUsageTotals(payload, new Date(now()).toISOString());
          } catch {
            value = { ...(saved?.value || { accountCost: null, userCost: null, tokens: null, fetchedAt: null }), stale: true };
          }
          currentCache.set(id, { checkedAt: now(), value });
          return value;
        }).finally(() => currentInflight.delete(id));
        currentInflight.set(id, task);
      }
      return [id, await currentInflight.get(id)];
    })));
  }
  read.refreshSettings = pump;
  return read;
}
