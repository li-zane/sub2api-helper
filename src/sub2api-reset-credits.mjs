import { createHash } from "node:crypto";
import { limitPoolRequests } from "./pool-network.mjs";

// Only expose the count and expiration metadata supplied by Sub2API.
export function normalizeResetCredits(value, { cached = false, now = Date.now() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = value.available_count;
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const credits = Array.isArray(value.credits) ? value.credits.flatMap((credit) => {
    const expiresAt = typeof credit?.expires_at === "string" ? credit.expires_at.trim().slice(0, 100) : "";
    if (!expiresAt || (cached && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now)) return [];
    return [{ expiresAt }];
  }) : [];
  const availableCount = cached ? Math.min(count, credits.length) : count;
  // Like Sub2API, an expired or incomplete positive snapshot means unknown,
  // while an explicitly reported zero is a valid count.
  if (cached && count > 0 && availableCount === 0) return null;
  return { availableCount, credits };
}

// Quota queries reach the provider, unlike database-only account/usage polling.
// Cache attempts (including failures) and share in-flight manual/background reads.
export function createResetCreditsReader({ request, normalize = payload => {
  const data = payload?.data ?? payload;
  return { resetCredits: normalizeResetCredits(data?.rate_limit_reset_credits) };
}, getSettings = () => ({ ttlMs: 900_000, concurrency: 4 }), isBlocked = () => false, now = Date.now }) {
  let backend = "", cache = new Map(), inflight = new Map();
  const limited = limitPoolRequests(async (config, id, task, currentCache) => {
    if (!task.manual && isBlocked(id)) return null;
    let value;
    try {
      const payload = await request(config, `/api/v1/admin/openai/accounts/${encodeURIComponent(id)}/quota/refresh`, { method: "POST", timeoutMs: 30_000 });
      value = normalize(payload);
      if (!value || typeof value !== "object") throw Error("Invalid quota response");
      value = { ...value, resetCreditsObserved: true, resetCreditsFetchedAt: new Date(now()).toISOString(),
        resetCreditsStale: !value.resetCredits };
    } catch {
      value = { resetCredits: currentCache.get(id)?.value?.resetCredits || null,
        resetCreditsObserved: true, resetCreditsFetchedAt: new Date(now()).toISOString(), resetCreditsStale: true };
    }
    currentCache.set(id, { checkedAt: now(), value });
    return value;
  }, () => getSettings().concurrency);
  async function read(config, accountIds, { forceRefresh = false, manual = false } = {}) {
    const identity = createHash("sha256").update(`${config.baseUrl}\n${config.adminApiKey}`).digest("hex");
    if (identity !== backend) { backend = identity; cache = new Map(); inflight = new Map(); }
    const currentCache = cache, currentInflight = inflight;
    const ids = [...new Set(accountIds.map(String).filter(id => /^[1-9]\d*$/.test(id)))];
    return new Map(await Promise.all(ids.map(async id => {
      if (!manual && isBlocked(id)) return [id, null];
      const saved = currentCache.get(id);
      if (!forceRefresh && saved && now() - saved.checkedAt < getSettings().ttlMs) return [id, saved.value];
      let task = currentInflight.get(id);
      if (!task) {
        task = { manual };
        task.promise = limited(config, id, task, currentCache).finally(() => currentInflight.delete(id));
        currentInflight.set(id, task);
      } else if (manual) task.manual = true;
      return [id, await task.promise];
    })));
  }
  read.refreshSettings = limited.drain;
  return read;
}
