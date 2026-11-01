// Only expose the count and expiration metadata supplied by Sub2API.
export function normalizeResetCredits(value, { cached = false, now = Date.now() } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = value.available_count;
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const credits = Array.isArray(value.credits) ? value.credits.flatMap((credit) => {
    const expiresAt = typeof credit?.expires_at === "string" ? credit.expires_at.trim().slice(0, 100) : "";
    if (!expiresAt || (cached && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now)) return [];
    return [{ expiresAt }];
  }) : [];
  const availableCount = cached ? Math.min(count, credits.length) : count;
  // Like Sub2API, an expired or incomplete positive snapshot means unknown,
  // while an explicitly reported zero is a valid count.
  if (cached && count > 0 && availableCount === 0) return null;
  return { availableCount, credits };
}
