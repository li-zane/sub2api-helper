import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOG_TAIL_BYTES = 80_000;
const directory = job => path.dirname(job.outputPath);

// Password/TOTP history is immutable, including pending and cleared values.
// Web/cookie/OAuth views are derived from their current canonical files.
const transientTypes = new Set(["web_session", "web_login", "codex_oauth", "cookie", "cookies", "credentials"]);

export async function recordCredentialHistory(root, event, { key } = {}) {
  if (transientTypes.has(event.type)) return null;
  const dir = path.join(root, "credential-history");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Stable event keys make acceptance notifications/restarts idempotent.
  const digest = key && crypto.createHash("sha256").update(key).digest("hex");
  const id = digest ? `0-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}` : `${Date.now()}-${crypto.randomUUID()}`;
  if (key) {
    try { return JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const record = { version: 1, id, at: new Date().toISOString(), ...event };
  await writePrivateJsonAtomic(path.join(dir, `${id}.json`), record);
  return record;
}

export async function readCredentialHistory(root) {
  const dir = path.join(root, "credential-history"), current = [];
  // Cleanup follows a usable canonical commit. A missing/corrupt file must not
  // destroy the only remaining recovery snapshot during migration.
  for (const [file, type] of [["web-session.json", "web_session"], ["sub2api-import-oauth.json", "codex_oauth"]]) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
      if (type === "web_session" && (!value.cookies?.length || value.validation?.status === "expired")) continue;
      if (type === "codex_oauth" && !value.accounts?.some(account => account.credentials?.access_token || account.credentials?.refresh_token)) continue;
      current.push({ version: 1, id: `current-${type}`, type, stage: "current", at: value.updatedAt || value.exported_at || null,
        email: value.email, after: value });
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  }
  const available = new Set(current.map(record => record.type));
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code === "ENOENT") names = []; else throw error; }
  const records = [];
  for (const name of names.filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort()) {
    const file = path.join(dir, name);
    let event;
    try { event = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) continue; throw error; }
    if (transientTypes.has(event.type)) {
      const category = event.type === "codex_oauth" ? "codex_oauth" : "web_session";
      if (available.has(category) && (event.type !== "credentials" || available.size === 2)) {
        await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    } else records.push(event);
  }
  return [...records, ...current];
}

export async function writePrivateJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    await fs.chmod(file, 0o600);
    if (process.platform !== "win32") {
      const dir = await fs.open(path.dirname(file), "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

export function hydrateAccountLog(job) {
  if (job.logHydrated || job.deleted) return;
  const file = path.join(directory(job), "account.log"), initial = job.logs || "";
  sync.mkdirSync(directory(job), { recursive: true, mode: 0o700 });
  let tail = "";
  try {
    const fd = sync.openSync(file, "r");
    try {
      const size = sync.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
      sync.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      tail = buffer.toString("utf8");
    } finally { sync.closeSync(fd); }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  sync.appendFileSync(file, initial, { mode: 0o600 });
  job.logs = (tail + initial).slice(-LOG_TAIL_BYTES);
  job.logHydrated = true;
}

export function appendAccountLog(job, text) {
  if (job.deleted || !text) return;
  hydrateAccountLog(job);
  sync.appendFileSync(path.join(directory(job), "account.log"), text, { mode: 0o600 });
  job.logs = (job.logs + text).slice(-LOG_TAIL_BYTES);
}

// Store UTC instants, not a server-local wall clock. A line split across child
// output chunks receives one timestamp; the UI chooses the display timezone.
export function appendTimestampedAccountLog(job, text, now = new Date()) {
  if (job.deleted || !text) return;
  hydrateAccountLog(job);
  let start = job.logTimestampAtLineStart ?? (!job.logs || job.logs.endsWith("\n"));
  let stamped = "";
  for (const part of String(text).match(/[^\n]*\n|[^\n]+$/g) || []) {
    stamped += (start && part.trim() ? `[${now.toISOString()}] ` : "") + part;
    start = part.endsWith("\n");
  }
  job.logTimestampAtLineStart = start;
  appendAccountLog(job, stamped);
}

export async function readAccountLog(job, { full = false, credentials = false } = {}) {
  hydrateAccountLog(job);
  const file = await fs.open(path.join(directory(job), "account.log"), "r");
  let text, totalBytes;
  try {
    totalBytes = (await file.stat()).size;
    const bytes = full ? totalBytes : Math.min(totalBytes, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(bytes);
    await file.read(buffer, 0, bytes, totalBytes - bytes);
    text = buffer.toString("utf8");
  } finally { await file.close(); }
  if (credentials) {
    const events = await readCredentialHistory(directory(job));
    text += "\n=== 凭据历史（原始/候选新值；以 stage 区分准备与已提交） ===\n";
    text += events.map(event => JSON.stringify(event, null, 2)).join("\n");
  }
  return { logs: text, totalBytes, truncated: !full && totalBytes > LOG_TAIL_BYTES };
}
