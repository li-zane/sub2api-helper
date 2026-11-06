import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";

export function HelpTip({ title, children, content, label = "查看说明", className = "" }) {
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const closeTimerRef = useRef(null);
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState(null);

  const open = !dismissed && (hovered || focused || pinned);
  const body = children ?? content;

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function handleMouseEnter() {
    clearCloseTimer();
    setDismissed(false);
    setHovered(true);
  }

  function handleMouseLeave() {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setHovered(false);
    }, 150);
  }

  function handleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    clearCloseTimer();
    setDismissed(false);
    setPinned((current) => {
      const next = !current;
      if (!next) { setHovered(false); setDismissed(true); }
      return next;
    });
  }

  function handleBlur(event) {
    if (triggerRef.current?.contains(event.relatedTarget) || popoverRef.current?.contains(event.relatedTarget)) return;
    setFocused(false); setPinned(false);
  }

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    function updatePosition() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const maxHeight = Math.max(0, window.innerHeight - 24);
      if (popoverRef.current) popoverRef.current.style.maxHeight = `${maxHeight}px`;
      const popWidth = popoverRef.current?.offsetWidth || 280;
      const popHeight = popoverRef.current?.offsetHeight || 96;
      const gap = 8;
      const margin = 12;
      let left = rect.left + rect.width / 2 - popWidth / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - popWidth - margin));
      let placement = "bottom";
      let top = rect.bottom + gap;
      if (top + popHeight > window.innerHeight - margin && rect.top - gap - popHeight >= margin) {
        placement = "top";
        top = rect.top - gap - popHeight;
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - popHeight - margin));
      const scrollable = popoverRef.current?.scrollHeight > popoverRef.current?.clientHeight;
      setCoords(previous => previous?.top === top && previous?.left === left && previous?.maxHeight === maxHeight && previous?.placement === placement && previous?.scrollable === scrollable
        ? previous : { top, left, placement, maxHeight, scrollable });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, body, title]);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event) {
      if (
        triggerRef.current?.contains(event.target)
        || popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      setPinned(false);
      setHovered(false);
      setDismissed(true);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPinned(false);
        setHovered(false);
        setDismissed(true);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  if (!body) return null;

  const portalRoot = triggerRef.current?.closest("dialog") || document.body;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`help-tip-trigger ${open ? "active" : ""} ${pinned ? "pinned" : ""} ${className}`.trim()}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => { setFocused(true); setDismissed(false); }}
        onBlur={handleBlur}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          id={tooltipId}
          role="tooltip"
          className={`help-tip-popover ${coords?.placement || "bottom"} ${pinned ? "pinned" : ""}`}
          tabIndex={coords?.scrollable ? 0 : undefined}
          style={{ top: `${coords?.top ?? 0}px`, left: `${coords?.left ?? 0}px`, maxHeight: coords ? `${coords.maxHeight}px` : undefined, overflowY: "auto", visibility: coords ? undefined : "hidden" }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onClick={(event) => event.stopPropagation()}
        >
          {title && <div className="help-tip-title">{title}</div>}
          <div className="help-tip-content">{body}</div>
        </div>,
        portalRoot,
      )}
    </>
  );
}
