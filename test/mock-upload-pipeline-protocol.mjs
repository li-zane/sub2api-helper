import fs from "node:fs/promises";
import path from "node:path";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
const arg = flag => process.argv[process.argv.indexOf(flag) + 1], email = arg("--email");
if (process.argv.includes("--replace-totp")) {
  const file = arg("--totp-result"); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, email, operation: "replace_totp", stage: "confirmed", activation_succeeded: true,
    confirmation_succeeded: true, remote_disabled: false, secret: "MZXW6YTBON2GK3TB", otpauth_uri: "otpauth://totp/fixture?secret=MZXW6YTBON2GK3TB" }));
  console.log("[ok] 2FA replacement activated");
} else {
  const file = arg("--sub2api-out"), identity = await getAccountBrowserIdentity(email);
  const accessToken = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, { email, identity, accessToken,
    validation: { status: "valid", verifiedAt: new Date().toISOString() }, web: {},
    cookies: [{ name: "session", value: "pipeline-fixture", domain: "127.0.0.1", path: "/", hostOnly: true }] });
  console.log(`[ok] Saved web session: ${process.env.TOSUB2_WEB_SESSION_PATH}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: "sub2api-data", accounts: [{ name: "oauth---" + email, platform: "openai", type: "oauth",
    credentials: { email, access_token: "fixture-Codex-token", refresh_token: "fixture-refresh", plan_type: "free" }, extra: { email, plan_type: "free" } }] }));
  console.log(`[ok] Saved sub2api import: ${file}`);
}
