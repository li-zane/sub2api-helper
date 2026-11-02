import { TlsFingerprintTransport } from "./tls-transport.mjs";

const FAILURE_MESSAGES = {
  AUTH: "模型凭据失效或无权限，请刷新授权", QUOTA: "账号额度已用尽或受到请求频率限制",
  OVERLOADED: "模型上游过载", UPSTREAM: "模型上游服务异常", HTTP: "模型接口拒绝请求",
  TIMEOUT: "模型请求超时", NETWORK: "代理或网络连接失败", INCOMPLETE: "模型流式响应中断或未完成",
  EMPTY: "模型未返回可评分文本", ACCOUNT_PAUSED: "账号已暂停或状态异常，本轮跳过",
  ACCOUNT_MISSING: "账号尚未加入 Sub2API 号池", CREDENTIALS: "账号缺少可用模型凭据",
  PROXY: "账号绑定的代理不可用", REFERENCE: "指纹参考库加载失败或超时", UNKNOWN: "检测未完成，请检查账号配置及网络",
};
function failure(code, { httpStatus = null, retryable = false, upstreamCode = null } = {}) {
  return Object.assign(new Error(FAILURE_MESSAGES[code]), { fingerprintFailure: true, code, httpStatus, retryable, upstreamCode });
}
export function fingerprintFailure(error) {
  if (error?.fingerprintFailure && Object.hasOwn(FAILURE_MESSAGES, error.code)) return { code: error.code, message: FAILURE_MESSAGES[error.code], httpStatus: error.httpStatus ?? null, retryable: error.retryable === true, upstreamCode: error.upstreamCode ?? null };
  const message = String(error?.message || "");
  const code = /timed?\s*out|timeout|超时/i.test(message) ? "TIMEOUT" : /代理/.test(message) ? "PROXY" : /connect|curl|tls|socket|network|fetch failed|econn|enotfound/i.test(message) ? "NETWORK" : /已暂停|状态异常/.test(message) ? "ACCOUNT_PAUSED" : /尚未加入/.test(message) ? "ACCOUNT_MISSING" : /凭据/.test(message) ? "CREDENTIALS" : /参考库/.test(message) ? "REFERENCE" : "UNKNOWN";
  return { code, message: FAILURE_MESSAGES[code], httpStatus: null, retryable: ["TIMEOUT", "NETWORK"].includes(code), upstreamCode: null };
}
function upstreamFailure(event, httpStatus = null) {
  const error = event?.error || event?.response?.error || {};
  const raw = `${error.code || ""} ${error.type || ""} ${error.message || ""}`;
  const upstreamCode = ["usage_limit_reached", "rate_limit_exceeded", "insufficient_quota", "server_error", "server_is_overloaded", "overloaded", "service_unavailable_error", "invalid_api_key", "token_expired", "model_not_found"].find(code => error.code === code || error.type === code) || null;
  const code = /overload/i.test(raw) ? "OVERLOADED" : /usage.limit|rate.limit|quota|limit.*reached/i.test(raw) || httpStatus === 429 ? "QUOTA" : /expired|invalid.*token|unauthoriz/i.test(raw) || [401, 403].includes(httpStatus) ? "AUTH" : httpStatus >= 500 ? "UPSTREAM" : httpStatus ? "HTTP" : "INCOMPLETE";
  return failure(code, { httpStatus, upstreamCode, retryable: ["OVERLOADED", "UPSTREAM", "INCOMPLETE"].includes(code) });
}

