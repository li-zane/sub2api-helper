import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, Copy, History, KeyRound, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { notify } from "./toast-events.mjs";
import { compactDateTime, displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";
import { accountProfitCents, formatAccountCost, formatCnyCents } from "./account-pricing.mjs";
import { shareJobList } from "./polling-snapshot.mjs";
import "./subscription-history.css";

const REFRESH_INTERVAL_MS = 5_000;
const COPIED_BADGE_DURATION_MS = 1_800;
const FREE_PLAN_VALUES = new Set(["free", "free_plan", "chatgptfreeplan"]);
const NON_SUBSCRIPTION_PLANS = new Set(["free", "free_plan", "chatgptfreeplan", "unknown", "null", "undefined", "none", "n/a"]);

function fallbackCopyInDialog(text) {
  const host = document.querySelector("dialog[open]") || document.body;
  if (!host) throw new Error("clipboard unavailable");
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  host.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

async function copyValue(value, copyTextFn) {
  const text = String(value ?? "");
  if (typeof copyTextFn === "function") {
    try {
      await copyTextFn(text);
      return;
    } catch (error) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) throw error;
    }
  } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  fallbackCopyInDialog(text);
}

export function parseProfitCents(profitCents, userCostUsd, poolPriceMultiplier, accountCostCny) {
  if (typeof profitCents === "string" && /^-?\d+$/.test(profitCents.trim())) {
    return BigInt(profitCents.trim());
  }
  if (typeof profitCents === "bigint") return profitCents;
  if (typeof profitCents === "number" && Number.isInteger(profitCents)) return BigInt(profitCents);
  return accountProfitCents(userCostUsd, poolPriceMultiplier ?? 1, accountCostCny ?? 0);
}

const QUALITY_LABELS = { normal: "未降智", degraded: "降智", recovered: "已恢复" };
const CHECK_LABELS = { match: "未降智", mismatch: "降智", unknown: "结果未确认", error: "检测失败" };
const CHECK_METHODS = { fingerprint: "指纹", candy: "糖果题" };
const CHECK_SOURCES = { manual: "手动", scheduled: "定时", import: "导入后" };

function qualityLabel(quality) {
  return QUALITY_LABELS[quality?.kind] || (quality?.lastCheckedAt ? "尚无确认状态" : "未检测");
}

