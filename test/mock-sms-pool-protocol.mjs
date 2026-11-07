import fs from "node:fs/promises";
import readline from "node:readline/promises";
const arg = name => process.argv[process.argv.indexOf(name) + 1], email = arg("--email"), output = arg("--sub2api-out");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log("[4/5] Phone binding is required"); let count = 0;
  for (;;) {
    const phone = await rl.question("Phone number, E.164 format (p=quit): "); count++;
    const rejection = email.startsWith("pool-voip") && count === 1 ? 'HTTP400: {"error":{"message":"Not permitted","code":"voip_phone_disallowed"}}'
      : email.startsWith("pool-rate") ? "HTTP429: too many requests"
      : email.startsWith("pool-fixed") || email.startsWith("pool-all") || email.startsWith("pool-two") && count <= 2 || email.startsWith("pool-one") && count === 1 || email.startsWith("pool-duplicate") && count === 1 ? "HTTP400: Invalid phone number. Please try again." : null;
    if (rejection) {
      console.log(`[warn] Could not send SMS to ${phone}: ${rejection}`);
      if (email.startsWith("pool-duplicate")) { await new Promise(r => setTimeout(r, 40)); console.log(`[warn] Could not send SMS to ${phone}: ${rejection}`); }
      console.log("[info] Enter another phone number, or q to quit."); continue;
    }
    const code = await rl.question("Phone OTP (r=resend, p=change phone, q=quit): "); if (code !== "654321") throw Error("Unexpected fixture code");
    if (email.startsWith("pool-otp") && count === 1 || email.startsWith("pool-wrong")) {
      console.log(`[warn] Phone OTP validation failed: ${email.startsWith("pool-otp") ? "HTTP429: phone_recently_used" : "incorrect code"}`);
      if (await rl.question("Phone OTP (r=resend, p=change phone, q=quit): ") === "p") continue;
      throw Error("Unexpected fixture action");
    }
    console.log("[ok] Phone OTP validated");
    await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, access_token: "fixture", refresh_token: "fixture", plan_type: "free" }, extra: {} }] }));
    console.log(`[ok] Saved sub2api import: ${output}`); break;
  }
} finally { rl.close(); }
