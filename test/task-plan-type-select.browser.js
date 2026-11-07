async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],writes=[];
  const check=(ok,message)=>{if(!ok)throw Error(message)};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message})}};
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/task-settings'))writes.push(r.postDataJSON())});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'任务设置',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'任务设置',exact:true});await modal.waitFor();
  while(await modal.getByRole('button',{name:'删除自动任务规则',exact:true}).count())await modal.getByRole('button',{name:'删除自动任务规则',exact:true}).last().click();
  for(let i=0;i<2;i++)await modal.getByRole('button',{name:'添加规则',exact:true}).click();
  const rule=i=>modal.locator('.task-auto-rule').nth(i),input=i=>rule(i).getByRole('combobox'),menu=modal.getByRole('listbox');
  await test('PlanType-reuses-custom-select-skin-without-native-datalist',async()=>{
    check(await rule(0).locator('.custom-select-container.is-editable').count()===1,'editable shared CustomSelect missing');
    check(await modal.locator('#task-plan-type-suggestions,input[list="task-plan-type-suggestions"]').count()===0,'native datalist remains');
    const styles=await input(0).evaluate(el=>{const a=getComputedStyle(el),b=getComputedStyle(document.querySelector('.task-auth-mode-field .custom-select-trigger')),keys=['fontSize','fontWeight','borderRadius','backgroundColor','borderColor'];return {height:el.getBoundingClientRect().height,same:keys.every(k=>a[k]===b[k]),actual:Object.fromEntries(keys.map(k=>[k,a[k]])),reference:Object.fromEntries(keys.map(k=>[k,b[k]]))}});
    check(styles.same&&styles.height===32,'input skin differs from the other custom selects: '+JSON.stringify(styles));
  });
  await test('first-open-menu-is-top-layer-aligned-and-shows-plan-labels',async()=>{
    await input(0).scrollIntoViewIfNeeded();await input(0).click();await menu.waitFor();
    check(await menu.evaluate(el=>el.matches(':popover-open')),'menu is clipped instead of top-layer');
    const a=await input(0).boundingBox(),b=await menu.boundingBox();
    check(Math.abs(a.x-b.x)<2&&Math.min(Math.abs(a.y+a.height-b.y),Math.abs(b.y+b.height-a.y))<8,'first-open positioning differs from trigger');
    const option=menu.getByRole('option').filter({hasText:'self_serve_business_prolite'});
    check((await option.innerText()).includes('Business Premium'),'mapped label missing');
    await option.click();check(await input(0).inputValue()==='self_serve_business_prolite','selected friendly label instead of raw PlanType');
    check(await menu.count()===0,'option selection reopened dropdown through its label');
    await input(0).click();await menu.waitFor();
    check(await option.getAttribute('aria-selected')==='true','selected state missing');
    await menu.screenshot({path:evidence+'/plan-menu-desktop.png'});
    await page.keyboard.press('Escape');
  });
  await test('custom-values-typing-and-native-text-editing-keep-focus',async()=>{
    await input(1).fill('');await input(1).pressSequentially('future_plan_2026');
    check(await input(1).inputValue()==='future_plan_2026','custom PlanType typing lost characters');
    check(await input(1).evaluate(el=>el===document.activeElement),'typing lost focus');
    await input(1).press('Home');await input(1).press('End');await input(1).press('Space');
    check(await input(1).inputValue()==='future_plan_2026 ','space intercepted as select action');
    await input(1).fill('future_plan_2026');await input(1).press('Enter');
    check(writes.length===0,'Enter submitted the settings form');
    check(await modal.isVisible()&&await menu.count()===0,'custom value Enter did not just close the menu');
  });
  await test('keyboard-selection-Escape-Tab-and-associated-label-work',async()=>{
    await input(1).press('ArrowDown');await input(1).press('ArrowDown');
    const id=await input(1).getAttribute('aria-activedescendant');check(Boolean(id),'no active option for keyboard navigation');
    const raw=await page.locator('[id='+JSON.stringify(id)+'] .custom-select-option-label').evaluate(el=>el.firstChild.textContent);
    await input(1).press('Enter');check(await input(1).inputValue()===raw,'keyboard selection did not commit raw PlanType');
    await input(1).fill('future_plan_2026');await input(1).press('Escape');
    check(await modal.isVisible()&&await menu.count()===0,'Escape closed dialog instead of the menu');
    await input(1).click();await input(1).press('Tab');check(await menu.count()===0,'Tab left menu open');
    await rule(1).locator('label[for="task-auto-plan-1"]').click();check(await input(1).evaluate(el=>el===document.activeElement),'PlanType label does not focus visible input');
    if(await menu.count())await input(1).press('Escape');
  });
  await test('raw-PlanType-and-actions-save-and-reopen-without-conversion',async()=>{
    for(let i=0;i<2;i++)await rule(i).getByRole('checkbox',{name:'Codex 授权',exact:true}).check();
    let releaseSave;const holdSave=new Promise(resolve=>{releaseSave=resolve});
    await page.route('**/api/task-settings',async route=>{if(route.request().method()==='POST')await holdSave;await route.continue()});
    const response=page.waitForResponse(r=>r.url().endsWith('/api/task-settings')&&r.request().method()==='POST');
    try {
      await modal.getByRole('button',{name:'保存设置',exact:true}).click();
      await page.waitForFunction(()=>[...document.querySelectorAll('.task-auto-plan-field input')].every(el=>el.disabled));
      check(await input(0).isDisabled()&&await input(1).isDisabled(),'PlanType editable during save');
      check(await menu.count()===0,'disabled editable menu remained open');
    } finally {releaseSave()}
    const saved=await response;await page.unroute('**/api/task-settings');
    check(saved.ok(),'settings API rejected unchanged raw values: '+await saved.text());
    const body=saved.request().postDataJSON();
    check(body.autoActions.self_serve_business_prolite.includes('authorize-codex')&&body.autoActions.future_plan_2026.includes('authorize-codex'),'raw/custom PlanType was lost');
    check(!Object.hasOwn(body.autoActions,'Business Premium'),'friendly name saved as key');
    await modal.waitFor({state:'hidden'});await page.getByRole('button',{name:'任务设置',exact:true}).click();await modal.waitFor();
    check(await modal.locator('.task-auto-plan-field input').evaluateAll(els=>els.some(el=>el.value==='future_plan_2026')),'custom saved value not restored');
    const selected=modal.locator('.task-auto-plan-field input');
    check(await selected.count()===2,'saved rules changed count');
  });
  await test('375px-long-values-menu-are-contained-and-scrollable',async()=>{
    await page.setViewportSize({width:375,height:812});
    await input(0).fill('self_serve_business_prolite_very_long_custom_future_plan_type');await input(0).scrollIntoViewIfNeeded();await input(0).click();
    await menu.waitFor();const b=await menu.boundingBox();
    check(b.x>=4&&b.y>=4&&b.x+b.width<=371&&b.y+b.height<=808,'mobile popup outside viewport');
    check(await menu.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'long PlanType menu has horizontal overflow');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');
    await page.screenshot({path:evidence+'/plan-menu-mobile.png'});
    await input(0).press('Escape');
  });
  await test('no-runtime-errors-and-other-setup-selects-still-operate',async()=>{
    await page.setViewportSize({width:1440,height:1000});
    const proxy=modal.getByRole('combobox',{name:'账号代理分配',exact:true});await proxy.scrollIntoViewIfNeeded();await proxy.click();
    await modal.getByRole('option',{name:'全局代理',exact:true}).click();
    check((await proxy.innerText()).includes('全局代理'),'readonly CustomSelect changed');
    check(errors.length===0,errors.join('; '));
  });
  await modal.getByRole('button',{name:'取消',exact:true}).click();
  return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
