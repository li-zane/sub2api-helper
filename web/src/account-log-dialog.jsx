import { notify } from "./toast-events.mjs";
import { CopyableAccount, AccountText } from "./copyable-account.jsx";
import { splitSmsPhoneHighlights } from "./protocol-sms-log.mjs";
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy, RefreshCw, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { displayDateTime, displayProtocolLog } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";
import { groupCredentialHistory } from "./credential-history-groups.mjs";

const stages = { imported: "导入", started: "开始", prepared: "已备份", submission_pending: "待提交",
  confirmed: "已确认", confirmed_before_save: "已确认待保存", activation_pending: "待激活", activated: "已激活",
  activated_before_save: "已激活待保存", local_password_delete_prepared: "清空本地密码", local_key_delete_prepared: "清空本地密钥",
  manual_update_prepared: "手动更新", current: "当前版本", activation_failed: "激活未完成", enroll_failed: "注册未完成" };
const credentialNames = { password: "密码", "2fa": "2FA", web_session: "Web 会话 / Cookie", codex_oauth: "Codex OAuth" };
const credentialName = type => Object.hasOwn(credentialNames, type) ? credentialNames[type] : String(type || "其他凭据");
function title(entry, view) {
  if (view !== "credentials") return entry.label;
  const name = credentialName(entry.type);
  return `${name} · ${stages[entry.stage] || entry.stage || "历史"}`;
}
function time(value, view) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? displayDateTime(value) : view === "credentials" ? "时间未知" : "当前记录";
}

export function AccountLogDialog({ request, job, onClose, statusBadge }) {
  const timeZone = useDisplayTimeZone();
  const [view, setView] = useState("protocol"), [selected, setSelected] = useState(null);
  const [data, setData] = useState({ entries: [], content: "" }), [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false), [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const groupId = useId();
  const credentialGroups = useMemo(() => view === "credentials" ? groupCredentialHistory(data.entries) : [], [view, data.entries]);
  const protocolParts = useMemo(() => splitSmsPhoneHighlights(displayProtocolLog(data.content)), [data.content, timeZone]);
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
    try { await navigator.clipboard.writeText(view === "protocol" ? displayProtocolLog(data.content) : data.content || ""); setCopied(true); notify("日志内容已复制"); }
    catch { notify("复制失败，请选择内容后复制", { tone: "error" }); }
  }
  const current = data.entries.find(entry => entry.id === selected);
  function selectEntry(entry) {
    sequence.current++; setSelected(entry.id); setData(previous => ({ ...previous, content: "" })); setCopied(false);
  }
  const entryButton = (entry, className = "", key = entry.id) => <button type="button" key={key} data-entry-id={entry.id} aria-pressed={entry.id === selected}
    className={`account-log-entry ${entry.id === selected ? "is-selected" : ""} ${className}`.trim()} onClick={() => selectEntry(entry)}>
    <strong>{title(entry, view)}{view === "protocol" && entry.tags?.includes("sms") && <span className="account-log-sms-tag">接码</span>}</strong><time>{time(entry.at, view)}</time>
    {view === "protocol" && <small>{({ running: "进行中", completed: "已结束", failed: "未完成", interrupted: "已中断", canceled: "已取消" })[entry.status] || entry.status}</small>}
  </button>;
  return <AccessibleDialog className="log-dialog account-log-dialog" labelledBy="account-log-title" onClose={onClose}>
    <div className="dialog-header">
      <div><div className="section-title-row"><h2 id="account-log-title">账号日志与凭据</h2>{statusBadge}</div><span><CopyableAccount email={job.email} /></span></div>
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
          {view === "protocol" ? data.entries.map(entry => entryButton(entry)) : credentialGroups.map((group, index) => {
            const open = expanded.has(group.type), name = credentialName(group.type), versionsId = `${groupId}-credential-${index}`;
            const selectedHistory = group.history.some(entry => entry.id === selected);
            return <div className={`account-credential-group ${selectedHistory ? "has-selected-history" : ""}`.trim()} key={group.type} data-credential-type={group.type}>
              <div className="account-credential-header">
                {entryButton(group.latest, "account-credential-latest", group.type)}
                {group.history.length > 0 && <button type="button" className="account-credential-toggle" aria-expanded={open} aria-controls={versionsId}
                  aria-label={`${open ? "收起" : "展开"} ${name} 的 ${group.history.length} 条历史记录`}
                  onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(group.type)) next.delete(group.type); else next.add(group.type); return next; })}>
                  <ChevronRight size={14} className={open ? "is-expanded" : ""} aria-hidden="true" /><span>{group.history.length}</span>
                </button>}
              </div>
              {group.history.length > 0 && <div className="account-credential-versions" id={versionsId} role="group" aria-label={`${name} 历史版本`} hidden={!open}>
                {open && group.history.map(entry => entryButton(entry, "account-credential-version"))}
              </div>}
            </div>;
          })}
        </nav>
        <section className="account-log-content" aria-label="记录详情">
          {error ? <div className="dialog-error" role="alert">{error}</div> : selected ? <>
            <div className="account-log-content-heading">{current ? title(current, view) : "正在读取记录…"}</div>
            <pre className="log-dialog-viewer" tabIndex="0">{data.content ? view === "protocol" ? protocolParts.map((part, index) => part.phone ? <span key={index} className="protocol-log-phone">{part.text}</span> : <AccountText key={index} text={part.text} />) : <AccountText text={data.content} /> : (data.selectedId === selected ? "该记录暂无输出" : "正在读取内容…")}</pre>
          </> : <div className="account-log-placeholder">选择记录，查看详细内容</div>}
        </section>
      </div>
    </div>
    <div className="dialog-actions log-dialog-actions"><span className="log-dialog-meta">{data.retention || "每 1.2 秒同步；点击记录后加载详情"}</span>
      <span className="dialog-actions-spacer" /><button type="button" className="cancel-button" onClick={onClose}>关闭</button></div>
  </AccessibleDialog>;
}
