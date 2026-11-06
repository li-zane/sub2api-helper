export const DEFAULT_POOL_SYNC_CONCURRENCY = 100;

// Bound requests, not accounts: one overload account fetches two series concurrently.
export function limitPoolRequests(request, concurrency = DEFAULT_POOL_SYNC_CONCURRENCY) {
  const limit = () => typeof concurrency === "function" ? concurrency() : concurrency;
  if (!Number.isInteger(limit()) || limit() < 1) throw new Error("Invalid pool request concurrency");
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit() && queue.length) {
      const { args, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(() => request(...args)).then(resolve, reject).finally(() => { active--; drain(); });
    }
  };
  const limited = (...args) => new Promise((resolve, reject) => { queue.push({ args, resolve, reject }); drain(); });
  limited.drain = drain;
  return limited;
}
