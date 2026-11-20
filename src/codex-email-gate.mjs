import fs from "node:fs/promises";
import path from "node:path";

const oauthOperations = new Set(["initial_authorization", "reauthorize", "relogin", "automatic_relogin", "resume", "retry", "session_reset"]);

// One-time, read-only migration. A pool-sync failure or a Web login is not
// evidence about Codex. Use one indexed OAuth attempt, never adjacent tasks.
export async function legacyCodexEmailGate(dir) {
  const index = path.join(dir, "operation-logs");
  let names;
  try { names = await fs.readdir(index); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const entries = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
    const op = JSON.parse(await fs.readFile(path.join(index, name), "utf8"));
    if (oauthOperations.has(op.type) && Number.isSafeInteger(op.start) && Number.isFinite(Date.parse(op.at))) entries.push(op);
  }
  entries.sort((a,b) => b.start - a.start);
  for (const [i, op] of entries.entries()) {
    const at = op.finishedAt || op.at;
    if (op.status === "completed") return { required: false, at };
    if (op.status !== "failed" || !Number.isSafeInteger(op.end)) continue;
    const end = Math.min(op.end, entries[i - 1]?.start ?? op.end);
    const length = Math.min(64 * 1024, end - op.start);
    if (length <= 0) continue;
    const fd = await fs.open(path.join(dir, "account.log"), "r");
    try {
      const bytes = Buffer.alloc(length);
      const {bytesRead} = await fd.read(bytes, 0, length, end - length);
      const log = bytes.toString("utf8", 0, bytesRead);
      const stage = log.lastIndexOf("[codex-auth-login]");
      if (stage > log.lastIndexOf("[auth-expired]") &&
          /Email OTP \(r=resend, q=quit\):\s*\[login-timeout\]\s*LOGIN_TIMEOUT/.test(log.slice(stage)))
        return { required: true, at };
    } finally { await fd.close(); }
  }
  return null;
}
