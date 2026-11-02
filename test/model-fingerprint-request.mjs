import assert from "node:assert/strict";
import { createFingerprintSampler, createFingerprintAccountReader, extractFingerprintReply, fingerprintFailure } from "../src/model-fingerprint-request.mjs";
const readCalls = [];
const reader = createFingerprintAccountReader(async (_config, endpoint) => {
  readCalls.push(endpoint);
  if (endpoint === "/api/v1/admin/accounts/9") return { data: { id: 9, name: "fixture", type: "oauth", platform: "openai", proxy_id: 7, credentials: { email: "fixture@example.test" } } };
  assert.equal(endpoint, "/api/v1/admin/accounts/data?ids=9&include_proxies=true");
  return { data: { accounts: [{ name: "fixture", type: "oauth", platform: "openai", credentials: { email: "fixture@example.test", access_token: "export-token" }, proxy_key: "exact-key" }], proxies: [{ proxy_key: "exact-key", protocol: "http", host: "proxy.fixture", port: 8000, username: "fixed", password: "secret" }] } };
});
const exported = await reader({}, 9);
assert.equal(exported.credentials.access_token, "export-token"); assert.equal(exported.fingerprintProxyUrl, "http://fixed:secret@proxy.fixture:8000/"); assert.equal(readCalls.length, 2);
const badExport = createFingerprintAccountReader(async (_config, endpoint) => endpoint.includes("/data?") ? { accounts: [{ name: "wrong", type: "oauth", platform: "openai" }] } : { id: 9, name: "fixture", type: "oauth", platform: "openai", credentials: {} });
await assert.rejects(badExport({}, 9), /不匹配/);
let configured, sent, closed = 0;
const response = [{ type: "response.output_text.delta", delta: "1, 2, 3" }, { type: "response.completed", response: {} }].map(x => "data: " + JSON.stringify(x)).join("\n\n");
const sample = createFingerprintSampler({ getProxies: async () => [{ id: 7, url: "http://fixed:secret@proxy.fixture:8000" }], getAccount: async () => ({ type: "oauth", credentials: { access_token: "parent-token", chatgpt_account_id: "parent-id" } }), transportFactory: () => ({ configure: async url => { configured = url; }, request: async (method, url, options) => { sent = { method, url, ...options }; return { ok: true, text: async () => response }; }, close: async () => { closed++; } }) });
const account = { type: "oauth", proxy_id: 7, credentials: { access_token: "token", chatgpt_account_id: "account-id", model_mapping: { alias: "gpt-5.5" } } };
assert.equal(await sample({}, account, "alias", "specific numeric prompt", new AbortController().signal), "1, 2, 3");
assert.equal(configured, "http://fixed:secret@proxy.fixture:8000"); assert.equal(sent.headers.authorization, "Bearer token"); assert.equal(sent.headers["chatgpt-account-id"], "account-id");
assert.equal(sent.url, "https://chatgpt.com/backend-api/codex/responses");
assert.equal(sent.timeoutMs,180000,"slow reasoning responses have three minutes to finish");
const body = JSON.parse(sent.body); assert.equal(body.model, "gpt-5.5"); assert.equal(body.input[0].content[0].text, "specific numeric prompt"); assert.equal(body.store, false); assert(!Object.hasOwn(body, "max_output_tokens")); assert.equal(closed, 1);
await sample({}, { parent_account_id: 2, proxy_id: 0 }, "gpt-5.5", "probe", new AbortController().signal); assert.equal(configured, null); assert.equal(sent.headers.authorization, "Bearer parent-token");
await assert.rejects(sample({}, { ...account, proxy_id: 999 }, "alias", "probe", new AbortController().signal), /代理/);
assert.throws(() => extractFingerprintReply('data: {"type":"response.output_text.delta","delta":"1, 2"}'), /未完成/);
assert.throws(() => extractFingerprintReply('data: {"type":"response.failed"}'), /未完成/);
assert.throws(() => extractFingerprintReply(JSON.stringify({ status: "incomplete", output: [{ content: [{ type: "output_text", text: "1, 2" }] }] })), /未完成/);
assert.equal(extractFingerprintReply(JSON.stringify({ output: [{ content: [{ type: "output_text", text: "5, 6" }] }] })), "5, 6");
console.log("PASS: exact account token, fixed proxy/direct route, parent credentials, model mapping, original prompt, no OAuth output-limit override, SSE completion and no fallback on missing proxy");
for (const [status, code, retryable] of [[401,"AUTH",false],[429,"QUOTA",false],[503,"UPSTREAM",true]]) {
  const failing = createFingerprintSampler({ transportFactory: () => ({ configure: async()=>{}, close: async()=>{}, request: async()=>({ok:false,status,text:async()=>JSON.stringify({error:{message:"private-token https://secret.fixture"}})}) }) });
  await assert.rejects(failing({}, {...account,proxy_id:0}, "model", "prompt", new AbortController().signal), error => {
    const detail=fingerprintFailure(error); assert.equal(detail.code,code); assert.equal(detail.httpStatus,status); assert.equal(detail.retryable,retryable); assert(!JSON.stringify(detail).includes("private-token")); return true;
  });
}
assert.throws(()=>extractFingerprintReply('data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"private-token"}}}'), error => fingerprintFailure(error).code === "QUOTA");
assert.throws(()=>extractFingerprintReply('data: {"type":"response.failed","response":{"error":{"code":"overloaded"}}}'), error => fingerprintFailure(error).retryable);
assert.throws(()=>extractFingerprintReply('data: {"type":"error","error":{"code":"server_is_overloaded","type":"service_unavailable_error","message":"Our servers are currently overloaded. Please try again later."}}'), error => fingerprintFailure(error).upstreamCode === "server_is_overloaded" && fingerprintFailure(error).code === "OVERLOADED");
assert.equal(fingerprintFailure(new Error('curl (28) operation timed out https://private.fixture')).code,"TIMEOUT");
const streamError = createFingerprintSampler({transportFactory:()=>({configure:async()=>{},close:async()=>{},request:async()=>({ok:true,status:200,text:async()=> 'data: {"type":"error","error":{"code":"server_is_overloaded"}}'})})});
await assert.rejects(streamError({}, {...account,proxy_id:0},'model','prompt',new AbortController().signal),error=>fingerprintFailure(error).code==='OVERLOADED'&&fingerprintFailure(error).httpStatus===200);
assert(!JSON.stringify(fingerprintFailure(new Error('private-token'))).includes('private-token'));
console.log("PASS: HTTP/SSE quota, auth, overload, timeout diagnostics and secret-free errors");
