import { existsSync, readFileSync } from "node:fs";

// A root-owned marker is live only while the exact installer process lives.
// PID + kernel start ticks survive service restarts, not PID reuse or reboot
// (/run is volatile). No account or scheduler settings are ever rewritten.
export const releaseMarker = "/run/tosub2-release-drain";
export function releaseDispatchPaused({ marker = releaseMarker, read = readFileSync, exists = existsSync } = {}) {
  if (!exists(marker)) return false;
  try {
    const owner = read(marker, "utf8").trim().match(/^([1-9]\d*) (\d+)$/);
    if (!owner) return true; // inconsistent marker: do not admit new work
    const stat = read("/proc/" + owner[1] + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] === owner[2];
  } catch (e) {
    return e.code !== "ENOENT" && e.code !== "ESRCH";
  }
}

export function drainRequestKind(method, pathname) {
  if (["GET", "HEAD", "OPTIONS"].includes(method) || method === "POST" && pathname === "/api/jobs/query") return "read";
  if (method === "POST" && /^\/api\/jobs\/[a-f0-9-]+\/(input|cancel)$/.test(pathname)) return "finish";
  return "new";
}
