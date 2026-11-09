async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],mutations=[];
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  const check=(value,message)=>{if(!value)throw Error(message);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
  const records=['match','mismatch','unknown','match','error','match'].map((status,i)=>({method:i%2?'fingerprint':'candy',status,checkedAt:`2026-11-01T0${6-i}:00:00Z`}));
  let running=false;
  const state=()=>({enabled:false,phase:running?'running':'idle',runningMethod:running?'candy':null,models:[{model:'fixture',expected:'fixture'}],override:{enabled:false},recentResults:records,result:null});
  await page.route('**/api/sub2api/account-status*',r=>r.fulfill({json:{configured:false,accounts:{}}}));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{const r=await route.fetch(),data=await r.json();data.jobs=data.jobs.map((j,i)=>({...j,status:i===3?'banned':'completed',autoRepairBlocked:i===3,sub2apiInPool:true,sub2apiEnabled:i===1,codexStatusEligible:i===1,sub2apiQuotaRestricted:i===4,sub2apiRateLimited:i===5,sub2apiUsage:null,canCheckModelFingerprint:i<=1,overloadAutoCooldown:{phase:i===0?'cooling':'idle'},modelFingerprint:{...state(),enabled:i===1}}));await route.fulfill({json:data});});
  await page.route(/\/api\/jobs\/[^/]+\/model-fingerprint\/check$/,route=>{mutations.push(route.request().url());running=true;return route.fulfill({status:202,json:{job:{modelFingerprint:state()}}});});
  await page.route(/\/api\/jobs\/[^/]+\/model-fingerprint\/history(?:\?|$)/,route=>route.fulfill({json:{records:records.map(r=>({...r,models:[]})),models:[]}}));
  await page.setViewportSize({width:1480,height:1000});await page.reload();await page.locator('tr.job-row').first().waitFor();
  const row=i=>page.locator('tr.job-row').nth(i),bars=i=>row(i).locator('.fingerprint-round'),button=i=>row(i).locator('.fingerprint-check-button');
  const snapshot=i=>bars(i).evaluateAll(nodes=>nodes.map(n=>({color:getComputedStyle(n).backgroundColor,title:n.getAttribute('aria-label')})));
  await test('cooling-retains-history-colors-timestamps-and-detail-access',async()=>{
    const a=await snapshot(0),b=await snapshot(1);check(a.every((r,i)=>r.color===b[i].color),'cooling history was grayed');check(a.every(r=>r.title.includes('历史结果')&&r.title.includes('2026/11/01')),'timestamps/history label lost');
    await bars(0).last().click();await page.getByRole('dialog').waitFor();check(await page.getByRole('dialog').locator('.fingerprint-timeline-node').count()===6,'history unreadable');await page.keyboard.press('Escape');
    await row(0).locator('.codex-status').screenshot({path:evidence+'/cooling-history.png'});
  });
  await test('cooling-manual-check-allowed-automation-switch-stays-disabled',async()=>{
    check(await button(0).isEnabled(),'cooling manual check disabled');check((await button(0).getAttribute('title')).includes('不解除冷却'),'cooling side effect not explained');
    check(await row(0).getByRole('switch',{name:/降智检测/}).isDisabled(),'automatic checks re-enabled');
    const before=await snapshot(0);await button(0).click();check(await button(0).isDisabled(),'running check is clickable');check(await button(0).locator('svg.spin').count()===1,'running spinner missing');await button(0).evaluate(el=>el.click());check(mutations.length===1,'duplicate request submitted');check(JSON.stringify(await snapshot(0))===JSON.stringify(before),'starting check changed historical results');running=false;await page.reload();await row(0).waitFor();
  });
  await test('manual-disabled-banned-quota-and-429-remain-blocked',async()=>{for(const i of [2,3,4,5])check(await button(i).isDisabled(),'blocked account became testable '+i);});
  await test('retry-settings-validate-and-persist-with-disable-option',async()=>{
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();let d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    const count=d.getByRole('spinbutton',{name:'检测失败重试次数',exact:true}),delay=d.getByRole('spinbutton',{name:'检测失败重试间隔（秒）',exact:true});
    check(await count.inputValue()==='1'&&await delay.inputValue()==='5','retry defaults wrong');
    let posts=0;const listen=r=>{if(r.method()==='POST'&&r.url().endsWith('/api/model-fingerprint/settings'))posts++;};page.on('request',listen);
    await count.fill('');await d.getByRole('button',{name:'保存降智检测设置'}).click();check(posts===0,'blank retries sent');await count.fill('6');await d.getByRole('button',{name:'保存降智检测设置'}).click();check(posts===0,'excess retries sent');
    await count.fill('0');await delay.fill('0');await d.getByRole('button',{name:'保存降智检测设置'}).click();check(posts===0,'invalid delay sent');await delay.fill('9');
    const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/model-fingerprint/settings'));await d.getByRole('button',{name:'保存降智检测设置'}).click();const response=await pending;check(response.ok(),'save rejected');const body=response.request().postDataJSON();check(body.settings.failureRetries===0&&body.settings.failureRetryDelaySeconds===9,'retry fields missing');page.off('request',listen);await d.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();d=page.getByRole('dialog',{name:'降智检测设置',exact:true});check(await d.getByRole('spinbutton',{name:'检测失败重试次数',exact:true}).inputValue()==='0','retry disable not persisted');check(await d.getByRole('spinbutton',{name:'检测失败重试间隔（秒）',exact:true}).inputValue()==='9','delay not persisted');
    await d.getByRole('spinbutton',{name:'检测失败重试次数',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/candy-retry-settings-desktop.png'});await page.keyboard.press('Escape');
  });
  await test('mobile-history-and-retry-settings-stay-contained',async()=>{
    await page.setViewportSize({width:375,height:812});await row(0).locator('.codex-status').scrollIntoViewIfNeeded();check(await row(0).locator('.codex-status').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'cell overflow');
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});await d.getByRole('spinbutton',{name:'检测失败重试次数',exact:true}).scrollIntoViewIfNeeded();check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'settings overflow');await page.screenshot({path:evidence+'/candy-retry-settings-mobile.png'});await page.keyboard.press('Escape');check(!errors.length,errors.join('; '));
  });
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
