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
  const [coords, setCoords] = useState({ top: 0, left: 0, placement: "bottom" });

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

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    function updatePosition() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
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
      setCoords({ top, left, placement });
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
        onBlur={() => { setFocused(false); setPinned(false); }}
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
          className={`help-tip-popover ${coords.placement} ${pinned ? "pinned" : ""}`}
          style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
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
