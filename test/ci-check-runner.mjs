import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { expandChecks, partitionChecks, parseShard, runChecks } from "../.agents/ci/check-runner.mjs";

const expanded = expandChecks({ check: "npm run nested && node test/last.mjs --flag", nested: "node test/one.mjs && node test/one.mjs" });
assert.deepEqual(expanded.map(entry => entry.command), ["node test/one.mjs", "node test/one.mjs", "node test/last.mjs --flag"]);
assert.deepEqual(expanded.map(entry => entry.index), [0, 1, 2], "duplicate commands lost occurrence identities");
assert.deepEqual(expanded[2].args, ["test/last.mjs", "--flag"]);
for (const command of ["node test/a.mjs;echo bad", "node test/a.mjs | node test/b.mjs", "npm run nested --silent", "echo skipped"]) {
  assert.throws(() => expandChecks({ check: command, nested: "node test/a.mjs" }), /Unsupported/);
}
assert.throws(() => expandChecks({ check: "npm run missing" }), /Missing/);
assert.throws(() => expandChecks({ check: "npm run nested", nested: "npm run check" }), /Recursive/);
for (const value of ["0/4", "5/4", "1/0", "1/33", "1.5/4", "4", "1/4extra", ""]) assert.throws(() => parseShard(value));
assert.deepEqual(parseShard("2/4"), { index: 2, count: 4 });
const scripts = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).scripts;
const all = expandChecks(scripts), groups = partitionChecks(all, 4);
assert.deepEqual(groups, partitionChecks(all, 4), "plan must be stable across all OS runners");
assert.equal(groups.flat().length, all.length);
assert.deepEqual(groups.flat().map(entry => entry.index).sort((a, b) => a - b), all.map(entry => entry.index), "shards dropped or repeated tests");
assert(groups.every(group => group.length > 0));
for (const group of groups) assert.deepEqual(group.map(entry => entry.index), group.map(entry => entry.index).sort((a, b) => a - b));
assert.deepEqual(partitionChecks(all, 1)[0], all, "one shard must exactly preserve npm check order");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper CI runner "));
try {
  const trace = path.join(root, "trace.txt"), entries = [];
  for (const [index, exit] of [[0, 0], [1, 7], [2, 0]]) {
    const file = path.join(root, `step ${index}.mjs`);
    await fs.writeFile(file, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(trace)},'${index}\\n'); process.exit(${exit});`);
    entries.push({ index, command: `node step ${index}.mjs`, args: [file] });
  }
  const result = await runChecks(entries, { cwd: root, stdio: "ignore", log: () => {} });
  assert.equal(result.exitCode, 7, "child failure must fail the shard");
  assert.deepEqual(result.results.map(entry => entry.exitCode), [0, 7]);
  assert.equal(await fs.readFile(trace, "utf8"), "0\n1\n", "later commands ran after a failure");
  assert(result.results.every(entry => Number.isInteger(entry.durationMs) && entry.durationMs >= 0));
  const passed = await runChecks(entries.slice(0, 1), { cwd: root, stdio: "ignore", log: () => {} });
  assert.equal(passed.exitCode, 0);
  // Exercise the CLI boundary too: a failed child must produce timings and a
  // failed process exit, rather than accidentally allowing a runtime release.
  const runner = path.join(root, ".agents/ci/check-runner.mjs"), timings = path.join(root, "timings.json");
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.copyFile(new URL("../.agents/ci/check-runner.mjs", import.meta.url), runner);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { check: "node pass.mjs && node fail.mjs && node later.mjs" } }));
  await fs.writeFile(path.join(root, "pass.mjs"), "process.exit(0)");
  await fs.writeFile(path.join(root, "fail.mjs"), "process.exit(7)");
  await fs.writeFile(path.join(root, "later.mjs"), "throw Error('must never run')");
  const summary = path.join(root, "summary.md");
  const cliExit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--shard", "1/1", "--timings", timings], {
      cwd: root, env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, windowsHide: true, stdio: "ignore",
    });
    child.once("error", reject); child.once("exit", resolve);
  });
  assert.equal(cliExit, 7);
  const report = JSON.parse(await fs.readFile(timings, "utf8"));
  assert.equal(report.exitCode, 7); assert.equal(report.totalCommands, 3);
  assert.deepEqual(report.results.map(result => result.exitCode), [0, 7]);
  assert((await fs.readFile(summary, "utf8")).includes("2/3 commands executed"));
  console.log(`CI_RUNNER_PASS tests=${all.length} shards=4 nested_expansion=true complete_disjoint_deterministic=true original_order=true invalid_commands_rejected=true child_failure_propagated=true paths_with_spaces=true timings=true`);
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
