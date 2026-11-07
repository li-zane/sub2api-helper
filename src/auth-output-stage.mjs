const markers = [
  ["auth_expired", "[auth-expired]"],
  ["codex_auth_login", "[codex-auth-login]"],
  ["email_otp", "Email OTP (r=resend, q=quit):"],
  ["password", "Password (q=quit):"],
  ["totp_setup_otp", "2FA setup OTP (6 digits, q=quit):"],
  ["mfa_preparing", "[mfa] TOTP 2FA challenge reached."],
  ["mfa_otp", "2FA OTP (6 digits, q=quit):"],
  ["mfa_accepted", "[ok] 2FA verification accepted"],
  ["password_accepted", "[ok] Password accepted"],
];

// Retain overlap for split stdout chunks, but never replay a completed marker
// from the retained tail. Apply fresh events in protocol order, not if-order.
export function authOutputStages(scan, previousLength = 0) {
  const events = [];
  for (const [type, marker] of markers) {
    for (let at = scan.indexOf(marker); at !== -1; at = scan.indexOf(marker, at + marker.length)) {
      const end = at + marker.length;
      if (end > previousLength) events.push({ type, end });
    }
  }
  return events.sort((a, b) => a.end - b.end);
}
