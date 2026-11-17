import { DEFAULT_POOL_PRICE_MULTIPLIER, normalizeAccountCost, normalizePoolPriceMultiplier, restoredAccountCost, accountProfitCents } from "../../shared/account-pricing.mjs";
export { DEFAULT_POOL_PRICE_MULTIPLIER, normalizeAccountCost, normalizePoolPriceMultiplier, restoredAccountCost, accountProfitCents };
import { formatCnyCents } from "../../shared/currency-text.mjs";
export { formatCnyCents } from "../../shared/currency-text.mjs";
export const formatAccountCost = value => formatCnyCents(-accountProfitCents(0, 1, restoredAccountCost(value)), { trim: true });
export function preserveNewerAccountCost(previous, next) {
  if (!previous?.accountCostUpdatedAt || previous.accountCostUpdatedAt === next.accountCostUpdatedAt) return next;
  return Date.parse(previous.accountCostUpdatedAt) > (Date.parse(next.accountCostUpdatedAt) || 0)
    ? { ...next, accountCostCny: previous.accountCostCny, accountCostUpdatedAt: previous.accountCostUpdatedAt } : next;
}
