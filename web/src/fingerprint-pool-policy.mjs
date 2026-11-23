export const PRIORITY_STEP_FIELDS = Object.freeze([
  Object.freeze({ step: 1, key: "matchedFirstTrip", label: "不降智头车", inputLabel: "不降智头车优先级" }),
  Object.freeze({ step: 2, key: "mismatchedFirstTrip", label: "降智头车", inputLabel: "降智头车优先级" }),
  Object.freeze({ step: 3, key: "matchedLongTerm", label: "不降智长效", inputLabel: "不降智长效优先级" }),
]);

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

export function createDefaultPolicyDraft() {
  return {
    concurrency: { enabled: false, value: "10" },
    priority: {
      enabled: false,
      matchedFirstTrip: "",
      mismatchedFirstTrip: "",
      matchedLongTerm: "",
    },
  };
}

export function normalizeFingerprintPoolPolicyEntry(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawConcurrency = source.concurrency && typeof source.concurrency === "object" ? source.concurrency : {};
  const rawPriority = source.priority && typeof source.priority === "object" ? source.priority : {};
  const parsedConcurrency = parseIntegerInRange(rawConcurrency.value, 0, 10000);
  return {
    concurrency: {
      enabled: rawConcurrency.enabled === true,
      value: parsedConcurrency ?? 10,
    },
    priority: {
      enabled: rawPriority.enabled === true,
      matchedFirstTrip: parseIntegerInRange(rawPriority.matchedFirstTrip, 0, 10000),
      mismatchedFirstTrip: parseIntegerInRange(rawPriority.mismatchedFirstTrip, 0, 10000),
      matchedLongTerm: parseIntegerInRange(rawPriority.matchedLongTerm, 0, 10000),
    },
  };
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
  if (!policy || typeof policy !== "object") return createDefaultPolicyDraft();
  const normalized = normalizeFingerprintPoolPolicyEntry(policy);
  return {
    concurrency: {
      enabled: normalized.concurrency.enabled,
      value: String(normalized.concurrency.value ?? 10),
    },
    priority: {
      enabled: normalized.priority.enabled,
      matchedFirstTrip: normalized.priority.matchedFirstTrip === null ? "" : String(normalized.priority.matchedFirstTrip),
      mismatchedFirstTrip: normalized.priority.mismatchedFirstTrip === null ? "" : String(normalized.priority.mismatchedFirstTrip),
      matchedLongTerm: normalized.priority.matchedLongTerm === null ? "" : String(normalized.priority.matchedLongTerm),
    },
  };
}

export function policiesMapToDrafts(policiesMap) {
  const normalized = normalizeFingerprintPoolPoliciesMap(policiesMap);
  const drafts = Object.create(null);
  for (const [key, entry] of Object.entries(normalized)) {
    drafts[key] = policyToDraft(entry);
  }
  return drafts;
}

export function togglePolicyDraftSwitch(currentDraft, section, enabled) {
  const draft = currentDraft || createDefaultPolicyDraft();
  const prevBadInputs = draft.__badInputs || {};
  if (section === "concurrency") {
    const nextValueText = enabled && String(draft.concurrency?.value ?? "").trim() === "" && !prevBadInputs.concurrency
      ? "10"
      : String(draft.concurrency?.value ?? "10");
    return {
      ...draft,
      concurrency: {
        enabled: Boolean(enabled),
        value: nextValueText,
      },
      __badInputs: enabled ? prevBadInputs : { ...prevBadInputs, concurrency: false },
    };
  }
  if (section === "priority") {
    return {
      ...draft,
      priority: {
        matchedFirstTrip: "",
        mismatchedFirstTrip: "",
        matchedLongTerm: "",
        ...draft.priority,
        enabled: Boolean(enabled),
      },
      __badInputs: enabled
        ? prevBadInputs
        : {
          ...prevBadInputs,
          matchedFirstTrip: false,
          mismatchedFirstTrip: false,
          matchedLongTerm: false,
        },
    };
  }
  return draft;
}

export function validatePolicyDraft(draft) {
  const current = draft || createDefaultPolicyDraft();
  const badInputs = current.__badInputs || {};
  const errors = {
    concurrency: "",
    matchedFirstTrip: "",
    mismatchedFirstTrip: "",
    matchedLongTerm: "",
  };
  let firstErrorField = null;
  let firstErrorMessage = "";

  if (current.concurrency?.enabled === true) {
    const parsedConcurrency = badInputs.concurrency
      ? null
      : parseIntegerInRange(current.concurrency.value, 0, 10000);
    if (parsedConcurrency === null) {
      errors.concurrency = "请输入 0–10000 的整数";
      firstErrorField = "concurrency";
      firstErrorMessage = errors.concurrency;
    }
  }

  if (current.priority?.enabled === true) {
    for (const stepField of PRIORITY_STEP_FIELDS) {
      if (badInputs[stepField.key]) {
        errors[stepField.key] = "留空或输入 0–10000 的整数";
        if (!firstErrorField) {
          firstErrorField = stepField.key;
          firstErrorMessage = errors[stepField.key];
        }
        continue;
      }
      const rawText = String(current.priority?.[stepField.key] ?? "").trim();
      if (rawText === "") continue;
      if (parseIntegerInRange(rawText, 0, 10000) === null) {
        errors[stepField.key] = "留空或输入 0–10000 的整数";
        if (!firstErrorField) {
          firstErrorField = stepField.key;
          firstErrorMessage = errors[stepField.key];
        }
      }
    }
  }

  return {
    valid: firstErrorField === null,
    errors,
    firstErrorField,
    firstErrorMessage,
  };
}

export function isPriorityAllEmpty(draft) {
  if (draft?.priority?.enabled !== true) return false;
  return PRIORITY_STEP_FIELDS.every((field) => String(draft.priority?.[field.key] ?? "").trim() === "");
}

export function draftToPolicy(draft) {
  const current = draft || createDefaultPolicyDraft();
  const badInputs = current.__badInputs || {};
  const parsedConcurrency = badInputs.concurrency
    ? null
    : parseIntegerInRange(current.concurrency?.value, 0, 10000);
  return {
    concurrency: {
      enabled: current.concurrency?.enabled === true,
      value: parsedConcurrency ?? 10,
    },
    priority: {
      enabled: current.priority?.enabled === true,
      matchedFirstTrip: badInputs.matchedFirstTrip
        ? null
        : parseIntegerInRange(current.priority?.matchedFirstTrip, 0, 10000),
      mismatchedFirstTrip: badInputs.mismatchedFirstTrip
        ? null
        : parseIntegerInRange(current.priority?.mismatchedFirstTrip, 0, 10000),
      matchedLongTerm: badInputs.matchedLongTerm
        ? null
        : parseIntegerInRange(current.priority?.matchedLongTerm, 0, 10000),
    },
  };
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
