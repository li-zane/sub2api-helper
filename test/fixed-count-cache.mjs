import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import * as api from '../src/overload-monitor.mjs';
const minute=60_000, now=Date.parse('2026-11-10T12:19:00Z'), email='cache@example.test';
let failed=0;
const test=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}};
await test('fixed-five-minute-grid-includes-current-partial-bin',async()=>{
  const points=await api.collectRequestIntervals({config:{},accountIds:[7],now,windowMinutes:5,request:async()=>({data:{items:[],total:0}})});
  assert.equal(points.length,18);assert.equal(points.at(-1).start,'2026-11-10T12:15:00.000Z');assert.equal(points.at(-1).end,'2026-11-10T12:20:00.000Z');
  assert.equal(points[0].start,'2026-11-10T10:50:00.000Z');
  for(const p of points){assert.equal(Date.parse(p.start)%(5*minute),0);assert.equal(Date.parse(p.end)-Date.parse(p.start),5*minute);}
});
await test('rolling-fifteen-minute-meter-retains-exact-boundaries',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fixed-count-boundary-'));let clock=now;
 const rows=[now-15*minute-1,now-15*minute,now-15*minute+1,now-1,now];
 const monitor=new api.OverloadMonitor({filePath:path.join(dir,'counts.json'),getConfig:()=>({baseUrl:'fixture',adminApiKey:'fixture'}),backendIdentity:c=>c.baseUrl,listAccounts:async()=>new Map([[email,[7]]]),now:()=>clock,setTimer:()=>({unref(){}}),clearTimer:()=>{},request:async(_c,endpoint)=>{
  const url=new URL(endpoint,'https://fixture'),start=Date.parse(url.searchParams.get('start_time')),end=Date.parse(url.searchParams.get('end_time'));
  const items=rows.map((at,id)=>({id,request_id:String(id),account_id:7,kind:'error',created_at:new Date(at).toISOString(),status_code:503,message:api.OVERLOAD_MESSAGE})).filter(r=>Date.parse(r.created_at)>=start&&Date.parse(r.created_at)<=end);return{data:{items,total:items.length}};
 }});
 try{
  await monitor.setEnabled(email,true);await monitor.refresh();assert.equal(monitor.snapshot(email).recentCount,3,'cutoff inclusive; sample time exclusive');
  clock+=2;await monitor.refresh();assert.equal(monitor.snapshot(email).recentCount,2,'rolling cutoff must advance within a fixed bin');
 }finally{await monitor.stop();await fs.rm(dir,{recursive:true,force:true});}
});
await test('pause-closes-previously-partial-bin-and-fills-gaps',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fixed-count-pause-'));let clock=now;
 const rows=[now-minute,now+30_000,now+6*minute],calls=[];
 const monitor=new api.OverloadMonitor({getWindowMinutes:()=>5,filePath:path.join(dir,'counts.json'),getConfig:()=>({baseUrl:'fixture',adminApiKey:'fixture'}),backendIdentity:c=>c.baseUrl,listAccounts:async()=>new Map([[email,[7]]]),now:()=>clock,setTimer:()=>({unref(){}}),clearTimer:()=>{},request:async(_c,endpoint)=>{
  const url=new URL(endpoint,'https://fixture'),start=Date.parse(url.searchParams.get('start_time')),end=Date.parse(url.searchParams.get('end_time'));calls.push({start,end});
  const items=rows.map((at,id)=>({id,request_id:String(id),account_id:7,kind:'error',created_at:new Date(at).toISOString(),status_code:503,message:api.OVERLOAD_MESSAGE})).filter(r=>Date.parse(r.created_at)>=start&&Date.parse(r.created_at)<=end);return{data:{items,total:items.length}};
 }});
 try{
  await monitor.setEnabled(email,true);await monitor.refresh();assert.equal(monitor.snapshot(email).points.at(-1).count,1);
  calls.length=0;clock+=12*minute;await monitor.refresh();const snapshot=monitor.snapshot(email);
  assert(calls.every(c=>c.start===Date.parse('2026-11-10T12:15:00Z')),'resume must close last partial bin, not start at first missing bin');
  const closed=snapshot.points.find(p=>p.start==='2026-11-10T12:15:00.000Z');assert.equal(closed.count,2);assert.equal(closed.requestCount,2);
  assert.equal(snapshot.recentCount,0);assert(snapshot.points.every(p=>p.count!==null&&p.requestCount!==null));
 }finally{await monitor.stop();await fs.rm(dir,{recursive:true,force:true});}
});
await test('cached-history-recheck-delay-restart-scope-and-full-reconciliation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fixed-count-cache-'));let clock=now,ids=[7],failRequests=false,failOverloads=false,monitor,restarted;
 const calls=[],rows=[{id:1,at:now-minute},{id:2,at:now-20*minute}];
 const options={getWindowMinutes:()=>5,filePath:path.join(dir,'counts.json'),getConfig:()=>({baseUrl:'fixture',adminApiKey:'fixture'}),backendIdentity:c=>c.baseUrl,listAccounts:async()=>new Map([[email,ids]]),now:()=>clock,setTimer:()=>({unref(){}}),clearTimer:()=>{},request:async(_c,endpoint)=>{
  const url=new URL(endpoint,'https://fixture'),requests=url.pathname.endsWith('/requests'),start=Date.parse(url.searchParams.get('start_time')),end=Date.parse(url.searchParams.get('end_time'));
  calls.push({requests,start,end,id:url.searchParams.get('account_id')});
  if(requests?failRequests:failOverloads)throw Error(requests?'requests-down':'overloads-down');
  const items=rows.filter(r=>r.at>=start&&r.at<=end).map(r=>({id:Number(url.searchParams.get('account_id'))*1000+r.id,request_id:String(r.id),account_id:Number(url.searchParams.get('account_id')),kind:'error',created_at:new Date(r.at).toISOString(),status_code:503,message:api.OVERLOAD_MESSAGE}));return{data:{items,total:items.length}};
 }};
 try{
  monitor=new api.OverloadMonitor(options);await monitor.setEnabled(email,true);await monitor.refresh();let first=monitor.snapshot(email);
  assert.equal(first.points.length,18);assert.equal(first.points.at(-1).count,1);assert.equal(first.recentCount,1);assert.equal(first.points.at(-1).requestCount,1);
  const coldSpan=calls[0].end-calls[0].start;assert.equal(coldSpan,89*minute);
  clock+=30_000;assert.deepEqual(monitor.snapshot(email),first,'UI polling must not move or recalculate cached bins');
  // A delayed log in the previous bin must be picked up, including after a boundary.
  rows.push({id:3,at:now-6*minute});clock=now+minute;calls.length=0;await monitor.refresh();let current=monitor.snapshot(email);
  assert(calls.every(c=>c.start===Date.parse('2026-11-10T12:15:00Z')&&c.end===clock),'warm sync should only query current+previous bin');
  assert.equal(current.points.at(-1).start,'2026-11-10T12:20:00.000Z');assert.equal(current.points.at(-2).count,1);
  clock+=minute;calls.length=0;await monitor.refresh();assert(calls.every(c=>c.end-c.start<=10*minute),'warm refresh scans at most ten minutes');
  // Delay in the immediately preceding bucket is corrected without double counting.
  rows.push({id:4,at:now-2*minute});await monitor.refresh();current=monitor.snapshot(email);assert.equal(current.points.find(p=>p.start==='2026-11-10T12:15:00.000Z').count,2);
  await monitor.refresh();assert.equal(monitor.snapshot(email).points.find(p=>p.start==='2026-11-10T12:15:00.000Z').count,2,'re-query replaces counts rather than accumulating duplicates');
  assert.equal(monitor.snapshot(email).recentCount,2,'exact rolling 15m excludes the delayed event outside recheck range until reconciliation');
  await monitor.stop();restarted=new api.OverloadMonitor(options);await restarted.load();calls.length=0;await restarted.refresh();assert(calls.every(c=>c.end-c.start<=10*minute),'restart must reuse persisted fixed bins');
  // A partial failure keeps old counts at their actual bin, never under a new time label.
  const retained=restarted.snapshot(email);failRequests=true;clock+=5*minute;await restarted.refresh();const partial=restarted.snapshot(email);
  assert.equal(partial.requestUpdatedAt,retained.requestUpdatedAt);assert.equal(partial.points.at(-1).requestCount,null);assert(partial.points.some(p=>p.requestCount===2));
  failOverloads=true;const old=restarted.snapshot(email);clock+=minute;await restarted.refresh();assert.deepEqual(restarted.snapshot(email).points,old.points,'both failed keeps cache view');
  failOverloads=failRequests=false;
  // New pool membership invalidates both caches and reloads all visible bins.
  ids=[7,8];calls.length=0;await restarted.refresh();assert(calls.every(c=>c.end-c.start>80*minute),'pool IDs changed: reload historical counts');
  assert.equal(restarted.snapshot(email).points.find(p=>p.start==='2026-11-10T12:15:00.000Z').count,4,'distinct pool records aggregate once each');
  // Stable membership: full history reconciliation remains periodic, not every minute.
  clock+=60*minute;calls.length=0;await restarted.refresh();assert(calls.every(c=>c.end-c.start>80*minute),'hourly reconciliation includes delayed historical logs');
  const disk=JSON.parse(await fs.readFile(options.filePath,'utf8'));assert.equal(disk.version,2);assert.equal(disk.accounts[email].points.length,18);assert(!JSON.stringify(restarted.snapshot(email)).includes('overloadEvents'),'raw timing cache must not bloat public API');
  console.log('CACHE_QUERY_EVIDENCE cold_seconds='+coldSpan/1000+' warm_max_seconds=600');
 }finally{await monitor?.stop();await restarted?.stop();await fs.rm(dir,{recursive:true,force:true});}
});
if(failed)process.exitCode=1;else console.log('FIXED_COUNT_CACHE_PASS bins=18 fixed_minutes=5 warm_query_max_seconds=600 restart_cache=true late_logs=true scopes=true');