function proxyUrl(proxy) {
  if (!proxy) throw new Error("账号绑定的代理未能导出");
  if (proxy.url || proxy.proxy_url) return proxy.url || proxy.proxy_url;
  const url = new URL(`${proxy.protocol || "http"}://${proxy.host}:${proxy.port}`);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString();
}
// Current Sub2API detail/list DTOs redact secrets. Use the authenticated export
// API with an exact ID filter; never fetch the entire pool's credentials.
export function createFingerprintAccountReader(request) {
  return async (config, id) => {
    const unwrap = payload => payload?.data || payload;
    const account = unwrap(await request(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}`));
    if (!account || String(account.id) !== String(id)) throw new Error("账号读取结果不匹配");
    let credentials = account.credentials || {}, fingerprintProxyUrl = null;
    if (!account.parent_account_id && !(account.type === "oauth" ? credentials.access_token : credentials.api_key)) {
      const exported = unwrap(await request(config, `/api/v1/admin/accounts/data?ids=${encodeURIComponent(id)}&include_proxies=true`));
      const entries = exported?.accounts || [];
      if (entries.length !== 1 || entries[0].name !== account.name || entries[0].type !== account.type || entries[0].platform !== account.platform) throw new Error("单账号凭据导出结果不匹配");
      const selected = entries[0];
      for (const key of ["email", "chatgpt_account_id"]) {
        if (credentials[key] && selected.credentials?.[key] !== credentials[key]) throw new Error("导出账号身份不匹配");
      }
      credentials = selected.credentials || {};
      if (account.proxy_id && selected.proxy_key) fingerprintProxyUrl = proxyUrl((exported.proxies || []).find(p => p.proxy_key === selected.proxy_key));
    }
    if (account.proxy_id && !fingerprintProxyUrl) {
      const exported = unwrap(await request(config, `/api/v1/admin/proxies/data?ids=${encodeURIComponent(account.proxy_id)}`));
      const proxies = exported?.proxies || [];
      if (proxies.length !== 1) throw new Error("单代理导出结果不匹配");
      fingerprintProxyUrl = proxyUrl(proxies[0]);
    }
    return { ...account, credentials, fingerprintProxyUrl };
  };
}

export function extractFingerprintReply(text) {
  let deltas = "", completed = null, streaming = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    streaming = true;
    let event; try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (event.type === "response.output_text.delta") deltas += event.delta || "";
    if (event.choices?.[0]?.delta?.content) deltas += event.choices[0].delta.content;
    if (event.type === "response.completed") completed = event.response;
    if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw upstreamFailure(event);
  }
  if (streaming && !completed) throw failure("INCOMPLETE", { retryable: true });
  if (deltas) return deltas;
  if (!completed) { try { completed = JSON.parse(text); } catch {} }
  if (completed?.error || completed?.status && completed.status !== "completed") throw upstreamFailure(completed);
  const output = completed?.output?.flatMap(item => (item.content || []).filter(p => p.type === "output_text").map(p => p.text || "")).join("") || completed?.choices?.[0]?.message?.content;
  if (typeof output !== "string" || !output.trim()) throw failure("EMPTY");
  return output;
}

// Direct account-specific sampling avoids the admin /test route's hard-coded "hi".
// Credentials stay on this server; the reference detector only receives local text.
export function createFingerprintSampler({ getAccount, getProxies, transportFactory = () => new TlsFingerprintTransport({ profile: "chrome146", rotateProxySessions: false, sameProxyRiskRetries: 0, cloudflareSolver: false }), testUrl } = {}) {
  return async (config, account, model, prompt, signal) => {
    let credentialAccount = account;
    if (account.parent_account_id != null) credentialAccount = await getAccount(config, account.parent_account_id);
    const credentials = credentialAccount.credentials || {};
    const oauth = credentialAccount.type === "oauth";
    const token = oauth ? credentials.access_token : credentials.api_key;
    if (!token || !["oauth", "apikey"].includes(credentialAccount.type)) throw new Error("账号缺少可用模型凭据");
    let proxyUrl = null;
    if (account.proxy_id != null && Number(account.proxy_id) !== 0) {
      proxyUrl = account.fingerprintProxyUrl || (await getProxies(config)).find(p => String(p.id) === String(account.proxy_id))?.url;
      if (!proxyUrl) throw new Error("账号绑定的代理不存在，检测已停止");
    }
    const mapped = (account.credentials?.model_mapping || credentials.model_mapping)?.[model];
    const body = { model: typeof mapped === "string" ? mapped : model, input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }], stream: true, store: false, instructions: "" };
    if (!oauth) body.max_output_tokens = 8192;
    const base = String(credentials.base_url || "https://api.openai.com").replace(/\/$/, "");
    const url = testUrl || (oauth ? "https://chatgpt.com/backend-api/codex/responses" : base.endsWith("/v1") ? `${base}/responses` : `${base}/v1/responses`);
    if (!/^https:\/\//i.test(url) && !testUrl) throw new Error("模型服务地址必须使用 HTTPS");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" };
    if (oauth) {
      headers.originator = "codex_cli_rs"; headers["openai-beta"] = "responses=experimental";
      const id = credentials.chatgpt_account_id || credentials.account_id;
      if (id) headers["chatgpt-account-id"] = String(id);
    }
    const transport = transportFactory(); const abort = () => { void transport.close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted(); await transport.configure(proxyUrl, { force: true });
      const response = await transport.request("POST", url, { timeoutMs: 180000, headers, body: JSON.stringify(body) });
      signal.throwIfAborted();
      const text = await response.text();
      if (!response.ok) {
        let event; try { event = JSON.parse(text); } catch {}
        throw upstreamFailure(event, response.status);
      }
      try { return extractFingerprintReply(text); }
      catch (error) {
        if (error.fingerprintFailure && error.httpStatus == null) error.httpStatus = response.status;
        throw error;
      }
    } finally { signal.removeEventListener("abort", abort); await transport.close(); }
  };
}
