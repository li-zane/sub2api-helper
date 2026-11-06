import fs from "node:fs/promises";
import readline from "node:readline/promises";
const arg = key => process.argv[process.argv.indexOf(key) + 1];
const email = arg("--email"), output = arg("--sub2api-out"), rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await run();
async function run() {
try {
  console.log("[web-session] Reused saved Web session; account login skipped.");
  console.log("[codex-auth-login] Codex requires its own sign-in; preserving the saved Web session.");
  console.log("[ok] Password accepted");
  console.log("[4/5] Phone binding is required");
  const phone = await rl.question("Phone number, E.164 format (p=quit): ");
  if (email.startsWith("reject")) {
    console.log(`[warn] Could not send SMS to ${phone}: phone already used`);
    console.log("[info] Enter another phone number, or q to quit.");
    await rl.question("Phone number, E.164 format (p=quit): ");
    return;
  }
  const code = await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ");
  if (code !== "654321") throw Error("wrong fixture code");
  console.log("[ok] Phone OTP validated");
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, access_token: "fixture", refresh_token: "fixture", plan_type: "free" }, extra: {} }] }));
  console.log(`[ok] Saved sub2api import: ${output}`);
} finally { rl.close(); }
}
