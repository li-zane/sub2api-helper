// Keep UI eligibility and the submitted subset consistent without changing plans.
export function proxySwitchSelectionState(jobs, { mode, proxySettingsDirty = false, sub2apiReady = false, selectedCount = jobs.length } = {}) {
  const eligible = jobs.filter((job) => job.canSwitchProxy === true && job.canLogoutAllSessions === true && job.canForceRelogin === true);
  const skippedCount = Math.max(0, selectedCount - eligible.length);
  let reason = "";
  if (!selectedCount) reason = "请先勾选账号";
  else if (jobs.length !== selectedCount) reason = "正在同步所选账号，请稍候";
  else if (!["sub2api", "plan"].includes(mode)) reason = "请在任务设置中选择并保存 Sub2API 代理模式或按 PlanType 授权模式";
  else if (proxySettingsDirty) reason = "请先保存代理配置";
  else if (!sub2apiReady) reason = "请先配置 Sub2API 后端和管理员 API Key";
  else if (!eligible.length) reason = jobs.some((job) => job.canSwitchProxy === true)
    ? "所选账号正在运行或缺少已保存的授权，暂不能切换 IP"
    : "所选账号的当前方案未指定切换目标，请选择直连、固定代理或均衡分配";
  else reason = `可按当前方案切换 ${eligible.length} 个账号${skippedCount ? `，将跳过 ${skippedCount} 个未指定目标或尚未就绪的账号` : ""}`;
  return { canSwitch: selectedCount === jobs.length && eligible.length > 0 && ["sub2api", "plan"].includes(mode) && !proxySettingsDirty && sub2apiReady, eligible, skippedCount, reason };
}

// Keep bulk logout bounded; one account failing must not interrupt the others.
export async function logoutAccountSessions(jobs, request, onProgress = () => {}) {
  const results = new Array(jobs.length);
  let next = 0;
  let completed = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      try {
        await request(`/api/jobs/${encodeURIComponent(job.id)}/sessions/logout-all`, { method: "POST" });
        results[index] = { job, ok: true };
      } catch (error) {
        results[index] = { job, ok: false, error: error?.message || "请求失败" };
      }
      onProgress(++completed, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return results;
}
