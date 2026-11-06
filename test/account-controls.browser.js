async page => {
  const results=[],errors=[],requests=[],evidence="__UI_TEST_EVIDENCE_DIR__";
  const check=(v,m)=>{if(!v)throw Error(m)};
  const run=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message})}};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.jobs=data.jobs.map((j,i)=>i===0?{...j,status:'completed',sub2apiInPool:true,sub2apiEnabled:true,sub2apiRateLimited:true,codexStatusEligible:false,
      overloadDetection:{configured:true,enabled:true,revision:1,points:[]},overloadAutoCooldown:{configured:true,enabled:true,revision:1},modelFingerprint:{enabled:true,models:[],override:{},phase:'idle'}}:j.status==='banned'?{...j,sub2apiInPool:true,sub2apiEnabled:false,sub2apiUsage:{allowed:true,primary:{usedPercent:10},totals:{accountCost:1,userCost:2,tokens:1000}}}:j);
    await route.fulfill({json:data});
  });
  for(const suffix of['web-login','usage?refresh=1'])await page.route(`**/api/jobs/*/${suffix}`,route=>{
    requests.push(route.request().url());return route.fulfill({json:suffix==='web-login'?{job:{}}:{usage:{allowed:true,primary:{usedPercent:37},totals:{accountCost:12,userCost:3,tokens:2048}}}});
  });
  await page.setViewportSize({width:1480,height:1000});await page.reload();await page.waitForSelector('tr.job-row.status-banned');
  const banned=page.locator('tr.job-row.status-banned').first(),limited=page.locator('tr.job-row').first();
  await run('banned-web-enabled-OAuth-controls-disabled',async()=>{
    check(await banned.getByRole('button',{name:'登录 Web',exact:true}).isEnabled(),'manual Web is disabled');
    for(const name of['重新授权','重新开始授权','重试授权'])check(await banned.getByRole('button',{name,exact:true}).isDisabled(),`${name} unexpectedly enabled`);
    await banned.getByRole('button',{name:'登录 Web',exact:true}).click();
    check(requests.some(u=>u.endsWith('/web-login')),'Web button used OAuth or stale check endpoint');
  });
  await run('banned-manual-usage-still-refreshes',async()=>{
    await banned.getByRole('button',{name:'从 Sub2API 同步用量',exact:true}).click();
    check(requests.some(u=>u.endsWith('/usage?refresh=1')),'manual usage did not call refresh API');
  });
  await run('429-controls-disabled-with-existing-gray-style',async()=>{
    const cell=limited.locator('.codex-status-cell');
    for(const c of await cell.getByRole('switch').all())check(await c.isDisabled(),'429 switch enabled');
    check(await cell.locator('.fingerprint-check-button').isDisabled(),'429 sample button enabled');
    check(await cell.locator('.fingerprint-cell-body.is-disabled').count()===1,'existing disabled styling not applied');
    check((await cell.getByRole('switch').first().getAttribute('title')).includes('429'),'missing rate limit explanation');
  });
  await run('account-controls-no-runtime-errors',async()=>{
    await page.locator('.table-frame').evaluate(el=>{el.scrollLeft=el.scrollWidth});await page.screenshot({path:`${evidence}/account-controls-desktop.png`});
    await page.setViewportSize({width:375,height:812});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
    check(!errors.length,errors.join('; '));
  });
  await page.unrouteAll({behavior:'wait'});return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
