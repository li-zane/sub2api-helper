import fs from "node:fs/promises";
import path from "node:path";
import { historicalSubscriptionEvidence, isSubscribedPlan } from "./subscription-history.mjs";

export function createSubscriptionHistorySync({
  history, listJobs, readCredentialHistory, getPlanType, isAccountBlocked,
  getUserCost, accountEmail, files = fs,
}) {
  const backfill = new Map(), backfillVersions = new Map(), exportCache = new Map();
  let pending, dirty = false;

  async function readEvidence(job, email) {
    const evidence = historicalSubscriptionEvidence(await readCredentialHistory(path.dirname(job.outputPath)));
    if (evidence) backfill.set(email, evidence);
    return evidence;
  }

  async function observe(job) {
    const email = job.email.toLowerCase(), planType = getPlanType(job);
    let evidence = backfill.get(email);
    let historicalPlanType = [job.planType, job.planAutomationPlanType, evidence?.planType].find(isSubscribedPlan);
    if (!isSubscribedPlan(planType) && !historicalPlanType && !history.has(email)) {
      const historyRoot = path.dirname(job.outputPath);
      try {
        const stat = await files.stat(path.join(historyRoot, "credential-history"));
        if (backfillVersions.get(historyRoot) !== stat.mtimeMs) {
          evidence = await readEvidence(job, email);
          backfillVersions.set(historyRoot, stat.mtimeMs);
          historicalPlanType = evidence?.planType;
        }
      } catch { /* A failed history read is not evidence of a subscription. */ }
    }
    if (!isSubscribedPlan(planType) && !historicalPlanType && !history.has(email)) return null;
    const credentials = { mailApiUrl: job.mailApiUrl || "", mailRequestBody: job.mailRequestBody || "" };
    // A locked/unavailable secure store is not a successful credential clear.
    if (job.password || !job.hasPasswordCredential) credentials.password = job.password || "";
    if (job.totpSecret || !job.hasTotpCredential) credentials.totpSecret = job.totpSecret || "";
    try {
      const stat = await files.stat(job.outputPath), key = `${stat.mtimeMs}:${stat.size}`;
      let cached = exportCache.get(job.outputPath);
      if (cached?.key !== key) {
        const value = JSON.parse(await files.readFile(job.outputPath, "utf8"));
        const accounts = value.type === "sub2api-data" && value.accounts?.filter(account => accountEmail(account) === email);
        if (accounts?.length && accounts.some(account => account.credentials?.access_token || account.credentials?.refresh_token)) {
          cached = { key, json: JSON.stringify({ ...value, accounts }, null, 2) };
          exportCache.set(job.outputPath, cached);
        }
      }
      if (cached?.json) credentials.sub2apiJson = cached.json;
    } catch { /* Keep the last committed snapshot across temporary file/read failures. */ }
    return { email, loginEmail: job.loginEmail, accountAddedAt:job.createdAt, planType, historicalPlanType, firstSubscribedAt: evidence?.at,
      accountBanned: isAccountBlocked(email), remark: job.remark || "", accountCostCny: job.accountCostCny,
      userCostUsd: getUserCost(job), credentials };
  }

  function ensureFresh() {
    if (pending) return pending;
    // Each idle read checks disk again. Only changes can extend an in-flight scan.
    pending = Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          const current = listJobs().filter(job => !job.deleted);
          const observations = await Promise.all(current.map(observe));
          await history.reconcile(observations.filter(Boolean), current.map(job => job.email));
        } while (dirty);
      } finally {
        pending = undefined;
      }
    });
    return pending;
  }

  return {
    ensureFresh,
    invalidate: () => { dirty = true; },
    waitForIdle: () => pending,
    backfillJob: job => readEvidence(job, job.email.toLowerCase()),
    forgetExport: outputPath => exportCache.delete(outputPath),
  };
}
