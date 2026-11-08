import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { TOAST_EVENT } from "./toast-events.mjs";
import { AccountText } from "./copyable-account.jsx";

function TaskToast({ message, expiresAt, tone, busy = false, onDismiss, closeLabel }) {
  const [closing, setClosing] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    setClosing(false);
    const timer = window.setTimeout(() => setClosing(true), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => dismiss.current(), 180);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return <div className={`task-toast ${tone}${closing ? " is-leaving" : ""}`} role={tone === "error" ? "alert" : "status"} aria-atomic="true" aria-busy={busy}
    tabIndex={0} onClick={() => setClosing(true)} onKeyDown={event => {
      if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); setClosing(true); }
    }}>
    {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : tone === "error" ? <CircleAlert size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
    <span className="task-toast-message"><AccountText text={message} /></span>
    <button type="button" className="toast-dismiss" onClick={() => setClosing(true)} aria-label={closeLabel}><X size={16} aria-hidden="true" /></button>
  </div>;
}

export function TaskToasts({ notice, revision, busy, error, sessionError, onDismissNotice, onDismissError, onDismissSessionError }) {
  const region = useRef(null);
  const noticeDeadline = useRef({ revision, expiresAt: Date.now() + 3000 });
  if (noticeDeadline.current.revision !== revision) noticeDeadline.current = { revision, expiresAt: Date.now() + 3000 };
  const [portalHost, setPortalHost] = useState(document.body);
  useLayoutEffect(() => {
    const sync = () => {
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')];
      setPortalHost(dialogs.at(-1) || document.body);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);
  const [shownError, setShownError] = useState({ text: error || "", revision: 0, expiresAt: Date.now() + 3000 }), [shownSessionError, setShownSessionError] = useState({ text: sessionError || "", revision: 0, expiresAt: Date.now() + 3000 });
  const [messages, setMessages] = useState([]);
  useEffect(() => {
    const receive = event => setMessages(current => [...current, event.detail].slice(-4));
    window.addEventListener(TOAST_EVENT, receive);
    return () => window.removeEventListener(TOAST_EVENT, receive);
  }, []);
  // Successful background polling may clear the app's request error state.
  // It must not erase an operation toast before the user can read it.
  useEffect(() => { if (error) setShownError(current => ({ text: error, revision: current.revision + 1, expiresAt: Date.now() + 3000 })); }, [error]);
  useEffect(() => { if (sessionError) setShownSessionError(current => ({ text: sessionError, revision: current.revision + 1, expiresAt: Date.now() + 3000 })); }, [sessionError]);
  const popover = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
  useLayoutEffect(() => {
    const element = region.current;
    if (!element?.isConnected || !popover) return;
    // Keep the popover inside the active modal so native modal inertness does
    // not block its controls. The top layer keeps it outside modal clipping.
    if (element.matches(":popover-open")) element.hidePopover();
    element.showPopover();
  }, [notice, revision, shownError, shownSessionError, messages, popover, portalHost]);
  if (!notice && !shownError.text && !shownSessionError.text && !messages.length) return null;
  return createPortal(<div ref={region} className="task-toast-region" popover={popover ? "manual" : undefined} aria-label="任务通知">
    {notice && <TaskToast key={`task-notice-${revision}`} message={notice} expiresAt={noticeDeadline.current.expiresAt} tone="success" busy={busy} onDismiss={onDismissNotice} closeLabel="关闭任务通知" />}
    {shownError.text && <TaskToast key={`task-error-${shownError.revision}`} message={shownError.text} expiresAt={shownError.expiresAt} tone="error" onDismiss={() => { setShownError(current => ({ ...current, text: "" })); onDismissError(); }} closeLabel="关闭错误通知" />}
    {shownSessionError.text && <TaskToast key={`session-error-${shownSessionError.revision}`} message={shownSessionError.text} expiresAt={shownSessionError.expiresAt} tone="error" onDismiss={() => { setShownSessionError(current => ({ ...current, text: "" })); onDismissSessionError(); }} closeLabel="关闭设备通知" />}
    {messages.map(item => <TaskToast key={item.id} message={item.message} expiresAt={item.expiresAt} tone={item.tone}
      onDismiss={() => setMessages(current => current.filter(entry => entry.id !== item.id))} closeLabel="关闭操作通知" />)}
  </div>, portalHost);
}
