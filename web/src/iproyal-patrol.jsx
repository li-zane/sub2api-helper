import React, { useEffect, useRef, useState } from 'react';

const route = '/api/iproyal/patrol';

export function IproyalPatrol({ request }) {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [desiredEnabled, setDesiredEnabled] = useState(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const version = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      const seq = version.current;
      let result;
      try {
        result = await request(route, { signal: controller.signal });
        if (!controller.signal.aborted && seq === version.current) setState(result);
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
    try { setState(await request(route, options)); }
    catch (e) { setError(e.message); }
    finally { version.current++; setDesiredEnabled(null); setPending(false); }
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
    <small>每 5 分钟按订单更新剩余流量。开启后会将匹配的代理改为订单编号，多 IP 订单追加固定序号。</small>
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
    IPRoyal · {text}{record.stale ? '（待刷新）' : ''}</small>;
}
