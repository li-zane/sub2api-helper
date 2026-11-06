export function smsOrderCost(amount, currency) {
  const text = typeof amount === "number" && Number.isFinite(amount)
    ? amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 12 })
    : typeof amount === "string" ? amount.trim() : "";
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(text)) return null;
  const currencies = { 840: "USD", 978: "EUR", 643: "RUB", 156: "CNY", 826: "GBP", 392: "JPY" };
  const unit = String(currency ?? "").trim().toUpperCase();
  return { amount: text, currency: currencies[unit] || (/^[A-Z]{3}$|^\d{3}$/.test(unit) ? unit : null) };
}

export function smsOrderLog(provider, order, { maxPrice = "", late = false, invalid = false } = {}) {
  const safe = value => String(value ?? "").replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 120);
  const cost = order.cost && smsOrderCost(order.cost.amount, order.cost.currency);
  return `[sms-order] ${invalid ? "取号响应异常，已保留订单待取消" : late ? "任务结束后取号返回" : "取号成功"}；平台 ${safe(provider)}；订单 ${safe(order.requestId) || "手动号码"}；手机号 ${safe(order.number)}；金额 ${cost ? `${cost.amount} ${cost.currency || "（币种未返回，按平台订单计价）"}` : "未知（平台未返回订单金额）"}${maxPrice ? `；价格上限 ${safe(maxPrice)}（非实际金额）` : ""}。\n`;
}
