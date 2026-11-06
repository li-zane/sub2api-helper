import fs from "node:fs/promises";
import path from "node:path";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
import { recordCredentialHistory, writePrivateJsonAtomic } from "../src/account-history.mjs";
const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
const email = arg("--email"), file = arg("--sub2api-out");
if (process.argv.includes("--web-only")) {
  const identity = await getAccountBrowserIdentity(email);
  await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, { email, identity, accessToken: "new-candidate-token",
    cookies: [{ name: "session", value: "new-candidate-cookie", domain: "chatgpt.com", path: "/", secure: true, hostOnly: true }], web: {} });
  console.log(`[ok] Saved web session: ${process.env.TOSUB2_WEB_SESSION_PATH}`);
  if (email.startsWith("timeout")) { console.log("2FA code (q=quit):"); process.stdin.resume(); }
  else { console.error("[error] fixture failed after candidate write"); process.exitCode = 1; }
} else if (process.argv.includes("--replace-totp")) {
  const resultPath = arg("--totp-result"), before = { totpSecret: process.env.CHATGPT_TOTP_SECRET };
  const data = { version: 1, email, operation: "replace_totp", stage: "activation_pending", secret: "MZXW6YTBON2GK3TB",
    otpauth_uri: "otpauth://totp/fixture?secret=MZXW6YTBON2GK3TB", activation_mode: "automatic", activation_succeeded: false };
  await recordCredentialHistory(path.dirname(resultPath), { type: "2fa", stage: data.stage, before, after: data });
  await writePrivateJsonAtomic(resultPath, data);
  console.log("[2fa-setup-ready] 2FA key created; activating it automatically.");
  data.stage = "confirmed"; data.activation_succeeded = true; data.confirmation_succeeded = true;
  await writePrivateJsonAtomic(resultPath, data);
  console.log("[ok] 2FA replacement activated");
} else {
  console.log("DURABILITY_FIRST_EVENT");
  process.stdout.write("fixture-output ".repeat(9000) + "\n");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth",
    credentials: { email, access_token: "fixture-access", refresh_token: "fixture-refresh", plan_type: "free" } }] }));
  console.log(`[ok] Saved sub2api import: ${file}`);
}
