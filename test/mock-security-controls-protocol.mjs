import fs from "node:fs/promises";
import path from "node:path";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
import { recordCredentialHistory, writePrivateJsonAtomic } from "../src/account-history.mjs";

const arg = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const email = arg("--email"), output = arg("--sub2api-out"), replacing = process.argv.includes("--replace-password");
const trace = async event => fs.appendFile(process.env.SECURITY_CONTROLS_TRACE, JSON.stringify({ email, replacing, at: Date.now(), ...event }) + "\n", { mode: 0o600 });
if (!replacing) {
  await trace({ type: "initial" });
  const identity = await getAccountBrowserIdentity(email);
  const token = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, { email, identity, accessToken: token, web: {},
    cookies: [{ name: "identity", value: encodeURIComponent(email), domain: "127.0.0.1", path: "/", hostOnly: true }] });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth",
    credentials: { email, access_token: "original-OAuth-access", refresh_token: "original-OAuth-refresh", plan_type: "free" } }] }));
  if (!email.startsWith("unknown")) {
    console.log("[ok] Password accepted");
    if (process.env.CHATGPT_TOTP_SECRET) console.log("[ok] 2FA verification accepted");
  }
  console.log(`[ok] Saved sub2api import: ${output}`);
} else {
  const password = process.env.CHATGPT_NEW_PASSWORD, previous = process.env.CHATGPT_LOGIN_PASSWORD;
  await trace({ type: "rotation", password, previous, argsHaveAddPassword: process.argv.includes("--add-password") });
  const file = arg("--password-add-result"), before = { password: previous };
  const result = { version: 1, email, operation: "replace_password", stage: "prepared", password,
    previous_password: previous, activation_succeeded: false, confirmation_succeeded: false };
  await recordCredentialHistory(path.dirname(file), { type: "password", stage: result.stage, email, before, after: result });
  await writePrivateJsonAtomic(file, result);
  if (email.startsWith("timeout")) {
    console.log("[mfa] TOTP 2FA challenge reached.");
    console.log("2FA OTP (6 digits, q=quit):");
    process.stdin.resume(); await new Promise(() => {});
  } else if (email.startsWith("prepared")) {
    console.log("[password-replace] Candidate retained without mutation.");
  } else if (email.startsWith("uncertain")) {
    result.stage = "submission_unconfirmed";
    if (email.startsWith("uncertainlegacy")) delete result.operation;
    await writePrivateJsonAtomic(file, result);
    console.error("[error] PASSWORD_REPLACE_SUBMISSION_UNCONFIRMED: fixture request completion unknown"); process.exitCode = 1;
  } else {
    const at = new Date().toISOString();
    Object.assign(result, { stage: "confirmed", activation_succeeded: true, confirmation_succeeded: true, added_at: at, changed_at: at });
    await writePrivateJsonAtomic(file, result);
    console.log("[ok] Account password changed and saved securely");
    if (email.startsWith("postconfirm")) { console.error("[error] fixture post-confirmation Web verification failed"); process.exitCode = 1; }
  }
}
