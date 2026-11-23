export const FINGERPRINT_POOL_FIELDS = Object.freeze({ concurrency: "并发", priority: "优先级" });
export const FINGERPRINT_POOL_TIERS = Object.freeze({
  matchedLongTerm: "不降智长效",
  mismatchedLongTerm: "降智长效",
});
export const ROTATION_POOL_FIELDS = Object.freeze({ priority: "优先级", rateMultiplier: "计费倍率" });

const DEFAULT_LADDER = Object.freeze({ enabled: false, matchedLongTerm: null, mismatchedLongTerm: null });
export const DEFAULT_FINGERPRINT_POOL_POLICY = Object.freeze({
  concurrency: DEFAULT_LADDER,
  priority: DEFAULT_LADDER,
  rotation: Object.freeze({ priority: null, rateMultiplier: null }),
});

export function isLegacyFingerprintConcurrency(section) {
  return Object.hasOwn(section, "value") && !Object.keys(FINGERPRINT_POOL_TIERS).some(key => Object.hasOwn(section, key))
    && !Object.hasOwn(section, "matchedFirstTrip") && !Object.hasOwn(section, "mismatchedFirstTrip");
}

export function longTermPolicyValues(section) {
  if (Object.hasOwn(section, "mismatchedLongTerm")) return section;
  return {
    matchedLongTerm: section.matchedLongTerm ?? section.matchedFirstTrip,
    mismatchedLongTerm: section.mismatchedFirstTrip,
  };
}

export function isPoolRateMultiplier(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

export function parsePoolRateMultiplier(value) {
  if (!["string", "number"].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const number = Number(text);
  return isPoolRateMultiplier(number) ? number : null;
}

export function fingerprintPoolNumber(policy, field, verdict, tags) {
  if (tags?.validity === "轮转") {
    if (field === "priority") return policy.rotation?.priority ?? null;
    if (field === "rate_multiplier") return policy.rotation?.rateMultiplier ?? null;
  }
  if (tags?.validity !== "长效" || field === "rate_multiplier") return null;
  const section = policy[field];
  if (!section.enabled) return null;
  if (field === "concurrency" && isLegacyFingerprintConcurrency(section)) {
    return verdict === "match" ? section.value : null;
  }
  if (verdict === "match") return section.matchedLongTerm ?? null;
  if (verdict === "mismatch") return section.mismatchedLongTerm ?? null;
  return null;
}
