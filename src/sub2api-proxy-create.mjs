import crypto from 'node:crypto';
import { normalizeProxyInput } from '../web/src/proxy-input.mjs';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = proxy => digest([proxy.protocol || 'http', String(proxy.host || '').replace(/^\[|\]$/g, '').toLowerCase(), Number(proxy.port), proxy.username || '', proxy.password || '']);
const publicProxy = p => ({ id: p.id, name: p.name, protocol: p.protocol, host: p.host, port: p.port });
function error(status, message) { return Object.assign(new Error(message), { status }); }
export function createProxyImporter({ request, now = Date.now }) {
  const ledger = new Map(), locks = new Map();
  return async (config, body) => {
    if (!config?.baseUrl || !config.adminApiKey) throw error(409, '请先保存 Sub2API 后端和管理员 API Key');
    if (!Array.isArray(body?.proxies) || !body.proxies.length || body.proxies.length > 100) throw error(400, '请提供 1–100 条代理');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId || '')) throw error(400, '缺少有效的提交标识，请重新打开添加窗口');
    let proxies;
    try { proxies = body.proxies.map((p, i) => { try { return normalizeProxyInput(p, now()); } catch (e) { throw Error(`第 ${i + 1} 条：${e.message}`); } }); }
    catch (e) { throw error(400, e.message); }
    const backend = digest([config.baseUrl, config.adminApiKey]), key = backend + ':' + body.requestId, hash = digest(proxies);
    for (const [k, v] of ledger) if (now() - v.at > 24 * 3600_000 && !v.pending) ledger.delete(k);
    let entry = ledger.get(key);
    if (entry && entry.hash !== hash) throw error(409, '本次提交内容已变更，请使用新的提交标识');
    if (entry?.pending) return entry.pending;
    if (!entry) { if (ledger.size >= 1000) throw error(429, '代理导入请求过多，请稍后再试'); entry = { hash, at: now(), results: [] }; ledger.set(key, entry); }
    const previous = locks.get(backend) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      // /all returns active nodes only. Read every page to also dedupe disabled nodes.
      const list = [];
      for (let page = 1; ; page++) {
        const payload = await request(config, `/api/v1/admin/proxies?page=${page}&page_size=100`, { timeoutMs: 30_000 });
        const data = payload?.data ?? payload;
        if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw error(502, '号池代理列表格式异常，请检查后重试');
        list.push(...data.items);
        if (list.length >= data.total) break;
        if (!data.items.length || page >= 100) throw error(502, '号池代理列表不完整，已停止添加');
      }
      const existing = new Map(list.map(p => [identity(p), p]));
      for (const [index, proxy] of proxies.entries()) {
        if (['created', 'existing', 'unknown'].includes(entry.results[index]?.status)) continue;
        const found = existing.get(identity(proxy));
        if (found) { entry.results[index] = { index, status: 'existing', proxy: publicProxy(found), message: '相同代理已存在，已跳过' }; continue; }
        try {
          const response = await request(config, '/api/v1/admin/proxies', { method: 'POST', timeoutMs: 30_000, headers: { 'Idempotency-Key': digest([body.requestId, index, hash]) }, body: JSON.stringify(proxy) });
          const saved = response?.data ?? response;
          if (!Number.isSafeInteger(Number(saved?.id)) || Number(saved.id) <= 0) throw error(502, '创建响应缺少代理 ID');
          const record = { ...proxy, id: saved.id };
          existing.set(identity(proxy), record);
          entry.results[index] = { index, status: 'created', proxy: publicProxy(record), message: '已添加到号池' };
        } catch (e) {
          // A timeout/5xx may have committed remotely. Never replay it blindly.
          const definite = e.remoteStatus >= 400 && e.remoteStatus < 500;
          entry.results[index] = { index, status: definite ? 'failed' : 'unknown', message: definite ? `号池拒绝添加（HTTP ${e.remoteStatus}）` : '添加结果待确认，请先读取号池代理列表；未自动重试' };
        }
      }
      return { results: entry.results, ...Object.fromEntries(['created', 'existing', 'failed', 'unknown'].map(status => [status, entry.results.filter(r => r.status === status).length])) };
    });
    entry.pending = pending;
    locks.set(backend, pending);
    try { return await pending; } finally { entry.pending = null; if (locks.get(backend) === pending) locks.delete(backend); }
  };
}
