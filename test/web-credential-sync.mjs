import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";

const source=path.resolve(process.env.CREDENTIAL_SYNC_ROOT || ".");
const load=name=>import(pathToFileURL(path.join(source,"src",name)));
const mod=await load("account-web-session.mjs");
const { getAccountBrowserIdentity }=await load("account-browser-identity.mjs");
const root=await fs.mkdtemp(path.join(os.tmpdir(),"credential-sync-"));
const email="sync@example.test",outputPath=path.join(root,"sub2api-import-oauth.json"),file=path.join(root,"web-session.json");
const identity=await getAccountBrowserIdentity(email,{root:path.join(root,"identities")});
const job={email,outputPath,resultSaved:true,planType:"free"};
const jwt=(id,plan)=>`web.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,"https://api.openai.com/auth":{chatgpt_account_id:id,chatgpt_plan_type:plan}})).toString("base64url")}.signature`;
const classify=()=>mod.publicWebCredentialSync?.(job,job.planType)||{status:"unverified"};
const oauth=async(id="personal",plan="free")=>fs.writeFile(outputPath,JSON.stringify({accounts:[{credentials:{email,chatgpt_account_id:id,plan_type:plan,access_token:jwt(id,plan)}}]}));
const seed=async(id="old-team",plan="team",status="valid",selected="personal")=>mod.writeAccountWebSession(file,{email,identity,accessToken:jwt(id,plan),web:{workspaceId:selected},validation:{status,verifiedAt:new Date().toISOString()},cookies:[{name:"browser",value:"same-device",domain:"fixture.test",path:"/",hostOnly:true}]});
try {
  await oauth();await seed();
  const original=await fs.readFile(file,"utf8"),exported=await fs.readFile(outputPath,"utf8");
  await mod.inspectAccountWebSession(job);
  if(!process.argv.includes("--permission")) {
    assert.equal(classify().status,"pending_update","Free display with a Team Web token must expose pending Web credentials");
    assert.equal(classify().reason,"workspace_mismatch");assert.equal(classify().webPlanType,"team");assert.equal(job.planType,"free");
    assert(!JSON.stringify(classify()).includes("signature"),"public sync metadata never includes tokens");
    assert.equal(await fs.readFile(file,"utf8"),original);assert.equal(await fs.readFile(outputPath,"utf8"),exported);
    job.webLoginPreviousState={};assert.equal(classify().status,"refreshing");job.webLoginPreviousState=null;
    await seed("personal","free");await mod.inspectAccountWebSession(job);assert.equal(classify().status,"synced");
    await oauth("other-personal","free");await mod.inspectAccountWebSession(job);assert.equal(classify().status,"authorization_pending","same-plan workspace drift must stay pending");
    await oauth("personal","team");await mod.inspectAccountWebSession(job);assert.equal(classify().status,"authorization_pending");
    await oauth();await seed("personal","free","expired");await mod.inspectAccountWebSession(job);assert.equal(classify().status,"pending_update");
    await seed("personal","free");await mod.inspectAccountWebSession(job);
    const raw=JSON.parse(await fs.readFile(file,"utf8"));raw.accessToken="opaque-token";await mod.writeAccountWebSession(file,raw);
    await mod.inspectAccountWebSession(job);assert.equal(classify().status,"unverified","unknown token context must not claim synchronization");
    await fs.writeFile(file,"<invalid-json>");await mod.inspectAccountWebSession(job);assert.equal(classify().status,"pending_update");
  }
  await seed("personal","free");await mod.inspectAccountWebSession(job);
  const read=fs.readFile.bind(fs),untouched=await read(file,"utf8");
  for(const code of ["EACCES","EPERM"]){
    const denied=mock.method(fs,"readFile",async(p,...args)=>{if(String(p)===file)throw Object.assign(new Error("fixture permission denied"),{code});return read(p,...args);});
    try {
      await mod.inspectAccountWebSession(job);
      assert.equal(job.webSessionStatus,"unavailable","file permission errors must not be labeled expired");
      assert.equal(classify().status,"read_failed");assert.equal(classify().reason,code);assert.equal(job.webSessionContext,null);
    } finally { denied.mock.restore(); }
    assert.equal(await read(file,"utf8"),untouched);
  }
  await mod.inspectAccountWebSession(job);assert.equal(job.webSessionReadError,null);assert.equal(classify().status,"synced");
  assert.equal(mod.publicWebCredentialSync(job,"free",{blocked:true}).status,"blocked");
  await fs.unlink(file);await mod.inspectAccountWebSession(job);assert.equal(classify().status,"absent");
  console.log("WEB_CREDENTIAL_SYNC_PASS Free/old-Team pending; refresh; Web/Codex workspace+plan consistency; opaque context unverified; EACCES/EPERM distinct from expiry; recovery clears errors; no credential writes");
} catch(error) { console.error("WEB_CREDENTIAL_SYNC_FAIL "+error.message);process.exitCode=1; }
finally { mock.restoreAll();await fs.rm(root,{recursive:true,force:true}); }
