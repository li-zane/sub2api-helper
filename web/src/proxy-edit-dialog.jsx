import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Globe2, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import { AccessibleDialog } from './accessible-dialog.jsx';
import { CustomSelect } from './custom-select.jsx';
import { normalizeProxyInput } from './proxy-input.mjs';
import './proxy-create-dialog.css';
import './proxy-edit-dialog.css';

const protocols = ['http', 'https', 'socks5', 'socks5h'].map(value => ({ value, label: value.toUpperCase() }));

export function ProxyEditDialog({ proxies, request, onClose, onSaved }) {
  const titleId = useId();
  const [selectedId, setSelectedId] = useState(proxies[0].id);
  const [draft, setDraft] = useState(null);
  const [revision, setRevision] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setDraft(null); setRevision(''); setError(''); setClearPassword(false);
    void request(`/api/sub2api/proxies/${selectedId}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      const proxy = data.proxy;
      setDraft({ name: proxy.name, protocol: proxy.protocol, host: proxy.host, port: String(proxy.port), username: proxy.username || '', password: '' });
      setHasPassword(Boolean(proxy.hasPassword)); setRevision(data.revision);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || '读取代理配置失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId, request, reload]);

  const change = (field, value) => setDraft(current => ({ ...current, [field]: value }));
  const close = () => { if (!busyRef.current) onClose(); };
  async function save(event) {
    event.preventDefault();
    if (busyRef.current || !draft || !revision) return;
    let validated;
    try { validated = normalizeProxyInput({ ...draft, password: clearPassword ? '' : draft.password }); }
    catch (e) { setError(e.message); return; }
    const { expires_at, password, ...fields } = validated;
    const body = { ...fields, revision };
    if (clearPassword || password) body.password = password;
    busyRef.current = true; setSaving(true); setError('');
    try {
      const result = await request(`/api/sub2api/proxies/${selectedId}`, { method: 'PUT', body: JSON.stringify(body) });
      if (!aliveRef.current) return;
      onSaved?.(result.proxy);
      onClose();
    } catch (e) { if (aliveRef.current) setError(e.message || '保存代理失败'); }
    finally { busyRef.current = false; if (aliveRef.current) setSaving(false); }
  }
  const disabled = loading || saving;
  return (
    <AccessibleDialog className="proxy-create-dialog proxy-edit-dialog" labelledBy={titleId} closeDisabled={saving} onClose={close}>
      <div className="dialog-header">
        <div className="proxy-create-title-row">
          <Globe2 size={18} className="proxy-title-icon" aria-hidden="true" />
          <h2 id={titleId}>编辑代理</h2>
        </div>
        <button type="button" className="icon-button" data-dialog-initial-focus disabled={saving} onClick={close} aria-label="关闭编辑代理"><X size={18} /></button>
      </div>
      <form onSubmit={save} noValidate>
        <div className="proxy-create-body">
          {proxies.length > 1 && (
            <div className="proxy-input-group">
              <span className="proxy-field-title">代理节点</span>
              <CustomSelect value={String(selectedId)} disabled={saving} aria-label="选择代理节点"
                options={proxies.map(proxy => ({ value: String(proxy.id), label: `${proxy.name} · ${proxy.protocol.toUpperCase()} · ${proxy.host}:${proxy.port}` }))}
                onChange={event => setSelectedId(Number(event?.target?.value ?? event))} />
            </div>
          )}
          {loading && <div className="proxy-edit-loading" role="status"><LoaderCircle size={16} className="spin" />读取代理配置…</div>}
          {error && <div className="proxy-error-banner" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
          {draft && <div className="proxy-form-grid">
            <div className="proxy-form-row">
              <label className="proxy-input-group"><span className="proxy-field-title">代理名称 *</span>
                <input className="proxy-text-input" value={draft.name} maxLength={100} disabled={disabled} onChange={e => change('name', e.target.value)} />
              </label>
              <div className="proxy-input-group"><span className="proxy-field-title">协议 *</span>
                <CustomSelect value={draft.protocol} options={protocols} disabled={disabled} aria-label="选择协议" onChange={e => change('protocol', e?.target?.value ?? e)} />
              </div>
            </div>
            <div className="proxy-form-row host-port-row">
              <label className="proxy-input-group host-input-group"><span className="proxy-field-title">主机地址 / IP *</span>
                <input className="proxy-text-input" value={draft.host} disabled={disabled} spellCheck={false} onChange={e => change('host', e.target.value)} />
              </label>
              <label className="proxy-input-group port-input-group"><span className="proxy-field-title">端口 *</span>
                <input className="proxy-text-input" type="number" min="1" max="65535" value={draft.port} disabled={disabled} onChange={e => change('port', e.target.value)} />
              </label>
            </div>
            <div className="proxy-form-row">
              <label className="proxy-input-group"><span className="proxy-field-title">用户名（可选）</span>
                <input className="proxy-text-input" value={draft.username} autoComplete="off" disabled={disabled} onChange={e => change('username', e.target.value)} />
              </label>
              <label className="proxy-input-group"><span className="proxy-field-title">密码（可选）</span>
                <input className="proxy-text-input" type="password" value={draft.password} autoComplete="new-password" disabled={disabled || clearPassword}
                  placeholder={hasPassword ? '已设置，留空保留原密码' : '无认证请留空'} onChange={e => change('password', e.target.value)} />
              </label>
            </div>
            {hasPassword && <label className="proxy-edit-clear-password"><input type="checkbox" checked={clearPassword} disabled={disabled}
              onChange={e => { setClearPassword(e.target.checked); change('password', ''); }} />清除已保存密码</label>}
          </div>}
        </div>
        <div className="dialog-footer proxy-dialog-footer">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => setReload(value => value + 1)}>
            <RefreshCw size={14} />重新读取
          </button>
          <div className="proxy-footer-form-actions">
            <button type="button" className="cancel-button" disabled={saving} onClick={close}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled || !draft}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存修改
            </button>
          </div>
        </div>
      </form>
    </AccessibleDialog>
  );
}
