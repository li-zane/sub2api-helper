import { buildJobListRequest } from "./job-list-filters.mjs";
import { preserveNewerAccountCost } from "./account-pricing.mjs";
import { shareJobList, shareSnapshot } from "./polling-snapshot.mjs";

function reconcileJob(previous, next) {
  return shareSnapshot(previous, preserveNewerAccountCost(previous, next));
}

export function reconcilePolledJobs(previous, next) {
  return shareJobList(previous, next, reconcileJob);
}

export function refreshOpenJob(current, rows) {
  if (!current) return current;
  const row = rows.find(job => job.id === current.id);
  return row ? shareSnapshot(current, row) : current;
}

// The next tick is scheduled only after settlement. Disposing a filter/page
// generation aborts its request and discards even a late successful response.
export function startJobListPoll(query, { request, onData, onError, intervalMs }) {
  const { url, options } = buildJobListRequest(query);
  const controller = new AbortController();
  let timer;
  async function poll() {
    try {
      const data = await request(url, { ...options, signal: controller.signal });
      if (!controller.signal.aborted) onData(data);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(poll, intervalMs);
    }
  }
  void poll();
  return () => { controller.abort(); clearTimeout(timer); };
}
