import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-chunked-"));
const email = "chunked@example.test", file = path.join(root, "web-session.json");
const identityRoot = path.join(root, "identities");
const identity = await getAccountBrowserIdentity(email, { root: identityRoot });
const jwt = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, "https://api.openai.com/auth": { chatgpt_account_id: "personal" } })).toString("base64url")}.signature`;
let mode, signins = 0, oauth = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  const url = new URL(req.url, "http://fixture");
  const json = data => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
  if (url.pathname === "/") {
    const cookies = ["__Host-next-auth.csrf-token=csrf; Path=/"];
    if (mode === "single") cookies.push("__Secure-next-auth.session-token=session; Path=/");
    else if (mode !== "missing") for (const n of mode === "orphan" ? [1] : [0, 1]) cookies.push(`__Secure-next-auth.session-token.${n}=chunk${n}; Path=/${mode === "wrong-path" ? "other" : ""}${mode === "expired" ? "; Max-Age=0" : ""}`);
    res.setHeader("set-cookie", cookies); return res.end("ChatGPT home");
  }
  if (url.pathname === "/api/auth/providers") return json({});
  if (url.pathname === "/api/auth/csrf") return json({ csrfToken: "csrf" });
  if (url.pathname === "/api/auth/signin/openai") { signins++; return json({ url: base+"/?callback=complete" }); }
  if (url.pathname === "/api/auth/session") return json({ accessToken: jwt, user: { email: mode === "mismatch" ? "other@example.test" : email } });
  if (url.pathname === "/backend-api/accounts/check/v4-2023-04-27") {
    if (mode === "revoked") { res.statusCode=401; return json({ error: { code: "token_revoked" } }); }
    return json({ default_account_id: "personal", accounts: [{ id: "personal", structure: "personal", plan_type: "free" }] });
  }
  oauth++; res.statusCode=404;json({});
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function run() {
  signins=0;
  await writeAccountWebSession(file,{ email,identity,accessToken:"old-token",web:{workspaceId:"personal"},validation:{status:"expired"},cookies:[{name:"persistent-browser",value:"original",domain:"127.0.0.1",path:"/",hostOnly:true}] });
  const child=spawn(process.execPath,[process.env.WEB_CHUNKED_TEST_PROTOCOL || "src/protocol-login.mjs","--native-http","--email",email,"--chatgpt-base",base,"--auth-base",base,"--output-mode","web","--sub2api-out",path.join(root,"oauth.json"),"--checkpoint",path.join(root,"checkpoint.json")],{windowsHide:true,env:{...process.env,NODE_ENV:"test",TOSUB2_WEB_SESSION_PATH:file,TOSUB2_BROWSER_IDENTITY_ROOT:identityRoot,CHATGPT_PROXY_URL:""},stdio:["ignore","pipe","pipe"]});
  let output="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>output+=x);
  const timer=setTimeout(()=>child.kill(),15000);
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});clearTimeout(timer);
  return {code,output};
}
try {
  const oauthOriginal="original Codex authorization";await fs.writeFile(path.join(root,"oauth.json"),oauthOriginal);
  for (mode of ["chunked","single"]) {
    const result=await run();assert.equal(result.code,0,mode+": "+result.output);
    assert.equal(signins,1);assert.match(result.output,/Existing ChatGPT web session accepted/);
    const saved=JSON.parse(await fs.readFile(file,"utf8"));assert.equal(saved.accessToken,jwt);assert.equal(saved.validation.status,"valid");
    assert.deepEqual(saved.identity,identity);assert(saved.cookies.some(c=>c.name==="persistent-browser"));
  }
  for (mode of ["missing","orphan","wrong-path","expired","mismatch","revoked"]) {
    const result=await run();assert.equal(result.code,1,mode+": must verify session beyond callback");
    assert.match(result.output,mode==="mismatch"?/WEB_LOGIN_ACCOUNT_MISMATCH/:mode==="revoked"?/WEB_LOGIN_TOKEN_REVOKED/:/UNEXPECTED_LOGIN_PAGE/);
    assert(signins<=2,"recovery remains bounded");
    assert.equal(JSON.parse(await fs.readFile(file,"utf8")).accessToken,"old-token","failed validation preserves previous session");
  }
  assert.equal(oauth,0);assert.equal(await fs.readFile(path.join(root,"oauth.json"),"utf8"),oauthOriginal);
  console.log("WEB_CHUNKED_PASS chunked/single cookies; real callback recovery; fresh token; identity preserved; missing/orphan/expired/path/account/revoked controls; bounded retry; OAuth untouched");
} catch(error) { console.error("WEB_CHUNKED_FAIL "+error.message);process.exitCode=1; }
finally { await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true}); }
