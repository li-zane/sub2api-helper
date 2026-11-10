import crypto from "node:crypto";

const secret = value => typeof value?.totpSecret === "string" && value.totpSecret.trim() ? value.totpSecret
  : typeof value?.secret === "string" && value.secret.trim() ? value.secret : "";
const normalized = key => key.toUpperCase().replace(/[\s=]/g, "");
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;

// A presentation projection only. Original immutable records and raw IDs remain readable.
export function compactTotpHistory(history) {
  const versions = new Map(), cleared = [], rest = history.filter(event => event.type !== "2fa");
  const ensure = (key, event) => {
    const canonical = normalized(key);
    if (!versions.has(canonical)) versions.set(canonical, { key, events: new Map(), own: [], first: event });
    const value = versions.get(canonical); value.events.set(event.id, event); return value;
  };
  const ordered = history.filter(event => event.type === "2fa").map((event, index) => ({ event, index }))
    .sort((a, b) => timestamp(a.event.at) - timestamp(b.event.at) || a.index - b.index).map(({ event }) => event);
  for (const event of ordered) {
    const before = secret(event.before), after = secret(event.after);
    if (before) ensure(before, event);
    if (after) {
      const version = ensure(after, event); version.own.push(event);
      if (event.stage === "current") { version.current = event; version.key = after; }
    }
    if (event.stage === "local_key_delete_prepared") cleared.push({ ...event, stage: "cleared", label: "2FA · 已清空本地记录", compact: true });
    if (!before && !after && event.stage === "current") rest.push(event);
  }
  for (const [key, version] of versions) {
    const records = [...version.events.values()].filter(event => event.stage !== "current");
    const own = version.own.filter(event => event.stage !== "current");
    const latest = own.at(-1) || records[0] || version.current || version.first;
    const confirmed = own.some(event => event.after?.confirmation_succeeded === true || ["confirmed", "confirmed_before_save"].includes(event.stage));
    const activated = own.some(event => event.after?.activation_succeeded === true || ["activated", "activated_before_save"].includes(event.stage));
    const failed = /failed|invalid/.test(latest?.after?.stage || latest?.stage || "");
    const imported = own.some(event => ["imported", "manual_update_prepared"].includes(event.stage));
    const stage = version.current ? "current" : confirmed ? "confirmed" : activated ? "activated" : failed ? "candidate_failed" : imported ? "historical" : own.length ? "candidate" : "historical";
    const label = { current: "当前本地密钥", confirmed: "已确认密钥", activated: "已激活密钥", candidate_failed: "候选密钥 · 未完成", candidate: "候选密钥 · 待确认", historical: "历史密钥" }[stage];
    const after = { totpSecret: version.key, localRecord: Boolean(version.current), ...(version.current ? { remoteEnabled: version.current.after.remoteEnabled } : {}) };
    rest.push({ id: version.current ? "current-2fa" : `totp-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
      type: "2fa", stage, label: `2FA · ${label}`, compact: true, at: latest?.at || null, after,
      note: "同一密钥的流程已合并；本地保存不代表远端已启用，候选不代表生效。原始记录仍完整保留。",
      records: records.map(event => ({ id: event.id, at: event.at, stage: event.stage,
        ...(event.after?.stage && event.after.stage !== event.stage ? { resultStage: event.after.stage } : {}),
        ...Object.fromEntries(Object.entries(event.after || {}).filter(([name]) => /^(?:activation_succeeded|confirmation_succeeded|remote_disabled|enrollment_error|activation_error|confirmation_error)$/.test(name))) })) });
  }
  return [...rest, ...cleared];
}
