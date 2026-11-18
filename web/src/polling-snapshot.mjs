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
  // Responses generally keep their field order. A matching key proves own
  // membership directly, while the fallback handles reordered objects.
  const previousKeys = Object.keys(previous);
  let count = 0, result = null;
  for (const key in next) {
    if (!Object.hasOwn(next, key)) continue;
    const exists = previousKeys[count++] === key || Object.hasOwn(previous, key);
    const before = exists ? previous[key] : undefined;
    const incoming = next[key];
    if (exists && Object.is(before, incoming)) continue;
    const value = shareSnapshot(before, incoming);
    if (!result && (!exists || !Object.is(value, before))) {
      result = copySharedPrefix(previous, next, key);
    }
    if (result) result[key] = value;
  }
  if (result) return result;
  // A deletion alone is discovered after visiting all incoming fields.
  return count === previousKeys.length ? previous : copySharedPrefix(previous, next);
}

function copySharedPrefix(previous, next, stopKey) {
  // Spread defines "__proto__" as an own data property. Fields preceding
  // the first change already compared equal and retain their old references.
  const result = { ...next };
  for (const key of Object.keys(next)) {
    if (key === stopKey) break;
    result[key] = previous[key];
  }
  return result;
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
