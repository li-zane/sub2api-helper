import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { writeAccountWebSession, saveProtocolWebSession } from "../src/account-web-session.mjs";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { readCredentialHistory } from "../src/account-history.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-durability-"));
const email = "retained@example.test", identity = await getAccountBrowserIdentity(email, { root: path.join(root, "identity") });
const file = path.join(root, "web-session.json"), job = { email, webSessionPath: file };
const jwt = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url")}.sig`;
const original = { email, identity, accessToken: "old-token", cookies: [{ name: "session", value: "original-cookie", domain: "127.0.0.1", path: "/", hostOnly: true }], web: {} };
let mode;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/session") {
    res.setHeader("set-cookie", `session=${mode === "error" ? "" : "rotated-cookie"}; Path=/${mode === "error" ? "; Max-Age=0" : ""}`);
    if (mode === "error") { res.statusCode = 503; return res.end(JSON.stringify({ error: "unavailable" })); }
    return res.end(JSON.stringify({ user: { email: mode === "mismatch" ? "other@example.test" : email }, accessToken: jwt, expires: "2030-01-01T00:00:00Z" }));
  }
  if (mode === "backend-error") { res.statusCode = 502; return res.end(JSON.stringify({ error: "backend unavailable" })); }
  res.end(JSON.stringify({ accounts: [{ id: "personal", structure: "personal", plan_type: "free" }] }));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const oldBase = process.env.CHATGPT_BASE, oldNative = process.env.TOSUB2_SESSION_NATIVE_HTTP;
process.env.CHATGPT_BASE = `http://127.0.0.1:${server.address().port}`; process.env.TOSUB2_SESSION_NATIVE_HTTP = "1";
const { listAccountWorkspaces } = await import("../src/account-sessions.mjs");
try {
  for (mode of ["error", "mismatch", "backend-error", "ok"]) {
    await writeAccountWebSession(file, original);
    if (mode === "ok") await listAccountWorkspaces(job, { forceWebRefresh: true });
    else await assert.rejects(listAccountWorkspaces(job, { forceWebRefresh: true }));
    const current = JSON.parse(await fs.readFile(file, "utf8"));
    if (["error", "mismatch"].includes(mode)) { assert.equal(current.accessToken, original.accessToken); assert.equal(current.cookies[0].value, "original-cookie"); }
    else { assert.equal(current.accessToken, jwt); assert.equal(current.cookies.find(c => c.name === "session").value, "rotated-cookie"); }
  }
  const events = await readCredentialHistory(root);
  assert(events.some(e => e.before?.cookies?.some(c => c.value === "original-cookie") && e.after?.cookies?.some(c => c.value === "rotated-cookie")));
  await saveProtocolWebSession(file, { browserIdentity: identity, jar: { toJSON: () => original.cookies } }, {});
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).accessToken, jwt, "OAuth save erased the verified Web access token");
  const hash = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  await writeAccountWebSession(file, { ...original, accessToken: "concurrent-success-token" });
  await assert.rejects(writeAccountWebSession(file, original, { expectedHash: hash }), /WEB_SESSION_UPDATE_CONFLICT/);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).accessToken, "concurrent-success-token", "late candidate replaced a concurrent successful refresh");
  const blocked = path.join(root, "blocked"); await fs.mkdir(blocked); await fs.writeFile(path.join(blocked, "credential-history"), "not a directory");
  const protectedFile = path.join(blocked, "web-session.json"); await fs.writeFile(protectedFile, JSON.stringify(original));
  const bytes = await fs.readFile(protectedFile, "utf8");
  await assert.rejects(writeAccountWebSession(protectedFile, { ...original, accessToken: "new" }));
  assert.equal(await fs.readFile(protectedFile, "utf8"), bytes, "history persistence failure overwrote current session");
  console.log("WEB_SESSION_DURABILITY_PASS error/mismatched jars discarded; verified cookie rotation persisted despite later backend error; old/new snapshots; OAuth save retains token; history fsync precedes replacement");
} finally {
  if (oldBase === undefined) delete process.env.CHATGPT_BASE; else process.env.CHATGPT_BASE = oldBase;
  if (oldNative === undefined) delete process.env.TOSUB2_SESSION_NATIVE_HTTP; else process.env.TOSUB2_SESSION_NATIVE_HTTP = oldNative;
  await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true });
}
