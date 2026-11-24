import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const FIVE_MINUTES = 300_000;
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
      index[ip] = Object.hasOwn(index, ip) ? { ambiguous: true } : { order, name };
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
const empty = key => ({ key, checked: {}, orders: {}, slots: {}, inventoryAt: 0 });

export function createIproyalPatrol({ root, source, target, canRun, list, rename, now = Date.now }) {
  const cacheFile = path.join(root, 'iproyal-cache.json');
  const settingsFile = path.join(root, 'iproyal-settings.json');
  let enabled = false, closed = false, work, timer, settingsQueue = Promise.resolve();
  let cache = empty(''), message = '', lastRun = 0;
  const valid = key => enabled && !closed && canRun() && target()?.key === key;
  const status = () => ({ enabled, running: Boolean(work), message, lastRun, intervalMinutes: 5 });
  async function inspect() {
    const context = target();
    if (!context) throw fault(409, '请先保存 Sub2API 后端配置');
    const { key } = context;
    const api = await source();
    const nodes = await list(context);
    if (!valid(key)) return;
    const state = cache.key === key ? structuredClone(cache) : empty(key);
    const ips = [...new Set(nodes.map(addressOf).filter(Boolean))];
    let failures = 0;
    let firstError = '';
    const recordFailure = e => { failures++; firstError ||= safeMessage(e); };
    let inventoryFailed = false;
    const needsInventory = state.source !== api.identity || !state.inventoryAt ||
      now() - state.inventoryAt >= DAY || ips.some(ip => !Object.hasOwn(state.checked, ip));
    if (needsInventory) {
      try {
        const idx = indexInventory(await api.inventory(), state.slots);
        state.checked = Object.fromEntries(ips.map(ip => [ip, idx[ip] ?? null]));
        if (state.source !== api.identity) state.orders = {};
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
    for (const order of orders) {
      if (!valid(key)) return;
      try { state.orders[order] = { ...await api.bandwidth(order), at: now(), stale: false }; }
      catch (e) {
        state.orders[order] = { ...state.orders[order], stale: true };
        recordFailure(e);
      }
    }
    if (!valid(key)) return;
    // Commit the mapping before names are changed, so a restart reuses slots.
    await save(cacheFile, state);
    cache = state;
    for (const node of nodes) {
      if (!valid(key)) return;
      const link = state.checked[addressOf(node)];
      if (inventoryFailed || !link?.order || state.orders[link.order]?.stale || node.name === link.name) continue;
      try { await rename(context, node, link.name); }
      catch { recordFailure(fault(502, '部分节点改名待重试')); }
    }
    lastRun = now();
    message = failures ? `${failures} 项待重试 · ${firstError}` : `已查验 ${ips.length} 个 IP，${orders.size} 笔匹配订单`;
  }
  function run() {
    if (!enabled || closed || !canRun()) return Promise.resolve();
    if (!work) work = inspect().catch(e => { lastRun = now(); message = safeMessage(e); }).finally(() => { work = null; });
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
      enabled = (await readState(settingsFile, {})).enabled === true;
      cache = await readState(cacheFile, empty(''));
    },
    start() { timer = setInterval(run, FIVE_MINUTES); timer.unref(); void run(); },
    async stop() { closed = true; clearInterval(timer); await Promise.allSettled([work, settingsQueue]); },
    configure(value) {
      if (typeof value !== 'boolean') throw fault(400, '巡检开关需要布尔值');
      const next = settingsQueue.then(async () => {
        if (value && !target()) throw fault(409, '请先保存 Sub2API 后端配置');
        if (value) await source();
        await save(settingsFile, { enabled: value });
        enabled = value;
        if (enabled) void run(); else await work;
        return status();
      });
      settingsQueue = next.catch(() => {});
      return next;
    },
    lookup(key, ip) {
      if (!enabled || cache.key !== key || !Object.hasOwn(cache.checked, ip)) return null;
      const link = cache.checked[ip];
      if (!link || link.ambiguous) return { status: link ? 'ambiguous' : 'unmatched' };
      const usage = cache.orders[link.order];
      return { status: 'matched', order: link.order, ...usage, stale: !usage?.at || usage.stale || now() - usage.at > 2 * FIVE_MINUTES };
    },
  };
}
