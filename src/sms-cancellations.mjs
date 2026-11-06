import fs from "node:fs/promises";
import crypto from "node:crypto";
import { writePrivateJsonAtomic } from "./account-history.mjs";

// Durable cancellation outbox: no API keys, phone numbers or SMS codes stored.
export class SmsCancellations {
  constructor({ filePath, getClient, onEvent = () => {}, retryMs = 30_000, now = Date.now }) {
    Object.assign(this, { filePath, getClient, onEvent, retryMs, now });
    this.records = new Map(); this.clients = new Map(); this.inflight = new Map();
    this.writes = Promise.resolve(); this.timer = null; this.stopped = false;
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.pending)) throw new Error("接码取消记录格式错误");
      for (const r of data.pending) {
        if (!r || typeof r.id !== "string" || !/^[a-f0-9]{64}$/.test(r.id) || !r.jobId || !r.providerId || typeof r.requestId !== "string") throw new Error("接码取消记录格式错误");
        this.records.set(r.id, r);
      }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  save() {
    const work = this.writes.catch(() => {}).then(() => writePrivateJsonAtomic(this.filePath, { version: 1, pending: [...this.records.values()] }));
    this.writes = work; return work;
  }
  count(jobId) { return [...this.records.values()].filter(r => r.jobId === jobId).length; }
  async cancel({ jobId, providerId, requestId }, client) {
    requestId = String(requestId);
    const id = crypto.createHash("sha256").update(`${jobId}\0${providerId}\0${requestId}`).digest("hex");
    if (client) this.clients.set(id, client);
    if (!this.records.has(id)) {
      this.records.set(id, { id, jobId, providerId, requestId, requestedAt: new Date(this.now()).toISOString(), nextAttemptAt: 0 });
    }
    // Also await persistence for a duplicate caller: the first caller may still
    // be writing this record when timeout/child-close cleanup races with it.
    await this.save();
    return this.attempt(id);
  }
  attempt(id) {
    if (this.inflight.has(id)) return this.inflight.get(id);
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    const operation = (async () => {
      try {
        const client = this.clients.get(id) || await this.getClient(record.providerId);
        if (!client) throw new Error("接码平台配置待恢复");
        try { await client.release(record.requestId); }
        catch (error) { if (!["NO_ACTIVATION", "STATUS_CANCEL"].includes(error?.code)) throw error; }
        this.records.delete(id);
        try { await this.save(); } catch (e) { this.records.set(id, record); throw e; }
        this.clients.delete(id); this.onEvent(record, true);
      } catch (error) {
        record.nextAttemptAt = this.now() + this.retryMs;
        await this.save(); this.onEvent(record, false);
        throw error;
      }
    })();
    this.inflight.set(id, operation);
    void operation.finally(() => this.inflight.delete(id)).catch(() => {});
    return operation;
  }
  async retry() {
    if (this.stopped) return;
    for (const r of this.records.values()) {
      if (this.stopped) break;
      if (r.nextAttemptAt <= this.now()) await this.attempt(r.id).catch(() => {});
    }
  }
  start() {
    this.stopped = false;
    this.timer = setInterval(() => { void this.retry(); }, this.retryMs); this.timer.unref?.();
    void this.retry();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([...this.inflight.values()]); await this.writes;
  }
}
