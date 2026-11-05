import assert from "node:assert/strict";
import { createDirectPublicIpReader } from "../src/direct-public-ip.mjs";

let now = 1000, calls = 0, reply = "198.51.100.42";
const cached = createDirectPublicIpReader({ now: () => now, ttlMs: 100, retryMs: 20, fetchImpl: async () => { calls++; return Response.json({ ip: reply }); } });
assert.equal(cached.peek(), null);
assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => cached.read())), Array(20).fill(reply));
assert.equal(calls, 1, "concurrent requests must share a single lookup");
assert.equal(await cached.read(), reply); assert.equal(calls, 1);
now += 101; reply = "2001:db8::42";
assert.equal(cached.peek(), null, "expired address must not look current");
assert.equal(await cached.read(), reply); assert.equal(calls, 2);

let fallbackCalls = 0;
const fallback = createDirectPublicIpReader({ fetchImpl: async () => ++fallbackCalls === 1 ? Response.json({ ip: "<!DOCTYPE html>" }) : new Response("2001:db8::7\n") });
assert.equal(await fallback.read(), "2001:db8::7"); assert.equal(fallbackCalls, 2);

let failureCalls = 0;
const failed = createDirectPublicIpReader({ now: () => now, retryMs: 20, fetchImpl: async () => { failureCalls++; throw Error("offline"); } });
assert.deepEqual(await Promise.all([failed.read(), failed.read(), failed.read()]), [null, null, null]);
assert.equal(failureCalls, 2, "only one request per provider on concurrent failure");
await failed.read(); assert.equal(failureCalls, 2, "failed lookup needs backoff");
now += 21; await failed.read(); assert.equal(failureCalls, 4, "failed lookup can retry after backoff");

for (const body of [false, true]) {
  let aborted = 0;
  const slow = createDirectPublicIpReader({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted++; });
    const pending = () => new Promise(() => {});
    return body ? { ok: true, json: pending, text: pending } : pending();
  } });
  assert.equal(await slow.read(), null);
  assert.equal(aborted, 2, `${body ? "body" : "headers"} must obey per-provider deadline`);
}

now += 1000;
let freshCalls = 0;
const stale = createDirectPublicIpReader({ now: () => now, ttlMs: 10, fetchImpl: async () => ++freshCalls === 1 ? Response.json({ ip: "198.51.100.9" }) : new Response("upstream error", { status: 503 }) });
assert.equal(await stale.read(), "198.51.100.9");
now += 11; assert.equal(await stale.read(), null); assert.equal(stale.peek(), null, "failed refresh must not indefinitely reuse an old address");
console.log("DIRECT_IP_PASS server-only; IPv4/IPv6 validation; single-flight; TTL; failure backoff; headers/body deadlines; stale address cleared");
