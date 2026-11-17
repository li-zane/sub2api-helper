import React, { useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { apiFetch } from "./console-request.mjs";
import { ModalForm } from "./accessible-dialog.jsx";
import { HelpTip } from "./help-tip.jsx";
import { CopyableAccount } from "./copyable-account.jsx";

export function RemarkDialog({ token, job, onClose, onSaved }) {
  const [remark, setRemark] = useState(job.remark || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/remark`, { method: "POST", body: JSON.stringify({ remark }) });
      onSaved(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <ModalForm className="batch-dialog remark-dialog" role="dialog" aria-modal="true" aria-labelledby="remark-title" onSubmit={save} onClose={onClose} closeDisabled={saving}>
        <div className="dialog-header">
          <div>
            <div className="section-title-row">
              <h2 id="remark-title">账号备注</h2>
              <HelpTip label="账号备注同步说明">
                与号池备注双向同步：保存会更新同邮箱账号的完整备注，清空也会同步。号池修改会在下一次同步时回显，编辑中的内容会保留。
              </HelpTip>
            </div>
            <span><CopyableAccount email={job.email} /></span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭备注"><X size={18} /></button>
        </div>
        <label className="batch-label" htmlFor="account-remark">备注内容</label>
        <textarea id="account-remark" className="remark-input" value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={2000} disabled={saving} autoFocus placeholder="例如：首批账号、到期时间、用途" />
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-footer">
          <button type="button" className="cancel-button" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存备注</button>
        </div>
      </ModalForm>
    </div>
  );
}
