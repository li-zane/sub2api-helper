import React, { useState, useEffect, useRef, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";

function TooltipLayer({ target, text, placement = "top", className = "", id }) {
  const ref = useRef(null);
  const [coords, setCoords] = useState(null);
  useLayoutEffect(() => {
    if (!target?.isConnected || !ref.current) return;
    const rect = target.getBoundingClientRect(), tip = ref.current.getBoundingClientRect(), gap = 6, margin = 8;
    let side = placement === "bottom" ? "bottom" : "top";
    if (side === "top" && rect.top - tip.height - gap < margin) side = "bottom";
    else if (side === "bottom" && rect.bottom + tip.height + gap > innerHeight - margin && rect.top - tip.height - gap >= margin) side = "top";
    const left = Math.max(margin + tip.width / 2, Math.min(rect.left + rect.width / 2, innerWidth - margin - tip.width / 2));
    const top = side === "top" ? Math.max(margin + tip.height, rect.top - gap) : Math.min(rect.bottom + gap, innerHeight - margin - tip.height);
    setCoords(previous => previous?.top === top && previous?.left === left && previous?.side === side ? previous : { top, left, side });
  }, [target, text, placement]);
  if (!target?.isConnected || !text) return null;
  // A body portal is below a modal dialog regardless of z-index.
  const host = target.closest("dialog[open]") || document.body;
  const side = coords?.side || placement;
  return createPortal(<div ref={ref} id={id} role="tooltip" className={`apple-floating-tooltip ${side} ${className}`.trim()}
    style={{ position: "fixed", top: `${coords?.top || 0}px`, left: `${coords?.left || 0}px`, visibility: coords ? undefined : "hidden",
      transform: side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)" }}>{text}</div>, host);
}

export function Tooltip({ content, title, children, placement = "top", className = "" }) {
  const text = content ?? title;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const escape = event => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("scroll", dismiss, true); window.addEventListener("resize", dismiss); document.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  if (!text) return children;
  return <><span ref={triggerRef} className="tooltip-trigger-wrapper" data-tooltip-owned="true" aria-describedby={open ? id : undefined}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>{children}</span>
    {open && <TooltipLayer target={triggerRef.current} text={text} placement={placement} className={className} id={id} />}</>;
}

// One delegated listener set for the whole application; work is allocated only while a tip is open.
export function GlobalTooltipProvider() {
  const [tip, setTip] = useState(null);
  const active = useRef(null);
  const id = useId();
  useEffect(() => {
    let observer, keyboard = false;
    const dismiss = () => {
      const current = active.current;
      active.current = null; observer?.disconnect(); observer = null;
      if (current) {
        const { el, title, describedBy } = current;
        // Never overwrite a newer title written by a React render.
        if (title !== null && !el.hasAttribute("title")) el.setAttribute("title", title);
        delete el.dataset.agyTitle;
        if (el.getAttribute("aria-describedby")?.split(/\s+/).includes(id)) {
          if (describedBy) el.setAttribute("aria-describedby", describedBy); else el.removeAttribute("aria-describedby");
        }
      }
      setTip(null);
    };
    const find = target => target instanceof Element ? target.closest("[data-tooltip], [title], [data-agy-title]") : null;
    const show = event => {
      const el = find(event.target);
      if (!el || el.closest(".help-tip-trigger, .help-tip-popover, [data-tooltip-owned]")) return;
      if (active.current?.el === el) return;
      dismiss();
      const title = el.getAttribute("title"), text = el.getAttribute("data-tooltip") || title;
      if (!text?.trim()) return;
      const describedBy = el.getAttribute("aria-describedby");
      active.current = { el, title, describedBy };
      const publish = () => {
        const nextTitle = el.getAttribute("title");
        if (nextTitle !== null) { active.current.title = nextTitle; el.dataset.agyTitle = nextTitle; el.removeAttribute("title"); }
        const nextText = el.getAttribute("data-tooltip") || active.current.title;
        if (!nextText?.trim()) { dismiss(); return; }
        setTip(previous => previous?.el === el && previous?.text === nextText ? previous : { el, text: nextText });
      };
      el.setAttribute("aria-describedby", [describedBy, id].filter(Boolean).join(" "));
      publish();
      observer = new MutationObserver(() => {
        if (!el.isConnected || el.closest("dialog:not([open])")) { dismiss(); return; }
        publish();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "data-tooltip", "open"] });
    };
    const leave = event => {
      if (!active.current) return;
      if (event.relatedTarget instanceof Node && active.current.el.contains(event.relatedTarget)) return;
      dismiss();
    };
    const pointerdown = () => { keyboard = false; dismiss(); };
    const focus = event => { if (keyboard && !event.target.hasAttribute?.("data-dialog-initial-focus")) show(event); };
    const keydown = event => { if (event.key === "Escape") { keyboard = false; dismiss(); } else keyboard = true; };
    document.addEventListener("pointerover", show, true); document.addEventListener("pointerout", leave, true);
    document.addEventListener("focusin", focus, true); document.addEventListener("focusout", leave, true);
    document.addEventListener("pointerdown", pointerdown, true); document.addEventListener("keydown", keydown, true);
    window.addEventListener("scroll", dismiss, true); window.addEventListener("resize", dismiss);
    return () => {
      dismiss();
      document.removeEventListener("pointerover", show, true); document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("focusin", focus, true); document.removeEventListener("focusout", leave, true);
      document.removeEventListener("pointerdown", pointerdown, true); document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss);
    };
  }, [id]);
  return tip ? <TooltipLayer target={tip.el} text={tip.text} id={id} /> : null;
}
export default Tooltip;
