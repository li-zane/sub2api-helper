async page => {
  const results=[],errors=[],evidence="__UI_TEST_EVIDENCE_DIR__";
  const check=(value,message)=>{if(!value)throw Error(message)};
  const run=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/'+name+'-failure.png'}).catch(()=>{});await page.keyboard.press('Escape').catch(()=>{})}};
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  let userCost=2;
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{const res=await route.fetch(),data=await res.json();data.jobs=data.jobs.map(j=>({...j,status:'completed',autoRepairBlocked:false,sub2apiInPool:true,canDownload:true,canLogoutAllSessions:true,canForceRelogin:true,
    sub2apiUsage:{source:'sub2api',cacheKey:'pricing-'+j.id,allowed:true,primary:{usedPercent:10},totals:{accountCost:100,userCost,tokens:272000000,fetchedAt:'2026-11-07T01:00:00Z'}}}));data.selection=data.jobs;await route.fulfill({json:data})});
  await page.setViewportSize({width:1480,height:1000});await page.reload();
  const row=page.locator('tr.job-row').first();await row.locator('.usage-profit-pill').waitFor();
  const closeToasts=async()=>{while(await page.locator('.toast-dismiss').count())await page.locator('.toast-dismiss').first().click()};
  await run('default-cost-beside-remark',async()=>{
    const cost=row.locator('.account-cost-button'),remark=row.locator('.account-remark-button');
    check(await cost.innerText()==='￥0','legacy cost is not zero');const a=await remark.boundingBox(),b=await cost.boundingBox();check(b.x>=a.x+a.width-1&&Math.abs(a.y-b.y)<2,'cost not beside remark');
    check((await row.locator('.usage-profit-pill').innerText()).includes('￥2.00'),'default multiplier is not 1');
  });
  await run('multiplier-shares-timezone-row-and-saves',async()=>{
    await page.getByRole('button',{name:'任务设置',exact:true}).click();const dialog=page.locator('.task-settings-dialog');await dialog.waitFor();
    const zone=dialog.locator('label[for="task-display-time-zone"]'),rate=dialog.locator('label[for="task-pool-price-multiplier"]');
    const [a,b]=await dialog.locator('.task-display-pricing-row').evaluate(el=>[...el.querySelectorAll(':scope > label')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y}}));check(Math.abs(a.y-b.y)<2&&b.x>a.x,'timezone/rate not on the same desktop row');
    await dialog.getByRole('spinbutton',{name:'号池价格倍率',exact:true}).fill('7');
    const response=page.waitForResponse(r=>r.url().endsWith('/api/task-settings')&&r.request().method()==='POST');
    await dialog.getByRole('button',{name:'保存设置',exact:true}).click();check((await response).ok(),'rate save failed');await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.querySelector('.usage-profit-pill')?.textContent.includes('￥14.00'));
    const toast=page.locator('.task-toast.success');await toast.waitFor();const r=await toast.boundingBox();check(r.x+r.width<=1480&&r.y>=0,'toast outside viewport');
    check(await page.locator('.app-shell .global-success').count()===0,'inline notice still occupies the table');await closeToasts();
  });
  async function saveCost(value) {
    await row.locator('.account-cost-button').click();const dialog=page.getByRole('dialog',{name:'账号成本',exact:true});await dialog.waitFor();
    await dialog.getByRole('spinbutton',{name:'账号成本（人民币）',exact:true}).fill(value);
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/cost')&&r.request().method()==='POST'),dialog.getByRole('button',{name:'保存成本',exact:true}).click()]);await dialog.waitFor({state:'hidden'});
  }
  await run('edit-cost-updates-profit-without-layout-shift',async()=>{
    const before=await row.boundingBox();await saveCost('12.34');await page.waitForFunction(()=>document.querySelector('.account-cost-button')?.textContent==='￥12.34');
    check((await row.locator('.usage-profit-pill').innerText()).includes('￥1.66'),'profit did not use U*7-cost');
    const tags=await row.locator('.usage-total-pill').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}}));
    check(tags.length===4&&Math.abs(tags[2].y-tags[3].y)<2&&tags[3].x>=tags[2].x+tags[2].width-1,'profit not to the right of A/U/T');
    check(Math.abs((await row.boundingBox()).y-before.y)<1,'toast pushed the account table');
    await page.screenshot({path:evidence+'/pricing-toast-desktop.png'});await closeToasts();
    await page.reload();await row.locator('.usage-profit-pill').waitFor();check(await row.locator('.account-cost-button').innerText()==='￥12.34','cost did not survive reload');
  });
  await run('negative-and-unknown-profit-are-not-fabricated',async()=>{
    await saveCost('20');await page.waitForFunction(()=>document.querySelector('.usage-profit-pill')?.textContent.includes('-￥6.00'));
    check(await row.locator('.usage-profit-pill.negative').count()===1,'loss has no distinct state');await closeToasts();
    userCost=null;await page.reload();await row.locator('.usage-profit-pill').waitFor();check((await row.locator('.usage-profit-pill').innerText()).includes('—'),'missing U became a fake loss');
    userCost=0;await page.reload();await row.locator('.usage-profit-pill').waitFor();check((await row.locator('.usage-profit-pill').innerText()).includes('-￥20.00'),'known zero U did not subtract cost');userCost=2;
  });
  await run('toast-pauses-on-focus-and-auto-dismisses',async()=>{
    await saveCost('12.34');const toast=page.locator('.task-toast.success');await toast.waitFor();
    await toast.getByRole('button',{name:'关闭任务通知',exact:true}).focus();await page.waitForTimeout(6300);check(await toast.isVisible(),'toast expired while keyboard focused');
    await page.getByRole('button',{name:'任务设置',exact:true}).focus();await page.mouse.move(0,0);await toast.waitFor({state:'hidden',timeout:7500});
  });
  await run('task-errors-use-dismissible-toast',async()=>{
    await page.route('**/api/jobs/delete-batch',route=>route.fulfill({status:500,json:{error:'fixture-delete-failed'}}));await page.evaluate(()=>{window.confirm=()=>true});
    await row.getByRole('button',{name:'删除账号',exact:true}).click();const toast=page.locator('.task-toast.error');await toast.getByText('fixture-delete-failed',{exact:true}).waitFor();
    check(await toast.getAttribute('role')==='alert','error toast has no alert semantics');await toast.getByRole('button',{name:'关闭错误通知',exact:true}).click();await toast.waitFor({state:'hidden'});
  });
  await run('task-progress-toast-does-not-expire-mid-task',async()=>{
    let release,requested;const gate=new Promise(r=>release=r),started=new Promise(r=>requested=r);
    await page.route('**/api/jobs/cooldown-batch',async route=>{requested();await gate;return route.fulfill({json:{started:1,skipped:0,cooldownMinutes:60}})});
    try {
      await row.getByRole('checkbox').check();await page.locator('.bulk-more-trigger').click();
      await page.getByRole('menuitem',{name:'一键冷却',exact:true}).click();await started;
      const toast=page.locator('.task-toast.success');await toast.waitFor();check(await toast.getAttribute('aria-busy')==='true','progress toast is not busy');
      await page.mouse.move(0,0);await page.waitForTimeout(6300);check(await toast.isVisible(),'progress toast expired before task completed '+JSON.stringify(await page.evaluate(()=>({exists:!!document.querySelector('.task-toast.success'),busy:document.querySelector('.task-toast.success')?.getAttribute('aria-busy'),open:document.querySelector('.task-toast-region')?.matches(':popover-open'),text:document.querySelector('.task-toast-region')?.textContent,workflow:!!document.querySelector('.workflow-busy')}))));
      release();await page.waitForFunction(()=>document.querySelector('.task-toast.success')?.getAttribute('aria-busy')==='false');await closeToasts();
      await row.getByRole('checkbox').uncheck();
    } finally {release();await page.unroute('**/api/jobs/cooldown-batch')}
  });
  await run('mobile-price-and-toast-fit-viewport',async()=>{
    await page.setViewportSize({width:375,height:812});await saveCost('10');const toast=page.locator('.task-toast.success');await toast.waitFor();const b=await toast.boundingBox();check(b.x>=0&&b.x+b.width<=376,'mobile toast overflow');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');await page.screenshot({path:evidence+'/pricing-toast-mobile.png'});await closeToasts();
    await page.getByRole('button',{name:'任务设置',exact:true}).click();const rate=page.getByRole('spinbutton',{name:'号池价格倍率',exact:true});await rate.scrollIntoViewIfNeeded();const r=await rate.boundingBox();check(r.x>=0&&r.x+r.width<=375,'mobile multiplier input overflow');await page.keyboard.press('Escape');check(!errors.length,errors.join('; '));
  });
  await page.unrouteAll({behavior:'wait'});return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
