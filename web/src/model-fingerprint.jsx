import React, { useEffect, useRef, useState } from "react";
import { Settings2, X } from "lucide-react";

const TITLES = { match: "指纹一致", mismatch: "疑似不一致", unknown: "证据不足", error: "请求失败" };
const toText = models => (models || []).map(m => m.expected === m.model ? m.model : `${m.model} => ${m.expected}`).join("\n");
const fromText = text => text.split(/\n/).map(line => line.trim()).filter(Boolean).map(line => { const [model, ...parts] = line.split("=>"); return { model: model.trim(), expected: parts.join("=>").trim() || model.trim() }; });
async function api(token, url, body) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "x-console-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "指纹检测请求失败"); return data;
}
function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { const previous = document.activeElement; const dialog = ref.current; dialog.showModal(); return () => { dialog.close(); previous?.focus?.(); }; }, []);
  return <dialog ref={ref} className="batch-dialog fingerprint-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button></div>{children}
  </dialog>;
}
export function FingerprintDefaultsFields({ value, onChange, disabled = false }) {
  const [text, setText] = useState(() => toText(value.models));
  return <section className="fingerprint-defaults" aria-label="默认降智检测规则">
    <label className="settings-field"><span>默认检测模型（每行一个，最多 8 个）</span><textarea aria-label="默认检测模型" rows={3} value={text} disabled={disabled} placeholder={"模型 ID\n模型别名 => 预期指纹名称"} onChange={event => { setText(event.target.value); onChange({ ...value, models: fromText(event.target.value) }); }} /></label>
    <div className="fingerprint-two-fields">
      <label className="settings-field"><span>默认检测间隔（分钟）</span><input aria-label="默认检测间隔（分钟）" type="number" min="5" max="43200" value={value.intervalMinutes ?? 360} disabled={disabled} onChange={event => onChange({ ...value, intervalMinutes: event.target.value })} /></label>
      <label className="settings-field"><span>最低归因概率</span><input aria-label="最低归因概率" type="number" min="0.5" max="1" step="0.05" value={value.minProbability ?? 0.8} disabled={disabled} onChange={event => onChange({ ...value, minProbability: event.target.value })} /></label>
    </div>
    <p className="task-settings-help">每个模型每轮发送 3 条数字指纹提示词，会使用账号额度。名称可写为“请求模型 =&gt; 参考库指纹名称”。仅完整、可校准的高概率结果参与匹配；归因是参考库内的统计排序，不等同于模型身份或智力证明。</p>
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
  return <><button type="button" className="secondary-button" disabled={!token || busy} onClick={open}><Settings2 size={16} />降智检测设置</button>
    {!data && error && <span role="alert" className="proxy-quality-error">{error}</span>}
    {data && <Dialog title="降智检测设置" onClose={() => setData(null)}><form onSubmit={save} className="fingerprint-form">
      <FingerprintDefaultsFields value={data.settings} onChange={settings => setData(current => ({ ...current, settings }))} disabled={busy} />
      <div><button type="button" className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { setReference(await api(token, "/api/model-fingerprint/reference")); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>读取指纹参考库模型</button>{reference && <p className="task-settings-help">参考库 {reference.builtAt}：{reference.models.map(m => m.id).join("、")}</p>}</div>
      <section className="fingerprint-section"><h3>PlanType 默认开关</h3><p className="task-settings-help">未配置的 PlanType 默认关闭；账号独立设置优先。新账号识别订阅类型后自动继承。</p>
        <div className="fingerprint-plan-list">{plans.map(plan => <label key={plan}><input type="checkbox" checked={data.settings.planDefaults[plan] === true} onChange={e => patch({ planDefaults: { ...data.settings.planDefaults, [plan]: e.target.checked } })} /><span>{plan}</span></label>)}</div>
        <div className="fingerprint-add-plan"><input aria-label="添加检测 PlanType" value={newPlan} onChange={e => setNewPlan(e.target.value)} placeholder="自定义原始 PlanType" /><button type="button" className="secondary-button" disabled={!newPlan.trim()} onClick={() => { patch({ planDefaults: { ...data.settings.planDefaults, [newPlan.trim().toLowerCase()]: false } }); setNewPlan(""); }}>添加类型</button></div>
      </section>
      <section className="fingerprint-section"><h3>号池分组加入规则</h3><p className="task-settings-help">读取各 PlanType 所绑定方案的默认分组。默认加入始终保留；不降智加入要求全部指定模型指纹一致。明确不一致时移出条件组；未知结果不改已有分组，新上传账号需通过后才加入条件组。不改其它分组。</p>
        {data.profiles.map(profile => <fieldset key={profile.id} className="fingerprint-profile"><legend>{profile.name} · {(profile.planTypes || []).join(" / ") || "未绑定 PlanType"}</legend>
          {!profile.groupIds.length && <p className="task-settings-help">此方案未指定分组，请先在 Sub2API 配置中选择号池。</p>}
          {profile.groupIds.map(id => <label className="fingerprint-group-rule" key={id}><span>{data.groups.find(g => String(g.id) === String(id))?.name || `分组 ${id}`}</span><select aria-label={`${profile.name} 分组 ${id} 加入规则`} value={data.settings.groupPolicies[profile.id]?.[id] || "default"} onChange={e => patch({ groupPolicies: { ...data.settings.groupPolicies, [profile.id]: { ...data.settings.groupPolicies[profile.id], [id]: e.target.value } } })}><option value="default">默认加入</option><option value="verified">不降智加入（指纹一致）</option></select></label>)}
        </fieldset>)}
      </section>
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setData(null)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存降智检测设置"}</button></div>
    </form></Dialog>}
  </>;
}
export function ModelFingerprintCell({ job, token, onError }) {
  const [state, setState] = useState(job.modelFingerprint), [editing, setEditing] = useState(false), [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => setState(job.modelFingerprint), [job.modelFingerprint]);
  if (!state) return <span>—</span>;
  async function update(body, check = false) {
    setBusy(true); setError(""); try { const result = await api(token, `/api/jobs/${job.id}/model-fingerprint${check ? "/check" : ""}`, body); setState(result.job.modelFingerprint); if (!check) setEditing(false); } catch (e) { setError(e.message); onError?.(e.message); } finally { setBusy(false); }
  }
  function open() { setDraft({ ...state.override, text: toText(state.override.models ?? state.models), customModels: state.override.models !== null, customInterval: state.override.intervalMinutes !== null, interval: state.override.intervalMinutes ?? state.intervalMinutes }); setError(""); setEditing(true); }
  const result = state.result;
  return <div className="fingerprint-cell-body">
    <div className="fingerprint-cell-actions"><button type="button" role="switch" aria-checked={state.enabled} aria-label={`${job.email} 降智检测`} className={`status-toggle ${state.enabled ? "on" : ""}`} disabled={!token || busy} onClick={() => update({ ...state.override, enabled: !state.enabled })}><span className="status-toggle-track"><span className="status-toggle-thumb" /></span><span>{state.enabled ? "开启" : "关闭"}</span></button><button type="button" className="icon-button" aria-label={`${job.email} 独立降智检测设置`} onClick={open}><Settings2 size={14} /></button></div>
    <span className={`fingerprint-status ${result?.status || "unknown"}`}>{state.phase === "running" ? "检测中…" : !state.models.length ? "待配置模型" : result ? TITLES[result.status] : state.previousResult ? "配置已变更，待复检" : "尚未检测"}</span>
    <small>{state.override.enabled == null ? "继承 PlanType" : "账号独立开关"} · {state.intervalMinutes} 分钟</small>
    {result && <small title={result.models.map(r => `${r.model} → ${r.predictionName || r.prediction || "未知"} (${r.probability == null ? "—" : `${Math.round(r.probability * 100)}%`})`).join("\n")}>{result.models.map(r => `${r.model}：${TITLES[r.status]}`).join("；")}</small>}
    {result && <small>{new Date(result.checkedAt).toLocaleString("zh-CN")}</small>}
    {(state.lastError || state.groupSyncError) && <small className="proxy-quality-error">{state.lastError || state.groupSyncError}</small>}
    <button type="button" className="fingerprint-check-button" disabled={!token || busy || state.phase === "running" || !state.models.length || !job.sub2apiInPool} onClick={() => update({}, true)}>立即检测</button>
    {editing && <Dialog title={`${job.email} 降智检测`} onClose={() => setEditing(false)}><form className="fingerprint-form" onSubmit={e => { e.preventDefault(); update({ enabled: draft.enabled, models: draft.customModels ? fromText(draft.text) : null, intervalMinutes: draft.customInterval ? draft.interval : null }); }}>
      <label className="settings-field"><span>账号检测开关</span><select aria-label="账号检测开关" value={draft.enabled == null ? "inherit" : String(draft.enabled)} onChange={e => setDraft({ ...draft, enabled: e.target.value === "inherit" ? null : e.target.value === "true" })}><option value="inherit">继承 PlanType</option><option value="true">独立开启</option><option value="false">独立关闭</option></select></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customModels} onChange={e => setDraft({ ...draft, customModels: e.target.checked })} />使用独立检测模型</label>
      <label className="settings-field"><span>账号检测模型</span><textarea aria-label="账号检测模型" rows={4} value={draft.text} disabled={!draft.customModels} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
      <label className="fingerprint-checkbox"><input type="checkbox" checked={draft.customInterval} onChange={e => setDraft({ ...draft, customInterval: e.target.checked })} />使用独立检测间隔</label>
      <label className="settings-field"><span>账号检测间隔（分钟）</span><input aria-label="账号检测间隔（分钟）" type="number" min="5" max="43200" disabled={!draft.customInterval} value={draft.interval} onChange={e => setDraft({ ...draft, interval: e.target.value })} /></label>
      {result && <section className="fingerprint-section"><h3>最近模型归因</h3>{result.models.map((r, i) => <p key={i}>{r.model} → {r.predictionName || r.prediction || r.error || "未知"} · {TITLES[r.status]} {r.probability != null ? `(${(r.probability * 100).toFixed(1)}%)` : ""}<small className="fingerprint-reference">期望：{r.expected}；参考库：{r.referenceBuiltAt || "—"}</small></p>)}</section>}
      {error && <p role="alert" className="proxy-quality-error">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>取消</button><button className="primary-button" disabled={busy}>保存账号检测设置</button></div>
    </form></Dialog>}
  </div>;
}
