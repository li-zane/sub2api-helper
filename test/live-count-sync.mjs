import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectOverloadIntervals, collectRequestIntervals, OverloadMonitor, OVERLOAD_MESSAGE } from '../src/overload-monitor.mjs';
import * as settings from '../web/src/monitor-settings.mjs';
import { buildOverloadChart } from '../web/src/overload-chart.mjs';

const now = Date.parse('2026-11-10T03:07:42Z');
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS '+name); }
  catch (error) { failures++; console.error('FAIL '+name+': '+error.message); }
}
const row = { id: 7, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE, kind: 'error', request_id: 'recent', created_at: new Date(now - 1000).toISOString() };
await test('current-quarter-activity-counted-before-quarter-ends', async () => {
  const request = async () => ({data:{items:[row],total:1}});
  const options = {now, config:{}, accountIds:[7],request};
  const overload = await collectOverloadIntervals(options), requests = await collectRequestIntervals(options);
  assert.equal(overload.at(-1).end, new Date(now).toISOString());
  assert.equal(overload.at(-1).count,1);
  assert.equal(requests.at(-1).requestCount,1);
  assert.equal(Date.parse(overload[0].start), now - 90*60_000);
  for (let i=0;i<6;i++) { assert.equal(Date.parse(overload[i].end)-Date.parse(overload[i].start),15*60_000); if(i)assert.equal(overload[i].start,overload[i-1].end); }
});
await test('rolling-boundaries-exclude-older-and-future-records', async () => {
  const start=now-90*60_000, rows=[start-1,start,start+15*60_000-1,start+15*60_000,now-1,now].map((at,i)=>({...row,id:i,request_id:String(i),created_at:new Date(at).toISOString()}));
  const options={now,config:{},accountIds:[7],request:async()=>({data:{items:rows,total:rows.length}})};
  assert.deepEqual((await collectOverloadIntervals(options)).map(p=>p.count),[2,1,0,0,0,1]);
  assert.deepEqual((await collectRequestIntervals(options)).map(p=>p.requestCount),[2,1,0,0,0,1]);
});
await test('count-sync-settings-live-under-pool-sync-default-60s-and-100', () => {
  assert.equal(settings.DEFAULT_MONITORING.overloadIntervalSeconds,60);
  for(const key of ['overloadIntervalSeconds','overloadConcurrency'])assert.equal(settings.MONITOR_FIELDS.find(f=>f.key===key).group,'号池与用量同步');
  assert.equal(settings.DEFAULT_MONITORING.overloadConcurrency,100);
});
await test('legacy-default-migration-preserves-custom-and-new-900s', () => {
  assert.equal(typeof settings.normalizeSavedMonitoring,'function');
  assert.equal(settings.normalizeSavedMonitoring({version:2,monitoring:{overloadIntervalSeconds:900}}).overloadIntervalSeconds,60);
  assert.equal(settings.normalizeSavedMonitoring({version:2,monitoring:{overloadIntervalSeconds:120}}).overloadIntervalSeconds,120);
  assert.equal(settings.normalizeSavedMonitoring({version:3,monitoring:{overloadIntervalSeconds:900}}).overloadIntervalSeconds,900);
  assert.equal(settings.normalizeSavedMonitoring({version:1}).overloadIntervalSeconds,60);
});
await test('sync-each-minute-keeps-cache-and-separate-failed-series-across-restart', async () => {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'live-count-sync-'));
  let clock=now, failOverloads=false, failRequests=false, delay, monitor, recovered;
  const options={filePath:path.join(temp,'monitor.json'),getConfig:()=>({baseUrl:'fixture',adminApiKey:'fixture'}),backendIdentity:c=>c.baseUrl,listAccounts:async()=>new Map([['fixture@example.test',[7]]]),now:()=>clock,setTimer:(_f,ms)=>{delay=ms;return{unref(){}};},clearTimer:()=>{},request:async(_c,url)=>{
    const requests=url.includes('/ops/requests?');
    if(requests?failRequests:failOverloads)throw Error(requests?'requests-down':'overloads-down');
    return {data:{items:[row],total:1}};
  }};
  try {
    monitor=new OverloadMonitor(options);await monitor.setEnabled('fixture@example.test',true);await monitor.refresh();
    assert.equal(delay,18_000,'next minute boundary, not next quarter');
    const initial=monitor.snapshot('fixture@example.test');assert.equal(initial.points.at(-1).count,1);
    clock+=60_000;assert.deepEqual(monitor.snapshot('fixture@example.test').points,initial.points,'polling alone must not move or erase cached buckets');
    failOverloads=failRequests=true;await monitor.refresh();
    assert.deepEqual(monitor.snapshot('fixture@example.test').points,initial.points,'both failed: preserve actual old sample and timestamps');
    failOverloads=false;await monitor.refresh();
    const partial=monitor.snapshot('fixture@example.test');
    assert.equal(partial.points.at(-1).count,1);assert.equal(partial.points.at(-1).requestCount,1,'failed request series retains known values');
    assert.equal(partial.points.at(-1).end,new Date(clock).toISOString());
    assert.equal(partial.points.at(-1).requestEnd,initial.points.at(-1).end,'cached request time is not relabeled as fresh');
    const chart=buildOverloadChart(partial.points);assert.equal(chart.positioned.at(-1).requestEnd,initial.points.at(-1).end);
    await monitor.stop();recovered=new OverloadMonitor(options);await recovered.load();assert.deepEqual(recovered.snapshot('fixture@example.test'),partial,'independent series survive restart');
    failOverloads=true;failRequests=false;clock+=60_000;await recovered.refresh();const other=recovered.snapshot('fixture@example.test');
    assert.equal(other.points.at(-1).end,partial.points.at(-1).end);assert.equal(other.points.at(-1).requestEnd,new Date(clock).toISOString());
    assert.equal(other.points.at(-1).count,1);assert.equal(other.points.at(-1).requestCount,1);
  } finally {await monitor?.stop();await recovered?.stop();await fs.rm(temp,{recursive:true,force:true});}
});
if(failures)process.exitCode=1;
else console.log('LIVE_COUNT_SYNC_PASS current_activity=true rolling_90m=true independent_cache=true minute_sync=true migration=true');
