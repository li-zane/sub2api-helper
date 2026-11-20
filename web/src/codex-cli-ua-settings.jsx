import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

export function CodexCliUaSettings({ request, disabled, onSyncBusy }) {
  useDisplayTimeZone();
  const [data, setData] = useState(null), [busy, setBusy] = useState("read");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const live = useRef(false), inFlight = useRef(false), generation = useRef(0);
  useEffect(() => {
    live.current = true;
    const current = ++generation.current;
    inFlight.current = true;
    setBusy("read"); setError(""); setData(null);
    request("/api/codex-cli/ua/read", { method: "POST", body: "{}" }).then(result => {
      if (live.current && current === generation.current) setData(result);
    }, e => { if (live.current && current === generation.current) setError(e.message); }).finally(() => {
      if (live.current && current === generation.current) { inFlight.current = false; setBusy(""); }
    });
    return () => { live.current = false; };
  }, [request]);

  async function act(action) {
    if (inFlight.current || disabled) return;
    inFlight.current = true; setBusy(action); setError(""); setNotice("");
    if (action === "sync") onSyncBusy(true);
    try {
      const body = action === "sync" ? { contextId: data.contextId, cliUserAgent: data.cli.userAgent, gatewayUserAgent: data.gateway.userAgent } : { refreshCli: true };
      const result = await request(`/api/codex-cli/ua/${action}`, { method: "POST", body: JSON.stringify(body) });
      if (live.current) {
        setData(result);
        if (action === "sync") setNotice(result.changed ? "号池 UA 已同步，并已读回核验。" : "两端 UA 已一致，无需更新。");
      }
    } catch (e) {
      if (live.current) { setError(e.message); setData(null); }
    } finally {
      inFlight.current = false;
      if (live.current) { setBusy(""); if (action === "sync") onSyncBusy(false); }
    }
  }
  const ready = data?.cli?.userAgent && typeof data?.gateway?.userAgent === "string" && !data.cli.error && !data.gateway.error;
  const errors = [error, data?.cli?.error, data?.gateway?.configured ? data.gateway.error : null].filter(Boolean);
  return <section className="cli-ua-settings" aria-labelledby="cli-ua-title" aria-busy={Boolean(busy)}>
    <div className="cli-ua-heading"><h4 id="cli-ua-title">Codex User-Agent</h4>
      <span className="cli-ua-state" role="status">{busy === "read" ? "正在读取…" : busy === "sync" ? "正在同步…" : ready ? data.matches ? "已一致" : "未同步" : "待读取"}</span>
    </div>
    <dl className="cli-ua-values">
      <div><dt>当前 CLI UA</dt><dd><code>{data?.cli?.userAgent || (data?.cli?.error ? "暂未读取成功" : "—")}</code></dd></div>
      <div><dt>号池 UA</dt><dd><code>{data?.gateway?.userAgent === "" ? "未设置（空值）" : data?.gateway?.userAgent || (data?.gateway?.error ? "暂未读取成功" : "—")}</code></dd></div>
    </dl>
    <p className="cli-auth-note">读取部署的 CLI 实际 UA；缓存 10 分钟，点“重新读取”可强制刷新。授权时不自动同步。同步按钮立即更新当前号池的全局 OpenAI Codex UA，不改变授权方式。</p>
    {data?.cli?.checkedAt && <p className="cli-auth-note">CLI {data.cli.version} · 读取时间：<time dateTime={data.cli.checkedAt}>{displayDateTime(data.cli.checkedAt)}</time></p>}
    {data?.gateway?.configured === false && <p className="cli-auth-note">{data.gateway.error}</p>}
    {errors.length > 0 && <p className="cli-ua-error" role="alert">{errors.join("；")}</p>}
    {notice && <p className="cli-auth-note" role="status">{notice}</p>}
    <div className="cli-ua-actions">
      <button type="button" className="cancel-button" disabled={Boolean(busy) || disabled} onClick={() => act("read")}><RefreshCw size={14} aria-hidden="true" />重新读取</button>
      <button type="button" className="cancel-button" disabled={Boolean(busy) || disabled || !ready || data.matches} onClick={() => act("sync")}><ArrowRight size={14} aria-hidden="true" />同步 CLI UA 到号池</button>
    </div>
  </section>;
}
