import { FINGERPRINT_POOL_FIELDS, FINGERPRINT_POOL_TIERS, ROTATION_POOL_FIELDS, isLegacyFingerprintConcurrency, longTermPolicyValues, parsePoolRateMultiplier } from "../../shared/fingerprint-pool-policy.mjs";

export const POOL_STEP_FIELDS = Object.keys(FINGERPRINT_POOL_TIERS);
const poolFields = Object.keys(FINGERPRINT_POOL_FIELDS);
const rotationFields = Object.keys(ROTATION_POOL_FIELDS);
const parseRotationField = (field, value) => field === "rateMultiplier" ? parsePoolRateMultiplier(value) : parseIntegerInRange(value);
const mapRotation = read => Object.fromEntries(rotationFields.map(field => [field, read(field)]));

export function normalizePlanTypeKey(value) {
  return String(value ?? "").trim().toLowerCase().slice(0, 128);
}

function parseIntegerInRange(value, min = 0, max = 10000) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
  }
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function mapPoolSections(readSection) {
  return Object.fromEntries(poolFields.map(field => [field, readSection(field)]));
}

function mapPoolTiers(readTier) {
  return Object.fromEntries(POOL_STEP_FIELDS.map(key => [key, readTier(key)]));
}

export function createDefaultPolicyDraft() {
  return { ...mapPoolSections(() => ({ enabled: false, ...mapPoolTiers(() => "") })), rotation: mapRotation(() => "") };
}

export function normalizeFingerprintPoolPolicyEntry(raw) {
  const sections = mapPoolSections(field => {
    const section = raw?.[field] || {};
    const enabled = section.enabled === true;
    if (field === "concurrency" && isLegacyFingerprintConcurrency(section)) {
      return { enabled, value: parseIntegerInRange(section.value) ?? 10 };
    }
    const values = longTermPolicyValues(section);
    return { enabled, ...mapPoolTiers(key => parseIntegerInRange(values[key])) };
  });
  return { ...sections, rotation: mapRotation(field => parseRotationField(field, raw?.rotation?.[field])) };
}

export function normalizeFingerprintPoolPoliciesMap(rawPolicies) {
  if (!rawPolicies || typeof rawPolicies !== "object" || Array.isArray(rawPolicies)) return {};
  const normalized = Object.create(null);
  for (const [rawKey, entry] of Object.entries(rawPolicies)) {
    const key = normalizePlanTypeKey(rawKey);
    if (!key) continue;
    normalized[key] = normalizeFingerprintPoolPolicyEntry(entry);
  }
  return normalized;
}

export function policyToDraft(policy) {
  const normalized = normalizeFingerprintPoolPolicyEntry(policy);
  const draft = mapPoolSections(field => ({
    enabled: normalized[field].enabled,
    ...mapPoolTiers(key => String(normalized[field][key] ?? "")),
  }));
  draft.rotation = mapRotation(field => String(normalized.rotation[field] ?? ""));
  if (isLegacyFingerprintConcurrency(normalized.concurrency)) {
    draft.legacyConcurrencyValue = normalized.concurrency.value;
  }
  return draft;
}

export function policiesMapToDrafts(policiesMap) {
  const normalized = normalizeFingerprintPoolPoliciesMap(policiesMap);
  const drafts = Object.create(null);
  for (const [key, entry] of Object.entries(normalized)) {
    drafts[key] = policyToDraft(entry);
  }
  return drafts;
}

export function togglePolicyDraftSwitch(currentDraft, field, enabled) {
  const draft = currentDraft || createDefaultPolicyDraft();
  const badInputs = { ...draft.__badInputs };
  if (!enabled) {
    for (const key of POOL_STEP_FIELDS) delete badInputs[`${field}.${key}`];
  }
  return {
    ...draft,
    [field]: { ...draft[field], enabled },
    __badInputs: badInputs,
  };
}

export function validatePolicyDraft(draft) {
  const errors = {};
  let firstErrorField = null;
  let firstErrorMessage = "";
  for (const field of poolFields) {
    if (!draft?.[field]?.enabled) continue;
    for (const key of POOL_STEP_FIELDS) {
      const input = `${field}.${key}`;
      const text = String(draft[field][key] ?? "").trim();
      if (!draft.__badInputs?.[input] && (!text || parseIntegerInRange(text) !== null)) continue;
      errors[input] = "留空或输入 0–10000 的整数";
      if (!firstErrorField) {
        firstErrorField = input;
        firstErrorMessage = errors[input];
      }
    }
  }
  for (const field of rotationFields) {
    const input = `rotation.${field}`;
    const text = String(draft?.rotation?.[field] ?? "").trim();
    if (!draft?.__badInputs?.[input] && (!text || parseRotationField(field, text) !== null)) continue;
    errors[input] = field === "rateMultiplier" ? "留空或输入 0–1000000，最多 6 位小数" : "留空或输入 0–10000 的整数";
    if (!firstErrorField) {
      firstErrorField = input;
      firstErrorMessage = errors[input];
    }
  }
  return { valid: firstErrorField === null, errors, firstErrorField, firstErrorMessage };
}

export function draftToPolicy(draft) {
  const sections = mapPoolSections(field => {
    const enabled = draft?.[field]?.enabled === true;
    if (field === "concurrency" && Number.isInteger(draft?.legacyConcurrencyValue)) {
      return { enabled, value: draft.legacyConcurrencyValue };
    }
    return {
      enabled,
      ...mapPoolTiers(key => draft?.__badInputs?.[`${field}.${key}`] ? null : parseIntegerInRange(draft?.[field]?.[key])),
    };
  });
  return { ...sections, rotation: mapRotation(field => parseRotationField(field, draft?.rotation?.[field])) };
}

