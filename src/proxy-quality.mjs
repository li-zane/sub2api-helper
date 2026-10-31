import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { TlsFingerprintTransport } from "./tls-transport.mjs";

const DEFAULT_EXIT_URL = "https://api.ipify.org?format=json";
const DEFAULT_REPUTATION_URL = "https://proxycheck.io/v2/";
const REQUEST_TIMEOUT_MS = 8_000;
const REPUTATION_TTL_MS = 10 * 60_000;

// Separate transports keep diagnostics independent from account login sessions.
export class ProxyQualityService {
  constructor({ exitUrl = DEFAULT_EXIT_URL, reputationUrl = DEFAULT_REPUTATION_URL, profile = "chrome146", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.exitUrl = exitUrl;
    this.reputationUrl = reputationUrl;
    this.profile = profile === "auto" ? "chrome146" : profile;
    this.timeoutMs = Math.max(100, Math.min(REQUEST_TIMEOUT_MS, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
    this.running = new Map();
    this.reputations = new Map();
    this.closed = false;
  }

  async check(proxyUrl, { signal } = {}) {
    if (this.closed) throw Object.assign(new Error("服务正在关闭"), { status: 503 });
    const key = createHash("sha256").update(proxyUrl).digest("hex");
    const existing = this.running.get(key);
    if (existing) return existing.promise;
    if (this.running.size >= 2) throw Object.assign(new Error("已有两个代理正在检测，请稍后再试"), { status: 429 });
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const promise = this.run(proxyUrl, controller.signal).finally(() => {
      signal?.removeEventListener("abort", stop);
      this.running.delete(key);
    });
    this.running.set(key, { controller, promise });
    return promise;
  }

  async run(proxyUrl, externalSignal) {
    const transport = new TlsFingerprintTransport({ profile: this.profile, rotateProxySessions: false, sameProxyRiskRetries: 0, cloudflareSolver: false });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs * 4 + 2_000);
    const signal = AbortSignal.any([externalSignal, deadline.signal]);
    const stop = () => { void transport.close(); };
    signal.addEventListener("abort", stop, { once: true });
    const samples = [];
    try {
      signal.throwIfAborted();
      await transport.configure(proxyUrl, { force: true });
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
        } catch {
          samples.push({ ok: false, error: "出口检测失败，请检查代理连接、认证或检测服务" });
        }
      }
    } catch {
      if (!samples.length) samples.push({ ok: false, error: "出口检测失败，请检查代理连接、认证或检测服务" });
    } finally {
      await transport.close();
    }
    try {
      signal.throwIfAborted();
      const successful = samples.filter(sample => sample.ok);
      const ips = [...new Set(successful.map(sample => sample.ip))];
      const exits = await Promise.all(ips.map(async ip => ({ ip, ...await this.lookupReputation(ip, signal) })));
      const latencies = successful.map(sample => sample.latencyMs);
      return {
        checkedAt: new Date().toISOString(),
        status: successful.length === 2 ? "ok" : successful.length ? "partial" : "failed",
        samples,
        successCount: successful.length,
        sampleCount: 2,
        stable: successful.length === 2 ? ips.length === 1 : null,
        latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
        exits,
        error: successful.length ? null : "出口检测失败，请检查代理连接、认证或检测服务",
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  async lookupReputation(ip, signal) {
    const cached = this.reputations.get(ip);
    if (cached?.expiresAt > Date.now()) return cached.value;
    const checkedAt = new Date().toISOString();
    let value;
    try {
      const url = new URL(encodeURIComponent(ip), this.reputationUrl);
      url.search = new URLSearchParams({ vpn: "1", asn: "1", risk: "1" }).toString();
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const entry = data[ip] || Object.entries(data).find(([key]) => normalizeIp(key) === ip)?.[1];
      if (data.status !== "ok" || !entry || typeof entry !== "object") throw new Error("NO_REPUTATION");
      value = { ...normalizeReputation(entry), checkedAt, source: "proxycheck.io", available: true, error: null };
    } catch {
      value = { ...normalizeReputation({}), checkedAt, source: "proxycheck.io", available: false, error: "信誉库暂未返回有效数据，纯净度未知" };
    }
    if (!signal.aborted) {
      if (this.reputations.size >= 256) this.reputations.delete(this.reputations.keys().next().value);
      this.reputations.set(ip, { value, expiresAt: Date.now() + (value.available ? REPUTATION_TTL_MS : 30_000) });
    }
    return value;
  }

  async close() {
    this.closed = true;
    for (const operation of this.running.values()) operation.controller.abort();
    await Promise.allSettled([...this.running.values()].map(operation => operation.promise));
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
  const rawRisk = entry.risk;
  const risk = typeof rawRisk === "number" || (typeof rawRisk === "string" && /^\d+(?:\.\d+)?$/.test(rawRisk)) ? Number(rawRisk) : NaN;
  const riskScore = Number.isFinite(risk) && risk >= 0 && risk <= 100 ? risk : null;
  const type = text(entry.type);
  const classified = /^(business|residential|hosting|mobile|vpn|tor|socks|http|compromised|data.?cent)/i.test(type || "");
  return {
    riskScore,
    riskLevel: riskScore === null ? "unknown" : riskScore <= 33 ? "low" : riskScore <= 66 ? "medium" : "high",
    proxy: entry.proxy === "yes" ? true : entry.proxy === "no" ? false : null,
    vpn: classified ? /vpn/i.test(type) : null,
    tor: classified ? /\btor\b/i.test(type) : null,
    hosting: /hosting|datacen(?:ter|tre)|data cent(?:er|re)/i.test(type || "") ? true : /residential|mobile/i.test(type || "") ? false : null,
    networkType: type,
    country: text(entry.country),
    countryCode: text(entry.isocode),
    region: text(entry.region),
    city: text(entry.city),
    provider: text(entry.provider) || text(entry.organisation),
    asn: text(entry.asn),
  };
}
