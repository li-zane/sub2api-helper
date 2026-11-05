import React from "react";
import { OverloadDetection } from "./overload-detection.jsx";
import { ModelFingerprintCell } from "./model-fingerprint.jsx";

export function CodexStatus({ job, token, onError }) {
  return <div className="codex-status" aria-label={`${job.email} Codex 状态`}>
    <OverloadDetection job={job} token={token} onError={onError} />
    <ModelFingerprintCell job={job} token={token} onError={onError} />
  </div>;
}
