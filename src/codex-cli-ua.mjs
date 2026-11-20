import { randomUUID } from "node:crypto";
import { cliProfile, openCliSession, CODEX_CLI_VERSION, CODEX_CLI_IMAGE } from "./codex-cli-runtime.mjs";
import { validateCliUserAgent, readGatewayUserAgent, syncCliUserAgent } from "./codex-cli-oauth.mjs";

// Initialization only: never generate an OAuth link or read any account auth.json.
export async function probeCliUserAgent({ root, openSession = openCliSession }) {
  const profile = await cliProfile(root, "ua-probe@example.invalid");
  const session = await openSession(profile);
  try { return validateCliUserAgent(session.userAgent); }
  finally { await session.close(); }
}

const conflict = message => Object.assign(new Error(message), { status: 409 });
const configured = config => Boolean(config?.baseUrl && config?.adminApiKey);
const gatewayError = error => /^CODEX_CLI:/.test(error?.message || "") ? error.message : "读取号池 UA 失败，请重试";

export function createCliUaSettings({ root, getConfig, probe = probeCliUserAgent, fetchImpl = fetch, now = Date.now, cacheMs = 10 * 60_000 }) {
  let cached = null, probing = null, lastConfig, contextId;
  const contexts = () => {
    const config = getConfig();
    if (config !== lastConfig || !contextId) { lastConfig = config; contextId = randomUUID(); }
    return { config, contextId };
  };
  const checkContext = context => {
    if (getConfig() !== context.config) throw conflict("号池配置已变更，请重新读取 UA");
  };
  async function cli(force = false) {
    if (probing) return probing;
    if (!force && cached && now() - cached.at < cacheMs) return cached.value;
    cached = null;
    probing = (async () => {
      const userAgent = validateCliUserAgent(await probe({ root }));
      const version = /^codex_cli_rs\/(\d+\.\d+\.\d+) /.exec(userAgent)[1];
      const value = { userAgent, version, image: CODEX_CLI_IMAGE, checkedAt: new Date(now()).toISOString(), error: null };
      cached = { at: now(), value };
      return value;
    })().finally(() => { probing = null; });
    return probing;
  }
  async function gateway(context) {
    if (!configured(context.config)) return { configured: false, userAgent: null, checkedAt: null, error: "请先配置 Sub2API 后端和管理员 API Key" };
    const userAgent = await readGatewayUserAgent(context.config, { fetchImpl });
    checkContext(context);
    return { configured: true, userAgent, checkedAt: new Date(now()).toISOString(), error: null };
  }
  function snapshot(context, local, pool) {
    return { contextId: context.contextId, cli: local, gateway: pool,
      matches: !local.error && !pool.error ? local.userAgent === pool.userAgent : null };
  }
  return {
    async read({ refreshCli = false } = {}) {
      const context = contexts();
      const [local, pool] = await Promise.all([
        cli(refreshCli).catch(() => ({ userAgent: null, version: CODEX_CLI_VERSION, image: CODEX_CLI_IMAGE, checkedAt: null, error: "读取 CLI UA 失败，请检查 Docker、CLI 镜像和容器清理状态后重试" })),
        gateway(context).catch(error => ({ configured: configured(context.config), userAgent: null, checkedAt: null, error: gatewayError(error) })),
      ]);
      checkContext(context);
      return snapshot(context, local, pool);
    },
    async sync(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw conflict("请先读取 UA 对比信息");
      const context = contexts();
      if (!configured(context.config)) throw conflict("请先配置 Sub2API 后端和管理员 API Key");
      if (input.contextId !== context.contextId || typeof input.gatewayUserAgent !== "string" || input.gatewayUserAgent.length > 512) {
        throw conflict("UA 对比信息已过期，请重新读取后再同步");
      }
      const local = await cli();
      checkContext(context);
      // The browser can confirm a value, but cannot supply an arbitrary UA.
      if (input.cliUserAgent !== local.userAgent) throw conflict("CLI UA 已变更，请重新读取后再同步");
      const result = await syncCliUserAgent(context.config, local.userAgent, { root, fetchImpl,
        expectedPreviousUserAgent: input.gatewayUserAgent, assertCurrent: () => checkContext(context) });
      checkContext(context);
      return { ...snapshot(context, local, { configured: true, userAgent: result.userAgent, checkedAt: new Date(now()).toISOString(), error: null }), changed: result.changed };
    },
  };
}
