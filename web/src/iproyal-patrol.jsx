import React, { useEffect, useRef, useState } from 'react';
import { IPROYAL_DEFAULTS, iproyalSettings } from '../../shared/iproyal-settings.mjs';

const route = '/api/iproyal/patrol';

export function IproyalPatrol({ request, onUpdated }) {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [desiredEnabled, setDesiredEnabled] = useState(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [draft, setDraft] = useState(null);
  const version = useRef(0);
  const updated = useRef(onUpdated), lastRun = useRef(0);
  updated.current = onUpdated;
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      const seq = version.current;
      let result;
      try {
        result = await request(route, { signal: controller.signal });
        if (!controller.signal.aborted && seq === version.current) {
          setState(result);
          if (result.lastRun && lastRun.current !== result.lastRun) {
            lastRun.current = result.lastRun;
            updated.current?.();
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && seq === version.current) setError(e.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, result?.running ? 2000 : 10000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [request]);
  async function change(options, desired = null) {
    setPending(true);
    setDesiredEnabled(desired);
    setError('');
    version.current++;
    try { setState(await request(route, options)); updated.current?.(); return true; }
    catch (e) { setError(e.message); return false; }
    finally { version.current++; setDesiredEnabled(null); setPending(false); }
  }
  const form = draft ?? { ...IPROYAL_DEFAULTS, ...state };
  const edit = (key, value) => setDraft(current => ({ ...IPROYAL_DEFAULTS, ...state, ...current, [key]: value }));
  async function saveSettings(e) {
    e.preventDefault();
    let patch;
    try {
      patch = iproyalSettings({ ...form, enabled: Boolean(state.enabled), intervalMinutes: Number(form.intervalMinutes),
        thresholdGbPerIp: form.thresholdGbPerIp === '' ? NaN : Number(form.thresholdGbPerIp),
        usdToCny: form.usdToCny === '' || form.usdToCny === null ? null : Number(form.usdToCny) });
    } catch (e) { setError(e.message); return; }
    if (await change({ method: 'PUT', body: JSON.stringify(patch) })) setDraft(null);
  }
  async function testConnection() {
    setPending(true);
    setConnection('');
    setError('');
    try {
      const r = await request('/api/iproyal/test-connection', { method: 'POST' });
      setConnection(`连接成功 · ${r.ipCount} 个 IP，${r.orderCount} 笔订单 · ${r.bandwidthChecked ? '已验证余额读取' : '当前没有可验证余额的订单'}`);
    } catch (e) { setError(e.message); }
    finally { setPending(false); }
  }
  return <section className="proxy-sub2api-section" aria-label="IPRoyal 巡检">
    <div className="proxy-sub2api-header">
      <label><input type="checkbox" role="switch" checked={desiredEnabled ?? Boolean(state?.enabled)} disabled={pending || !state}
        onChange={e => change({ method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }, e.target.checked)} /> IPRoyal 巡检</label>
      <button type="button" className="secondary-button compact-btn" disabled={pending} onClick={testConnection}>测试连接</button>
      <button type="button" className="secondary-button compact-btn" disabled={pending || !state?.enabled || state.running}
        onClick={() => change({ method: 'POST' })}>立即巡检</button>
    </div>
    <small>按订单更新剩余流量，匹配的代理使用订单编号，多 IP 订单追加固定序号。</small>
    <form className="iproyal-settings-form" onSubmit={saveSettings}>
      <label>巡检间隔（分钟）<input type="number" min="1" max="1440" step="1" required disabled={pending || !state}
        value={form.intervalMinutes} onChange={e => edit('intervalMinutes', e.target.value)} /></label>
      <label className="iproyal-check"><input type="checkbox" role="switch" checked={form.autoPause} disabled={pending || !state}
        onChange={e => edit('autoPause', e.target.checked)} />流量达到阈值时暂停新分配</label>
      <label>单 IP 剩余流量阈值（GB）<input type="number" min="0" max="1000000" step="any" required disabled={pending || !state}
        value={form.thresholdGbPerIp} onChange={e => edit('thresholdGbPerIp', e.target.value)} /></label>
      <small>订单阈值 = 单 IP 阈值 × 订单全部独立 IP 数。余额 ≤ 阈值时暂停该订单的新分配；余额恢复后自动解除，手动暂停保持。</small>
      <label className="iproyal-check"><input type="checkbox" role="switch" checked={form.syncCost} disabled={pending || !state}
        onChange={e => edit('syncCost', e.target.checked)} />巡检同步 IP 成本</label>
      <label>美元兑人民币汇率<input type="number" min="0.000001" max="1000" step="any" required={form.syncCost} disabled={pending || !state}
        value={form.usdToCny ?? ''} placeholder="填写实际换算汇率" onChange={e => edit('usdToCny', e.target.value)} /></label>
      <small>按订单实付美元总额 ÷ 购买 IP 数 × 汇率，四舍五入到分。成本对应当前购买周期，同一出口只计一次。</small>
      <div className="iproyal-settings-actions">
        <button type="submit" className="secondary-button compact-btn" disabled={pending || !state || !draft}>保存巡检设置</button>
        {draft && <button type="button" className="secondary-button compact-btn" disabled={pending} onClick={() => setDraft(null)}>撤销修改</button>}
        <small>{state?.enabled ? `当前每 ${state.intervalMinutes ?? 5} 分钟巡检` : '巡检已关闭'}{draft ? ' · 有未保存修改' : ''}</small>
      </div>
    </form>
    {connection && <small role="status">{connection}</small>}
    {state?.enabled && <small role="status">{state.running ? '正在巡检…' : state.message || '等待首次巡检'}</small>}
    {error && <div role="alert" className="dialog-error">{error}</div>}
  </section>;
}

export function IproyalBalance({ record }) {
  if (!record) return null;
  if (record.status !== 'matched') return <small>{record.status === 'ambiguous' ? '订单归属冲突' : '未匹配当前 IPRoyal 库存'}</small>;
  const time = record.at ? new Date(record.at).toLocaleString() : '';
  const text = Number.isFinite(record.gb_balance) ? `剩余 ${record.gb_balance.toFixed(2)} GB` : '余额待查';
  return <small title={`订单 ${record.order}，同单共享。${time ? '上次成功更新 ' + time : ''}`}>
    IPRoyal · {text}{record.stale ? '（待刷新）' : ''}
    {Number.isFinite(record.thresholdGb) && ` · 阈值 ${record.thresholdGb} GB（${record.ipCount} IP）`}
    {record.autoAllocationPaused && ' · 自动暂停分配'}
    {record.cost && ` · $${record.cost.usdPerIp.toFixed(2)}/IP · ${record.cost.days} 天${record.costStale ? '（价格待刷新）' : ''}`}</small>;
}
