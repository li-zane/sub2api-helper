import assert from "node:assert/strict";
import { JobStore } from "../src/job-store.mjs";
import { normalizeJobFilters, projectJobList } from "../src/job-list-query.mjs";

const store = new JobStore();
const old = { id: "old", email: "A@EXAMPLE.TEST", status: "completed" };
const latest = { id: "new", email: "a@example.test", status: "failed" };
store.set(old.id, old);
store.set(latest.id, latest);
const siblings = () => [...store.forAccount(" A@example.test ")];
assert.deepEqual(siblings(), [old, latest]);
old.status = "banned";
assert.equal(siblings()[0].status, "banned", "status must stay live, not captured at insertion");
const replacement = { ...old, status: "canceled" };
store.set(old.id, replacement);
assert.deepEqual(siblings(), [replacement, latest], "replacing an ID must not duplicate it");
store.set(old.id, { ...replacement, email: "b@example.test" });
assert.deepEqual(siblings(), [latest]);
assert.deepEqual([...store.forAccount("b@example.test")], [store.get(old.id)]);
assert.equal(store.delete(latest.id), true);
assert.deepEqual(siblings(), []);
assert.equal(store.delete(latest.id), false);
assert.equal(store.has(old.id), true);
assert.deepEqual([...store.values()], [store.get(old.id)]);

const rows = [
  { id: "a", status: "completed", planType: "team", pool: { inPool: true, enabled: false, remoteStatus: "error", planType: "old" }, health: "abnormal" },
  { id: "b", status: "working", planType: "free", pool: { inPool: false, enabled: null }, health: "pending", active: true, poolOnly: true },
  { id: "c", status: "queued", planType: null, pool: { inPool: null, enabled: null }, health: "pending" },
  { id: "d", status: "banned", planType: null, pool: { inPool: true, enabled: true }, health: "abnormal", blocked: true },
  { id: "e", status: "completed", planType: "team", pool: { inPool: true, enabled: true }, health: "normal", loginMode: "password", hasTotpCredential: true },
].map(row => ({ ...row, email: row.id + "@internal.test", loginEmail: row.id + "@example.test" }));
const globalOptions = {
  statuses: ["queued", "working", "completed", "banned"], planTypes: ["free", "team"], planTypeUnknown: true,
  sub2apiPools: ["error", "not_added", "unknown", "added"], sub2apiEnabled: ["disabled", "unknown", "enabled"],
};
const stats = { normal: 1, abnormal: 2, pending: 2, active: 2, webSessionChecks: 1, queued: 1, completed: 2 };
function run(source, filters = {}, page = 1, emails = null) {
  const visits = [], details = [], selected = [], monitored = [];
  const result = projectJobList(source, { filters: normalizeJobFilters(filters), emails, requestedPage: page, pageSize: 2,
    webSessionChecks: source.length ? 1 : 0 }, {
    readRow: job => { visits.push(job.id); return { job, ...job }; },
    isCheckingSession: job => job.id === "e",
    matchesMonitoring: ({ job }) => { monitored.push(job.id); return job.id === "e"; },
    toSelection: ({ job }) => { selected.push(job.id); return { id: job.id }; },
    toDetail: ({ job }, common) => { assert.equal(job.id, common.id); details.push(job.id); return { ...common, email: job.loginEmail }; },
  });
  assert.deepEqual(visits, source.map(job => job.id), "read each row exactly once");
  assert.deepEqual(details, result.jobs.map(j => j.id));
  assert.deepEqual(selected, result.selection.map(j => j.id));
  if (source === rows) { assert.deepEqual(result.stats, stats); assert.deepEqual(result.filterOptions, globalOptions); }
  return { ...result, monitored };
}
const empty = run([], {}, 99);
assert.deepEqual(empty.pagination, { page: 1, pageSize: 2, total: 0, totalPages: 1, totalAll: 0 });
assert.deepEqual(empty.filterOptions, { statuses: [], planTypes: [], planTypeUnknown: false, sub2apiPools: [], sub2apiEnabled: [] });
assert.equal(empty.filter.active, false);
assert.deepEqual(empty.jobs, []); assert.deepEqual(empty.selection, []);
const end = run(rows, {}, 999);
assert.deepEqual(end.pagination, { page: 3, pageSize: 2, total: 5, totalPages: 3, totalAll: 5 });
assert.deepEqual(end.selection.map(j => j.id), ["a", "b", "c", "d", "e"]);
assert.deepEqual(end.jobs.map(j => j.id), ["e"]); assert.deepEqual(end.monitored, []);
assert.deepEqual(run(rows, {}, 2).jobs.map(j => j.id), ["c", "d"], "later matches must not displace the requested page");
for (const [f, ids] of [
  [{ summary: "active" }, ["b", "e"]], [{ summary: "queued" }, ["c"]], [{ summary: "abnormal" }, ["a", "d"]],
  [{ planType: "__unknown__", sub2apiEnabled: "unknown" }, ["c"]],
  [{ search: "OLD", status: " COMPLETED " }, ["a"]], [{ lockedOnly: "true", webSession: "banned" }, ["d"]],
  [{ accountType: "pool_only", sub2apiPool: "not_added" }, ["b"]],
  [{ accountType: "password_totp", search: "TEAM" }, ["e"]],
  [{ search: "does not exist" }, []],
]) {
  const page = run(rows, f);
  assert.deepEqual(page.selection.map(j => j.id), ids); assert.equal(page.filter.active, true);
}
const combined = run(rows, { fingerprint: "match", planType: "team", search: "EXAMPLE" }, 9, ["b@example.test", "e@example.test"]);
assert.deepEqual(combined.selection, [{ id: "e" }]);
assert.deepEqual(combined.monitored, ["e"], "invoke expensive filters only after email and ordinary predicates");
assert.deepEqual([combined.filter.requested, combined.filter.matched, combined.filter.search], [2, 1, "EXAMPLE"]);
assert.equal(run(rows, {}, 1, ["a@internal.test"]).pagination.total, 0, "exact match is against current login email");
assert.equal(run(rows, { fingerprint: "bogus", status: "bogus", search: " " }).filter.active, false);
console.log("JOB_LIST_QUERY_PASS live account index, single row projection, global stats/options, filters, pagination and cross-page selection");
