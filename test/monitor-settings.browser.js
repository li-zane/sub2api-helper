async (page) => {
  const results=[],errors=[],evidenceDir="__UI_TEST_EVIDENCE_DIR__";
  const check=(v,m)=>{if(!v)throw Error(m);};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}};
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1000});
  const open=async()=>{await page.getByRole('button',{name:'任务设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'任务设置',exact:true});await dialog.waitFor();await dialog.locator('.task-overload-advanced > summary').click();return dialog;};
  let modal=await open(),savedBody;
  await test('all-monitor-controls-defaults-and-labels',async()=>{
    check(await modal.locator('#task-login-timeout').inputValue()==='3','login timeout default');
    await modal.locator('#task-login-timeout').scrollIntoViewIfNeeded();
    await page.screenshot({path:evidenceDir+'/login-timeout-desktop.png'});
    check(await modal.locator('input[id^="monitor-"]').count()===11,'missing monitor settings');
    for(const key of ['usageTotalsConcurrency','overloadConcurrency','overloadCooldownConcurrency','profileSyncConcurrency']) check(await modal.locator('#monitor-'+key).inputValue()==='100',key+' default');
    check(await modal.locator('#fingerprint-default-concurrency, #fingerprint-default-interval').count()===0,'degradation settings duplicated');
    check(await modal.getByLabel('检测间隔（分钟）',{exact:true}).count()===1,'duplicated Web account interval');
    const web=modal.locator('section[aria-labelledby="web-session-monitor-title"]');
    check(await web.getByLabel('到期任务扫描间隔（秒）',{exact:true}).inputValue()==='30','Web scheduler field missing, duplicated or default changed');
    check(await modal.getByRole('heading',{name:'巡检调度',exact:true}).count()===0,'separate scheduler section remains');
    await web.scrollIntoViewIfNeeded();await page.screenshot({path:evidenceDir+'/websession-settings-desktop.png'});
  });
  await test('reject-invalid-login-timeout-before-request',async()=>{
    let posts=0;const cb=req=>{if(req.url().includes('/api/task-settings')&&req.method()==='POST')posts++;};page.on('request',cb);
    try{
      for(const value of ['0','','1.5','1441']){
        await modal.locator('#task-login-timeout').fill(value);await modal.getByRole('button',{name:'保存设置',exact:true}).click();
        check(posts===0,'invalid timeout sent to server');
        check(await modal.getByText('登录超时必须为 1–1440 的整数（分钟）',{exact:true}).isVisible(),'login timeout validation missing');
      }
    }finally{page.off('request',cb);await modal.locator('#task-login-timeout').fill('3');}
  });
  await test('reject-invalid-settings-before-request',async()=>{
    let posts=0;const cb=req=>{if(req.url().includes('/api/task-settings')&&req.method()==='POST')posts++;};page.on('request',cb);
    try{await modal.locator('#monitor-overloadConcurrency').fill('0');await modal.getByRole('button',{name:'保存设置',exact:true}).click();check(posts===0,'invalid request submitted');check(await modal.getByText('次数同步并发必须为 1–1000 的整数（请求）',{exact:true}).isVisible(),'range error missing');}finally{page.off('request',cb);}
    await modal.locator('#monitor-overloadConcurrency').fill('12');
  });
  await test('save-and-reopen-persist-all-fields',async()=>{
    await modal.locator('#task-login-timeout').fill('5');
    await modal.locator('#monitor-accountStatusIntervalSeconds').fill('25');
    await modal.locator('#monitor-usageTotalsConcurrency').fill('11');
    await modal.locator('#monitor-webSessionScanIntervalSeconds').fill('45');
    const reply=page.waitForResponse(r=>r.url().includes('/api/task-settings')&&r.request().method()==='POST');
    await modal.getByRole('button',{name:'保存设置',exact:true}).click();const r=await reply;savedBody=r.request().postDataJSON();check(r.ok(),'save failed');
    await modal.waitFor({state:'hidden'});modal=await open();
    check(await modal.locator('#task-login-timeout').inputValue()==='5'&&savedBody.loginTimeoutMinutes===5,'login timeout not persisted');
    check(await modal.locator('#monitor-overloadConcurrency').inputValue()==='12','overload not persisted');
    check(await modal.locator('#monitor-usageTotalsConcurrency').inputValue()==='11','usage not persisted');
    check(savedBody.monitoring.accountStatusIntervalSeconds===25,'cadence omitted');
    check(savedBody.monitoring.webSessionScanIntervalSeconds===45&&await modal.locator('#monitor-webSessionScanIntervalSeconds').inputValue()==='45','relocated scheduler value not persisted');
    check(!Object.hasOwn(savedBody,'modelFingerprint'),'task settings overwrite detection settings');
  });
  await test('desktop-dialog-scroll-and-keyboard',async()=>{
    await modal.locator('#monitor-overloadConcurrency').scrollIntoViewIfNeeded();
    check(await modal.locator('#monitor-overloadConcurrency').isVisible(),'control unreachable');
    const b=await modal.boundingBox();check(b.x>=0&&b.x+b.width<=1441,'desktop overflow');
    await page.screenshot({path:evidenceDir+'/monitor-settings-desktop.png'});
    await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
    check(await page.getByRole('button',{name:'任务设置',exact:true}).evaluate(el=>el===document.activeElement),'focus not restored');
  });
  await test('mobile-dialog-width-and-save-access',async()=>{
    await page.setViewportSize({width:375,height:812});modal=await open();
    const b=await modal.boundingBox();check(b.x>=0&&b.x+b.width<=376,'mobile overflow');
    await modal.locator('#task-login-timeout').scrollIntoViewIfNeeded();
    check(await modal.locator('#task-login-timeout').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=375;}),'login timeout input overflows');
    await page.screenshot({path:evidenceDir+'/login-timeout-mobile.png'});
    await modal.locator('#monitor-usageTotalsConcurrency').scrollIntoViewIfNeeded();
    check(await modal.locator('#monitor-usageTotalsConcurrency').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=375;}),'input exceeds viewport');
    await page.screenshot({path:evidenceDir+'/monitor-settings-mobile.png'});
    await modal.locator('#monitor-webSessionScanIntervalSeconds').scrollIntoViewIfNeeded();
    check(await modal.locator('#monitor-webSessionScanIntervalSeconds').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=375;}),'Web scheduler input exceeds mobile viewport');
    await page.screenshot({path:evidenceDir+'/websession-settings-mobile.png'});
    await modal.getByRole('button',{name:'取消',exact:true}).click();
  });
  await test('restore-defaults-is-local-until-save',async()=>{
    modal=await open();await modal.getByRole('button',{name:'恢复默认',exact:true}).click();
    check(await modal.locator('#task-login-timeout').inputValue()==='3','login timeout default not restored');
    check(await modal.locator('#monitor-usageTotalsConcurrency').inputValue()==='100','network default not restored');
    check(await modal.locator('#fingerprint-default-concurrency').count()===0,'restore default adds duplicate degradation controls');
    await modal.getByRole('button',{name:'取消',exact:true}).click();modal=await open();
    check(await modal.locator('#task-login-timeout').inputValue()==='5','cancel overwrote login timeout');
    check(await modal.locator('#monitor-usageTotalsConcurrency').inputValue()==='11','cancel persisted reset');
    await modal.getByRole('button',{name:'取消',exact:true}).click();
  });
  await test('no-browser-runtime-errors',async()=>check(!errors.length,errors.join('\n')));
  return {passed:results.filter(x=>x.passed).length,total:results.length,results};
}
