export function formatCnyCents(cents, { trim = false } = {}) {
  if (cents === null) return "—";
  const negative = cents < 0n, digits = (negative ? -cents : cents).toString().padStart(3, "0");
  let fraction = digits.slice(-2); if (trim) fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}￥${digits.slice(0,-2)}${fraction ? "." + fraction : ""}`;
}
