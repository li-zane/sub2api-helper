import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
await fs.access(npxCli);
const listener = http.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const session = `ui-regression-${process.pid}`;
const fixture = spawn(process.execPath, ["test/ui-fixture-server.mjs"], {
  cwd: root, windowsHide: true, env: { ...process.env, UI_TEST_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"],
});
let logs = "";
fixture.stdout.on("data", chunk => { logs += chunk; });
fixture.stderr.on("data", chunk => { logs += chunk; });
const exited = new Promise(resolve => fixture.once("exit", resolve));
// Invoke the same documented CLI as the manual workflow, not @playwright/test.
const cli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npxCli, "--no-install", "--package", "@playwright/cli", "playwright-cli", `-s=${session}`, ...args], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
});
try {
  let ready = false;
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    try { ready = (await fetch(base + "/api/bootstrap")).ok; if (ready) break; } catch {}
    if (fixture.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`UI fixture did not start\n${logs}`);
  await cli(["open", base]);
  await cli(["snapshot"]);
  const output = await cli(["run-code", "--filename", process.env.UI_TEST_SCRIPT || (process.argv.includes("--recent-operation") ? "test/recent-operation.browser.js" : "test/ui-regressions.browser.js"), "--raw"]);
  const line = output.split(/\r?\n/).find(line => line.startsWith('{"passed":'));
  if (!line) throw new Error(output);
  const result = JSON.parse(line);
  for (const item of result.results) console.log(`${item.passed ? "PASS" : "FAIL"}: ${item.name}${item.error ? ` — ${item.error}` : ""}`);
  console.log(`UI_REGRESSIONS ${result.passed}/${result.total}`);
  process.exitCode = result.passed === result.total ? 0 : 1;
} finally {
  await cli(["close"]).catch(() => {});
  if (fixture.exitCode === null) {
    fixture.stdin.end("stop\n");
  }
  await exited;
}
