import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";

function TaskToast({ message, revision, tone, busy = false, onDismiss, closeLabel }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const dismiss = useRef(onDismiss), remaining = useRef(6000);
  const latest = useRef(null);
  dismiss.current = onDismiss;
  latest.current = { message, revision, busy, hovered, focused };
  useEffect(() => { remaining.current = tone === "error" ? 8000 : 6000; }, [message, revision, busy, tone]);
  useEffect(() => {
    if (busy || hovered || focused) return undefined;
    const started = Date.now(), timer = window.setTimeout(() => {
      const current = latest.current;
      if (current.message === message && current.revision === revision && !current.busy && !current.hovered && !current.focused) dismiss.current();
    }, remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [message, revision, busy, hovered, focused, tone]);
  return <div className={`task-toast ${tone}`} role={tone === "error" ? "alert" : "status"} aria-atomic="true" aria-busy={busy}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : tone === "error" ? <CircleAlert size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
    <span className="task-toast-message">{message}</span>
    <button type="button" className="toast-dismiss" onClick={onDismiss} aria-label={closeLabel}><X size={16} aria-hidden="true" /></button>
  </div>;
}

export function TaskToasts({ notice, revision, busy, error, sessionError, onDismissNotice, onDismissError, onDismissSessionError }) {
  const region = useRef(null);
  const [shownError, setShownError] = useState(error || ""), [shownSessionError, setShownSessionError] = useState(sessionError || "");
  // Successful background polling may clear the app's request error state.
  // It must not erase an operation toast before the user can read it.
  useEffect(() => { if (error) setShownError(error); }, [error]);
  useEffect(() => { if (sessionError) setShownSessionError(sessionError); }, [sessionError]);
  const popover = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
  useLayoutEffect(() => {
    const element = region.current;
    if (!element || !popover) return;
    // A non-modal top-layer popover remains visible above native dialogs, but
    // never captures focus or intercepts clicks outside the toast cards.
    if (element.matches(":popover-open")) element.hidePopover();
    element.showPopover();
  }, [notice, revision, shownError, shownSessionError, popover]);
  if (!notice && !shownError && !shownSessionError) return null;
  return createPortal(<div ref={region} className="task-toast-region" popover={popover ? "manual" : undefined} aria-label="任务通知">
    {notice && <TaskToast key="task-notice" message={notice} revision={revision} tone="success" busy={busy} onDismiss={onDismissNotice} closeLabel="关闭任务通知" />}
    {shownError && <TaskToast key="task-error" message={shownError} tone="error" onDismiss={() => { setShownError(""); onDismissError(); }} closeLabel="关闭错误通知" />}
    {shownSessionError && <TaskToast key="session-error" message={shownSessionError} tone="error" onDismiss={() => { setShownSessionError(""); onDismissSessionError(); }} closeLabel="关闭设备通知" />}
  </div>, document.body);
}
