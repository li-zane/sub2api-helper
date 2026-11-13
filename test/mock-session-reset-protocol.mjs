import fs from "node:fs/promises";
import { seedWebSession } from "./account-web-fixture.mjs";
const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
const output = arg("--sub2api-out"), email = arg("--email"), trace = process.env.SESSION_RESET_TRACE;
const append = event => fs.appendFile(trace, JSON.stringify(event) + "\n");
if (process.argv.includes("--refresh-sub2api")) throw Error("session reset must never use old OAuth refresh");
const oldWeb = await fs.readFile(process.env.TOSUB2_WEB_SESSION_PATH, "utf8").then(JSON.parse, () => null);
await append({ phase: "web", reused: Boolean(oldWeb), proxy: process.env.CHATGPT_PROXY_URL,
  fixed: process.env.CHATGPT_PROXY_FIXED, phased: process.env.TOSUB2_PHASED_PROXY,
  mode: process.env.TOSUB2_CODEX_AUTH_MODE, oauthProxyId: process.env.TOSUB2_OAUTH_PROXY_ID });
console.log("[1/5] Start ChatGPT web login");
await seedWebSession(output);
console.log("[ok] Saved web session: " + process.env.TOSUB2_WEB_SESSION_PATH);
await append({ phase: "oauth", proxy: process.env.CHATGPT_PROXY_URL });
if (process.env.SESSION_RESET_GATE) {
  for (let i = 0; i < 1000 && !await fs.access(process.env.SESSION_RESET_GATE).then(() => true, () => false); i++) await new Promise(r => setTimeout(r, 20));
}
if (process.env.SESSION_RESET_FAIL_OAUTH === "1") { console.error("[error] fixture OAuth rejected"); process.exit(1); }
await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth",
  credentials: { email, access_token: "reset-new-access", refresh_token: "reset-new-refresh", plan_type: "free" } }] }));
console.log("[ok] Saved sub2api import: " + output);
