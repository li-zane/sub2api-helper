import React, { useRef, useState } from 'react';

function usePolicySave(node, request, onSaved) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function save(patch) {
    if (busy.current) return false;
    busy.current = true; setPending(true); setError('');
    try {
      const policy = await request(`/api/sub2api/proxies/${node.id}/allocation`, { method: 'PUT', body: JSON.stringify(patch) });
      onSaved(node, policy);
      return true;
    } catch (e) { setError(e.message); return false; }
    finally { busy.current = false; setPending(false); }
  }
  return { save, pending, error };
}

export function ProxyAllocationControl({ node, request, onSaved, disabled }) {
  const { save, pending, error } = usePolicySave(node, request, onSaved);
  const auto = Boolean(node.iproyal?.autoAllocationPaused);
  return <div className="proxy-allocation-control">
    <button type="button" role="switch" className="proxy-management-switch"
      aria-label={`参与分配 · ${node.name} · #${node.id}`} aria-checked={!node.allocationPaused && !auto}
      aria-busy={pending} disabled={disabled || pending || auto}
      title={auto ? '订单余额达到阈值，巡检自动暂停新分配' : '仅影响新分配，已有绑定继续使用'}
      onClick={() => save({ allocationPaused: !node.allocationPaused })}>
      <span className="proxy-management-switch-text">{pending ? '保存中' : auto ? '流量暂停' : '参与分配'}</span>
      <span className="proxy-management-switch-track" aria-hidden="true"><span className="proxy-management-switch-thumb" /></span>
    </button>
    {node.allocationPaused && auto && <small>手动暂停已保留</small>}
    {error && <small role="alert" className="proxy-management-node-error">{error}</small>}
  </div>;
}

export function ProxyCostControl({ node, request, onSaved, disabled }) {
  const [draft, setDraft] = useState(null);
  const { save, pending, error } = usePolicySave(node, request, onSaved);
  const synced = node.iproyal?.costSyncEnabled;
  const value = (synced ? null : draft) ?? String(node.ipCostCny ?? 0);
  return <form className="proxy-cost-control" onSubmit={async e => {
    e.preventDefault();
    if (!synced && await save({ ipCostCny: value })) setDraft(null);
  }}>
    <label>IP 成本（元）<input aria-label={`IP 成本（元）· ${node.ipAddress || node.host}`} type="number"
      min="0" max="1000000000" step="0.01" required value={value} disabled={disabled || pending || synced}
      onChange={e => setDraft(e.target.value)} /></label>
    {!synced && <button type="submit" className="secondary-button compact-btn" disabled={disabled || pending || draft === null}>
      {pending ? '保存中…' : '保存成本'}</button>}
    <small>{synced ? '随 IPRoyal 巡检同步' : '同一出口 IP 共用一份成本'}</small>
    {error && <small role="alert" className="proxy-management-node-error">{error}</small>}
  </form>;
}
