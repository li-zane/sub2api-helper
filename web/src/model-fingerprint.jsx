import React, { useEffect, useRef, useState } from "react";
import { Activity, Settings2, X } from "lucide-react";
import { HelpTip } from "./help-tip.jsx";

const TITLES = { match: "指纹一致", mismatch: "疑似不一致", unknown: "证据不足", error: "请求失败" };
const toText = models => (models || []).map(m => m.expected === m.model ? m.model : `${m.model} => ${m.expected}`).join("\n");
const fromText = text => text.split(/\n/).map(line => line.trim()).filter(Boolean).map(line => { const [model, ...parts] = line.split("=>"); return { model: model.trim(), expected: parts.join("=>").trim() || model.trim() }; });
async function api(token, url, body) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "x-console-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "指纹检测请求失败"); return data;
}
function Dialog({ title, subtitle, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { const previous = document.activeElement; const dialog = ref.current; dialog.showModal(); return () => { dialog.close(); previous?.focus?.(); }; }, []);
  return <dialog ref={ref} className="batch-dialog fingerprint-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <HelpTip title={title} label={`${title}说明`}>{subtitle}</HelpTip>}
      </div>
      <button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button>
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
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [newPlan, setNewPlan] = useState(""), [reference, setReference] = useState(null);
  async function open() { setBusy(true); setError(""); try { setData(await api(token, "/api/model-fingerprint/settings")); } catch (e) { setError(e.message); } finally { setBusy(false); } }
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
    {data && <Dialog title="降智检测设置" subtitle="通过数字指纹提示词评估模型响应分布是否与参考库一致" onClose={() => setData(null)}><form onSubmit={save} className="fingerprint-form">
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
        <div className="fingerprint-plan-list">{plans.map(plan => <label key={plan} className="plan-check-pill"><input type="checkbox" checked={data.settings.planDefaults[plan] === true} onChange={e => patch({ planDefaults: { ...data.settings.planDefaults, [plan]: e.target.checked } })} /><span>{plan}</span></label>)}</div>
        <div className="fingerprint-add-plan"><input aria-label="添加检测 PlanType" value={newPlan} onChange={e => setNewPlan(e.target.value)} placeholder="输入自定义原始 PlanType" /><button type="button" className="secondary-button" disabled={!newPlan.trim()} onClick={() => { patch({ planDefaults: { ...data.settings.planDefaults, [newPlan.trim().toLowerCase()]: false } }); setNewPlan(""); }}>添加类型</button></div>
      </section>
      <section className="fingerprint-section">
        <div className="section-title-row">
          <h3>号池分组加入规则</h3>
          <HelpTip title="号池分组加入规则" label="查看号池分组加入规则说明">
            读取各 PlanType 所绑定方案的默认分组。默认加入始终保留；不降智加入要求全部指定模型指纹一致。明确不一致时移出条件组；未知结果不改已有分组，新上传账号需通过后才加入条件组。不改其它分组。
          </HelpTip>
        </div>
        {data.profiles.map(profile => <fieldset key={profile.id} className="fingerprint-profile"><legend>{profile.name} · {(profile.planTypes || []).join(" / ") || "未绑定 PlanType"}</legend>
          {!profile.groupIds.length && <p className="empty-inline-note">此方案未指定分组，请先在 Sub2API 配置中选择号池</p>}
          {profile.groupIds.map(id => <label className="fingerprint-group-rule" key={id}><span>{data.groups.find(g => String(g.id) === String(id))?.name || `分组 ${id}`}</span><select aria-label={`${profile.name} 分组 ${id} 加入规则`} value={data.settings.groupPolicies[profile.id]?.[id] || "default"} onChange={e => patch({ groupPolicies: { ...data.settings.groupPolicies, [profile.id]: { ...data.settings.groupPolicies[profile.id], [id]: e.target.value } } })}><option value="default">默认加入</option><option value="verified">不降智加入（指纹一致）</option></select></label>)}
        </fieldset>)}
      </section>
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><span className="dialog-actions-spacer" /><button type="button" className="cancel-button" onClick={() => setData(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存降智检测设置"}</button></div>
    </form></Dialog>}
  </>;
}
function AttributionModels({ models }) {
  return <div className="fingerprint-result-models">{models.map((r, index) => <div key={index} className="fingerprint-result-model">
    <div className="fingerprint-model-header">
      <div className="field-label-row">
        <strong>{r.model}</strong>
        {(r.reason || r.error || r.expectedReference?.combined || r.samples?.length > 0) && (
          <HelpTip title={`${r.model} 采样详情`} label={`查看 ${r.model} 采样说明`}>
            {r.reason || r.error ? <div>{r.reason || r.error}</div> : null}
            {r.expectedReference?.combined ? <div>合并参考类：{r.expectedReference.name}（该库不区分类内单个模型）</div> : null}
            {r.samples?.length > 0 ? <div>样本数字数（实际 / 期望）：{r.samples.map(s => `${s.count} / ${s.expected}`).join("；")}</div> : null}
          </HelpTip>
        )}
      </div>
      <span className={`fingerprint-status ${r.status}`}>{TITLES[r.status] || "证据不足"}</span>
    </div>
    <p>期望：{r.expected} · 归因：{r.predictionName || r.prediction || "未知"}{r.probability != null ? ` · ${(r.probability * 100).toFixed(2)}%` : ""}</p>
    {r.failure && <small>错误分类：{r.failure.code}{r.failure.httpStatus ? ` · HTTP ${r.failure.httpStatus}` : ""}{r.failure.upstreamCode ? ` · ${r.failure.upstreamCode}` : ""}</small>}
    {r.sampleFailures?.length > 0 && <details><summary>采样请求记录（{r.sampleFailures.length} 次异常）</summary><ul>{r.sampleFailures.map((f, i) => <li key={i}>第 {f.sample} 份样本 · 第 {f.attempt} 次请求：{f.message}{f.httpStatus ? `（HTTP ${f.httpStatus}）` : ""}{f.upstreamCode ? ` · ${f.upstreamCode}` : ""}</li>)}</ul></details>}
    <small>远端账号 ID：{r.accountId || "—"} · {r.status === "error" ? `采样完成：${r.completedSamples ?? 0}/3` : `有效样本：${r.usedOutputs ?? 0}/3`} · 参考库：{r.referenceBuiltAt || "—"}</small>
    {r.candidates?.length > 0 && <details><summary>查看候选归因</summary><ol>{r.candidates.map(c => <li key={c.model}>{c.name || c.model}：{c.probability == null ? "—" : `${(c.probability * 100).toFixed(2)}%`}</li>)}</ol></details>}
  </div>)}</div>;
}
function FingerprintHistoryDialog({ job, token, onClose }) {
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false;
    const load = async () => { try { const next = await api(token, `/api/jobs/${job.id}/model-fingerprint/history`); if (!stopped) { setData(next); setError(""); } } catch (e) { if (!stopped) setError(e.message); } };
    void load(); const timer = setInterval(load, 5000); return () => { stopped = true; clearInterval(timer); };
  }, [job.id, token, refresh]);
  const time = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return <Dialog title={`${job.email} 最近 6 轮归因结果`} onClose={onClose}><div className="fingerprint-form fingerprint-history">
    <div className="fingerprint-history-toolbar"><button className="secondary-button compact-btn" type="button" onClick={() => setRefresh(v => v + 1)}>刷新记录</button></div>
    {data && <>
      {!data.models.length && <p className="proxy-quality-error">尚未配置检测模型，请先在“降智检测设置”或账号独立设置中添加。</p>}
      {data.groupSyncError && <p role="alert" className="proxy-quality-error">号池分组同步：{data.groupSyncError}</p>}
      {data.lastError && <p role="alert" className="proxy-quality-error">{data.lastError}</p>}
      {!data.records.length ? <p className="fingerprint-history-empty">暂无检测记录。</p> : data.records.map((record, index) => <section key={`${record.checkedAt}-${index}`} className="fingerprint-history-record">
        <div className="fingerprint-history-heading">
          <div className="field-label-row">
            <strong>{time(record.checkedAt)}</strong>
            <span className="record-meta-tag">
              {record.source === "manual" ? "手动检测" : record.source === "scheduled" ? "自动检测" : "历史结果"}
              {record.durationMs != null ? ` · ${(record.durationMs / 1000).toFixed(1)}s` : ""}
            </span>
            {record.legacy && (
              <HelpTip title="旧版记录说明" label="查看旧版记录说明">
                旧版记录按当时结论保留，不回填或修改分组；新检测将使用修正后的参考类匹配。
              </HelpTip>
            )}
          </div>
          <span className={`fingerprint-status ${record.status}`}>{TITLES[record.status] || "证据不足"}</span>
        </div>
        <AttributionModels models={record.models || []} />{record.error && <p className="proxy-quality-error">{record.error}</p>}
      </section>)}
    </>}
    {!data && !error && <p>正在读取归因记录…</p>}{error && <p role="alert" className="proxy-quality-error">{error}</p>}
  </div></Dialog>;
}
export function ModelFingerprintCell({ job, token, onError }) {
  const [state, setState] = useState(job.modelFingerprint), [editing, setEditing] = useState(false), [showHistory, setShowHistory] = useState(false), [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => setState(job.modelFingerprint), [job.modelFingerprint]);
  if (!state) return <span className="muted">—</span>;
  async function update(body, check = false) {
    setBusy(true); setError(""); try { const result = await api(token, `/api/jobs/${job.id}/model-fingerprint${check ? "/check" : ""}`, body); setState(result.job.modelFingerprint); if (!check) setEditing(false); } catch (e) { setError(e.message); onError?.(e.message); } finally { setBusy(false); }
  }
  function open() { setDraft({ ...state.override, text: toText(state.override.models ?? state.models), customModels: state.override.models !== null, customInterval: state.override.intervalMinutes !== null, interval: state.override.intervalMinutes ?? state.intervalMinutes }); setError(""); setEditing(true); }
  const result = state.result;
  const recent = (state.recentResults || (result || state.previousResult ? [result || state.previousResult] : [])).slice(0, 6).reverse();
  const rounds = [...Array(6 - recent.length).fill(null), ...recent];
  const checking = state.phase === "running" || state.phase === "queued";
  return <div className="fingerprint-cell-body">
    <div className="fingerprint-cell-actions">
      <button type="button" role="switch" aria-checked={state.enabled} aria-label={`${job.email} 降智检测`} className={`status-toggle ${state.enabled ? "on" : ""}`} disabled={!token || busy} onClick={() => update({ ...state.override, enabled: !state.enabled })}><span className="status-toggle-track"><span className="status-toggle-thumb" /></span></button>
      <button type="button" className="fingerprint-check-button" disabled={!token || busy || checking || !state.models.length || !job.sub2apiInPool} onClick={() => update({}, true)}>{state.phase === "running" ? "检测中…" : state.phase === "queued" ? "排队中…" : "立即检测"}</button>
      <button type="button" className="icon-button compact-icon-btn" aria-label={`${job.email} 独立降智检测设置`} title="独立降智检测设置" onClick={open}><Settings2 size={14} /></button>
    </div>
    <div className="fingerprint-rounds" role="group" aria-label={`${job.email} 最近 6 轮检测结果`}>
      {rounds.map((round, index) => {
        const status = !round ? "empty" : round.status === "match" ? "match" : round.status === "mismatch" ? "mismatch" : "error";
        const label = !round ? "暂无检测记录" : `${round.status === "match" ? "通过" : round.status === "mismatch" ? "不一致" : round.status === "unknown" ? "证据不足" : "检测失败"} · ${new Date(round.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`;
        return <button key={round?.checkedAt || `empty-${index}`} type="button" className={`fingerprint-round ${status}`} aria-label={label} title={label} onClick={() => setShowHistory(true)} />;
      })}
    </div>
    {showHistory && <FingerprintHistoryDialog job={job} token={token} onClose={() => setShowHistory(false)} />}
    {editing && <Dialog title={`${job.email} 降智检测`} onClose={() => setEditing(false)}><form className="fingerprint-form" onSubmit={e => { e.preventDefault(); update({ enabled: draft.enabled, models: draft.customModels ? fromText(draft.text) : null, intervalMinutes: draft.customInterval ? draft.interval : null }); }}>
      <label className="settings-field"><span>账号检测开关</span><select aria-label="账号检测开关" value={draft.enabled == null ? "inherit" : String(draft.enabled)} onChange={e => setDraft({ ...draft, enabled: e.target.value === "inherit" ? null : e.target.value === "true" })}><option value="inherit">继承 PlanType</option><option value="true">独立开启</option><option value="false">独立关闭</option></select></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customModels} onChange={e => setDraft({ ...draft, customModels: e.target.checked })} />使用独立检测模型</label>
      <label className="settings-field"><span>账号检测模型</span><textarea aria-label="账号检测模型" rows={4} value={draft.text} disabled={!draft.customModels} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customInterval} onChange={e => setDraft({ ...draft, customInterval: e.target.checked })} />使用独立检测间隔</label>
      <label className="settings-field"><span>账号检测间隔（分钟）</span><input aria-label="账号检测间隔（分钟）" type="number" min="5" max="43200" disabled={!draft.customInterval} value={draft.interval} onChange={e => setDraft({ ...draft, interval: e.target.value })} /></label>
      {result && <section className="fingerprint-section"><h3>最近模型归因</h3>{result.models.map((r, i) => <p key={i}>{r.model} → {r.predictionName || r.prediction || r.error || "未知"} · {TITLES[r.status]} {r.probability != null ? `(${(r.probability * 100).toFixed(1)}%)` : ""}<small className="fingerprint-reference">期望：{r.expected}；参考库：{r.referenceBuiltAt || "—"}</small></p>)}</section>}
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><span className="dialog-actions-spacer" /><button type="button" className="cancel-button" onClick={() => setEditing(false)}>取消</button><button className="primary-button" disabled={busy}>保存账号检测设置</button></div>
    </form></Dialog>}
  </div>;
}
