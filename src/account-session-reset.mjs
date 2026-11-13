import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const pending = new Set(["queued", "logging_out", "authorizing", "syncing"]);
export function sessionResetPending(state) { return pending.has(state?.status); }

// Private durable state: a reset keeps the route captured before logout, even
// when the plan, defaults or other accounts' proxy allocations later change.
export class AccountSessionResets {
  constructor(filePath) { this.filePath = filePath; this.accounts = new Map(); this.writes = Promise.resolve(); }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object") throw Error("会话重建记录格式无效");
      for (const [email, state] of Object.entries(data.accounts)) {
        if (state?.id && ["queued", "logging_out", "authorizing", "syncing", "completed", "failed"].includes(state.status)) this.accounts.set(email, state);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  get(email) { return this.accounts.get(String(email).toLowerCase()) || null; }
  publicState(email) {
    const state = this.get(email);
    if (!state) return null;
    const { id, status, source, startedAt, completedAt, error, proxyId } = state;
    return { id, status, source, startedAt, completedAt: completedAt || null, error: error || null, proxyId };
  }
  async save(email, changes) {
    email = email.toLowerCase();
    const operation = this.writes.catch(() => {}).then(async () => {
      const previous = this.accounts.get(email), next = changes === null ? null : { ...previous, ...changes };
      if (next) this.accounts.set(email, next); else this.accounts.delete(email);
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        await fs.writeFile(temporary, JSON.stringify({ version: 1, accounts: Object.fromEntries(this.accounts) }, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } catch (error) { if (previous) this.accounts.set(email, previous); else this.accounts.delete(email); throw error; }
      return next;
    });
    this.writes = operation; return operation;
  }
  begin(email, state) {
    if (sessionResetPending(this.get(email))) throw Error("账号已有会话重建任务");
    return this.save(email, { ...state, id: state.id || crypto.randomUUID(), status: "queued", startedAt: new Date().toISOString(), completedAt: null, error: null });
  }
  fail(email, error) { return this.save(email, { status: "failed", error: String(error?.message || error).slice(0, 500) }); }
  complete(email) { return this.save(email, { status: "completed", completedAt: new Date().toISOString(), error: null }); }
  remove(email) { return this.save(email, null); }
}

export function resetCredentialUpdate(local, remote) {
  if (!local?.credentials?.access_token || !local.credentials.refresh_token) throw Error("新 Codex OAuth 凭据不完整，号池保持不变");
  const credentials = { ...remote.credentials, ...local.credentials };
  // These writes deliberately omit proxy_id, schedulable, groups and priority.
  // OAuth identity/plan may change; the original pool row and route must not.
  return { credentials, ...(credentials.plan_type ? { plan_type: credentials.plan_type } : {}) };
}
