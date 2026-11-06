import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
const arg = key => process.argv[process.argv.indexOf(key) + 1];
const email = arg("--email"), web = process.argv.includes("--web-only");
await fs.appendFile(process.env.ACCOUNT_CONTROLS_TRACE, JSON.stringify({ email, web, phased: process.env.TOSUB2_PHASED_PROXY, hasPoolKey: Boolean(process.env.TOSUB2_OAUTH_ADMIN_KEY), at: Date.now() }) + "\n");
const identity = await getAccountBrowserIdentity(email);
const accessToken = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url")}.signature`;
await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH, { email, identity, accessToken, web: { workspaceId: "personal", planType: "free" }, cookies: [{ name: "identity", value: encodeURIComponent(email), domain: "127.0.0.1", path: "/", hostOnly: true }] });
console.log(`[ok] Saved web session: ${process.env.TOSUB2_WEB_SESSION_PATH}`);
if (!web) {
  console.log("[4/5] Phone binding is required");
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await input.question("Phone number, E.164 format (p=quit): "); await new Promise(() => {}); }
  finally { input.close(); }
}
