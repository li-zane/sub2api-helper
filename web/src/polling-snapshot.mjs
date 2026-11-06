// JSON API snapshots: preserve equal subtrees without hiding changing fields.
export function shareSnapshot(previous, next) {
  if (Object.is(previous, next)) return previous;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object") return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  if (Array.isArray(next) && previous.length !== next.length) return next.map((value, index) => shareSnapshot(previous[index], value));
  let changed = Object.keys(previous).length !== keys.length;
  const result = Array.isArray(next) ? [] : {};
  for (const key of keys) {
    const value = shareSnapshot(previous[key], next[key]);
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    if (!Object.hasOwn(previous, key) || value !== previous[key]) changed = true;
  }
  return changed ? result : previous;
}

// Key by ID so sorting/pagination cannot accidentally reuse a different account.
export function shareJobList(previous, next) {
  const byId = new Map(previous.map(job => [job.id, job]));
  const shared = next.map(job => shareSnapshot(byId.get(job.id), job));
  return shared.length === previous.length && shared.every((job, index) => job === previous[index]) ? previous : shared;
}
