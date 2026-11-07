export const DEFAULT_POOL_PRICE_MULTIPLIER = 1;

function decimalSetting(value, { label, max, places, positive }) {
  if (!["number", "string"].includes(typeof value)) throw Error(`${label}必须是有效数字`);
  const text = String(value).trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw Error(`${label}必须是非负数字`);
  const amount = Number(text), precision = (text.split(".")[1] || "").replace(/0+$/, "").length;
  if (!Number.isFinite(amount) || amount > max || positive && amount <= 0 || precision > places) {
    throw Error(`${label}范围${positive ? "大于 0" : "从 0"}至 ${max}，最多 ${places} 位小数`);
  }
  return amount;
}

export const normalizeAccountCost = value => decimalSetting(value, { label: "账号成本", max: 1_000_000_000, places: 2 });
export const normalizePoolPriceMultiplier = value => value === undefined ? DEFAULT_POOL_PRICE_MULTIPLIER
  : decimalSetting(value, { label: "号池价格倍率", max: 1_000_000, places: 6, positive: true });
export function restoredAccountCost(value) { try { return value === undefined ? 0 : normalizeAccountCost(value); } catch { return 0; } }

function decimalParts(value) {
  const match = String(value).toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) throw Error("Invalid decimal");
  let units = BigInt(match[1] + (match[2] || "")), scale = (match[2]?.length || 0) - Number(match[3] || 0);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  return { units, scale };
}

export function accountProfitCents(userCostUsd, multiplier, accountCostCny = 0) {
  if (typeof userCostUsd !== "number" || !Number.isFinite(userCostUsd) || userCostUsd < 0) return null;
  const usd = decimalParts(userCostUsd), rate = decimalParts(normalizePoolPriceMultiplier(multiplier));
  const cost = decimalParts(normalizeAccountCost(accountCostCny));
  const denominator = 10n ** BigInt(usd.scale + rate.scale), numerator = usd.units * rate.units * 100n;
  // Round the converted charge once, using decimal arithmetic rather than
  // binary floating-point. Account acquisition cost is already exact cents.
  const revenueCents = (numerator + denominator / 2n) / denominator;
  const costCents = cost.units * 100n / (10n ** BigInt(cost.scale));
  return revenueCents - costCents;
}

export function formatCnyCents(cents, { trim = false } = {}) {
  if (cents === null) return "—";
  const negative = cents < 0n, digits = (negative ? -cents : cents).toString().padStart(3, "0");
  let fraction = digits.slice(-2); if (trim) fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}￥${digits.slice(0,-2)}${fraction ? "." + fraction : ""}`;
}
export const formatAccountCost = value => formatCnyCents(-accountProfitCents(0, 1, restoredAccountCost(value)), { trim: true });

// A late list poll must not undo a locally confirmed cost edit.
export function preserveNewerAccountCosts(previous, next) {
  const byId = new Map(previous.map(job => [job.id, job]));
  return next.map(job => {
    const old = byId.get(job.id);
    return old && Date.parse(old.accountCostUpdatedAt) > (Date.parse(job.accountCostUpdatedAt) || 0)
      ? { ...job, accountCostCny: old.accountCostCny, accountCostUpdatedAt: old.accountCostUpdatedAt } : job;
  });
}
