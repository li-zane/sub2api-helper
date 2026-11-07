export function smsBowerModesFixture() {
  const prices = {}, countries = {};
  const rows = [
    ["1001", "Japan", [["gold", 3253, "0.04", 10], ["silver", 3328, "0.03", 20], ["bronze", 3288, "0.01", 30]]],
    ["73", "Brazil", [["gold", 3253, "0.035", 5], ["gold", 3243, "0.02", 7], ["silver", 3328, "0.01", 11]]],
    ["33", "Colombia", [["gold", 3253, "0.05", 3], ["bronze", 3288, "0.005", 13]]],
  ];
  for (const [code, title, offers] of rows) {
    const providers = prices[code] = { dr: {} }, positions = {};
    for (const [rank, id, price, count] of offers) {
      providers.dr[id] = { provider_id: id, price, count };
      positions[id] = { rank: { description: rank }, price, count, agent_ids: [id], agent_prices: { [id]: price } };
    }
    countries["internal-" + code] = { activate_org_code: code, title, positions };
  }
  return { prices, catalog: { services: { 247: { id: 247, activate_org_code: "dr", countries } } } };
}
