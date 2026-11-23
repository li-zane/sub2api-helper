import fs from "node:fs/promises";
import crypto from "node:crypto";
import { writePrivateJsonAtomic } from "./account-history.mjs";
import { accountProfitCents, restoredAccountCost } from "../shared/account-pricing.mjs";
import { formatCnyCents } from "../shared/currency-text.mjs";

const text = value => typeof value === "string" ? value : "";
const emailKey = value => text(value).trim().toLowerCase();
const timestamp = value => Number.isFinite(Date.parse(value)) ? value : null;
const nonSubscriptions = new Set(["free", "free_plan", "chatgptfreeplan", "unknown", "null", "undefined", "none", "n/a"]);
export const isSubscribedPlan = value => Boolean(text(value).trim()) && !nonSubscriptions.has(text(value).trim().toLowerCase());
const knownPlan = value => {
  const plan = text(value).trim().toLowerCase();
  if (["free", "free_plan", "chatgptfreeplan"].includes(plan)) return "free";
  return isSubscribedPlan(plan) ? plan : null;
};
const recordId = email => crypto.createHash("sha256").update(email).digest("hex").slice(0, 32);
const secretKeys = ["password", "totpSecret", "mailApiUrl", "mailRequestBody", "sub2apiJson"];
// Keep an unread plan change even when a later ban/recovery replaces lastChange.
const planChangeRevision = record => record?.lastSubscriptionChangeRevision
  || (record?.lastChange?.types?.includes("subscription") ? record.lastChange.revision : 0);

// Use only recorded workspace/plan evidence, never arbitrary words in logs.
export function historicalSubscriptionEvidence(events = []) {
  const candidates = [];
  for (const event of events) {
    if (event?.type !== "workspaces") continue;
    for (const side of [event.before, event.after]) {
      for (const workspace of Array.isArray(side?.workspaces) ? side.workspaces : []) {
        if (isSubscribedPlan(workspace?.planType)) candidates.push({ planType: workspace.planType, at: timestamp(event.at) });
      }
    }
  }
  return candidates.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))[0] || null;
}

export function subscriptionCredentialText(email, credentials = {}) {
  const password = text(credentials.password), totp = text(credentials.totpSecret);
  const mail = text(credentials.mailRequestBody) || text(credentials.mailApiUrl);
  if (password) return [email, password, ...(mail ? [mail] : []), ...(totp ? [totp] : [])].join("----");
  if (mail) return [email, mail, ...(totp ? [totp] : [])].join("----");
  if (totp) return `${email}--------${totp}`;
  return text(credentials.sub2apiJson);
}

