import assert from "node:assert/strict";
import { buildJobListRequest, jobFilterOptions } from "../web/src/job-list-filters.mjs";
import { reconcilePolledJobs, refreshOpenJob, startJobListPoll } from "../web/src/job-list-poll.mjs";

const query = { page: 2, emails: [], search: "  A & B  ", lockedOnly: true, status: "", summary: "normal", fingerprint: "match" };
const { url, options } = buildJobListRequest(query);
const get = new URL(url, "http://localhost");
assert.equal(get.pathname, "/api/jobs"); assert.deepEqual(options, {});
assert.deepEqual(Object.fromEntries(get.searchParams), { page: "2", search: "A & B", lockedOnly: "true", summary: "normal", fingerprint: "match" });
const emails = ["example@example.test"];
const post = buildJobListRequest({ ...query, emails });
assert.equal(post.url, "/api/jobs/query"); assert.equal(post.options.method, "POST");
assert.deepEqual(JSON.parse(post.options.body), { page: 2, emails, search: "A & B", lockedOnly: true, summary: "normal", fingerprint: "match" });
assert.equal(buildJobListRequest({ page: 1, emails: [], search: " ", lockedOnly: false }).url, "/api/jobs?page=1");
assert.deepEqual(jobFilterOptions({ planTypes: ["custom"], planTypeUnknown: true, statuses: ["bad", "constructor", "completed"],
  sub2apiPools: ["new", "added"], sub2apiEnabled: "disabled" }), {
  planTypeOptions: ["custom"], planTypeUnknown: true, statusOptions: ["completed"], sub2apiPoolOptions: ["added"], sub2apiEnabledOptions: [],
});

const original = [
  { id: "a", accountCostCny: 8, accountCostUpdatedAt: "2026-11-10T00:00:00Z", usage: { n: 1 } },
  { id: "b", accountCostCny: 0, accountCostUpdatedAt: null, usage: { n: 2 } },
];
const stale = { ...structuredClone(original[0]), accountCostCny: 0, accountCostUpdatedAt: null };
assert.equal(reconcilePolledJobs(original, [stale, structuredClone(original[1])]), original);
const other = { ...stale, id: "c" };
const polled = reconcilePolledJobs(original, [original[1], other, { ...stale, remark: "new" }]);
assert.equal(polled[0], original[1]); assert.equal(polled[1], other);
assert.equal(polled[2].accountCostCny, 8); assert.equal(polled[2].remark, "new"); assert.equal(polled[2].usage, original[0].usage);
assert.equal(refreshOpenJob(null, []), null);
assert.equal(refreshOpenJob(original[0], [other]), original[0]);
assert.equal(refreshOpenJob(original[0], structuredClone(original)), original[0]);

// A blocked request never overlaps its successor. First reject, then retry.
// Even a request implementation that ignores abort cannot deliver stale data.
const calls = [], errors = [], data = [];
let pending, notifyRequest;
const nextRequest = () => new Promise(resolve => { notifyRequest = resolve; });
const request = (_url, { signal }) => new Promise((resolve, reject) => {
  calls.push(signal); pending = { resolve, reject }; notifyRequest?.();
});
const stop = startJobListPoll(query, { request, onData: value => data.push(value), onError: e => errors.push(e.message), intervalMs: 1 });
try {
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  let next = nextRequest(); pending.reject(Error("offline")); await next;
  assert.deepEqual(errors, ["offline"]);
  next = nextRequest(); pending.resolve("current"); await next;
  assert.deepEqual(data, ["current"]);
  stop(); assert(calls.at(-1).aborted); pending.resolve("obsolete");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(data, ["current"]); assert.equal(calls.length, 3);
} finally { stop(); }
console.log("JOB_LIST_POLL_PASS GET/POST filters; cost and row identity; non-overlap, retry, abort and stale-response isolation");
