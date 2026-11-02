import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateAccountBrowserIdentity } from "./account-browser-identity.mjs";

export function webSessionPathForJob(job) {
  if (!job?.outputPath && !job?.webSessionPath) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 缺少账号会话目录");
  return job.webSessionPath || path.join(path.dirname(job.outputPath), "web-session.json");
}

export async function readAccountWebSession(job) {
  let session;
  try { session = JSON.parse(await fs.readFile(webSessionPathForJob(job), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    setWebSessionState(job, error.code === "ENOENT" ? "absent" : "expired");
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 尚未保存 Web 登录态，请为此账号重新登录一次");
  }
  if (session?.version !== 1 || !Array.isArray(session.cookies) || !session.cookies.length) {
    setWebSessionState(job, "expired");
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: Web 登录态无效，请重新登录");
  }
  try { validateAccountBrowserIdentity(session.identity, job.email || session.email); }
  catch (error) { setWebSessionState(job, "expired"); throw error; }
  if (session.email !== session.identity.email) { setWebSessionState(job, "expired"); throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: Web 登录态与账号不匹配"); }
  const verified = Date.parse(session.validation?.verifiedAt);
  setWebSessionState(job, session.validation?.status === "expired" ? "expired"
    : Number.isFinite(verified) && Date.now() - verified < 15 * 60_000 ? "valid" : "saved", session.validation?.verifiedAt);
  return session;
}

export async function writeAccountWebSession(file, session) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ ...session, version: 1, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function saveProtocolWebSession(file, client, web, credentials = {}) {
  if (!client.browserIdentity) return;
  await writeAccountWebSession(file, {
    email: client.browserIdentity.email, identity: client.browserIdentity,
    cookies: client.jar.toJSON(), web,
    ...(credentials.accessToken ? { validation: { status: "valid", verifiedAt: new Date().toISOString() } } : {}), accessToken: credentials.accessToken || null, expiresAt: credentials.expiresAt || null,
  });
}

export function setWebSessionState(job, status, verifiedAt = null) {
  job.webSessionStatus = status;
  job.webSessionAvailable = status === "saved" || status === "valid";
  job.webSessionVerifiedAt = verifiedAt || null;
}

// This probe reads local state only; it never sends a background login request.
export async function inspectAccountWebSession(job) {
  try { await readAccountWebSession(job); }
  catch { if (!job.webSessionStatus) setWebSessionState(job, "expired"); }
}
