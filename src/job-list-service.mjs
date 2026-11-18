import { projectJobList } from "./job-list-query.mjs";

export function createJobListService(deps) {
  return async function queryJobs({ requestedPage, emails = null, filters }) {
    await deps.syncCompletedOutputs();
    let poolState = deps.getCachedPoolState();
    try {
      poolState = await deps.loadPoolState();
    } catch (error) {
      if (filters.sub2apiPool || filters.sub2apiEnabled) throw error;
    }
    const allJobs = deps.listJobs();
    await deps.ensureSubscriptionHistoryFresh();
    await Promise.all(allJobs.map(deps.inspectWebSession));
    const result = projectJobList(allJobs, {
      filters, emails, requestedPage, pageSize: deps.pageSize, webSessionChecks: deps.webSessionChecks(),
    }, {
      readRow: job => deps.readRow(job, poolState),
      isCheckingSession: deps.isCheckingSession,
      matchesMonitoring: (row, selected) => deps.matchesMonitoring(row, selected, poolState),
      toSelection: deps.toSelection,
      toDetail: (row, selection) => deps.toDetail(row, selection, poolState),
    });
    return { ...result, stats: { ...result.stats, ...deps.historyStats() }, taskSettings: deps.taskSettings() };
  };
}
