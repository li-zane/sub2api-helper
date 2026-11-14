export function hasUsageSnapshot(usage) {
  return Boolean(usage && (usage.primary || usage.secondary || usage.credits || usage.resetCredits || usage.totals
    || typeof usage.allowed === "boolean" || typeof usage.limitReached === "boolean"));
}

const knownFields = (before, after) => {
  if (!after) return before || null;
  if (!before) return after;
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(key => [key, after[key] ?? before[key]]));
};

// Request state is separate from successful data. Omitted fields are not zeros.
export function mergeUsageSnapshot(before, after) {
  if (!after) return before || null;
  if (!before || before.cacheKey && after.cacheKey && before.cacheKey !== after.cacheKey) return after;
  const older = Date.parse(after.fetchedAt) < Date.parse(before.fetchedAt);
  const first = older ? after : before, last = older ? before : after;
  const merged = { ...first, ...last };
  for (const key of ["primary", "secondary", "credits"]) merged[key] = knownFields(first[key], last[key]);
  const olderTotals = Date.parse(after.totals?.updatedAt || after.totals?.fetchedAt) < Date.parse(before.totals?.updatedAt || before.totals?.fetchedAt);
  merged.totals = olderTotals ? knownFields(after.totals, before.totals) : knownFields(before.totals, after.totals);
  for (const key of ["resetCredits", "allowed", "limitReached", "fetchedAt"]) merged[key] = last[key] ?? first[key] ?? null;
  if (last.resetCreditsObserved === true) merged.resetCredits = last.resetCredits;
  // Card checks have their own cadence; quota-window timestamps may be older.
  const beforeCardsAt = Date.parse(before.resetCreditsFetchedAt || before.fetchedAt || "") || 0;
  const afterCardsAt = Date.parse(after.resetCreditsFetchedAt || after.fetchedAt || "") || 0;
  const cards = after.resetCreditsObserved === true && (before.resetCreditsObserved !== true || afterCardsAt >= beforeCardsAt) ? after : before;
  if (cards.resetCreditsObserved === true) {
    for (const key of ["resetCredits", "resetCreditsObserved", "resetCreditsStale", "resetCreditsFetchedAt"]) merged[key] = cards[key];
  }
  if (!older && after.fetchedAt && after.fetchedAt !== before.fetchedAt) merged.error = null;
  return merged;
}
