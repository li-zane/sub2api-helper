import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { validateAccountBrowserIdentity } from "./account-browser-identity.mjs";
import { webTokenWorkspaceId } from "./workspace-accounts.mjs";
import { recordCredentialHistory, writePrivateJsonAtomic } from "./account-history.mjs";

export function webSessionPathForJob(job) {
  if (!job?.outputPath && !job?.webSessionPath) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 缺少账号会话目录");
  return job.webSessionPath || path.join(path.dirname(job.outputPath), "web-session.json");
}

export async function readAccountWebSession(job) {
  job.webSessionReadError = null;
  job.webSessionContext = null;
  let session;
  try { session = JSON.parse(await fs.readFile(webSessionPathForJob(job), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      job.webSessionReadError = /^(?:EACCES|EPERM|EIO)$/.test(error.code || "") ? error.code : "READ_FAILED";
      setWebSessionState(job, "unavailable");
      throw error;
    }
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
  job.webSessionContext = {
    workspaceId: session.web?.workspaceId || null,
    tokenWorkspaceId: webTokenWorkspaceId(session.accessToken) || null,
    tokenPlanType: tokenPlanType(session.accessToken),
    reason: session.validation?.reason || null,
  };
  const verified = Date.parse(session.validation?.verifiedAt);
  setWebSessionState(job, session.validation?.status === "expired" ? "expired"
    : Number.isFinite(verified) && Date.now() - verified < 15 * 60_000 ? "valid" : "saved", session.validation?.verifiedAt);
  return session;
}

const sessionWrites = new Map();
export async function writeAccountWebSession(file, session, { expectedHash } = {}) {
  const key = path.resolve(file), next = structuredClone(session);
  const pending = (sessionWrites.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    let previous = null;
    let previousBytes = null;
    try { previousBytes = await fs.readFile(file); previous = JSON.parse(previousBytes.toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) previous = { invalidJson: await fs.readFile(file, "utf8") };
      else if (error.code !== "ENOENT") throw error;
    }
    const currentHash = previousBytes ? crypto.createHash("sha256").update(previousBytes).digest("hex") : null;
    if (expectedHash !== undefined && currentHash !== expectedHash) throw new Error("WEB_SESSION_UPDATE_CONFLICT: 原会话已被其他成功刷新更新，已保留当前会话及候选历史，请重新检测");
    const material = value => JSON.stringify([value?.cookies, value?.accessToken, value?.expiresAt, value?.web?.workspaceId]);
    if (material(previous) !== material(next)) {
      await recordCredentialHistory(path.dirname(file), { type: "web_session", stage: "prepared", email: next.email,
        file: path.basename(file), before: previous, after: next });
    }
    await writePrivateJsonAtomic(file, { ...next, version: 1, updatedAt: new Date().toISOString() });
  });
  sessionWrites.set(key, pending);
  try { await pending; }
  finally { if (sessionWrites.get(key) === pending) sessionWrites.delete(key); }
}

// Only a display label and stable pool ID cross into session metadata. Never
// persist a proxy URL, authentication fields or a guessed historical binding.
export function normalizeHelperLoginProxy(value) {
  if (!value || !["proxy", "direct"].includes(value.kind)) return null;
  const name = value.kind === "direct" ? "直连" : String(value.name || "").trim();
  if (!name || name.length > 160 || /[\x00-\x1f\x7f]/.test(name) || /[a-z][a-z0-9+.-]*:\/\//i.test(name)) return null;
  const proxyId = /^\d+$/.test(String(value.proxyId || "")) ? String(value.proxyId) : null;
  const recordedAt = typeof value.recordedAt === "string" && Number.isFinite(Date.parse(value.recordedAt)) ? value.recordedAt : null;
  return { kind: value.kind, name, proxyId: value.kind === "direct" ? null : proxyId, recordedAt };
}

export function attachHelperLoginProxies(devices, session) {
  const key = device => device.sessionId ? `session:${device.sessionId}` : device.deviceIdHash ? `trusted:${device.deviceIdHash}` : null;
  const signature = device => Number(device.lastSignedInTimestamp) || null;
  const saved = new Map();
  for (const item of Array.isArray(session.helperDeviceProxies) ? session.helperDeviceProxies.slice(-500) : []) {
    if (!item || typeof item !== "object") continue;
    const proxy = normalizeHelperLoginProxy(item.proxy);
    if (typeof item.key === "string" && item.key.length <= 300 && proxy) saved.set(item.key, { key: item.key, signedInAt: Number(item.signedInAt) || null, proxy });
  }
  const current = devices.filter(device => device.isCurrentDevice);
  const proxy = normalizeHelperLoginProxy(session.web?.helperLoginProxy);
  // A unique current row is identified by the authenticated cookie jar itself.
  // Display names, OS, location and the job's current pool binding are not IDs.
  if (proxy && current.length === 1 && key(current[0])) saved.set(key(current[0]), { key: key(current[0]), signedInAt: signature(current[0]), proxy });
  const retained = [];
  const result = devices.map(device => {
    const entry = saved.get(key(device));
    if (!entry || entry.signedInAt !== signature(device)) return device;
    retained.push(entry);
    return { ...device, helperLoginProxy: entry.proxy };
  });
  session.helperDeviceProxies = retained.slice(-500);
  return result;
}

export async function saveProtocolWebSession(file, client, web, credentials = {}) {
  if (!client.browserIdentity) return;
  let helperDeviceProxies = [];
  let previousCredentials = {};
  try {
    const previous = JSON.parse(await fs.readFile(file, "utf8"));
    if (previous.email === client.browserIdentity.email && previous.identity?.deviceId === client.browserIdentity.deviceId) {
      helperDeviceProxies = Array.isArray(previous.helperDeviceProxies) ? previous.helperDeviceProxies.slice(-500) : [];
      if (previous.web?.workspaceId === web?.workspaceId) previousCredentials = previous;
    }
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const helperLoginProxy = normalizeHelperLoginProxy(web?.helperLoginProxy);
  const storedWeb = { ...web };
  delete storedWeb.helperLoginProxy;
  if (helperLoginProxy) storedWeb.helperLoginProxy = helperLoginProxy;
  await writeAccountWebSession(file, {
    email: client.browserIdentity.email, identity: client.browserIdentity,
    cookies: client.jar.toJSON(), web: storedWeb, helperDeviceProxies,
    ...(credentials.accessToken ? { validation: { status: "valid", verifiedAt: new Date().toISOString() } }
      : previousCredentials.validation ? { validation: previousCredentials.validation } : {}),
    accessToken: credentials.accessToken || previousCredentials.accessToken || null,
    expiresAt: credentials.expiresAt || previousCredentials.expiresAt || null,
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
  job.authorizationContext = null;
  if (job.resultSaved && job.outputPath) {
    try {
      const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
      const account = data.accounts?.[0], credentials = account?.credentials || {};
      job.authorizationContext = {
        workspaceId: webTokenWorkspaceId(credentials.access_token) || credentials.chatgpt_account_id || credentials.account_id || account?.extra?.chatgpt_account_id || null,
        planType: tokenPlanType(credentials.access_token) || credentials.plan_type || account?.extra?.plan_type || null,
      };
    } catch { /* A missing export must not hide the Web session's own status. */ }
  }
}

function tokenPlanType(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    const plan = String(value?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "").trim().toLowerCase();
    return /^[a-z0-9_-]{1,64}$/.test(plan) ? plan : null;
  } catch { return null; }
}

// Local evidence only: token claims describe their issued context, not whether
// that workspace is still usable. Live checks remain the monitor's job.
export function publicWebCredentialSync(job, planType, { blocked = false } = {}) {
  const context = job.webSessionContext;
  const result = { status: "unverified", reason: null, webPlanType: context?.tokenPlanType || null, planType: planType || null };
  const state = (status, reason) => ({ ...result, status, reason });
  if (blocked) return state("blocked", "account_banned");
  if (job.webSessionReadError) return state("read_failed", job.webSessionReadError);
  if (job.webLoginPreviousState) return state("refreshing", null);
  if (job.webSessionStatus === "absent") return state("absent", null);
  if (job.webSessionStatus === "expired") return state("pending_update", context?.reason || "session_expired");
  if (!context) return result;
  if (context.workspaceId && context.tokenWorkspaceId && context.workspaceId !== context.tokenWorkspaceId) return state("pending_update", "workspace_mismatch");
  const authorized = job.authorizationContext;
  if (job.webSessionStatus === "valid" && context.tokenWorkspaceId && authorized?.workspaceId && context.tokenWorkspaceId !== authorized.workspaceId) return state("authorization_pending", "workspace_changed");
  if (job.webSessionStatus === "valid" && authorized?.planType && context.tokenPlanType && authorized.planType !== context.tokenPlanType) return state("authorization_pending", "plan_changed");
  if (context.tokenPlanType && planType && context.tokenPlanType !== planType) return state("pending_update", "plan_mismatch");
  if (job.resultSaved && !authorized?.workspaceId) return result;
  if (job.webSessionStatus === "valid" && context.tokenWorkspaceId && context.tokenPlanType) return state("synced", null);
  return result;
}
