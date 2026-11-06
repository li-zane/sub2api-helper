async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__", results=[], errors=[], detailRequests=[];
  const check=(value,message)=>{if(!value)throw Error(message)};
  const run=async(name,action)=>{try{await action();results.push({name,passed:true})}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:`${evidence}/${name}-failure.png`}).catch(()=>{});await page.keyboard.press('Escape').catch(()=>{});}};
  page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.jobs=data.jobs.map((job,index)=>index===0?{...job,status:'completed',webSessionStatus:'valid',autoRepairBlocked:false,canReplacePassword:true,canReplaceTotp:true,hasTotpKey:true}:index===1?{...job,status:'banned',webSessionStatus:'banned',autoRepairBlocked:true,canReplacePassword:true,canReplaceTotp:true}:job);
    await route.fulfill({json:data});
  });
  await page.route('**/api/jobs/*/credentials',route=>route.fulfill({json:{credentials:{password:'Fixture-Password!',passwordAvailable:true,hasPassword:true,totpSecret:'JBSWY3DPEHPK3PXP',hasTotpKey:true,sub2apiJson:'{}',persisted:true}}}));
  await page.route('**/api/jobs/*/logs?*',async route=>{
    const url=new URL(route.request().url()),view=url.searchParams.get('view'),entry=url.searchParams.get('entry');
    if(entry)detailRequests.push({view,entry});
    const entries=view==='protocol'?[{id:'web-run',type:'web_login',label:'自动 Web 登录',at:'2026-11-07T00:00:00Z',status:'completed'},{id:'password-run',type:'replace_password',label:'轮换密码',at:'2026-11-07T00:01:00Z',status:'completed'}]
      :[{id:'password-old',type:'password',stage:'imported',at:'2026-11-07T00:00:00Z'},{id:'password-new',type:'password',stage:'confirmed',at:'2026-11-07T00:01:00Z'},{id:'totp-old',type:'2fa',stage:'imported',at:'2026-11-07T00:02:00Z'},{id:'current-web_session',type:'web_session',stage:'current',at:'2026-11-07T00:03:00Z'},{id:'current-codex_oauth',type:'codex_oauth',stage:'current',at:'2026-11-07T00:04:00Z'}];
    const content=entry?({ 'web-run':'WEB_TASK_ONLY GET /api/auth/session 200','password-run':'PASSWORD_TASK_ONLY confirmed','password-old':'{"password":"old-password-fixture"}','password-new':'{"password":"new-password-fixture"}','totp-old':'{"totpSecret":"historical-fixture"}','current-web_session':'{"cookies":"CURRENT_WEB_ONLY"}','current-codex_oauth':'{"access_token":"CURRENT_OAUTH_ONLY"}' })[entry]:'';
    await route.fulfill({json:{view,entries,selectedId:entry,content,retention:view==='protocol'?'任务协议日志保留至删除账号':'密码与 2FA 历史永久保留；Web / Cookie / OAuth 仅展示当前版本'}});
  });
  await page.setViewportSize({width:1480,height:1000});await page.reload();await page.locator('tr.job-row').first().waitFor();
  await run('password-and-TOTP-buttons-share-footer',async()=>{
    await page.locator('tr.job-row').first().getByRole('button',{name:'查看或修改账号凭据',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'账号凭据',exact:true});await dialog.getByRole('button',{name:'一键轮换密码',exact:true}).waitFor();
    const a=await dialog.getByRole('button',{name:'一键轮换密码',exact:true}).boundingBox(),b=await dialog.getByRole('button',{name:'轮换 2FA',exact:true}).boundingBox();
    check(Math.abs(a.y-b.y)<3,'rotation buttons are not adjacent');check(await dialog.locator('.credential-dialog-actions').getByRole('button',{name:'一键轮换密码',exact:true}).count()===1,'password button not in footer');
    await dialog.locator('.credential-dialog-actions').getByRole('button',{name:'关闭',exact:true}).click();
  });
  await run('banned-account-hides-both-rotation-controls',async()=>{
    await page.locator('tr.job-row.status-banned').getByRole('button',{name:'查看或修改账号凭据',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'账号凭据',exact:true});await dialog.getByLabel('密码',{exact:true}).waitFor();
    check(await dialog.getByRole('button',{name:/轮换密码|轮换 2FA/}).count()===0,'banned rotation remains visible');
    await dialog.locator('.credential-dialog-actions').getByRole('button',{name:'关闭',exact:true}).click();
  });
  await page.locator('tr.job-row').first().getByRole('button',{name:'查看协议日志',exact:true}).click();
  const log=page.getByRole('dialog',{name:'账号日志与凭据',exact:true});
  await run('two-tabs-lazy-menu-detail-navigation',async()=>{
    await log.getByRole('button',{name:/自动 Web 登录/}).waitFor();
    check(detailRequests.length===0,'detail was fetched before selection');check((await log.innerText()).includes('选择记录'),'selection placeholder missing');
    await log.getByRole('button',{name:/自动 Web 登录/}).click();await log.locator('pre').filter({hasText:'WEB_TASK_ONLY'}).waitFor();
    await log.getByRole('button',{name:/轮换密码/}).click();await log.locator('pre').filter({hasText:'PASSWORD_TASK_ONLY'}).waitFor();
    check(!(await log.innerText()).includes('WEB_TASK_ONLY'),'another task leaked into detail');
  });
  await run('credential-history-selects-individual-old-and-current-records',async()=>{
    await log.getByRole('tab',{name:'凭据历史',exact:true}).click();await log.getByRole('button',{name:/密码 · 导入/}).waitFor();
    check(await log.locator('pre').count()===0,'old protocol or credential remained selected after tab change');
    await log.getByRole('button',{name:/密码 · 导入/}).click();await log.locator('pre').filter({hasText:'old-password-fixture'}).waitFor();
    await log.getByRole('button',{name:/Web 会话 \/ Cookie/}).click();await log.locator('pre').filter({hasText:'CURRENT_WEB_ONLY'}).waitFor();
    check(!(await log.innerText()).includes('old-password-fixture'),'old secret remains after selection');
  });
  await run('responsive-two-pane-layout-and-keyboard-tabs',async()=>{
    const menu=await log.locator('.account-log-menu').boundingBox(),content=await log.locator('.account-log-content').boundingBox();check(menu.x+menu.width<=content.x+2,'desktop panes overlap');
    await page.screenshot({path:`${evidence}/account-records-desktop.png`});
    await log.getByRole('tab',{name:'凭据历史'}).focus();await page.keyboard.press('ArrowLeft');check(await log.getByRole('tab',{name:'协议日志'}).getAttribute('aria-selected')==='true','keyboard tab switch failed');
    await page.setViewportSize({width:375,height:812});await page.screenshot({path:`${evidence}/account-records-mobile.png`});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');
    const workspace=await log.locator('.account-log-workspace').boundingBox();check(workspace.width<375,'mobile panel exceeds viewport');
    await log.getByRole('button',{name:'关闭协议日志',exact:true}).click();await page.setViewportSize({width:1480,height:1000});
  });
  await run('plan-rule-OAuth-dependency-is-visible-and-reversible',async()=>{
    await page.getByRole('button',{name:'任务设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'任务设置',exact:true});await dialog.getByRole('button',{name:'添加规则',exact:true}).click();
    const row=dialog.locator('.task-auto-rule').last();await row.getByRole('checkbox',{name:'上传到 Sub2API',exact:true}).check();
    check(await row.getByRole('checkbox',{name:'Codex 授权',exact:true}).isChecked(),'upload did not include visible OAuth prerequisite');
    await row.getByRole('checkbox',{name:'Codex 授权',exact:true}).uncheck();check(!(await row.getByRole('checkbox',{name:'上传到 Sub2API',exact:true}).isChecked()),'OAuth removal left upload checked');
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
  });
  await run('record-browser-no-runtime-errors',async()=>{check(errors.length===0,errors.join('; '))});
  await page.unrouteAll({behavior:'wait'});return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
