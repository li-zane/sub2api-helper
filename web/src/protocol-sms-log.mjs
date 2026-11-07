export function hasSmsActivity(text) {
  return /\[(?:sms(?:-order)?|phone(?:-otp)?)\]|\/(?:add-phone\/send|phone-otp\/validate)(?:[?\s"']|$)|Enter phone number|手机号验证|手机验证/i.test(String(text || ""));
}

// Render as React text nodes, never HTML. Only explicitly labelled phone
// numbers are collected; OTP codes, timestamps and unrelated IDs stay plain.
export function splitSmsPhoneHighlights(text) {
  const value = String(text || ""), phones = new Set();
  for (const match of value.matchAll(/(?:手机号|phone(?:\s+number|Number|_number)?)[\s"'=:：]*(\+?[1-9]\d{6,14})(?!\d)/gi)) {
    phones.add(match[1]); phones.add(match[1].replace(/^\+/, ""));
  }
  if (!phones.size) return [{ text: value, phone: false }];
  const escaped = [...phones].sort((a, b) => b.length - a.length).map(phone => phone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|[^\\d+])(${escaped.join("|")})(?!\\d)`, "g"), parts = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index + match[1].length;
    if (start > cursor) parts.push({ text: value.slice(cursor, start), phone: false });
    parts.push({ text: match[2], phone: true }); cursor = start + match[2].length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), phone: false });
  return parts;
}
