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
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 尚未保存 Web 登录态，请为此账号重新登录一次");
  }
  if (session?.version !== 1 || !Array.isArray(session.cookies) || !session.cookies.length) {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: Web 登录态无效，请重新登录");
  }
  validateAccountBrowserIdentity(session.identity, job.email || session.email);
  if (session.email !== session.identity.email) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: Web 登录态与账号不匹配");
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
    cookies: client.jar.toJSON(), web, accessToken: credentials.accessToken || null, expiresAt: credentials.expiresAt || null,
  });
}
