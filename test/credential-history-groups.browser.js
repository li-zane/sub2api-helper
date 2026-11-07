async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],details=[],writes=[];
  const check=(ok,message)=>{if(!ok)throw Error(message)};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message});await page.screenshot({path:evidence+'/'+name+'-failed.png'}).catch(()=>{})}};
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url())});
  const entries=[
    {id:'p-old',type:'password',stage:'imported',at:'2026-10-01T00:00:00Z'},
    {id:'t-old',type:'2fa',stage:'imported',at:'2026-11-02T00:00:00Z'},
    {id:'p-current',type:'password',stage:'current',at:'2026-11-06T00:00:00Z'},
    {id:'web',type:'web_session',stage:'current',at:'2026-11-07T00:00:00Z'},
    {id:'p-new',type:'password',stage:'submission_pending',at:'2026-11-07T01:00:00Z'},
    {id:'t-new',type:'2fa',stage:'activated',at:'2026-11-07T02:00:00Z'},
    {id:'oauth',type:'codex_oauth',stage:'current',at:'2026-11-07T03:00:00Z'},
    {id:'p-unknown',type:'password',stage:'prepared',at:null},
  ];
  const protocol=[{id:'task-a',label:'自动 Web 登录',type:'web_login',at:'2026-11-07T00:00:00Z',status:'completed'},{id:'task-b',label:'密码轮换任务',type:'replace_password',at:'2026-11-07T01:00:00Z',status:'completed'}];
  let loads=0;
  await page.route('**/api/jobs/*/logs?*',async route=>{
    const url=new URL(route.request().url()),view=url.searchParams.get('view'),id=url.searchParams.get('entry');
    if(id)details.push({view,id});if(view==='credentials')loads++;
    await route.fulfill({json:{view,entries:view==='credentials'?[...entries]:protocol,selectedId:id,content:id?JSON.stringify({id,value:'FIXTURE_SECRET_'+id}):'',retention:'模拟记录；历史保留，候选不代表生效'}});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('tr.job-row').first().getByRole('button',{name:'查看协议日志',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'账号日志与凭据',exact:true}),menu=dialog.getByRole('navigation',{name:'凭据记录',exact:true});
  const group=type=>menu.locator(`[data-credential-type="${type}"]`),toggle=type=>group(type).locator('.account-credential-toggle');
  const entry=id=>menu.locator(`[data-entry-id="${id}"]`);
  await dialog.getByRole('tab',{name:'凭据历史',exact:true}).click();await group('password').waitFor();
  await test('default-collapsed-latest-only-and-groups-newest-first',async()=>{
    check(await menu.locator('.account-credential-group').count()===4,'same type rendered as flat peers');
    check(JSON.stringify(await menu.locator('.account-credential-group').evaluateAll(nodes=>nodes.map(n=>n.dataset.credentialType)))===JSON.stringify(['codex_oauth','2fa','password','web_session']),'groups not ordered by newest timestamp');
    check(await menu.locator('.account-credential-version').count()===0,'history must start collapsed');
    check(await group('password').locator('.account-credential-latest').getAttribute('data-entry-id')==='p-new','current alias displaced newer candidate');
    check(await toggle('password').getAttribute('aria-expanded')==='false','default expanded state');
    check(await group('web_session').locator('.account-credential-toggle').count()===0,'single-version credential has empty expander');
    check(details.length===0&&await dialog.locator('pre').count()===0,'credential secrets prefetched on listing');
    await dialog.screenshot({path:evidence+'/credentials-collapsed.png'});
  });
  await test('expanded-history-is-indented-descending-and-independent',async()=>{
    await toggle('password').click();
    check(JSON.stringify(await group('password').locator('.account-credential-version').evaluateAll(nodes=>nodes.map(n=>n.dataset.entryId)))===JSON.stringify(['p-current','p-old','p-unknown']),'versions not ordered newest-first/unknown-last');
    check(await entry('p-unknown').locator('time').innerText()==='时间未知','undated history incorrectly marked as current');
    const top=await entry('p-new').boundingBox(),nested=await entry('p-current').boundingBox();
    check(nested.x>top.x+8,'old versions are still at same hierarchy level');
    await toggle('2fa').click();check(await entry('t-old').isVisible(),'independent group not expanded');
    check(await entry('p-current').isVisible(),'opening another group collapsed the first');
    check(details.length===0,'expanding history fetched secrets');
    await dialog.screenshot({path:evidence+'/credentials-expanded.png'});
  });
  await test('old-version-selection-copy-and-collapse-keep-right-detail',async()=>{
    await entry('p-current').click();await dialog.locator('pre').filter({hasText:'FIXTURE_SECRET_p-current'}).waitFor();
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__credentialCopy=value}}})});
    await dialog.getByRole('button',{name:'复制内容',exact:true}).click();
    check((await page.evaluate(()=>window.__credentialCopy)).includes('FIXTURE_SECRET_p-current'),'copied wrong version');
    await toggle('password').click();check(await entry('p-current').count()===0,'collapsed old entries stayed in tab order');
    check((await dialog.locator('pre').innerText()).includes('FIXTURE_SECRET_p-current'),'collapse discarded selected detail');
    check(await group('password').evaluate(el=>el.classList.contains('has-selected-history')),'collapsed selected-history cue missing');
    await toggle('password').click();check(await entry('p-current').getAttribute('aria-pressed')==='true','selected history lost after reopening');
  });
  await test('polling-new-version-preserves-open-state-and-selected-ID',async()=>{
    const before=loads;entries.push({id:'p-latest',type:'password',stage:'confirmed',at:'2026-11-07T04:00:00Z'});
    await page.waitForResponse(r=>r.url().includes('/logs?')&&new URL(r.url()).searchParams.get('view')==='credentials');
    await entry('p-latest').waitFor();check(loads>before,'automatic metadata poll did not run');
    check(await toggle('password').getAttribute('aria-expanded')==='true','poll reset expansion');
    check(await entry('p-current').getAttribute('aria-pressed')==='true','poll switched selected credential');
    check(await menu.locator('.account-credential-group').first().getAttribute('data-credential-type')==='password','new group did not move to top');
    check(await group('password').locator('.account-credential-version').first().getAttribute('data-entry-id')==='p-new','previous latest not moved into ordered history');
    check((await dialog.locator('pre').innerText()).includes('FIXTURE_SECRET_p-current'),'poll replaced selected secret with new latest');
  });
  await test('latest-entry-loads-only-selected-record-and-tabs-stay-independent',async()=>{
    await entry('p-latest').click();await dialog.locator('pre').filter({hasText:'FIXTURE_SECRET_p-latest'}).waitFor();
    check(!details.some(d=>d.view==='credentials'&&!['p-current','p-latest'].includes(d.id)),'hidden history was prefetched');
    await dialog.getByRole('tab',{name:'协议日志',exact:true}).click();
    await dialog.getByRole('button',{name:/自动 Web 登录/}).waitFor();
    check(await dialog.locator('.account-credential-group').count()===0,'protocol tasks incorrectly grouped as credentials');
    check((await dialog.locator('.account-log-menu .account-log-entry').first().innerText()).includes('自动 Web 登录'),'protocol order changed');
    check(await dialog.locator('pre').count()===0,'secret leaked into protocol view');
    await dialog.getByRole('tab',{name:'凭据历史',exact:true}).click();await group('password').waitFor();
    check(await toggle('password').getAttribute('aria-expanded')==='true','tab change reset remembered expansion');
    check(await dialog.locator('pre').count()===0,'tab change retained old private detail');
  });
  await test('keyboard-disclosure-and-375px-layout-remain-usable',async()=>{
    await toggle('password').focus();await page.keyboard.press('Enter');check(await toggle('password').getAttribute('aria-expanded')==='false','Enter did not collapse');
    await page.keyboard.press('Space');check(await toggle('password').getAttribute('aria-expanded')==='true','Space did not expand');
    const controls=await toggle('password').getAttribute('aria-controls');check(await page.evaluate(id=>!!document.getElementById(id),controls),'disclosure controls missing element');
    await page.setViewportSize({width:375,height:812});await entry('p-old').scrollIntoViewIfNeeded();await entry('p-old').click();
    await dialog.locator('pre').filter({hasText:'FIXTURE_SECRET_p-old'}).waitFor();
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');
    check(await menu.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'nested versions overflow menu');
    await dialog.screenshot({path:evidence+'/credentials-mobile.png'});
  });
  await test('metadata-groups-do-not-write-or-report-runtime-errors',async()=>{check(writes.length===0,'history grouping performed a write');check(errors.length===0,errors.join('; '))});
  await dialog.getByRole('button',{name:'关闭协议日志',exact:true}).click();
  await page.unrouteAll({behavior:'wait'});return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
