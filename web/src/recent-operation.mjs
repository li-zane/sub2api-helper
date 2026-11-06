const LABELS = {
  initial_authorization: "首次授权", reauthorize: "重新授权", relogin: "重新开始授权",
  web_login: "Web 登录", automatic_relogin: "自动授权", resume: "继续授权",
  setup_2fa: "设置 2FA", replace_2fa: "更换 2FA", add_password: "添加密码", replace_password: "轮换密码",
  account_update: "更新账号资料", credential_update: "更新凭据", proxy_update: "更新代理 IP",
  cooldown: "账号冷却", workspace_switch: "切换空间",
};
const AUTHORIZATION = new Set(["initial_authorization", "reauthorize", "relogin", "automatic_relogin", "resume"]);
const UPDATES = new Set(["account_update", "credential_update", "proxy_update", "workspace_switch"]);
const ACTIVE_STATUSES = new Set([
  "queued", "starting", "working", "totp_starting",
  "password_add_starting", "finalizing", "refreshing",
]);
const ERROR_STATUSES = new Set(["failed", "mfa_failed", "banned", "canceled"]);

function feedbackText(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  const text = String(value);
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export function recentOperation(job, statusLabels = {}) {
  const type = job.lastOperationType || "initial_authorization";
  let result = statusLabels[job.status] || "状态未知";
  let error = null;
  let message = job.prompt || "";
  let tone = ERROR_STATUSES.has(job.status) ? "error"
    : job.status === "completed" ? "success"
    : ACTIVE_STATUSES.has(job.status) ? "running" : "pending";

  // Web-only login restores the previous authorization status, so that status
  // must never be presented as the result of the newer Web operation.
  if (type === "web_login") {
    error = job.webLoginError;
    if (job.webLoginPending) result = statusLabels[job.status] || "登录中";
    else if (error) result = /已取消/.test(feedbackText(error)) ? "已取消" : "失败";
    else if (job.webLoginCompletedAt && Date.parse(job.webLoginCompletedAt) >= Date.parse(job.lastOperationAt || job.createdAt)) result = "已完成";
    else result = "待确认";
    tone = error ? "error" : result === "已完成" ? "success" : (job.webLoginPending && (!job.status || ACTIVE_STATUSES.has(job.status))) ? "running" : "pending";
    message = job.webLoginPending ? job.prompt : error || (result === "已完成" ? "Web 登录态已保存" : "尚无本次 Web 登录的完成反馈");
  } else if (["setup_2fa", "replace_2fa"].includes(type)) {
    error = job.totpSetupError;
    if (error) { result = "失败"; tone = "error"; }
    message = error || job.prompt;
  } else if (["add_password", "replace_password"].includes(type)) {
    error = job.passwordAddError;
    if (error) { result = "失败"; tone = "error"; }
    message = error || job.prompt;
  } else if (UPDATES.has(type)) {
    // Credential/route updates can happen after a failed authorization. Its
    // old prompt/error is not feedback from this update.
    result = "已更新"; tone = "success"; message = "账号操作已保存";
  } else {
    error = job.lastError;
    if (AUTHORIZATION.has(type) && job.poolRefreshError) {
      error = job.poolRefreshError; result = "同步待完成"; tone = "error";
    } else if (type === "cooldown" && job.poolRefreshDueAt) {
      result = "冷却中"; tone = "pending";
    }
  }

  const details = [];
  const add = (label, value) => { const text = feedbackText(value); if (text) details.push(`${label}\n${text}`); };
  add("操作类型", type);
  add("结果", result);
  add("反馈", message);
  if (error && feedbackText(error) !== feedbackText(message)) add("错误详情", error);
  // These diagnostics used to occupy several lines in the table. Keep them in
  // the detail view with explicit labels, separate from the operation result.
  if (job.webSessionMaintenancePause) add("Web 自动维护已暂停", `${job.webSessionMaintenancePause.reason === "logout" ? "已主动登出" : "已取消任务"}；手动检测或重新登录可恢复。`);
  if (job.webSessionCheckPending) add("Web 会话检测", job.webSessionCheckStatus === "queued" ? "排队中" : job.webSessionCheckStatus === "relogin" ? "会话已确认失效，正在重登，完成后自动复检" : "正在检测 Web 会话并核对套餐与自动化开关");
  if (job.webSessionCheckError) add("Web 会话检测失败", job.webSessionCheckError);
  if (job.webSessionRepairRetryAt) add("Web 自动重登冷却中", `最早重试时间：${job.webSessionRepairRetryAt}；到期后由巡检调度。可手动检测 Web 会话，确认失效后立即重登。`);
  if (job.poolRefreshAction) add("号池更新", job.poolRefreshError || (job.poolRefreshDueAt ? `冷却至 ${job.poolRefreshDueAt}` : job.poolRefreshReady ? "正在更新号池凭据" : "授权完成后更新号池凭据"));
  if (job.autoRepairBlocked) add("号池监控已永久跳过", job.autoRepairBlockedReason || "账号已不可用");
  if (job.banProxyReleasePending) add("封禁账号 IP 解绑待重试", job.banProxyReleaseError || "正在解绑");
  if (job.mailApiError && job.status === "email_otp") add("邮箱服务反馈", job.mailApiError);
  if (job.phoneError) add("手机验证反馈", job.phoneError);
  if (job.smsError) add("接码平台反馈", job.smsError);
  return { type, label: LABELS[type] || "账号操作", result, tone,
    at: job.lastOperationAt || job.createdAt, text: details.join("\n\n") };
}
