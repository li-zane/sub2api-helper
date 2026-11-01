import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { TlsFingerprintTransport, proxySupportsSessionRotation, rotateProxySession } from "./tls-transport.mjs";

const DEFAULT_EXIT_URL = "https://my.ippure.com/v1/info";
const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const REQUEST_TIMEOUT_MS = 8_000;

// Separate transports keep diagnostics independent from account login sessions.
export class ProxyQualityService {
  constructor({ exitUrl = DEFAULT_EXIT_URL, chatgptUrl = DEFAULT_CHATGPT_URL, profile = "chrome146", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.exitUrl = exitUrl;
    this.chatgptUrl = chatgptUrl;
    this.profile = profile === "auto" ? "chrome146" : profile;
    this.timeoutMs = Math.max(100, Math.min(REQUEST_TIMEOUT_MS, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
    this.running = new Map();
    this.closed = false;
  }

  async check(proxyUrl, { signal, rotateSession = false } = {}) {
    if (this.closed) throw Object.assign(new Error("服务正在关闭"), { status: 503 });
    const key = createHash("sha256").update(`${rotateSession ? "rotate" : "fixed"}\0${proxyUrl}`).digest("hex");
    const existing = this.running.get(key);
    if (existing) return existing.promise;
    if (this.running.size >= 2) throw Object.assign(new Error("已有两个代理正在检测，请稍后再试"), { status: 429 });
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const promise = this.run(proxyUrl, controller.signal, rotateSession).finally(() => {
      signal?.removeEventListener("abort", stop);
      this.running.delete(key);
    });
    this.running.set(key, { controller, promise });
    return promise;
  }

  async run(proxyUrl, externalSignal, rotateSession) {
    const transport = new TlsFingerprintTransport({ profile: this.profile, rotateProxySessions: false, sameProxyRiskRetries: 0, cloudflareSolver: false });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs * 4 + 2_000);
    const signal = AbortSignal.any([externalSignal, deadline.signal]);
    const stop = () => { void transport.close(); };
    signal.addEventListener("abort", stop, { once: true });
    const samples = [];
    let chatgpt = { status: "failed", latencyMs: null, httpStatus: null, error: "ChatGPT 访问失败，请检查代理连接或稍后重试" };
    const reports = new Map();
    const sessionRotation = rotateSession ? (proxySupportsSessionRotation(proxyUrl) ? "rotated" : "unsupported") : "fixed";
    const checkProxyUrl = sessionRotation === "rotated" ? rotateProxySession(proxyUrl) : proxyUrl;
    try {
      signal.throwIfAborted();
      // Rotate once per diagnostic run; both samples measure the same new session.
      await transport.configure(checkProxyUrl, { force: true });
      for (let i = 0; i < 2; i++) {
        signal.throwIfAborted();
        const start = performance.now();
        try {
          const response = await transport.request("GET", this.exitUrl, { timeoutMs: this.timeoutMs, headers: { accept: "application/json", "cache-control": "no-cache" } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const ip = normalizeIp(data.ip);
          if (!ip) throw new Error("INVALID_IP");
          samples.push({ ok: true, ip, latencyMs: Math.max(1, Math.round(performance.now() - start)) });
          const report = normalizeReputation(data);
          // IPPure reports the caller's IP: obtain both the exit and its score
          // through the selected proxy, never a direct reputation lookup.
          if (report.riskScore !== null || !reports.get(ip)?.available) reports.set(ip, {
            ...report, checkedAt: new Date().toISOString(), source: "ippure.com",
            available: report.riskScore !== null,
            error: report.riskScore === null ? "IPPure 未返回有效风险分，纯净度未知" : null,
          });
        } catch {
          samples.push({ ok: false, error: "出口检测失败，请检查代理连接、认证或检测服务" });
        }
      }
      signal.throwIfAborted();
      // Keep the selected proxy session for the target-site request as well.
      // This diagnostic transport has no account login cookies or credentials.
      chatgpt = await measureChatGptLatency(transport, this.chatgptUrl, this.timeoutMs);
    } catch {
      if (!samples.length) samples.push({ ok: false, error: "出口检测失败，请检查代理连接、认证或检测服务" });
    } finally {
      await transport.close();
    }
    try {
      signal.throwIfAborted();
      const successful = samples.filter(sample => sample.ok);
      const ips = [...new Set(successful.map(sample => sample.ip))];
      const exits = ips.map(ip => ({ ip, ...reports.get(ip) }));
      const latencies = successful.map(sample => sample.latencyMs);
      return {
        checkedAt: new Date().toISOString(),
        sessionRotation,
        status: successful.length === 2 ? "ok" : successful.length ? "partial" : "failed",
        samples,
        successCount: successful.length,
        sampleCount: 2,
        stable: successful.length === 2 ? ips.length === 1 : null,
        latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        chatgpt,
        exits,
        error: successful.length ? null : "出口检测失败，请检查代理连接、认证或检测服务",
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  async close() {
    this.closed = true;
    for (const operation of this.running.values()) operation.controller.abort();
    await Promise.allSettled([...this.running.values()].map(operation => operation.promise));
  }
}

async function measureChatGptLatency(transport, url, timeoutMs) {
  const start = performance.now();
  try {
    const response = await transport.request("GET", url, { timeoutMs, discardBody: true, headers: { accept: "text/html", "cache-control": "no-cache" } });
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    const challenge = /challenge/i.test(response.headers.get("cf-mitigated") || response.headers.get("x-cf-mitigated") || "");
    const status = challenge ? "challenge" : response.status >= 200 && response.status < 400 ? "ok" : "http_error";
    return { status, latencyMs, httpStatus: response.status, error: status === "ok" ? null : challenge ? "ChatGPT 返回安全验证页面" : `ChatGPT 返回 HTTP ${response.status}` };
  } catch {
    return { status: "failed", latencyMs: null, httpStatus: null, error: "ChatGPT 连接失败或超时（单次最多 8 秒）" };
  }
}

function normalizeIp(value) {
  const ip = typeof value === "string" ? value.trim() : "";
  const version = isIP(ip);
  if (!version) return null;
  return version === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

function text(value) { return typeof value === "string" ? value.trim().slice(0, 180) : null; }

export function normalizeReputation(entry) {
  const rawRisk = entry.fraudScore;
  const risk = typeof rawRisk === "number" || (typeof rawRisk === "string" && /^\d+(?:\.\d+)?$/.test(rawRisk)) ? Number(rawRisk) : NaN;
  const riskScore = Number.isFinite(risk) && risk >= 0 && risk <= 100 ? risk : null;
  const residential = typeof entry.isResidential === "boolean" ? entry.isResidential : null;
  return {
    riskScore,
    riskLevel: riskScore === null ? "unknown" : riskScore <= 33 ? "low" : riskScore <= 66 ? "medium" : "high",
    proxy: null,
    vpn: null,
    tor: null,
    hosting: null,
    residential,
    broadcast: typeof entry.isBroadcast === "boolean" ? entry.isBroadcast : null,
    networkType: residential === true ? "住宅 IP" : residential === false ? "非住宅 IP" : null,
    country: text(entry.country),
    countryCode: text(entry.countryCode),
    region: text(entry.region),
    city: text(entry.city),
    provider: text(entry.asOrganization),
    asn: Number.isSafeInteger(entry.asn) && entry.asn > 0 ? `AS${entry.asn}` : null,
  };
}
