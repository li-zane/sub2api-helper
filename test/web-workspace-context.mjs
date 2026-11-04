import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = path.resolve(process.env.WORKSPACE_CONTEXT_ROOT || ".");
const load = name => import(pathToFileURL(path.join(source, "src", name)));
const { probeAccountWebSession, listAccountSessions, listAccountWorkspaces } = await load("account-sessions.mjs");
const { writeAccountWebSession, readAccountWebSession } = await load("account-web-session.mjs");
const { getAccountBrowserIdentity } = await load("account-browser-identity.mjs");
const { WebSessionMonitor } = await load("web-session-monitor.mjs");
const { identifyWebPlan } = await load("protocol-login.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-workspace-context-"));
process.env.TOSUB2_SESSION_NATIVE_HTTP = "1";
const email = "context@example.test", outputPath = path.join(root, "sub2api-import-oauth.json");
const job = { email, outputPath, planType: "free" };
const identity = await getAccountBrowserIdentity(email, { root: path.join(root, "identities") });
const oauth = JSON.stringify({ accounts: [{ credentials: { email, access_token: "unchanged-Codex", chatgpt_account_id: "personal", plan_type: "free" } }] });
const jwt = workspaceId => `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, "https://api.openai.com/auth": { chatgpt_account_id: workspaceId } })).toString("base64url")}.signature`;
const listing = { current_account_id: "personal", accounts: [
  { id: "dead-team", structure: "workspace", plan_type: "business", is_deactivated: true },
  { id: "personal", structure: "personal", plan_type: "free" },
] };
let tokenId = "dead-team", deviceStatus = 402, code = "deactivated_workspace", deviceReads = 0;
const server = http.createServer((req,res) => {
  res.setHeader("content-type","application/json");
  if (req.url === "/api/auth/session") return res.end(JSON.stringify({ accessToken: jwt(tokenId), user: { email } }));
  if (req.url.endsWith("/accounts/check/v4-2023-04-27")) return res.end(JSON.stringify(listing));
  if (req.url.startsWith("/backend-api/accounts/sessions")) {
    deviceReads++; res.statusCode = deviceStatus;
    return res.end(JSON.stringify(deviceStatus === 200 ? { devices: [{ session_id: "current", display_name: "Original browser", is_current_device: true }] } : { error: { code, message: "Payment Required" } }));
  }
  res.statusCode=404;res.end("{}");
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base=`http://127.0.0.1:${server.address().port}`;
process.env.CHATGPT_BASE=base;
const webFile=path.join(root,"web-session.json");
async function seed() {
  await writeAccountWebSession(webFile,{ email,identity,web:{workspaceId:"personal"},accessToken:jwt(tokenId),
    validation:{status:"valid"},cookies:[{name:"session",value:"persistent",domain:"127.0.0.1",path:"/",hostOnly:true}] });
}
let monitor;
try {
  await fs.writeFile(outputPath,oauth);await seed();
  const snapshot=await probeAccountWebSession(job);
  assert.equal(snapshot.repairReason,"web_workspace_unavailable","token's deactivated team must override healthy personal metadata");
  assert.equal(deviceReads,0,"confirmed workspace listing detects context loss without failing device request");
  assert.equal((await readAccountWebSession(job)).validation.reason,"workspace_unavailable");
  await assert.rejects(listAccountSessions(job), e=>/^SESSION_WORKSPACE_UNAVAILABLE:/.test(e.message) && e.providerCode===code && e.remoteStatus===402);
  await listAccountWorkspaces(job);
  assert.equal(job.webSessionStatus,"expired","successful account discovery must not mark the dead token healthy");
  tokenId="personal";
  for (const [status,errorCode] of [[402,"billing_required"],[403,"deactivated_workspace"],[503,"deactivated_workspace"]]) {
    deviceStatus=status;code=errorCode;await seed();
    await assert.rejects(listAccountSessions(job),/^Error: SESSION_PROVIDER_ERROR:/);
    assert.notEqual((await readAccountWebSession(job)).validation.status,"expired","only confirmed 402 workspace errors invalidate Web context");
  }
  deviceStatus=402;code="workspace_deactivated";await seed();
  let repairs=0,reason;
  monitor=new WebSessionMonitor({filePath:path.join(root,"monitor.json"),getSettings:()=>({enabled:true,autoRelogin:true,intervalMinutes:15,retryMinutes:60}),
    listJobs:()=>[job],isBusy:()=>false,hasSession:()=>true,probe:()=>probeAccountWebSession(job),retryDelayMs:0,
    repair:(_job,context)=>{repairs++;reason=context.reason;} });
  await monitor.run();assert.equal(repairs,1);assert.equal(reason,"web_workspace_unavailable");
  await monitor.run({force:true});assert.equal(repairs,1,"workspace failures obey the same durable cooldown");
  deviceStatus=200;await seed();assert.equal((await probeAccountWebSession(job)).repairReason,null);
  assert.equal((await listAccountSessions(job)).devices.length,1);
  const client={getJson:async (_method,url)=>({data:url.endsWith("/api/auth/session")?{accessToken:jwt("dead-team")}:listing})};
  await assert.rejects(identifyWebPlan(client,{chatgptBase:base,web:{workspaceId:"personal"},allowPersonalFallback:true,preferTeam:true,verifyTokenWorkspace:true}),/WEB_LOGIN_WORKSPACE_MISMATCH/);
  assert.equal(await fs.readFile(outputPath,"utf8"),oauth);
  console.log("WEB_WORKSPACE_CONTEXT_PASS dead-token detection; explicit 402 code; transient preservation; Web repair/cooldown; fresh token binding; OAuth unchanged");
} catch(error) { console.error("WEB_WORKSPACE_CONTEXT_FAIL "+error.message.split("\n")[0]);process.exitCode=1; }
finally { await monitor?.stop();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true}); }
