import React, { useLayoutEffect, useRef } from "react";

export function trapModalTab(event) {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const dialog = event.currentTarget;
  const controls = [...dialog.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]',
  )].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement) || document.activeElement === dialog)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement) || document.activeElement === dialog)) {
    event.preventDefault(); first.focus();
  }
}

// Preserve the existing form DOM/classes while adding modal keyboard behavior.
export function ModalForm({ onClose, closeDisabled = false, onKeyDown, children, ...props }) {
  const ref = useRef(null);
  const returnFocusRef = useRef(document.activeElement);
  useModalFocus(ref, true, returnFocusRef);
  return <form {...props} ref={ref} onKeyDown={event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    if (!closeDisabled) onClose();
  }}>{children}</form>;
}

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
      onKeyDown={trapModalTab}
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
export function useModalFocus(ref, open, returnFocusRef) {
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current, previous = returnFocusRef?.current || document.activeElement, siblings = [];
    for (let branch = dialog; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
        siblings.push([sibling, sibling.inert]); sibling.inert = true;
      }
      if (branch.parentElement === document.body) break;
    }
    const currentFocus = dialog.contains(document.activeElement) ? document.activeElement : null;
    (currentFocus || dialog.querySelector('.dialog-header .icon-button:not(:disabled)') || dialog.querySelector('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'))?.focus();
    dialog.addEventListener("keydown", trapModalTab);
    return () => { dialog.removeEventListener("keydown", trapModalTab); for (const [el, inert] of siblings) el.inert = inert; if (previous?.isConnected) previous.focus(); };
  }, [ref, open, returnFocusRef]);
}
