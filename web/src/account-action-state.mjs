// Keep read access independent of login mutations. This text also explains why
// an otherwise available action is locked while a task is waiting for input.
export function accountMutationBlockReason(job, { workflowBusy = false, submitting = false } = {}) {
  if (submitting) return "正在提交操作，请稍候";
  if (workflowBusy) return "批量操作正在进行，请等待完成；期间仍可查看账号资料";
  const stages = {
    queued: "任务正在排队，请等待或取消当前任务",
    starting: "正在启动账号任务，请等待或取消当前任务",
    working: "账号任务正在进行，请等待或取消当前任务",
    password: "正在等待登录密码，请继续登录或取消当前任务",
    email_otp: "正在等待邮箱验证码，请继续验证或取消当前任务",
    mfa_otp: "正在等待 2FA 验证码，请继续验证或取消当前任务",
    phone: "正在等待绑定手机号，请继续验证或取消当前任务",
    phone_otp: "正在等待短信验证码，请继续验证或取消当前任务",
    totp_setup_otp: "正在设置 2FA，请完成验证或取消当前任务",
    totp_starting: "正在准备设置 2FA，请等待或取消当前任务",
    password_add_starting: "正在添加账号密码，请等待或取消当前任务",
    finalizing: "正在保存授权结果，请等待完成",
    refreshing: "正在刷新 Codex 授权，请等待或取消当前任务",
  };
  if (stages[job.status]) return stages[job.status];
  if (job.webLoginPending) return "Web 登录正在进行，请等待完成或取消当前任务";
  if (job.webSessionCheckPending) return "Web 会话检测正在进行，请等待完成";
  if (["pending", "queued", "running"].includes(job.autoTaskStatus)) return "账号自动化任务正在进行，请等待完成";
  if (job.poolRefreshAction) return job.poolRefreshError
    ? "授权或号池同步尚未完成，可点击 Codex 授权重试"
    : "授权结果正在等待更新号池，请等待当前操作完成";
  return "";
}
