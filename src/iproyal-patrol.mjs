import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { IPROYAL_DEFAULTS, iproyalSettings } from '../shared/iproyal-settings.mjs';
import { observeIpUsage, usagePolicy, usageWindow } from './iproyal-ip-usage.mjs';

const DAY = 86_400_000;
const fault = (status, message) => Object.assign(new Error(message), { status, patrolMessage: message });
const safeMessage = e => e?.patrolMessage || '巡检失败，请检查网络、凭据文件和号池连接';
export const addressOf = row => {
  const address = String(row.ip_address || row.ipAddress || row.exit_ip || row.ip || row.host || '').trim().toLowerCase();
  return isIP(address) ? address : '';
};

export async function dashboardSource(file, fetchImpl = fetch) {
  if (!file) throw fault(409, '请配置 IPROYAL_CREDENTIALS_FILE');
  let secret;
  try { secret = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw fault(409, 'IPRoyal 凭据文件不可读或 JSON 格式错误'); }
  if (typeof secret?.bearer !== 'string' || !secret.bearer.trim() || /\s/.test(secret.bearer)
      || (secret.cookie != null && (typeof secret.cookie !== 'string' || /[\r\n]/.test(secret.cookie)))) {
    throw fault(409, '请检查凭据文件中的 bearer 和 cookie 格式');
  }
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + secret.bearer };
  if (secret.cookie) headers.Cookie = secret.cookie;
  async function get(route) {
    const res = await fetchImpl('https://apid.iproyal.com/v1/orders/' + route, {
      headers, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      const message = [401, 403].includes(res.status) ? '请核对或更新后台凭据' : '本轮稍后重试';
      throw fault(502, `IPRoyal HTTP ${res.status}，${message}`);
    }
    return res.json();
  }
  return {
    identity: createHash('sha256').update(headers.Authorization).digest('hex'),
    async inventory() {
      const rows = [];
      const seenIds = new Set();
      let total;
      let pages;
      for (let page = 1; page <= 1000; page++) {
        const { data, meta } = await get(`proxies?product_id=14&page=${page}&per_page=20&sort_order=desc`);
        if (!Array.isArray(data) || !Number.isSafeInteger(meta?.total) || meta.total < 0 ||
            !Number.isSafeInteger(meta.last_page) || meta.last_page < 1 || meta.current_page !== page ||
            (page > 1 && (meta.total !== total || meta.last_page !== pages))) break;
        total = meta.total;
        pages = meta.last_page;
        for (const row of data) {
          if (!isIP(row.ip) || !Number.isSafeInteger(Number(row.order_id)) || Number(row.order_id) <= 0 ||
              row.id == null || seenIds.has(row.id)) throw fault(502, 'IPRoyal 库存记录无效或重复');
          seenIds.add(row.id);
          rows.push({ ip: row.ip.toLowerCase(), order: String(row.order_id) });
        }
        if (page === pages && rows.length === total) return rows;
        if (page >= pages || !data.length) break;
      }
      throw fault(502, 'IPRoyal 库存分页不完整，本轮保留已有归属');
    },
    async bandwidth(order) {
      if (!/^[1-9]\d*$/.test(order)) throw fault(400, '订单号无效');
      const v = await get(order + '/bandwidth');
      const fields = ['gb_limit', 'gb_used', 'gb_balance'];
      if (!fields.every(k => Number.isFinite(v?.[k]) && v[k] >= 0)) throw fault(502, 'IPRoyal 流量响应缺少有效数值');
      return Object.fromEntries(fields.map(k => [k, v[k]]));
    },
    async ipUsage(order, ip, window) {
      if (!/^[1-9]\d*$/.test(order) || !isIP(ip)) throw fault(400, '订单号或 IP 无效');
      const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
      if (!validDate(window?.from) || !validDate(window?.to) || window.from > window.to || Date.parse(window.to) - Date.parse(window.from) !== 6 * DAY) throw fault(400, '用量查询周期无效');
      const query = new URLSearchParams({ date_from: window.from, date_to: window.to, time_zone: 'Asia/Shanghai',
        measurement_unit: 'MB', rounding_decimal: '2', 'ip_addresses[]': ip });
      const result = await get(order + '/data-usage?' + query);
      const days = {};
      for (let at = Date.parse(window.from); at <= Date.parse(window.to); at += DAY) {
        const day = new Date(at).toISOString().slice(0, 10), amount = result?.data?.[day];
        if (!Number.isFinite(amount) || amount < 0) throw fault(502, 'IPRoyal 单 IP 用量响应不完整');
        days[day] = amount;
      }
      // remaining is shared order balance, never an individual IP counter.
      return { ...window, days };
    },
    async orderDetails(order) {
      if (!/^[1-9]\d*$/.test(order)) throw fault(400, '订单号无效');
      const v = await get(order);
      if (String(v?.id) !== order) throw fault(502, 'IPRoyal 订单详情编号不匹配');
      const quantity = v?.order_product?.quantity;
      const days = v?.order_product?.product_plan?.duration;
      const amount = v?.amount_with_vat ?? v?.amount;
      const validCost = Number.isInteger(quantity) && quantity > 0 && Number.isFinite(amount) &&
        amount >= 0 && Number.isInteger(days) && days > 0;
      const rawExpiry = v.order_product?.expire_date;
      const end = typeof rawExpiry === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(rawExpiry) ? Date.parse(rawExpiry) : NaN;
      return {
        cost: validCost ? { amountUsd: amount, quantity, days, usdPerIp: amount / quantity } : null,
        expiresAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
      };
    },
  };
}

