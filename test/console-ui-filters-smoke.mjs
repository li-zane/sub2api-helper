import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { seedWebSession } from "./account-web-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-ui-filters-"));
const fixture = [
  { email: "workspace@example.test", status: "completed", plan_type: "free", workspace_plan_type: "business", remark: "Primary account" },
  { email: "free@example.test", status: "completed", plan_type: "free" },
  { email: "banned@example.test", status: "banned", plan_type: "free" },
];
for (const [index, account] of fixture.entries()) {
  const dir = path.join(root, `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, result_saved: true, created_at: "2026-11-01T00:00:00Z", ...account }));
  await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email: account.email, access_token: "fixture", refresh_token: "fixture" }, extra: {} }] }));
}
const listener = http.createServer();
// Use the ephemeral range, avoiding browser/Fetch's forbidden low ports.
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [process.env.UI_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
  windowsHide: true,
  env: { ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), SUB2API_MONITOR_ENABLED: "0", TOSUB2_CREDENTIAL_KEY: "ab".repeat(32) },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
const exited = new Promise(resolve => child.once("exit", resolve));
try {
  let boot;
  for (let i = 0; i < 150; i++) {
    try { boot = await (await fetch(base + "/api/bootstrap")).json(); break; } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(boot?.token, logs);
  const headers = { "x-console-token": boot.token, "content-type": "application/json" };
  const get = async suffix => {
    const response = await fetch(base + "/api/jobs" + suffix, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const all = await get("");
  assert.equal(all.jobs.find(job => job.email === fixture[0].email).planType, "business");
  const search = await get("?search=BUSINESS");
  assert.deepEqual(search.jobs.map(job => job.email), [fixture[0].email], "search must use the displayed workspace plan");
  assert.equal(search.filter.active, true);
  assert.equal(search.filter.search, "BUSINESS");
  assert.equal((await get("?search=primary")).jobs[0].email, fixture[0].email);
  assert.equal((await get("?webSession=valid")).pagination.total, 0);
  assert.equal((await get("?webSession=absent")).pagination.total, 2);
  assert.deepEqual((await get("?webSession=banned")).jobs.map(job => job.email), [fixture[2].email]);
  const locked = await get("?lockedOnly=true");
  assert.deepEqual(locked.jobs.map(job => job.email), [fixture[2].email]);
  assert.equal(locked.filter.lockedOnly, true);
  const response = await fetch(base + "/api/jobs/query", { method: "POST", headers, body: JSON.stringify({ emails: [fixture[0].email, fixture[1].email], search: "business", webSession: "absent" }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs.map(job => job.email), [fixture[0].email]);
  assert.equal((await get("?webSession=unavailable")).pagination.total,0,"unavailable is a supported Web state filter, not an ignored value");
  const token=`web.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,"https://api.openai.com/auth":{chatgpt_account_id:"old-team",chatgpt_plan_type:"team"}})).toString("base64url")}.signature`;
  const accountDir=path.join(root,"11111111-1111-4111-8111-000000000002");
  const session=await seedWebSession(path.join(accountDir,"sub2api-import-oauth.json"),{accessToken:token});
  session.web.workspaceId="personal";session.validation={status:"valid",verifiedAt:new Date().toISOString()};
  await fs.writeFile(path.join(accountDir,"web-session.json"),JSON.stringify({...session,version:1}));
  const pending=(await get("?search=free@example.test")).jobs[0];
  assert.equal(pending.planType,"free");assert.equal(pending.webCredentialSync.status,"pending_update");assert.equal(pending.webCredentialSync.webPlanType,"team",JSON.stringify({web:pending.webSessionStatus,sync:pending.webCredentialSync,read:pending.webSessionReadError}));
  assert(!JSON.stringify(pending).includes(token),"sync API never returns raw Web token");
  console.log("PASS: UI filters use effective workspace plan, case-insensitive search, remarks, Web state including read failures, locked state, active metadata, exact-email intersections and Free/old-Team credential sync");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await exited;
  await fs.rm(root, { recursive: true, force: true });
}
