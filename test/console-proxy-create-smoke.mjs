import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'helper-proxy-create-'));
const proxies=[],writes=[];
const remote=http.createServer(async(req,res)=>{
 const route=new URL(req.url,'http://fixture').pathname;res.setHeader('content-type','application/json');
 if(req.method==='POST'&&route==='/api/v1/admin/proxies'){
  let text='';for await(const chunk of req)text+=chunk;const p=JSON.parse(text);writes.push(p);
  assert(req.headers['idempotency-key']);assert.equal(req.headers['x-api-key'],'fixture-key');
  if(p.host==='rejected.test'){res.statusCode=400;res.end(JSON.stringify({message:'echo-password-fixture'}));return;}
  if(p.host==='uncertain.test'){res.statusCode=500;res.end('{}');return;}
  proxies.push({...p,id:proxies.length+1,status:'active'});res.end(JSON.stringify({data:proxies.at(-1)}));return;
 }
 const data=route==='/api/v1/admin/proxies/all'?proxies:route==='/api/v1/admin/proxies'?{items:proxies,total:proxies.length}:route==='/api/v1/admin/groups/all'?[]:route==='/api/v1/admin/accounts'?{items:[],total:0,pages:1}:null;
 res.end(JSON.stringify({data}));
});
const freePort=async()=>{const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
await new Promise(r=>remote.listen(0,'127.0.0.1',r));
let child,logs='';
try{
 for(let n=1;n<=25;n++){
  const dir=path.join(temp,`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`),email=`proxy-${n}@example.test`;
  await fs.mkdir(dir);await fs.writeFile(dir+'/job-meta.json',JSON.stringify({version:1,email,status:n===24?'failed':n===25?'banned':'completed',result_saved:n<=23,created_at:'2026-11-01T00:00:00Z'}));
  if(n<=23)await fs.writeFile(dir+'/sub2api-import-oauth.json',JSON.stringify({type:'sub2api-data',accounts:[{platform:'openai',type:'oauth',credentials:{email,access_token:'fixture',refresh_token:'fixture'}}]}));
 }
 const base='http://127.0.0.1:'+await freePort();
 child=spawn(process.execPath,['src/console-server.mjs','--host','127.0.0.1','--port',new URL(base).port],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',ONBOARDING_OUTPUT_ROOT:temp,LOCALAPPDATA:temp,TOSUB2_LINUX_CREDENTIAL_ROOT:temp+'/credentials',TOSUB2_MAC_CREDENTIAL_ROOT:temp+'/credentials',TOSUB2_CREDENTIAL_KEY:'ab'.repeat(32),SUB2API_MONITOR_ENABLED:'0'}});
 child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);let token;
 for(const end=Date.now()+20000;Date.now()<end;){try{token=(await(await fetch(base+'/api/bootstrap')).json()).token;if(token)break;}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,75));}
 assert(token,logs);const headers={'content-type':'application/json','x-console-token':token};
 const post=async(url,body)=>{const r=await fetch(base+url,{method:'POST',headers,body:JSON.stringify(body)});return{status:r.status,data:await r.json()};};
 assert.equal((await fetch(base+'/api/sub2api/proxies',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await post('/api/sub2api/proxies',{})).status,409,'PROXY_CREATE_ENDPOINT must exist and require saved configuration');
 assert.equal((await post('/api/sub2api/settings',{config:{baseUrl:'http://127.0.0.1:'+remote.address().port,adminApiKey:'fixture-key'}})).status,200);
 assert.equal((await post('/api/sub2api/proxies',{requestId:'a'.repeat(16),proxies:[{name:'bad',host:'proxy.test',port:0}]})).status,400);assert.equal(writes.length,0);
 const proxy={name:'Tokyo',protocol:'socks5h',host:'proxy.test',port:1080,username:'user',password:'password-fixture',expires_at:Math.floor(Date.now()/1000)+86400};
 const body={requestId:'b'.repeat(16),proxies:[proxy,{...proxy,name:'duplicate'},{...proxy,host:'rejected.test'},{...proxy,host:'uncertain.test'}]};
 const [a,b]=await Promise.all([post('/api/sub2api/proxies',body),post('/api/sub2api/proxies',body)]);
 assert.equal(a.status,200,JSON.stringify(a));assert.equal(b.status,200);assert.deepEqual(a.data,b.data);
 assert.deepEqual([a.data.created,a.data.existing,a.data.failed,a.data.unknown],[1,1,1,1]);assert.equal(writes.length,3);
 assert.equal(proxies[0].expires_at,proxy.expires_at);assert.equal(proxies[0].protocol,'socks5h');
 assert(!JSON.stringify(a.data).includes('password-fixture'));assert(!JSON.stringify(a.data).includes('echo-password'));
 assert.equal((await post('/api/sub2api/proxies',{...body,proxies:[{...proxy,name:'other'}]})).status,409);
 for(const query of ['?page=1','?page=2','?search=proxy-1']){
  const r=await fetch(base+'/api/jobs'+query,{headers}),data=await r.json();assert.equal(r.status,200);assert.equal(data.stats.normal,23);assert.equal(data.stats.abnormal,2);assert.equal(data.stats.pending,0);
 }
 console.log('PROXY_CREATE_API_PASS auth=true validation=true partial=1/1/1/1 idempotency=true secrets_omitted=true stats=23/2 all_pages=true');
}finally{
 if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
 await new Promise(r=>remote.close(r));await fs.rm(temp,{recursive:true,force:true});
}
