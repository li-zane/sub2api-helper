import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { advisory, checkGuards, root } from "./dependency-guards.mjs";

const severities = ["info", "low", "moderate", "high", "critical"];
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function assessAudit(report) {
  const counts = report?.metadata?.vulnerabilities;
  const entries = report?.vulnerabilities;
  if (report?.auditReportVersion !== 2 || report.error || !isRecord(counts) || !isRecord(entries))
    throw Error("npm audit did not return a complete report");

  const reported = Object.values(entries);
  if (reported.some(item => !isRecord(item) || !severities.includes(item.severity)
    || !Array.isArray(item.nodes) || !item.nodes.length || !Array.isArray(item.via) || !item.via.length)
    || counts.total !== reported.length
    || severities.some(severity => counts[severity] !== reported.filter(item => item.severity === severity).length))
    throw Error("npm audit returned inconsistent vulnerability data");

  const allowed = new Set(["picomatch", "fdir", "tinyglobby", "vite"]);
  const mitigated = (name, seen = new Set()) => {
    const item = entries[name];
    if (!allowed.has(name) || !item || item.severity !== "high" || seen.has(name) || !item.via?.length
      || item.nodes?.length !== 1 || item.nodes[0] !== `node_modules/${name}`) return false;
    return item.via.every(via => typeof via === "string"
      ? mitigated(via, new Set([...seen, name]))
      : isRecord(via) && name === "picomatch" && via.name === "picomatch" && via.url === advisory && via.severity === "high"
        && item.nodes?.length === 1 && item.nodes[0] === "node_modules/picomatch");
  };
  const blocked = Object.entries(entries).filter(([name, item]) =>
    ["high", "critical"].includes(item.severity) && !mitigated(name)).map(([name]) => name);
  if (blocked.length) throw Error(`Unmitigated dependency advisories: ${blocked.join(", ")}`);
  return Object.keys(entries).filter(name => mitigated(name));
}

async function main() {
  await checkGuards();
  if (!process.env.npm_execpath) throw Error("Run through npm run audit:dependencies");
  const audit = spawnSync(process.execPath, [process.env.npm_execpath, "audit", "--json", "--audit-level=high"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (audit.error || ![0, 1].includes(audit.status)) throw Error(`npm audit failed: ${audit.error?.message || audit.stderr || audit.status}`);
  const report = JSON.parse(audit.stdout);
  // Print upstream's unaltered result, including the advisory. The only local
  // exception requires exact hashes for all guarded standalone/bundled parsers.
  console.log(audit.stdout.trim());
  const mitigated = assessAudit(report);
  const { high, critical } = report.metadata.vulnerabilities;
  if ((audit.status === 1) !== (high + critical > 0)) throw Error("npm audit exit status disagrees with the report");
  console.log(`DEPENDENCY_AUDIT_PASS upstream_exit=${audit.status} locally_mitigated=${mitigated.join(",") || "none"} guards=5`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
