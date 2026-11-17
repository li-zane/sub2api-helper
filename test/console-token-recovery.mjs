import assert from "node:assert/strict";
import { createConsoleClient } from "../web/src/console-api.mjs";

const base = "http://helper.test/";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const invalid = () => json({ error: "Invalid console token", code: "INVALID_CONSOLE_TOKEN" }, 403);
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = async predicate => {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 1)); }
  throw Error("test did not reach expected state");
};
const auth = { headers: { "x-console-token": "old" } };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log("PASS: " + name); }
function fixture(handler, bootstrap = () => json({ token: "new" })) {
  const calls = [], client = createConsoleClient({ baseUrl: base, fetch: async (input, options) => {
    const request = input instanceof Request ? input : new Request(new URL(input, base), options);
    request.signal.throwIfAborted(); calls.push(request);
    return new URL(request.url).pathname === "/api/bootstrap" ? bootstrap(request) : handler(request);
  } });
  return { client, calls, boots: () => calls.filter(r => r.url.endsWith("/api/bootstrap")).length };
}

await test("stale token refreshes and rejected write executes exactly once", async () => {
  let actions = 0;
  const f = fixture(r => { if (r.headers.get("x-console-token") !== "new") return invalid(); actions++; return json({ ok: true }); });
  assert.equal((await f.client.fetch("/api/jobs/query", { ...auth, method: "POST", body: "{}" })).status, 200);
  assert.equal(f.boots(), 1); assert.equal(actions, 1); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.find(r => r.url.endsWith("bootstrap")).cache, "no-store");
});
await test("32 concurrent failures share one refresh", async () => {
  const gate = pending(); let actions = 0;
  const f = fixture(r => { if (r.headers.get("x-console-token") !== "new") return invalid(); actions++; return json({ ok: true }); }, async () => { await gate.promise; return json({ token: "new" }); });
  const requests = Array.from({ length: 32 }, () => f.client.fetch("/api/jobs/query", { ...auth, method: "POST", body: "{}" }));
  await wait(() => f.boots() === 1); gate.resolve();
  assert((await Promise.all(requests)).every(r => r.ok)); assert.equal(f.boots(), 1); assert.equal(actions, 32);
});
await test("late stale response reuses completed refresh", async () => {
  const slow = pending();
  const f = fixture(async r => {
    if (r.headers.get("x-console-token") === "new") return json({ ok: true });
    if (r.url.endsWith("/slow")) await slow.promise;
    return invalid();
  });
  const delayed = f.client.fetch("/api/slow", auth);
  assert((await f.client.fetch("/api/fast", auth)).ok); slow.resolve(); assert((await delayed).ok); assert.equal(f.boots(), 1);
});
await test("old React token props use newest cached token", async () => {
  const f = fixture(r => r.headers.get("x-console-token") === "new" ? json({ ok: true }) : invalid());
  await f.client.bootstrap();
  for (let i = 0; i < 5; i++) assert((await f.client.fetch("/api/jobs", auth)).ok);
  assert.equal(f.boots(), 1); assert.equal(f.calls.length, 6);
});
await test("persistent rejection retries once", async () => {
  const f = fixture(invalid); const response = await f.client.fetch("/api/jobs", auth);
  assert.equal(response.status, 403); assert.equal((await response.json()).code, "INVALID_CONSOLE_TOKEN");
  assert.equal(f.boots(), 1); assert.equal(f.calls.length, 3);
});
for (const status of [401, 403, 429, 500]) await test(`ordinary HTTP ${status} does not refresh or replay`, async () => {
  const f = fixture(() => json({ error: "ordinary error" }, status));
  const response = await f.client.fetch("/api/jobs/query", { ...auth, method: "POST", body: "{}" });
  assert.equal(response.status, status); assert.equal(f.calls.length, 1); assert.equal(f.boots(), 0);
});
await test("HTML 403 body remains readable", async () => {
  const f = fixture(() => new Response("<html>Forbidden</html>", { status: 403 }));
  assert.equal(await (await f.client.fetch("/api/jobs", auth)).text(), "<html>Forbidden</html>"); assert.equal(f.boots(), 0);
});
await test("legacy exact error remains compatible", async () => {
  const f = fixture(r => r.headers.get("x-console-token") === "new" ? json({ ok: true }) : json({ error: "Invalid console token" }, 403));
  assert((await f.client.fetch("/api/jobs", auth)).ok); assert.equal(f.boots(), 1);
});
await test("another machine error code cannot trigger a write replay", async () => {
  const f = fixture(() => json({ error: "Invalid console token", code: "BUSINESS_FORBIDDEN" }, 403));
  assert.equal((await f.client.fetch("/api/jobs/query", { ...auth, method: "POST", body: "{}" })).status, 403);
  assert.equal(f.calls.length, 1); assert.equal(f.boots(), 0);
});
await test("Request JSON body, credentials, headers and binary download survive replay", async () => {
  const bodies = [];
  const f = fixture(async r => {
    bodies.push(await r.text()); assert.equal(r.credentials, "include"); assert.equal(r.cache, "no-store");
    assert.equal(r.headers.get("x-custom"), "kept");
    return r.headers.get("x-console-token") === "new" ? new Response(new Uint8Array([0, 255, 1])) : invalid();
  });
  const request = new Request(base + "api/download", { method: "POST", credentials: "include", cache: "no-store",
    headers: { ...auth.headers, "content-type": "application/json", "x-custom": "kept" }, body: '{"ids":[1,2]}' });
  const response = await f.client.fetch(request);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 1]); assert.deepEqual(bodies, ['{"ids":[1,2]}', '{"ids":[1,2]}']);
});
await test("cross-origin and unauthenticated requests never inherit cached token", async () => {
  const f = fixture(r => { assert.equal(r.headers.get("x-console-token"), r.url.startsWith("https://other.test") ? "old" : null); return json({ ok: true }); });
  await f.client.bootstrap();
  await f.client.fetch("https://other.test/api/jobs", auth); await f.client.fetch("/api/jobs");
  assert.equal(f.boots(), 1);
});
await test("aborted waiter stops promptly without canceling another refresh waiter", async () => {
  const gate = pending(), controller = new AbortController(); let actions = 0;
  const f = fixture(r => { if (r.headers.get("x-console-token") !== "new") return invalid(); actions++; return json({ ok: true }); }, async () => { await gate.promise; return json({ token: "new" }); });
  const aborted = f.client.fetch("/api/jobs", { ...auth, signal: controller.signal });
  const rejection = assert.rejects(aborted, { name: "AbortError" });
  const surviving = f.client.fetch("/api/jobs", auth);
  await wait(() => f.boots() === 1); controller.abort(); await rejection;
  assert.equal(actions, 0); gate.resolve(); assert((await surviving).ok); assert.equal(f.boots(), 1); assert.equal(actions, 1);
});
await test("bootstrap failure clears shared promise so a later request recovers", async () => {
  let boots = 0;
  const f = fixture(r => r.headers.get("x-console-token") === "new" ? json({ ok: true }) : invalid(), () => ++boots === 1 ? json({ error: "temporarily unavailable" }, 503) : json({ token: "new" }));
  await assert.rejects(f.client.fetch("/api/jobs", auth), { status: 503 });
  assert((await f.client.fetch("/api/jobs", auth)).ok); assert.equal(f.boots(), 2);
});
await test("empty bootstrap token fails without replay", async () => {
  const f = fixture(invalid, () => json({ token: "" }));
  await assert.rejects(f.client.fetch("/api/jobs", auth), /访问令牌/); assert.equal(f.calls.length, 2);
});
await test("network failure never repeats a write", async () => {
  const f = fixture(() => { throw new TypeError("network failed"); });
  await assert.rejects(f.client.fetch("/api/jobs/query", { ...auth, method: "POST", body: "{}" }), /network failed/);
  assert.equal(f.calls.length, 1); assert.equal(f.boots(), 0);
});
await test("concurrent bootstrap calls share initialization", async () => {
  const gate = pending(); const f = fixture(() => json({ ok: true }), async () => { await gate.promise; return json({ token: "new" }); });
  const a = f.client.bootstrap(), b = f.client.bootstrap(); gate.resolve();
  await Promise.all([a, b]); assert.equal(f.boots(), 1);
});
console.log(`CONSOLE_TOKEN_UNIT_PASS cases=${passed}`);
