import React, { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { displayDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";
import "./bound-ip-dialog.css";

export function BoundIpDialog({ job, loadOptions, request, blockedReason, onClose, onStarted }) {
  const titleId = useId();
  const formId = useId();
  const [options, setOptions] = useState(null);
  const [readError, setReadError] = useState("");
  const [writeError, setWriteError] = useState("");
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setOptions(null);
    setReadError("");
    setTarget(null);
    void loadOptions(controller.signal).then(data => {
      if (!controller.signal.aborted) setOptions(data);
    }).catch(error => {
      if (!controller.signal.aborted) setReadError(error.message || "读取 IP 失败");
    });
    return () => controller.abort();
  }, [loadOptions, reload]);

  const currentIds = new Set((job.boundProxies || []).map(proxy => Number(proxy.id)).filter(id => id > 0));
  if (job.assignedProxyId && !currentIds.size) currentIds.add(Number(job.assignedProxyId));
  const isBound = currentIds.size > 0 || job.boundProxyStatus === "bound";
  const unavailable = blockedReason || (job.sub2apiRateLimited || job.sub2apiQuotaRestricted
    ? "账号当前受限，请在状态恢复后再更换绑定"
    : job.canForceRelogin !== true || job.canLogoutAllSessions !== true
      ? "请先确认账号有可用的登录会话"
      : "");
  const isCurrent = id => id === 0 ? !isBound : currentIds.size === 1 && currentIds.has(id);
  const close = () => { if (!pending.current) onClose(); };

  async function submit(event) {
    event.preventDefault();
    if (pending.current || !options || unavailable || target === null || isCurrent(target)) return;
    pending.current = true;
    setBusy(true);
    setWriteError("");
    try {
      const result = await request(`/api/jobs/${encodeURIComponent(job.id)}/proxy-binding`, {
        method: "POST", body: JSON.stringify({ proxyId: target }),
      });
      onStarted(result.job);
    } catch (error) {
      setWriteError(error.message || "切换绑定失败");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <AccessibleDialog className="bound-ip-dialog" labelledBy={titleId} closeDisabled={busy} onClose={close}>
    <div className="dialog-header">
      <h2 id={titleId}>切换绑定 IP</h2>
      <button type="button" className="icon-button" onClick={close} disabled={busy} aria-label="关闭切换绑定 IP"><X size={17} /></button>
    </div>
    <div className="bound-ip-dialog-body">
      <p className="bound-ip-account">{job.email}</p>
      <BoundIpHistory key={job.id} job={job} request={request} optionsLoaded={Boolean(options)} />
      {unavailable && <p className="bound-ip-notice" role="status">{unavailable}</p>}
      {readError ? <div role="alert" className="bound-ip-notice">
        <span>{readError}</span>
        <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重新读取</button>
      </div> : !options && <p className="bound-ip-notice" role="status">正在读取 IP 和绑定数量…</p>}
      {options && <form id={formId} onSubmit={submit}>
        <fieldset className="bound-ip-options" disabled={busy || Boolean(unavailable)}>
          <legend className="sr-only">目标绑定</legend>
          {options.groups.map(group => <div className="bound-ip-option-group" key={group.ipAddress}>
            <div className="bound-ip-option-heading">
              <strong>{group.ipAddress}</strong><span>已绑定 {group.accountCount} 个账号</span>
            </div>
            {group.nodes.map(node => <label className="bound-ip-option" key={node.id}>
              <input type="radio" name={formId} value={node.id} disabled={isCurrent(Number(node.id)) || node.availableForBinding === false}
                checked={target === Number(node.id)} onChange={() => setTarget(Number(node.id))} />
              <span>{node.name} · {String(node.protocol).toUpperCase()}</span>
              {currentIds.has(Number(node.id)) && <small>当前绑定</small>}
            </label>)}
          </div>)}
          <div className="bound-ip-option-group">
            <div className="bound-ip-option-heading">
              <strong>直连</strong><span>{Number.isFinite(options.directCount) ? `${options.directCount} 个账号` : "账号数待获取"}</span>
            </div>
            <label className="bound-ip-option">
              <input type="radio" name={formId} value="0" disabled={isCurrent(0)} checked={target === 0} onChange={() => setTarget(0)} />
              <span>解除 IP 绑定并改为直连</span>
            </label>
          </div>
        </fieldset>
      </form>}
      {writeError && <p className="bound-ip-notice" role="alert">{writeError}</p>}
      {options && !unavailable && <p className="bound-ip-notice">确认后会登出该账号的会话，使用所选连接重新登录。</p>}
    </div>
    <div className="dialog-footer">
      <button type="button" className="cancel-button" onClick={close} disabled={busy}>取消</button>
      <button type="submit" form={formId} className="primary-button" disabled={!options || Boolean(unavailable) || busy || target === null || isCurrent(target)}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
        {busy ? "正在提交…" : target === 0 ? "解除绑定并重新登录" : "切换并重新登录"}
      </button>
    </div>
  </AccessibleDialog>;
}

function BoundIpHistory({ job, request, optionsLoaded }) {
  useDisplayTimeZone();
  const titleId = useId();
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    // Read saved history immediately, then refresh when the options request
    // finishes recording the latest pool bindings. History still works offline.
    void request(`/api/jobs/${encodeURIComponent(job.id)}/proxy-history`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setHistory(data.history);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error.message || "读取历史 IP 失败");
    });
    return () => controller.abort();
  }, [job.id, request, optionsLoaded, reload]);
  const currentIps = new Set((job.boundProxies || []).map(proxy => proxy.ipAddress).filter(Boolean));
  return <section className="bound-ip-history" aria-labelledby={titleId}>
    <div className="bound-ip-history-heading">
      <h3 id={titleId}>历史使用的 IP</h3>
      {history && <span>共 {history.length} 个</span>}
    </div>
    <p className="bound-ip-notice">按出口 IP 去重，保留已记录的绑定。</p>
    {error && <div role="alert" className="bound-ip-history-error">
      <span>{error}</span>
      <button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重试历史记录</button>
    </div>}
    {!history && !error && <p className="bound-ip-notice" role="status">正在读取历史 IP…</p>}
    {history?.length === 0 && <p className="bound-ip-notice">暂无历史 IP 记录</p>}
    {history?.length > 0 && <ul className="bound-ip-history-list" aria-label="历史 IP 列表">
      {history.map(item => <li key={item.ipAddress}>
        <div className="bound-ip-history-heading">
          <strong>{item.ipAddress}</strong>
          {currentIps.has(item.ipAddress) && <small>当前绑定</small>}
        </div>
        <span>{item.lastRequestAt ? `上次使用：${displayDateTime(item.lastRequestAt)}` : "暂无请求时间记录"}</span>
      </li>)}
    </ul>}
  </section>;
}
