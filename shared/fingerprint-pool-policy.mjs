export const FINGERPRINT_POOL_FIELDS = Object.freeze({ concurrency: "并发", priority: "优先级" });
export const FINGERPRINT_POOL_TIERS = Object.freeze({
  matchedRotation: "不降智轮转",
  matchedLongTerm: "不降智长效",
  mismatchedRotation: "降智轮转",
  mismatchedLongTerm: "降智长效",
});

const DEFAULT_LADDER = Object.freeze({ enabled: false, ...Object.fromEntries(Object.keys(FINGERPRINT_POOL_TIERS).map(key => [key, null])) });
export const DEFAULT_FINGERPRINT_POOL_POLICY = Object.freeze({
  concurrency: DEFAULT_LADDER,
  priority: DEFAULT_LADDER,
});

export function isLegacyFingerprintConcurrency(section) {
  return Object.hasOwn(section, "value") && !Object.keys(FINGERPRINT_POOL_TIERS).some(key => Object.hasOwn(section, key))
    && !Object.hasOwn(section, "matchedFirstTrip") && !Object.hasOwn(section, "mismatchedFirstTrip");
}

export function fingerprintPoolTierValues(section, field, rotation) {
  const oldLongTerm = !Object.hasOwn(section, "mismatchedLongTerm");
  const legacyConcurrency = field === "concurrency" && isLegacyFingerprintConcurrency(section) ? section.value : null;
  const legacyRotation = rotation?.[field];
  return {
    matchedRotation: Object.hasOwn(section, "matchedRotation") ? section.matchedRotation : legacyRotation,
    matchedLongTerm: oldLongTerm ? section.matchedLongTerm ?? section.matchedFirstTrip ?? legacyConcurrency : section.matchedLongTerm,
    mismatchedRotation: Object.hasOwn(section, "mismatchedRotation") ? section.mismatchedRotation : legacyRotation,
    mismatchedLongTerm: oldLongTerm ? section.mismatchedFirstTrip : section.mismatchedLongTerm,
  };
}

export function fingerprintPoolNumber(policy, field, verdict, tags) {
  const validity = tags?.validity;
  if (!Object.hasOwn(FINGERPRINT_POOL_FIELDS, field)) return null;
  if (!policy[field]?.enabled || (verdict !== "match" && verdict !== "mismatch")) return null;
  const prefix = verdict === "match" ? "matched" : "mismatched";
  const suffix = validity === "轮转" ? "Rotation" : validity === "长效" ? "LongTerm" : null;
  return suffix ? policy[field][prefix + suffix] ?? null : null;
}
