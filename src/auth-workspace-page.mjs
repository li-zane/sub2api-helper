// Decode server-provided JSON only. Never execute authentication-page scripts.
export function workspaceSessionFromHtml(html) {
  if (typeof html !== 'string' || html.length > 2_000_000) return null;
  const roots = [];
  for (const match of html.matchAll(/<script\b[^>]*\btype=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { roots.push(JSON.parse(match[1])); } catch {}
  }
  for (const match of html.matchAll(/__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g)) {
    try {
      const table = JSON.parse(JSON.parse(match[1]));
      if (!Array.isArray(table) || table.length > 10_000) continue;
      const decoded = new Map();
      function resolve(index) {
        if (!Number.isInteger(index) || index < 0 || index >= table.length) return undefined;
        if (decoded.has(index)) return decoded.get(index);
        const value = table[index];
        if (value === null || typeof value !== 'object') return value;
        const result = Array.isArray(value) ? [] : Object.create(null);
        decoded.set(index, result);
        if (Array.isArray(value)) for (const entry of value) result.push(resolve(entry));
        else for (const [key, entry] of Object.entries(value)) {
          const name = /^_\d+$/.test(key) ? resolve(Number(key.slice(1))) : key;
          if (typeof name === 'string' && !['__proto__', 'constructor', 'prototype'].includes(name)) result[name] = resolve(entry);
        }
        return result;
      }
      roots.push(resolve(0));
    } catch {}
  }
  const seen = new Set();
  const queue = [...roots];
  while (queue.length && seen.size < 10_000) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value.workspaces) && value.workspaces.some(w => w && typeof w.id === 'string' && w.id)) return value;
    queue.push(...Object.values(value));
  }
  return null;
}
