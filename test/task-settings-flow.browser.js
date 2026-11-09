async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],writes=[];
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/task-settings'))writes.push(r.postDataJSON());});
  const check=(value,message)=>{if(!value)throw Error(message);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
  const api=body=>page.evaluate(async patch=>{const b=await fetch('/api/bootstrap').then(r=>r.json());const r=await fetch('/api/task-settings',{headers:{'x-console-token':b.token,'content-type':'application/json'},...(patch?{method:'POST',body:JSON.stringify(patch)}:{})});if(!r.ok)throw Error(await r.text());return(await r.json()).settings;},body);
  const open=async()=>{await page.getByRole('button',{name:'任务设置',exact:true}).click();const d=page.getByRole('dialog',{name:'任务设置',exact:true});await d.waitFor();return d;};
  const save=async d=>{const result=page.waitForResponse(r=>r.url().endsWith('/api/task-settings')&&r.request().method()==='POST');await d.getByRole('button',{name:'保存设置',exact:true}).click();const r=await result;check(r.ok(),await r.text());await d.waitFor({state:'hidden'});return r.request().postDataJSON();};
  await api({smsTimeoutMinutes:25,poolPriceMultiplier:7,webSessionMonitor:{enabled:false,intervalMinutes:37,retryMinutes:73,autoRelogin:false},overloadAutoCooldown:{windowMinutes:21,threshold:17,cooldownMinutes:42},autoActions:{free:['enable-overload-detection']}});
  await page.setViewportSize({width:1440,height:1000});let d=await open();
  await test('one-overload-section-with-statistics-and-cooldown',async()=>{
    const section=d.locator('.task-overload-settings');check(await section.count()===1,'overload section duplicated');
    check(await section.getByRole('heading',{name:'统计展示',exact:true}).count()===1,'statistics heading missing');
    check(await section.getByRole('heading',{name:'自动冷却',exact:true}).count()===1,'cooldown heading missing');
    check(await section.locator('input').count()===7,'overload inputs missing');
    check(await d.getByRole('heading',{name:'过载监控',exact:true}).count()===0,'old overload section remains');
    check(await d.getByRole('checkbox',{name:'自动开启过载统计',exact:true}).isChecked(),'preset switch renamed incorrectly');
    check(!await section.locator('#monitor-overloadConcurrency').isVisible(),'advanced options not collapsed');
    await section.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/task-settings-overload-desktop.png'});
  });
  await test('unchanged-form-submits-no-monitor-or-credential-settings',async()=>{
    const payload=await save(d);check(Object.keys(payload).length===0,'unchanged fields resent: '+JSON.stringify(payload));d=await open();
  });
  await test('saving-one-field-preserves-newer-server-values',async()=>{
    await api({monitoring:{overloadConcurrency:77},webSessionMonitor:{retryMinutes:120}});
    await d.locator('#monitor-overloadIntervalSeconds').fill('600');const payload=await save(d);
    check(JSON.stringify(payload)===JSON.stringify({monitoring:{overloadIntervalSeconds:600}}),'not a sparse patch: '+JSON.stringify(payload));
    const current=await api();check(current.monitoring.overloadConcurrency===77&&current.webSessionMonitor.retryMinutes===120,'concurrent values overwritten');d=await open();
  });
  await test('folded-concurrency-keeps-edits-and-validates-before-request',async()=>{
    const details=d.locator('.task-overload-advanced'),summary=details.locator('summary');await summary.focus();await page.keyboard.press('Enter');
    await details.locator('#monitor-overloadConcurrency').fill('0');const before=writes.length;await d.getByRole('button',{name:'保存设置',exact:true}).click();check(writes.length===before,'invalid value sent');
    check(await d.getByRole('alert').isVisible(),'validation feedback missing');await details.locator('#monitor-overloadConcurrency').fill('12');await summary.click();
    const payload=await save(d);check(payload.monitoring?.overloadConcurrency===12,'collapsed field edit lost');d=await open();
  });
  await test('restore-defaults-includes-sms-and-price-preserves-plan-and-fingerprint',async()=>{
    await d.getByRole('button',{name:'恢复默认',exact:true}).click();
    check(await d.locator('#task-sms-timeout').inputValue()==='10','SMS default omitted');check(await d.locator('#task-pool-price-multiplier').inputValue()==='1','price default omitted');
    check(await d.getByRole('checkbox',{name:'自动开启过载统计',exact:true}).isChecked(),'reset removed plan rule');
    const before=await api();check(before.smsTimeoutMinutes===25&&before.poolPriceMultiplier===7,'reset saved without submit');const payload=await save(d),after=await api();
    check(payload.smsTimeoutMinutes===10&&payload.poolPriceMultiplier===1,'reset fields missing from patch');check(!Object.hasOwn(payload,'modelFingerprint')&&!Object.hasOwn(payload.monitoring||{},'fingerprintScanIntervalSeconds'),'hidden degradation settings overwritten');
    check(JSON.stringify(after.modelFingerprint)===JSON.stringify(before.modelFingerprint),'degradation settings changed');
  });
  await test('mobile-containment-and-keyboard-return',async()=>{
    await page.setViewportSize({width:375,height:812});d=await open();await d.locator('.task-overload-settings').scrollIntoViewIfNeeded();await d.locator('.task-overload-advanced > summary').click();
    check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog horizontal overflow');
    check(await d.locator('.task-overload-settings input').evaluateAll(nodes=>nodes.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})),'overload inputs overflow');
    await page.screenshot({path:evidence+'/task-settings-overload-mobile.png'});await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});
    check(await page.getByRole('button',{name:'任务设置',exact:true}).evaluate(el=>el===document.activeElement),'focus not restored');check(!errors.length,errors.join('; '));
  });
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
