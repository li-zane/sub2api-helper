import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, ShieldCheck } from "lucide-react";
import { HelpTip } from "./help-tip.jsx";
import { displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

const RISK_LABELS = { low: "低风险", medium: "中风险", high: "高风险", unknown: "风险未知" };
const flag = value => value === true ? "是" : value === false ? "否" : "未知";
const timeLabel = value => displayDateTime(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function ProxyQualityPanel({ token, mode, proxies, globalProxyUrl, dirty, defaultOpen = false }) {
  return <details className="proxy-quality-panel" open={defaultOpen || undefined}>
    <summary>
      <ShieldCheck size={15} aria-hidden="true" />
      <span>出口与纯净度检测</span>
      <HelpTip title="出口与纯净度检测说明" label="查看出口与纯净度检测说明">
        通过待测代理访问 IPPure 检测出口和风险分，并用同一代理会话测量未登录访问 ChatGPT 首页的请求耗时（HTTP 状态单独显示）。
      </HelpTip>
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="proxy-quality-body">
      {mode !== "sub2api" && <ProxyQualityCheck key={`global:${globalProxyUrl}`} token={token} name="全局代理" target={{ target: "global" }} disabled={!globalProxyUrl || dirty}
        hint={dirty ? "请先保存代理配置后再检测" : !globalProxyUrl ? "请先填写并保存代理地址" : "每次检测使用新代理会话，两次抽样共用该会话"} />}
      {["sub2api", "plan"].includes(mode) && proxies.map(proxy => <ProxyQualityCheck key={`${proxy.id}:${proxy.host}:${proxy.port}`} token={token} name={proxy.name} target={{ target: "sub2api", proxyId: proxy.id }} />)}
      {mode === "sub2api" && !proxies.length && <p className="empty-inline-note">读取代理后，可逐个检测节点质量</p>}
    </div>
  </details>;
}

function ProxyQualityCheck({ token, name, target, disabled = false, hint }) {
  useDisplayTimeZone();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function check() {
    if (controller.current || busy || disabled || !token) return;
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/proxy-quality/check", { method: "POST", headers: { "x-console-token": token, "content-type": "application/json" }, body: JSON.stringify(target), signal: current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "检测失败，请重试");
      setResult(data.result);
    } catch (requestError) {
      if (!current.signal.aborted) setError(requestError.message);
    } finally {
      if (controller.current === current) controller.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }

  const sessionNote = result
    ? (result.sessionRotation === "rotated" ? "本次已轮换代理会话" : result.sessionRotation === "unsupported" ? "当前代理未识别到可轮换会话参数，按原地址检测" : "本次保持节点固定会话")
    : "";

  return <section className="proxy-quality-check" aria-label={`${name} 代理质量`} aria-busy={busy}>
    <div className="proxy-quality-check-header">
      <div className="field-label-row">
        <strong>{name}</strong>
        {(hint || sessionNote) && (
          <HelpTip title={`${name} 检测说明`} label={`查看 ${name} 检测说明`}>
            {hint && <div>{hint}</div>}
            {sessionNote && <div>{sessionNote} · 检测于 {timeLabel(result.checkedAt)}</div>}
          </HelpTip>
        )}
      </div>
      <button type="button" className="secondary-button compact-btn" onClick={check} disabled={busy || disabled || !token} aria-label={`检测 ${name} 的代理质量`}>
        {busy && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{busy ? "检测中…" : result ? "重新检测" : "检测质量"}
      </button>
    </div>
    {busy && <span className="proxy-quality-help" role="status">正在检测出口、IP 信誉与 ChatGPT 延迟…</span>}
    {error && <p className="proxy-quality-error" role="alert">{error}</p>}
    {result && <div className={`proxy-quality-result${busy ? " stale" : ""}`}>
      <div className="proxy-quality-metrics">
        <span><small>IPPure 耗时</small><strong>{result.latencyMs === null ? "—" : `${result.latencyMs} ms`}</strong></span>
        <span>
          <small>ChatGPT 延迟</small>
          <strong>{result.chatgpt?.latencyMs == null ? "—" : `${result.chatgpt.latencyMs} ms`}</strong>
          <small className={result.chatgpt?.status && result.chatgpt.status !== "ok" ? "proxy-quality-error" : ""}>
            {result.chatgpt?.httpStatus ? `HTTP ${result.chatgpt.httpStatus}${result.chatgpt.status === "challenge" ? " · 验证" : ""}` : result.chatgpt?.error || "尚未检测"}
          </small>
        </span>
        <span>
          <small>出口抽样</small>
          <strong>{result.successCount}/{result.sampleCount} 成功</strong>
          <small className={`proxy-quality-sampling ${result.stable === false ? "changed" : result.stable === null ? "unknown" : ""}`}>
            {result.stable === true ? "两次出口一致" : result.stable === false ? "两次出口不同" : "稳定性未知"}
          </small>
        </span>
      </div>
      {result.error && <p className="proxy-quality-error" role="alert">{result.error}</p>}
      {result.status === "partial" && <p className="proxy-quality-error">一次出口检测失败，请重新检测。</p>}
      {result.exits.map(exit => <ProxyExit key={exit.ip} exit={exit} />)}
    </div>}
  </section>;
}

function ProxyExit({ exit }) {
  const location = [...new Set([exit.country, exit.region, exit.city].filter(Boolean))].join(" · ");
  const isp = [exit.provider, exit.asn].filter(Boolean).join(" · ");
  return <div className="proxy-quality-exit">
    <div className="proxy-quality-exit-heading">
      <div className="field-label-row">
        <code>{exit.ip}</code>
        <HelpTip title={`出口 ${exit.ip} 详情`} label={`查看 ${exit.ip} 详情`}>
          {location && <div>地区：{location}</div>}
          {isp && <div>运营商：{isp}</div>}
          {exit.networkType && <div>网络类型：{exit.networkType}</div>}
          <div>住宅 IP：{flag(exit.residential)} · 广播 IP：{flag(exit.broadcast)}</div>
          <div>来源：{exit.source} · {timeLabel(exit.checkedAt)}{exit.riskScore !== null ? "（分数越低风险越低）" : ""}</div>
        </HelpTip>
      </div>
      <span className={`proxy-risk-badge ${exit.riskLevel}`}>{RISK_LABELS[exit.riskLevel]} {exit.riskScore === null ? "" : `· ${exit.riskScore}/100`}</span>
    </div>
    {exit.riskScore !== null && <meter min="0" max="100" low="34" high="67" optimum="0" value={exit.riskScore} aria-label={`${exit.ip} 风险分，越低越好`} />}
    {exit.error && <p className="proxy-quality-error">{exit.error}</p>}
  </div>;
}
