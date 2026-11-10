async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__", results=[], errors=[];
  const check=(v,m)=>{if(!v)throw Error(m);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
  page.setDefaultTimeout(7000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  let partial=false;
  const end=Date.parse('2026-11-10T03:07:00Z'), requestEnd=end-60_000;
  const points=()=>Array.from({length:6},(_,i)=>({start:new Date(end-(6-i)*900_000).toISOString(),end:new Date(end-(5-i)*900_000).toISOString(),count:i===5?3:0,requestCount:100+i,requestStart:new Date((partial?requestEnd:end)-(6-i)*900_000).toISOString(),requestEnd:new Date((partial?requestEnd:end)-(5-i)*900_000).toISOString()}));
  await page.route(/\/api\/sub2api\/account-status/,r=>r.fulfill({json:{configured:false,accounts:{}}}));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.jobs=data.jobs.map((j,i)=>i?j:{...j,status:'completed',autoRepairBlocked:false,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,overloadDetection:{configured:true,enabled:true,revision:1,updatedAt:new Date(end).toISOString(),lastError:null,requestError:partial?'fixture request sync unavailable':null,points:points()},overloadAutoCooldown:{configured:true,enabled:true,revision:1,settings:{windowMinutes:15,threshold:10},windowCount:1,lastCheckedAt:new Date(end-60_000).toISOString()}});
    await route.fulfill({response,json:data});
  });
  await page.setViewportSize({width:1480,height:1000});await page.reload();
  const row=page.locator('tr.job-row').first();await row.locator('.overload-point').last().waitFor();
  await test('app-identity-and-current-activity-shown-before-quarter-end',async()=>{
    check(new URL(page.url()).hostname==='127.0.0.1'&&(await page.title()).length>0,'unexpected app identity');
    check(await page.locator('tr.job-row').count()>0,'blank screen');
    check(await page.locator('vite-error-overlay').count()===0,'framework error overlay');
    const svg=row.locator('.overload-plot svg');check((await svg.getAttribute('aria-label')).includes('截至最近同步的 90 分钟'),'chart description still closed quarters');
    await row.locator('.overload-point').last().focus();
    const text=await row.getByRole('tooltip').innerText();check(text.includes('3 次')&&text.includes('105 次')&&text.includes(':07'),'current activity/time range missing: '+text);
    const meter=row.getByRole('meter',{name:'15min 过载次数'});check(await meter.getAttribute('aria-valuenow')==='3','stale cooldown count overrides current sync');
    await page.waitForTimeout(180);await page.screenshot({path:evidence+'/current-window-desktop.png'});await page.keyboard.press('Escape');
  });
  await test('partial-error-keeps-counts-and-shows-separate-cached-range',async()=>{
    partial=true;await page.reload();await row.locator('.overload-error').waitFor();await row.locator('.overload-point').last().focus();
    const text=await row.getByRole('tooltip').innerText();check(text.includes('请求区间')&&text.includes(':06')&&text.includes(':07'),'cached request interval relabeled as fresh');
    check(text.includes('105 次')&&text.includes('3 次')&&text.includes('保留上次成功数据'),'cached values or failure explanation missing');
    await page.waitForTimeout(180);await page.screenshot({path:evidence+'/cached-series-desktop.png'});
  });
  await test('mobile-tooltip-and-settings-stay-accessible',async()=>{
    await page.keyboard.press('Escape');await page.setViewportSize({width:375,height:812});
    await row.locator('.overload-point').first().focus();await row.locator('.overload-point').last().focus();await row.getByRole('tooltip').waitFor();
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'任务设置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'任务设置',exact:true});await dialog.waitFor();
    const sync=dialog.getByLabel(/^调用与过载次数同步间隔/);await sync.scrollIntoViewIfNeeded();
    check(await sync.inputValue()==='60','minute default missing');check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile dialog overflows');
    const b=await sync.boundingBox();check(b.x>=0&&b.x+b.width<=376,'sync control off screen');
    await page.screenshot({path:evidence+'/count-sync-mobile.png'});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});check(!errors.length,errors.join('; '));
  });
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
