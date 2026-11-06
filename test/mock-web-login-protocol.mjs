import fs from "node:fs/promises";
import path from "node:path";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const email = arg("--email") || JSON.parse(await fs.readFile(arg("--refresh-sub2api"), "utf8")).accounts[0].credentials.email;
const outputPath = arg("--sub2api-out");
const web = process.argv.includes("--web-only");
const trace = entry => fs.appendFile(process.env.WEB_LOGIN_TRACE, JSON.stringify({ email, web, ...entry }) + "\n");
await trace({ event: "start", mode: arg("--output-mode"), authMode: process.env.TOSUB2_CODEX_AUTH_MODE, hasPoolKey: Boolean(process.env.TOSUB2_OAUTH_ADMIN_KEY), emailOtpApiAvailable: process.env.TOSUB2_EMAIL_OTP_API_AVAILABLE });
console.log("Email OTP (r=resend, q=quit):");
process.stdin.resume();
await new Promise(resolve => process.stdin.once("data", resolve));
if (email.startsWith("web-fail")) {
  console.error("[error] fixture Web login rejected");
  process.exitCode = 1;
} else if (web) {
  if (arg("--output-mode") !== "web") throw new Error("Web-only output mode not used");
  const identity = await getAccountBrowserIdentity(email);
  const accessToken = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, {
    email, identity, accessToken, cookies: [{ name: "session", value: "web-fixture", domain: "127.0.0.1", path: "/", hostOnly: true }],
    web: { workspaceId: "fixture-workspace" },
  });
  console.log(`[ok] Saved web session: ${process.env.TOSUB2_WEB_SESSION_PATH}`);
} else {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth",
    credentials: { email, access_token: "fixture-Codex-token", refresh_token: "fixture-Codex-refresh" } }] }));
  console.log(`[ok] Saved sub2api import: ${outputPath}`);
}
await trace({ event: "end" });
process.stdin.destroy();
