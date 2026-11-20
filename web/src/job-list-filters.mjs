export const JOB_STATUS_LABELS = {
  queued: "排队中",
  starting: "启动中",
  working: "处理中",
  password: "待密码",
  mfa_otp: "待 2FA",
  totp_starting: "准备 2FA",
  password_add_starting: "准备密码",
  totp_setup_otp: "激活 2FA",
  inspection_paused: "已暂停",
  codex_email_verification: "邮箱二验",
  email_otp: "待邮箱码",
  phone: "待手机号",
  phone_otp: "待手机码",
  finalizing: "生成中",
  refreshing: "刷新授权",
  completed: "已完成",
  failed: "失败",
  mfa_failed: "2FA 未通过",
  banned: "封禁",
  canceled: "授权已取消",
  reauth_required: "待重新授权",
  resume_available: "可继续",
};
export const SUB2API_POOL_FILTER_LABELS = {
  added: "已加入",
  error: "错误",
  not_added: "未加入",
  unknown: "未同步",
};
export const SUB2API_ENABLED_FILTER_LABELS = {
  enabled: "已启用",
  disabled: "已停用",
  unknown: "未知",
};

const known = (values, labels) => Array.isArray(values) ? values.filter(value => Object.hasOwn(labels, value)) : [];

export function jobFilterOptions(options) {
  return {
    planTypeOptions: Array.isArray(options?.planTypes) ? options.planTypes : [],
    planTypeUnknown: options?.planTypeUnknown === true,
    statusOptions: known(options?.statuses, JOB_STATUS_LABELS),
    sub2apiPoolOptions: known(options?.sub2apiPools, SUB2API_POOL_FILTER_LABELS),
    sub2apiEnabledOptions: known(options?.sub2apiEnabled, SUB2API_ENABLED_FILTER_LABELS),
  };
}

// Compile once per filter/page change, not once per tick. Both endpoints
// receive the same active filters; the email-list endpoint needs typed JSON.
export function buildJobListRequest({ page, emails, search, ...filters }) {
  const active = Object.fromEntries(Object.entries({ search: search.trim(), ...filters }).filter(([, value]) => value));
  if (emails.length) return {
    url: "/api/jobs/query",
    options: { method: "POST", body: JSON.stringify({ page, emails, ...active }) },
  };
  return { url: `/api/jobs?${new URLSearchParams({ page, ...active })}`, options: {} };
}
