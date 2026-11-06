import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, RefreshCw, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { displayDateTime, displayProtocolLog } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

const stages = { imported: "导入", started: "开始", prepared: "已备份", submission_pending: "待提交",
  confirmed: "已确认", confirmed_before_save: "已确认待保存", activation_pending: "待激活", activated: "已激活",
  activated_before_save: "已激活待保存", local_password_delete_prepared: "清空本地密码", local_key_delete_prepared: "清空本地密钥",
  manual_update_prepared: "手动更新", current: "当前版本", activation_failed: "激活未完成", enroll_failed: "注册未完成" };
function title(entry, view) {
  if (view !== "credentials") return entry.label;
  const name = { password: "密码", "2fa": "2FA", web_session: "Web 会话 / Cookie", codex_oauth: "Codex OAuth" }[entry.type] || entry.type;
  return `${name} · ${stages[entry.stage] || entry.stage || "历史"}`;
}
function time(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? displayDateTime(value) : "当前记录";
}

export function AccountLogDialog({ request, job, onClose, statusBadge }) {
  useDisplayTimeZone();
  const [view, setView] = useState("protocol"), [selected, setSelected] = useState(null);
  const [data, setData] = useState({ entries: [], content: "" }), [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false), [copied, setCopied] = useState(false);
  const sequence = useRef(0), alive = useRef(true), pending = useRef(null);
  useEffect(() => () => { alive.current = false; sequence.current++; }, []);
  const load = async () => {
    const key = `${view}:${selected || ""}`;
    if (pending.current?.key === key) return;
    const requestState = { key }; pending.current = requestState;
    const seq = ++sequence.current;
    const query = new URLSearchParams({ view, ...(selected ? { entry: selected } : {}) });
    try {
      const next = await request(`/api/jobs/${job.id}/logs?${query}`);
      if (!alive.current || seq !== sequence.current) return;
      setData(next); setError("");
    } catch (reason) {
      if (alive.current && seq === sequence.current) setError(reason.message);
    } finally { if (pending.current === requestState) pending.current = null; }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(load, 1200);
    return () => { sequence.current++; window.clearInterval(timer); };
  }, [job.id, request, view, selected]);
  function changeView(next) {
    sequence.current++; setView(next); setSelected(null); setData({ entries: [], content: "" }); setError(""); setCopied(false);
  }
  async function refresh() { setRefreshing(true); try { await load(); } finally { if (alive.current) setRefreshing(false); } }
  async function copy() {
    try { await navigator.clipboard.writeText(view === "protocol" ? displayProtocolLog(data.content) : data.content || ""); setCopied(true); }
    catch { setError("复制失败，请选择内容后复制"); }
  }
  const current = data.entries.find(entry => entry.id === selected);
  return <AccessibleDialog className="log-dialog account-log-dialog" labelledBy="account-log-title" onClose={onClose}>
    <div className="dialog-header">
      <div><div className="section-title-row"><h2 id="account-log-title">账号日志与凭据</h2>{statusBadge}</div><span>{job.email}</span></div>
      <div className="dialog-header-actions">
        <button type="button" className="secondary-button compact-button" onClick={copy} disabled={!data.content} title="复制当前内容">
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制内容"}
        </button>
        <button type="button" className="icon-button" onClick={refresh} disabled={refreshing} aria-label="刷新日志"><RefreshCw size={16} className={refreshing ? "spin" : ""} /></button>
        <button type="button" className="icon-button" autoFocus onClick={onClose} aria-label="关闭协议日志"><X size={18} /></button>
      </div>
    </div>
    <div className="log-dialog-body">
      <div className="account-log-tabs" role="tablist" aria-label="日志分类">
        {[["protocol", "协议日志"], ["credentials", "凭据历史"]].map(([key, label]) => <button type="button" role="tab" key={key}
          id={`log-tab-${key}`} aria-selected={view === key} aria-controls="account-log-panel" tabIndex={view === key ? 0 : -1}
          className={`secondary-button compact-button ${view === key ? "is-active" : ""}`} onClick={() => changeView(key)}
          onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); const next = view === "protocol" ? "credentials" : "protocol"; changeView(next); document.getElementById(`log-tab-${next}`)?.focus(); } }}>{label}</button>)}
      </div>
      <div className="account-log-workspace" id="account-log-panel" role="tabpanel" aria-labelledby={`log-tab-${view}`}>
        <nav className="account-log-menu" aria-label={view === "protocol" ? "任务记录" : "凭据记录"}>
          {!data.entries.length && <p className="account-log-empty">暂无记录</p>}
          {data.entries.map(entry => <button type="button" key={entry.id} aria-pressed={entry.id === selected}
            className={`account-log-entry ${entry.id === selected ? "is-selected" : ""}`} onClick={() => { sequence.current++; setSelected(entry.id); setData(previous => ({ ...previous, content: "" })); setCopied(false); }}>
            <strong>{title(entry, view)}</strong><time>{time(entry.at)}</time>
            {view === "protocol" && <small>{({ running: "进行中", completed: "已结束", failed: "未完成", interrupted: "已中断", canceled: "已取消" })[entry.status] || entry.status}</small>}
          </button>)}
        </nav>
        <section className="account-log-content" aria-label="记录详情">
          {error ? <div className="dialog-error" role="alert">{error}</div> : selected ? <>
            <div className="account-log-content-heading">{current ? title(current, view) : "正在读取记录…"}</div>
            <pre className="log-dialog-viewer" tabIndex="0">{data.content ? view === "protocol" ? displayProtocolLog(data.content) : data.content : (data.selectedId === selected ? "该记录暂无输出" : "正在读取内容…")}</pre>
          </> : <div className="account-log-placeholder">选择记录，查看详细内容</div>}
        </section>
      </div>
    </div>
    <div className="dialog-actions log-dialog-actions"><span className="log-dialog-meta">{data.retention || "每 1.2 秒同步；点击记录后加载详情"}</span>
      <span className="dialog-actions-spacer" /><button type="button" className="cancel-button" onClick={onClose}>关闭</button></div>
  </AccessibleDialog>;
}
