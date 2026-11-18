import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { root, advisory, checkGuards, guardedFiles, guardMessage } from "../.agents/ci/dependency-guards.mjs";
import { assessAudit } from "../.agents/ci/audit-dependencies.mjs";

const require = createRequire(import.meta.url), pm = require("picomatch");
await checkGuards();

// Verify the guard at pattern compilation using small, ordinary expressions.
const blocked = ["+(docs)", "*(logs)", "**/+(src).js", "{+(src),lib}", "!(+(docs))", "(docs)", "@(docs)+"];
const options = [{}, { fastpaths: false }, { windows: true }, { capture: true }, { maxExtglobRecursion: false }];
const reject = fn => assert.throws(fn, error => error instanceof SyntaxError && error.message === guardMessage);
for (const pattern of blocked) for (const opts of options) {
  reject(() => pm.makeRe(pattern, opts));
  reject(() => pm.parse(pattern, opts));
}
reject(() => pm.makeRe("@(docs)*", { regex: true }));
reject(() => pm.makeRe("(docs)", { noextglob: true }));
reject(() => pm(["src/**", "+(docs)"]));
reject(() => pm("src/**", { ignore: "+(docs)" }));
const controls = [
  ["**/*.{js,jsx,ts,tsx}", "web/src/main.jsx", true],
  ["**/*.{js,jsx,ts,tsx}", "web/src/styles.css", false],
  ["**/!(*.d).ts", "src/file.ts", true], ["**/!(*.d).ts", "src/file.d.ts", false],
  ["@(a|b)", "a", true], ["?(ab)", "ab", true], ["!(abc)", "def", true],
  ["[()]", "(", true], ['"+(docs)"', "+(docs)", true], [String.raw`\+\(docs\)`, "+(docs)", true],
  ["**/node_modules/**", "node_modules/react/index.js", true], ["**/.env*", "src/.env.local", true],
];
for (const [pattern, input, expected] of controls) assert.equal(pm(pattern)(input), expected, pattern);

// Exercise the actual parser bodies in every bundled CJS/ESM copy, including
// both watcher versions. Use Picomatch's same constants/utils dependencies;
// full Vite/Rollup loading is also covered by build/static frontend checks.
let parserCount = 1;
const constants = require("picomatch/lib/constants"), utils = require("picomatch/lib/utils");
for (const [name] of guardedFiles) {
  if (name.includes("/picomatch/")) continue;
  const source = await fs.readFile(path.join(root, name), "utf8");
  for (const match of source.matchAll(/function requireParse(?:\$\d+)?\s*\(\)\s*\{([\s\S]*?)\n\}/g)) {
    if (!match[1].includes("const extglobOpen = ")) continue;
    const body = match[1].replace(/^[\s\S]*?const utils =[^\n]*\n/, "")
      .replace(/parse_1(?:\$\d+)? = parse;\s*return parse_1(?:\$\d+)?;/, "return parse;");
    const parse = new Function("constants", "utils", body)(constants, utils);
    for (const pattern of blocked) for (const opts of options) reject(() => parse(pattern, opts));
    reject(() => parse("@(docs)*", { regex: true }));
    for (const [pattern, input, expected] of controls) {
      const state = parse(pattern, { fastpaths: false });
      assert.equal(pm.compileRe(state).test(input), expected, `${name}: ${pattern}`);
    }
    parserCount++;
  }
}
assert.equal(parserCount, 7);

const report = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } }, vulnerabilities: {
  picomatch: { severity: "high", nodes: ["node_modules/picomatch"], via: [{ name: "picomatch", severity: "high", url: advisory }] },
  vite: { severity: "high", nodes: ["node_modules/vite"], via: ["picomatch"] },
} };
assert.deepEqual(assessAudit(report), ["picomatch", "vite"]);
for (const mutate of [r => { r.vulnerabilities.picomatch.via[0].url += "-other"; },
  r => { r.vulnerabilities.picomatch.via.push({ name: "picomatch", severity: "high", url: "other" }); },
  r => { r.vulnerabilities.vite.via.push("missing"); }, r => { r.vulnerabilities.picomatch.nodes.push("node_modules/other/node_modules/picomatch"); },
  r => { r.vulnerabilities.vite.via = ["vite"]; }, r => { r.error = { code: "ENETWORK" }; },
  r => { r.vulnerabilities.vite.severity = "critical"; r.metadata.vulnerabilities.high--; r.metadata.vulnerabilities.critical++; },
  r => { r.vulnerabilities.other = { severity: "high", nodes: ["node_modules/other"], via: ["picomatch"] }; r.metadata.vulnerabilities.high++; r.metadata.vulnerabilities.total++; },
  r => { r.vulnerabilities = {}; }, r => { r.metadata.vulnerabilities = {}; },
  r => { r.vulnerabilities.vite.via = [null]; }]) {
  const changed = structuredClone(report); mutate(changed); assert.throws(() => assessAudit(changed));
}
assert.deepEqual(assessAudit({ ...report, metadata: { vulnerabilities: {
  info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0,
} }, vulnerabilities: {} }), []);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-guard-test-"));
try {
  for (const file of ["package-lock.json", "node_modules/picomatch/package.json", "node_modules/rollup/package.json", ...guardedFiles.keys()]) {
    const dest = path.join(temp, file); await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(root, file), dest);
  }
  const target = path.join(temp, [...guardedFiles.keys()][0]);
  const good = await fs.readFile(target, "utf8");
  await fs.writeFile(target, good.replace("type === 'plus'", "type === 'never'"));
  await assert.rejects(checkGuards({ cwd: temp }));
  await fs.writeFile(target, good.split(/(?<=\n)/).filter(line => !line.includes(guardMessage)).join(""));
  await assert.rejects(checkGuards({ cwd: temp }));
  await checkGuards({ cwd: temp, apply: true });
  assert.equal(await fs.readFile(target, "utf8"), good);
  const lock = JSON.parse(await fs.readFile(path.join(temp, "package-lock.json"), "utf8"));
  lock.packages["node_modules/vite/node_modules/picomatch"] = { version: "4.0.5" };
  await fs.writeFile(path.join(temp, "package-lock.json"), JSON.stringify(lock));
  await assert.rejects(checkGuards({ cwd: temp, apply: true }));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
console.log("DEPENDENCY_GUARDS_TEST_PASS parsers=7; extglob/raw repeats rejected; ordinary globs preserved; hash/copy/audit checks fail closed");
