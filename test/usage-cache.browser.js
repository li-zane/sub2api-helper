async page => {
  const results=[], errors=[], evidence="__UI_TEST_EVIDENCE_DIR__";
  const check=(value,message)=>{if(!value)throw Error(message)};
  const run=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:error.message})}};
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  let snapshot={source:'sub2api',cacheKey:'fixture-key',fetchedAt:'2026-11-07T00:00:00Z',allowed:true,primary:{usedPercent:10},secondary:{usedPercent:17},
    credits:{balance:'105'},resetCredits:{availableCount:2,credits:[]},totals:{accountCost:105,userCost:117,tokens:272000000,fetchedAt:'2026-11-07T00:00:00Z'}};
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{const r=await route.fetch(),data=await r.json();data.jobs=data.jobs.map(j=>({...j,status:'completed',canDownload:true,sub2apiInPool:true,sub2apiUsage:snapshot}));await route.fulfill({json:data})});
  let release, resolvePending, fail=true, calls=0;
  const gate=()=>new Promise(resolve=>{release=resolve});let pending=gate();
  await page.route('**/api/jobs/*/usage?refresh=1',async route=>{calls++;resolvePending?.();await pending;
    if(fail)return route.fulfill({status:503,json:{error:'fixture-sync-failed'}});
    snapshot={...snapshot,fetchedAt:'2026-11-07T01:00:00Z',primary:{usedPercent:0},totals:{accountCost:0,userCost:0,tokens:0},resetCredits:{availableCount:0,credits:[]},credits:{balance:'0'}};
    return route.fulfill({json:{usage:snapshot}});
  });
  await page.setViewportSize({width:1480,height:1000});await page.reload();
  const row=page.locator('tr.job-row').first(),cell=row.locator('.account-usage');await cell.locator('.usage-total-pills').waitFor();
  await run('refresh-keeps-data-and-blocks-double-click',async()=>{
    const requested=new Promise(resolve=>{resolvePending=resolve});await cell.getByRole('button',{name:'从 Sub2API 同步用量',exact:true}).click();await requested;
    check((await cell.innerText()).includes('272M'),'totals disappeared while refreshing');
    check((await cell.innerText()).includes('2 张'),'reset cards disappeared while refreshing');
    check(await cell.getByRole('button',{name:'从 Sub2API 同步用量',exact:true}).isDisabled(),'refresh button allows concurrent duplicate requests');
    check(calls===1,'duplicate refresh request');
  });
  release();await page.waitForTimeout(180);
  await run('failed-refresh-retains-last-values',async()=>{
    check((await cell.innerText()).includes('A $105'),'failure erased actual cost');check((await cell.innerText()).includes('U $117'),'failure erased user cost');
    check((await cell.innerText()).includes('272M'),'failure erased token total');
    check(await cell.getByRole('button',{name:'从 Sub2API 同步用量',exact:true}).isEnabled(),'failed refresh cannot be retried');
    const title=await cell.getAttribute('title')||await cell.getAttribute('data-agy-title');check(title.includes('保留上次数据'),'cached result lacks failure explanation');
    await page.screenshot({path:evidence+'/usage-cache-failure.png'});
  });
  await run('successful-refresh-replaces-cache-with-real-zeros',async()=>{
    fail=false;pending=Promise.resolve();await Promise.all([page.waitForResponse(r=>r.url().endsWith('/usage?refresh=1')),cell.getByRole('button',{name:'从 Sub2API 同步用量',exact:true}).click()]);
    await page.waitForFunction(()=>document.querySelector('.usage-total-pills')?.textContent.includes('A $0'));
    check((await cell.innerText()).includes('T 0'),'real zero token count not applied');check((await cell.innerText()).includes('0 张'),'real zero card count not applied');
    await page.reload();await cell.waitFor();check((await cell.innerText()).includes('A $0'),'updated snapshot not used after reload');
  });
  await run('automatic-card-update-uses-independent-timestamp',async()=>{
    snapshot={...snapshot,resetCreditsObserved:true,resetCreditsFetchedAt:'2026-11-07T02:00:00Z',resetCredits:{availableCount:1,credits:[]}};
    await page.waitForFunction(()=>document.querySelector('.usage-reset-credits')?.textContent.includes('1 张'));
    snapshot={...snapshot,fetchedAt:'2026-11-07T00:00:00Z',resetCreditsFetchedAt:'2026-11-07T03:00:00Z',resetCredits:{availableCount:0,credits:[]}};
    await page.waitForFunction(()=>document.querySelector('.usage-reset-credits')?.textContent.includes('0 张'));
    check((await cell.innerText()).includes('A $0'),'card-only polling replaced newer accounting');
    await page.screenshot({path:evidence+'/automatic-reset-cards.png'});
  });
  await run('mobile-no-new-styles-or-runtime-errors',async()=>{
    await page.setViewportSize({width:375,height:812});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');check(!errors.length,errors.join('; '));
  });
  release?.();await page.unrouteAll({behavior:'wait'});return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
