import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POOL_SYNC_CONCURRENCY, limitPoolRequests } from "./pool-network.mjs";
import { overloadGrid, DEFAULT_COUNT_WINDOW_MINUTES } from "../web/src/overload-grid.mjs";

export const OVERLOAD_MESSAGE = "Our servers are currently overloaded. Please try again later.";
export const OVERLOAD_INTERVAL_MS = 15 * 60_000;
export const COUNT_SYNC_INTERVAL_MS = 60_000;
export const COUNT_BUCKET_MS = DEFAULT_COUNT_WINDOW_MINUTES * 60_000;
export const COUNT_POINT_COUNT = overloadGrid().pointCount;
const RECONCILE_MS = 60 * 60_000;

// Six completed, half-open quarters: at 03:15 the last point is [03:00, 03:15).
export function completedIntervals(now = Date.now()) {
  const end = Math.floor(now / OVERLOAD_INTERVAL_MS) * OVERLOAD_INTERVAL_MS;
  return Array.from({ length: 6 }, (_, index) => ({
    start: new Date(end - (6 - index) * OVERLOAD_INTERVAL_MS).toISOString(),
    end: new Date(end - (5 - index) * OVERLOAD_INTERVAL_MS).toISOString(), count: null,
  }));
}

// Stable labels follow the configured overload window, including its unfinished bin.
export function recentIntervals(now = Date.now(), windowMinutes = DEFAULT_COUNT_WINDOW_MINUTES, minimumPoints = 0) {
  const { bucketMs, pointCount: historyPoints } = overloadGrid(windowMinutes);
  const pointCount = Math.max(historyPoints, minimumPoints);
  const end = (Math.floor(now / bucketMs) + 1) * bucketMs;
  return Array.from({ length: pointCount }, (_, index) => ({
    start: new Date(end - (pointCount - index) * bucketMs).toISOString(),
    end: new Date(end - (pointCount - index - 1) * bucketMs).toISOString(),
    count: null,
  }));
}

function containsOverload(value) {
  if (typeof value === "string") return value.includes(OVERLOAD_MESSAGE);
  return false;
}

function isOverload(row) {
  return Number(row.upstream_status_code ?? row.status_code) === 503
    && [row.message, row.upstream_error_message, row.upstream_error_detail, row.error_body].some(containsOverload);
}

// The split upstream list includes recovered failures, so successful failovers still count.
// The legacy endpoint is used only when the split endpoint does not exist.
export async function collectOverloadIntervals(options) {
  return collectOverloadCounts({ ...options, points: options.points ?? recentIntervals(options.now, options.windowMinutes), queryEnd: options.now ?? Date.now() });
}

export async function collectOverloadWindow({ start, end, ...options }) {
  const points = await collectOverloadCounts({ ...options, points: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString() }] });
  return points?.[0].count ?? null;
}

