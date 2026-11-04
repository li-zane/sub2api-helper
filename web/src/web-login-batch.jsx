import React, { useEffect, useState } from "react";

const LABELS = { queued: "排队", running: "重登中", checking: "检测中", input: "待输入验证码或密码", success: "成功", failed: "失败" };

export function WebLoginBatch({ token, batch, onRetry, onClose, busy }) {
  const [progress, setProgress] = useState(null), [error, setError] = useState("");
  useEffect(() => {
    let stopped = false, timer;
    setProgress(null);
    const load = async () => {
      try {
        const response = await fetch("/api/jobs/web-session-check-progress", { method: "POST", headers: { "content-type": "application/json", "x-console-token": token }, body: JSON.stringify({ attempts: batch.attempts }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "读取会话检测进度失败");
        if (!stopped) { setProgress(data.progress); setError(""); }
        if (!stopped && data.progress.some(p => !["success", "failed"].includes(p.phase))) timer = setTimeout(load, 1200);
      } catch (e) { if (!stopped) { setError(e.message); timer = setTimeout(load, 3000); } }
    };
    if (token) void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [batch, token]);
  const records = [...(progress || []), ...batch.failed.map(p => ({ ...p, phase: "failed" }))];
  const count = phase => records.filter(p => p.phase === phase).length;
  const failedIds = records.filter(p => p.phase === "failed").map(p => p.id);
  const pending = !progress || records.some(p => !["success", "failed"].includes(p.phase));
  return <section className="web-login-batch" aria-label="Web 会话检测批次">
    <div className="web-login-batch-heading">
      <strong role="status">Web 会话检测{pending ? "进度" : "完成"}：成功 {count("success")} · 失败 {count("failed")} · 待输入 {count("input")} · 排队 {count("queued")} · 检测中 {count("checking")} · 重登中 {count("running")} · 跳过 {batch.skipped.length}</strong>
      <button type="button" className="secondary-button" disabled={busy || pending || !failedIds.length} onClick={() => onRetry([...new Set(failedIds)])}>仅重试失败项</button>
      <button type="button" className="secondary-button" onClick={onClose}>关闭进度</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <details><summary>查看账号明细</summary><ul>{records.map(p => <li key={p.id}>{p.email || p.id}：{p.phase === "success" ? p.renewed ? "已重登并复检" : "会话有效" : LABELS[p.phase]}{p.error ? ` · ${p.error}` : ""}</li>)}{batch.skipped.map(p => <li key={p.id}>{p.email}：已跳过，原选择保留</li>)}</ul></details>
  </section>;
}
