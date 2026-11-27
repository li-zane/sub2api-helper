import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FileText, Pencil, X } from "lucide-react";
import { AnchoredPopover } from "./anchored-popover.jsx";

export function AccountRemark({ job, onEdit }) {
  const anchor = useRef(null), panel = useRef(null), timer = useRef(null);
  const pinned = useRef(false), suppressHover = useRef(false);
  const keyboardPreview = useRef(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const hasRemark = Boolean(job.remark), shown = hasRemark && open;

  function clearTimer() { clearTimeout(timer.current); }
  function dismiss(restoreFocus = false) {
    clearTimer(); pinned.current = false; keyboardPreview.current = false; suppressHover.current = true; setOpen(false);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  }
  function show() {
    clearTimer();
    if (!suppressHover.current) setOpen(true);
  }
  function leave() {
    clearTimer();
    timer.current = setTimeout(() => {
      if (!pinned.current && !panel.current?.contains(document.activeElement)
          && !keyboardPreview.current) setOpen(false);
    }, 180);
  }
  function edit() {
    dismiss(true);
    onEdit();
  }
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!hasRemark) { pinned.current = false; setOpen(false); }
  }, [hasRemark]);
  useEffect(() => {
    if (!shown) return;
    const outside = event => {
      if (!anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) dismiss();
    };
    const escape = event => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      dismiss(pinned.current || panel.current?.contains(document.activeElement));
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [shown]);

  return <>
    <button ref={anchor} type="button" className={`account-remark-button ${hasRemark ? "has-remark" : ""}`}
      data-tooltip-owned="true" aria-label={`${hasRemark ? "查看" : "添加"} ${job.email} 的备注`}
      aria-haspopup={hasRemark ? "dialog" : undefined} aria-expanded={hasRemark ? shown : undefined}
      aria-controls={shown ? id : undefined}
      onMouseEnter={hasRemark ? () => { keyboardPreview.current = false; show(); } : undefined} onMouseLeave={leave}
      onPointerMove={event => {
        if (suppressHover.current && hasRemark && event.pointerType === "mouse") {
          suppressHover.current = false; setOpen(true);
        }
      }}
      onFocus={event => {
        if (hasRemark && !suppressHover.current && event.currentTarget.matches(":focus-visible")) {
          keyboardPreview.current = true; show();
        }
      }}
      onClick={() => {
        if (!hasRemark) { edit(); return; }
        if (pinned.current) { dismiss(); return; }
        clearTimer(); suppressHover.current = false; pinned.current = true; setOpen(true);
        requestAnimationFrame(() => panel.current?.querySelector(".account-remark-full")?.focus({ preventScroll: true }));
      }}>
      <FileText size={13} aria-hidden="true" />
      {hasRemark && <><span className="account-remark-text">{job.remark}</span><ChevronDown size={11} aria-hidden="true" /></>}
    </button>
    {shown && createPortal(<AnchoredPopover anchorRef={anchor} className="account-remark-popover"
      id={id} role="dialog" aria-label={`${job.email} 的完整备注`} onClose={() => dismiss()}
      onMouseEnter={show} onMouseLeave={leave}>
      <div ref={panel}>
        <div className="account-remark-preview-header">
          <strong>完整备注</strong>
          <button type="button" className="icon-button" aria-label="关闭完整备注" onClick={() => dismiss(true)}><X size={15} /></button>
        </div>
        <div className="account-remark-full" tabIndex={0} aria-label="备注全文">{job.remark}</div>
        <button type="button" className="account-remark-edit" onClick={edit}><Pencil size={13} aria-hidden="true" />编辑备注</button>
      </div>
    </AnchoredPopover>, document.body)}
  </>;
}