function QualityCheckLog({ recordId, request }) {
  const [records, setRecords] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(null);
  const inFlight = useRef(null);

  const read = useCallback(async (before) => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    setFailed(null);
    try {
      const base = `/api/subscription-history/${encodeURIComponent(recordId)}/quality`;
      const url = before ? `${base}?before=${encodeURIComponent(before)}` : base;
      const data = await request(url, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setRecords(previous => before ? [...previous, ...data.records] : data.records);
      setNextBefore(data.nextBefore);
    } catch {
      if (!controller.signal.aborted) setFailed({ before });
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [recordId, request]);

  useEffect(() => {
    void read(null);
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [read]);

  return (
    <div className="sub-quality-logs" aria-busy={loading}>
      {records.length > 0 && (
        <ul aria-label="逐次检测记录">
          {records.map(record => (
            <li key={record.id}>
              <span className={`sub-quality-verdict is-${record.status}`}>{CHECK_LABELS[record.status]}</span>
              <time dateTime={record.at}>{displayDateTime(record.at)}</time>
              <span>{[CHECK_METHODS[record.method], CHECK_SOURCES[record.source]].filter(Boolean).join(" · ") || "来源未记录"}</span>
            </li>
          ))}
        </ul>
      )}
      {loading && <span role="status">正在读取检测记录…</span>}
      {failed && (
        <div role="alert">读取检测记录失败 <button type="button" className="sub-quality-link" onClick={() => void read(failed.before)}>重试</button></div>
      )}
      {!loading && !failed && !records.length && <p>暂无逐次检测记录</p>}
      {!loading && !failed && nextBefore && (
        <button type="button" className="sub-quality-link" onClick={() => void read(nextBefore)}>加载更早记录</button>
      )}
    </div>
  );
}

function QualityDrawer({ id, record, request, onClose }) {
  const [showChecks, setShowChecks] = useState(false);
  const quality = record.quality;
  const timeline = quality?.timeline || [];
  const heading = `${id}-title`;
  return (
    <section id={id} className="sub-quality-drawer" aria-labelledby={heading}>
      <div className="sub-quality-drawer-head">
        <h3 id={heading}>降智状态变化</h3>
        <button type="button" className="sub-quality-link" onClick={onClose}>收起降智历史</button>
      </div>
      {quality?.lastCheckedAt && <p className="sub-quality-meta">最近检测 <time dateTime={quality.lastCheckedAt}>{displayDateTime(quality.lastCheckedAt)}</time></p>}
      {timeline.length ? (
        <ol className="sub-quality-timeline" aria-label="降智状态时间线">
          {timeline.map((event, index) => {
            const label = event.status === "mismatch" ? "观测到降智" : event.previousStatus === "mismatch" ? "观测到恢复" : "确认未降智";
            const prior = timeline[index - 1];
            const minutes = event.previousStatus === "mismatch" && prior
              ? Math.floor((Date.parse(event.at) - Date.parse(prior.at)) / 60_000) : null;
            const interval = minutes === null ? null : minutes < 1 ? "不足 1 分钟" :
              minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`;
            return (
              <li key={`${event.at}:${index}`} className={`is-${event.status}${event.method ? "" : " is-legacy"}`}>
                <strong>{label}</strong>
                <time dateTime={event.at}>{displayDateTime(event.at)}</time>
                {(event.method || interval) && (
                  <span>{[CHECK_METHODS[event.method], interval && `距本段首次观测到降智 ${interval}`].filter(Boolean).join(" · ")}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : <p className="sub-quality-meta">暂无确认的降智状态</p>}
      {timeline.some(event => !event.method) && <p className="sub-quality-meta">较早记录可能只保留状态变化</p>}
      <button type="button" className="sub-quality-link" aria-expanded={showChecks}
        aria-controls={showChecks ? `${id}-checks` : undefined} onClick={() => setShowChecks(value => !value)}>
        {showChecks ? "收起逐次检测" : "查看逐次检测"}
      </button>
      {showChecks && <div id={`${id}-checks`}><QualityCheckLog recordId={record.id} request={request} /></div>}
    </section>
  );
}
export function profitTone(cents) {
  if (cents === null) return "unknown";
  if (cents > 0n) return "positive";
  if (cents < 0n) return "negative";
  return "zero";
}

function planTone(rawPlan) {
  const normalized = String(rawPlan || "").trim().toLowerCase();
  if (!normalized) return "default";
  if (FREE_PLAN_VALUES.has(normalized)) return "free";
  if (normalized.includes("business")) return "business";
  if (normalized.includes("team")) return "team";
  if (normalized.includes("pro") || normalized.includes("enterprise")) return "pro";
  if (normalized.includes("plus")) return "plus";
  return "default";
}

function defaultFormatPlanType(value) {
  const raw = String(value || "").trim();
  return raw || "未知";
}

export function subscriptionStatusInfo(record, formatPlanType = defaultFormatPlanType) {
  const currentRaw = String(record?.planType || "").trim();
  const paidRaw = String(record?.lastPaidPlanType || "").trim();
  const normalizedCurrent = currentRaw.toLowerCase();
  const normalizedPaid = paidRaw.toLowerCase();
  const paidLabel = formatPlanType(paidRaw || currentRaw);
  const currentLabel = currentRaw ? formatPlanType(currentRaw) : "";

  if (record?.accountBanned) {
    return { kind: "banned", badgeText: "已封禁", planLabel: paidLabel,
      rawPlan: paidRaw || currentRaw, detail: `账号已封禁，原订阅 ${paidLabel}` };
  }
  if (!record?.present && !FREE_PLAN_VALUES.has(normalizedCurrent)) {
    return {
      kind: "removed",
      badgeText: "已删除",
      planLabel: paidLabel,
      rawPlan: paidRaw || currentRaw,
      detail: `原订阅 ${paidLabel}，已从主列表删除`,
    };
  }
  if (!normalizedCurrent || NON_SUBSCRIPTION_PLANS.has(normalizedCurrent) && !FREE_PLAN_VALUES.has(normalizedCurrent)) {
    return {
      kind: "unknown",
      badgeText: "待确认",
      planLabel: paidLabel,
      rawPlan: paidRaw,
      detail: `曾订阅 ${paidLabel}，当前套餐待确认`,
    };
  }
  if (FREE_PLAN_VALUES.has(normalizedCurrent)) {
    return {
      kind: "downgraded",
      badgeText: "已降为 Free",
      planLabel: paidLabel,
      rawPlan: paidRaw || currentRaw,
      detail: `曾订阅 ${paidLabel}，当前已降为 ${currentLabel || "Free"}`,
    };
  }
  if (normalizedCurrent && normalizedPaid && normalizedCurrent !== normalizedPaid && !NON_SUBSCRIPTION_PLANS.has(normalizedCurrent)) {
    return {
      kind: "changed",
      badgeText: `当前 ${currentLabel}`,
      planLabel: paidLabel,
      rawPlan: currentRaw,
      detail: `曾订阅 ${paidLabel}，当前为 ${currentLabel}`,
    };
  }
  return {
    kind: "active",
    badgeText: "当前订阅",
    planLabel: paidLabel,
    rawPlan: paidRaw || currentRaw,
    detail: `当前订阅中（${paidLabel}）`,
  };
}

export function matchesSubscriptionSearch(record, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  const email = String(record?.email || "").toLowerCase();
  const remark = String(record?.remark || "").toLowerCase();
  return email.includes(normalized) || remark.includes(normalized);
}

function formatCostDisplay(value) {
  if (value === null || value === undefined || value === "") return "—";
  try {
    return formatAccountCost(value);
  } catch {
    return "—";
  }
}

function formatRecordTimeSummary(record) {
  const first = record?.firstSubscribedAt;
  const updated = record?.updatedAt;
  const firstCompact = first ? compactDateTime(first) : "";
  const updatedCompact = updated ? compactDateTime(updated) : "";
  const hasFirst = Boolean(firstCompact && firstCompact !== "-");
  const hasUpdated = Boolean(updatedCompact && updatedCompact !== "-");

  let label = "";
  if (hasFirst && hasUpdated && firstCompact !== updatedCompact) {
    label = `首次订阅 ${firstCompact} · 更新 ${updatedCompact}`;
  } else if (hasFirst) {
    label = `首次订阅 ${firstCompact}`;
  } else if (hasUpdated) {
    label = `更新于 ${updatedCompact}`;
  }

  const tooltipLines = [];
  if (first) tooltipLines.push(`首次订阅：${displayDateTime(first)}`);
  if (updated) tooltipLines.push(`最近更新：${displayDateTime(updated)}`);

  return { label, title: tooltipLines.join("\n") };
}

function subscriptionChangeLabel(change, formatPlanType) {
  const labels = [];
  if (change.types?.includes("subscription")) labels.push(`${formatPlanType(change.fromPlanType)} → ${formatPlanType(change.toPlanType)}`);
  if (change.types?.includes("banned")) labels.push("账号封禁");
  if (change.types?.includes("recovered")) labels.push("封禁解除");
  return labels.join(" · ");
}

export function SubscriptionHistoryDialog({
  open = true,
  token,
  request,
  copyText,
  formatPlanType = defaultFormatPlanType,
  onTotalChange,
  onClose,
}) {
  useDisplayTimeZone();
  const titleId = useId();

  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [copyingId, setCopyingId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [highlightedChanges, setHighlightedChanges] = useState({});
  const [expandedQualityId, setExpandedQualityId] = useState(null);

  const openRef = useRef(open);
  openRef.current = open;
  const aliveRef = useRef(false);
  const epochRef = useRef(0);
  const listSeqRef = useRef(0);
  const listAbortRef = useRef(null);
  const credSeqRef = useRef(0);
  const credAbortRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const loadHistoryRef = useRef(null);
  const loadedEpochRef = useRef(0);
  const acknowledgedRef = useRef(new Set());
  const seenAbortRef = useRef(new Set());
  const onTotalChangeRef = useRef(onTotalChange);
  onTotalChangeRef.current = onTotalChange;

  const clearCopiedTimer = useCallback(() => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    loadedEpochRef.current = 0;
    for (const controller of seenAbortRef.current) controller.abort();
    seenAbortRef.current.clear();
    acknowledgedRef.current = new Set();
    if (!open) {
      aliveRef.current = false;
      epochRef.current += 1;
      listSeqRef.current += 1;
      credSeqRef.current += 1;
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      credAbortRef.current?.abort();
      credAbortRef.current = null;
      clearCopiedTimer();
      loadHistoryRef.current = null;
      return undefined;
    }

    aliveRef.current = true;
    const epoch = ++epochRef.current;
    listSeqRef.current += 1;
    credSeqRef.current += 1;
    listAbortRef.current?.abort();
    listAbortRef.current = null;
    credAbortRef.current?.abort();
    credAbortRef.current = null;
    clearCopiedTimer();

    // Reset state immediately when opening or switching token so stale data never leaks across sessions.
    setRecords([]);
    setTotal(null);
    setHasLoaded(false);
    setLoading(Boolean(token));
    setRefreshing(false);
    setError(token ? "" : "缺少控制台访问令牌，无法读取历史订阅");
    setCopyingId(null);
    setCopiedId(null);
    setLastUpdatedAt(null);
    setHighlightedChanges({});
    setExpandedQualityId(null);

    if (!token || typeof request !== "function") {
      if (token) {
        setLoading(false);
        setError("历史订阅请求器未就绪");
      }
      return () => {
        aliveRef.current = false;
        epochRef.current += 1;
      };
    }

    const loadHistory = async ({ background = false, replace = false } = {}) => {
      if (background && !replace && listAbortRef.current) return;
      const seq = ++listSeqRef.current;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;

      if (background) setRefreshing(true);
      else {
        setLoading(true);
        setError("");
      }

      try {
        const data = await request("/api/subscription-history", { signal: controller.signal });
        if (!aliveRef.current || !openRef.current || epoch !== epochRef.current || seq !== listSeqRef.current || controller.signal.aborted) {
          return;
        }
        const nextRecords = Array.isArray(data?.records) ? data.records : [];
        const nextTotal = typeof data?.total === "number" && Number.isFinite(data.total) ? data.total : nextRecords.length;
        setRecords((current) => shareJobList(current, nextRecords));
        loadedEpochRef.current = epoch;
        setTotal(nextTotal);
        setHasLoaded(true);
        setError("");
        setLastUpdatedAt(new Date().toISOString());
        onTotalChangeRef.current?.(nextTotal);
      } catch (requestError) {
        if (
          requestError?.name === "AbortError"
          || controller.signal.aborted
          || !aliveRef.current
          || !openRef.current
          || epoch !== epochRef.current
          || seq !== listSeqRef.current
        ) {
          return;
        }
        setError(requestError?.message || "历史订阅读取失败");
      } finally {
        if (listAbortRef.current === controller) listAbortRef.current = null;
        if (aliveRef.current && openRef.current && epoch === epochRef.current && seq === listSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    loadHistoryRef.current = loadHistory;
    void loadHistory({ background: false });

    const timer = window.setInterval(() => {
      void loadHistory({ background: true });
    }, REFRESH_INTERVAL_MS);

    const handleFocus = () => {
      void loadHistory({ background: true, replace: true });
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      aliveRef.current = false;
      epochRef.current += 1;
      listSeqRef.current += 1;
      credSeqRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      credAbortRef.current?.abort();
      credAbortRef.current = null;
      for (const controller of seenAbortRef.current) controller.abort();
      seenAbortRef.current.clear();
      clearCopiedTimer();
      loadHistoryRef.current = null;
    };
  }, [open, token, request, clearCopiedTimer]);

  const filteredRecords = useMemo(
    () => records.filter((record) => matchesSubscriptionSearch(record, search)),
    [records, search],
  );

  useEffect(() => {
    if (!open || !hasLoaded || loadedEpochRef.current !== epochRef.current) return;
    const changes = filteredRecords.filter(record => record.lastChange?.unread)
      .map(record => ({ id: record.id, revision: record.lastChange.revision }));
    if (!changes.length) return;
    // Keep the highlight throughout this visit, even after a poll returns the saved read state.
    setHighlightedChanges(current => {
      if (changes.every(change => current[change.id] === change.revision)) return current;
      return { ...current, ...Object.fromEntries(changes.map(change => [change.id, change.revision])) };
    });
    const acknowledged = acknowledgedRef.current;
    const pending = changes.filter(change => !acknowledged.has(`${change.id}:${change.revision}`));
    for (const change of pending) acknowledged.add(`${change.id}:${change.revision}`);
    const epoch = epochRef.current;
    // Only rendered, search-visible records are acknowledged; GET never consumes notices.
    for (let offset = 0; offset < pending.length; offset += 500) {
      const batch = pending.slice(offset, offset + 500);
      const controller = new AbortController();
      seenAbortRef.current.add(controller);
      void request("/api/subscription-history/seen", {
        method: "POST", body: JSON.stringify({ changes: batch }), signal: controller.signal,
      }).catch(() => {
        if (epoch === epochRef.current) {
          for (const change of batch) acknowledged.delete(`${change.id}:${change.revision}`);
        }
      }).finally(() => seenAbortRef.current.delete(controller));
    }
  }, [open, hasLoaded, filteredRecords, lastUpdatedAt, request]);

  const handleRetry = useCallback(() => {
    if (!loadHistoryRef.current) return;
    void loadHistoryRef.current({ background: hasLoaded, replace: true });
  }, [hasLoaded]);

  const handleCopyEmail = useCallback(async (email) => {
    if (!email) return;
    try {
      await copyValue(email, copyText);
      if (!aliveRef.current || !openRef.current) return;
      notify("账号已复制");
    } catch {
      if (!aliveRef.current || !openRef.current) return;
      notify("账号复制失败，请手动选择复制", { tone: "error" });
    }
  }, [copyText]);

  const handleCopyCredentials = useCallback(async (record) => {
    if (!record?.id || !record.canCopyCredentials || copyingId === record.id) return;
    const epoch = epochRef.current;
    const seq = ++credSeqRef.current;
    credAbortRef.current?.abort();
    const controller = new AbortController();
    credAbortRef.current = controller;
    setCopyingId(record.id);

    try {
      const data = await request(`/api/subscription-history/${encodeURIComponent(record.id)}/credentials`, {
        signal: controller.signal,
      });
      if (!aliveRef.current || !openRef.current || epoch !== epochRef.current || seq !== credSeqRef.current || controller.signal.aborted) {
        return;
      }
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text) throw new Error("未获取到可复制的凭据内容");

      await copyValue(text, copyText);
      if (!aliveRef.current || !openRef.current || epoch !== epochRef.current || seq !== credSeqRef.current) {
        return;
      }

      clearCopiedTimer();
      setCopiedId(record.id);
      copiedTimerRef.current = window.setTimeout(() => {
        if (aliveRef.current && epoch === epochRef.current) {
          setCopiedId((current) => (current === record.id ? null : current));
        }
        copiedTimerRef.current = null;
      }, COPIED_BADGE_DURATION_MS);

      notify(record.email ? `已复制 ${record.email} 的凭据` : "凭据已复制");
    } catch (requestError) {
      if (
        requestError?.name === "AbortError"
        || controller.signal.aborted
        || !aliveRef.current
        || !openRef.current
        || epoch !== epochRef.current
        || seq !== credSeqRef.current
      ) {
        return;
      }
      notify(`复制凭据失败：${requestError?.message || "未知错误"}`, { tone: "error" });
    } finally {
      if (credAbortRef.current === controller) credAbortRef.current = null;
      if (aliveRef.current && openRef.current && epoch === epochRef.current && seq === credSeqRef.current) {
        setCopyingId((current) => (current === record.id ? null : current));
      }
    }
  }, [copyText, copyingId, request, clearCopiedTimer]);

  if (!open) return null;

  const totalCount = total ?? records.length;
  const normalizedSearch = search.trim();

  return (
    <AccessibleDialog
      className="subscription-history-dialog"
      labelledBy={titleId}
      onClose={onClose}
    >
      <div className="dialog-header sub-history-header">
        <div className="sub-history-heading">
          <div className="sub-history-title-row">
            <History size={18} className="sub-history-title-icon" aria-hidden="true" />
            <h2 id={titleId}>历史订阅</h2>
            <span className="task-count-badge" aria-label={`共 ${totalCount} 条历史订阅`}>
              {hasLoaded ? totalCount : "—"}
            </span>
          </div>
        </div>
        <div className="dialog-header-actions">
          <span
            className={`sub-history-sync-pill ${refreshing ? "is-syncing" : ""}`}
            title={lastUpdatedAt ? `每 5 秒及窗口聚焦自动刷新；最近更新 ${displayDateTime(lastUpdatedAt)}` : "每 5 秒及窗口聚焦自动刷新"}
          >
            {refreshing
              ? <LoaderCircle size={12} className="spin" aria-hidden="true" />
              : <i className="sub-history-live-dot" aria-hidden="true" />}
            <span>{refreshing ? "同步中…" : "自动更新"}</span>
          </span>
          <button
            type="button"
            className="icon-button"
            data-dialog-initial-focus
            onClick={onClose}
            title="关闭历史订阅"
            aria-label="关闭历史订阅"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {hasLoaded&&<div className="sub-outcomes" role="group" aria-label="历史订阅检测概览">
        {[["normal","未降智"],["degraded","观测降智"],["recovered","已恢复"],["unknown","未确认"]].map(([k,v])=><div key={k} className={"sub-outcome "+k}>
          <span>{v}</span><strong>{records.filter(r=>(r.quality?.kind||"unknown")===k).length}</strong></div>)}
      </div>}
      <div className="sub-history-toolbar">
        <div className="sub-history-search-box">
          <Search size={14} className="sub-history-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="sub-history-search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索邮箱或备注…"
            aria-label="搜索邮箱或备注"
            spellCheck="false"
          />
          {search && (
            <button
              type="button"
              className="sub-history-search-clear"
              onClick={() => setSearch("")}
              aria-label="清空搜索"
              title="清空搜索"
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="sub-history-meta" aria-live="polite">
          <span>
            {!hasLoaded
              ? (loading ? "加载中…" : "未加载")
              : normalizedSearch
                ? `匹配 ${filteredRecords.length} / ${records.length} 条`
                : `共 ${totalCount} 条`}
          </span>
          {lastUpdatedAt && (
            <>
              <span className="sub-history-meta-dot" aria-hidden="true" />
              <span title={`最近同步：${displayDateTime(lastUpdatedAt)}`}>
                {compactDateTime(lastUpdatedAt)} 同步
              </span>
            </>
          )}
        </div>
      </div>

      {error && hasLoaded && (
        <div className="sub-history-inline-error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>自动刷新失败，当前保留上次数据：{error}</span>
          <button type="button" className="sub-history-retry-link" onClick={handleRetry}>
            重试
          </button>
        </div>
      )}

      <div className="sub-history-body">
        {loading && !hasLoaded ? (
          <div className="sub-history-state" role="status" aria-live="polite">
            <LoaderCircle size={22} className="spin sub-history-state-icon" aria-hidden="true" />
            <strong>正在读取历史订阅…</strong>
            <span>正在获取已记录的付费账号、成本与利润信息</span>
          </div>
        ) : error && !hasLoaded ? (
          <div className="sub-history-state is-error" role="alert">
            <CircleAlert size={22} className="sub-history-state-icon" aria-hidden="true" />
            <strong>读取历史订阅失败</strong>
            <span>{error}</span>
            <button type="button" className="secondary-button compact-button" onClick={handleRetry}>
              <RefreshCw size={13} aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : records.length === 0 ? (
          <div className="sub-history-state">
            <History size={22} className="sub-history-state-icon" aria-hidden="true" />
            <strong>暂无历史订阅记录</strong>
            <span>当账号拥有过非 Free 付费套餐后会自动留档；之后降级或删除仍会保留在此。</span>
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="sub-history-state">
            <Search size={22} className="sub-history-state-icon" aria-hidden="true" />
            <strong>没有匹配的记录</strong>
            <span>未找到邮箱或备注包含“{normalizedSearch}”的历史订阅账号。</span>
            <button type="button" className="secondary-button compact-button" onClick={() => setSearch("")}>
              清空搜索
            </button>
          </div>
        ) : (
          <>
            <div className="sub-history-list-head" aria-hidden="true">
              <span>账号与备注</span>
              <span>套餐 / 状态</span>
              <span className="sub-history-head-num">成本</span>
              <span className="sub-history-head-num">利润</span>
              <span className="sub-history-head-action">凭据</span>
            </div>
            <div className="sub-history-list" role="list" aria-label="历史订阅账号列表">
              {filteredRecords.map((record) => {
                const status = subscriptionStatusInfo(record, formatPlanType);
                const costDisplay = formatCostDisplay(record.accountCostCny);
                const cents = parseProfitCents(
                  record.profitCents,
                  record.userCostUsd,
                  record.poolPriceMultiplier,
                  record.accountCostCny,
                );
                const tone = profitTone(cents);
                const profitText = typeof record.profitDisplay === "string" && record.profitDisplay.trim()
                  ? record.profitDisplay
                  : formatCnyCents(cents);
                const profitTitle = record.userCostUsd != null && record.poolPriceMultiplier != null
                  ? `利润 ${profitText} = U $${record.userCostUsd} × ${record.poolPriceMultiplier} 元/美元 − 成本 ${costDisplay}`
                  : cents === null
                    ? "暂无用量数据，无法计算利润"
                    : `利润 ${profitText}`;
                const timeInfo = formatRecordTimeSummary(record);
                const isCopying = copyingId === record.id;
                const isCopied = copiedId === record.id;
                const pTone = planTone(status.rawPlan);
                const change = record.lastChange;
                const isUnread = change && (change.unread || highlightedChanges[record.id] === change.revision);
                const drawerId = `${titleId}-quality-${record.id}`;
                const qualityOpen = expandedQualityId === record.id;
                const qualityClass = `sub-quality ${record.quality?.kind || "unknown"}`;
                const hasQuality = Boolean(record.quality?.lastCheckedAt || record.quality?.timeline?.length);
                const closeQuality = () => {
                  document.getElementById(`${drawerId}-trigger`)?.focus();
                  setExpandedQualityId(null);
                };

                return (
                  <div className={`sub-history-row${isUnread ? " is-unread" : ""}`} role="listitem" key={record.id} onKeyDown={event => {
                    if (qualityOpen && event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeQuality();
                    }
                  }}>
                    <div className="sub-history-col-account">
                      <button
                        type="button"
                        className="copyable-account sub-history-email"
                        disabled={!record.email}
                        title={record.email ? `点击复制邮箱 ${record.email}` : undefined}
                        aria-label={record.email ? `复制邮箱 ${record.email}` : "未知邮箱"}
                        onClick={() => handleCopyEmail(record.email)}
                      >
                        <span className="sub-history-email-text">{record.email || "未知账号"}</span>
                        {record.email && <Copy size={12} className="sub-history-email-copy-icon" aria-hidden="true" />}
                      </button>
                      {record.remark && (
                        <span className="sub-history-remark" title={record.remark}>
                          {record.remark}
                        </span>
                      )}
                      {hasQuality ? (
                        <button type="button" id={`${drawerId}-trigger`} className={`${qualityClass} sub-quality-trigger`}
                          aria-label={`${record.email} 降智历史 ${qualityLabel(record.quality)}`}
                          aria-expanded={qualityOpen} aria-controls={qualityOpen ? drawerId : undefined}
                          onClick={() => setExpandedQualityId(qualityOpen ? null : record.id)}>
                          {qualityLabel(record.quality)} <ChevronDown aria-hidden="true" size={12} />
                        </button>
                      ) : <span className={qualityClass}>{qualityLabel(record.quality)}</span>}
                      {timeInfo.label && (
                        <span className="sub-history-time" title={timeInfo.title || undefined}>
                          {timeInfo.label}
                        </span>
                      )}
                      {change?.at && (
                        <span className="sub-history-change">
                          <span>{isUnread && <strong className="sub-history-unread-label">新变化 · </strong>}{subscriptionChangeLabel(change, formatPlanType)}</span>
                          <span>变化时间：<time dateTime={change.at}>{displayDateTime(change.at)}</time></span>
                        </span>
                      )}
                    </div>

                    <div className="sub-history-col-plan">
                      <span
                        className={`plan-tag sub-history-plan-tag tone-${pTone}`}
                        title={status.detail}
                      >
                        {status.planLabel}
                      </span>
                      <span className={`sub-history-status status-${status.kind}`} title={status.detail}>
                        <i className="sub-history-status-dot" aria-hidden="true" />
                        <span>{status.badgeText}</span>
                      </span>
                      {!record.present && status.kind !== "removed" && (
                        <span className="sub-history-status status-removed" title="已从主列表删除">
                          <i className="sub-history-status-dot" aria-hidden="true" />
                          <span>已删除</span>
                        </span>
                      )}
                    </div>

                    <div className="sub-history-col-cost">
                      <span className="sub-history-mobile-label">成本</span>
                      <span className="sub-history-money" title={`账号成本：${costDisplay}`}>
                        {costDisplay}
                      </span>
                    </div>

                    <div className="sub-history-col-profit">
                      <span className="sub-history-mobile-label">利润</span>
                      <span className={`sub-history-profit tone-${tone}`} title={profitTitle}>
                        {profitText}
                      </span>
                    </div>

                    <div className="sub-history-col-action">
                      <button
                        type="button"
                        className={`sub-history-copy-btn ${isCopied ? "is-copied" : ""}`}
                        disabled={!record.canCopyCredentials || isCopying}
                        aria-busy={isCopying}
                        title={
                          !record.canCopyCredentials
                            ? "该记录暂无可复制的凭据"
                            : isCopied
                              ? "凭据已复制到剪贴板"
                              : `复制 ${record.email || "该账号"} 的凭据`
                        }
                        aria-label={
                          !record.canCopyCredentials
                            ? `${record.email || "账号"} 暂无可复制凭据`
                            : `复制 ${record.email || "账号"} 凭据`
                        }
                        onClick={() => handleCopyCredentials(record)}
                      >
                        {isCopying
                          ? <LoaderCircle size={13} className="spin" aria-hidden="true" />
                          : isCopied
                            ? <Check size={13} aria-hidden="true" />
                            : <KeyRound size={13} aria-hidden="true" />}
                        <span>
                          {isCopying ? "复制中…" : isCopied ? "已复制" : record.canCopyCredentials ? "复制凭据" : "无凭据"}
                        </span>
                      </button>
                    </div>
                    {qualityOpen && <QualityDrawer id={drawerId} record={record} request={request} onClose={closeQuality} />}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="dialog-footer sub-history-footer">
        <button type="button" className="cancel-button" onClick={onClose}>
          关闭
        </button>
      </div>
    </AccessibleDialog>
  );
}
