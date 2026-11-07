import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { formatSmsMoney } from './sms-money.mjs';
import { displayDateTime } from './display-time.mjs';
import { useDisplayTimeZone } from './use-display-time.jsx';

export function SmsProviderBalance({ token, endpoint, apiKey, disabled = false }) {
  useDisplayTimeZone();
  const context = JSON.stringify([endpoint, String(apiKey || '').trim(), token]);
  const latest = useRef(context), pending = useRef(null);
  latest.current = context;
  const [state, setState] = useState(null);
  const current = state?.context === context ? state : null;
  useEffect(() => () => {
    if (pending.current?.context === context) { pending.current.controller.abort(); pending.current = null; }
  }, [context]);
  async function query() {
    if (disabled || !token || !String(apiKey || '').trim() || pending.current?.context === context) return;
    pending.current?.controller.abort();
    const request = { context, controller: new AbortController() };
    pending.current = request;
    setState(before => ({ context, loading: true, balance: before?.context === context ? before.balance : null, fetchedAt: before?.context === context ? before.fetchedAt : null, error: '' }));
    const active = () => pending.current === request && latest.current === context && !request.controller.signal.aborted;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'x-console-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ config: { apiKey: String(apiKey).trim() } }), signal: request.controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `余额查询失败（HTTP ${response.status}）`);
      if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(data.balance?.amount || '') || data.balance?.currency !== 'USD') throw new Error('余额查询返回格式不正确');
      if (active()) setState({ context, loading: false, balance: data.balance, fetchedAt: data.fetchedAt, error: '' });
    } catch (error) {
      if (active()) setState(before => ({ ...before, context, loading: false, error: error.message }));
    } finally { if (pending.current === request) pending.current = null; }
  }
  return <div className="sms-balance-panel">
    <div className="sms-balance-row">
      <span className="sms-balance-value" role="status" aria-live="polite" title={current?.fetchedAt ? `查询时间：${displayDateTime(current.fetchedAt)}` : undefined}>
        <Wallet size={15} aria-hidden="true" />
        {current?.balance ? `账户余额 ${formatSmsMoney(current.balance.amount, current.balance.currency)}${current.error ? '（上次查询）' : ''}` : '账户余额 未查询'}
      </span>
      <button type="button" className="price-refresh-button" onClick={query} disabled={disabled || !token || !String(apiKey || '').trim() || current?.loading}>
        <RefreshCw size={15} className={current?.loading ? 'spin' : ''} aria-hidden="true" />{current?.loading ? '查询余额中…' : '查询余额'}
      </button>
    </div>
    {current?.error && <p className="dialog-error" role="alert">{current.error}</p>}
  </div>;
}
