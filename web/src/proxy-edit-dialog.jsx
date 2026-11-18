import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, Globe2, LoaderCircle, Power, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { AccessibleDialog } from './accessible-dialog.jsx';
import { CustomSelect } from './custom-select.jsx';
import { normalizeProxyInput } from './proxy-input.mjs';
import './proxy-create-dialog.css';
import './proxy-edit-dialog.css';

const protocols = ['http', 'https', 'socks5', 'socks5h'].map(value => ({ value, label: value.toUpperCase() }));

export function ProxyEditDialog({ proxies, request, onClose, onSaved, onStatusChanged, onDeleted }) {
  const titleId = useId();
  const deleteTitleId = useId();
  const [selectedId, setSelectedId] = useState(proxies[0].id);
  const [draft, setDraft] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [clearPassword, setClearPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setDraft(null); setLoaded(null); setError(''); setClearPassword(false);
    void request(`/api/sub2api/proxies/${selectedId}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      const proxy = data.proxy;
      setDraft({ name: proxy.name, protocol: proxy.protocol, host: proxy.host, port: String(proxy.port), username: proxy.username || '', password: '' });
      setLoaded(data);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message || '读取代理配置失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId, request, reload]);

  const change = (field, value) => setDraft(current => ({ ...current, [field]: value }));
  const close = () => { if (!busyRef.current) onClose(); };
  const ready = !loading && loaded?.proxy.id === selectedId && Boolean(loaded.revision);
  const saving = pending === 'save';
  const deleting = pending === 'delete';
  const changingStatus = pending === 'status';
  const hasPassword = Boolean(loaded?.proxy.hasPassword);
  const status = loaded?.proxy.status;
  const active = status === 'active';
  const inactive = status === 'inactive' || status === 'disabled';
  async function save(event) {
    event.preventDefault();
    if (busyRef.current || !draft || !ready || confirmDelete) return;
    let validated;
    try { validated = normalizeProxyInput({ ...draft, password: clearPassword ? '' : draft.password }); }
    catch (e) { setError(e.message); return; }
    const { expires_at, password, ...fields } = validated;
    const body = { ...fields, revision: loaded.revision };
    if (clearPassword || password) body.password = password;
    busyRef.current = true; setPending('save'); setError('');
    try {
      const result = await request(`/api/sub2api/proxies/${selectedId}`, { method: 'PUT', body: JSON.stringify(body) });
      if (!aliveRef.current) return;
      onSaved?.(result.proxy);
      onClose();
    } catch (e) { if (aliveRef.current) setError(e.message || '保存代理失败'); }
    finally { busyRef.current = false; if (aliveRef.current) setPending(null); }
  }
  async function toggleStatus() {
    if (busyRef.current || !ready || confirmDelete || (!active && !inactive)) return;
    busyRef.current = true; setPending('status'); setError('');
    try {
      const result = await request(`/api/sub2api/proxies/${selectedId}`, {
        method: 'PATCH', body: JSON.stringify({ status: active ? 'inactive' : 'active', revision: loaded.revision }),
      });
      if (!aliveRef.current) return;
      setLoaded(result);
      onStatusChanged?.(result.proxy);
    } catch (e) { if (aliveRef.current) setError(e.message || '切换代理状态失败'); }
    finally { busyRef.current = false; if (aliveRef.current) setPending(null); }
  }
  async function remove() {
    if (busyRef.current || !ready || !confirmDelete) return;
    busyRef.current = true; setPending('delete'); setDeleteError('');
    try {
      await request(`/api/sub2api/proxies/${selectedId}`, { method: 'DELETE', body: JSON.stringify({ revision: loaded.revision }) });
      if (!aliveRef.current) return;
      onDeleted(selectedId);
      onClose();
    } catch (e) {
      if (aliveRef.current) setDeleteError(e.message || '删除代理失败');
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setPending(null);
    }
  }
  const disabled = loading || Boolean(pending);
  return (
    <>
    <AccessibleDialog className="proxy-create-dialog proxy-edit-dialog" labelledBy={titleId} closeDisabled={Boolean(pending)} onClose={close}>
      <div className="dialog-header">
        <div className="proxy-create-title-row">
          <Globe2 size={18} className="proxy-title-icon" aria-hidden="true" />
          <h2 id={titleId}>编辑代理</h2>
        </div>
        <button type="button" className="icon-button" data-dialog-initial-focus disabled={Boolean(pending)} onClick={close} aria-label="关闭编辑代理"><X size={18} /></button>
      </div>
      <form onSubmit={save} noValidate>
        <div className="proxy-create-body">
          {proxies.length > 1 && (
            <div className="proxy-input-group">
              <span className="proxy-field-title">代理节点</span>
              <CustomSelect value={String(selectedId)} disabled={Boolean(pending)} aria-label="选择代理节点"
                options={proxies.map(proxy => ({ value: String(proxy.id), label: `${proxy.name} · ${proxy.protocol.toUpperCase()} · ${proxy.host}:${proxy.port}` }))}
                onChange={event => setSelectedId(Number(event?.target?.value ?? event))} />
            </div>
          )}
          {loading && <div className="proxy-edit-loading" role="status"><LoaderCircle size={16} className="spin" />读取代理配置…</div>}
          {error && <div className="proxy-error-banner" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
          {ready && (active || inactive) && <div className="proxy-edit-state">
            <div>
              <span className="proxy-field-title" role="status">{active ? '代理已启用' : '代理已停用'}</span>
              <p>停用后暂停新绑定，保留现有绑定。重新启用仍受代理有效期限制。</p>
            </div>
            <button type="button" className="secondary-button" disabled={disabled} onClick={toggleStatus}>
              {changingStatus ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />}
              {active ? '停用代理' : '启用代理'}
            </button>
          </div>}
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
          <div className="proxy-edit-secondary-actions">
            <button type="button" className="danger-button" disabled={disabled || !ready} onClick={() => {
              setDeleteError('');
              setConfirmDelete(true);
            }}><Trash2 size={14} />删除代理</button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => setReload(value => value + 1)}>
              <RefreshCw size={14} />重新读取
            </button>
          </div>
          <div className="proxy-footer-form-actions">
            <button type="button" className="cancel-button" disabled={Boolean(pending)} onClick={close}>取消</button>
            <button type="submit" className="primary-button" disabled={disabled || !ready}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存修改
            </button>
          </div>
        </div>
      </form>
    </AccessibleDialog>
    {confirmDelete && ready && (
      <AccessibleDialog className="proxy-create-dialog proxy-delete-dialog" labelledBy={deleteTitleId}
        closeDisabled={deleting} onClose={() => { if (!busyRef.current) setConfirmDelete(false); }}>
        <div className="dialog-header"><h2 id={deleteTitleId}>删除代理</h2></div>
        <div className="proxy-create-body">
          <p>从号池删除 <strong>{loaded.proxy.name}</strong>（{loaded.proxy.protocol.toUpperCase()} · {loaded.proxy.host}:{loaded.proxy.port}）？</p>
          <p>删除后需要重新添加才能使用。</p>
          <p>如果该代理仍有绑定账号，请先从账号列表的「绑定 IP」更换或解除绑定，等重新登录和同步完成后再删除。</p>
          {deleteError && <div className="proxy-error-banner" role="alert"><AlertCircle size={15} /><span>{deleteError}</span></div>}
        </div>
        <div className="dialog-footer proxy-dialog-footer">
          <button type="button" className="cancel-button" data-dialog-initial-focus disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</button>
          <button type="button" className="danger-button" disabled={deleting} onClick={remove}>
            {deleting ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
            {deleting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </AccessibleDialog>
    )}
    </>
  );
}
