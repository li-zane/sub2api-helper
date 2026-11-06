import React, { useLayoutEffect, useRef, useState } from "react";

// Keep the caller's appearance and DOM ancestry; the top layer avoids clipping.
export function AnchoredPopover({ anchorRef, align = "left", onClose, children, ...props }) {
  const ref = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const popover = typeof menu.showPopover === "function";
    if (popover) menu.showPopover();
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor?.isConnected) return;
      const rect = anchor.getBoundingClientRect(), width = menu.offsetWidth, height = menu.offsetHeight;
      if (rect.bottom < 8 || rect.top > innerHeight - 8) { closeRef.current?.(); return; }
      const left = Math.max(8, Math.min(align === "right" ? rect.right - width : rect.left, innerWidth - width - 8));
      const below = rect.bottom + 6;
      const preferred = below + height <= innerHeight - 8 ? below : rect.top - height - 6;
      const top = Math.max(8, Math.min(preferred, innerHeight - height - 8));
      setPosition(old => old?.left === left && old?.top === top ? old : { left, top });
    };
    const scroll = event => { if (!menu.contains(event.target)) place(); };
    place(); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", place);
      if (popover && menu.matches(":popover-open")) menu.hidePopover();
    };
  }, [anchorRef, align]);
  return <div {...props} ref={ref} popover="manual" style={{ position: "fixed", left: position?.left ?? 0, top: position?.top ?? 0,
    right: "auto", bottom: "auto", margin: 0, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 16px)",
    overflowY: "auto", visibility: position ? undefined : "hidden" }}>{children}</div>;
}
