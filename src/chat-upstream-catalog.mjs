import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const ENDPOINT =
  "https://chatgpt.com/backend-api/codex/models?client_version=0.144.0";
const unsupported = /image|audio|video|embedding|tts|whisper|moderation/i;
const problem = (status, message) => Object.assign(Error(message), { status });

export function upstreamTextModelIds(manifest) {
  const records = manifest?.models ?? manifest?.data;
  if (!Array.isArray(records)) throw problem(502, "上游模型目录格式异常");
  return [
    ...new Set(
      records.flatMap((r) => {
        const id = typeof r === "string" ? r : r?.slug || r?.id;
        return typeof id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(id) &&
          !unsupported.test(id) &&
          r?.visibility !== "hide" &&
          r?.visibility !== "hidden"
          ? [id]
          : [];
      }),
    ),
  ];
}

// Only use the fixed, read-only upstream manifest for this OAuth identity.
// Never substitute the pool's configured aliases, global catalog, or another account.
export function createChatCatalog({
  getAccount,
  readManifest = readUpstreamManifest,
  identity,
  now = Date.now,
  ttl = 60_000,
}) {
  const cached = new Map(),
    pending = new Map();
  return async function get(target, { fresh = false } = {}) {
    const key = JSON.stringify([identity(target.c), target.account, target.id]);
    const old = cached.get(key);
    if (!fresh && old && now() - old.at < ttl) return old.models;
    if (pending.has(key)) return pending.get(key);
    cached.delete(key);
    const work = (async () => {
      const account = await getAccount(target);
      const manifest = await readManifest(target, account);
      const models = upstreamTextModelIds(manifest);
      if (cached.size >= 128) cached.delete(cached.keys().next().value);
      cached.set(key, { at: now(), models });
      return models;
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

// The manifest is a protected resource, not an OAuth token exchange. Use
// ordinary verified HTTPS, no browser session, redirects, retries or cookies.
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;

function agentForBoundProxy(raw) {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol))
      return new HttpsProxyAgent(url, {
        timeout: TIMEOUT_MS,
        rejectUnauthorized: true,
      });
    if (
      ["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(
        url.protocol,
      )
    )
      return new SocksProxyAgent(url, { timeout: TIMEOUT_MS });
  } catch {
    /* never expose a proxy URL or credentials */
  }
  throw problem(409, "账号绑定代理配置无效，未改走直连");
}

export async function readUpstreamManifest(
  target,
  account,
  { credentials = account.credentials, get = https.get } = {},
) {
  if (
    account.platform !== "openai" ||
    account.type !== "oauth" ||
    !credentials?.access_token
  )
    throw problem(409, "所选账号缺少可用的 OAuth 凭据");
  const bound = Number(account.proxy_id) > 0;
  if (bound && !account.fingerprintProxyUrl)
    throw problem(409, "账号绑定代理不可用，未改走直连");
  const agent = agentForBoundProxy(bound ? account.fingerprintProxyUrl : null);
  const headers = {
    accept: "application/json",
    authorization: "Bearer " + credentials.access_token,
    originator: "codex_cli_rs",
    version: "0.144.0",
    "user-agent": "sub2api-helper (model catalog)",
  };
  const id = credentials.chatgpt_account_id || credentials.account_id;
  if (id) headers["chatgpt-account-id"] = String(id);
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      get(
        ENDPOINT,
        {
          headers,
          agent,
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
        resolve,
      ).once("error", reject);
    });
    // https.get does not follow Location; a 3xx never forwards this account's bearer.
    if (response.statusCode !== 200)
      throw problem(
        502,
        "上游模型目录返回 HTTP " +
          response.statusCode +
          "；未使用号池配置列表替代",
      );
    let length = 0;
    const chunks = [];
    for await (const chunk of response) {
      length += chunk.length;
      if (length > MAX_BYTES) throw problem(502, "上游模型目录响应过大");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    if (e?.status === 502) throw e;
    throw problem(502, "未能读取此账号的上游模型目录，请稍后重试");
  } finally {
    response?.destroy();
    if (agent) agent.destroy();
  }
}
