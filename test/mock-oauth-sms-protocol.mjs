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
  let number = 0;
  for (;;) {
    const phone = await rl.question("Phone number, E.164 format (p=quit): ");
    number++;
    if (email.startsWith("reject-phone") || email.startsWith("reject-once") && number === 1 || email.startsWith("partial-reject") && number === 1 || email.startsWith("rate-limit")) {
      const error = email.startsWith("rate-limit") ? "HTTP 429: too many requests" : "We've detected suspicious behavior from phone numbers similar to yours.";
      if (email.startsWith("partial")) {
        process.stdout.write(`[warn] Could not send SMS to ${phone}: We've detected `);
        await new Promise(r => setTimeout(r, 20));
        console.log("suspicious behavior from phone numbers similar to yours.");
        for (let n = 0; n < 3; n++) { await new Promise(r => setTimeout(r, 20)); console.log("[debug] waiting for next phone prompt"); }
      } else console.log(`[warn] Could not send SMS to ${phone}: ${error}`);
      console.log("[info] Enter another phone number, or q to quit.");
      continue;
    }
    const code = await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ");
    if (code !== "654321") throw Error("wrong fixture code");
    if ((email.startsWith("otp-risk") && number === 1) || email.startsWith("wrong-otp")) {
      console.log(`[warn] Phone OTP validation failed: ${email.startsWith("otp-risk") ? "HTTP 429: phone_recently_used" : "incorrect code"}`);
      const next = await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ");
      if (next === "p") continue;
      throw Error("unexpected fixture OTP action");
    }
    break;
  }
  console.log("[ok] Phone OTP validated");
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, access_token: "fixture", refresh_token: "fixture", plan_type: "free" }, extra: {} }] }));
  console.log(`[ok] Saved sub2api import: ${output}`);
} finally { rl.close(); }
}
