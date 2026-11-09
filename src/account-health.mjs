import { usageRestricted } from '../web/src/codex-eligibility.mjs';
// Task outcomes are historical; current account/session/pool state takes priority.
export function accountHealth(job, pool = {}, banned = false) {
  if (banned || job.autoRepairBlocked || job.status === 'banned' || job.webSessionStatus === 'banned') return 'abnormal';
  if (pool.rateLimited || pool.quotaRestricted || usageRestricted(pool.usage) || ['error', 'disabled', 'expired', 'banned'].includes(pool.remoteStatus)) return 'abnormal';
  if (['expired', 'unavailable'].includes(job.webSessionStatus)) return 'abnormal';
  if (job.loginAutomationPause || job.webSessionMaintenancePause || job.poolRefreshError) return 'abnormal';
  if (job.webSessionStatus === 'valid' || pool.inPool === true && pool.remoteStatus === 'active') return 'normal';
  if (['failed', 'mfa_failed', 'reauth_required', 'resume_available'].includes(job.status)) return 'abnormal';
  if (job.status === 'completed' && job.resultSaved) return 'normal';
  return 'pending';
}
