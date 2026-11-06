export function codexStatusEligible(job) {
  return job?.sub2apiInPool === true && job?.sub2apiEnabled === true && job?.sub2apiRateLimited !== true && job?.codexStatusEligible !== false && !job?.autoRepairBlocked && job?.status !== "banned";
}

export function codexStatusBlockReason(job) {
  if (job?.autoRepairBlocked || job?.status === "banned") return "账号已封禁，Codex 检测已停止";
  if (job?.sub2apiRateLimited) return "账号处于 429 限流中，过载及降智检测已停止";
  return "账号需先加入号池并启用";
}