async function collectOverloadCounts({ config, accountIds, request, points, queryEnd, includeEvents = false, isEnabled = () => true }) {
  const start = Date.parse(points[0].start);
  const end = Math.min(Date.parse(points.at(-1).end), queryEnd ?? Infinity);
  const bucketMs = Date.parse(points[0].end) - start;
  const counts = Array(points.length).fill(0);
  const events = includeEvents ? points.map(() => []) : null;
  const seen = new Set();
  for (const accountId of new Set(accountIds.map(String))) {
    let endpoint = "/api/v1/admin/ops/upstream-errors";
    let expectedTotal = null;
    let received = 0;
    for (let page = 1; ; page += 1) {
      if (!isEnabled()) return null;
      if (page > 1000) throw new Error("运维日志分页超过上限，统计未完成");
      const query = new URLSearchParams({
        page: String(page), page_size: "500", platform: "openai", account_id: accountId,
        start_time: points[0].start, end_time: new Date(end).toISOString(),
        status_codes: "503", view: "all", sort_by: "created_at", sort_order: "asc",
      });
      let payload;
      try {
        payload = await request(config, `${endpoint}?${query}`);
      } catch (error) {
        if (page !== 1 || error.remoteStatus !== 404 || endpoint.endsWith("/errors")) throw error;
        endpoint = "/api/v1/admin/ops/errors";
        payload = await request(config, `${endpoint}?${query}`);
      }
      const data = payload?.data ?? payload;
      if (!data || !Array.isArray(data.items)) throw new Error("运维日志响应格式无效");
      const total = Number(data.total);
      if (data.total === null || data.total === "" || !Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
        throw new Error("运维日志列表发生变化或总数无效，请重试");
      }
      expectedTotal = total;
      received += data.items.length;
      for (const item of data.items) {
        if (!isEnabled()) return null;
        if (String(item.account_id) !== accountId) continue;
        const timestamp = Date.parse(item.created_at);
        if (!Number.isFinite(timestamp)) throw new Error("运维日志缺少有效时间");
        if (timestamp < start || timestamp >= end) continue;
        if (item.id === undefined || item.id === null) throw new Error("运维日志缺少记录 ID");
        const key = String(item.id);
        if (seen.has(key)) continue;
        seen.add(key);
        let row = item;
        if (!isOverload(row) && Number(row.upstream_status_code ?? row.status_code) === 503) {
          // List rows omit the upstream body; inspect it before deciding whether to count.
          if (!isEnabled()) return null;
          const detail = await request(config, `${endpoint}/${encodeURIComponent(item.id)}`);
          row = detail?.data ?? detail;
          if (!row || String(row.id) !== String(item.id) || String(row.account_id) !== accountId) {
            throw new Error("运维日志详情与账号不匹配");
          }
        }
        if (isOverload(row)) {
          const index = Math.floor((timestamp - start) / bucketMs);
          counts[index] += 1;
          events?.[index].push(timestamp);
        }
      }
      if (received >= total) break;
      if (!data.items.length) throw new Error("运维日志分页不完整");
    }
  }
  return points.map((point, index) => ({ ...point, count: counts[index], ...(events ? { overloadEvents: events[index] } : {}) }));
}

