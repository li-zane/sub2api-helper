import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_WEB_SESSION_MONITOR = Object.freeze({ enabled: false, intervalMinutes: 15, autoRelogin: true, retryMinutes: 60 });
export function normalizeWebSessionMonitor(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WebSession 巡检设置必须为对象");
  const result = { ...DEFAULT_WEB_SESSION_MONITOR, ...value };
  for (const key of ["enabled", "autoRelogin"]) if (typeof result[key] !== "boolean") throw new Error("WebSession 巡检开关必须为布尔值");
  for (const [key, min] of [["intervalMinutes", 1], ["retryMinutes", 15]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > 1440) throw new Error(`WebSession ${key} 必须为 ${min} 到 1440 的整数分钟`);
  }
  return Object.fromEntries(Object.keys(DEFAULT_WEB_SESSION_MONITOR).map(k => [k, result[k]]));
}

// Server-owned, serial checks. No UI polling, parallel logins, logout-all or
// At most two retries for non-401 failures; only confirmed expiry/workspace changes repair.
export class WebSessionMonitor {
  constructor({ filePath, getSettings, listJobs, isBusy, hasSession, probe, repair, lock = (_job, fn) => fn(), withSlot = (_job, fn) => fn(), now = Date.now, tickMs = 30_000, retryDelayMs = 1_000 }) {
    Object.assign(this, { filePath, getSettings, listJobs, isBusy, hasSession, probe, repair, lock, withSlot, now, tickMs, retryDelayMs });
    this.accounts = Object.create(null); this.running = null; this.timer = null; this.stopped = false; this.writes = Promise.resolve();
    this.retryAbort = new AbortController();
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      for (const [email, value] of Object.entries(data.accounts || {})) if (value && typeof value === "object") this.accounts[email] = value;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  snapshot() { return { running: Boolean(this.running), settings: this.getSettings(), accounts: structuredClone(this.accounts) }; }
  start() {
    this.stopped = false;
    if (this.retryAbort.signal.aborted) this.retryAbort = new AbortController();
    if (!this.timer) { this.timer = setInterval(() => { void this.run().catch(() => {}); }, this.tickMs); this.timer.unref?.(); }
    void this.run().catch(() => {});
  }
  trigger(force = false) { if (!this.stopped) void this.run({ force }).catch(() => {}); }
  async stop() { this.stopped = true; this.retryAbort.abort(); clearInterval(this.timer); this.timer = null; await this.running; await this.writes; }
  async repairFinished(email, { success = true, webOnly = false } = {}) {
    const entry = this.accounts[email.toLowerCase()];
    if (entry) {
      entry.status = success ? "pending_check" : "needs_attention";
      entry.lastError = success ? null : "自动重登未完成；将在冷却限制内重新巡检";
      entry.nextCheckAt = new Date(this.now()).toISOString();
      // One successful Web renewal may require a separate workspace/OAuth repair.
      // Persist this continuation; a restart must neither lose it nor reset cooldown.
      entry.webRecoveryPending = success && webOnly && ["expired", "web_workspace_unavailable"].includes(entry.repairReason);
      await this.save();
    }
  }
  run({ force = false } = {}) {
    if (this.running) return this.running;
    if (this.stopped || !this.getSettings().enabled) return Promise.resolve(this.snapshot());
    this.running = this.scan(force).finally(() => { this.running = null; });
    return this.running;
  }
  async scan(force) {
    for (const job of await this.listJobs()) {
      if (this.stopped || !this.getSettings().enabled) break;
      const email = job.email.toLowerCase();
      const existing = this.accounts[email];
      if (!force && Date.parse(existing?.nextCheckAt) > this.now()) continue;
      if (this.isBusy(job) || !(await this.hasSession(job))) continue;
      // Admission may skip a full shared pool. Leave nextCheckAt untouched so the
      // next scheduler tick can try again without pretending a check happened.
      await this.withSlot(job, () => this.lock(job, async () => {
        if (this.stopped || !this.getSettings().enabled || this.isBusy(job)) return;
        const settings = this.getSettings();
        const at = new Date(this.now()).toISOString();
        const entry = this.accounts[email] ||= {};
        entry.lastCheckedAt = at;
        entry.nextCheckAt = new Date(this.now() + settings.intervalMinutes * 60_000).toISOString();
        let reason = null;
        let followUp = false;
        try {
          const result = await this.probeWithRetries(job, entry);
          if (Array.isArray(result.devices)) entry.devices = result.devices;
          entry.workspaces = result.workspaces || [];
          entry.currentWorkspaceId = result.currentWorkspaceId || null;
          entry.planType = result.planType || null;
          entry.lastError = null;
          entry.lastSuccessAt = at;
          reason = result.repairReason || null;
          followUp = entry.webRecoveryPending === true && Boolean(reason) && !["expired", "web_workspace_unavailable"].includes(reason);
          entry.webRecoveryPending = false;
          entry.status = reason ? "changed" : "valid";
        } catch (error) {
          reason = /^SESSION_TOKEN_EXPIRED:/.test(error.message) ? "expired"
            : /^SESSION_WORKSPACE_UNAVAILABLE:/.test(error.message) ? "web_workspace_unavailable" : null;
          entry.status = reason === "expired" ? "expired" : reason ? "changed" : "check_failed";
          // Persist a diagnostic class, never upstream response/token/cookie text.
          entry.lastError = reason === "expired" ? "Web 登录态已确认失效" : reason ? "Web 凭据绑定的空间已停用，需要恢复 Web 登录"
            : "巡检未完成：网络、代理、权限或上游异常；保留原绑定";
        }
        entry.repairReason = reason;
        await this.save();
        if (!reason || this.stopped || !this.getSettings().enabled || !settings.autoRelogin) return;
        if (!followUp && Date.parse(entry.lastRepairAt) + settings.retryMinutes * 60_000 > this.now()) { entry.status = "retry_wait"; await this.save(); return; }
        // Persist the cooldown before enqueueing so a restart cannot duplicate it.
        entry.lastRepairAt = at; entry.status = "repairing";
        await this.save();
        try {
          if (await this.repair(job, { reason }) === false) entry.status = "needs_attention";
        } catch { entry.status = "needs_attention"; entry.lastError = "自动重登未能入队，请检查账号资料或手动登录"; }
        await this.save();
      }));
    }
    return this.snapshot();
  }
  async probeWithRetries(job, entry) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      entry.checkAttempts = attempt;
      try { return await this.probe(job); }
      catch (error) {
        const unauthorized = [error.status, error.remoteStatus, error.response?.status].some(status => Number(status) === 401)
          || /\bHTTP\s+401\b/i.test(error.message || "");
        const terminal = /^SESSION_(?:TOKEN_EXPIRED|CREDENTIALS_UNAVAILABLE|WORKSPACE_UNAVAILABLE):/.test(error.message || "");
        const interrupted = () => this.stopped || !this.getSettings().enabled || this.isBusy(job);
        if (attempt === 3 || unauthorized || terminal || interrupted()) throw error;
        try { await delay(this.retryDelayMs * attempt, undefined, { signal: this.retryAbort.signal }); }
        catch { throw error; }
        if (interrupted()) throw error;
      }
    }
  }
  save() {
    const value = JSON.stringify({ version: 1, accounts: this.accounts }, null, 2) + "\n";
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, value, { mode: 0o600 }); await fs.rename(temp, this.filePath); }
      finally { await fs.rm(temp, { force: true }); }
    });
    return this.writes;
  }
}
