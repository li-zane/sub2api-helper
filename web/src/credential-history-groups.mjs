// Order metadata only; credential contents remain lazy-loaded by entry ID.
export function groupCredentialHistory(entries = []) {
  const ordered = entries.map((entry, index) => {
    const value = entry.at;
    const timestamp = (typeof value === "string" && value.trim()) || typeof value === "number"
      ? new Date(value).getTime() : NaN;
    return { entry, index, timestamp: Number.isFinite(timestamp) ? timestamp : -Infinity };
  }).sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
  const groups = new Map();
  for (const { entry } of ordered) {
    const type = String(entry.type || "unknown");
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(entry);
  }
  return [...groups].map(([type, records]) => ({ type, latest: records[0], history: records.slice(1) }));
}
