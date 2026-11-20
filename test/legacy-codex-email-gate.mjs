import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { legacyCodexEmailGate } from "../src/codex-email-gate.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-email-gate-"));
const index = path.join(root, "operation-logs");
let offset = 0;
async function record(type, status, message) {
  const start = offset, bytes = Buffer.from(message + "\n");
  offset += bytes.length;
  await fs.appendFile(path.join(root, "account.log"), bytes);
  await fs.writeFile(path.join(index, randomUUID() + ".json"),
    JSON.stringify({ type, status, start, end: offset, at: new Date(1000 * offset).toISOString() }));
}
try {
  await fs.mkdir(index);
  const prompt = "Email OTP (r=resend, q=quit): [login-timeout] LOGIN_TIMEOUT";
  await record("relogin", "failed", "[codex-auth-login]");
  await record("relogin", "failed", prompt);
  assert.equal(await legacyCodexEmailGate(root), null, "markers from separate attempts");
  await record("relogin", "failed", "[codex-auth-login]\n[auth-expired]\n" + prompt);
  assert.equal(await legacyCodexEmailGate(root), null, "returned to Web login");
  await record("reauthorize", "failed", "[codex-auth-login]\n" + prompt);
  await record("pool_refresh", "failed", "LOGIN_TIMEOUT");
  await record("web_login", "completed", "Web session saved");
  assert.equal((await legacyCodexEmailGate(root)).required, true);
  await record("reauthorize", "completed", "Authorization saved");
  assert.equal((await legacyCodexEmailGate(root)).required, false);
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log("LEGACY_CODEX_EMAIL_GATE_PASS");
