import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Clock3, Infinity as InfinityIcon, Plus, RefreshCw, Store, TrainFront, Trash2, X } from "lucide-react";
import { DEFAULT_TAG_OPTIONS, TAG_OPTION_KEYS } from "../../shared/account-tags.mjs";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { AnchoredPopover } from "./anchored-popover.jsx";
import "./account-tags.css";

const labels = { merchant: "商家", trip: "车次", validity: "时效" };
const icons = { merchant: Store, trip: TrainFront, validity: Clock3 };
const fieldsByPlacement = { account: ["merchant", "trip"], plan: ["validity"] };

export function AccountTags({ placement, job, options, onSave, onLoadOptions, onRemoveOption }) {
  const [field, setField] = useState("");
  const anchor = useRef(null);
  const tags = job.accountTags || {};
  function close(restore = true) {
    setField("");
    if (restore) anchor.current?.focus({ preventScroll: true });
  }
  return <div className={`account-tags account-tags--${placement}`}>
    {fieldsByPlacement[placement].map(key => {
      const label = labels[key];
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
    {field && <TagEditor key={field} {...{ field, tags, options, anchor, close, onLoadOptions, onRemoveOption }} onSave={patch => onSave(job, patch)} />}
  </div>;
}

function TagEditor({ field, tags, options, anchor, close, onLoadOptions, onRemoveOption, onSave }) {
  const id = useId();
  const panel = useRef(null);
  const [query, setQuery] = useState("");
  const [rotation, setRotation] = useState(false);
  const [time, setTime] = useState(tags.stopAt || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState("");
  const validity = field === "validity";
  const current = tags[field];
  const choices = validity ? DEFAULT_TAG_OPTIONS.validities : options?.[TAG_OPTION_KEYS[field]] ?? [];
  const text = query.trim();
  const visible = choices.filter(value => value.toLowerCase().includes(text.toLowerCase()));
  const create = text && !choices.includes(text);

  useEffect(() => {
    let mounted = true;
    onLoadOptions().catch(err => { if (mounted) setError(err.message); });
    return () => { mounted = false; };
  }, [onLoadOptions]);

  useLayoutEffect(() => {
    if (rotation) return;
    const frame = requestAnimationFrame(() => {
      const target = panel.current?.querySelector("input:not(:disabled), button:not(:disabled)") || panel.current;
      target?.focus({ preventScroll: true });
    });
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

  useLayoutEffect(() => {
    if (removeCandidate && !saving) panel.current?.querySelector(".tag-cancel-remove")?.focus();
  }, [removeCandidate, saving]);

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
  async function removeOption() {
    if (saving || !removeCandidate) return;
    setSaving(true);
    setError("");
    try {
      await onRemoveOption(field, removeCandidate);
      setRemoveCandidate("");
    }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  function navigate(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (saving) return;
      if (removeCandidate) cancelRemoval();
      else close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const items = [...panel.current.querySelectorAll("button:not(:disabled):not(.tag-remove)")];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      event.preventDefault();
      items[(index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
        : (index + items.length + (event.key === "ArrowDown" ? 1 : -1)) % items.length)].focus();
    } else if (event.key === "Enter" && event.target.tagName === "INPUT" && text) {
      event.preventDefault(); choose(text);
    }
  }
  function cancelRemoval() {
    setRemoveCandidate("");
    setError("");
    panel.current?.querySelector("input, .tag-option-row button")?.focus({ preventScroll: true });
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
    <div ref={panel} tabIndex={-1}>
      <div className="tag-picker-label">{labels[field]}</div>
      {!validity && <input type="text" aria-label={"搜索或新建" + labels[field]} placeholder={"搜索或输入新" + labels[field]} value={query}
        onChange={event => setQuery(event.target.value)} maxLength={64} disabled={saving} />}
      <div className="tag-options">
        {options && !choices.length && !create && <div role="status">暂无参考值</div>}
        {create && <button type="button" className="tag-create" onClick={() => choose(text)} disabled={saving}><Plus size={13} />新建「{text}」</button>}
        {visible.map(value => <div className="tag-option-row" key={value}>
          <button type="button" onClick={() => choose(value)} disabled={saving} aria-pressed={value === current}>
            <span>{value}</span>{value === current && <Check size={14} />}</button>
          {!validity && <button type="button" className="tag-remove" disabled={saving} aria-label={"从列表删除" + labels[field] + "「" + value + "」"}
            title="从下拉列表删除" onClick={() => { setError(""); setRemoveCandidate(value); }}><Trash2 size={14} aria-hidden="true" /></button>}
        </div>)}
      </div>
      {removeCandidate && <div className="tag-remove-confirm" role="group" aria-label="确认删除下拉选项">
        <p>从所有账号的下拉列表移除「{removeCandidate}」？</p>
        <div>
          <button type="button" className="cancel-button tag-cancel-remove" disabled={saving} onClick={cancelRemoval}>取消</button>
          <button type="button" className="tag-confirm-remove" disabled={saving} onClick={removeOption}>删除选项</button>
        </div>
      </div>}
      {current && <button type="button" className="tag-clear" onClick={() => choose("")} disabled={saving}>清空{labels[field]}</button>}
      {message}
    </div>
  </AnchoredPopover>, document.body);
}
