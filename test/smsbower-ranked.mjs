import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { rankedFixtureData } from "./smsbower-ranked-fixture.mjs";
const { createSmsBowerClient } = await import(process.env.SMSBOWER_RANKED_SOURCE ? pathToFileURL(process.env.SMSBOWER_RANKED_SOURCE).href : "../src/smsbower.mjs");
let passed = 0;
const run = async (name, fn) => { await fn(); passed++; };
function fixture({ offers = [["gold", 3253, "0.018", 10], ["gold", 3243, "0.025", 4], ["silver", 3328, "0.01", 6], ["bronze", 3288, "0.005", 8]], purchase, catalogFailure } = {}) {
  const { catalog, prices } = rankedFixtureData("73");
  const positions = catalog.services[247].countries[9].positions = {}, providers = prices[73].dr = {};
  for (const [rank, id, price, count] of offers) { providers[id] = { provider_id: id, price, count }; positions[id] = { rank: { description: rank }, price, count, agent_ids: [id], agent_prices: { [id]: price } }; }
  const calls = [];
  const client = createSmsBowerClient({ apiKey: "fixture-private-key", fetchImpl: async (url, opts) => {
    const u = new URL(url); calls.push(u);
    if (u.searchParams.has("serviceId")) { assert(!u.searchParams.has("api_key")); assert(!opts.headers.cookie); if (catalogFailure) return new Response("down", { status: 503 }); return Response.json(catalog); }
    if (u.searchParams.get("action") === "getPricesV3") return Response.json(prices);
    return purchase ? purchase(u) : Response.json({ activationId: "order", phoneNumber: "12025550123", activationCost: u.searchParams.get("maxPrice") });
  } });
  return { client, calls, catalog, prices, purchases: () => calls.filter(u => ["getNumber", "getNumberV2"].includes(u.searchParams.get("action"))) };
}
await run("Gold before cheaper lower ranks and provider pinned", async () => {
  const f = fixture(), order = await f.client.getNumber("dr", "73", "0.04");
  assert.equal(f.purchases()[0].searchParams.get("providerIds"), "3253", "ranked purchase must pin the Gold provider");
  assert.equal(order.rank, "gold"); assert.equal(order.providerId, "3253"); assert.equal(f.purchases()[0].searchParams.get("country"), "73");
});
await run("no stock: all Gold then Silver then Bronze", async () => {
  const f = fixture({ purchase: u => new Response(u.searchParams.get("providerIds") === "3288" ? "ACCESS_NUMBER:order:12025550123" : "NO_NUMBERS") });
  const o = await f.client.getNumber("dr", "73", "0.04"); assert.equal(o.rank, "bronze"); assert.deepEqual(f.purchases().map(u => u.searchParams.get("providerIds")), ["3253", "3243", "3328", "3288"]);
});
await run("budget inclusive, too-expensive Gold skipped", async () => {
  const f = fixture(); const o = await f.client.getNumber("dr", "73", "0.010000"); assert.equal(o.rank, "silver"); assert.equal(o.quotedPrice, "0.01");
});
await run("no stock never raises budget or changes country", async () => {
  const f = fixture(); await assert.rejects(f.client.getNumber("dr", "73", "0.004999"), /价格上限内没有可用/); assert.equal(f.purchases().length, 0);
});
await run("unknown rank and zero stock skipped", async () => {
  const f = fixture({ offers: [["platinum", 1, ".001", 5], ["gold", 2, "0.001", 0], ["bronze", 3, "0.002", 5]] }); assert.equal((await f.client.getNumber("dr", "73", "0.04")).providerId, "3");
});
await run("catalogue failure stops without a purchase", async () => {
  const f = fixture({ catalogFailure: true }); await assert.rejects(f.client.getNumber("dr", "73", "0.04"), /等级数据读取失败/); assert.equal(f.purchases().length, 0);
});
for (const cap of ["", "0", "-1", "oops", "NaN", "1e2"]) await run("invalid budget " + cap, async () => {
  const f = fixture(); await assert.rejects(f.client.getNumber("dr", "73", cap), /最高价格/); assert.equal(f.calls.length, 0);
});
for (const mode of ["timeout", "http", "malformed", "balance", "missing-order"]) await run("ambiguous/terminal response stops: " + mode, async () => {
  const f = fixture({ purchase: () => { if (mode === "timeout") throw Object.assign(Error("timeout"), { name: "AbortError" }); return mode === "http" ? new Response("down", { status: 503 }) : mode === "malformed" ? new Response("broken") : mode === "balance" ? new Response("NO_BALANCE") : Response.json({ phoneNumber: "12025550123" }); } });
  await assert.rejects(f.client.getNumber("dr", "73", "0.04")); assert.equal(f.purchases().length, 1);
});
await run("explicit BAD_ACTION fallback retains provider and cap", async () => {
  const f = fixture({ purchase: u => new Response(u.searchParams.get("action") === "getNumberV2" ? "BAD_ACTION" : "ACCESS_NUMBER:legacy:12025550123") });
  await f.client.getNumber("dr", "73", "0.04"); assert.equal(f.purchases().length, 2); for (const u of f.purchases()) { assert.equal(u.searchParams.get("providerIds"), "3253"); assert.equal(u.searchParams.get("maxPrice"), "0.018"); }
});
for (const payload of [{ activationCost: "0.05" }, { activationCost: "0.01", currency: "EUR" }, { activationCost: "invalid" }, { phoneNumber: "invalid" }]) await run("paid invalid order preserved for durable cancel", async () => {
  const f = fixture({ purchase: () => Response.json({ activationId: "paid", phoneNumber: "12025550123", ...payload }) });
  await assert.rejects(f.client.getNumber("dr", "73", "0.04"), e => e.smsOrder?.requestId === "paid" && e.smsOrder.rank === "gold"); assert.equal(f.purchases().length, 1);
});
await run("country mapping is by API code not internal ID", async () => {
  const f = fixture(); f.catalog.services[247].countries[9].activate_org_code = "33"; await assert.rejects(f.client.getNumber("dr", "73", "0.04")); assert.equal(f.purchases().length, 0);
});
await run("conflicting and missing ranks never purchased", async () => {
  const f = fixture(); const pos = f.catalog.services[247].countries[9].positions; pos.conflict = { ...pos[3253], rank: { description: "bronze" } }; delete pos[3243].rank;
  assert.equal((await f.client.getNumber("dr", "73", "0.04")).rank, "silver");
});
await run("legacy malformed paid order is retained", async () => {
  const f = fixture({ purchase: u => new Response(u.searchParams.get("action") === "getNumberV2" ? "BAD_ACTION" : "ACCESS_NUMBER:paid-legacy:123") });
  await assert.rejects(f.client.getNumber("dr", "73", "0.04"), e => e.smsOrder?.requestId === "paid-legacy"); assert.equal(f.purchases().length, 2);
});
await run("account-specific discounted quote controls the budget", async () => {
  const f = fixture(); f.catalog.services[247].countries[9].positions[3253].agent_prices[3253] = "0.2";
  assert.equal((await f.client.getNumber("dr", "73", "0.02")).providerId, "3253");
});
await run("decimal boundary never rounds an over-budget quote down", async () => {
  const f = fixture({ offers: [["gold", 3253, "0.018000000001", 10], ["silver", 3328, "0.018", 10]] });
  assert.equal((await f.client.getNumber("dr", "73", "0.018")).rank, "silver");
});
console.log(`SMSBOWER_RANKED_PASS ${passed} cases; strict USD cap; Gold>Silver>Bronze; lowest-price within rank; provider pinned; no ambiguous repurchase; paid malformed order retained; metadata failure=no purchase`);
