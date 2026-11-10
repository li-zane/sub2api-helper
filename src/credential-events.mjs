import path from "node:path";
import fs from "node:fs/promises";
import { recordCredentialHistory, readCredentialHistory } from "./account-history.mjs";
import { normalizeAccountWorkspaces } from "./account-workspaces.mjs";
import { uniqueWorkspaceAccounts } from "./workspace-accounts.mjs";
import { smsOrderCost } from "./sms-order-cost.mjs";

const queues = new Map();
function serialized(root, action) {
  const key = path.resolve(root), previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(action); queues.set(key, pending);
  return pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
}
const text = value => typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 128) || null : null;

export function workspaceSnapshot(payload) {
  const raw = payload?.accounts;
  if (!raw || typeof raw !== "object" || payload.error || payload.has_more || payload.next_page || payload.next_cursor) return null;
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  if (entries.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) return null;
  const unique = uniqueWorkspaceAccounts(payload);
  // Never interpret an incomplete/malformed response or UI truncation as removals.
  if (unique.length > 100 || entries.length && !unique.length) return null;
  if (Array.isArray(raw) && entries.some(entry => !text(entry.account?.account_id || entry.account?.id || entry.account_id || entry.id || entry.accountId))) return null;
  return normalizeAccountWorkspaces(payload).workspaces.map(({ current, availabilityLabel, ...workspace }) => workspace)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function recordWorkspaceHistory(root, payload, email) {
  const after = workspaceSnapshot(payload);
  if (!after) return Promise.resolve(null);
  return serialized(root, async () => {
    const records = (await readCredentialHistory(root)).filter(event => event.type === "workspaces")
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
    const previous = records.at(-1), before = previous?.after?.workspaces ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    const old = new Map((before || []).map(item => [item.id, item])), next = new Map(after.map(item => [item.id, item]));
    const changes = { added: after.filter(item => !old.has(item.id)), removed: (before || []).filter(item => !next.has(item.id)),
      updated: after.filter(item => old.has(item.id) && JSON.stringify(old.get(item.id)) !== JSON.stringify(item))
        .map(item => ({ id: item.id, before: old.get(item.id), after: item })) };
    return recordCredentialHistory(root, { type: "workspaces", stage: previous ? "changed" : "discovered", email, sequence: (previous?.sequence || 0) + 1,
      before: before ? { workspaces: before } : null, after: { workspaces: after }, changes },
    { key: `workspaces:${previous?.id || "initial"}:${JSON.stringify(after)}` });
  });
}

// Persist only order fields that describe the accepted phone, never API keys or OTPs.
export function phoneOrderDetails(order = {}, providerId, providerName) {
  return { requestId: text(order.requestId), number: text(order.number), providerId: text(providerId), providerName: text(providerName),
    country: text(order.country), countryName: text(order.countryName), rank: text(order.rank),
    supplierId: text(order.providerId), cost: order.cost ? smsOrderCost(order.cost.amount, order.cost.currency) : null };
}

export async function recordAcceptedPhone(root, { phone, email, runId, order = null }) {
  if (!/^\+?[1-9]\d{6,14}$/.test(String(phone || ""))) return null;
  if (!order) {
    try { order = JSON.parse(await fs.readFile(path.join(root, "sms-order.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  const matching = order?.number === phone && order?.runId === runId;
  const after = { phone, ...(matching ? phoneOrderDetails({ ...order, providerId: order.supplierId }, order.providerId, order.providerName) : { providerName: "手动号码", cost: null }) };
  const key = matching && order.requestId ? `${order.providerId}:${order.requestId}:${phone}` : `manual:${runId}:${phone}`;
  return serialized(root, () => recordCredentialHistory(root, { type: "phone", stage: "verified", email, after }, { key: `phone:${key}` }));
}
