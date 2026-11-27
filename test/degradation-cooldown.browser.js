async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__", results=[], errors=[];
  page.setDefaultTimeout(7000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const check=(value,message)=>{if(!value)throw Error(message);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}};
  const api=patch=>page.evaluate(async patch=>{
    const {token}=await fetch('/api/bootstrap').then(r=>r.json());
    const response=await fetch('/api/model-fingerprint/settings',{headers:{'x-console-token':token,'content-type':'application/json'},...(patch?{method:'POST',body:JSON.stringify({patch})}:{})});
    if(!response.ok)throw Error(await response.text());return (await response.json()).settings;
  },patch);
  const open=async()=>{await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'降智检测设置',exact:true});await dialog.waitFor();return dialog;};
  const save=async dialog=>{const next=page.waitForResponse(r=>r.url().endsWith('/api/model-fingerprint/settings')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'保存降智检测设置',exact:true}).click();check((await next).ok(),'save failed');await dialog.waitFor({state:'hidden'});};
  await page.setViewportSize({width:1440,height:1000});
  let dialog;
  await test('default-off-configure-independent-types-and-duration',async()=>{
    dialog=await open();const section=dialog.getByRole('region',{name:'降智冷却',exact:true});
    check(!await section.getByRole('checkbox',{name:'启用降智冷却',exact:true}).isChecked(),'master must default off');
    check(await section.getByRole('spinbutton',{name:'降智冷却时长（分钟）'}).isDisabled(),'disabled master fields active');
    await section.getByRole('checkbox',{name:'启用降智冷却',exact:true}).check();
    check(!await section.getByRole('checkbox',{name:'长效账号降智后冷却'}).isChecked()&&!await section.getByRole('checkbox',{name:'轮转账号降智后冷却'}).isChecked(),'types must default off');
    await section.getByRole('checkbox',{name:'长效账号降智后冷却'}).check();
    await section.getByRole('spinbutton',{name:'降智冷却时长（分钟）'}).fill('90');
    await section.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/cooldown-desktop.png'});
    await save(dialog);
    const rule=(await api()).degradationCooldown;
    check(rule.enabled&&rule.longTerm&&!rule.rotating&&rule.cooldownMinutes===90,'rule not persisted');
    dialog=await open();check(await dialog.getByRole('spinbutton',{name:'降智冷却时长（分钟）'}).inputValue()==='90','reopen lost duration');
  });
  await test('nested-edits-preserve-concurrent-duration-and-toggle-types',async()=>{
    await api({degradationCooldown:{cooldownMinutes:120}});
    await dialog.getByRole('checkbox',{name:'长效账号降智后冷却'}).uncheck();
    await dialog.getByRole('checkbox',{name:'轮转账号降智后冷却'}).check();
    await save(dialog);const rule=(await api()).degradationCooldown;
    check(!rule.longTerm&&rule.rotating&&rule.cooldownMinutes===120,'concurrent duration overwritten');
  });
  await test('mobile-layout-cancel-and-master-off-preserve-type-choices',async()=>{
    await page.setViewportSize({width:375,height:812});dialog=await open();
    const section=dialog.getByRole('region',{name:'降智冷却',exact:true});await section.scrollIntoViewIfNeeded();
    check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'horizontal overflow');
    await page.screenshot({path:evidence+'/cooldown-mobile.png'});
    await dialog.getByRole('spinbutton',{name:'降智冷却时长（分钟）'}).fill('1');
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    check((await api()).degradationCooldown.cooldownMinutes===120,'cancel saved duration');
    dialog=await open();await dialog.getByRole('checkbox',{name:'启用降智冷却',exact:true}).uncheck();await save(dialog);
    const rule=(await api()).degradationCooldown;check(!rule.enabled&&rule.rotating&&rule.cooldownMinutes===120,'master changed saved options');
  });
  await test('account-displays-rest-deadline-and-retains-history',async()=>{
    await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
      const response=await route.fetch(),data=await response.json();
      if(data.jobs)data.jobs=data.jobs.map(job=>job.email==='review-1@example.test'?{...job,sub2apiInPool:true,sub2apiEnabled:false,codexStatusEligible:false,canCheckModelFingerprint:true,
        degradationCooldown:{paused:true,phase:'cooling',coolingUntil:'2026-11-27T06:00:00Z',validity:'轮转'},
        modelFingerprint:{...job.modelFingerprint,models:[{model:'fixture'}],recentResults:[{status:'mismatch',method:'candy',checkedAt:'2026-11-27T05:00:00Z'}]}}:job);
      await route.fulfill({response,json:data});
    });
    await page.setViewportSize({width:1440,height:1000});await page.reload();
    const row=page.locator('tr.job-row').filter({has:page.getByRole('checkbox',{name:'选择 review-1@example.test',exact:true})});
    await row.getByText('降智冷却至 2026/11/27 14:00:00',{exact:true}).waitFor();
    check(await row.getByRole('button',{name:'review-1@example.test 立即检测降智'}).isEnabled(),'explicit diagnostic unavailable');
    check(await row.getByRole('button',{name:/检测已暂停.*历史结果.*糖果未通过/}).count()===1,'rest lost previous verdict');
    check(errors.length===0,errors.join('; '));
    check(page.url().startsWith('http://127.0.0.1:')&&(await page.title()).includes('Helper'),'wrong app');
    check(await page.locator('vite-error-overlay').count()===0,'framework overlay');
  });
  return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
