import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Initial estimates from CI logs. Actual durations are retained as artifacts so
// unusually slow tests can be identified without reducing test coverage.
const estimates = new Map(Object.entries({
  "test/console-session-reset-smoke.mjs": 55,
  "test/password-mfa-workspace-smoke.mjs": 28,
  "test/static-frontend.mjs": 22,
  "test/console-reset-credit-auto-smoke.mjs": 22,
  "test/fingerprint-transcripts.mjs": 18,
  "test/console-sms-deadline-smoke.mjs": 18,
  "test/console-login-timeout-smoke.mjs": 14,
  "test/console-smoke.mjs": 14,
  "test/console-restore-shutdown-smoke.mjs": 14,
  "test/sms-provider-console-smoke.mjs": 14,
  "test/production-console-smoke.mjs": 10,
}));

export function expandChecks(scripts, name = "check", stack = []) {
  if (!Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") throw Error(`Missing npm script: ${name}`);
  if (stack.includes(name)) throw Error(`Recursive npm script: ${[...stack, name].join(" -> ")}`);
  const commands = [];
  for (const command of scripts[name].split(/\s*&&\s*/)) {
    const tokens = command.trim().split(/\s+/);
    if (tokens.some(token => !/^[\w./:=+-]+$/.test(token))) throw Error(`Unsupported shell syntax in ${name}: ${command}`);
    if (tokens[0] === "npm" && tokens[1] === "run" && tokens.length === 3) {
      commands.push(...expandChecks(scripts, tokens[2], [...stack, name]));
    } else if (tokens[0] === "node" && tokens.length > 1) {
      commands.push({ command: tokens.join(" "), args: tokens.slice(1) });
    } else throw Error(`Unsupported check command in ${name}: ${command}`);
  }
  return commands.map((entry, index) => ({ ...entry, index }));
}

export function estimatedSeconds(entry) {
  if (entry.args[0] === "--check") return 0.1;
  return estimates.get(entry.args[0]) ?? (entry.args[0].startsWith("test/console-") ? 5 : 0.5);
}

export function partitionChecks(entries, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw Error("Shard count must be an integer from 1 to 32");
  const groups = Array.from({ length: count }, () => ({ seconds: 0, entries: [] }));
  const ordered = [...entries].sort((a, b) => estimatedSeconds(b) - estimatedSeconds(a) || a.index - b.index);
  for (const entry of ordered) {
    const group = groups.reduce((best, candidate) => candidate.seconds < best.seconds ? candidate : best);
    group.entries.push(entry); group.seconds += estimatedSeconds(entry);
  }
  // Preserve the original order within a runner. Each test owns its temporary
  // fixtures; separate Actions jobs also isolate ports, processes and files.
  return groups.map(group => group.entries.sort((a, b) => a.index - b.index));
}

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value || "");
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || index > count || count > 32)
    throw Error("Pass --shard INDEX/COUNT, for example --shard 1/4");
  return { index, count };
}

export async function runChecks(entries, { cwd = root, env = process.env, stdio = "inherit", log = console.log } = {}) {
  const results = [], started = performance.now();
  for (const entry of entries) {
    const group = env.GITHUB_ACTIONS === "true";
    log(`${group ? "::group::" : "RUN "}[${results.length + 1}/${entries.length}] ${entry.command}`);
    const began = performance.now();
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, entry.args, { cwd, env, stdio, windowsHide: true });
      child.once("error", error => resolve({ exitCode: 1, error: error.message }));
      child.once("exit", (code, signal) => resolve({ exitCode: code ?? 1, ...(signal ? { signal } : {}) }));
    });
    results.push({ index: entry.index, command: entry.command, durationMs: Math.round(performance.now() - began), ...result });
    log(`${result.exitCode === 0 ? "PASS" : "FAIL"} ${(results.at(-1).durationMs / 1000).toFixed(2)}s ${entry.command}`);
    if (group) log("::endgroup::");
    if (result.exitCode !== 0) break;
  }
  return { results, durationMs: Math.round(performance.now() - started), exitCode: results.find(result => result.exitCode !== 0)?.exitCode ?? 0 };
}

async function main(args) {
  let shard, timings, list = false;
  while (args.length) {
    const option = args.shift();
    if (option === "--shard") shard = parseShard(args.shift());
    else if (option === "--timings") { timings = args.shift(); if (!timings) throw Error("Missing timings path"); }
    else if (option === "--list") list = true;
    else throw Error(`Unknown argument: ${option}`);
  }
  if (!shard) throw Error("Missing --shard INDEX/COUNT");
  const { scripts } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const all = expandChecks(scripts), groups = partitionChecks(all, shard.count), entries = groups[shard.index - 1];
  const plan = { shard, totalCommands: all.length, selectedCommands: entries.length,
    estimatedSeconds: Math.round(entries.reduce((sum, entry) => sum + estimatedSeconds(entry), 0)) };
  if (list) { console.log(JSON.stringify({ ...plan, entries }, null, 2)); return; }
  console.log(`CHECK_PLAN ${JSON.stringify(plan)}`);
  const run = await runChecks(entries);
  const report = { schema: 1, platform: process.platform, node: process.version, ...plan, ...run };
  if (timings) {
    await fs.mkdir(path.dirname(path.resolve(timings)), { recursive: true });
    await fs.writeFile(timings, JSON.stringify(report, null, 2) + "\n");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const slowest = [...run.results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### Tests ${shard.index}/${shard.count} (${process.platform})\n\n${run.results.length}/${entries.length} commands executed; ${(run.durationMs / 1000).toFixed(1)} seconds; exit ${run.exitCode}.\n\n| Command | Seconds | Exit |\n| --- | ---: | ---: |\n`
      + slowest.map(result => `| \`${result.command}\` | ${(result.durationMs / 1000).toFixed(2)} | ${result.exitCode} |`).join("\n") + "\n");
  }
  console.log(`CHECK_SHARD_${run.exitCode === 0 ? "PASS" : "FAIL"} shard=${shard.index}/${shard.count} executed=${run.results.length}/${entries.length} total=${all.length} seconds=${(run.durationMs / 1000).toFixed(2)}`);
  process.exitCode = run.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
