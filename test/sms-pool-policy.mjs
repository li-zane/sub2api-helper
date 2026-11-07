import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { smsBowerModesFixture } from "./smsbower-modes-fixture.mjs";
import { createSmsPoolPolicy, restoreSmsPoolPolicy, excludedSmsPools, recordSmsPoolFailure, isVirtualSmsPool, smsPoolKey, normalizeSmsPoolRoute } from "../src/sms-pool-policy.mjs";
import { normalizeSmsSettings, emptySmsSettings } from "../src/sms-settings.mjs";
const { createSmsProvider } = await import(process.env.SMS_POOL_SOURCE ? pathToFileURL(process.env.SMS_POOL_SOURCE).href : "../src/sms-providers.mjs");
let passed = 0; const run = async (name, fn) => { await fn(); passed++; };
function fixture({ selectionMode = "global", country = "1001", excluded = [] } = {}) {
  const { prices, catalog } = smsBowerModesFixture(), calls = [];
  prices[12] = { dr: { 3209: { provider_id: 3209, price: "0.004", count: 1000 } } };
  catalog.services[247].countries.virtual = { activate_org_code: "12", title: "United States (virtual)", positions: { first: { rank: { description: "gold" }, count: 1000, price: "0.004", agent_ids: [3209] } } };
  catalog.services[247].countries["internal-73"].id = 12;
  const config = { apiKey: "fixture-private-key", service: "dr", selectionMode, country, maxPrice: "0.04" };
  const provider = createSmsProvider("smsbower", config, { fetchImpl: async url => {
    const u = new URL(url); calls.push(u);
    if (u.searchParams.has("serviceId")) return Response.json(catalog);
    if (u.searchParams.get("action") === "getPricesV3") return Response.json(u.searchParams.has("country") ? { [country]: prices[country] } : prices);
    if (u.searchParams.get("action") === "getPrices") return Response.json({ 12: { dr: { cost: 0.004, count: 1000 } }, 73: { dr: { cost: 0.02, count: 12 } } });
    if (u.searchParams.get("action") === "getCountries") return Response.json({ 12: { id: 12, eng: "United States (virtual)" }, 73: { id: 73, eng: "Brazil" } });
    return Response.json({ activationId: "paid", phoneNumber: "5511999999999", activationCost: u.searchParams.get("maxPrice") });
  } });
  return { provider, calls, config, catalog, prices, buy: () => provider.getNumber({ excludedPools: excluded }), buys: () => calls.filter(u => ["getNumber", "getNumberV2"].includes(u.searchParams.get("action"))) };
}
await run("virtual Gold cheapest excluded before purchase", async () => {
  const f = fixture(), o = await f.buy(); assert.equal(o.country, "73", "virtual country 12 must be excluded before buying a number"); assert.equal(o.providerId, "3243"); assert.equal(f.buys().length, 1);
});
await run("virtual stock excluded from estimate and price choices", async () => {
  const f = fixture(); assert.equal((await f.provider.estimateNumberAvailability()).totalCount, 96); assert.deepEqual((await f.provider.listNumberOptions()).map(o => o.country), ["73"]); assert.equal(f.buys().length, 0);
});
await run("fixed virtual country cannot silently cross border", async () => {
  const f = fixture({ selectionMode: "country", country: "12" }); await assert.rejects(f.buy(), /虚拟号码池/); assert.equal((await f.provider.estimateNumberAvailability()).totalCount, 0); assert.equal(f.calls.length, 0);
});
await run("failed pool excluded but ordering and budget retained", async () => {
  const f = fixture({ excluded: ["dr|73|3243"] }), o = await f.buy(); assert.equal(o.country, "73"); assert.equal(o.providerId, "3253"); assert.equal(o.quotedPrice, "0.035");
});
await run("pool identity includes country and service", async () => {
  const f = fixture({ excluded: ["dr|1001|3243", "ot|73|3243"] }); assert.equal((await f.buy()).providerId, "3243");
});
await run("unknown virtual name and provider flags excluded", async () => {
  const f = fixture(); f.catalog.services[247].countries["internal-73"].title = "Test VoIP"; assert.equal((await f.buy()).country, "1001");
  const g = fixture(); g.prices[73].dr[3243].is_virtual = true; assert.equal((await g.buy()).providerId, "3253");
});
for (const record of [{ title: "Virtual" }, { chn: "美国（虚拟）" }, { is_virtual: true }, { isVirtual: 1 }, { virtual: "1" }, { number_type: "voip" }]) await run("explicit virtual marker " + JSON.stringify(record), async () => assert(isVirtualSmsPool(record, "73")));
for (const record of [{ id: 12, activate_org_code: "2", title: "Kazakhstan" }, { title: "United States (non-virtual)" }, { chn: "非虚拟号码" }, { is_virtual: "false" }]) await run("no inferred virtual marker " + JSON.stringify(record), async () => assert(!isVirtualSmsPool(record, "187")));
await run("default threshold 2 and exact boundary", async () => {
  const p = createSmsPoolPolicy("attempt"), route = { service: "dr", country: "73", providerId: "3243", requestId: "one" };
  assert.equal(recordSmsPoolFailure(p, route, "invalid phone").excluded, false); assert.deepEqual(excludedSmsPools(p), []);
  assert.equal(recordSmsPoolFailure(p, { ...route, requestId: "two" }, "invalid phone").excluded, true); assert.deepEqual(excludedSmsPools(p), ["dr|73|3243"]);
});
await run("duplicate callbacks count the same order once", async () => {
  const p = createSmsPoolPolicy("attempt"), route = { country: "73", providerId: "3243", requestId: "one" };
  recordSmsPoolFailure(p, route, "invalid phone"); assert.equal(recordSmsPoolFailure(p, route, "invalid phone"), null); assert.equal(p.failures["dr|73|3243"], 1);
});
await run("VoIP refusal immediately blocks at threshold10", async () => {
  const p = createSmsPoolPolicy("attempt"), route = { country: "73", providerId: "3243", requestId: "one" };
  const r = recordSmsPoolFailure(p, route, "HTTP400: voip_phone_disallowed", 10); assert(r.immediate && r.excluded); assert.deepEqual(excludedSmsPools(p, 10), ["dr|73|3243"]);
});
await run("threshold configurable without cross-account sharing", async () => {
  const a = createSmsPoolPolicy("a"), b = createSmsPoolPolicy("b"), route = { country: "73", providerId: "3243", requestId: "one" };
  assert(recordSmsPoolFailure(a, route, "invalid phone", 1).excluded); assert.deepEqual(excludedSmsPools(b, 1), []); assert.deepEqual(excludedSmsPools(createSmsPoolPolicy("new-attempt"), 1), []);
});
await run("private checkpoint restores policy and dedupe", async () => {
  const p = createSmsPoolPolicy("attempt"), route = { country: "73", providerId: "3243", requestId: "one" }; recordSmsPoolFailure(p, route, "voip_phone_disallowed", 10);
  const restored = restoreSmsPoolPolicy(JSON.parse(JSON.stringify(p))); assert.deepEqual(excludedSmsPools(restored, 10), ["dr|73|3243"]); assert.equal(recordSmsPoolFailure(restored, route, "invalid phone"), null); assert.equal(restoreSmsPoolPolicy(null), null);
});
await run("route record contains no credentials", async () => {
  const route = normalizeSmsPoolRoute({ country: "73", providerId: "3243", requestId: "one", apiKey: "secret", countryName: "Brazil\n" }); assert.equal(route.countryName, "Brazil "); assert(!JSON.stringify(route).includes("secret")); assert.equal(smsPoolKey({}), null);
});
await run("settings default2 strict1to10 and legacy migration", async () => {
  assert.equal(emptySmsSettings().maxFailuresPerPool, 2); const config = fixture().config;
  const old = { selectedProviderId: "smsbower", autoAcquire: true, maxAutoNumbers: 8, configs: { smsbower: config } }; assert.equal(normalizeSmsSettings(old).maxFailuresPerPool, 2); assert.equal(normalizeSmsSettings(old).maxAutoNumbers, 8);
  for (const v of [0, 11, 1.5, "2", false, ""]) assert.throws(() => normalizeSmsSettings({ ...old, maxFailuresPerPool: v }), /阈值/);
  for (const v of [1, 3, 10]) assert.equal(normalizeSmsSettings({ ...old, maxFailuresPerPool: v }).maxFailuresPerPool, v);
});
console.log(`SMS_POOL_POLICY_PASS ${passed} cases; virtual excluded before purchase/estimate/options; scoped failure threshold; VoIP immediate; dedupe; checkpoint; strict setting migration`);
