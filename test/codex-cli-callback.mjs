import assert from "node:assert/strict";
import { completeCliCallback, CLI_CALLBACK_SCRIPT } from "../src/codex-cli-callback.mjs";
const callback = "http://localhost:1455/auth/callback?code=private-code&state=private-state";
const success = "http://127.0.0.1:1455/success?id_token=private-token&codex_streamlined_login=true";
async function probe(responses, value = callback) {
  const calls = [];
  const result = await completeCliCallback(value, { fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options }); const response = responses.shift();
    if (response instanceof Error) throw response;
    assert(response, "unexpected extra fetch"); return response;
  } });
  assert(!/private-code|private-state|private-token/.test(JSON.stringify(result)));
  for (const c of calls) assert.equal(c.options.redirect, "manual");
  return { result, calls };
}
for (const status of [302, 303]) {
  const { result, calls } = await probe([new Response(null, { status, headers: { location: success } }), new Response("ok")]);
  assert.deepEqual(result, { ok: true, callbackStatus: status, successStatus: 200, followedSuccess: true });
  assert.equal(calls[1].url, success); assert.equal(calls[0].options.signal, calls[1].options.signal);
}
const relative = await probe([new Response(null, { status: 302, headers: { location: "/success?x=y" } }), new Response("ok")]);
assert.equal(relative.calls[1].url, "http://127.0.0.1:1455/success?x=y");
for (const location of ["https://example.com/success?id_token=private-token", "http://127.0.0.1:1456/success", "/cancel", "/auth/callback", "http://u:p@localhost:1455/success", "/success#fragment", "//example.com:1455/success"]) {
  const { result, calls } = await probe([new Response(null, { status: 302, headers: { location } })]);
  assert.equal(result.ok, false); assert.equal(result.code, "INVALID_DESTINATION"); assert.equal(calls.length, 1);
}
for (const value of ["not a URL", "https://localhost:1455/auth/callback", "http://example.com:1455/auth/callback", "http://localhost:1455/success", callback + "#fragment"]) {
  const { result, calls } = await probe([], value); assert.equal(result.ok, false); assert.equal(calls.length, 0);
}
assert.equal((await probe([new Response(null, { status: 302 })])).result.code, "MISSING_LOCATION");
assert.equal((await probe([new Response(null, { status: 500 })])).result.code, "HTTP_STATUS");
const loop = await probe([new Response(null, { status: 302, headers: { location: success } }), new Response(null, { status: 302, headers: { location: success } })]);
assert.equal(loop.result.ok, false); assert.equal(loop.calls.length, 2);
const page = await probe([new Response("sign-in error page")]);
assert.equal(page.result.ok, true); assert.equal(page.result.followedSuccess, false); assert.equal(page.calls.length, 1);
assert.equal((await probe([new Error("upstream private-token")])).result.code, "CONNECTION");
assert.equal((await probe([new DOMException("private-token", "TimeoutError")])).result.code, "TIMEOUT");
assert(CLI_CALLBACK_SCRIPT.includes(completeCliCallback.toString()), "container executes the exact tested function");
console.log("CLI_CALLBACK_PASS local success redirect, one hop, shared timeout, error response, destination validation, no secret diagnostics");
