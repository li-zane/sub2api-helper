// Run from the repository root: node test/bench/frontend-poll.mjs
// Pass a module exporting reconcilePolledJobs to compare another implementation.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { reconcilePolledJobs } = await import(process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2]))
  : new URL("../../web/src/job-list-poll.mjs", import.meta.url));

const selection = Array.from({ length: 1000 }, (_, i) => ({
  id: String(i), email: `row-${i}@example.test`, status: "completed",
  planType: i % 2 ? "free" : "plus", remark: "", groups: [1, 2],
  accountCostCny: i % 7, accountCostUpdatedAt: i % 3 ? null : "2026-10-01T00:00:00Z",
}));
const page = selection.slice(0, 20).map(row => ({
  ...row, usage: { tokens: 1000, windows: [{ used: 1 }, { used: 2 }] },
  history: Array.from({ length: 12 }, (_, i) => ({ n: i, status: "completed" })),
}));
const clone = value => JSON.parse(JSON.stringify(value));
const noop = { page: clone(page), selection: clone(selection) };
const edit = clone(noop);
edit.page[7].remark = edit.selection[7].remark = "edited";
const reorder = { page: clone(page).reverse(), selection: clone(selection).reverse() };
const rounds = 9, iterations = 30;
console.log(`page=20 selection=1000 samples=${rounds} polls/sample=${iterations}; median ms/poll (merge only)`);
for (const [name, data] of Object.entries({ unchanged: noop, oneEdit: edit, reversed: reorder })) {
  const run = () => [reconcilePolledJobs(page, data.page), reconcilePolledJobs(selection, data.selection)];
  const [rows, index] = run();
  assert.deepEqual(rows, data.page);
  assert.deepEqual(index, data.selection);
  assert.equal(index[name === "reversed" ? 999 : 0], selection[0]);
  if (name === "unchanged") { assert.equal(rows, page); assert.equal(index, selection); }
  for (let i = 0; i < iterations; i++) run();
  const timings = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    for (let j = 0; j < iterations; j++) run();
    timings.push((performance.now() - start) / iterations);
  }
  console.log(`${name}=${timings.sort((a, b) => a - b)[Math.floor(rounds / 2)].toFixed(3)}`);
}