// Latest private credentials only; public summaries never include secret fields.
// Entries survive a downgrade or removal from the main account list.
export class SubscriptionHistory {
  constructor(file, { now = () => new Date().toISOString() } = {}) {
    this.file = file; this.now = now; this.records = new Map(); this.writes = Promise.resolve();
  }
  async load() {
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (data?.version !== 1 || !Array.isArray(data.records)) throw Error("历史订阅记录格式无效");
    for (const record of data.records) {
      const email = emailKey(record.email);
      if (!email.includes("@") || !isSubscribedPlan(record.lastPaidPlanType)) continue;
      this.records.set(email, { ...record, email, id: recordId(email), credentials: Object.fromEntries(secretKeys
        .filter(key => typeof record.credentials?.[key] === "string").map(key => [key, record.credentials[key]])) });
    }
  }
  has(email) { return this.records.has(emailKey(email)); }
  get size() { return this.records.size; }
  get unreadPlanChangeCount() {
    let count = 0;
    for (const record of this.records.values()) {
      if (planChangeRevision(record) > (record.lastSeenChangeRevision || 0)) count++;
    }
    return count;
  }
  reconcile(observations, presentEmails) {
    const work = this.writes.catch(() => {}).then(async () => {
      const next = new Map([...this.records].map(([key, value]) => [key, structuredClone(value)]));
      const present = new Set(presentEmails.map(emailKey));
      const at = this.now();
      for (const observation of observations) {
        const email = emailKey(observation.email);
        if (!email.includes("@")) continue;
        const previous = next.get(email);
        const paidPlan = isSubscribedPlan(observation.planType) ? observation.planType
          : isSubscribedPlan(observation.historicalPlanType) ? observation.historicalPlanType : null;
        if (!previous && !paidPlan) continue;
        const credentials = { ...previous?.credentials };
        for (const key of secretKeys) if (typeof observation.credentials?.[key] === "string") credentials[key] = observation.credentials[key];
        const fromPlan = knownPlan(previous?.planType);
        const toPlan = knownPlan(observation.planType) || fromPlan;
        const accountBanned = typeof observation.accountBanned === "boolean" ? observation.accountBanned : previous?.accountBanned === true;
        const types = [];
        if (fromPlan && toPlan && fromPlan !== toPlan) types.push("subscription");
        if (accountBanned && previous?.accountBanned !== true) types.push("banned");
        if (!accountBanned && previous?.accountBanned === true) types.push("recovered");
        const record = { ...previous, id: recordId(email), email,
          accountAddedAt:previous?.accountAddedAt || timestamp(observation.accountAddedAt),
          loginEmail: emailKey(observation.loginEmail) || email,
          remark: text(observation.remark), accountCostCny: restoredAccountCost(observation.accountCostCny),
          planType: toPlan,
          accountBanned,
          lastSubscriptionChangeRevision: planChangeRevision(previous),
          lastPaidPlanType: isSubscribedPlan(observation.planType) ? observation.planType : previous?.lastPaidPlanType || paidPlan,
          firstSubscribedAt: previous?.firstSubscribedAt || timestamp(observation.firstSubscribedAt) || at,
          userCostUsd: typeof observation.userCostUsd === "number" && Number.isFinite(observation.userCostUsd) && observation.userCostUsd >= 0
            ? observation.userCostUsd : previous?.userCostUsd ?? null,
          present: present.has(email), credentials };
        if (types.length) record.lastChange = { revision: (previous?.lastChange?.revision || 0) + 1,
          at, types, fromPlanType: fromPlan, toPlanType: toPlan };
        if (types.includes("subscription")) record.lastSubscriptionChangeRevision = record.lastChange.revision;
        if (!previous || JSON.stringify({ ...previous, updatedAt: undefined }) !== JSON.stringify({ ...record, updatedAt: undefined })) record.updatedAt = at;
        next.set(email, record);
      }
      for (const [email, record] of next) if (record.present !== present.has(email)) next.set(email, { ...record, present: present.has(email), updatedAt: at });
      if (JSON.stringify([...next]) === JSON.stringify([...this.records])) return;
      await writePrivateJsonAtomic(this.file, { version: 1, records: [...next.values()] });
      this.records = next;
    });
    this.writes = work;
    return work;
  }
  markSeen(changes) {
    const work = this.writes.catch(() => {}).then(async () => {
      const revisions = new Map(changes.map(change => [change.id, change.revision]));
      const next = new Map(this.records);
      let acknowledged = 0;
      for (const [email, record] of next) {
        const revision = record.lastChange?.revision;
        // Exact revisions prevent a delayed acknowledgement from hiding a newer change.
        if (!revision || revisions.get(record.id) !== revision || record.lastSeenChangeRevision === revision) continue;
        next.set(email, { ...record, lastSeenChangeRevision: revision });
        acknowledged++;
      }
      if (acknowledged) {
        await writePrivateJsonAtomic(this.file, { version: 1, records: [...next.values()] });
        this.records = next;
      }
      return acknowledged;
    });
    this.writes = work;
    return work;
  }
  list(multiplier,qualityFor) {
    return [...this.records.values()].sort((a, b) => String(b.firstSubscribedAt).localeCompare(String(a.firstSubscribedAt)) || a.email.localeCompare(b.email)).map(record => {
      const profit = accountProfitCents(record.userCostUsd, multiplier, record.accountCostCny);
      return { id: record.id, email: record.loginEmail || record.email, remark: record.remark, accountCostCny: record.accountCostCny,
        userCostUsd: record.userCostUsd, poolPriceMultiplier: multiplier,
        profitCents: profit === null ? null : profit.toString(), profitDisplay: formatCnyCents(profit),
        planType: record.planType, lastPaidPlanType: record.lastPaidPlanType,
        ...(qualityFor ? {quality:qualityFor(record.email,record.accountAddedAt || record.firstSubscribedAt)} : {}),
        accountBanned: record.accountBanned === true,
        lastChange: record.lastChange ? { ...structuredClone(record.lastChange), unread: record.lastSeenChangeRevision !== record.lastChange.revision } : null,
        firstSubscribedAt: record.firstSubscribedAt, updatedAt: record.updatedAt, present: record.present,
        canCopyCredentials: Boolean(subscriptionCredentialText(record.email, record.credentials)) };
    });
  }
  credentials(id) {
    const record = [...this.records.values()].find(record => record.id === id);
    if (!record) return null;
    return subscriptionCredentialText(record.loginEmail || record.email, record.credentials);
  }
  emailForId(id) {
    return [...this.records.values()].find(record => record.id === id)?.email ?? null;
  }
  flush() { return this.writes; }
}
