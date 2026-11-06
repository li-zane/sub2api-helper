import { CustomSelect } from "./custom-select.jsx";
import React, { useEffect, useRef, useState } from "react";
import { Activity, Check, ChevronDown, RefreshCw, Settings2, X } from "lucide-react";
import { HelpTip } from "./help-tip.jsx";
import { trapModalTab } from "./accessible-dialog.jsx";

const TITLES = { match: "指纹一致", mismatch: "疑似不一致", unknown: "证据不足", error: "请求失败" };
const toText = models => (models || []).map(m => m.expected === m.model ? m.model : `${m.model} => ${m.expected}`).join("\n");
const fromText = text => text.split(/\n/).map(line => line.trim()).filter(Boolean).map(line => { const [model, ...parts] = line.split("=>"); return { model: model.trim(), expected: parts.join("=>").trim() || model.trim() }; });

function formatReferenceTime(val) {
  if (!val) return "—";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).slice(0, 19).replace("T", " ");
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return String(val);
  }
}

function formatTimelineTime(val) {
  if (!val) return { time: "—", date: "" };
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return { time: String(val), date: "" };
    const str = d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const parts = str.split(" ");
    return { date: parts[0] || "", time: parts[1] || str };
  } catch {
    return { time: String(val), date: "" };
  }
}

