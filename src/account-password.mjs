import crypto from "node:crypto";

export function generateAccountPassword() {
  const groups = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!@#%_"];
  const alphabet = groups.join("");
  const chars = groups.map(group => group[crypto.randomInt(group.length)]);
  while (chars.length < 12) chars.push(alphabet[crypto.randomInt(alphabet.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
