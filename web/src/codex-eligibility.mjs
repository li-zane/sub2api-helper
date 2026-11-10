export function usageRestricted(usage) {
  return usage?.quotaRestricted === true || usage?.limitReached === true || usage?.allowed === false || usage?.credits?.overageLimitReached === true
    || [usage?.primary, usage?.secondary].some(window => typeof window?.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 100);
}

export function codexStatusEligible(job) {
  return job?.sub2apiInPool === true && job?.sub2apiEnabled === true && job?.sub2apiRemoteStatus !== "error" && job?.sub2apiRateLimited !== true && job?.sub2apiQuotaRestricted !== true && !usageRestricted(job?.sub2apiUsage) && job?.codexStatusEligible !== false && !job?.autoRepairBlocked && job?.status !== "banned";
}

export function codexStatusBlockReason(job) {
  if (job?.autoRepairBlocked || job?.status === "banned") return "账号已封禁，Codex 检测已停止";
  if (job?.sub2apiRateLimited) return "账号处于 429 限流中，过载及降智检测已停止";
  if (job?.sub2apiQuotaRestricted || usageRestricted(job?.sub2apiUsage)) return "账号已达到用量限额，Codex 探测已停止；额度同步仍可使用";
  if (job?.sub2apiRemoteStatus === "error") return "号池账号报错，Codex 检测已暂停；点击号池错误标签查看错误码";
  return "账号需先加入号池并启用";
}
