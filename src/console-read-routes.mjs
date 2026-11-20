import { normalizeJobFilters } from "./job-list-query.mjs";

const SUBSCRIPTION_RECORD = /^\/api\/subscription-history\/([a-f0-9]{32})\/credentials$/;
const JOB_FILTER_PARAMS = [
  "search", "lockedOnly", "accountType", "status", "planType", "sub2apiPool",
  "sub2apiEnabled", "overload", "fingerprint", "webSession", "summary",
];

function pageNumber(value) {
  return Math.max(1, Number.parseInt(value || "1", 10) || 1);
}

// The caller authenticates once before invoking this dispatcher. A false
// return leaves unrelated methods and routes to the existing API handler.
export function createConsoleReadRoutes({
  readJson, sendJson, httpError, queryJobs, normalizeEmailFilter,
  syncCompletedOutputs, ensureSubscriptionHistoryFresh, subscriptionHistory,
  getPriceMultiplier, qualityFor, maxBatchJobs,
}) {
  return async function handleReadRoute(req, res, url) {
    const { pathname, searchParams } = url;
    const { method } = req;
    if (method === "GET" && pathname === "/api/jobs") {
      const filters = normalizeJobFilters(Object.fromEntries(
        JOB_FILTER_PARAMS.map(key => [key, searchParams.get(key)]),
      ));
      sendJson(res, 200, await queryJobs({ requestedPage: pageNumber(searchParams.get("page")), filters }));
      return true;
    }

    if (method === "POST" && pathname === "/api/jobs/query") {
      const body = await readJson(req);
      sendJson(res, 200, await queryJobs({
        requestedPage: pageNumber(body.page), emails: normalizeEmailFilter(body.emails),
        filters: normalizeJobFilters(body),
      }));
      return true;
    }

    if (method === "GET" && pathname === "/api/subscription-history") {
      await syncCompletedOutputs();
      await ensureSubscriptionHistoryFresh();
      const records = subscriptionHistory.list(getPriceMultiplier(),qualityFor);
      sendJson(res, 200, { records, total: records.length });
      return true;
    }

    if (method === "POST" && pathname === "/api/subscription-history/seen") {
      const changes = (await readJson(req))?.changes;
      if (!Array.isArray(changes) || changes.length > maxBatchJobs || changes.some(change =>
        typeof change?.id !== "string" || !/^[a-f0-9]{32}$/.test(change.id) || !Number.isSafeInteger(change.revision) || change.revision < 1)) {
        throw httpError(400, "历史订阅变化标记无效");
      }
      await syncCompletedOutputs();
      await ensureSubscriptionHistoryFresh();
      const acknowledged = await subscriptionHistory.markSeen(changes);
      sendJson(res, 200, { acknowledged });
      return true;
    }

    const subscriptionRecord = method === "GET" && SUBSCRIPTION_RECORD.exec(pathname);
    if (subscriptionRecord) {
      await syncCompletedOutputs();
      await ensureSubscriptionHistoryFresh();
      const value = subscriptionHistory.credentials(subscriptionRecord[1]);
      if (value === null) throw httpError(404, "历史订阅账号不存在");
      if (!value) throw httpError(409, "该账号尚无可复制的凭据");
      sendJson(res, 200, { text: value });
      return true;
    }

    return false;
  };
}
