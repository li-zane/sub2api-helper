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

// Focus/inert behavior for an existing styled form modal without replacing its DOM.
export function useModalFocus(ref, open) {
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current, previous = document.activeElement, siblings = [];
    for (let branch = dialog; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
        siblings.push([sibling, sibling.inert]); sibling.inert = true;
      }
      if (branch.parentElement === document.body) break;
    }
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]')].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
    (dialog.querySelector('.dialog-header .icon-button:not(:disabled)') || focusable()[0])?.focus();
    const trap = event => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const controls = focusable(), first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener("keydown", trap);
    return () => { dialog.removeEventListener("keydown", trap); for (const [el, inert] of siblings) el.inert = inert; if (previous?.isConnected) previous.focus(); };
  }, [ref, open]);
}
