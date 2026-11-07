async (page) => {
 const dir="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],detailCalls=[];
 const check=(ok,m)=>{if(!ok)throw Error(m);},run=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}};
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
 const model={model:'gpt-fixture',expected:'gpt-fixture',accountId:'2918',status:'unknown',predictionName:'Not scored',usedOutputs:2,reason:'仅获得 2/3 份有效检测样本',samples:[{count:100,expected:100},{count:100,expected:100},{count:5,expected:100}]};
 const makeRound=(id,index,extra={})=>({id,checkedAt:new Date(Date.UTC(2026,10,7,1,0,0)-index*60000).toISOString(),status:'unknown',source:'manual',durationMs:102500,transcriptVersion:1,requestCount:4,models:[model],...extra});
 let records=[makeRound('r0',0),makeRound('r1',1,{status:'error',requestCount:1}),makeRound('r2',2,{transcriptVersion:undefined}),makeRound('r3',3,{requestCount:0,models:[],status:'error'}),makeRound('r4',4),makeRound('r5',5)];
 let failRead=true;
 const rawRequests=[{sample:1,attempt:1,prompt:'EXACT PROMPT <script>window.__transcriptXss=1</script>\nsecond line',response:'1, 2, 3 <img src=x onerror=window.__transcriptXss=2>',status:'success',accepted:true,count:100,expectedCount:100,minimumCount:80,durationMs:3000,startedAt:'2026-11-07T01:00:00Z'},
 {sample:2,attempt:1,prompt:'second prompt',response:'partial reply',status:'error',accepted:false,count:2,minimumCount:80,expectedCount:100,failure:{code:'INCOMPLETE',message:'模型流式响应未完成'}},
 {sample:2,attempt:2,prompt:'second prompt',response:'second reply',status:'success',accepted:true,count:100,minimumCount:80,expectedCount:100},
 {sample:3,attempt:1,prompt:'third prompt',response:'short reply',status:'success',accepted:false,count:5,minimumCount:80,expectedCount:100}];
 const state=()=>({enabled:true,models:[{model:'gpt-fixture',expected:'gpt-fixture'}],override:{enabled:true,models:null,intervalMinutes:null},intervalMinutes:15,phase:'idle',recentResults:records.map(r=>({status:r.status,checkedAt:r.checkedAt}))});
 for(const r of ['**/api/sub2api/settings','**/api/sub2api/monitor'])await page.route(r,route=>route.fulfill({json:{hasAdminApiKey:true,config:{baseUrl:'http://fixture.test'}}}));
 await page.route('**/api/sub2api/account-status*',r=>r.fulfill({json:{configured:false,accounts:{}}}));
 await page.route(/\/api\/jobs(?:\?|$)/,async route=>{const response=await route.fetch(),data=await response.json();data.jobs=data.jobs.map(j=>({...j,status:'completed',autoRepairBlocked:false,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,modelFingerprint:state()}));await route.fulfill({json:data});});
 await page.route(/\/model-fingerprint\/history(?:\?|$)/,async route=>{
  const id=new URL(route.request().url()).searchParams.get('round');
  if(!id)return route.fulfill({json:{models:state().models,records,phase:'idle'}});
  detailCalls.push(id);
  if(id==='r1'&&failRead){failRead=false;return route.fulfill({status:404,json:{error:'该轮记录已轮换，请刷新'}});}
  const record=records.find(r=>r.id===id);if(!record)return route.fulfill({status:404,json:{error:'记录已轮换'}});
  return route.fulfill({json:{record:{...record,models:[{...model,requests:id==='r1'?[{...rawRequests[0],status:'error',response:null,accepted:false,failure:{code:'AUTH',message:'授权失效'}}]:rawRequests}]}}});
 });
 await page.setViewportSize({width:1480,height:1000});await page.reload();await page.waitForFunction(()=>document.querySelectorAll('tr.job-row').length===20);
 await page.locator('tr.job-row').first().locator('.fingerprint-round').last().click();
 const dialog=page.getByRole('dialog'),nodes=dialog.locator('.fingerprint-timeline-node');
 await nodes.nth(5).waitFor();
 await run('six-round-summaries-lazy-load-no-extra-requests',async()=>{check(await nodes.count()===6,'not six rounds');check(detailCalls.length===0,'raw replies fetched during summary load');check((await nodes.first().innerText()).includes('2/3'),'missing valid sample count');check((await nodes.first().innerText()).includes('未评分说明'),'missing unscorable explanation');});
 await run('expand-round-exact-prompt-answer-and-safe-text',async()=>{
  await nodes.first().locator('.fingerprint-transcripts > summary').click();await nodes.first().locator('.fingerprint-sample').nth(3).waitFor();check(detailCalls.join(',')==='r0','must fetch only opened round');
  const sample=nodes.first().locator('.fingerprint-sample').first();await sample.locator('summary').click();check(await sample.locator('.fingerprint-request-prompt').innerText()===rawRequests[0].prompt,'prompt changed');check(await sample.locator('.fingerprint-request-response').innerText()===rawRequests[0].response,'reply changed');check(await page.evaluate(()=>!window.__transcriptXss),'reply executed as HTML');check(await sample.locator('script,img').count()===0,'raw HTML inserted');
  await page.screenshot({path:`${dir}/fingerprint-transcripts-desktop.png`});
 });
 await run('retry-attempt-partial-answer-and-invalid-sample-visible',async()=>{
  const retry=nodes.first().locator('.fingerprint-sample').nth(1);await retry.locator('summary').click();check((await retry.innerText()).includes('未完成，未参与评分'),'partial answer mislabelled');check((await retry.innerText()).includes('INCOMPLETE'),'missing failure code');check(await retry.locator('.fingerprint-request-response').innerText()==='partial reply','partial response lost');check((await nodes.first().locator('.fingerprint-sample').nth(2).locator('summary').innerText()).includes('请求 2'),'retry attempt missing');check((await nodes.first().locator('.fingerprint-sample').nth(3).innerText()).includes('数字不足'),'invalid sample marked as accepted');
  const details=nodes.first().locator('.fingerprint-transcripts');await details.locator(':scope > summary').click();await details.locator(':scope > summary').click();await nodes.first().locator('.fingerprint-sample').first().waitFor();check(detailCalls.filter(i=>i==='r0').length===1,'reopening fetches duplicate request');
 });
 await run('legacy-and-preflight-errors-do-not-invent-transcripts',async()=>{check((await nodes.nth(2).innerText()).includes('旧记录未保存原文'),'legacy message missing');check(await nodes.nth(2).locator('.fingerprint-transcripts').count()===0,'legacy fake details');check((await nodes.nth(3).innerText()).includes('未发出模型请求'),'preflight error message missing');});
 await run('detail-read-failure-retry-and-no-answer-case',async()=>{await nodes.nth(1).locator('.fingerprint-transcripts > summary').click();await nodes.nth(1).getByRole('alert').waitFor();await nodes.nth(1).getByRole('button',{name:'重试读取'}).click();const sample=nodes.nth(1).locator('.fingerprint-sample');await sample.locator('summary').click();check((await sample.innerText()).includes('本次请求未收到回答正文'),'no-answer case missing');check(detailCalls.filter(i=>i==='r1').length===2,'read retry failed');});
 await run('mobile-width-keyboard-and-bounded-scroll',async()=>{
  await page.setViewportSize({width:375,height:812});await nodes.first().scrollIntoViewIfNeeded();const sample=nodes.first().locator('.fingerprint-sample').first();if(!await sample.evaluate(e=>e.open))await sample.locator('summary').click();await sample.locator('.fingerprint-request-prompt').focus();check(await sample.locator('.fingerprint-request-prompt').evaluate(e=>e===document.activeElement),'raw text not keyboard focusable');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'document overflows');check(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'dialog overflows');check(await sample.locator('pre').first().evaluate(e=>e.clientHeight<=220),'prompt scroll unbounded');await page.screenshot({path:`${dir}/fingerprint-transcripts-mobile.png`});
 });
 await run('rollover-removes-expanded-text-and-keeps-six-rounds',async()=>{
  records=Array.from({length:6},(_,i)=>makeRound('new-'+i,i));await dialog.getByRole('button',{name:'刷新记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.fingerprint-request-prompt'));check(await nodes.count()===6,'rollover changed six window');check(!(await dialog.innerText()).includes('EXACT PROMPT'),'old loaded text retained');
  await page.keyboard.press('Escape');check(await dialog.count()===0,'Escape did not close dialog');check(errors.length===0,errors.join('; '));
 });
 await page.unrouteAll({behavior:'wait'});return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
