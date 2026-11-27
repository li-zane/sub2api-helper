import { OverloadCooldown } from "./overload-cooldown.mjs";
import { degradationCooldownApplies } from "../shared/degradation-cooldown-settings.mjs";

// Reuse durable pause ownership, partial-write recovery and deadline scheduling.
// Detection policy stays separate from overload counters and never logs out.
export class DegradationCooldown extends OverloadCooldown {
  constructor({ getRule, getValidity, canStart = () => true, sharedLock, ...options }) {
    super({ ...options, retryBlocked: true,
      isBlocked: email => { const config = options.getConfig(); return !config?.baseUrl || !config?.adminApiKey || options.isBlocked?.(email); },
      getSettings: () => ({ windowMinutes: 15, threshold: 1, cooldownMinutes: getRule().cooldownMinutes }) });
    Object.assign(this, { getRule, getValidity, canStart });
    if (sharedLock) this.lock = sharedLock;
  }

  snapshot(email) {
    const entry = this.accounts.get(String(email).toLowerCase());
    return { paused: this.isPaused(email), phase: entry?.phase || "idle", coolingUntil: entry?.coolingUntil || null,
      startedAt: entry?.operation?.startedAt || null, cooldownMinutes: entry?.cooldownMinutes || null,
      validity: entry?.validity || null, lastError: entry?.lastError || null };
  }

  ownsPoolPause(id, config) {
    const backend = this.backendIdentity(config);
    return [...this.accounts.values()].some(entry => entry.backend === backend && entry.resumeAccountIds?.includes(String(id)));
  }

  async observeVerdict(email, round) {
    email = email.toLowerCase();
    if (round?.status !== "mismatch" || !round.id) return;
    try {
      await this.lock(email, async () => {
        const config = this.getConfig(), backend = this.backendIdentity(config);
        const previous = this.accounts.get(email);
        const eligible = () => !this.stopped && !this.dispatchPaused() && !this.isBlocked(email) && this.canStart(email)
          && degradationCooldownApplies(this.getRule(), this.getValidity(email))
          && backend === this.backendIdentity(this.getConfig()) && round.backend === backend;
        if (!eligible() || previous?.resumeAccountIds?.length || previous?.lastRoundId === round.id) return;
        const mapping = await this.listAccounts(config);
        if (!eligible()) return;
        const rule = this.getRule(), validity = this.getValidity(email);
        const records = (mapping.get(email) || []).filter(record => record.enabled === true && record.canCount !== false);
        const targets = [...new Set(records.map(record => String(record.id)))].filter(id => /^\d+$/.test(id));
        if (!targets.length) return;
        const startedAt = new Date(this.now()).toISOString();
        const until = new Date(this.now() + rule.cooldownMinutes * 60_000).toISOString();
        await this.update(email, { enabled: true, backend, validity, lastRoundId: round.id, phase: "pausing",
          resumeAccountIds: targets, coolingUntil: until, cooldownMinutes: rule.cooldownMinutes, lastError: null,
          operation: { id: round.id, startedAt, until, cooldownMinutes: rule.cooldownMinutes, finishedAt: null } });
        await this.pause(email, config, records);
      });
    } catch (error) {
      await this.lock(email, () => this.update(email, { lastError: String(error.message).slice(0, 300) }));
    } finally { this.trigger(); }
  }

  // Called inside the shared scheduling lock, before a manual pool write.
  async manualOverrideLocked(email, ids) {
    email = email.toLowerCase();
    const entry = this.accounts.get(email);
    if (!entry || entry.backend !== this.backendIdentity(this.getConfig())) return;
    const removed = new Set(ids.map(String));
    const remaining = (entry.resumeAccountIds || []).filter(id => !removed.has(id));
    await this.update(email, { resumeAccountIds: remaining, ...(remaining.length ? {} : { phase: "idle", coolingUntil: null }), lastError: null });
    this.onChange();
  }
}
