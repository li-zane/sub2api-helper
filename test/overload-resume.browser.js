async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [];
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({name, passed:true}); } catch (error) { results.push({name, passed:false,error:error.message}); } };
  const api = patch => page.evaluate(async patch => {
    const {token} = await fetch('/api/bootstrap').then(r => r.json());
    const r = await fetch('/api/task-settings', {headers:{'x-console-token':token,'content-type':'application/json'},
      ...(patch ? {method:'POST', body:JSON.stringify(patch)} : {})});
    if (!r.ok) throw Error(await r.text()); return (await r.json()).settings;
  }, patch);
  const open = async () => { await page.getByRole('button',{name:'任务设置',exact:true}).click(); const d=page.getByRole('dialog',{name:'任务设置',exact:true}); await d.waitFor(); return d; };
  const save = async d => { const done=page.waitForResponse(r=>r.url().endsWith('/api/task-settings')&&r.request().method()==='POST'); await d.getByRole('button',{name:'保存设置',exact:true}).click();check((await done).ok(),'save failed');await d.waitFor({state:'hidden'}); };
  let d;
  await page.setViewportSize({width:1440,height:1000});
  await test('independent-type-switches-default-on-save-reopen-and-concurrent-edits',async()=>{
    d=await open();const section=d.locator('.task-overload-settings');
    const long=section.getByRole('checkbox',{name:'长效账号过载后冷却',exact:true});
    const rotating=section.getByRole('checkbox',{name:'轮转账号过载后冷却',exact:true});
    check(await long.isChecked()&&await rotating.isChecked(),'legacy type defaults changed');
    await long.uncheck();
    await api({overloadAutoCooldown:{rotating:false,threshold:19}});
    await section.scrollIntoViewIfNeeded(); await page.screenshot({path:evidence+'/overload-types-desktop.png'});
    await save(d);let settings=await api();
    check(settings.overloadAutoCooldown.longTerm===false&&settings.overloadAutoCooldown.rotating===false&&settings.overloadAutoCooldown.threshold===19,'save overwrote concurrent edits');
    d=await open();check(!await d.getByRole('checkbox',{name:'长效账号过载后冷却',exact:true}).isChecked(),'long-term selection not persisted');
    await d.getByRole('checkbox',{name:'轮转账号过载后冷却',exact:true}).check();await save(d);
    settings=await api();check(!settings.overloadAutoCooldown.longTerm&&settings.overloadAutoCooldown.rotating,'independent rotating toggle failed');
  });
  await test('mobile-settings-fit-and-cancel-preserves-type-values',async()=>{
    await page.setViewportSize({width:375,height:812});d=await open();
    await d.locator('.task-overload-settings').scrollIntoViewIfNeeded();
    check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile horizontal overflow');
    await d.getByRole('checkbox',{name:'长效账号过载后冷却',exact:true}).check();
    await page.screenshot({path:evidence+'/overload-types-mobile.png'});
    await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});
    check((await api()).overloadAutoCooldown.longTerm===false,'cancel saved draft');
  });
  await test('assumed-degradation-is-visible-without-fabricated-history',async()=>{
    await page.route('**/api/jobs**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(!['/api/jobs','/api/jobs/query'].includes(pathname)){await route.continue();return;}
      const response=await route.fetch(),data=await response.json();
      if(data.jobs?.length)data.jobs[0].modelFingerprint={...data.jobs[0].modelFingerprint,assumedDegraded:{at:new Date().toISOString(),recheckPending:true},recentResults:[]};
      await route.fulfill({response,json:data});
    });
    await page.setViewportSize({width:1440,height:1000});await page.reload();
    await page.getByText('按降智处理 · 等待重新检测',{exact:true}).first().waitFor();
    check((await page.title()).includes('Helper'),'wrong page');check(await page.locator('tr.job-row').count()>0,'blank list');
    check(await page.locator('vite-error-overlay').count()===0,'framework overlay');check(errors.length===0,errors.join('; '));
    await page.screenshot({path:evidence+'/overload-resumed-status.png'});
  });
  return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
