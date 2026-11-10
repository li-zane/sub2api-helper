import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { AccessibleDialog } from './accessible-dialog.jsx';
import { poolErrorTooltip } from './pool-account-error.mjs';

export function Sub2ApiPoolBadge({ inPool, remoteStatus, errors = [] }) {
  const [open, setOpen] = useState(false);
  const hasError = inPool === true && remoteStatus === 'error';
  useEffect(() => { if (!hasError) setOpen(false); }, [hasError]);
  if (!hasError) return <span className={`pool-badge ${inPool === true ? 'added' : inPool === false ? 'not-added' : 'unknown'}`}>{inPool === true ? '已加入' : inPool === false ? '未加入' : '未同步'}</span>;
  const codes = [...new Set(errors.map(e => e.code).filter(Boolean))], tooltip = poolErrorTooltip(errors);
  return <>
    <button type="button" className="pool-badge error pool-error-detail-trigger" title={tooltip} aria-label={`查看号池错误详情${codes.length ? `：${codes.join('、')}` : ''}`} onClick={() => setOpen(true)}>
      <span>错误{codes.length ? ' ·' : ''}</span>{codes.length > 0 && <code>{codes.join('、')}</code>}
    </button>
    {open && <AccessibleDialog className="pool-error-dialog" labelledBy="pool-error-dialog-title" onClose={() => setOpen(false)}>
      <div className="dialog-header"><h2 id="pool-error-dialog-title">号池错误详情</h2><div className="dialog-header-actions"><button type="button" className="icon-button" aria-label="关闭号池错误详情" onClick={() => setOpen(false)}><X size={18} /></button></div></div>
      <pre className="pool-error-message">{tooltip}</pre>
      <div className="dialog-footer"><button type="button" className="cancel-button" onClick={() => setOpen(false)}>关闭</button></div>
    </AccessibleDialog>}
  </>;
}
