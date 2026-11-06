import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { seedWebSession } from "./account-web-fixture.mjs";
import { mergeSecurityState } from "../src/account-security.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-password-status-")), outputPath = path.join(root, "sub2api-import-oauth.json");
let mode = "existing", requests = [];
const upstream = http.createServer((req, res) => {
  requests.push(req.method + " " + req.url); res.setHeader("content-type", "application/json");
  assert.equal(req.method, "GET"); assert.equal(req.headers["chatgpt-account-id"], "workspace");
  if (req.url.endsWith("/mfa_info")) {
    if (mode === "mfa-error") { res.statusCode = 503; return res.end("{}"); }
    return res.end(JSON.stringify({ mfa_enabled_v2: true, password_enabled: false }));
  }
  if (req.url.endsWith("/change_password/eligibility")) {
    if (mode === "password-error") { res.statusCode = 403; return res.end("{}"); }
    return res.end(JSON.stringify({ eligible: ["existing", "mfa-error"].includes(mode) ? true : mode === "malformed" ? "true" : false }));
  }
  if (req.url.endsWith("/add_password/eligibility")) return res.end(JSON.stringify({ eligible: mode === "new" }));
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
process.env.TOSUB2_SESSION_NATIVE_HTTP = "1";
process.env.CHATGPT_BASE = `http://127.0.0.1:${upstream.address().port}`;
const { readAccountSecurityState } = await import("../src/account-sessions.mjs");
try {
  const original = JSON.stringify({ accounts: [{ credentials: { email: "fixture@example.test", chatgpt_account_id: "workspace" } }] });
  await fs.writeFile(outputPath, original); await seedWebSession(outputPath);
  const job = { outputPath, email: "fixture@example.test" };
  let state = await readAccountSecurityState(job); assert.equal(state.passwordEnabled, true); assert.equal(state.totpEnabled, true);
  assert(!requests.some(r => r.includes("add_password")), "existing-password proof issued unnecessary Add query");
  mode = "new"; state = await readAccountSecurityState(job); assert.equal(state.passwordEnabled, false); assert(state.passwordCheckedAt);
  for (mode of ["neither", "malformed", "password-error"]) {
    state = await readAccountSecurityState(job); assert.equal(state.passwordEnabled, null); assert.equal(state.passwordCheckedAt, null);
    assert.equal(mergeSecurityState({ passwordEnabled: true, passwordCheckedAt: "2026-11-01T00:00:00Z" }, state).passwordEnabled, true);
  }
  mode = "mfa-error"; state = await readAccountSecurityState(job); assert.equal(state.passwordEnabled, true); assert.equal(state.totpEnabled, null);
  assert.equal(await fs.readFile(outputPath, "utf8"), original);
  console.log("PASSWORD_STATUS_PASS change eligible confirms existing; add eligible confirms absent; both false/malformed/403 unknown; MFA and password failures isolated; GET-only; no OAuth mutation");
} finally { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true }); }