async function api(token, url, body) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "x-console-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "指纹检测请求失败"); return data;
}
function Dialog({ title, subtitle, onClose, closeDisabled = false, returnFocusRef, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = returnFocusRef?.current || document.activeElement;
    const dialog = ref.current;
    const initialFocus = dialog.querySelector('[data-dialog-initial-focus]:not(:disabled), .dialog-header .icon-button:not(:disabled)');
    initialFocus?.setAttribute("autofocus", "");
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog
    ref={ref}
    className="batch-dialog fingerprint-dialog"
    aria-label={title}
    onKeyDown={trapModalTab}
    onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget || closeDisabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}
  >
    <div className="dialog-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <HelpTip title={title} label={`${title}说明`}>{subtitle}</HelpTip>}
      </div>
      <button type="button" className="icon-button" data-dialog-initial-focus aria-label={`关闭${title}`} disabled={closeDisabled} onClick={onClose}><X size={18} /></button>
    </div>
    {children}
  </dialog>;
}
function FingerprintDefaultsFields({ value, onChange, disabled = false }) {
  const [text, setText] = useState(() => toText(value.models));
  return <section className="fingerprint-defaults" aria-label="默认降智检测规则">
    <label className="settings-field">
      <span className="field-label-row">
        <span>默认检测模型（每行一个，最多 8 个）</span>
        <HelpTip title="默认降智检测规则" label="查看默认降智检测规则说明">
          每个模型每轮发送 3 条数字指纹提示词，会使用账号额度、网络和本机评分资源。不同账号按并发上限执行，同一账号的请求依次进行；提高并发会增加瞬时资源占用。名称可写为“请求模型 =&gt; 参考库指纹名称”。参考库中的合并类（如 gpt-6-astra/6.1-sol）匹配表示属于该类，不区分其单个模型。归因是参考库内的统计排序，不等同于模型身份或智力证明。
        </HelpTip>
      </span>
      <textarea aria-label="默认检测模型" rows={3} value={text} disabled={disabled} placeholder={"模型 ID\n模型别名 => 预期指纹名称"} onChange={event => { setText(event.target.value); onChange({ ...value, models: fromText(event.target.value) }); }} />
    </label>
    <div className="fingerprint-three-fields">
      <label className="settings-field"><span>默认检测间隔（分钟）</span><input aria-label="默认检测间隔（分钟）" type="number" min="5" max="43200" value={value.intervalMinutes ?? 360} disabled={disabled} onChange={event => onChange({ ...value, intervalMinutes: event.target.value })} /></label>
      <label className="settings-field"><span>最低归因概率</span><input aria-label="最低归因概率" type="number" min="0.5" max="1" step="0.05" value={value.minProbability ?? 0.8} disabled={disabled} onChange={event => onChange({ ...value, minProbability: event.target.value })} /></label>
      <label className="settings-field"><span>同时检测账号数（1–16）</span><input aria-label="同时检测账号数量" type="number" min="1" max="16" value={value.maxConcurrentAccounts ?? 3} disabled={disabled} onChange={event => onChange({ ...value, maxConcurrentAccounts: event.target.value })} /></label>
    </div>
  </section>;
}
export function FingerprintSettingsButton({ token, planTypes = [] }) {
  const returnFocusRef = useRef(null);
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [newPlan, setNewPlan] = useState(""), [reference, setReference] = useState(null);
  async function open(event) { returnFocusRef.current = event.currentTarget; setBusy(true); setError(""); try { setData(await api(token, "/api/model-fingerprint/settings")); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const patch = changes => setData(current => ({ ...current, settings: { ...current.settings, ...changes } }));
  const plans = data ? [...new Set([...planTypes, ...Object.keys(data.settings.planDefaults), ...data.profiles.flatMap(p => p.planTypes || [])])].sort() : [];
  async function save(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const groupPolicies = Object.fromEntries(data.profiles.map(p => [p.id, Object.fromEntries(p.groupIds.map(id => [id, data.settings.groupPolicies[p.id]?.[id] || "default"]))]));
      await api(token, "/api/model-fingerprint/settings", { settings: { ...data.settings, groupPolicies } }); setData(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <><button type="button" className="secondary-button topbar-action-button" disabled={!token || busy} onClick={open}><Activity size={14} />降智检测设置</button>
    {!data && error && <span role="alert" className="proxy-quality-error">{error}</span>}
    {data && <Dialog title="降智检测设置" subtitle="通过数字指纹提示词评估模型响应分布是否与参考库一致" closeDisabled={busy} returnFocusRef={returnFocusRef} onClose={() => setData(null)}><form onSubmit={save} className="fingerprint-form">
      <FingerprintDefaultsFields value={data.settings} onChange={settings => setData(current => ({ ...current, settings }))} disabled={busy} />
      <div className="fingerprint-toolbar-row">
        {data.runtime && (
          <span className="runtime-status-pill">
            正在检测 <strong>{data.runtime.activeAccounts}</strong> · 等待 <strong>{data.runtime.queuedAccounts}</strong>
            <HelpTip label="并发调整说明">仅调整并发上限不会中断当前正在执行的账号检测任务。</HelpTip>
          </span>
        )}
        <button type="button" className="secondary-button compact-btn" disabled={busy} onClick={async () => { setBusy(true); try { setReference(await api(token, "/api/model-fingerprint/reference")); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>读取指纹参考库模型</button>
        {reference && (
          <span className="runtime-status-pill">
            已读取 {reference.models.length} 个参考模型
            <HelpTip title={`参考库 (${reference.builtAt})`} label="查看参考库模型列表">
              {reference.models.map(m => m.name || m.id).join("、")}
            </HelpTip>
          </span>
        )}
      </div>
      <section className="fingerprint-section">
        <div className="section-title-row">
          <h3>PlanType 默认开关</h3>
          <HelpTip title="PlanType 默认开关" label="查看 PlanType 默认开关说明">
            未配置的 PlanType 默认关闭；账号独立设置优先。新账号识别订阅类型后自动继承对应开关状态。
          </HelpTip>
        </div>
        <div className="fingerprint-plan-list">{plans.map(plan => <label key={plan} className="plan-check-pill"><input type="checkbox" disabled={busy} checked={data.settings.planDefaults[plan] === true} onChange={e => patch({ planDefaults: { ...data.settings.planDefaults, [plan]: e.target.checked } })} /><span>{plan}</span></label>)}</div>
        <div className="fingerprint-add-plan"><input aria-label="添加检测 PlanType" disabled={busy} value={newPlan} onChange={e => setNewPlan(e.target.value)} placeholder="输入自定义原始 PlanType" /><button type="button" className="secondary-button" disabled={busy || !newPlan.trim()} onClick={() => { patch({ planDefaults: { ...data.settings.planDefaults, [newPlan.trim().toLowerCase()]: false } }); setNewPlan(""); }}>添加类型</button></div>
      </section>
      <section className="fingerprint-section">
        <div className="section-title-row">
          <h3>号池分组加入规则</h3>
          <HelpTip title="号池分组加入规则" label="查看号池分组加入规则说明">
            读取各 PlanType 所绑定方案的默认分组。默认加入始终保留；不降智加入要求全部指定模型指纹一致。明确不一致时移出条件组；未知结果不改已有分组，新上传账号需通过后才加入条件组。不改其它分组。
          </HelpTip>
        </div>
        {data.profiles.map(profile => <fieldset key={profile.id} className="fingerprint-profile" disabled={busy}><legend>{profile.name} · {(profile.planTypes || []).join(" / ") || "未绑定 PlanType"}</legend>
          {!profile.groupIds.length && <p className="empty-inline-note">此方案未指定分组，请先在 Sub2API 配置中选择号池</p>}
          {profile.groupIds.map(id => <label className="fingerprint-group-rule" key={id}><span>{data.groups.find(g => String(g.id) === String(id))?.name || `分组 ${id}`}</span><CustomSelect disabled={busy} aria-label={`${profile.name} 分组 ${id} 加入规则`} value={data.settings.groupPolicies[profile.id]?.[id] || "default"} onChange={e => patch({ groupPolicies: { ...data.settings.groupPolicies, [profile.id]: { ...data.settings.groupPolicies[profile.id], [id]: e.target.value } } })}><option value="default">默认加入</option><option value="verified">不降智加入（指纹一致）</option></CustomSelect></label>)}
        </fieldset>)}
      </section>
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><span className="dialog-actions-spacer" /><button type="button" className="cancel-button" disabled={busy} onClick={() => setData(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存降智检测设置"}</button></div>
    </form></Dialog>}
  </>;
}
function AttributionModels({ models, parentStatus }) {
  return <div className="fingerprint-timeline-models">{models.map((r, index) => {
    const modelStatus = r.status || "unknown";
    const isMatch = modelStatus === "match";
    const isMismatch = modelStatus === "mismatch";
    const isError = modelStatus === "error";
    const predName = r.predictionName || r.prediction || (isError ? (r.failure?.code || "检测失败") : "未知");
    const probPercent = r.probability != null ? `${(r.probability * 100).toFixed(2)}%` : null;

    return <div key={index} className={`fingerprint-timeline-model status-${modelStatus}`}>
      <div className="fingerprint-model-stream">
        <div className="model-stream-left">
          <strong className="model-name-text">{r.model}</strong>
          {(r.reason || r.error || r.expectedReference?.combined || r.samples?.length > 0) && (
            <HelpTip title={`${r.model} 采样详情`} label={`查看 ${r.model} 采样说明`}>
              {r.reason || r.error ? <div>{r.reason || r.error}</div> : null}
              {r.expectedReference?.combined ? <div>合并参考类：{r.expectedReference.name}（该库不区分类内单个模型）</div> : null}
              {r.samples?.length > 0 ? <div>样本数字数（实际 / 期望）：{r.samples.map(s => `${s.count} / ${s.expected}`).join("；")}</div> : null}
            </HelpTip>
          )}
          {r.expected && r.expected !== r.model && (
            <span className="expected-pill">期望：{r.expected}</span>
          )}
        </div>

        <span className="stream-arrow" aria-hidden="true">→</span>

        <div className="model-stream-right">
          <span className={`pred-name-text status-${modelStatus}`}>{predName}</span>
          {probPercent && <span className={`prob-pill status-${modelStatus}`}>{probPercent}</span>}
          {(models.length > 1 || r.status !== parentStatus) && (
            <span className={`model-status-tag ${r.status}`}>{TITLES[r.status] || "证据不足"}</span>
          )}
        </div>
      </div>

      {r.failure && (
        <div className="fingerprint-error-note">
          <span>错误分类：{r.failure.code}</span>
          {r.failure.httpStatus ? <span> · HTTP {r.failure.httpStatus}</span> : null}
          {r.failure.upstreamCode ? <span> · {r.failure.upstreamCode}</span> : null}
        </div>
      )}

      {r.sampleFailures?.length > 0 && (
        <details className="fingerprint-timeline-details sample-failures-details">
          <summary className="timeline-details-summary">
            <ChevronDown size={13} className="details-chevron" />
            <span>采样请求记录（{r.sampleFailures.length} 次异常）</span>
          </summary>
          <ul className="timeline-details-list">
            {r.sampleFailures.map((f, i) => (
              <li key={i}>
                第 {f.sample} 份样本 · 第 {f.attempt} 次请求：{f.message}
                {f.httpStatus ? `（HTTP ${f.httpStatus}）` : ""}
                {f.upstreamCode ? ` · ${f.upstreamCode}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="fingerprint-timeline-meta">
        <span>远端账号 ID：{r.accountId || "—"}</span>
        <span className="meta-sep">·</span>
        <span>{r.status === "error" ? `采样完成：${r.completedSamples ?? 0}/3` : `有效样本：${r.usedOutputs ?? 0}/3`}</span>
        <span className="meta-sep">·</span>
        <span>参考库：{formatReferenceTime(r.referenceBuiltAt)}</span>
      </div>

      {r.candidates?.length > 0 && (
        <details className="fingerprint-timeline-details candidates-details">
          <summary className="timeline-details-summary">
            <ChevronDown size={13} className="details-chevron" />
            <span>候选归因分布 (Top {r.candidates.length})</span>
          </summary>
          <div className={`timeline-details-branch candidates-branch ${isMismatch ? "is-mismatch" : isMatch ? "is-match" : ""}`}>
            {r.candidates.map((c, cIdx) => {
              const name = c.name || c.model;
              const probNum = c.probability != null ? c.probability * 100 : 0;
              const probText = c.probability != null ? `${probNum.toFixed(2)}%` : "—";
              const isFirst = cIdx === 0;
              return (
                <div key={c.model || cIdx} className={`branch-candidate-item ${isFirst ? "is-top-candidate" : ""}`}>
                  <div className="candidate-name-col">
                    <span className="candidate-rank">{cIdx + 1}.</span>
                    <span className={`candidate-name ${isFirst ? (isMismatch ? "text-rose" : "text-emerald") : ""}`}>
                      {name}
                    </span>
                  </div>
                  <div className="candidate-prob-col">
                    <div className="candidate-bar-track">
                      <div
                        className={`candidate-bar-fill ${isFirst ? (isMismatch ? "bar-rose" : "bar-emerald") : "bar-slate"}`}
                        style={{ width: `${Math.max(0, Math.min(100, probNum))}%` }}
                      />
                    </div>
                    <span className={`candidate-prob-text ${isFirst ? (isMismatch ? "text-rose" : "text-emerald") : ""}`}>
                      {probText}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>;
  })}</div>;
}
function FingerprintHistoryDialog({ job, token, onClose }) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const refreshTimerRef = useRef(null);
  const requestSequence = useRef(0);
  const mounted = useRef(false);
  const manualPending = useRef(false);

  useEffect(() => {
    let stopped = false;
    mounted.current = true;
    const load = async () => {
      if (manualPending.current) return;
      const request = ++requestSequence.current;
      try {
        const next = await api(token, `/api/jobs/${job.id}/model-fingerprint/history`);
        if (!stopped && request === requestSequence.current) { setData(next); setError(""); }
      } catch (e) {
        if (!stopped && request === requestSequence.current) setError(e.message);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      mounted.current = false;
      requestSequence.current++;
      clearInterval(timer);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [job.id, token]);

  const handleRefresh = async () => {
    if (manualPending.current) return;
    manualPending.current = true;
    const request = ++requestSequence.current;
    const current = () => mounted.current && request === requestSequence.current;
    setRefreshing(true);
    setRefreshed(false);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const start = Date.now();
    try {
      const next = await api(token, `/api/jobs/${job.id}/model-fingerprint/history`);
      if (!current()) return;
      setData(next);
      setError("");
      const elapsed = Date.now() - start;
      if (elapsed < 500) {
        await new Promise(r => setTimeout(r, 500 - elapsed));
      }
      if (!current()) return;
      setRefreshed(true);
      refreshTimerRef.current = setTimeout(() => setRefreshed(false), 1200);
    } catch (e) {
      if (current()) setError(e.message);
    } finally {
      manualPending.current = false;
      if (current()) setRefreshing(false);
    }
  };

  const isInitialLoading = !data && !error;

  return <Dialog title={`${job.email} 最近 6 轮归因结果`} onClose={onClose}><div className="fingerprint-history-panel">
    <div className="fingerprint-history-toolbar">
      <div className="fingerprint-history-meta">
        <span className="history-meta-sub">按时间倒序排列</span>
      </div>
      <button
        className={`secondary-button compact-btn fingerprint-refresh-btn ${refreshing ? "is-refreshing" : refreshed ? "is-refreshed" : ""}`}
        type="button"
        onClick={handleRefresh}
        disabled={refreshing}
        aria-label="刷新记录"
      >
        {refreshed ? (
          <Check size={12} className="refresh-check-icon" />
        ) : (
          <RefreshCw size={12} className={refreshing || isInitialLoading ? "spin" : ""} />
        )}
        <span>{refreshing ? "刷新中…" : refreshed ? "已刷新" : "刷新记录"}</span>
      </button>
    </div>
    {data && <>
      {!data.models.length && <p className="proxy-quality-error">尚未配置检测模型，请先在“降智检测设置”或账号独立设置中添加。</p>}
      {data.groupSyncError && <p role="alert" className="proxy-quality-error">号池分组同步：{data.groupSyncError}</p>}
      {data.lastError && <p role="alert" className="proxy-quality-error">{data.lastError}</p>}
      {!data.records.length ? <p className="fingerprint-history-empty">暂无检测记录。</p> : <div className="fingerprint-timeline" role="list">
        {data.records.map((record, index) => {
          const { time, date } = formatTimelineTime(record.checkedAt);
          const statusKey = record.status || "unknown";
          return <div key={`${record.checkedAt}-${index}`} className={`fingerprint-timeline-node status-${statusKey}`} role="listitem">
            <div className="timeline-node-marker" aria-hidden="true">
              <span className={`marker-dot status-${statusKey}`} />
            </div>
            <div className="timeline-node-content">
              <div className="timeline-node-header">
                <div className="node-time-wrap">
                  <span className="node-time">{time}</span>
                  <span className="node-date">{date}</span>
                  <span className="node-meta-sep">·</span>
                  <span className="node-source-tag">
                    {record.source === "manual" ? "手动检测" : record.source === "scheduled" ? "自动检测" : "历史结果"}
                  </span>
                  {record.durationMs != null && <>
                    <span className="node-meta-sep">·</span>
                    <span className="node-duration">{(record.durationMs / 1000).toFixed(1)}s</span>
                  </>}
                  {record.legacy && (
                    <HelpTip title="旧版记录说明" label="查看旧版记录说明">
                      旧版记录按当时结论保留，不回填或修改分组；新检测将使用修正后的参考类匹配。
                    </HelpTip>
                  )}
                </div>
                <span className={`fingerprint-status ${record.status}`}>{TITLES[record.status] || "证据不足"}</span>
              </div>
              <AttributionModels models={record.models || []} parentStatus={record.status} />
              {record.error && <p className="proxy-quality-error timeline-record-error">{record.error}</p>}
            </div>
          </div>;
        })}
      </div>}
    </>}
    {!data && !error && <p className="fingerprint-history-loading">正在读取归因记录…</p>}
    {error && <p role="alert" className="proxy-quality-error">{error}</p>}
  </div></Dialog>;
}
export function ModelFingerprintCell({ job, token, onError }) {
  const [state, setState] = useState(job.modelFingerprint), [editing, setEditing] = useState(false), [showHistory, setShowHistory] = useState(false), [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [checkPending, setCheckPending] = useState(false);
  const requestPending = useRef(false);
  useEffect(() => setState(job.modelFingerprint), [job.modelFingerprint]);
  if (!state) return <span className="muted">—</span>;
  async function update(body, check = false) {
    if (requestPending.current || check && ["running", "queued"].includes(state.phase)) return;
    requestPending.current = true;
    setBusy(true); setCheckPending(check); setError(""); try { const result = await api(token, `/api/jobs/${job.id}/model-fingerprint${check ? "/check" : ""}`, body); setState(result.job.modelFingerprint); if (!check) setEditing(false); } catch (e) { setError(e.message); onError?.(e.message); } finally { requestPending.current = false; setBusy(false); setCheckPending(false); }
  }
  function open() { setDraft({ ...state.override, text: toText(state.override.models ?? state.models), customModels: state.override.models !== null, customInterval: state.override.intervalMinutes !== null, interval: state.override.intervalMinutes ?? state.intervalMinutes }); setError(""); setEditing(true); }
  const result = state.result;
  const recent = (state.recentResults || (result || state.previousResult ? [result || state.previousResult] : [])).slice(0, 6).reverse();
  const rounds = [...Array(6 - recent.length).fill(null), ...recent];
  const checking = state.phase === "running" || state.phase === "queued";
  return <div className={`fingerprint-cell-body${state.enabled ? "" : " is-disabled"}`}>
    <div className="fingerprint-cell-actions">
      <div className="overload-control fingerprint-toggle-control"><span>降智</span>
      <button type="button" role="switch" aria-checked={state.enabled} aria-label={`${job.email} 降智检测`} className={`status-toggle ${state.enabled ? "on" : ""}`} disabled={!token || busy} onClick={() => update({ ...state.override, enabled: !state.enabled })}><span className="status-toggle-track"><span className="status-toggle-thumb" /></span></button>
      </div>
      <div className="fingerprint-action-pair">
      <button type="button" className="fingerprint-check-button" aria-label={`${job.email} 立即检测降智`} title={state.phase === "queued" ? "排队中" : checking || checkPending ? "正在检测" : "立即检测"} aria-busy={checking || checkPending} disabled={!token || busy || checking || !state.models.length || !job.sub2apiInPool} onClick={() => update({}, true)}><RefreshCw size={13} className={checking || checkPending ? "spin" : ""} aria-hidden="true" /></button>
      <button type="button" className="icon-button compact-icon-btn" aria-label={`${job.email} 独立降智检测设置`} title="独立降智检测设置" onClick={open}><Settings2 size={14} /></button>
      </div>
    </div>
    <div className="fingerprint-rounds" role="group" aria-label={`${job.email} 最近 6 轮检测结果`}>
      {rounds.map((round, index) => {
        const status = !round ? "empty" : round.status === "match" ? "match" : round.status === "mismatch" ? "mismatch" : "error";
        const label = `${state.enabled ? "" : "检测已关闭 · "}${!round ? "暂无检测记录" : `${round.status === "match" ? "通过" : round.status === "mismatch" ? "不一致" : round.status === "unknown" ? "证据不足" : "检测失败"} · ${new Date(round.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`}`;
        return <button key={round?.checkedAt || `empty-${index}`} type="button" className={`fingerprint-round ${status}`} aria-label={label} title={label} onClick={() => setShowHistory(true)} />;
      })}
    </div>
    {showHistory && <FingerprintHistoryDialog job={job} token={token} onClose={() => setShowHistory(false)} />}
    {editing && <Dialog title={`${job.email} 降智检测`} closeDisabled={busy} onClose={() => setEditing(false)}><form className="fingerprint-form" onSubmit={e => { e.preventDefault(); update({ enabled: draft.enabled, models: draft.customModels ? fromText(draft.text) : null, intervalMinutes: draft.customInterval ? draft.interval : null }); }}>
      <label className="settings-field"><span>账号检测开关</span><CustomSelect disabled={busy} aria-label="账号检测开关" value={draft.enabled == null ? "inherit" : String(draft.enabled)} onChange={e => setDraft({ ...draft, enabled: e.target.value === "inherit" ? null : e.target.value === "true" })}><option value="inherit">继承 PlanType</option><option value="true">独立开启</option><option value="false">独立关闭</option></CustomSelect></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customModels} onChange={e => setDraft({ ...draft, customModels: e.target.checked })} />使用独立检测模型</label>
      <label className="settings-field"><span>账号检测模型</span><textarea aria-label="账号检测模型" rows={4} value={draft.text} disabled={!draft.customModels} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customInterval} onChange={e => setDraft({ ...draft, customInterval: e.target.checked })} />使用独立检测间隔</label>
      <label className="settings-field"><span>账号检测间隔（分钟）</span><input aria-label="账号检测间隔（分钟）" type="number" min="5" max="43200" disabled={!draft.customInterval} value={draft.interval} onChange={e => setDraft({ ...draft, interval: e.target.value })} /></label>
      {result && <section className="fingerprint-section"><h3>最近模型归因</h3>{result.models.map((r, i) => <p key={i}>{r.model} → {r.predictionName || r.prediction || r.error || "未知"} · {TITLES[r.status]} {r.probability != null ? `(${(r.probability * 100).toFixed(1)}%)` : ""}<small className="fingerprint-reference">期望：{r.expected}；参考库：{r.referenceBuiltAt || "—"}</small></p>)}</section>}
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><span className="dialog-actions-spacer" /><button type="button" className="cancel-button" disabled={busy} onClick={() => setEditing(false)}>取消</button><button className="primary-button" disabled={busy}>保存账号检测设置</button></div>
    </form></Dialog>}
  </div>;
}
