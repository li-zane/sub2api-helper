import assert from "node:assert/strict";
import { authOutputStages } from "../src/auth-output-stage.mjs";

const mfa = "[mfa] TOTP 2FA challenge reached.\n[mfa] Generated a 6-digit code from the configured 2FA key.\n";
const accepted = "[ok] 2FA verification accepted\n";
const email = "Email OTP (r=resend, q=quit): ";
const transcript = "[auth-expired] fixture\n[codex-auth-login] fixture\nPassword (q=quit): [ok] Password accepted\n" + mfa + "2FA OTP (6 digits, q=quit): " + accepted + email;
const expected = ["auth_expired", "codex_auth_login", "password", "password_accepted", "mfa_preparing", "mfa_otp", "mfa_accepted", "email_otp"];
function stream(chunks) {
  let tail = ""; const events = [];
  for (const text of chunks) {
    const scan = tail + text;
    events.push(...authOutputStages(scan, tail.length).map(e => e.type));
    tail = scan.slice(-2000);
  }
  return events;
}
assert.deepEqual(stream([transcript]), expected);
for (let at = 0; at <= transcript.length; at++) assert.deepEqual(stream([transcript.slice(0, at), transcript.slice(at)]), expected, `split ${at}`);
assert.deepEqual(stream([...transcript]), expected);
assert.deepEqual(stream([transcript, "\nheartbeat\n", "more output"]), expected);
assert.deepEqual(stream([mfa + accepted + email, mfa + "2FA OTP (6 digits, q=quit): ", accepted, email]),
  ["mfa_preparing", "mfa_accepted", "email_otp", "mfa_preparing", "mfa_otp", "mfa_accepted", "email_otp"]);
assert.deepEqual(stream([mfa + accepted + "x".repeat(2500), email]), ["mfa_preparing", "mfa_accepted", "email_otp"]);
assert.deepEqual(stream(["2FA setup OTP (6 digits, q=quit): "]), ["totp_setup_otp"]);
console.log(`AUTH_OUTPUT_STAGE_PASS splits=${transcript.length + 1} bytewise/coalesced output; protocol order; no stale-tail replay; genuine repeated challenges; tail eviction; setup prompt`);
