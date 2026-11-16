import assert from 'node:assert/strict';
import http from 'node:http';
import {CookieJar,ProtocolClient,loginChatgptWeb,runCodexOauth} from '../src/protocol-login.mjs';
import {workspaceSessionFromHtml} from '../src/auth-workspace-page.mjs';

let base, mode='web', calls=[], state, callback;
const workspace={id:'team-fixture',structure:'workspace',plan_type:'business',name:'Team'};
const payload=()=>({page:{type:'workspace'},continue_url:base+'/workspace','oai-client-auth-session':{workspaces:[workspace]}});
const table=[{'_1':2},'loaderData',{'_3':4},'route',{'_5':6},'session',{'_7':8},'workspaces',[9],{'_10':11,'_12':13},'id','team-fixture','structure','workspace'];
const streamed='<script>window.__reactRouterContext.streamController.enqueue('+JSON.stringify(JSON.stringify(table))+')</script>';
assert.equal(workspaceSessionFromHtml(streamed).workspaces[0].id,workspace.id);
assert.equal(workspaceSessionFromHtml('<script>throw Error("must never execute")</script>'),null);
const html=()=>mode==='oauth-direct'?streamed:'<script type="application/json">'+JSON.stringify({loaderData:{auth:{session:payload()['oai-client-auth-session']}}})+'</script>';
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,base);calls.push(req.method+' '+url.pathname);
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=chunks.length&&req.headers['content-type']?.includes('application/json')?JSON.parse(Buffer.concat(chunks)):{};
 const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
 const redirect=path=>{res.writeHead(302,{location:path});res.end();};
 if(url.pathname==='/')return res.end('Home');
 if(url.pathname==='/api/auth/providers')return json({});
 if(url.pathname==='/api/auth/csrf'){res.setHeader('set-cookie','__Host-next-auth.csrf-token=fixture; Path=/');return json({csrfToken:'fixture'});}
 if(url.pathname==='/api/auth/signin/openai')return json({url:base+'/workspace'});
 if(url.pathname==='/workspace')return res.end(mode==='missing'?'<h1>No workspaces</h1>':html());
 if(url.pathname==='/oauth/authorize'){
  state=url.searchParams.get('state');callback=url.searchParams.get('redirect_uri')+'?code=fixture&state='+state;
  res.setHeader('set-cookie','oauth-context=original; Path=/');
  if(mode==='oauth-direct')return redirect(base+'/workspace');
  return redirect(base+'/choose-an-account');
 }
 if(url.pathname==='/choose-an-account')return res.end('<input name="session_id" value="us_fixture_1234567890">');
 if(url.pathname==='/api/accounts/session/select')return json(mode==='email-after-password'?{continue_url:base+'/log-in/password'}:mode.startsWith('email')?{continue_url:(mode==='email-foreign'?'https://foreign.invalid':base)+'/api/accounts/email-otp/send',method:mode==='email-post'?'POST':'GET',page:{type:'email_otp_send'},'oai-client-auth-session':{email_verified:false,email_verification_mode:'post_auth_email_verification'}}:{continue_url:base+'/workspace',page:{type:'workspace'}});
 if(url.pathname==='/api/accounts/password/verify')return json({continue_url:base+'/api/accounts/email-otp/send',method:'GET',page:{type:'email_otp_send'}});
 if(url.pathname==='/api/accounts/email-otp/send'){
  assert.equal(req.method,mode==='email-post'?'POST':'GET');
  return json(mode==='email-loop'?{continue_url:base+'/api/accounts/email-otp/send',method:'GET',page:{type:'email_otp_send'}}:{continue_url:base+'/email-verification',page:{type:'email_verification'}});
 }
 if(url.pathname==='/email-verification')return res.end('<h1>Verify email</h1>');
 if(url.pathname==='/api/accounts/email-otp/validate'){assert.equal(body.code,'123456');return json(payload());}
 if(url.pathname==='/api/accounts/workspace/select'){
  assert.equal(body.workspace_id,workspace.id);
  if(mode==='web'){res.setHeader('set-cookie','__Secure-next-auth.session-token=web-fixture; Path=/');return json({continue_url:base+'/'});}
  assert.match(req.headers.cookie,/oauth-context=original/);return json({continue_url:callback});
 }
 res.statusCode=404;res.end('{}');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
const identity={deviceId:'fixture',sessionId:'fixture',browser:{userAgent:'fixture',acceptLanguage:'en',secChUa:'"Chromium"',secChUaMobile:'?0',secChUaPlatform:'"Windows"'}};
const client=()=>new ProtocolClient({browserIdentity:identity,jar:new CookieJar()});
process.env.NODE_ENV='test';process.env.TOSUB2_TEST_SENTINEL_TOKEN='fixture';
try{
 const web=await loginChatgptWeb(client(),{chatgptBase:base,authBase:base,email:'fixture@example.test'});
 assert.equal(web.workspaceId,workspace.id);assert.equal(web.callbackUrl,base+'/');
 assert.equal(calls.filter(x=>x==='POST /api/accounts/workspace/select').length,1);
 assert(!calls.some(x=>x.includes('password/verify')||x.includes('email-otp/validate')));
 console.log('WORKSPACE_WEB_PASS direct workspace completes actual selection');
 for(mode of ['oauth-workspace','oauth-direct','email-send','email-post','email-after-password','email-foreign','email-loop']){
  calls=[];let prompts=0;
  const options={authBase:base,codexAuthMode:'local',codexClientId:'fixture',codexRedirectUri:'http://127.0.0.1:1455/auth/callback',currentWorkspaceId:workspace.id,expectedEmail:'fixture@example.test',password:'fixture-password',
   rl:{question:async()=>{prompts++;return '123456';}}};
  if(['email-foreign','email-loop'].includes(mode)){
   await assert.rejects(runCodexOauth(client(),options),mode==='email-foreign'?/CODEX_AUTH_ORIGIN_INVALID/:/CODEX_AUTH_VERIFICATION_INCOMPLETE/);
   assert.equal(calls.filter(x=>x.endsWith(' /api/accounts/email-otp/send')).length,mode==='email-foreign'?0:1);
   console.log('WORKSPACE_OAUTH_PASS '+mode+' rejected without foreign request or repeated sends');continue;
  }
  const result=await runCodexOauth(client(),options);
  assert.equal(new URL(result.callbackUrl).searchParams.get('state'),state);
  assert.equal(calls.filter(x=>x.startsWith('GET /oauth/authorize')).length,1);
  assert.equal(calls.filter(x=>x==='POST /api/accounts/workspace/select').length,1);
  assert(!calls.some(x=>x.includes('/api/auth/signin/openai')));
  assert.equal(prompts,mode.startsWith('email')?1:0);
  if(mode.startsWith('email')){
   const method=mode==='email-post'?'POST':'GET';
   assert.equal(calls.filter(x=>x===method+' /api/accounts/email-otp/send').length,1);
   assert(calls.indexOf(method+' /api/accounts/email-otp/send')<calls.indexOf('POST /api/accounts/email-otp/validate'));
  }
  console.log('WORKSPACE_OAUTH_PASS '+mode+' original context and required email verification preserved');
 }
 mode='missing';
 await assert.rejects(loginChatgptWeb(client(),{chatgptBase:base,authBase:base,email:'fixture@example.test'}),/WORKSPACE_SELECTION_UNAVAILABLE/);
 console.log('WORKSPACE_MISSING_PASS empty workspace page is not accepted as login success');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
