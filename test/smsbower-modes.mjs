import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { smsBowerModesFixture } from "./smsbower-modes-fixture.mjs";
import { smsOrderLog } from "../src/sms-order-cost.mjs";
const source = process.env.SMSBOWER_MODES_SOURCE;
const { createSmsProvider } = await import(source ? pathToFileURL(source).href : "../src/sms-providers.mjs");
let passed = 0; const run = async (name, fn) => { await fn(); passed++; };
function fixture({ selectionMode, country = "1001", maxPrice = "0.04", purchase, empty = false, catalogFail = false } = {}) {
  const { prices, catalog } = smsBowerModesFixture(), calls = [];
  const provider = createSmsProvider("smsbower", { apiKey: "fixture-private-key", service: "dr", selectionMode, country, maxPrice, countryLabel: "saved-Japan" }, { fetchImpl: async url => {
    const u = new URL(url); calls.push(u);
    if (u.searchParams.has("serviceId")) { assert(!u.searchParams.has("api_key")); return catalogFail ? new Response("down", { status: 503 }) : Response.json(catalog); }
    if (u.searchParams.get("action") === "getPricesV3") return Response.json(empty ? {} : u.searchParams.has("country") ? { [u.searchParams.get("country")]: prices[u.searchParams.get("country")] } : prices);
    return purchase ? purchase(u) : Response.json({ activationId: "paid", phoneNumber: "5511999999999", activationCost: u.searchParams.get("maxPrice") });
  } });
  return { provider, calls, prices, catalog, buys: () => calls.filter(u => ["getNumber", "getNumberV2"].includes(u.searchParams.get("action"))) };
}
await run("global mode chooses Gold across countries instead of saved country", async () => {
  const f = fixture({ selectionMode: "global" }), order = await f.provider.getNumber();
  assert.equal(f.buys()[0].searchParams.get("country"), "73", "global mode must search beyond the saved country");
  assert.equal(order.providerId, "3243"); assert.equal(order.country, "73"); assert.equal(order.countryName, "Brazil"); assert.equal(f.provider.serviceLabel, "不限国家");
  assert.match(smsOrderLog("SMSBower", order), /国家 Brazil（ID 73）/);
});
await run("default/legacy mode remains country-scoped", async () => {
  const f = fixture(), order = await f.provider.getNumber(); assert.equal(order.country, "1001"); assert.equal(order.providerId, "3253"); assert.equal(order.countryName, "Japan");
  assert.equal(f.calls.find(u => u.searchParams.get("action") === "getPricesV3").searchParams.get("country"), "1001");
});
await run("global inventory exact qualified stock sum and no paid calls", async () => {
  const f = fixture({ selectionMode: "global", country: "" }); const estimate = await f.provider.estimateNumberAvailability();
  assert.equal(estimate.totalCount, 96); assert.deepEqual(estimate.byRank, { gold: 22, silver: 31, bronze: 43 }); assert.equal(estimate.countryCount, 3); assert.equal(estimate.providerCount, 7); assert.equal(estimate.country, null); assert.equal(f.buys().length, 0);
  assert(!f.calls.find(u => u.searchParams.get("action") === "getPricesV3").searchParams.has("country"));
});
await run("country-scoped inventory uses same qualified offers as purchase", async () => {
  const f = fixture({ selectionMode: "country" }), estimate = await f.provider.estimateNumberAvailability(); assert.equal(estimate.totalCount, 60); assert.deepEqual(estimate.byRank, { gold: 10, silver: 20, bronze: 30 }); assert.equal(estimate.countryCount, 1); assert.equal(estimate.country, "1001"); assert.equal(f.buys().length, 0);
});
await run("budget change recalculates inclusive boundary", async () => {
  const f = fixture({ selectionMode: "global", maxPrice: "0.01" }), estimate = await f.provider.estimateNumberAvailability(); assert.equal(estimate.totalCount, 54); assert.deepEqual(estimate.byRank, { gold: 0, silver: 11, bronze: 43 }); assert.equal((await f.provider.getNumber()).rank, "silver");
});
await run("out of stock fixed country cannot cross border", async () => {
  const f = fixture({ selectionMode: "country", purchase: () => new Response("NO_NUMBERS") }); await assert.rejects(f.provider.getNumber()); assert(f.buys().every(u => u.searchParams.get("country") === "1001"));
});
await run("global no-stock fallback exhausts Gold before Silver", async () => {
  const f = fixture({ selectionMode: "global", purchase: u => new Response(u.searchParams.get("providerIds") === "3328" ? "ACCESS_NUMBER:paid:5511999999999" : "NO_NUMBERS") });
  const order = await f.provider.getNumber(); assert.equal(order.rank, "silver"); assert.deepEqual(f.buys().map(u => [u.searchParams.get("country"), u.searchParams.get("providerIds")]), [["73", "3243"], ["73", "3253"], ["1001", "3253"], ["73", "3328"]]);
});
await run("estimate snapshot not reused for purchases", async () => {
  const f = fixture({ selectionMode: "global" }); await f.provider.estimateNumberAvailability(); f.prices[73].dr[3243].price = "0.05"; const order = await f.provider.getNumber(); assert.equal(order.providerId, "3253"); assert.equal(order.country, "73"); assert.equal(f.calls.filter(u => u.searchParams.get("action") === "getPricesV3").length, 2);
});
await run("same provider in different countries counted separately", async () => {
  const f = fixture({ selectionMode: "global" }); const e = await f.provider.estimateNumberAvailability(); assert.equal(e.byRank.gold, 22);
});
await run("empty stock returns zero instead of error or order", async () => {
  const f = fixture({ selectionMode: "global", empty: true }); assert.equal((await f.provider.estimateNumberAvailability()).totalCount, 0); await assert.rejects(f.provider.getNumber()); assert.equal(f.buys().length, 0);
});
await run("unknown rank and unsafe stock count excluded", async () => {
  const f = fixture({ selectionMode: "global" }); delete f.catalog.services[247].countries["internal-73"].positions[3243].rank; f.prices[1001].dr[3253].count = 1.5; assert.equal((await f.provider.estimateNumberAvailability()).totalCount, 79);
});
await run("catalogue failure is an error, not fake zero", async () => {
  const f = fixture({ selectionMode: "global", catalogFail: true }); await assert.rejects(f.provider.estimateNumberAvailability(), /等级数据读取失败/); assert.equal(f.buys().length, 0);
});
await run("known paid malformed order retains actual country", async () => {
  const f = fixture({ selectionMode: "global", purchase: () => Response.json({ activationId: "broken", activationCost: "0.01" }) }); await assert.rejects(f.provider.getNumber(), e => e.smsOrder?.country === "73" && e.smsOrder.countryName === "Brazil"); assert.equal(f.buys().length, 1);
});
for (const mode of ["invalid", "GLOBAL", "all"]) await run("invalid mode " + mode, async () => assert.throws(() => fixture({ selectionMode: mode }), /选号方式/));
await run("global mode ignores an inactive saved country", async () => assert.equal((await fixture({ selectionMode: "global", country: "invalid" }).provider.getNumber()).country, "73"));
console.log(`SMSBOWER_MODES_PASS ${passed} cases; fixed-country preserved; global rank+price ordering; qualified stock totals=96/60; estimates read-only; fresh purchase data; actual country logs`);
