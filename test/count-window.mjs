import assert from 'node:assert/strict';
import { recentIntervals } from '../src/overload-monitor.mjs';
import { OverloadMonitor, OVERLOAD_MESSAGE } from '../src/overload-monitor.mjs';
import { overloadGrid } from '../web/src/overload-grid.mjs';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { OverloadCooldown } from '../src/overload-cooldown.mjs';
const now=Date.parse('2026-11-10T12:19:00Z');
const points=recentIntervals(now);
assert.equal(points.length,6,'default is six configured 15-minute windows');
assert.equal(points.at(-1).start,'2026-11-10T12:15:00.000Z');
assert.equal(points.at(-1).end,'2026-11-10T12:30:00.000Z');
for(const minutes of [5,15,20,30,90,120,1440]){
  const grid=overloadGrid(minutes),p=recentIntervals(now,minutes);
  assert.equal(p.length,grid.pointCount);
  assert.equal(Date.parse(p.at(-1).end)-Date.parse(p[0].start),grid.historyMinutes*60_000);
  assert(p.every(v=>Date.parse(v.end)-Date.parse(v.start)===minutes*60_000));
}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'count-window-')),email='window@example.test';
const minutesCurrent=()=>2;
let clock=now,windowMinutes=15,failRequests=false,hold,monitor,restarted;
const calls=[],rows=[now-60_000,now-17*60_000,now-40*60_000];
const options={filePath:path.join(dir,'counts.json'),getWindowMinutes:()=>windowMinutes,getConfig:()=>({baseUrl:'fixture',adminApiKey:'fixture'}),backendIdentity:c=>c.baseUrl,listAccounts:async()=>new Map([[email,[7]]]),now:()=>clock,setTimer:()=>({unref(){}}),clearTimer:()=>{},request:async(_c,endpoint)=>{
  const u=new URL(endpoint,'https://fixture'),start=Date.parse(u.searchParams.get('start_time')),end=Date.parse(u.searchParams.get('end_time')),requests=u.pathname.endsWith('/requests');calls.push({start,end,requests});
  if(hold)await hold;if(failRequests&&requests)throw Error('fixture requests unavailable');
  const items=rows.map((at,id)=>({id,request_id:String(id),account_id:7,kind:'error',created_at:new Date(at).toISOString(),status_code:503,message:OVERLOAD_MESSAGE})).filter(r=>Date.parse(r.created_at)>=start&&Date.parse(r.created_at)<=end);return{data:{items,total:items.length}};
}};
const cooldown=new OverloadCooldown({...options,getSettings:()=>({windowMinutes,threshold:10,cooldownMinutes:60})});
cooldown.accounts.set(email,{enabled:true,windowCount:7,windowCountMinutes:15});
assert.equal(cooldown.snapshot(email).windowCount,7);windowMinutes=30;assert.equal(cooldown.snapshot(email).windowCount,null,'stale cooldown count must not acquire a new window label');windowMinutes=15;
try{
  monitor=new OverloadMonitor(options);await monitor.setEnabled(email,true);await monitor.refresh();let s=monitor.snapshot(email);
  assert.equal(s.bucketMinutes,15);assert.equal(s.windowMinutes,15);assert.equal(s.pointCount,6);assert.equal(s.recentCount,1);
  clock+=60_000;calls.length=0;await monitor.refresh();assert(calls.every(c=>c.end-c.start<=30*60_000),'15min warm cache queries at most two bins');
  windowMinutes=30;assert(monitor.snapshot(email).points.every(p=>p.count===null),'old five/15min counts must not be relabeled as 30min');
  calls.length=0;await monitor.refresh();s=monitor.snapshot(email);assert.equal(s.points.length,3);assert.equal(s.recentCount,2);
  assert.equal(s.points.at(-1).start,'2026-11-10T12:00:00.000Z');assert.equal(s.points.at(-1).end,'2026-11-10T12:30:00.000Z');
  assert(calls.every(c=>c.start===Date.parse(s.points[0].start)),'window changes force full cache rebuild');
  assert.equal(s.points.reduce((n,p)=>n+p.count,0),3);
  let release;hold=new Promise(r=>release=r);const running=monitor.refresh();await new Promise(r=>setImmediate(r));windowMinutes=10;release();await running;hold=null;
  assert(monitor.snapshot(email).points.every(p=>p.count===null),'in-flight old-window counts discarded');
  await monitor.refresh();assert.equal(monitor.snapshot(email).points.length,9);assert.equal(monitor.snapshot(email).recentCount,0);
  failRequests=true;windowMinutes=20;const requestAt=monitor.snapshot(email).requestUpdatedAt;await monitor.refresh();s=monitor.snapshot(email);
  assert.equal(s.points.length,5);assert.equal(s.historyMinutes,100);assert.equal(s.recentCount,0);
  assert(s.points.every(p=>p.requestCount===null),'failed old-size request cache stays unknown on a new grid');assert.equal(s.requestUpdatedAt,requestAt);
  failRequests=false;await monitor.refresh();const before=monitor.snapshot(email);await monitor.stop();restarted=new OverloadMonitor(options);await restarted.load();assert.deepEqual(restarted.snapshot(email),before);
  calls.length=0;await restarted.refresh();assert(calls.every(c=>c.end-c.start<=40*60_000),'restarts reuse matching window cache');
  for(windowMinutes of [90,120]){await restarted.refresh();s=restarted.snapshot(email);assert.equal(s.points.length,1);assert.equal(s.recentCount,minutesCurrent(windowMinutes),'current fixed bin excludes earlier bins');}
  await restarted.stop();
  const old=recentIntervals(clock,5).map(p=>({...p,count:999,requestCount:999}));
  await fs.writeFile(options.filePath,JSON.stringify({version:2,backend:'fixture',accounts:{[email]:{enabled:true,revision:7,points:old,requestPoints:old,updatedAt:new Date(clock).toISOString(),overloadScope:'["7"]',requestScope:'["7"]'}}}));
  windowMinutes=15;restarted=new OverloadMonitor(options);await restarted.load();assert.equal(restarted.snapshot(email).enabled,true);assert.equal(restarted.snapshot(email).revision,7);
  assert(restarted.snapshot(email).points.every(p=>p.count===null),'deployed five-minute cache must be rebuilt');await restarted.refresh();assert.equal(restarted.snapshot(email).points.reduce((n,p)=>n+p.count,0),3);
}finally{await monitor?.stop();await restarted?.stop();await fs.rm(dir,{recursive:true,force:true});}
console.log('COUNT_WINDOW_PASS default_15min=true configured_5_10_20_30_90_120=true cache_migration=true settings_race=true partial_failure=true restart=true');
