import React, { useEffect, useState } from "react";
import { buildOverloadChart } from "./overload-chart.mjs";

function intervalLabel(point) {
  const format = (value) => new Date(value).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${format(point.start)} – ${format(point.end)}`;
}

export function OverloadDetection({ job, token, onError }) {
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [saved, setSaved] = useState(null);
  const [cooldownBusy, setCooldownBusy] = useState(false);
  const [savedCooldown, setSavedCooldown] = useState(null);
  const source = job.overloadDetection;
  useEffect(() => {
    if (source) setSaved((current) => !current || (source.revision ?? 0) > (current.revision ?? 0) ? source : current);
  }, [source?.revision]);
  // Keep the latest switch revision even after its poll acknowledgement: an older
  // request may still complete later and must never undo the visible saved state.
  const detection = saved && (saved.revision ?? 0) > (source?.revision ?? -1) ? saved : source || saved;
  const enabled = detection?.enabled === true;
  const cooldownSource = job.overloadAutoCooldown;
  useEffect(() => {
    if (cooldownSource) setSavedCooldown(current => !current || cooldownSource.revision >= current.revision ? cooldownSource : current);
  }, [cooldownSource?.revision, cooldownSource?.settings]);
  const cooldown = savedCooldown && (savedCooldown.revision ?? 0) > (cooldownSource?.revision ?? -1) ? savedCooldown : cooldownSource || savedCooldown;
  const cooldownEnabled = cooldown?.enabled === true;
  const points = detection?.points || [];
  const { positioned, overloadSegments, requestSegments } = buildOverloadChart(points);
  const active = hovered === null ? null : positioned[hovered];
  const errors = [detection?.lastError ? `过载统计：${detection.lastError}` : null,
    detection?.requestError ? `请求统计：${detection.requestError}` : null].filter(Boolean).join("；");

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/overload-detection`, {
        method: "POST", headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "过载检测开关保存失败");
      setSaved(data.job.overloadDetection);
      onError("");
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  }

  async function toggleCooldown() {
    if (cooldownBusy) return;
    setCooldownBusy(true);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/overload-auto-cooldown`, {
        method: "POST", headers: { "content-type": "application/json", "x-console-token": token }, body: JSON.stringify({ enabled: !cooldownEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "自动冷却开关保存失败");
      setSavedCooldown(data.job.overloadAutoCooldown);
      onError("");
    } catch (error) { onError(error.message); }
    finally { setCooldownBusy(false); }
  }

  return (
    <div className="overload-detection">
      <div className="overload-controls">
      <div className="overload-control"><span>检测</span>
      <button
        type="button" role="switch" aria-checked={enabled}
        aria-label={`${job.email} 过载检测`} aria-busy={busy}
        title={detection?.configured ? (enabled ? "停止过载检测" : "开启过载检测") : "请先配置 Sub2API 后端"}
        className={`overload-switch ${enabled ? "enabled" : "disabled"}`}
        disabled={busy || !token || (!detection?.configured && !enabled)} onClick={toggle}
      ><span aria-hidden="true" /></button>
      </div>
      <div className="overload-control"><span>冷却</span><button type="button" role="switch" aria-checked={cooldownEnabled} aria-busy={cooldownBusy}
        aria-label={`${job.email} 自动冷却`} className={`overload-switch ${cooldownEnabled ? "enabled" : "disabled"}`}
        title={cooldown?.configured ? (cooldownEnabled ? "关闭自动冷却，并恢复本功能暂停的账号" : "开启过载自动冷却") : "请先配置 Sub2API 后端"}
        disabled={cooldownBusy || !token || (!cooldown?.configured && !cooldownEnabled)} onClick={toggleCooldown}><span aria-hidden="true" /></button></div>
      </div>
      <div className="overload-chart-status">
      <div className="overload-chart">
        <svg viewBox="0 0 164 56" role="group" aria-label="最近六个完整的 15 分钟区间的过载与请求数量，两条线独立缩放">
          <line className="overload-zero" x1="14" x2="156" y1="44" y2="44" />
          <text className="overload-zero-label" x="1" y="48">0</text>
          {overloadSegments.map((values, index) => <polyline key={index} className="overload-line" points={values} />)}
          {requestSegments.map((values, index) => <polyline key={index} className="overload-request-line" points={values} />)}
          {positioned.map((point, index) => (
            <g key={point.start} className="overload-point" tabIndex="0" role="img"
              aria-label={`${intervalLabel(point)}；过载 ${point.count ?? "未统计"}；请求 ${point.requestCount ?? "未统计"}`}
              onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
              onClick={() => setHovered(index)} onKeyDown={(event) => { if (event.key === "Escape") setHovered(null); }}>
              <rect className="overload-hit-area" x={point.x - 13} y="0" width="26" height="56" />
              {point.y !== null && <circle className={`overload-dot ${hovered === index ? "active" : ""}`} cx={point.x} cy={point.y} r={hovered === index ? 3.5 : 2.5} />}
              {point.requestY !== null && <circle className="overload-request-dot" cx={point.x} cy={point.requestY} r={hovered === index ? 4.5 : 3.5} />}
            </g>
          ))}
        </svg>
        {active && <div className={`overload-tooltip point-${hovered}`} role="tooltip">
          <span>{intervalLabel(active)}</span>
          <strong className="overload-tooltip-count"><i aria-hidden="true" />过载 <b>{active.count === null ? "未统计" : `${active.count} 次`}</b></strong>
          <strong className="overload-tooltip-requests"><i aria-hidden="true" />请求 <b>{active.requestCount === null || active.requestCount === undefined ? "未统计" : `${active.requestCount} 次`}</b></strong>
          <span className="overload-scale-note">独立缩放</span>
        </div>}
        {errors && <span className="overload-error" role="img" aria-label={errors} title={errors}>!</span>}
      </div>
      {cooldown && <span className={`overload-cooldown-status ${cooldown.lastError ? "error" : ""}`} title={cooldown.lastError || (cooldownEnabled ? `最近 ${cooldown.settings.windowMinutes} 分钟 ${cooldown.windowCount ?? "未知"} 次，阈值 ${cooldown.settings.threshold} 次` : "自动冷却已关闭")}>
        {cooldown.lastError ? "自动冷却异常" : cooldown.phase === "resuming" ? "正在恢复号池…" : cooldown.coolingUntil ? `冷却至 ${new Date(cooldown.coolingUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}` : cooldownEnabled ? `${cooldown.settings.windowMinutes} 分钟 ${cooldown.windowCount ?? "—"}/${cooldown.settings.threshold} 次` : ""}
      </span>}
      </div>
    </div>
  );
}
