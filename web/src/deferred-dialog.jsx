import React, { useEffect, useId, useState } from "react";
import { AccessibleDialog } from "./accessible-dialog.jsx";

// Each dialog shares its import between concurrent opens. Only the mounted
// opener may reveal it, even if the download finishes after cancellation.
export function deferredDialog(label, importComponent) {
  let Component, pending;
  function load() {
    pending ??= importComponent().then(loaded => {
      Component = loaded;
    }).catch(error => {
      pending = undefined;
      throw error;
    });
    return pending;
  }
  function DeferredDialog(props) {
    const [phase, setPhase] = useState(() => Component ? "ready" : "loading");
    const titleId = useId();
    useEffect(() => {
      if (phase !== "loading") return;
      let mounted = true;
      load().then(
        () => { if (mounted) setPhase("ready"); },
        () => { if (mounted) setPhase("error"); },
      );
      return () => { mounted = false; };
    }, [phase]);

    if (phase === "ready") return <Component {...props} />;
    const failed = phase === "error";
    return <AccessibleDialog labelledBy={titleId} onClose={props.onClose} returnFocusRef={props.returnFocusRef}>
      <div className="dialog-header">
        <h2 id={titleId}>{failed ? `${label}加载失败` : `正在加载${label}`}</h2>
      </div>
      <div className="dialog-footer">
        <button type="button" className="secondary-button" onClick={props.onClose}>取消</button>
        {failed && <button type="button" className="primary-button" onClick={() => setPhase("loading")}>重试</button>}
      </div>
    </AccessibleDialog>;
  }
  // Start the import alongside a pre-open data request when one is needed.
  DeferredDialog.preload = () => { void load().catch(() => {}); };
  return DeferredDialog;
}
