import React, { useState } from "react";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";

export function SessionResetDialog({ count, onClose, onConfirm }) {
  const [minutes, setMinutes] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const value = Number(minutes);
    if (!minutes.trim() || !Number.isInteger(value) || value < 0 || value > 43200) {
      setError("请输入 0–43200 分钟的整数"); return;
    }
    setBusy(true); setError("");
    try {
      if (await onConfirm(value)) onClose();
      else setError("提交失败，请稍后重试；账号状态变化时请刷新后重新选择。");
    }
    finally { setBusy(false); }
  }
  return <AccessibleDialog className="session-reset-dialog" labelledBy="session-reset-title" onClose={onClose} closeDisabled={busy}>
    <form onSubmit={submit}>
      <div className="dialog-header">
        <div><h2 id="session-reset-title">一键重登</h2><p>已选择 {count} 个账号</p></div>
        <button type="button" className="icon-button" aria-label="关闭一键重登" disabled={busy} onClick={onClose}><X size={18} /></button>
      </div>
      <label className="settings-field" htmlFor="session-reset-delay">
        <span>冷却时间（分钟）</span>
        <input id="session-reset-delay" data-dialog-initial-focus type="number" min="0" max="43200" step="1"
          value={minutes} disabled={busy} onChange={event => setMinutes(event.target.value)} required />
      </label>
      <p className="settings-note">登出所有设备后等待，再重登 Web、完成 Codex 授权并更新号池凭据。0 分钟立即继续，全程保留原 IP 绑定。</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-footer">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}开始重登
        </button>
      </div>
    </form>
  </AccessibleDialog>;
}
