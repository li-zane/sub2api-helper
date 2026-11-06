import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { readJsonResponse } from "./response-errors.js";
import { compactDateTime } from "./display-time.mjs";
import { useDisplayTimeZone } from "./use-display-time.jsx";

export function AccountSecurityLights({ job, token, disabledReason = "", onJobUpdate, onError }) {
  useDisplayTimeZone();
  const [pending, setPending] = useState(null), [failure, setFailure] = useState(null);
  const running = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reason = disabledReason || (!token ? "尚未连接控制台" : !job.webSessionAvailable ? "请先登录 Web，再核对远端状态" : "");
  async function check(field) {
    if (running.current || reason) return;
    running.current = true; setPending(field); setFailure(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/security-state?field=${field}`, { headers: { "x-console-token": token }, cache: "no-store" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "安全状态核对失败");
      if (!data.job || typeof data.securityState?.[field === "totp" ? "totpEnabled" : "passwordEnabled"] !== "boolean") throw new Error("上游未返回可确认的安全状态");
      if (alive.current && data.job) onJobUpdate?.(data.job);
    } catch (error) {
      if (alive.current) { setFailure({ field, message: error.message }); onError?.(`核对${field === "totp" ? " 2FA" : "密码"}失败：${error.message}；保留上次结果`); }
    } finally { running.current = false; if (alive.current) setPending(null); }
  }
  const state = job.securityState;
  return <div className="account-security-lights" role="group" aria-label="账号安全状态"
    style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 5, fontSize: 10.5, color: "var(--muted)" }}>
    {[["2FA", "totp", state?.totpEnabled, "totpCheckedAt"], ["密码", "password", state?.passwordEnabled, "passwordCheckedAt"]].map(([label, field, enabled, timeKey]) => {
      const known = enabled === true || enabled === false;
      const checkedAt = state && Object.hasOwn(state, timeKey) ? state[timeKey] : state?.checkedAt;
      const description = `${label}：${known ? enabled ? "已开启" : "未开启" : "待确认"}`;
      const note = checkedAt ? `；核对时间：${compactDateTime(checkedAt)}` : known ? "；已有成功验证记录，时间未记录" : "；尚无远端确认结果";
      return <button type="button" key={field} aria-label={`核对 ${label} 状态`} disabled={Boolean(reason || pending)} aria-busy={pending === field}
        onClick={() => check(field)} title={`${description}${note}；${pending === field ? "正在核对…" : reason || "点击手动核对远端状态"}${failure?.field === field ? `；上次核对失败：${failure.message}` : ""}`}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, padding: 0, background: "transparent", color: "inherit", font: "inherit", cursor: reason || pending ? "default" : "pointer" }}>
        <span role="img" aria-label={description} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <i aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: known ? enabled ? "var(--emerald)" : "var(--danger)" : "var(--subtle)" }} />{label}
        </span>
        {pending === field && <LoaderCircle size={10} className="spin" aria-hidden="true" />}
      </button>;
    })}
  </div>;
}
