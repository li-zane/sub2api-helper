import React, { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

export function SmsNumberEstimate({ token, endpoint, config, disabled = false }) {
  useDisplayTimeZone();
  const selectionMode = config.selectionMode || "country";
  const input = { apiKey: String(config.apiKey || "").trim(), service: config.service || "dr", selectionMode,
    country: selectionMode === "global" ? "" : String(config.country || ""), maxPrice: String(config.maxPrice || "").trim() };
  const context = JSON.stringify([endpoint, token, input]);
  const latest = useRef(context), pending = useRef(null);
  latest.current = context;
  const [state, setState] = useState(null);
  const current = state?.context === context ? state : null;
  const ready = Boolean(token && /^[a-zA-Z0-9._-]{8,256}$/.test(input.apiKey) && /^\d{1,12}(?:\.\d{1,6})?$/.test(input.maxPrice) && Number(input.maxPrice) > 0 &&
    ["country", "global"].includes(selectionMode) && (selectionMode === "global" || /^\d{1,5}$/.test(input.country)));
  async function query() {
    if (!ready || disabled || pending.current?.context === context) return;
    pending.current?.controller.abort();
    const request = { context, controller: new AbortController() }; pending.current = request;
    setState(before => ({ context, loading: true, estimate: before?.context === context ? before.estimate : null, fetchedAt: before?.context === context ? before.fetchedAt : null, error: "" }));
    const active = () => pending.current === request && latest.current === context && !request.controller.signal.aborted;
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "x-console-token": token, "content-type": "application/json" }, body: JSON.stringify({ config: input }), signal: request.controller.signal });
      const data = await response.json().catch(() => ({})), estimate = data.estimate;
      if (!response.ok) throw new Error(data.error || `库存预估失败（HTTP ${response.status}）`);
      const numbers = [estimate?.totalCount, estimate?.countryCount, estimate?.providerCount, ...["gold", "silver", "bronze"].map(rank => estimate?.byRank?.[rank])];
      if (!numbers.every(n => Number.isSafeInteger(n) && n >= 0) || estimate.totalCount !== estimate.byRank.gold + estimate.byRank.silver + estimate.byRank.bronze) throw new Error("库存预估返回格式不正确");
      if (active()) setState({ context, loading: false, estimate, fetchedAt: data.fetchedAt, error: "" });
    } catch (error) { if (active()) setState(before => ({ ...before, context, loading: false, error: error.message })); }
    finally { if (pending.current === request) pending.current = null; }
  }
  useEffect(() => {
    const timer = ready && !disabled ? window.setTimeout(() => void query(), 600) : null;
    return () => { window.clearTimeout(timer); if (pending.current?.context === context) { pending.current.controller.abort(); pending.current = null; } };
  }, [context, disabled]);
  const estimate = current?.estimate, number = value => value.toLocaleString("zh-CN");
  return <section className="sms-balance-panel" aria-label="号码库存预估">
    <div className="sms-balance-row">
      <span className="sms-balance-value" role="status" aria-live="polite" title={current?.fetchedAt ? `预估时间：${displayDateTime(current.fetchedAt)}` : undefined}>
        {estimate ? `预估可用约 ${number(estimate.totalCount)} 个${current.error ? "（上次预估）" : ""}` : current?.loading ? "正在预估可用号码…" : ready ? "等待预估…" : "填写价格上限后预估可用数量"}
      </span>
      <button type="button" className="price-refresh-button" onClick={query} disabled={disabled || !ready || current?.loading}>
        <RefreshCw size={15} className={current?.loading ? "spin" : ""} aria-hidden="true" />刷新预估
      </button>
    </div>
    {estimate && <div className="sms-price-note">Gold {number(estimate.byRank.gold)} · Silver {number(estimate.byRank.silver)} · Bronze {number(estimate.byRank.bronze)} · {estimate.countryCount} 个国家</div>}
    <div className="sms-price-note">库存为平台合计估算，可能共享；预估不买号，实际以取号为准。</div>
    {current?.error && <p className="dialog-error" role="alert">{current.error}</p>}
  </section>;
}
