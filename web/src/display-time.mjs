export const DEFAULT_DISPLAY_TIME_ZONE = "Asia/Shanghai";
export function normalizeDisplayTimeZone(value = DEFAULT_DISPLAY_TIME_ZONE) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new Error("显示时区必须是有效的 IANA 时区，例如 Asia/Shanghai 或 UTC");
  try { return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone; }
  catch { throw new Error("显示时区必须是有效的 IANA 时区，例如 Asia/Shanghai 或 UTC"); }
}
let zone = DEFAULT_DISPLAY_TIME_ZONE;
const listeners = new Set(), formatters = new Map();
export const getDisplayTimeZone = () => zone;
export function subscribeDisplayTimeZone(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function setDisplayTimeZone(value) {
  const next = normalizeDisplayTimeZone(value);
  if (next === zone) return;
  zone = next; formatters.clear(); for (const listener of listeners) listener();
}
function formatter(options) {
  const key = JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: zone, hourCycle: "h23" }));
  return formatters.get(key);
}
const full = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
export function displayDateTime(value, options = full) {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatter(options).format(date) : "—";
}
export function displayTimeParts(value) {
  const date = new Date(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(date.getTime())) return { date: "-", time: "", year: "" };
  const parts = Object.fromEntries(formatter(full).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.month}/${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`, year: parts.year };
}
export function compactDateTime(value) {
  const p = displayTimeParts(value), now = displayTimeParts(new Date());
  return !p.time ? "-" : p.date === now.date && p.year === now.year ? p.time : `${p.date} ${p.time}`;
}
export function displayProtocolLog(value) {
  return String(value || "").replace(/^\[(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\] /gm,
    (original, at) => {
      const date = new Date(at); if (!Number.isFinite(date.getTime())) return original;
      const parts = displayTimeParts(at);
      const offset = formatter({ timeZoneName: "shortOffset" }).formatToParts(date).find(p => p.type === "timeZoneName")?.value || zone;
      return `[${parts.year}/${parts.date} ${parts.time} ${offset}] `;
    });
}
