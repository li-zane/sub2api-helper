import crypto from "node:crypto";
import fs from "node:fs/promises";
import { writePrivateJsonAtomic } from "./account-history.mjs";

const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const ids = values => [...new Set((values || []).map(String).filter(v => /^[1-9]\d*$/.test(v)))].sort();
const sameIds = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));
const window = value => {
  if (!value || typeof value !== "object") return null;
  const result = { usedPercent: number(value.usedPercent), used: number(value.used), limit: number(value.limit), remaining: number(value.remaining),
    resetAt: date(value.resetAt), resetAfterSeconds: number(value.resetAfterSeconds), limitWindowSeconds: number(value.limitWindowSeconds) };
  return Object.values(result).some(v => v !== null) ? result : null;
};

// Only display data belongs here: never persist pool readiness, credentials,
// API keys or remote account objects. Missing values are not successful zeros.
function sanitizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const totals = value.totals ? { accountCost: number(value.totals.accountCost), userCost: number(value.totals.userCost),
    tokens: number(value.totals.tokens), fetchedAt: date(value.totals.fetchedAt), updatedAt: date(value.totals.updatedAt), stale: value.totals.stale === true } : null;
  const result = {
    source: "sub2api", fetchedAt: date(value.fetchedAt), snapshotTimestamp: date(value.snapshotTimestamp),
    planType: typeof value.planType === "string" ? value.planType.slice(0, 128) : null,
    allowed: bool(value.allowed), limitReached: bool(value.limitReached), stale: value.stale === true,
    primary: window(value.primary), secondary: window(value.secondary),
    credits: value.credits ? { hasCredits: bool(value.credits.hasCredits), unlimited: bool(value.credits.unlimited),
      balance: typeof value.credits.balance === "string" && value.credits.balance.trim() && Number.isFinite(Number(value.credits.balance)) ? value.credits.balance : null,
      overageLimitReached: bool(value.credits.overageLimitReached) } : null,
    resetCredits: value.resetCredits ? { availableCount: number(value.resetCredits.availableCount),
      credits: (Array.isArray(value.resetCredits.credits) ? value.resetCredits.credits : []).map(c => ({ expiresAt: date(c.expiresAt) })).filter(c => c.expiresAt) } : null,
    resetCreditsObserved: value.resetCreditsObserved === true, resetCreditsStale: value.resetCreditsStale === true, resetCreditsFetchedAt: date(value.resetCreditsFetchedAt), totals,
  };
  return result.primary || result.secondary || result.credits && Object.values(result.credits).some(v => v !== null)
    || result.resetCredits || [result.allowed, result.limitReached].some(v => v !== null)
    || totals && [totals.accountCost, totals.userCost, totals.tokens].some(v => v !== null) ? result : null;
}

export const usageSnapshotKey = (backend, email, accountIds) => crypto.createHash("sha256")
  .update(JSON.stringify([backend, String(email).toLowerCase(), ids(accountIds)])).digest("hex");

export class UsageSnapshots {
  constructor(file) { this.file = file; this.records = new Map(); this.writes = Promise.resolve(); }
  async load() {
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
    if (data?.version !== 1 || !Array.isArray(data.records)) return;
    for (const record of data.records) {
      if (!/^[a-f0-9]{24}$/.test(record.backend || "") || typeof record.email !== "string" || !record.email.includes("@")) continue;
      const usage = sanitizeUsage(record.usage), accountIds = ids(record.accountIds);
      if (usage && accountIds.length) this.records.set(`${record.backend}:${record.email.toLowerCase()}`, { backend: record.backend, email: record.email.toLowerCase(), accountIds, usage });
    }
  }
  get(backend, email, accountIds) {
    const record = this.records.get(`${backend}:${String(email).toLowerCase()}`);
    if (!record || accountIds && !sameIds(accountIds, record.accountIds)) return null;
    const copy = structuredClone(record);
    copy.usage.stale = true;
    if (copy.usage.resetCredits) copy.usage.resetCreditsStale = true;
    if (copy.usage.totals) copy.usage.totals.stale = true;
    copy.usage.cacheKey = usageSnapshotKey(backend, email, copy.accountIds);
    return copy;
  }
  async update(backend, records, { reconcile = false } = {}) {
    if (!/^[a-f0-9]{24}$/.test(backend || "")) throw Error("Invalid usage snapshot namespace");
    const keep = new Set();
    for (const record of records) {
      const email = String(record.email || "").toLowerCase(), accountIds = ids(record.accountIds), usage = sanitizeUsage(record.usage);
      const key = `${backend}:${email}`;
      if (!email.includes("@") || !accountIds.length || !usage) continue;
      keep.add(key); this.records.set(key, { backend, email, accountIds, usage });
    }
    if (reconcile) for (const [key, record] of this.records) if (record.backend === backend && !keep.has(key)) this.records.delete(key);
    await this.save();
  }
  async removeEmail(email) {
    for (const [key, record] of this.records) if (record.email === String(email).toLowerCase()) this.records.delete(key);
    await this.save();
  }
  save() {
    const snapshot = { version: 1, records: structuredClone([...this.records.values()]) };
    this.writes = this.writes.catch(() => {}).then(() => writePrivateJsonAtomic(this.file, snapshot));
    return this.writes;
  }
  flush() { return this.writes; }
}
