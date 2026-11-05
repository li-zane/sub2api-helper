import React, { useLayoutEffect, useRef } from "react";

// Native modal dialogs provide focus containment and make the background inert.
export function AccessibleDialog({ children, className = "", labelledBy, onClose, closeDisabled = false }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    // React autoFocus runs before showModal(); native dialog focusing would
    // otherwise select the first help trigger and open its focus tooltip.
    const initialFocus = dialog.querySelector('[data-dialog-initial-focus]:not(:disabled), .dialog-header .icon-button:not(:disabled)');
    initialFocus?.setAttribute("autofocus", "");
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`batch-dialog ${className}`.trim()}
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const controls = [...event.currentTarget.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]',
        )].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || closeDisabled) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
