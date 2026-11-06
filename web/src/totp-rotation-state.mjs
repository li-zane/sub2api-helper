export function totpRotationView(job, requestPending = false) {
  const active = requestPending || job?.lastOperationType === "replace_2fa" && ["queued", "starting", "working", "password", "email_otp", "mfa_otp", "totp_starting", "totp_setup_otp", "finalizing"].includes(job.status);
  if (active) return { state: "running", label: "2FA 轮换进行中" };
  if (job?.totpRotationIncomplete) return { state: "incomplete", label: "2FA 轮换未完成（原授权可用）" };
  if (job?.lastOperationType === "replace_2fa" && job?.totpRotationStage === "confirmed") return { state: "completed", label: "2FA 轮换已完成" };
  return { state: "idle", label: job?.status || "" };
}
