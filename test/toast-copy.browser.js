async page => {
  const results=[],errors=[],evidence="__UI_TEST_EVIDENCE_DIR__";
  const check=(value,message)=>{if(!value)throw Error(message);};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});await page.screenshot({path:evidence+'/'+name+'-failure.png'}).catch(()=>{});}finally{for(let i=0;i<3&&await page.getByRole('dialog').count();i++)await page.keyboard.press('Escape');}};
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.evaluate(()=>{window.__accountCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__accountCopies.push(text)}});});
  await page.route('**/api/jobs/*/credentials',route=>route.fulfill({json:{credentials:{password:'fixture-pass',totpSecret:'JBSWY3DPEHPK3PXP',sub2apiJson:'{"email":"review-1@example.test"}',persisted:true}}}));
  await page.route('**/api/jobs/*/sessions',route=>route.fulfill({json:{sessions:{devices:[]}}}));
  await page.route('**/api/jobs/*/workspaces',route=>route.fulfill({json:{workspaces:{workspaces:[]}}}));
  await page.setViewportSize({width:1440,height:1000});
  const row=page.locator('tr.job-row').filter({has:page.getByRole('checkbox',{name:'选择 review-1@example.test',exact:true})});
  const clear=async()=>{await page.locator('.task-toast').evaluateAll(nodes=>nodes.forEach(el=>el.click()));await page.locator('.task-toast').last().waitFor({state:'hidden'}).catch(()=>{});};
  await test('table-account-copies-and-keeps-row-selection',async()=>{
    await row.getByRole('button',{name:'复制账号名 review-1@example.test',exact:true}).click();
    check(await page.evaluate(()=>window.__accountCopies.at(-1))==='review-1@example.test','wrong table email');
    check(!await row.getByRole('checkbox').isChecked(),'copy changed selection');await clear();
  });
  const cases=[['账号凭据','查看或修改账号凭据'],['已登录设备与会话','查看已登录设备和会话'],['工作空间','查看并切换工作空间'],['账号日志与凭据','查看协议日志'],['账号备注','编辑 review-1@example.test 的备注'],['账号成本','编辑 review-1@example.test 的账号成本']];
  for(const [title,trigger] of cases)await test('account-copy-in-'+title,async()=>{
    await row.getByRole('button',{name:trigger,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await dialog.waitFor();await page.waitForTimeout(300);
    const before=await dialog.boundingBox();await dialog.getByRole('button',{name:'复制账号名 review-1@example.test',exact:true}).first().click();
    check(await page.evaluate(()=>window.__accountCopies.at(-1))==='review-1@example.test','wrong modal email');
    const toast=page.locator('.task-toast').filter({hasText:'账号已复制'}).last();await toast.waitFor();
    const hit=await toast.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));});check(hit,'toast is behind native modal');
    check(await page.locator('.credential-notice').count()===0,'inline feedback remains');
    check(Math.abs((await dialog.boundingBox()).height-before.height)<1,'toast resized dialog');
    await clear();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  });
  await test('credential-code-and-json-copy-use-toast-without-layout-shift',async()=>{
    await row.getByRole('button',{name:'查看或修改账号凭据',exact:true}).click();const dialog=page.getByRole('dialog',{name:'账号凭据',exact:true});
    await dialog.getByRole('button',{name:'复制动态验证码',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[aria-label="复制动态验证码"]').disabled);await page.waitForTimeout(250);
    const before=await dialog.boundingBox();await dialog.getByRole('button',{name:'复制动态验证码',exact:true}).click();
    await page.locator('.task-toast').filter({hasText:'动态验证码已复制'}).waitFor();check(/^\d{6}$/.test(await page.evaluate(()=>window.__accountCopies.at(-1))),'OTP clipboard incorrect');
    await dialog.getByRole('button',{name:'复制 Sub2API JSON',exact:true}).click();
    check(await page.evaluate(()=>window.__accountCopies.at(-1))==='{"email":"review-1@example.test"}','JSON copy modified content');
    await dialog.locator('.credential-json-viewer').getByRole('button',{name:'复制账号名 review-1@example.test',exact:true}).click();
    check(await page.evaluate(()=>window.__accountCopies.at(-1))==='review-1@example.test','JSON email not copyable');
    check(Math.abs((await dialog.boundingBox()).height-before.height)<1,'copy notice changed height');
    await page.screenshot({path:evidence+'/credential-toast-desktop.png'});await clear();await page.keyboard.press('Escape');
  });
  const send=async text=>page.evaluate(async text=>{const module=await import('/src/toast-events.mjs');module.notify(text);},text);
  await test('toast-keeps-original-deadline-after-modal-closes',async()=>{
    await row.getByRole('button',{name:'查看已登录设备和会话',exact:true}).click();
    await send('关闭弹窗后继续提示');await page.waitForTimeout(1600);await page.keyboard.press('Escape');
    const toast=page.locator('.task-toast').filter({hasText:'关闭弹窗后继续提示'});await toast.waitFor();
    await toast.waitFor({state:'hidden',timeout:1900});
  });
  await test('toast-click-fades-before-removal-and-does-not-close-dialog',async()=>{
    await row.getByRole('button',{name:'查看已登录设备和会话',exact:true}).click();const dialog=page.getByRole('dialog',{name:'已登录设备与会话',exact:true});
    await send('点击关闭测试');const toast=page.locator('.task-toast').filter({hasText:'点击关闭测试'});await toast.click();
    check(await toast.getAttribute('class').then(s=>s.includes('is-leaving')),'toast removed without fade');await toast.waitFor({state:'hidden'});check(await dialog.isVisible(),'toast click closed modal');await page.keyboard.press('Escape');
  });
  await test('repeated-message-has-new-three-second-lifetime',async()=>{
    await send('重复提示');await page.waitForTimeout(2200);await send('重复提示');
    await page.waitForTimeout(1200);check(await page.locator('.task-toast').filter({hasText:'重复提示'}).count()===1,'old timer removed repeated toast');
    await page.waitForTimeout(1200);check(await page.locator('.task-toast').filter({hasText:'重复提示'}).count()===1,'new toast expired early');
    await page.locator('.task-toast').filter({hasText:'重复提示'}).waitFor({state:'hidden',timeout:1400});
  });
  await test('copy-failure-is-error-toast-and-clipboard-can-recover',async()=>{
    await page.evaluate(()=>navigator.clipboard.writeText=async()=>{throw Error('fixture denied');});
    await row.getByRole('button',{name:'编辑 review-1@example.test 的备注',exact:true}).click();const dialog=page.getByRole('dialog',{name:'账号备注',exact:true});
    await dialog.getByRole('button',{name:'复制账号名 review-1@example.test',exact:true}).click();await page.locator('.task-toast.error').filter({hasText:'账号复制失败'}).waitFor();
    await page.evaluate(()=>navigator.clipboard.writeText=async text=>window.__accountCopies.push(text));await clear();await page.keyboard.press('Escape');
  });
  await test('mobile-toast-center-and-modal-copy-fit-viewport',async()=>{
    await page.setViewportSize({width:375,height:812});await row.getByRole('button',{name:'查看或修改账号凭据',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'账号凭据',exact:true});await dialog.getByRole('button',{name:'复制账号名 review-1@example.test',exact:true}).first().click();
    const toast=page.locator('.task-toast').filter({hasText:'账号已复制'}).last();const box=await toast.boundingBox();check(box.x>=0&&box.x+box.width<=375&&Math.abs(box.x+box.width/2-187.5)<2&&box.y<32,'mobile toast position incorrect');
    check(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'copy buttons overflow modal');await page.screenshot({path:evidence+'/credential-toast-mobile.png'});await clear();await page.keyboard.press('Escape');
  });
  await test('no-toast-copy-runtime-errors',async()=>check(!errors.length,errors.join(';')));
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
