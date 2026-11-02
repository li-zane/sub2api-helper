import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { browserIdentityForTlsProfile } from "./tls-transport.mjs";

export async function getAccountBrowserIdentity(email, options = {}) {
  const account = String(email || "").trim().toLowerCase();
  if (!account) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 缺少账号邮箱");
  const root = options.root || process.env.TOSUB2_BROWSER_IDENTITY_ROOT || path.resolve("tmp/browser-identities");
  const file = path.join(root, `${crypto.createHash("sha256").update(account).digest("hex")}.json`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try { return validate(JSON.parse(await fs.readFile(file, "utf8")), account); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const tlsProfile = options.profile && /^chrome\d+[a-z]?$/.test(options.profile) ? options.profile : "chrome142";
  const identity = {
    version: 1, email: account, deviceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), tlsProfile,
    browser: browserIdentityForTlsProfile(tlsProfile),
  };
  // Publish a complete file atomically; concurrent login processes share one winner.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try { await fs.link(temporary, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { await fs.unlink(temporary); }
  return validate(JSON.parse(await fs.readFile(file, "utf8")), account);
}

export function validateAccountBrowserIdentity(identity, email = identity?.email) {
  return validate(identity, String(email || "").trim().toLowerCase());
}

function validate(value, account) {
  if (value?.version !== 1 || value.email !== account || !/^[-a-f0-9]{36}$/i.test(value.deviceId || "")
    || !/^[-a-f0-9]{36}$/i.test(value.sessionId || "") || !/^chrome\d+[a-z]?$/.test(value.tlsProfile || "")
    || value.browser?.profile !== value.tlsProfile || !value.browser?.userAgent || !value.browser?.acceptLanguage) {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 账号浏览器身份文件无效，请检查持久化数据");
  }
  return value;
}
