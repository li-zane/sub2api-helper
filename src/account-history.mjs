import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LOG_TAIL_BYTES = 80_000;
const directory = job => path.dirname(job.outputPath);

// Credential history is immutable and durable before any remote mutation or
// replacement. It lives inside the account directory and is deleted with it.
export async function recordCredentialHistory(root, event) {
  const dir = path.join(root, "credential-history");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const record = { version: 1, id, at: new Date().toISOString(), ...event };
  await writePrivateJsonAtomic(path.join(dir, `${id}.json`), record);
  return record;
}

export async function readCredentialHistory(root) {
  const dir = path.join(root, "credential-history");
  let names;
  try { names = await fs.readdir(dir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const name of names.filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort()) {
    records.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
  }
  return records;
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
