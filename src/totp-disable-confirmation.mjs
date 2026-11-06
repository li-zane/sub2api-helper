// HTTP 200/204 acknowledges a request, not the factor's resulting state.
export function confirmedTotpState(info) {
  const flags = [info?.mfa_enabled_v2, info?.mfa_enabled].filter(v => typeof v === "boolean");
  const factor = Boolean(info?.native_default_factor_id) || Array.isArray(info?.factors?.totp) && info.factors.totp.some(f => f?.id || f?.factor_type === "totp");
  if (flags.length && flags.every(v => v === false) && !factor) return false;
  if (flags.length && flags.every(v => v === true) && factor) return true;
  return null;
}

export async function confirmTotpDisable({ disable, readInfo, persist }) {
  const uncertain = () => persist({ stage: "disable_unconfirmed", remote_disabled: false, disable_uncertain: true });
  let reply;
  try { reply = await disable(); }
  catch (error) { await uncertain(); throw error; }
  let info;
  try { info = await readInfo(); }
  catch { await uncertain(); throw new Error("TOTP_REPLACE_DISABLE_UNCONFIRMED: unable to verify MFA status after disable; do not enroll yet"); }
  const state = confirmedTotpState(info);
  if (state === false) {
    await persist({ stage: "disabled", remote_disabled: true, disable_uncertain: false, disabled_at: new Date().toISOString() });
    return;
  }
  if (state === true && !reply?.acknowledged) {
    await persist({ stage: "disable_rejected", remote_disabled: false, disable_uncertain: false });
    throw new Error("TOTP_REPLACE_DISABLE_REJECTED: MFA status still confirms an enabled TOTP factor");
  }
  await uncertain();
  throw new Error("TOTP_REPLACE_DISABLE_UNCONFIRMED: MFA status did not confirm that TOTP was disabled; do not enroll yet");
}
