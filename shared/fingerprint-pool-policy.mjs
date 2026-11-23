export const DEFAULT_FINGERPRINT_POOL_POLICY = Object.freeze({
  concurrency: Object.freeze({ enabled: false, value: 10 }),
  priority: Object.freeze({ enabled: false, matchedFirstTrip: null, mismatchedFirstTrip: null, matchedLongTerm: null }),
});

export function fingerprintPoolNumber(policy, field, verdict, tags) {
  if (!policy[field].enabled) return null;
  if (field === "concurrency") return verdict === "match" ? policy.concurrency.value : null;
  if (verdict === "match") {
    if (tags?.trip === "头车" && policy.priority.matchedFirstTrip !== null) return policy.priority.matchedFirstTrip;
    if (tags?.validity === "长效") return policy.priority.matchedLongTerm;
  }
  if (verdict === "mismatch" && tags?.trip === "头车") return policy.priority.mismatchedFirstTrip;
  return null;
}