// Count request-level success + failure records, not upstream retry/error attempts.
// Bin timestamps locally so an inclusive upstream end_time never leaks the next interval.
export async function collectRequestIntervals({ config, accountIds, request, now = Date.now(), windowMinutes = DEFAULT_COUNT_WINDOW_MINUTES, points = recentIntervals(now, windowMinutes), isEnabled = () => true }) {
  const start = Date.parse(points[0].start);
  const end = Math.min(Date.parse(points.at(-1).end), now);
  const bucketMs = Date.parse(points[0].end) - start;
  const counts = Array(points.length).fill(0);
  const seen = new Set();
  for (const accountId of new Set(accountIds.map(String))) {
    let expectedTotal = null;
    let received = 0;
    for (let page = 1; ; page += 1) {
      if (!isEnabled()) return null;
      if (page > 1000) throw new Error("请求日志分页超过上限，统计未完成");
      const query = new URLSearchParams({
        page: String(page), page_size: "100", platform: "openai", account_id: accountId,
        start_time: points[0].start, end_time: new Date(end).toISOString(),
        kind: "all", sort: "created_at_desc",
      });
      const payload = await request(config, `/api/v1/admin/ops/requests?${query}`);
      const data = payload?.data ?? payload;
      if (!data || !Array.isArray(data.items)) throw new Error("请求日志响应格式无效");
      const total = Number(data.total);
      if (data.total === null || data.total === "" || !Number.isSafeInteger(total) || total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
        throw new Error("请求日志列表发生变化或总数无效，请重试");
      }
      expectedTotal = total;
      received += data.items.length;
      for (const item of data.items) {
        if (String(item.account_id) !== accountId) continue;
        const timestamp = Date.parse(item.created_at);
        if (!Number.isFinite(timestamp)) throw new Error("请求日志缺少有效时间");
        if (timestamp < start || timestamp >= end) continue;
        if (!["success", "error"].includes(item.kind)) throw new Error("请求日志类型无效");
        const identity = item.request_id || (item.error_id ? `error:${item.error_id}` : null);
        if (identity) {
          const key = `${accountId}:${identity}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        counts[Math.floor((timestamp - start) / bucketMs)] += 1;
      }
      if (received >= total) break;
      if (!data.items.length) throw new Error("请求日志分页不完整");
    }
  }
  return points.map((point, index) => ({ ...point, requestCount: counts[index] }));
}

const knownCount = value => Number.isSafeInteger(value) && value >= 0;
function validPoints(points, windowMinutes, minimumPoints = 0) {
  const grid = windowMinutes === undefined ? null : overloadGrid(windowMinutes);
  return (Array.isArray(points) ? points : []).filter(point => {
    if (!point) return false;
    const start = Date.parse(point.start), duration = Date.parse(point.end) - start;
    return Number.isInteger(duration / 60_000) && duration >= 60_000 && duration <= 1440 * 60_000
      && start % duration === 0 && (!grid || duration === grid.bucketMs);
  }).slice(-Math.max(grid?.pointCount ?? 90, minimumPoints));
}

function refreshPlan(entry, metric, scope, now, windowMinutes) {
  const { bucketMs } = overloadGrid(windowMinutes);
  const field = metric === "overload" ? "count" : "requestCount";
  const saved = validPoints(metric === "overload" ? entry.points : entry.requestPoints, windowMinutes, 2);
  const previous = new Map(saved.map(point => [point.start, point]));
  const grid = recentIntervals(now, windowMinutes, 2);
  const full = entry[`${metric}Scope`] !== scope || !entry[`${metric}ReconciledAt`]
    || now - Date.parse(entry[`${metric}ReconciledAt`]) >= RECONCILE_MS
    || Date.parse(entry[`${metric}UpdatedAt`]) > now;
  const currentStart = Date.parse(grid.at(-1).start);
  const sampledAt = Date.parse(entry[`${metric}UpdatedAt`]);
  const first = full ? 0 : grid.findIndex(point => !knownCount(previous.get(point.start)?.[field])
    // Close the last partially sampled bucket even after a long pause.
    || !Number.isFinite(sampledAt) || Date.parse(point.end) > sampledAt
    || Date.parse(point.start) >= currentStart - bucketMs);
  return { grid, points: grid.slice(Math.max(0, first)), previous, full, bucketMs };
}

function mergeCounts(plan, fresh) {
  const fetched = new Map(fresh.map(point => [point.start, point]));
  return plan.grid.map(point => {
    const value = fetched.get(point.start) || plan.previous.get(point.start) || point;
    const { overloadEvents, ...summary } = value;
    return summary;
  });
}

export class OverloadMonitor {
  constructor({ filePath, getConfig, backendIdentity, listAccounts, request, isBlocked = () => false, concurrency = DEFAULT_POOL_SYNC_CONCURRENCY, getMonitoringSettings = () => ({ concurrency, intervalMs: COUNT_SYNC_INTERVAL_MS }), getWindowMinutes = () => DEFAULT_COUNT_WINDOW_MINUTES, getAdditionalTargets = () => [], onOverloadCounts = async () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { filePath, getConfig, backendIdentity, listAccounts, request, isBlocked, concurrency, getMonitoringSettings, getWindowMinutes, getAdditionalTargets, onOverloadCounts, now, setTimer, clearTimer });
    this.request = limitPoolRequests((config, url, { isEnabled, ...options } = {}) => {
      if (isEnabled && !isEnabled()) throw new Error("过载统计已停止");
      return request(config, url, options);
    }, () => this.getMonitoringSettings().concurrency);
    this.backend = null;
    this.accounts = new Map();
    this.writePromise = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.stopped = false;
    this.rerun = false;
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (![1, 2].includes(data.version) || !data.accounts || typeof data.accounts !== "object") throw new Error("过载检测配置格式无效");
      this.backend = data.backend || null;
      for (const [email, entry] of Object.entries(data.accounts)) {
        if (entry && typeof entry.enabled === "boolean") this.accounts.set(email, {
          enabled: entry.enabled, points: validPoints(entry.points), requestPoints: validPoints(entry.requestPoints ?? entry.points),
          revision: Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0,
          updatedAt: entry.updatedAt || null, lastError: entry.lastError || null, requestError: entry.requestError || null,
          ...Object.fromEntries(["overload", "request"].flatMap(metric => ["UpdatedAt", "ReconciledAt", "Scope"].map(suffix => [`${metric}${suffix}`, entry[`${metric}${suffix}`] || null]))),
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") console.warn(`[warn] 过载检测配置读取失败：${error.message}`);
    }
  }

  syncBackend() {
    const config = this.getConfig();
    const backend = config?.baseUrl && config?.adminApiKey ? this.backendIdentity(config) : null;
    if (backend !== this.backend) {
      this.backend = backend;
      for (const [email, entry] of this.accounts) this.accounts.set(email, { enabled: entry.enabled, revision: entry.revision, points: [], requestPoints: [], updatedAt: null, lastError: null, requestError: null });
    }
    return backend;
  }

  snapshot(email) {
    const configured = Boolean(this.syncBackend());
    const entry = this.accounts.get(email.toLowerCase());
    const grid = overloadGrid(this.getWindowMinutes());
    const stored = new Map(validPoints(entry?.points, grid.bucketMinutes).map(point => [point.start, point]));
    const requests = new Map(validPoints(entry?.requestPoints, grid.bucketMinutes).map(point => [point.start, point]));
    const at = Date.parse(entry?.updatedAt);
    const points = recentIntervals(Number.isFinite(at) ? at : this.now(), grid.bucketMinutes);
    return {
      configured, enabled: entry?.enabled === true, revision: entry?.revision || 0, updatedAt: entry?.updatedAt || null,
      lastError: entry?.lastError || null, requestError: entry?.requestError || null,
      bucketMinutes: grid.bucketMinutes, pointCount: grid.pointCount, historyMinutes: grid.historyMinutes, windowMinutes: grid.bucketMinutes,
      overloadUpdatedAt: entry?.overloadUpdatedAt || null, requestUpdatedAt: entry?.requestUpdatedAt || null,
      countMode: "fixed_bucket", recentCount: stored.get(points.at(-1)?.start)?.count ?? null,
      points: points.map(point => ({ ...point, count: stored.get(point.start)?.count ?? null,
        requestCount: requests.get(point.start)?.requestCount ?? null,
        requestStart: point.start, requestEnd: point.end,
      })),
    };
  }

  persist() {
    const data = JSON.stringify({ version: 2, backend: this.backend, accounts: Object.fromEntries(this.accounts) }, null, 2);
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, `${data}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
    });
    this.writePromise = operation;
    return operation;
  }

  async setEnabled(email, enabled) {
    this.syncBackend();
    if (enabled && !this.backend) throw new Error("请先配置 Sub2API 后端地址和管理员 API Key");
    email = email.toLowerCase();
    const previous = this.accounts.get(email);
    const entry = { ...previous, enabled, revision: (previous?.revision || 0) + 1, points: previous?.points || [], lastError: null, requestError: null };
    this.accounts.set(email, entry);
    try { await this.persist(); }
    catch (error) {
      if (this.accounts.get(email) === entry) {
        if (previous) this.accounts.set(email, previous);
        else this.accounts.delete(email);
      }
      throw error;
    }
    return this.snapshot(email);
  }

  async remove(email) {
    this.accounts.delete(email.toLowerCase());
    await this.persist();
  }

  start() {
    this.stopped = false;
    this.trigger();
  }

  trigger() {
    if (this.stopped) return;
    this.rerun = true;
    void this.refresh().catch((error) => console.warn(`[warn] 过载检测统计失败：${error.message}`));
  }

  refresh() {
    if (this.running) return this.running;
    this.clearTimer(this.timer);
    const intervalMs = this.getMonitoringSettings().intervalMs;
    const startedInterval = Math.floor(this.now() / intervalMs);
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.stopped) return;
      if (Math.floor(this.now() / intervalMs) !== startedInterval) this.rerun = true;
      if (this.rerun) { this.trigger(); return; }
      const nextInterval = intervalMs - (this.now() % intervalMs);
      const failed = [...this.accounts.values()].some((entry) => entry.enabled && (entry.lastError || entry.requestError));
      this.timer = this.setTimer(() => this.trigger(), failed ? Math.min(60_000, nextInterval) : nextInterval);
      this.timer.unref?.();
    });
    return this.running;
  }

  async run() {
    this.rerun = false;
    if (!this.syncBackend() || this.stopped) return;
    const backend = this.backend;
    const config = this.getConfig();
    const now = this.now();
    const windowMinutes = overloadGrid(this.getWindowMinutes()).bucketMinutes;
    const additional = new Set(this.getAdditionalTargets());
    for (const email of additional) if (!this.accounts.has(email)) this.accounts.set(email, { enabled: false, revision: 0, points: [], requestPoints: [] });
    const entries = [...this.accounts].filter(([email, entry]) => (entry.enabled || additional.has(email)) && !this.isBlocked(email));
    if (!entries.length) return;
    let mapping;
    try { mapping = await this.listAccounts(config); }
    catch (error) {
      if (this.stopped || this.backendIdentity(this.getConfig()) !== backend) return;
      for (const [email, entry] of entries) if (this.accounts.get(email) === entry) this.accounts.set(email, { ...entry, lastError: error.message, requestError: error.message });
      await this.persist();
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const [email, entry] = entries[cursor++];
        const isEnabled = () => !this.stopped && !this.isBlocked(email) && this.accounts.get(email) === entry
          && (entry.enabled || this.getAdditionalTargets().includes(email))
          && overloadGrid(this.getWindowMinutes()).bucketMinutes === windowMinutes
          && this.getConfig() && this.backendIdentity(this.getConfig()) === backend;
        if (!isEnabled()) continue;
        try {
          const accountIds = mapping.get(email) || [];
          if (!accountIds.length) throw new Error("该账号尚未加入 Sub2API 号池");
          const options = { config, accountIds, request: (config, url) => this.request(config, url, { isEnabled }), now, isEnabled };
          const scope = JSON.stringify({ accountIds: [...new Set(accountIds.map(String))].sort(), windowMinutes });
          const overloadPlan = refreshPlan(entry, "overload", scope, now, windowMinutes), requestPlan = refreshPlan(entry, "request", scope, now, windowMinutes);
          const [overloads, requests] = await Promise.allSettled([
            collectOverloadIntervals({ ...options, points: overloadPlan.points }),
            entry.enabled ? collectRequestIntervals({ ...options, points: requestPlan.points }) : Promise.resolve(null),
          ]);
          if (!isEnabled()) continue;
          this.accounts.set(email, { ...entry,
            points: overloads.status === "fulfilled" && overloads.value ? mergeCounts(overloadPlan, overloads.value) : entry.points || [],
            requestPoints: requests.status === "fulfilled" && requests.value ? mergeCounts(requestPlan, requests.value) : entry.requestPoints || [],
            ...(overloads.status === "fulfilled" && overloads.value ? { overloadScope: scope, overloadUpdatedAt: new Date(now).toISOString(), overloadReconciledAt: overloadPlan.full ? new Date(now).toISOString() : entry.overloadReconciledAt } : {}),
            ...(requests.status === "fulfilled" && requests.value ? { requestScope: scope, requestUpdatedAt: new Date(now).toISOString(), requestReconciledAt: requestPlan.full ? new Date(now).toISOString() : entry.requestReconciledAt } : {}),
            updatedAt: overloads.status === "fulfilled" || requests.status === "fulfilled" ? new Date(now).toISOString() : entry.updatedAt || null,
            lastError: overloads.status === "rejected" ? String(overloads.reason?.message || overloads.reason).slice(0, 500) : null,
            requestError: requests.status === "rejected" ? String(requests.reason?.message || requests.reason).slice(0, 500) : null,
          });
          if (overloads.status === "fulfilled" && overloads.value) {
            await this.onOverloadCounts(email, { config, accountIds, point: overloads.value.at(-1), sampledAt: now, windowMinutes });
          }
        } catch (error) {
          if (isEnabled()) this.accounts.set(email, { ...entry, lastError: String(error.message).slice(0, 500), requestError: String(error.message).slice(0, 500) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.getMonitoringSettings().concurrency, entries.length) }, worker));
    if (this.backendIdentity(this.getConfig()) === backend) await this.persist();
  }

  async stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
    await this.running?.catch(() => {});
    await this.writePromise.catch(() => {});
  }
}
