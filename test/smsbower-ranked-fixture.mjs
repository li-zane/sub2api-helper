export function rankedFixtureData(country = "1001", price = 0.42) {
  return {
    prices: { [country]: { dr: { 3253: { provider_id: 3253, price, count: 10 } } } },
    catalog: { services: { 247: { id: 247, activate_org_code: "dr", countries: {
      9: { title: country === "73" ? "Brazil" : "Japan", activate_org_code: country, positions: { one: { rank: { description: "gold" }, price, count: 10, agent_ids: [3253], agent_prices: { 3253: price } } } },
    } } } },
  };
}
export function rankedFixtureReply(url) {
  const parsed = new URL(url), { prices, catalog } = rankedFixtureData();
  if (parsed.searchParams.get("action") === "getPricesV3") return JSON.stringify(prices);
  if (parsed.searchParams.has("serviceId")) return JSON.stringify(catalog);
  return null;
}
export function withRankedFixture(fetchImpl) {
  return async (url, options) => {
    const reply = rankedFixtureReply(url);
    return reply === null ? fetchImpl(url, options) : new Response(reply);
  };
}
