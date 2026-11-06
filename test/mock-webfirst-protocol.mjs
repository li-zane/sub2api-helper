import fs from "node:fs/promises";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { readAccountWebSession, writeAccountWebSession } from "../src/account-web-session.mjs";
import { writePrivateJsonAtomic } from "../src/account-history.mjs";
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const email = arg("--email"), web = process.argv.includes("--web-only"), replacing = process.argv.includes("--replace-password");
await fs.appendFile(process.env.WEBFIRST_TRACE, JSON.stringify({ email, mode: replacing ? "password" : web ? "web" : "oauth", passwordLength: replacing ? process.env.CHATGPT_NEW_PASSWORD.length : null }) + "\n");
if (replacing) {
  const result = { version: 1, email, operation: "replace_password", stage: "confirmed", password: process.env.CHATGPT_NEW_PASSWORD,
    previous_password: process.env.CHATGPT_LOGIN_PASSWORD, activation_succeeded: true, confirmation_succeeded: true, added_at: new Date().toISOString() };
  await writePrivateJsonAtomic(arg("--password-add-result"), result);
  console.log("[ok] Account password changed and saved securely");
} else if (web) {
  if (email.startsWith("banned-")) { console.error("[error] Your account has been deactivated. account_deactivated"); process.exitCode = 1; }
  else {
    const identity = await getAccountBrowserIdentity(email), planType = email.startsWith("team-") ? "team" : "free";
    const token = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
    await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, { email, identity, accessToken: token,
      validation: { status: "valid", verifiedAt: new Date().toISOString() }, web: { planType, workspaceId: "personal" },
      cookies: [{ name: "fixture-email", value: encodeURIComponent(email), domain: "127.0.0.1", path: "/", hostOnly: true }] });
    console.log(`[ok] Saved web session: ${process.env.TOSUB2_WEB_SESSION_PATH}`);
  }
} else {
  const saved = process.env.WEBFIRST_BASELINE === "1" ? { email, web: { planType: "free" } } : await readAccountWebSession({ email, webSessionPath: process.env.TOSUB2_WEB_SESSION_PATH });
  if (saved.email !== email) throw Error("missing original Web session");
  await fs.writeFile(arg("--sub2api-out"), JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, access_token: "fixture-OAuth", refresh_token: "fixture-refresh", plan_type: saved.web.planType } }] }));
  console.log(`[ok] Saved sub2api import: ${arg("--sub2api-out")}`);
}
