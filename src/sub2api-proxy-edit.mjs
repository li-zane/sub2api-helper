import crypto from 'node:crypto';
import { normalizeProxyInput } from '../web/src/proxy-input.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const connection = proxy => ({
  name: String(proxy.name ?? ''), protocol: String(proxy.protocol || 'http'), host: String(proxy.host ?? ''),
  port: Number(proxy.port), username: String(proxy.username ?? ''), password: String(proxy.password ?? ''),
});
const backendKey = config => digest([config.baseUrl, config.adminApiKey]);
const revision = (config, proxy) => digest([backendKey(config), Number(proxy.id), connection(proxy)]);
const publicEdit = (config, proxy) => {
  const { password, ...fields } = connection(proxy);
  return { proxy: { id: Number(proxy.id), ...fields, hasPassword: Boolean(password) }, revision: revision(config, proxy) };
};

export function createProxyEditor({ request }) {
  const locks = new Map();
  function validate(config, id) {
    if (!config?.baseUrl || !config.adminApiKey) throw error(409, '请先保存 Sub2API 后端和管理员 API Key');
    if (!Number.isSafeInteger(id) || id <= 0) throw error(400, '代理 ID 无效');
  }
  async function read(config, id) {
    validate(config, id);
    let payload;
    try { payload = await request(config, `/api/v1/admin/proxies/${id}`, { timeoutMs: 30_000 }); }
    catch (e) {
      if (e.remoteStatus === 404) throw error(404, '该代理已不存在，请刷新代理列表');
      throw error(502, '读取代理配置失败，请稍后重试');
    }
    const proxy = payload?.data ?? payload;
    if (Number(proxy?.id) !== id) throw error(502, '号池代理配置格式异常');
    return proxy;
  }
  async function mutate(config, id, body, action, write) {
    validate(config, id);
    if (typeof body?.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw error(400, '缺少配置版本，请重新读取代理');
    const key = `${backendKey(config)}:${id}`;
    const previous = locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await read(config, id);
      if (body.revision !== revision(config, current)) throw error(409, `代理配置已变化，请重新读取后再${action}`);
      return write(current);
    });
    locks.set(key, operation);
    try { return await operation; }
    finally { if (locks.get(key) === operation) locks.delete(key); }
  }

  return {
    async get(config, id) { return publicEdit(config, await read(config, id)); },
    async update(config, id, body) {
      return mutate(config, id, body, '修改', async current => {
        const merged = { ...connection(current), ...Object.fromEntries(
          ['name', 'protocol', 'host', 'port', 'username', 'password'].filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]),
        ) };
        let normalized;
        try { normalized = normalizeProxyInput(merged); }
        catch (e) { throw error(400, e.message); }
        // Expiry, status and failover settings belong to the existing node.
        const { expires_at, ...fields } = normalized;
        let payload;
        try { payload = await request(config, `/api/v1/admin/proxies/${id}`, { method: 'PUT', timeoutMs: 30_000, body: JSON.stringify(fields) }); }
        catch (e) {
          throw error(502, e.remoteStatus >= 400 && e.remoteStatus < 500
            ? `号池拒绝修改（HTTP ${e.remoteStatus}）`
            : '保存结果待确认，请重新读取代理配置后确认');
        }
        const saved = payload?.data ?? payload;
        if (Number(saved?.id) !== id) throw error(502, '保存结果待确认，请重新读取代理配置后确认');
        return publicEdit(config, { ...current, ...fields, ...saved });
      });
    },
    async remove(config, id, body, assertUnused) {
      return mutate(config, id, body, '删除', async () => {
        await assertUnused(config, id);
        let payload;
        try { payload = await request(config, `/api/v1/admin/proxies/${id}`, { method: 'DELETE', timeoutMs: 30_000 }); }
        catch (e) {
          if (e.remoteCode === 'PROXY_IN_USE' || e.remoteStatus === 409) {
            throw error(409, '号池仍有账号使用此代理，请先更换绑定');
          }
          if (e.remoteStatus === 404) throw error(404, '该代理已不存在，请刷新代理列表');
          throw error(502, '删除结果待确认，请刷新代理列表后确认');
        }
        if (payload?.code === 'PROXY_IN_USE') throw error(409, '号池仍有账号使用此代理，请先更换绑定');
        if (![0, '0'].includes(payload?.code)) throw error(502, '删除结果待确认，请刷新代理列表后确认');
        return { deleted: true, id };
      });
    },
  };
}
