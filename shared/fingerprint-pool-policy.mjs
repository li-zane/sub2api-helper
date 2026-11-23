export const FINGERPRINT_POOL_FIELDS = Object.freeze({ concurrency: "并发", priority: "优先级" });
export const FINGERPRINT_POOL_TIERS = Object.freeze({
  matchedFirstTrip: "不降智头车",
  mismatchedFirstTrip: "降智头车",
  matchedLongTerm: "不降智长效",
});

const DEFAULT_LADDER = Object.freeze({ enabled: false, matchedFirstTrip: null, mismatchedFirstTrip: null, matchedLongTerm: null });
export const DEFAULT_FINGERPRINT_POOL_POLICY = Object.freeze({ concurrency: DEFAULT_LADDER, priority: DEFAULT_LADDER });

export function isLegacyFingerprintConcurrency(section) {
  return Object.hasOwn(section, "value") && !Object.keys(FINGERPRINT_POOL_TIERS).some(key => Object.hasOwn(section, key));
}

export function fingerprintPoolNumber(policy, field, verdict, tags) {
  const section = policy[field];
  if (!section.enabled) return null;
  if (field === "concurrency" && isLegacyFingerprintConcurrency(section)) {
    return verdict === "match" ? section.value : null;
  }
  if (verdict === "match") {
    if (tags?.trip === "头车" && section.matchedFirstTrip != null) return section.matchedFirstTrip;
    if (tags?.validity === "长效") return section.matchedLongTerm ?? null;
  }
  if (verdict === "mismatch" && tags?.trip === "头车") return section.mismatchedFirstTrip ?? null;
  return null;
}
