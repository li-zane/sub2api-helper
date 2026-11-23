import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Clock3, Infinity as InfinityIcon, Plus, RefreshCw, Store, TrainFront, X } from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { AnchoredPopover } from "./anchored-popover.jsx";
import "./account-tags.css";

const labels = { merchant: "商家", trip: "车次", validity: "时效" };
const icons = { merchant: Store, trip: TrainFront, validity: Clock3 };

export function AccountTags({ job, options, onSave, onLoadOptions }) {
  const [field, setField] = useState("");
  const anchor = useRef(null);
  const tags = job.accountTags || {};
  function close(restore = true) {
    setField("");
    if (restore) anchor.current?.focus({ preventScroll: true });
  }
  return <div className="account-tags">
    {Object.entries(labels).map(([key, label]) => {
      const value = tags[key];
      const Icon = key === "validity" && value ? (value === "轮转" ? RefreshCw : InfinityIcon) : icons[key];
      const detail = value === "轮转" && tags.stopAt ? "轮转至 " + tags.stopAt.replace("T", " ") + "（北京时间）" : value;
      const deadline = key === "validity" && value === "轮转" && tags.stopAt;
      return <button key={key} type="button" className="account-tag-chip" data-tone={value ? (key === "validity" ? value : "filled") : "empty"}
        aria-label={label + "：" + (detail || "未设置") + "，点击编辑"} title={label + " · " + (detail || "未设置")}
        aria-haspopup="dialog" aria-expanded={field === key} onClick={event => {
          anchor.current = event.currentTarget;
          setField(current => current === key ? "" : key);
        }}><Icon size={11} aria-hidden="true" /><span>{value || label}</span>
        {deadline && <time dateTime={deadline + "+08:00"}>{deadline.slice(5).replace("-", "/").replace("T", " ")}</time>}
      </button>;
    })}
    {field && <TagEditor key={field} {...{ field, tags, options, anchor, close, onLoadOptions }} onSave={patch => onSave(job, patch)} />}
  </div>;
}

function TagEditor({ field, tags, options, anchor, close, onLoadOptions, onSave }) {
  const id = useId();
  const panel = useRef(null);
  const [query, setQuery] = useState("");
  const [rotation, setRotation] = useState(false);
  const [time, setTime] = useState(tags.stopAt || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const validity = field === "validity";
  const current = tags[field];
  const choices = validity ? ["长效", "轮转"] : options[field === "merchant" ? "merchants" : "trips"];
  const text = query.trim();
  const visible = choices.filter(value => value.toLowerCase().includes(text.toLowerCase()));
  const create = text && !choices.includes(text);

  useEffect(() => {
    let mounted = true;
    if (!validity) onLoadOptions().catch(err => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, [validity, onLoadOptions]);

  useLayoutEffect(() => {
    if (rotation) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector("input, button")?.focus({ preventScroll: true }));
    const outside = event => {
      if (!saving && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [rotation, saving, anchor]); // The owning row keeps its trigger ref for focus restoration.

  async function save(patch) {
    if (saving) return;
    setSaving(true);
    setError("");
    try { await onSave(patch); close(); }
    catch (err) { setError(err.message); setSaving(false); }
  }
  function choose(value) {
    if (validity && value === "轮转") { setError(""); setRotation(true); }
    else save({ [field]: value });
  }
  function navigate(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!saving) close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = [...panel.current.querySelectorAll("button:not(:disabled)")];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      event.preventDefault();
      items[(index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
        : (index + items.length + (event.key === "ArrowDown" ? 1 : -1)) % items.length)].focus();
    } else if (event.key === "Enter" && event.target.tagName === "INPUT" && text) {
      event.preventDefault(); choose(text);
    }
  }
  const message = error && <div className="tag-error" role="alert">{error}</div>;
  if (rotation) return createPortal(
    <AccessibleDialog className="rotation-time-dialog" labelledBy={id} onClose={() => close()} closeDisabled={saving} returnFocusRef={anchor}>
      <div className="dialog-header"><div><RefreshCw size={17} /><h2 id={id}>轮转停止时间</h2></div>
        <button type="button" className="icon-button" disabled={saving} onClick={() => close()} aria-label="关闭轮转时间"><X size={16} /></button></div>
      <form onSubmit={event => { event.preventDefault(); save({ validity: "轮转", stopAt: time }); }}>
        <label className="batch-label" htmlFor={id + "-time"}>停止时间（北京时间）</label>
        <input id={id + "-time"} type="datetime-local" step="60" required data-dialog-initial-focus
          value={time} onChange={event => setTime(event.target.value)} disabled={saving} />
        {message}
        <div className="dialog-footer"><button type="button" className="cancel-button" disabled={saving} onClick={() => close()}>取消</button>
          <button type="button" className="cancel-button" disabled={saving} onClick={() => save({ validity: "轮转", stopAt: "" })}>不指定时间</button>
          <button type="submit" className="primary-button" disabled={saving || !time}>确认修改</button></div>
      </form>
    </AccessibleDialog>, document.body);
  return createPortal(<AnchoredPopover anchorRef={anchor} className="account-tag-popover" onClose={() => { if (!saving) close(false); }}
    role="dialog" aria-label={"选择" + labels[field]} onKeyDown={navigate}>
    <div ref={panel}>
      <div className="tag-picker-label">{labels[field]}</div>
      {!validity && <input type="text" aria-label={"搜索或新建" + labels[field]} placeholder={"搜索或输入新" + labels[field]} value={query}
        onChange={event => setQuery(event.target.value)} maxLength={64} disabled={saving} />}
      <div className="tag-options">
        {create && <button type="button" className="tag-create" onClick={() => choose(text)} disabled={saving}><Plus size={13} />新建「{text}」</button>}
        {visible.map(value => <button type="button" key={value} onClick={() => choose(value)} disabled={saving} aria-pressed={value === current}>
          <span>{value}</span>{value === current && <Check size={14} />}</button>)}
      </div>
      {current && <button type="button" className="tag-clear" onClick={() => choose("")} disabled={saving}>清空{labels[field]}</button>}
      {message}
    </div>
  </AnchoredPopover>, document.body);
}
