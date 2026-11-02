import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
import { reuseSavedWebLogin } from "../src/protocol-login.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-web-reuse-"));
const email = "reuse@example.test", file = path.join(root, "web-session.json");
const oldRoot = process.env.TOSUB2_BROWSER_IDENTITY_ROOT;
process.env.TOSUB2_BROWSER_IDENTITY_ROOT = path.join(root, "identities");
const identity = await getAccountBrowserIdentity(email);
let mode = "valid", calls = 0;
const server = http.createServer((req, res) => {
  calls++;
  assert.equal(req.url, "/api/auth/session", "reuse never visits sign-in, OTP or OAuth");
  assert.match(req.headers.cookie, /session=original/);
  assert.equal(req.headers["oai-device-id"], identity.deviceId);
  assert.equal(req.headers["oai-session-id"], identity.sessionId);
  assert.equal(req.headers["user-agent"], identity.browser.userAgent);
  res.setHeader("content-type", "application/json");
  if (mode === "401") { res.statusCode = 401; return res.end("{}"); }
  if (mode === "503") { res.statusCode = 503; return res.end("{}"); }
  if (mode === "html") return res.end("<html>challenge</html>");
  if (mode === "expired") return res.end("{}");
  res.setHeader("set-cookie", "renewed=next; Path=/");
  res.end(JSON.stringify({ accessToken: "web-token", user: { email: mode === "mismatch" ? "other@example.test" : email } }));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const options = { file, email, chatgptBase: `http://127.0.0.1:${server.address().port}` };
try {
  assert.equal(await reuseSavedWebLogin(options), null); assert.equal(calls, 0);
  await writeAccountWebSession(file, { email, identity, cookies: [{ name: "session", value: "original", domain: "127.0.0.1", path: "/", hostOnly: true }], web: { workspaceId: "personal" } });
  const original = await fs.readFile(file, "utf8");
  let result = await reuseSavedWebLogin(options);
  assert.equal(result.reused, true); assert.equal(result.web.workspaceId, "personal");
  assert.equal(result.client.jar.value("renewed", options.chatgptBase), "next");
  for (mode of ["expired", "401"]) {
    result = await reuseSavedWebLogin(options); assert.equal(result.reused, false);
    assert.equal(result.client.jar.value("session", options.chatgptBase), "original", "reauth keeps original browser jar");
    assert.equal(result.client.browserIdentity.deviceId, identity.deviceId);
  }
  for (mode of ["503", "html", "mismatch"]) await assert.rejects(reuseSavedWebLogin(options));
  assert.equal(await fs.readFile(file, "utf8"), original, "failed probes never overwrite saved session");
  const beforeMismatch = calls;
  await writeAccountWebSession(file, { ...JSON.parse(original), identity: { ...identity, deviceId: "11111111-1111-4111-8111-111111111111" } });
  await assert.rejects(reuseSavedWebLogin(options), /IDENTITY_MISMATCH/);
  assert.equal(calls, beforeMismatch, "mismatched device never reaches upstream");
  console.log("WEB REUSE PASS: cookies/device/session/browser preserved; valid skips sign-in; expired reauth keeps jar; transient/identity errors stop; saved state unchanged on failure");
} finally {
  await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true });
  if (oldRoot === undefined) delete process.env.TOSUB2_BROWSER_IDENTITY_ROOT; else process.env.TOSUB2_BROWSER_IDENTITY_ROOT = oldRoot;
}
