export function codexStatusEligible(job) {
  return job?.sub2apiInPool === true && job?.sub2apiEnabled === true && !job?.autoRepairBlocked && job?.status !== "banned";
}
