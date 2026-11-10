import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { seedWebSession } from "./account-web-fixture.mjs";
import { readCredentialHistory } from "../src/account-history.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-space-history-http-"));
const outputPath = path.join(root, "sub2api-import-oauth.json");
await fs.writeFile(outputPath, JSON.stringify({ accounts: [{ credentials: { chatgpt_account_id: "team" } }] }));
await seedWebSession(outputPath);
let mode = "initial";
const personal = { id: "personal", structure: "personal", plan_type: "free" }, team = { id: "team", name: "Team", structure: "workspace", plan_type: "business_premium" };
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  assert.equal(req.url, "/backend-api/accounts/check/v4-2023-04-27");
  assert.equal(req.headers["chatgpt-account-id"], undefined, "discovery must allow deactivated workspace fallback");
  if (mode === "error") { res.statusCode = 503; res.end(JSON.stringify({ error: "fixture outage" })); return; }
  if (mode === "malformed") { res.end(JSON.stringify({ ok: true })); return; }
  res.end(JSON.stringify({ accounts: mode === "removed" ? [personal] : [personal, mode === "disabled" ? { ...team, is_deactivated: true, error: { code: "deactivated_workspace" } } : team] }));
});
do { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); if (server.address().port > 10080) break; await new Promise(resolve => server.close(resolve)); } while (true);
process.env.TOSUB2_SESSION_NATIVE_HTTP = "1"; process.env.CHATGPT_BASE = `http://127.0.0.1:${server.address().port}`;
const { listAccountWorkspaces } = await import("../src/account-sessions.mjs");
const count = async () => (await readCredentialHistory(root)).filter(e => e.type === "workspaces");
try {
  await listAccountWorkspaces({ outputPath }); assert.equal((await count()).length, 1);
  await listAccountWorkspaces({ outputPath }); assert.equal((await count()).length, 1);
  mode = "error"; await assert.rejects(listAccountWorkspaces({ outputPath }), /503/); assert.equal((await count()).length, 1);
  mode = "malformed"; await listAccountWorkspaces({ outputPath }); assert.equal((await count()).length, 1);
  mode = "disabled"; await listAccountWorkspaces({ outputPath }); assert.equal((await count()).length, 2);
  mode = "removed"; await listAccountWorkspaces({ outputPath }); assert.equal((await count()).length, 3);
  assert((await count()).some(e => e.changes.removed.some(w => w.id === "team")));
  console.log("WORKSPACE_HISTORY_HTTP_PASS manual/probe discovery records real changes; duplicate probes, malformed data and 503 preserve previous history; disabled error code and removals retained");
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
