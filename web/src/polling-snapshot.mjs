// For same-length API arrays, allocate only at the first changed item.
function shareArray(previous, next, reconcile) {
  let result = previous.length === next.length ? null : [];
  for (let i = 0; i < next.length; i++) {
    const value = reconcile(previous[i], next[i], i);
    if (!result && !Object.is(value, previous[i])) result = previous.slice(0, i);
    if (result) result.push(value);
  }
  return result ?? previous;
}

// JSON API snapshots: preserve equal subtrees without hiding changing fields.
export function shareSnapshot(previous, next) {
  if (Object.is(previous, next)) return previous;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object") return next;
  if (Array.isArray(next)) return Array.isArray(previous) ? shareArray(previous, next, shareSnapshot) : next;
  if (Array.isArray(previous)) return next;
  const keys = Object.keys(next);
  let result = keys.length !== Object.keys(previous).length ? { ...next } : null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i], exists = Object.hasOwn(previous, key);
    const before = exists ? previous[key] : undefined;
    const value = shareSnapshot(before, next[key]);
    if (!result && (!exists || !Object.is(value, before))) {
      // Spread defines even "__proto__" as an own data property. Start from
      // next, not previous, so removed keys never survive a shape change.
      result = { ...next };
      for (let j = 0; j < i; j++) result[keys[j]] = previous[keys[j]];
    }
    if (result) result[key] = value;
  }
  return result ?? previous;
}

// Rows have unique IDs. In-order polls need no index; reorders and page
// changes resolve by ID, never by position.
export function shareJobList(previous, next, reconcile = shareSnapshot) {
  if (previous === next) return previous;
  if (previous.length === 0) return next.length ? next : previous;
  let byId;
  return shareArray(previous, next, (old, row) => {
    if (old?.id !== row.id) {
      if (!byId) {
        byId = new Map();
        for (const item of previous) byId.set(item.id, item);
      }
      old = byId.get(row.id);
    }
    return reconcile(old, row);
  });
}
