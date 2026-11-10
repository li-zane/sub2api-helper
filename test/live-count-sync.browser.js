async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__", results=[], errors=[];
  const check=(v,m)=>{if(!v)throw Error(m);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
  page.setDefaultTimeout(7000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  let partial=false, sample=Date.parse('2026-11-10T03:07:00Z');
  const end=Date.parse('2026-11-10T03:10:00Z'), requestAt=sample-60_000;
  const points=()=>Array.from({length:18},(_,i)=>({start:new Date(end-(18-i)*300_000).toISOString(),end:new Date(end-(17-i)*300_000).toISOString(),count:i===17?3:0,requestCount:100+i}));
  await page.route(/\/api\/sub2api\/account-status/,r=>r.fulfill({json:{configured:false,accounts:{}}}));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.jobs=data.jobs.map((j,i)=>i?j:{...j,status:'completed',autoRepairBlocked:false,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,overloadDetection:{configured:true,enabled:true,revision:1,bucketMinutes:5,recentCount:3,updatedAt:new Date(sample).toISOString(),overloadUpdatedAt:new Date(sample).toISOString(),requestUpdatedAt:new Date(partial?requestAt:sample).toISOString(),lastError:null,requestError:partial?'fixture request sync unavailable':null,points:points()},overloadAutoCooldown:{configured:true,enabled:true,revision:1,settings:{windowMinutes:15,threshold:10},windowCount:1,lastCheckedAt:new Date(requestAt).toISOString()}});
    await route.fulfill({response,json:data});
  });
  await page.setViewportSize({width:1480,height:1000});await page.reload();
  const row=page.locator('tr.job-row').first();await row.locator('.overload-point').last().waitFor();
  await test('app-identity-fixed-grid-and-current-partial-activity',async()=>{
    check(new URL(page.url()).hostname==='127.0.0.1'&&(await page.title()).length>0,'unexpected app identity');
    check(await page.locator('tr.job-row').count()>0,'blank screen');
    check(await page.locator('vite-error-overlay').count()===0,'framework error overlay');
    const svg=row.locator('.overload-plot svg');check((await svg.getAttribute('aria-label')).includes('每格固定 5 分钟'),'chart description missing fixed bins');
    check(await row.locator('.overload-point').count()===18,'fixed grid must have eighteen points');
    const geometry=await svg.evaluate(el=>({width:el.viewBox.baseVal.width,hits:[...el.querySelectorAll('.overload-hit-area')].map(n=>({x:Number(n.getAttribute('x')),width:Number(n.getAttribute('width'))}))}));
    check(geometry.hits.every((h,i)=>h.x>=0&&h.x+h.width<=geometry.width&&(!i||h.x>=geometry.hits[i-1].x+geometry.hits[i-1].width-0.01)),'chart hit areas overlap or exceed plot');
    await row.locator('.overload-point').last().focus();
    const text=await row.getByRole('tooltip').innerText();check(text.includes('3 次')&&text.includes('117 次')&&text.includes(':05')&&text.includes(':10')&&text.includes(':07'),'current activity/fixed interval/sample time missing: '+text);
    const tip=await row.getByRole('tooltip').boundingBox();check(tip.x>=0&&tip.x+tip.width<=1480,'desktop tooltip clipped');
    const meter=row.getByRole('meter',{name:'15min 过载次数'});check(await meter.getAttribute('aria-valuenow')==='3','stale cooldown count overrides current sync');
    await page.waitForTimeout(180);await page.screenshot({path:evidence+'/current-window-desktop.png'});await page.keyboard.press('Escape');
  });
  await test('partial-error-keeps-fixed-labels-and-independent-sample-times',async()=>{
    const labels=await row.locator('.overload-point').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));
    partial=true;sample+=60_000;await page.reload();await row.locator('.overload-error').waitFor();await row.locator('.overload-point').last().focus();
    check(JSON.stringify(await row.locator('.overload-point').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))))===JSON.stringify(labels),'minute sync unexpectedly moved fixed labels');
    const text=await row.getByRole('tooltip').innerText();check(text.includes('请求统计至')&&text.includes(':06')&&text.includes('过载统计至')&&text.includes(':08'),'cached request values relabeled as freshly sampled');
    check(text.includes('117 次')&&text.includes('3 次')&&text.includes('保留上次成功数据'),'cached values or failure explanation missing');
    await page.waitForTimeout(180);await page.screenshot({path:evidence+'/cached-series-desktop.png'});
  });
  await test('mobile-tooltip-and-settings-stay-accessible',async()=>{
    await page.keyboard.press('Escape');await page.setViewportSize({width:375,height:812});
    await row.locator('.overload-point').first().focus();await row.locator('.overload-point').last().focus();await row.getByRole('tooltip').waitFor();
    const tip=await row.getByRole('tooltip').boundingBox(),frame=await page.locator('.table-frame').boundingBox();check(tip.x>=frame.x&&tip.x+tip.width<=Math.min(375,frame.x+frame.width)+1,'mobile tooltip clipped by frame or viewport');
    await page.waitForTimeout(180);
    await page.screenshot({path:evidence+'/fixed-bins-mobile.png'});
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'任务设置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'任务设置',exact:true});await dialog.waitFor();
    const sync=dialog.getByLabel(/^调用与过载次数同步间隔/);await sync.scrollIntoViewIfNeeded();
    check(await sync.inputValue()==='60','minute default missing');check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile dialog overflows');
    const b=await sync.boundingBox();check(b.x>=0&&b.x+b.width<=376,'sync control off screen');
    await page.screenshot({path:evidence+'/count-sync-mobile.png'});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});check(!errors.length,errors.join('; '));
  });
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
