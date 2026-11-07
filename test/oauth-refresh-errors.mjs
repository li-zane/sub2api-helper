import assert from "node:assert/strict";
import { refreshOAuthToken } from "../src/protocol-login.mjs";

let checks = 0;
for (const [status, body, invalid] of [
  [400, { error: "invalid_grant" }, true],
  [401, { error: { code: "refresh_token_expired" } }, true],
  [400, { error: "invalid_client" }, false],
  [429, { error: "rate_limit_exceeded" }, false],
  [503, { error: "invalid_grant" }, false],
  [502, "<html>gateway error</html>", false],
  [200, {}, false],
]) {
  const transport = { fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }) };
  await assert.rejects(() => refreshOAuthToken({ authBase: "https://auth.example.test", clientId: "fixture", refreshToken: "fixture", transport }),
    error => error.message.startsWith("REFRESH_TOKEN_INVALID:") === invalid && !error.message.includes("gateway error"));
  checks++;
}
console.log(`OAUTH_REFRESH_ERRORS_PASS ${checks}/${checks} only explicit expired/revoked tokens trigger login; 429/5xx/malformed responses retain credentials`);
