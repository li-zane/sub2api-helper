import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'helper-pool-errors-')),email='workspace@example.test';let records=[
 {id:7,name:email,email,platform:'openai',type:'oauth',status:'active',schedulable:true},
 {id:8,name:email,email,platform:'openai',type:'oauth',status:'error',schedulable:false,error_message:'HTTP 402: {"error":{"code":"deactivated_workspace","message":"Workspace deactivated"}}'},
 {id:9,name:email,email,platform:'openai',type:'oauth',status:'error',schedulable:false,error_message:'HTTP 401: {"error":{"code":"invalid_grant","message":"Refresh denied; access_token=secret-test"}}'},
];let child,logs='',headers;
const remote=http.createServer((req,res)=>{assert.equal(req.method,'GET','read-only metadata sync');const u=new URL(req.url,'http://fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify({data:u.pathname==='/api/v1/admin/accounts'?{items:records,total:records.length,pages:1}:u.pathname.endsWith('/all')?[]:{items:[],total:0}}));});await new Promise(r=>remote.listen(0,'127.0.0.1',r));
const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base='http://127.0.0.1:'+port;
const get=async url=>{const r=await fetch(base+url,{headers});assert.equal(r.status,200,await r.clone().text());return r.json();};
try{
 const id='11111111-1111-4111-8111-111111111111';await fs.mkdir(root+'/'+id);await fs.writeFile(root+'/'+id+'/job-meta.json',JSON.stringify({version:1,email,status:'completed',created_at:'2026-11-01T00:00:00Z'}));
 await fs.writeFile(root+'/sub2api-settings.json',JSON.stringify({version:2,config:{baseUrl:'http://127.0.0.1:'+remote.address().port,adminApiKey:'fixture'},profiles:[{id:'default',name:'Default'}],activeProfileId:'default'}));
 child=spawn(process.execPath,['src/console-server.mjs','--host','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',ONBOARDING_OUTPUT_ROOT:root,LOCALAPPDATA:root,TOSUB2_LINUX_CREDENTIAL_ROOT:root+'/credentials',TOSUB2_MAC_CREDENTIAL_ROOT:root+'/credentials',TOSUB2_CREDENTIAL_KEY:'ab'.repeat(32),SUB2API_MONITOR_ENABLED:'0'}});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 for(const end=Date.now()+20000;Date.now()<end;){try{const b=await(await fetch(base+'/api/bootstrap')).json();if(b.token){headers={'x-console-token':b.token};break;}}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,50));}assert(headers,logs);
 let status=(await get('/api/sub2api/account-status?refresh=1')).accounts[email];assert.equal(status.remoteStatus,'error');assert.equal(status.remoteErrors?.length,2,'POOL_ERROR_DETAILS must carry all error rows');assert.deepEqual(status.remoteErrors.map(e=>e.code),['deactivated_workspace','invalid_grant']);assert.equal(status.remoteErrors[0].httpStatus,402);assert(!JSON.stringify(status).includes('secret-test'));
 let job=(await get('/api/jobs')).jobs.find(j=>j.email===email);assert.deepEqual(job.sub2apiRemoteErrors,status.remoteErrors);
 records.reverse();status=(await get('/api/sub2api/account-status?refresh=1')).accounts[email];assert.deepEqual(new Set(status.remoteErrors.map(e=>e.code)),new Set(['deactivated_workspace','invalid_grant']));
 records=records.map(r=>({...r,status:'active',schedulable:true}));status=(await get('/api/sub2api/account-status?refresh=1')).accounts[email];assert.equal(status.remoteStatus,'active');assert.deepEqual(status.remoteErrors,[],'stale pool errors not cleared');job=(await get('/api/jobs')).jobs.find(j=>j.email===email);assert.deepEqual(job.sub2apiRemoteErrors,[]);
 records=[{...records[0],status:'error',error_message:null}];status=(await get('/api/sub2api/account-status?refresh=1')).accounts[email];assert.equal(status.remoteErrors[0].code,null);assert.equal(status.remoteErrors[0].message,'上游未提供错误详情');
 console.log('POOL_ERROR_DETAILS_HTTP_PASS jobs_and_status=true duplicate_rows=true nested_code=true secret_redaction=true recovery_clears_error=true unknown=true pool_mutations=0');
}finally{if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}remote.closeAllConnections();await new Promise(r=>remote.close(r));await fs.rm(root,{recursive:true,force:true});}
