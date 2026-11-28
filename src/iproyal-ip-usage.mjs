const DAY = 86_400_000;
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export function usageWindow(now) {
  return { from: date.format(now - 6 * DAY), to: date.format(now) };
}

export function usagePolicy(settings) {
  return JSON.stringify([settings.usageCooldownEnabled, settings.usageThreshold, settings.usageUnit, settings.usageCooldownMinutes]);
}

// Compare overlapping calendar-day counters so midnight never subtracts a day
// that fell out of the query window. Supplier revisions are a fresh baseline.
export function observeIpUsage(previous, sample, settings, now) {
  const policy = usagePolicy(settings);
  let baselineReason = !previous ? 'initial' : previous.policy !== policy ? 'settings'
    : now < previous.at || now - previous.at >= 6 * DAY ? 'gap' : null;
  let deltaMb = 0;
  if (!baselineReason) {
    for (const [day, amount] of Object.entries(sample.days)) {
      const before = previous.days[day];
      if (before !== undefined && amount < before) { baselineReason = 'reset'; break; }
      if (before === undefined && day <= previous.to) { baselineReason = 'gap'; break; }
      deltaMb += amount - (before ?? 0);
    }
  }
  deltaMb = baselineReason ? null : Math.round(deltaMb * 100) / 100;
  const thresholdMb = settings.usageThreshold * (settings.usageUnit === 'GB' ? 1000 : 1);
  let cooldownUntil = previous?.policy === policy ? previous.cooldownUntil || 0 : 0;
  let triggerMb = previous?.policy === policy ? previous.triggerMb ?? null : null;
  if (!settings.usageCooldownEnabled) cooldownUntil = 0;
  // A cooldown has a fixed deadline. New measurements continue updating the
  // baseline during it; an unchanged report cannot trigger it again on expiry.
  if (settings.usageCooldownEnabled && cooldownUntil <= now && deltaMb > thresholdMb) {
    cooldownUntil = now + settings.usageCooldownMinutes * 60000;
    triggerMb = deltaMb;
  }
  return { ...sample, policy, at: now, since: baselineReason ? null : previous.at,
    deltaMb, totalMb: Math.round(Object.values(sample.days).reduce((sum, n) => sum + n, 0) * 100) / 100,
    baselineReason, cooldownUntil, triggerMb, stale: false };
}
