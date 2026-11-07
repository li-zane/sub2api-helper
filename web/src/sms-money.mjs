// SMSBower's official USD transition: https://smsbower.app/cn/blog/transition-to-usd
export const SMSBOWER_CURRENCY = 'USD';
export function formatSmsMoney(amount, currency = SMSBOWER_CURRENCY) {
  return `${amount} ${currency || SMSBOWER_CURRENCY}`;
}
