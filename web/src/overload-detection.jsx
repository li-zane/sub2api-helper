import React, { useEffect, useLayoutEffect, useState, useRef, useMemo } from "react";
import { buildOverloadChart } from "./overload-chart.mjs";
import { overloadGrid } from "./overload-grid.mjs";
import { overloadDashboard, overloadEnergy } from "./codex-dashboard.mjs";
import { codexStatusEligible, codexStatusBlockReason } from "./codex-eligibility.mjs";
import { displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

function intervalLabel(point) {
  const format = (value) => displayDateTime(value, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${format(point.start)} – ${format(point.end)}`;
}

export function OverloadDetection({ job, token, onError }) {
  useDisplayTimeZone();
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [saved, setSaved] = useState(null);
  const [cooldownBusy, setCooldownBusy] = useState(false);
  const [savedCooldown, setSavedCooldown] = useState(null);
  const plotRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tooltipOffset, setTooltipOffset] = useState(0);

  useEffect(() => {
    if (hovered === null) return;
    function handleClickOutside(event) {
      if (plotRef.current && !plotRef.current.contains(event.target)) {
        setHovered(null);
      }
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setHovered(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [hovered !== null]);
  const source = job.overloadDetection;
  useEffect(() => {
    if (source) setSaved((current) => !current || (source.revision ?? 0) > (current.revision ?? 0) ? source : current);
  }, [source?.revision]);
  // Keep the latest switch revision even after its poll acknowledgement: an older
  // request may still complete later and must never undo the visible saved state.
  const detection = saved && (saved.revision ?? 0) > (source?.revision ?? -1) ? saved : source || saved;
  const eligible = codexStatusEligible(job);
  const enabled = eligible && detection?.enabled === true;
  const cooldownSource = job.overloadAutoCooldown;
  useEffect(() => {
    if (cooldownSource) setSavedCooldown(current => !current || cooldownSource.revision >= current.revision ? cooldownSource : current);
  }, [cooldownSource?.revision, cooldownSource?.settings]);
  const cooldown = savedCooldown && (savedCooldown.revision ?? 0) > (cooldownSource?.revision ?? -1) ? savedCooldown : cooldownSource || savedCooldown;
  const cooldownEnabled = eligible && cooldown?.enabled === true;
  const points = detection?.points || [];
  const grid = overloadGrid(detection?.bucketMinutes);
  const dashboard = useMemo(() => overloadDashboard(detection, cooldown), [detection, cooldown]);
  const { positioned, hitWidth, overloadSegments, requestSegments } = useMemo(() => buildOverloadChart(points), [points]);
  const active = hovered === null ? null : positioned[hovered];
  const errors = [detection?.lastError ? `过载统计：${detection.lastError}` : null,
    detection?.requestError ? `请求统计：${detection.requestError}` : null].filter(Boolean).join("；");

  useLayoutEffect(() => {
    if (!active || !tooltipRef.current || !plotRef.current) return;
    const position = () => {
      const plot = plotRef.current.getBoundingClientRect();
      const frame = plotRef.current.closest(".table-frame")?.getBoundingClientRect();
      const width = tooltipRef.current.getBoundingClientRect().width;
      const left = Math.max(8, (frame?.left ?? 0) + 8);
      const right = Math.min(window.innerWidth - 8, (frame?.right ?? window.innerWidth) - 8);
      setTooltipOffset(Math.max(left - plot.left, Math.min(0, right - plot.left - width)));
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [active?.start, detection?.overloadUpdatedAt, detection?.requestUpdatedAt, errors]);

  async function toggle() {
    if (busy || !eligible) return;
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
    if (cooldownBusy || !eligible) return;
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
      <div className="overload-control overload-toggle-control"><span>过载</span>
      <button
        type="button" role="switch" aria-checked={enabled}
        aria-label={`${job.email} 过载检测`} aria-busy={busy}
        title={!eligible ? codexStatusBlockReason(job) : detection?.configured ? (enabled ? "停止过载检测" : "开启过载检测") : "请先配置 Sub2API 后端"}
        className={`overload-switch ${enabled ? "enabled" : "disabled"}`}
        disabled={!eligible || busy || !token || (!detection?.configured && !enabled)} onClick={toggle}
      ><span aria-hidden="true" /></button>
      </div>
      <div className="overload-control cooldown-toggle-control"><span>冷却</span><button type="button" role="switch" aria-checked={cooldownEnabled} aria-busy={cooldownBusy}
        aria-label={`${job.email} 自动冷却`} className={`overload-switch ${cooldownEnabled ? "enabled" : "disabled"}`}
        title={!eligible ? codexStatusBlockReason(job) : cooldown?.configured ? (cooldownEnabled ? "关闭自动冷却，并恢复本功能暂停的账号" : "开启过载自动冷却") : "请先配置 Sub2API 后端"}
        disabled={!eligible || cooldownBusy || !token || (!cooldown?.configured && !cooldownEnabled)} onClick={toggleCooldown}><span aria-hidden="true" /></button></div>
      </div>
      <div className="overload-chart-status">
      <div className="overload-dashboard overload-chart">
      <OverloadEnergy value={dashboard.quarter} enabled={enabled} />
      <div className="overload-plot" ref={plotRef}>
        <svg viewBox="0 0 164 56" role="group" aria-label={`${grid.historyMinutes} 分钟刻度的过载与请求数量，每格按过载统计窗口 ${grid.bucketMinutes} 分钟，当前格累计至最近同步，两条线独立缩放`}>
          <line className="overload-zero" x1="10" x2="156" y1="44" y2="44" />
          {overloadSegments.map((values, index) => <polyline key={index} className="overload-line" points={values} />)}
          {requestSegments.map((values, index) => <polyline key={index} className="overload-request-line" points={values} />)}
          {positioned.map((point, index) => (
            <g key={point.start} className="overload-point" tabIndex="0" role="img"
              aria-label={`${intervalLabel(point)}；过载 ${point.count ?? "未统计"}；请求 ${point.requestCount ?? "未统计"}${point.requestEnd && point.requestEnd !== point.end ? `；请求统计区间 ${intervalLabel({ start: point.requestStart, end: point.requestEnd })}` : ""}`}
              onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
              onClick={() => setHovered(index)} onKeyDown={(event) => { if (event.key === "Escape") setHovered(null); }}>
              <rect className="overload-hit-area" x={point.x - hitWidth / 2} y="0" width={hitWidth} height="56" />
              {point.y !== null && <circle className={`overload-dot ${hovered === index ? "active" : ""}`} cx={point.x} cy={point.y} r={hovered === index ? 3.5 : 2.5} />}
              {point.requestY !== null && <circle className="overload-request-dot" cx={point.x} cy={point.requestY} r={hovered === index ? 4.5 : 3.5} />}
            </g>
          ))}
        </svg>
        {active && <div className={`overload-tooltip point-${hovered}`} role="tooltip" ref={tooltipRef} style={{ left: tooltipOffset }}>
          <span>{intervalLabel(active)}</span>
          {detection?.overloadUpdatedAt && <span>过载统计至：{displayDateTime(detection.overloadUpdatedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <strong className="overload-tooltip-count"><i aria-hidden="true" />过载 <b>{active.count === null ? "未统计" : `${active.count} 次`}</b></strong>
          {active.requestEnd && active.requestEnd !== active.end && <span>请求区间：{intervalLabel({ start: active.requestStart, end: active.requestEnd })}</span>}
          <strong className="overload-tooltip-requests"><i aria-hidden="true" />请求 <b>{active.requestCount === null || active.requestCount === undefined ? "未统计" : `${active.requestCount} 次`}</b></strong>
          {detection?.requestUpdatedAt && <span>请求统计至：{displayDateTime(detection.requestUpdatedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <span className="overload-scale-note">{errors ? "同步异常，保留上次成功数据；" : ""}独立缩放</span>
        </div>}
        {errors && <span className="overload-error" role="img" aria-label={errors} title={errors}>!</span>}
      </div>
      <OverloadEnergy value={dashboard.total} enabled={enabled} />
      </div>
      {cooldown && (cooldown.lastError || cooldown.phase === "resuming" || cooldown.coolingUntil) && <span className={`overload-cooldown-status ${cooldown.lastError ? "error" : ""}`} title={cooldown.lastError || "自动冷却状态"}>
        {cooldown.lastError ? "自动冷却异常" : cooldown.phase === "resuming" ? "正在恢复号池…" : cooldown.phase === "refreshing" ? "重登授权后恢复…" : `冷却至 ${displayDateTime(cooldown.coolingUntil, { hour: "2-digit", minute: "2-digit" })}`}
      </span>}
      </div>
    </div>
  );
}

function OverloadEnergy({ value, enabled }) {
  const energy = overloadEnergy(value.count, value.limit, enabled);
  const title = `${value.period} 过载；${value.source}；${value.count ?? "未统计"} 次 / 阈值 ${value.limit ?? "未知"} 次${value.end ? `；统计至 ${displayDateTime(value.end)}` : ""}${enabled ? "" : "；过载检测已关闭"}`;
  return <div className={`codex-energy ${energy.tone}`} title={title}>
    <div className="codex-energy-track" role="meter" aria-label={`${value.period} 过载次数`} aria-valuemin={0} aria-valuemax={value.limit ?? undefined} aria-valuenow={energy.known ? Math.min(value.count, value.limit) : undefined} aria-valuetext={title}>
      <span className="codex-energy-fill" style={{ height: `${energy.ratio * 100}%`, background: energy.color }} />
    </div>
  </div>;
}
