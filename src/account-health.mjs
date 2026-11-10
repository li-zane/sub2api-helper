// Task outcomes are historical; current account/session/pool state takes priority.
export function accountHealth(job, pool = {}, banned = false) {
  if (banned || job.autoRepairBlocked || job.status === 'banned' || job.webSessionStatus === 'banned') return 'abnormal';
  if (pool.inPool === true && pool.remoteStatus === 'error' || pool.remoteStatus === 'banned') return 'abnormal';
  if (job.webSessionStatus === 'expired') return 'abnormal';
  if (job.webSessionStatus === 'valid' || pool.inPool === true && pool.remoteStatus === 'active') return 'normal';
  if (job.status === 'completed' && job.resultSaved) return 'normal';
  return 'pending';
}
