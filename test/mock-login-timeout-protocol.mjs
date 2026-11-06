import fs from "node:fs/promises";
import path from "node:path";
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const output = arg("--sub2api-out");
const email = arg("--email") || JSON.parse(await fs.readFile(arg("--refresh-sub2api"), "utf8")).accounts[0].credentials.email;
if (process.env.LOGIN_TIMEOUT_TRACE) await fs.appendFile(process.env.LOGIN_TIMEOUT_TRACE, JSON.stringify({ email, pid: process.pid, at: Date.now() }) + "\n");
if (email.startsWith("fast-")) {
  await new Promise(r => setTimeout(r, 80));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, access_token: "fixture", refresh_token: "fixture", plan_type: "free" }, extra: {} }] }));
  console.log(`[ok] Saved sub2api import: ${output}`);
  process.exit(0);
}
console.log("[mfa] TOTP 2FA challenge reached.");
console.log("2FA OTP (6 digits, q=quit):");
process.stdin.resume();
await new Promise(() => {});
