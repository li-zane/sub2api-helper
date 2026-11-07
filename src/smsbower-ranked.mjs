import { isVirtualSmsPool, smsPoolKey } from "./sms-pool-policy.mjs";
// Prices are USD decimals. Integer comparison avoids rounding across a budget boundary.
export function smsPriceUnits(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,12}(?:\.\d{1,12})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, "0"));
}

export function rankedSmsBowerOffers(prices, catalog, service, country, maxPrice, selectionMode = "country", excludedPools = []) {
  if (!["country", "global"].includes(selectionMode)) throw new Error("请选择有效的 SMSBower 选号方式");
  if (!Array.isArray(excludedPools) || excludedPools.some(key => typeof key !== "string")) throw new Error("SMSBower 号池排除规则格式不正确");
  const excluded = new Set(excludedPools);
  const cap = smsPriceUnits(maxPrice);
  if (cap === null || cap <= 0n) throw new Error("请设置 SMSBower 最高价格（USD），取号不会自动提高上限");
  const record = Object.values(catalog?.services || {}).find(item => item?.activate_org_code === service);
  if (!record?.countries || typeof record.countries !== "object") throw new Error("SMSBower 等级数据不可用，已停止取号");
  if (!prices || typeof prices !== "object" || Array.isArray(prices) || Object.keys(prices).some(key => !/^\d{1,5}$/.test(key))) throw new Error("SMSBower 供应商价格数据不可用，已停止取号");
  const selectedCountries = selectionMode === "global" ? Object.values(record.countries) : Object.values(record.countries).filter(item => String(item?.activate_org_code) === String(country));
  const allOffers = [], seen = new Set();
  for (const selected of selectedCountries) {
    const countryCode = String(selected?.activate_org_code ?? "");
    if (!/^\d{1,5}$/.test(countryCode) || seen.has(countryCode) || isVirtualSmsPool(selected, countryCode)) continue;
    seen.add(countryCode);
    allOffers.push(...countryOffers(prices, selected, service, countryCode, cap));
  }
  return sortOffers(allOffers.filter(offer => !excluded.has(smsPoolKey({ ...offer, service }))));
}

function countryOffers(prices, selected, service, country, cap) {
  const countryName = String(selected.chn || selected.title || selected.eng || ("国家 " + country));
  // A missing country means no inventory, not permission to switch countries.
  if (!selected) return [];
  if (!selected.positions || typeof selected.positions !== "object") throw new Error("SMSBower 国家等级数据格式不正确，已停止取号");
  const ranks = new Map(), conflicts = new Set();
  for (const position of Object.values(selected.positions)) {
    const rank = position?.rank?.description;
    if (isVirtualSmsPool(position, "") || !["gold", "silver", "bronze"].includes(rank) || !Array.isArray(position.agent_ids) || !(Number(position.count) > 0)) continue;
    for (const id of position.agent_ids) {
      const providerId = String(id);
      if (!/^\d+$/.test(providerId)) continue;
      const quote = position.agent_prices?.[providerId] ?? position.price;
      const units = smsPriceUnits(quote);
      if (units === null) continue;
      if (ranks.has(providerId) && ranks.get(providerId).rank !== rank) conflicts.add(providerId);
      ranks.set(providerId, { rank, units });
    }
  }
  const providers = prices?.[country]?.[service];
  if (providers === undefined) return [];
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("SMSBower 供应商价格数据不可用，已停止取号");
  const offers = [];
  for (const [key, provider] of Object.entries(providers)) {
    const id = String(provider?.provider_id ?? key), meta = ranks.get(id), price = smsPriceUnits(provider?.price);
    if (isVirtualSmsPool(provider, "") || String(key) !== id || conflicts.has(id) || !meta || price === null || price <= 0n || price > cap || (!Number.isSafeInteger(Number(provider.count)) || Number(provider.count) <= 0)) continue;
    offers.push({ country: String(country), countryName, providerId: id, rank: meta.rank, price: String(provider.price), count: Number(provider.count) });
  }
  return offers;
}

function sortOffers(offers) {
  const rankOrder = { gold: 0, silver: 1, bronze: 2 };
  return offers.sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank] || Number(smsPriceUnits(a.price) - smsPriceUnits(b.price)) || b.count - a.count || a.country.localeCompare(b.country) || a.providerId.localeCompare(b.providerId));
}

export function summarizeSmsBowerOffers(offers) {
  const byRank = { gold: 0, silver: 0, bronze: 0 };
  for (const offer of offers) {
    byRank[offer.rank] += offer.count;
    if (!Number.isSafeInteger(byRank[offer.rank])) throw new Error("SMSBower 库存数量超出可统计范围");
  }
  const totalCount = byRank.gold + byRank.silver + byRank.bronze;
  if (!Number.isSafeInteger(totalCount)) throw new Error("SMSBower 库存数量超出可统计范围");
  return { totalCount, byRank, countryCount: new Set(offers.map(offer => offer.country)).size, providerCount: offers.length };
}
