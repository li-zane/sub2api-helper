export const DEFAULT_SMS_POOL_FAILURE_LIMIT = 2;

export function isVirtualSmsPool(record = {}, apiCountryCode = record?.activate_org_code) {
  // SMSBower country 12 is explicitly "United States (virtual)". Never use
  // the catalogue's internal id (a different namespace) or a phone prefix.
  if (String(apiCountryCode ?? "") === "12") return true;
  if ([record?.is_virtual, record?.isVirtual, record?.virtual].some(value => value === true || value === 1 || value === "1")) return true;
  if (/^(?:virtual|voip)$/i.test(String(record?.number_type || record?.type || ""))) return true;
  const names = [record?.title, record?.eng, record?.chn, record?.rus, record?.slug].filter(value => typeof value === "string");
  return names.some(name => !/non[-\s]?virtual|not\s+virtual|非虚拟|не\s*виртуальн/iu.test(name) && /\bvirtual\b|\bvoip\b|虚拟|виртуальн/iu.test(name));
}

const validKey = value => typeof value === "string" && /^[a-z0-9_]{1,32}\|\d{1,5}\|\d{1,12}$/.test(value);
export function smsPoolKey(route) {
  const key = `${route?.service || "dr"}|${route?.country ?? ""}|${route?.providerId ?? ""}`;
  return validKey(key) ? key : null;
}

export function normalizeSmsPoolRoute(route) {
  if (!smsPoolKey(route) || typeof route?.requestId !== "string" || !route.requestId || route.requestId.length > 128) return null;
  return { service: String(route.service || "dr"), country: String(route.country), providerId: String(route.providerId), requestId: route.requestId,
    countryName: String(route.countryName || `国家 ${route.country}`).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80) };
}

export function createSmsPoolPolicy(attemptKey) {
  return { version: 1, attemptKey, failures: {}, blocked: [], seenOrders: [] };
}

export function restoreSmsPoolPolicy(value) {
  if (value?.version !== 1 || typeof value.attemptKey !== "string" || value.attemptKey.length > 200 || !value.failures || typeof value.failures !== "object" || Array.isArray(value.failures) || !Array.isArray(value.blocked) || !Array.isArray(value.seenOrders)) return null;
  const result = createSmsPoolPolicy(value.attemptKey);
  for (const [key, count] of Object.entries(value.failures)) if (validKey(key) && Number.isSafeInteger(count) && count > 0) result.failures[key] = count;
  result.blocked = [...new Set(value.blocked.filter(validKey))];
  result.seenOrders = [...new Set(value.seenOrders.filter(id => typeof id === "string" && id.length > 0 && id.length <= 128))].slice(-200);
  return result;
}

export function excludedSmsPools(policy, limit = DEFAULT_SMS_POOL_FAILURE_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("单个号池失败排除阈值必须为 1 到 10 的整数");
  return [...new Set([...(policy?.blocked || []), ...Object.entries(policy?.failures || {}).filter(([, count]) => count >= limit).map(([key]) => key)])];
}

// Call only for an upstream number-scoped refusal, never a supplier/network
// error, wrong OTP or account-wide rate limit. One paid order counts once.
export function recordSmsPoolFailure(policy, route, message, limit = DEFAULT_SMS_POOL_FAILURE_LIMIT) {
  const key = smsPoolKey(route), order = String(route?.requestId || "");
  if (!key || !order || policy.seenOrders.includes(order)) return null;
  excludedSmsPools(policy, limit);
  policy.seenOrders = [...policy.seenOrders, order].slice(-200);
  const count = policy.failures[key] = (policy.failures[key] || 0) + 1;
  const immediate = /voip_phone_disallowed/i.test(String(message || ""));
  if (immediate && !policy.blocked.includes(key)) policy.blocked.push(key);
  return { key, count, limit, immediate, excluded: immediate || count >= limit };
}