export function resolveProfilePlanTypes({
  activeProfileId,
  profiles = [],
  planTypeBindings = {},
  availablePlanTypes = [],
  savedPolicies = {},
  removedResidualKeys = [],
}) {
  const targetId = String(activeProfileId ?? "");
  const profileNameMap = new Map(
    (Array.isArray(profiles) ? profiles : []).map((profile) => [String(profile.id), profile.name || profile.id]),
  );
  const removedSet = new Set((removedResidualKeys || []).map(normalizePlanTypeKey).filter(Boolean));
  const rawLabelCandidates = new Map();
  const rememberRawCase = (raw) => {
    const trimmed = String(raw ?? "").trim();
    const key = trimmed.toLowerCase().slice(0, 128);
    if (!key) return "";
    if (!rawLabelCandidates.has(key)) rawLabelCandidates.set(key, trimmed);
    return key;
  };

  const boundToCurrent = [];
  const boundToCurrentSet = new Set();
  const boundToOtherMap = new Map();

  for (const [rawPlanType, boundProfileId] of Object.entries(planTypeBindings || {})) {
    const key = rememberRawCase(rawPlanType);
    if (!key) continue;
    const ownerId = String(boundProfileId ?? "");
    if (ownerId === targetId) {
      if (!boundToCurrentSet.has(key)) {
        boundToCurrentSet.add(key);
        boundToCurrent.push(key);
      }
    } else if (!boundToCurrentSet.has(key)) {
      boundToOtherMap.set(key, {
        ownerId,
        ownerName: profileNameMap.get(ownerId) || ownerId,
      });
    }
  }

  const unboundAvailable = [];
  const unboundSet = new Set();
  for (const rawPlanType of Array.isArray(availablePlanTypes) ? availablePlanTypes : []) {
    const key = rememberRawCase(rawPlanType);
    if (!key || boundToCurrentSet.has(key) || boundToOtherMap.has(key) || unboundSet.has(key)) continue;
    unboundSet.add(key);
    unboundAvailable.push(key);
  }

  const configurable = [
    ...boundToCurrent.map((key) => ({
      key,
      rawValue: rawLabelCandidates.get(key) || key,
      source: "bound",
      residual: false,
      boundElsewhere: null,
    })),
    ...unboundAvailable.map((key) => ({
      key,
      rawValue: rawLabelCandidates.get(key) || key,
      source: "fallback",
      residual: false,
      boundElsewhere: null,
    })),
  ];
  const configurableSet = new Set(configurable.map((item) => item.key));

  const residual = [];
  const residualSeen = new Set();
  for (const rawKey of Object.keys(savedPolicies || {})) {
    const key = normalizePlanTypeKey(rawKey);
    if (!key || removedSet.has(key) || configurableSet.has(key) || residualSeen.has(key)) continue;
    residualSeen.add(key);
    const elsewhere = boundToOtherMap.get(key) || null;
    residual.push({
      key,
      rawValue: rawLabelCandidates.get(key) || key,
      source: "residual",
      residual: true,
      boundElsewhere: elsewhere,
    });
  }

  return {
    configurable,
    residual,
    allTabs: [...configurable, ...residual],
  };
}

export function validateAndSerializeAllProfilePolicies({
  profiles = [],
  draftsByProfileId = {},
  removedResidualsByProfileId = {},
  planTypeBindings = {},
  availablePlanTypes = [],
}) {
  const nextPoliciesByProfileId = Object.create(null);

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const profileId = String(profile.id);
    const savedPolicies = normalizeFingerprintPoolPoliciesMap(profile.fingerprintPoolPolicies);
    const profileDrafts = draftsByProfileId?.[profileId] || {};
    const removedKeys = removedResidualsByProfileId?.[profileId] || [];
    const removedSet = new Set(removedKeys.map(normalizePlanTypeKey).filter(Boolean));
    const { configurable } = resolveProfilePlanTypes({
      activeProfileId: profileId,
      profiles,
      planTypeBindings,
      availablePlanTypes,
      savedPolicies,
      removedResidualKeys: removedKeys,
    });

    for (const tab of configurable) {
      const draft = profileDrafts[tab.key];
      if (!draft) continue;
      const validation = validatePolicyDraft(draft);
      if (!validation.valid) {
        return {
          valid: false,
          error: {
            profileId,
            profileName: profile.name || profileId,
            planType: tab.key,
            field: validation.firstErrorField,
            message: validation.firstErrorMessage,
          },
          nextPoliciesByProfileId: null,
        };
      }
    }

    const serialized = Object.create(null);
    const candidateKeys = new Set([
      ...Object.keys(savedPolicies),
      ...Object.keys(profileDrafts).map(normalizePlanTypeKey),
    ]);
    for (const key of candidateKeys) {
      if (!key || removedSet.has(key)) continue;
      const hasDraft = Object.hasOwn(profileDrafts, key);
      const entry = hasDraft ? draftToPolicy(profileDrafts[key]) : savedPolicies[key];
      if (!entry) continue;
      serialized[key] = entry;
    }
    nextPoliciesByProfileId[profileId] = serialized;
  }

  return {
    valid: true,
    error: null,
    nextPoliciesByProfileId,
  };
}
