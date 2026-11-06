import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
const arg = key => process.argv[process.argv.indexOf(key) + 1];
const email = arg("--email"), output = arg("--sub2api-out");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await fs.appendFile(process.env.DEADLINE_TRACE, JSON.stringify({ email, web: process.argv.includes("--web-login-only"), at: Date.now() }) + "\n");
try {
  if (email.startsWith("mfa")) {
    console.log("[mfa] TOTP 2FA challenge reached.");
    await rl.question("2FA OTP (6 digits, q=quit): ");
    await new Promise(() => {});
  }
  await new Promise(r => setTimeout(r, 250));
  console.log("[4/5] Phone binding is required");
  await rl.question("Phone number, E.164 format (p=quit): ");
  await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ");
  console.log("[ok] Phone OTP validated");
  console.log("[5/5] Select workspace");
  if (email.startsWith("finalize-hang")) await new Promise(() => {});
  await new Promise(r => setTimeout(r, 700)); // Finalization stays inside the same SMS budget after OTP success.
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ type: "oauth", platform: "openai", credentials: { email, access_token: "fixture-token", refresh_token: "fixture-refresh", plan_type: "free" } }] }));
  console.log(`[ok] Saved sub2api import: ${output}`);
} finally { rl.close(); }
