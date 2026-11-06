import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POOL_SYNC_CONCURRENCY, limitPoolRequests } from "./pool-network.mjs";
import { collectOverloadWindow } from "./overload-monitor.mjs";

export const DEFAULT_OVERLOAD_COOLDOWN = Object.freeze({ windowMinutes: 15, threshold: 10, cooldownMinutes: 60 });

export function normalizeOverloadCooldown(value = DEFAULT_OVERLOAD_COOLDOWN) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("自动冷却规则格式无效");
  const limits = { windowMinutes: [1, 1440, "统计窗口"], threshold: [1, 100000, "过载次数阈值"], cooldownMinutes: [1, 43200, "自动冷却时长"] };
  return Object.fromEntries(Object.entries(limits).map(([key, [min, max, label]]) => {
    const raw = value[key] ?? DEFAULT_OVERLOAD_COOLDOWN[key];
    const number = typeof raw === "boolean" || raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
    return [key, number];
  }));
}

export class OverloadCooldown {
  constructor({ filePath, getConfig, backendIdentity, getSettings, listAccounts, request, getMonitoringSettings = () => ({ intervalMs: 60_000, concurrency: DEFAULT_POOL_SYNC_CONCURRENCY }), isBlocked = () => false, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { filePath, getConfig, backendIdentity, getSettings, listAccounts, request, getMonitoringSettings, isBlocked, onChange, now, setTimer, clearTimer });
    this.request = limitPoolRequests(request, () => this.getMonitoringSettings().concurrency);
    this.accounts = new Map();
    this.locks = new Map();
    this.writePromise = Promise.resolve();
    this.mutationPromise = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.stopped = true;
    this.rerun = false;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object") throw new Error("自动冷却配置格式无效");
      for (const [email, raw] of Object.entries(data.accounts)) {
        if (!raw || typeof raw.enabled !== "boolean") continue;
        const resumeAccountIds = Array.isArray(raw.resumeAccountIds) ? [...new Set(raw.resumeAccountIds.map(String).filter(id => /^\d+$/.test(id)))] : [];
        this.accounts.set(email.toLowerCase(), { ...raw, resumeAccountIds, revision: Number.isSafeInteger(raw.revision) ? raw.revision : 0 });
      }
    } catch (error) { if (error.code !== "ENOENT") throw new Error(`自动冷却状态读取失败：${error.message}`); }
  }

  snapshot(email) {
    const entry = this.accounts.get(email.toLowerCase());
    const config = this.getConfig();
    return {
      configured: Boolean(config?.baseUrl && config?.adminApiKey), enabled: entry?.enabled === true, revision: entry?.revision || 0,
      phase: entry?.phase || "idle", coolingUntil: entry?.coolingUntil || null,
      windowCount: entry?.windowCount ?? null, lastCheckedAt: entry?.lastCheckedAt || null, lastError: entry?.lastError || null,
      settings: { ...this.getSettings() },
    };
  }

  isPaused(email) {
    const entry = this.accounts.get(String(email).toLowerCase());
    return Boolean(entry?.resumeAccountIds?.length && entry.backend === this.backendIdentity(this.getConfig()));
  }

  isManuallyDisabled(email, accountId, config = this.getConfig()) {
    return this.accounts.get(String(email).toLowerCase())?.manualScheduling?.[this.backendIdentity(config)]?.[String(accountId)] === false;
  }

  persist() {
    const data = JSON.stringify({ version: 1, accounts: Object.fromEntries(this.accounts) }, null, 2);
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, `${data}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    });
    this.writePromise = operation;
    return operation;
  }

  update(email, changes) {
    const operation = this.mutationPromise.catch(() => {}).then(async () => {
      const previous = this.accounts.get(email);
      const next = changes === null ? null : { ...previous, ...changes, revision: (previous?.revision || 0) + 1 };
      if (next) this.accounts.set(email, next); else this.accounts.delete(email);
      try { await this.persist(); }
      catch (error) { if (previous) this.accounts.set(email, previous); else this.accounts.delete(email); throw error; }
      return next;
    });
    this.mutationPromise = operation;
    return operation;
  }

  lock(email, action) {
    const operation = (this.locks.get(email) || Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(email, operation);
    return operation.finally(() => { if (this.locks.get(email) === operation) this.locks.delete(email); });
  }

  async setEnabled(email, enabled) {
    email = email.toLowerCase();
    await this.lock(email, async () => {
      const config = this.getConfig();
      if (enabled && (!config?.baseUrl || !config?.adminApiKey)) throw new Error("请先配置 Sub2API 后端地址和管理员 API Key");
      const entry = this.accounts.get(email);
      await this.update(email, { enabled, ...(!enabled && entry?.resumeAccountIds?.length ? { phase: "resuming" } : {}), lastError: null });
    });
    this.trigger();
    return this.snapshot(email);
  }

  // Unlike a normal disable, a permanent block must never resume the pool row.
  async blockAccount(email) {
    email = email.toLowerCase();
    await this.lock(email, () => this.update(email, { enabled: false, phase: "idle", resumeAccountIds: [], coolingUntil: null, lastError: null }));
  }

  // A manual pool switch takes ownership away from the automatic cooldown.
  async manualOverride(email, accountIds, action, { enabled } = {}) {
    email = email.toLowerCase();
    return this.lock(email, async () => {
      const entry = this.accounts.get(email);
      if (typeof enabled === "boolean") {
        const backend = this.backendIdentity(this.getConfig());
        const manualScheduling = structuredClone(entry?.manualScheduling || {});
        manualScheduling[backend] = { ...manualScheduling[backend], ...Object.fromEntries(accountIds.map(id => [String(id), enabled])) };
        await this.update(email, { enabled: entry?.enabled === true, manualScheduling });
      }
      if (entry && (!entry.resumeAccountIds?.length || entry.backend === this.backendIdentity(this.getConfig()))) {
        const removed = new Set(accountIds.map(String));
        const remaining = (entry.resumeAccountIds || []).filter(id => !removed.has(id));
        await this.update(email, { resumeAccountIds: remaining, ...(remaining.length ? {} : { phase: "idle", coolingUntil: null }), lastResumedAt: new Date(this.now()).toISOString(), lastError: null });
      }
      return action();
    });
  }

  async remove(email) {
    await this.lock(email.toLowerCase(), async () => {
      await this.update(email.toLowerCase(), null);
    });
  }

  start() { this.stopped = false; this.trigger(); }
  trigger() {
    if (this.stopped) return;
    this.rerun = true;
    void this.refresh().catch(error => console.warn(`[warn] 自动冷却检查失败：${error.message}`));
  }
  refresh() {
    if (this.running) return this.running;
    this.clearTimer(this.timer);
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.stopped) return;
      if (this.rerun) { this.trigger(); return; }
      const due = [...this.accounts.values()].filter(entry => entry.resumeAccountIds?.length && entry.phase !== "resuming").map(entry => Date.parse(entry.coolingUntil)).filter(time => Number.isFinite(time) && time > this.now());
      const delay = Math.max(100, Math.min(this.getMonitoringSettings().intervalMs, ...due.map(time => time - this.now())));
      this.timer = this.setTimer(() => this.trigger(), delay);
      this.timer.unref?.();
    });
    return this.running;
  }

  async run() {
    this.rerun = false;
    const config = this.getConfig();
    if (this.stopped || !config?.baseUrl || !config?.adminApiKey) return;
    const active = [...this.accounts].filter(([email, entry]) => !this.isBlocked(email) && (entry.enabled || entry.resumeAccountIds?.length));
    if (!active.length) return;
    let mapping;
    try { mapping = await this.listAccounts(config); }
    catch (error) {
      for (const [email] of active) await this.lock(email, () => this.update(email, { lastError: String(error.message).slice(0, 300) }));
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < active.length && !this.stopped) {
        const [email] = active[cursor++];
        await this.lock(email, async () => {
          try { await this.checkAccount(email, config, mapping.get(email) || []); }
          catch (error) { await this.update(email, { lastError: String(error.message).slice(0, 300) }); }
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(active.length, this.getMonitoringSettings().concurrency) }, worker));
  }

  async checkAccount(email, config, records) {
    let entry = this.accounts.get(email);
    if (!entry || this.stopped || this.isBlocked(email)) return;
    const backend = this.backendIdentity(config);
    if (this.backendIdentity(this.getConfig()) !== backend) return;
    if (entry.resumeAccountIds?.length) {
      if (entry.backend !== backend) throw new Error("Sub2API 后端已变化，原冷却记录待恢复原后端后处理");
      if (!entry.enabled || entry.phase === "resuming" || Date.parse(entry.coolingUntil) <= this.now()) {
        await this.resume(email, config, records);
      } else {
        // Reassert the pause if an unrelated credential repair enabled the pool row.
        await this.pause(email, config, records);
      }
      return;
    }
    if (!entry.enabled) return;
    const settings = this.getSettings();
    const end = this.now();
    const start = Math.max(end - settings.windowMinutes * 60_000, Date.parse(entry.lastResumedAt || "") || 0);
    if (start >= end) return;
    const valid = () => !this.stopped && !this.isBlocked(email) && this.accounts.get(email)?.enabled && this.backendIdentity(this.getConfig()) === backend;
    const count = await collectOverloadWindow({ start, end, accountIds: records.map(record => record.id), config, request: this.request, isEnabled: valid });
    if (count === null || !valid()) return;
    entry = await this.update(email, { windowCount: count, lastCheckedAt: new Date(end).toISOString(), lastError: null });
    if (count < settings.threshold) return;
    const targets = records.filter(record => record.enabled === true).map(record => String(record.id));
    if (!targets.length) return;
    // Save the full pause intent before the first remote write, so interrupted
    // requests remain recoverable even if their response was never received.
    await this.update(email, { backend, phase: "pausing", resumeAccountIds: targets, coolingUntil: new Date(end + settings.cooldownMinutes * 60_000).toISOString() });
    await this.pause(email, config, records);
  }

  async pause(email, config, records) {
    const entry = this.accounts.get(email);
    for (const id of entry.resumeAccountIds || []) {
      if (this.stopped || this.isBlocked(email) || this.backendIdentity(this.getConfig()) !== entry.backend) return;
      const record = records.find(record => String(record.id) === id);
      if (!record || record.enabled === false) continue;
      await this.setSchedulable(config, id, false);
    }
    await this.update(email, { phase: "cooling", lastError: null });
  }

  async resume(email, config, records) {
    let entry = await this.update(email, { phase: "resuming" });
    for (const id of [...entry.resumeAccountIds]) {
      if (this.stopped || this.isBlocked(email) || this.backendIdentity(this.getConfig()) !== entry.backend) return;
      const record = records.find(record => String(record.id) === id);
      if (record && record.enabled !== true) await this.setSchedulable(config, id, true);
      const remaining = entry.resumeAccountIds.filter(item => item !== id);
      entry = await this.update(email, { resumeAccountIds: remaining, ...(remaining.length ? {} : { phase: "idle", coolingUntil: null, lastResumedAt: new Date(this.now()).toISOString(), windowCount: 0, lastError: null }) });
    }
    await this.update(email, { phase: "idle", coolingUntil: null, lastResumedAt: new Date(this.now()).toISOString(), windowCount: 0, lastError: null });
  }

  async setSchedulable(config, id, enabled) {
    await this.request(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}/schedulable`, { method: "POST", body: JSON.stringify({ schedulable: enabled }) });
    this.onChange();
  }

  async stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
    await this.running?.catch(() => {});
    await Promise.allSettled([...this.locks.values()]);
    await this.writePromise.catch(() => {});
  }
}
