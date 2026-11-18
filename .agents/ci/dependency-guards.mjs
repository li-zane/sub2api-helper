import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
export const guardMessage = "HELPER_UNSUPPORTED_GLOB_REPEAT";
// Keep upstream package identities intact. Remove this temporary mitigation once
// an upstream release closes the advisory and its regression tests pass.
export const guardedFiles = new Map([
  ["node_modules/picomatch/lib/parse.js", "73211a8ba85ce257b827abd8960e52c9750385b3fd18e8ef1080b114d774eb23"],
  ["node_modules/rollup/dist/shared/rollup.js", "1902c14fd9a87196900a5c8cdf24c1ae3a9602111a5c02e78aa1c79c9b32f109"],
  ["node_modules/rollup/dist/shared/index.js", "dec42cf28e47e7ee7f7ecd4d78c5fad3927a10cf902c1f3ce7504c43e681d62f"],
  ["node_modules/rollup/dist/es/shared/node-entry.js", "955a6d21d0b1c2c2c44b068ba1195560d8b347d3f6d09acf1d1ad12dd598555b"],
  ["node_modules/rollup/dist/es/shared/watch.js", "9ea890daeff1a5a2bd334e0d9c879144195e3cd2c6a2213f8ad09723e1ae9dbb"],
]);
const replacements = [
  ["const extglobOpen = (type, value) => {", `if (type === 'plus' || type === 'star') throw new SyntaxError('${guardMessage}');`],
  ["if (value === '(') {", `if (prev.type !== 'at' || prev.extglob !== true) throw new SyntaxError('${guardMessage}');`],
  ["if ((prev && (prev.type === 'bracket' || prev.type === 'paren' || prev.type === 'brace')) || state.parens > 0) {", `throw new SyntaxError('${guardMessage}');`],
  ["if (prev && (prev.type === 'bracket' || prev.type === 'paren') && opts.regex === true) {", `throw new SyntaxError('${guardMessage}');`],
];
const hash = value => createHash("sha256").update(value).digest("hex");

export function patchSource(source) {
  for (const [needle, guard] of replacements) {
    const lines = source.split("\n");
    const matches = lines.flatMap((line, index) => line.trim() === needle ? [index] : []);
    if (matches.length < 1 || matches.length > 2) throw Error(`Unexpected parser boundary: ${needle}`);
    for (const index of matches.reverse()) {
      const indent = lines[index].match(/^\s*/)[0];
      const cr = lines[index].endsWith("\r") ? "\r" : "";
      lines.splice(index + 1, 0, `${indent}  ${guard}${cr}`);
    }
    source = lines.join("\n");
  }
  return source;
}

export async function checkGuards({ apply = false, cwd = root } = {}) {
  const lock = JSON.parse(await fs.readFile(path.join(cwd, "package-lock.json"), "utf8"));
  for (const [name, version] of [["picomatch", "4.0.5"], ["rollup", "4.62.4"]]) {
    const copies = Object.entries(lock.packages).filter(([key]) => key.endsWith(`node_modules/${name}`));
    if (copies.length !== 1 || copies[0][0] !== `node_modules/${name}` || copies[0][1].version !== version)
      throw Error(`Review dependency mitigation for changed ${name} installation`);
    const installed = JSON.parse(await fs.readFile(path.join(cwd, "node_modules", name, "package.json"), "utf8"));
    if (installed.name !== name || installed.version !== version) throw Error(`Unexpected installed ${name}`);
  }
  // Validate every original before writing any file. A changed package or a
  // missing/partial/tampered guard fails installation and the audit gate.
  const pending = [];
  for (const [name, originalHash] of guardedFiles) {
    const file = path.join(cwd, name), source = await fs.readFile(file, "utf8");
    const original = source.split(/(?<=\n)/).filter(line => !line.includes(guardMessage)).join("");
    if (hash(original) !== originalHash) throw Error(`Unrecognized dependency source: ${name}`);
    const patched = patchSource(original);
    if (source !== patched) {
      if (!apply || source !== original) throw Error(`Dependency guard missing or changed: ${name}`);
      pending.push([file, patched]);
    }
  }
  for (const [file, source] of pending) await fs.writeFile(file, source);
  return guardedFiles.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkGuards({ apply: process.argv.includes("--apply") })
    .then(count => console.log(`DEPENDENCY_GUARDS_PASS files=${count}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