// Allocate once from the complete supplier inventory. Pool membership and API
// display order must not change the existing suffixes.
export function indexInventory(rows, slots) {
  const orders = new Map();
  const index = {};
  for (const { ip, order } of rows) {
    if (!orders.has(order)) orders.set(order, new Set());
    orders.get(order).add(ip);
  }
  for (const [order, ips] of orders) {
    const assigned = slots[order] ??= {};
    let next = Object.values(assigned).reduce((max, n) => Math.max(max, n), 0) + 1;
    for (const ip of [...ips].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      assigned[ip] ??= next++;
      const name = ips.size === 1 ? order : order + '-' + assigned[ip];
      index[ip] = Object.hasOwn(index, ip) ? { ambiguous: true } : { order, name, ipCount: ips.size };
    }
  }
  return index;
}

async function readState(file, initial) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return initial; throw e; }
}
async function save(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
const empty = key => ({ key, checked: {}, orders: {}, slots: {}, inventoryAt: 0, nodeIps: {}, ipUsage: {} });

export function createIproyalPatrol({ root, source, target, canRun, list, rename, syncCost = async () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cacheFile = path.join(root, 'iproyal-cache.json');
  const settingsFile = path.join(root, 'iproyal-settings.json');
  let settings = { ...IPROYAL_DEFAULTS }, closed = false, started = false, generation = 0, work, timer, nextRunAt = null, settingsQueue = Promise.resolve();
  let cache = empty(''), message = '', lastRun = 0;
  const valid = (key, revision) => settings.enabled && !closed && canRun() && target()?.key === key && revision === generation;
  const status = () => ({ ...settings, running: Boolean(work), message, lastRun, nextRunAt });
  function schedule() {
    clearTimer(timer);
    nextRunAt = null;
    if (!started || closed || !settings.enabled) return;
    nextRunAt = now() + settings.intervalMinutes * 60000;
    timer = setTimer(() => { void run(); }, settings.intervalMinutes * 60000);
    timer.unref?.();
  }
  async function inspect() {
    const context = target();
    if (!context) throw fault(409, '请先保存 Sub2API 后端配置');
    const { key } = context;
    const revision = generation;
    const config = { ...settings };
    const api = await source();
    const nodes = await list(context);
    if (!valid(key, revision)) return;
    const state = cache.key === key ? structuredClone(cache) : empty(key);
    const ips = [...new Set(nodes.map(addressOf).filter(Boolean))];
    let failures = 0;
    let firstError = '';
    const recordFailure = e => { failures++; firstError ||= safeMessage(e); };
    let inventoryFailed = false;
    const needsInventory = state.source !== api.identity || !state.inventoryAt || !state.nodeIps ||
      Object.values(state.checked).some(v => v && !v.ambiguous && !v.ipCount) ||
      now() - state.inventoryAt >= DAY || ips.some(ip => !Object.hasOwn(state.checked, ip));
    if (needsInventory) {
      try {
        const idx = indexInventory(await api.inventory(), state.slots);
        state.checked = Object.fromEntries(ips.map(ip => [ip, idx[ip] ?? null]));
        if (state.source !== api.identity) { state.orders = {}; state.ipUsage = {}; }
        state.source = api.identity;
        state.inventoryAt = now();
      } catch (e) {
        if (state.source !== api.identity) throw e;
        inventoryFailed = true;
        recordFailure(e);
      }
    }
    state.checked = Object.fromEntries(ips.filter(ip => Object.hasOwn(state.checked, ip)).map(ip => [ip, state.checked[ip]]));
    const orders = new Set(Object.values(state.checked).map(v => v?.order).filter(Boolean));
    state.orders = Object.fromEntries(Object.entries(state.orders).filter(([id]) => orders.has(id)));
    state.ipUsage = Object.fromEntries(Object.entries(state.ipUsage || {}).filter(([ip, item]) => item.order === state.checked[ip]?.order));
    for (const order of orders) {
      if (!valid(key, revision)) return;
      try { state.orders[order] = { ...state.orders[order], ...await api.bandwidth(order), at: now(), stale: false }; }
      catch (e) {
        state.orders[order] = { ...state.orders[order], stale: true };
        recordFailure(e);
      }
      if (api.orderDetails) {
        const usage = state.orders[order];
        try {
          const { cost, expiresAt } = await api.orderDetails(order);
          usage.costStale = !cost;
          if (cost) Object.assign(usage, { cost, costAt: now() });
          else recordFailure(fault(502, 'IPRoyal 订单价格或周期待刷新'));
          usage.expiryStale = !expiresAt;
          if (expiresAt) Object.assign(usage, { expiresAt, expiryObservedAt: now() });
        } catch (e) {
          usage.costStale = usage.expiryStale = true;
          recordFailure(e);
        }
      }
    }
    if (!inventoryFailed && api.ipUsage) {
      const pending = ips.filter(ip => state.checked[ip]?.order);
      const window = usageWindow(now());
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && valid(key, revision)) {
          const ip = pending.shift(), order = state.checked[ip].order;
          try {
            const sample = await api.ipUsage(order, ip, window);
            state.ipUsage[ip] = { ...observeIpUsage(state.ipUsage[ip], sample, config, now()), order };
          } catch (e) {
            state.ipUsage[ip] = { ...state.ipUsage[ip], order, stale: true };
            recordFailure(e);
          }
        }
      }));
    }
    if (!valid(key, revision)) return;
    state.nodeIps = Object.fromEntries(nodes.map(node => [node.id, addressOf(node)]));
    // Commit the mapping before names are changed, so a restart reuses slots.
    await save(cacheFile, state);
    cache = state;
    const costIps = new Set();
    for (const node of nodes) {
      if (!valid(key, revision)) return;
      const link = state.checked[addressOf(node)];
      if (inventoryFailed || !link?.order) continue;
      const usage = state.orders[link.order];
      if (config.syncCost && usage.cost && !usage.costStale && !costIps.has(addressOf(node))) {
        try {
          await syncCost(context, node, Math.round(usage.cost.usdPerIp * config.usdToCny * 100) / 100);
          costIps.add(addressOf(node));
        } catch { recordFailure(fault(502, '部分 IP 成本同步待重试')); }
      }
      if (!valid(key, revision)) return;
      if (!usage.stale && node.name !== link.name) {
        try { await rename(context, node, link.name); }
        catch { recordFailure(fault(502, '部分节点改名待重试')); }
      }
    }
    lastRun = now();
    message = failures ? `${failures} 项待重试 · ${firstError}` : `已查验 ${ips.length} 个 IP，${orders.size} 笔匹配订单`;
  }
  function run() {
    if (!settings.enabled || closed || !canRun()) { schedule(); return Promise.resolve(); }
    if (!work) work = inspect().catch(e => { lastRun = now(); message = safeMessage(e); }).finally(() => { work = null; schedule(); });
    return work;
  }
  return {
    status, run,
    async checkConnection() {
      try {
        const api = await source();
        const rows = await api.inventory();
        const orders = new Set(rows.map(row => row.order));
        if (rows.length) await api.bandwidth(rows[0].order);
        return { ipCount: new Set(rows.map(row => row.ip)).size, orderCount: orders.size, bandwidthChecked: Boolean(rows.length) };
      } catch (e) { throw fault(e?.status || 502, safeMessage(e)); }
    },
    async load() {
      settings = iproyalSettings(await readState(settingsFile, {}));
      cache = await readState(cacheFile, empty(''));
    },
    start() { if (started) return; started = true; void run(); },
    async stop() { closed = true; clearTimer(timer); await Promise.allSettled([work, settingsQueue]); },
    configure(value) {
      const next = settingsQueue.then(async () => {
        const changed = iproyalSettings(typeof value === 'boolean' ? { enabled: value } : value, settings);
        const resetUsage = changed.enabled !== settings.enabled || usagePolicy(changed) !== usagePolicy(settings);
        if (changed.enabled && !target()) throw fault(409, '请先保存 Sub2API 后端配置');
        if (changed.enabled) await source();
        await save(settingsFile, changed);
        settings = changed;
        generation++;
        schedule();
        await work;
        if (resetUsage) {
          const state = structuredClone(cache);
          for (const sample of Object.values(state.ipUsage || {})) { sample.policy = null; sample.cooldownUntil = 0; }
          await save(cacheFile, state);
          cache = state;
        }
        if (settings.enabled) void run();
        return status();
      });
      settingsQueue = next.catch(() => {});
      return next;
    },
    lookup(key, ip) {
      if (!settings.enabled || cache.key !== key || !Object.hasOwn(cache.checked, ip)) return null;
      const link = cache.checked[ip];
      if (!link || link.ambiguous) return { status: link ? 'ambiguous' : 'unmatched' };
      const usage = cache.orders[link.order];
      const thresholdGb = settings.thresholdGbPerIp * link.ipCount;
      const individual = cache.ipUsage?.[ip];
      const usageCooldownPaused = Boolean(settings.usageCooldownEnabled && individual?.policy === usagePolicy(settings) && individual.cooldownUntil > now());
      const balanceAllocationPaused = settings.autoPause && Number.isFinite(thresholdGb) && Number.isFinite(usage?.gb_balance) && usage.gb_balance <= thresholdGb;
      return { status: 'matched', order: link.order, ...usage, ipCount: link.ipCount, thresholdGb,
        ipUsage: individual?.at ? { deltaMb: individual.deltaMb, totalMb: individual.totalMb, from: individual.from, to: individual.to,
          at: individual.at, since: individual.since, baselineReason: individual.baselineReason,
          stale: individual.stale || now() - individual.at > 2 * settings.intervalMinutes * 60000,
          cooldownUntil: usageCooldownPaused ? individual.cooldownUntil : null, triggerMb: individual.triggerMb } : null,
        usageCooldownPaused, balanceAllocationPaused,
        expiryStale: !usage?.expiryObservedAt || usage.expiryStale || now() - usage.expiryObservedAt > 2 * settings.intervalMinutes * 60000,
        autoAllocationPaused: balanceAllocationPaused || usageCooldownPaused,
        costSyncEnabled: settings.syncCost,
        stale: !usage?.at || usage.stale || now() - usage.at > 2 * settings.intervalMinutes * 60000 };
    },
    isBlocked(key, id) {
      if (!settings.enabled || cache.key !== key) return false;
      return Boolean(this.lookup(key, cache.nodeIps?.[id])?.autoAllocationPaused);
    },
  };
}
