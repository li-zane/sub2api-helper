import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hydrateAccountLog, readCredentialHistory } from "./account-history.mjs";

const labels = {
  initial_authorization: "首次授权", initial_web_login: "首次 Web 登录", web_login: "Web 登录",
  web_session_check: "Web 会话检测", reauthorize: "Codex 重新授权", relogin: "重新登录并授权",
  replace_2fa: "轮换 2FA", setup_2fa: "设置 2FA", replace_password: "轮换密码", add_password: "添加密码",
  account_update: "更新账号", resume: "继续授权", retry: "重试授权", upload: "上传到 Sub2API",
  automatic_relogin: "自动重新登录并授权", cooldown: "账号冷却", workspace_switch: "切换工作空间",
  credential_update: "更新本地凭据", proxy_update: "更新账号代理", logout_all: "登出所有设备",
};
const root = job => path.dirname(job.outputPath);
const indexFile = (job, id) => path.join(root(job), "operation-logs", `${id}.json`);
const terminal = status => ["completed", "failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(status);
function save(job, entry) {
  const file = indexFile(job, entry.id);
  sync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  sync.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
  sync.renameSync(temporary, file);
}
export function beginAccountLogOperation(job, type, at = new Date().toISOString()) {
  hydrateAccountLog(job);
  if (job.logOperation) finishAccountLogOperation(job, job.logOperation, terminal(job.status) ? "completed" : "interrupted");
  const entry = { id: crypto.randomUUID(), type, label: labels[type] || type, at,
    start: sync.statSync(path.join(root(job), "account.log")).size, end: null, status: "running" };
  save(job, entry); job.logOperation = entry;
  return entry;
}
export function finishAccountLogOperation(job, entry = job.logOperation, status = "completed") {
  if (!entry) return;
  if (entry.end === null) entry.end = sync.statSync(path.join(root(job), "account.log")).size;
  entry.status = status; entry.finishedAt ||= new Date().toISOString();
  save(job, entry);
  if (job.logOperation?.id === entry.id) job.logOperation = null;
}

export async function readAccountLogEntries(job, { view = "protocol", entryId = null } = {}) {
  if (!["protocol", "credentials"].includes(view)) throw Object.assign(new Error("不支持的日志分类"), { status: 400 });
  if (view === "credentials") {
    const history = await readCredentialHistory(root(job));
    if (job.password) history.push({ id: "current-password", type: "password", stage: "current", at: job.passwordAddedAt || job.createdAt,
      after: { password: job.password, localRecord: true, remoteEnabled: job.securityState?.passwordEnabled ?? null } });
    if (job.totpSecret) history.push({ id: "current-2fa", type: "2fa", stage: "current", at: job.createdAt,
      after: { totpSecret: job.totpSecret, localRecord: true, remoteEnabled: job.securityState?.totpEnabled ?? null } });
    const names = { password: "密码", "2fa": "2FA", web_session: "当前 Web 会话 / Cookie", codex_oauth: "当前 Codex OAuth" };
    const entries = history.map(event => ({ id: event.id, type: event.type, at: event.at, stage: event.stage,
      label: `${names[event.type] || event.type} · ${event.stage === "current" ? "当前版本" : event.stage || "历史"}` }));
    const selected = entryId ? history.find(event => event.id === entryId) : null;
    if (entryId && !selected) throw Object.assign(new Error("该记录已更新，请刷新列表"), { status: 404 });
    return { view, entries: entries.reverse(), selectedId: selected?.id || null,
      content: selected ? JSON.stringify(selected, null, 2) : "", retention: "密码与 2FA 历史永久保留，候选不代表生效；Web / Cookie / OAuth 仅当前版本" };
  }
  hydrateAccountLog(job);
  let entries = [];
  try {
    for (const name of await fs.readdir(path.join(root(job), "operation-logs"))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try { entries.push(JSON.parse(await fs.readFile(path.join(root(job), "operation-logs", name), "utf8"))); } catch {}
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  entries.sort((a, b) => a.start - b.start || String(a.at).localeCompare(String(b.at)));
  const size = (await fs.stat(path.join(root(job), "account.log"))).size;
  // An open disk record without a live owner was interrupted by a restart.
  // Stop it at the next operation boundary, not at the end of newer tasks.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.end === null && entry.id !== job.logOperation?.id) {
      entry.end = entries[i + 1]?.start ?? size;
      entry.status = "interrupted"; entry.finishedAt ||= new Date().toISOString(); save(job, entry);
    }
  }
  const legacyEnd = entries[0]?.start ?? size;
  if (legacyEnd > 0) entries.unshift({ id: "legacy", type: "legacy", label: "历史协议日志（未分组）", at: job.createdAt, start: 0, end: legacyEnd, status: "completed" });
  const grouped = [];
  let cursor = 0;
  for (const entry of entries) {
    if (entry.start > cursor) grouped.push({ id: `background-${cursor}`, type: "background", label: "后台同步 / 补充日志", at: null, start: cursor, end: entry.start, status: "completed" });
    grouped.push(entry); cursor = Math.max(cursor, entry.end ?? size);
  }
  if (cursor < size) grouped.push({ id: `background-${cursor}`, type: "background", label: "后台同步 / 补充日志", at: null, start: cursor, end: size, status: "completed" });
  entries = grouped;
  const selected = entryId ? entries.find(entry => entry.id === entryId) : null;
  if (entryId && !selected) throw Object.assign(new Error("日志记录不存在"), { status: 404 });
  let content = "";
  if (selected) {
    const start = Math.max(0, Math.min(size, selected.start));
    const end = Math.max(start, Math.min(size, selected.end ?? size));
    const handle = await fs.open(path.join(root(job), "account.log"), "r");
    try { const buffer = Buffer.alloc(end - start); await handle.read(buffer, 0, buffer.length, start); content = buffer.toString("utf8"); }
    finally { await handle.close(); }
  }
  return { view, entries: entries.reverse().map(({ start, end, ...entry }) => entry), selectedId: selected?.id || null,
    content, retention: "任务协议日志保留至删除账号" };
}
