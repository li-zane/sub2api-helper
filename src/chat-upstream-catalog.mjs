import { TlsFingerprintTransport } from "./tls-transport.mjs";

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

export async function readUpstreamManifest(
  target,
  account,
  {
    credentials = account.credentials,
    transportFactory = () =>
      new TlsFingerprintTransport({
        profile: "chrome146",
        rotateProxySessions: false,
        sameProxyRiskRetries: 0,
        cloudflareSolver: false,
      }),
  } = {},
) {
  if (
    account.platform !== "openai" ||
    account.type !== "oauth" ||
    !credentials?.access_token
  )
    throw problem(409, "所选账号缺少可用的 OAuth 凭据");
  const proxy =
    Number(account.proxy_id) > 0 ? account.fingerprintProxyUrl : null;
  if (Number(account.proxy_id) > 0 && !proxy)
    throw problem(409, "账号绑定代理不可用，未改走直连");
  const transport = transportFactory();
  try {
    if (proxy && transport.enabled === false)
      throw problem(409, "模型目录查询需要使用账号绑定的代理");
    await transport.configure(proxy, { force: true });
    const headers = {
      accept: "application/json",
      authorization: "Bearer " + credentials.access_token,
      originator: "codex_cli_rs",
      version: "0.144.0",
    };
    const id = credentials.chatgpt_account_id || credentials.account_id;
    if (id) headers["chatgpt-account-id"] = String(id);
    const response = await transport.request("GET", ENDPOINT, {
      headers,
      timeoutMs: 20000,
      redirect: "manual",
      requestKind: "oauth",
    });
    if (!response.ok)
      throw problem(
        502,
        "上游模型目录返回 HTTP " + response.status + "；未使用号池配置列表替代",
      );
    return JSON.parse(await response.text());
  } catch (e) {
    if (e?.status && [409, 502].includes(e.status)) throw e;
    throw problem(502, "未能读取此账号的上游模型目录，请稍后重试");
  } finally {
    await transport.close();
  }
}
