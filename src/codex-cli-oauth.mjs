import path from "node:path";
import { cliProfile, normalizeCliEmail, openCliSession, withCliLock } from "./codex-cli-runtime.mjs";
import { writePrivateJsonAtomic } from "./account-history.mjs";

const fail = (message) => new Error(`CODEX_CLI: ${message}`);
const AUTH_CLAIM = "https://api.openai.com/auth";

function claims(token) {
  try {
    const data = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function cliAuthToSub2api(auth, { expectedEmail, workspaceId, clientId = "app_EMoamEEZ73f0CkXaXp7hrann",
  userAgent, environmentId, accountName, concurrency = 10, priority = 1, rateMultiplier = 1 } = {}) {
  const tokens = auth?.tokens;
  if (auth?.auth_mode !== "chatgpt" || auth.OPENAI_API_KEY != null || !tokens
    || ["id_token", "access_token", "refresh_token", "account_id"].some(key => typeof tokens[key] !== "string" || !tokens[key].trim())) {
    throw fail("auth.json 缺少完整的 ChatGPT OAuth 凭据");
  }
  const id = claims(tokens.id_token), access = claims(tokens.access_token);
  const metadata = { ...access[AUTH_CLAIM], ...id[AUTH_CLAIM] };
  const email = normalizeCliEmail(id.email || access["https://api.openai.com/profile"]?.email);
  if (!expectedEmail || email !== normalizeCliEmail(expectedEmail)) throw fail("CLI 登录邮箱与当前账号不一致");
  if ((workspaceId && tokens.account_id !== workspaceId)
    || (metadata.chatgpt_account_id && metadata.chatgpt_account_id !== tokens.account_id)) throw fail("CLI 登录工作区与当前账号不一致");
  if (access.exp != null && (!Number.isFinite(access.exp) || access.exp <= Date.now() / 1000)) throw fail("CLI 访问令牌已过期，请重新授权");
  const plan = metadata.chatgpt_plan_type;
  const account = {
    name: accountName || `oauth---${email}`, platform: "openai", type: "oauth",
    credentials: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token,
      chatgpt_account_id: tokens.account_id, email, client_id: clientId,
      ...(access.exp ? { expires_at: access.exp } : {}), ...(plan ? { plan_type: plan } : {}) },
    extra: { account_id: tokens.account_id, chatgpt_account_id: tokens.account_id,
      chatgpt_user_id: metadata.chatgpt_user_id || metadata.user_id || id.sub || "", email, client_id: clientId,
      ...(plan ? { plan_type: plan } : {}), auth_provider: "codex_cli", codex_cli_environment: "one_shot", codex_cli_environment_id: environmentId,
      codex_cli_user_agent: userAgent, codex_cli_last_refresh: auth.last_refresh || null,
      openai_long_context_billing_enabled: false, openai_oauth_responses_websockets_v2_enabled: false,
      openai_oauth_responses_websockets_v2_mode: "off", privacy_mode: "training_set_failed" },
    concurrency: Number(concurrency || 10), priority: Number(priority || 1), rate_multiplier: Number(rateMultiplier || 1), auto_pause_on_expired: true,
  };
  return { account, data: { type: "sub2api-data", version: 1, exported_at: new Date().toISOString(), proxies: [], accounts: [account] } };
}

export function validateCliAuthUrl(value, authBase = "https://auth.openai.com") {
  let url, callback;
  try { url = new URL(value); callback = new URL(url.searchParams.get("redirect_uri")); }
  catch { throw fail("CLI 授权链接格式错误"); }
  const one = key => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : "";
  if (url.origin !== new URL(authBase).origin || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash
    || !one("state") || !one("client_id") || !one("code_challenge") || one("code_challenge_method") !== "S256"
    || one("response_type") !== "code" || !one("redirect_uri") || callback.protocol !== "http:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) || callback.port !== "1455"
    || callback.pathname !== "/auth/callback" || callback.username || callback.password || callback.search || callback.hash) throw fail("CLI 授权链接来源或参数错误");
  return { authUrl: url.href, redirectUri: callback.href, state: one("state"), clientId: one("client_id") };
}

export function validateCliCallback(value, session) {
  let callback;
  try { callback = new URL(value); } catch { throw fail("授权回调格式错误"); }
  const target = new URL(session.redirectUri);
  if (callback.origin !== target.origin || callback.pathname !== target.pathname || callback.username || callback.password || callback.hash
    || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== session.state
    || callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code") || callback.searchParams.has("error")) throw fail("授权回调来源或 state 不匹配");
  return callback.href;
}

function gatewayUrl(config) {
  let url;
  try { url = new URL(config?.baseUrl); } catch { throw fail("请先保存 Sub2API 后端设置"); }
  if (!config?.adminApiKey || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw fail("Sub2API 后端设置无效");
  return `${url.href.replace(/\/$/, "")}/api/v1/admin/settings`;
}

export function validateCliUserAgent(userAgent) {
  if (typeof userAgent !== "string" || !/^codex_cli_rs\/\d+\.\d+\.\d+ [\x20-\x7e]+$/.test(userAgent) || userAgent.length > 512) throw fail("CLI 未返回有效的 User-Agent");
  return userAgent;
}

async function requestGatewaySettings(config, method, body, fetchImpl) {
  let response;
  try { response = await fetchImpl(gatewayUrl(config), { method, headers: { "x-api-key": config.adminApiKey, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000) }); }
  catch { throw fail("Sub2API UA 设置连接失败"); }
  if (!response.ok) throw fail(`Sub2API UA 设置返回 HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw fail("Sub2API 设置响应格式错误"); }
  if (payload?.code != null && ![0, 200].includes(payload.code)) throw fail("Sub2API 设置更新失败");
  const data = payload?.data ?? payload;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("Sub2API 设置响应格式错误");
  return data;
}

export async function readGatewayUserAgent(config, { fetchImpl = fetch } = {}) {
  const settings = await requestGatewaySettings(config, "GET", undefined, fetchImpl);
  const ua = settings.openai_codex_user_agent;
  if (typeof ua !== "string" || ua.length > 512 || /[^\x20-\x7e]/.test(ua)) throw fail("该 Sub2API 版本未提供有效的 OpenAI Codex UA 设置");
  return ua;
}

export async function syncCliUserAgent(config, userAgent, { root, fetchImpl = fetch, expectedPreviousUserAgent, assertCurrent = () => {} } = {}) {
  const url = gatewayUrl(config);
  validateCliUserAgent(userAgent);
  return withCliLock(root, `gateway:${url}`, async () => {
    const request = (method, body) => requestGatewaySettings(config, method, body, fetchImpl);
    assertCurrent();
    const before = await request("GET");
    assertCurrent();
    if (typeof before.openai_codex_user_agent !== "string") throw fail("该 Sub2API 版本未提供 OpenAI Codex UA 设置");
    if (before.openai_codex_user_agent === userAgent) return { changed: false, userAgent };
    if (expectedPreviousUserAgent !== undefined && before.openai_codex_user_agent !== expectedPreviousUserAgent) {
      throw Object.assign(fail("号池 UA 已变更，请重新读取后再同步"), { status: 409 });
    }
    // PUT is a full settings save for several legacy fields. Carry forward the
    // GET projection exactly; never submit a UA-only body to this endpoint.
    await request("PUT", { ...before, openai_codex_user_agent: userAgent });
    const after = await request("GET");
    if (after.openai_codex_user_agent !== userAgent) throw fail("Sub2API UA 读回核验失败，请重试同步");
    await writePrivateJsonAtomic(path.join(root, "gateway-ua-last-sync.json"), {
      baseUrl: config.baseUrl, previousUserAgent: before.openai_codex_user_agent, userAgent, syncedAt: new Date().toISOString(),
    });
    return { changed: true, userAgent };
  });
}

export async function runCliOAuth(options) {
  const profile = await cliProfile(options.root, options.profileEmail || options.expectedEmail);
  const progress = message => options.onProgress?.(`[env=${profile.runId}] ${message}`);
  async function step(stage, action) {
    const start = Date.now();
    progress(`stage=${stage} start`);
    try {
      const value = await action();
      progress(`stage=${stage} ok duration_ms=${Date.now() - start}`);
      return value;
    } catch (error) {
      progress(`stage=${stage} failed duration_ms=${Date.now() - start}`);
      throw error;
    }
  }
  return withCliLock(profile.root, `profile:${profile.key}`, async () => {
    const session = await step("environment", () => (options.openSession || openCliSession)(profile, { ...options, onProgress: progress }));
    let failure, persistedExport;
    try {
      const started = await step("login_start", () => session.request("account/login/start", { type: "chatgpt", codexStreamlinedLogin: true }));
      if (started?.type !== "chatgpt" || !started.loginId) throw fail("CLI 未返回浏览器授权会话");
      const authorization = validateCliAuthUrl(started.authUrl, options.authBase);
      const clientId = authorization.clientId;
      progress("CLI 已生成链接，正在通过当前账号的 Web 会话授权");
      const completed = await step("web_authorization", () => options.authorize(authorization.authUrl, { provider: "cli", ...authorization }));
      await step("callback", () => session.deliverCallback(validateCliCallback(completed.callbackUrl, authorization)));
      await step("login_completed", () => session.waitForLogin(started.loginId));
      let converted;
      try {
        converted = await step("auth_validation", async () => cliAuthToSub2api(await session.readAuth(), { ...options, clientId,
          userAgent: session.userAgent, environmentId: profile.runId }));
      } catch (error) {
        // A valid login to the wrong browser account must not remain in this
        // account's temporary CLI home. Existing Helper exports stay intact.
        await step("discard_auth", () => session.discardAuth()).catch(() => {});
        throw error;
      }
      if (options.exportPath) {
        await step("export", () => writePrivateJsonAtomic(options.exportPath, converted.data));
        converted.persistedPath = path.resolve(options.exportPath);
        persistedExport = converted;
      }
      progress("CLI 凭据已校验；网关 UA 保持不变，可在任务设置中手动同步");
      return converted;
    } catch (error) { failure = error; throw error; }
    finally {
      try { await step("cleanup", () => session.close()); }
      catch (error) {
        if (!failure && !persistedExport) throw error;
        if (!failure && persistedExport) {
          // The OAuth export is already validated and durably written. A local
          // container cleanup timeout must not turn a successful authorization
          // into a retryable failure that creates another remote session.
          progress("cleanup warning: CLI 授权已完成，临时容器清理待确认；保留成功结果，不重复授权。");
        }
        // When an earlier stage failed, preserve that primary error. When the
        // export succeeded, return it and let the process-exit cleanup retry.
      }
    }
  });
}
