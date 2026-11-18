import assert from "node:assert/strict";
import { createJobListService } from "../src/job-list-service.mjs";

const events = [], jobs = [{ email: "a@example.test", loginEmail: "a@example.test", status: "completed" }];
const cached = { marker: "cached" }, loaded = { marker: "loaded" }, invalidated = { marker: "invalidated" };
let state = cached, expected = loaded, fail = false;
const service = createJobListService({
  syncCompletedOutputs: async () => events.push("outputs"), getCachedPoolState: () => { events.push("cached"); return state; },
  loadPoolState: async () => { events.push("loaded"); if (fail) throw Error("pool down"); return loaded; }, listJobs: () => { events.push("list"); return jobs; },
  ensureSubscriptionHistoryFresh: async () => events.push("history"), inspectWebSession: async () => { events.push("inspect"); state = invalidated; }, pageSize: 10,
  webSessionChecks: () => 0, readRow: (job, pool) => { assert.equal(pool, expected); events.push(`read:${pool.marker}`); return { job, pool, planType: "free", health: "normal", active: false, blocked: false }; },
  isCheckingSession: () => false, matchesMonitoring: (row, selected, pool) => { assert.equal(pool, expected); assert.equal(row.pool, expected); events.push(`match:${pool.marker}`); return true; },
  toSelection: ({ job }) => ({ id: job.email }), toDetail: ({ job, pool }, selection, snapshot) => { assert.equal(pool, expected); assert.equal(snapshot, expected); events.push(`detail:${pool.marker}`); return { id: job.email }; }, historyStats: () => ({}), taskSettings: () => ({})
});
const filters = { search: "", lockedOnly: false, webSession: "", accountType: "", status: "", planType: "", sub2apiPool: "", sub2apiEnabled: "", overload: "", fingerprint: "", summary: "" };
const result = await service({ requestedPage: 1, filters: { ...filters, fingerprint: "match" } });
assert.equal(result.pagination.total, 1); assert(events.includes("read:loaded") && events.includes("match:loaded") && events.includes("detail:loaded") && !events.includes("read:invalidated"));
assert(events.indexOf("loaded") < events.indexOf("inspect"));
fail = true;
events.length = 0;
await assert.rejects(() => service({ requestedPage: 1, filters: { ...filters, sub2apiPool: "added" } }), /pool down/);
await assert.rejects(() => service({ requestedPage: 1, filters: { ...filters, sub2apiEnabled: "enabled" } }), /pool down/);
assert(!events.includes("list"));
state = cached; expected = cached; events.length = 0;
const normal = await service({ requestedPage: 1, filters: { ...filters, fingerprint: "match" } });
assert.equal(normal.pagination.total, 1); assert(events.includes("read:cached") && events.includes("match:cached") && events.includes("detail:cached"));
console.log("JOB_LIST_SERVICE_PASS loaded-snapshot stability; inspect invalidation isolation; pool-filter failures; cached normal path; call ordering");
