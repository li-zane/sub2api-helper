async(page)=>{
 const root="__UI_TEST_ROOT__", evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],check=(v,m)=>{if(!v)throw Error(m);};
 const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}};page.on('pageerror',e=>errors.push(e.message));
 page.setDefaultTimeout(5000);await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(async root=>{window.__cleanupFixture=(await import('/@fs/'+root+'/test/frontend-components-fixture.jsx')).mount();},root);
 const dialog=page.getByRole('dialog',{name:'Component fixture',exact:true});await dialog.waitFor();const select=dialog.getByRole('combobox',{name:'Fixture choice',exact:true});
 await test('select-keyboard-skips-disabled-and-form-value',async()=>{
  await select.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');check(await dialog.locator('#fixture-value').innerText()==='c','disabled option not skipped');
  check(await page.evaluate(()=>new FormData(document.querySelector('#fixture-form')).get('choice'))==='c','form mirror stale');
  await select.click();await page.keyboard.press('Home');await page.keyboard.press('Enter');check(await dialog.locator('#fixture-value').innerText()==='a','Home failed');await select.focus();await page.keyboard.press('d');await page.keyboard.press('Enter');check(await dialog.locator('#fixture-value').innerText()==='d','typeahead failed');
 });
 await test('select-Escape-Tab-outside-disable-empty-and-label',async()=>{
  await select.click();await page.keyboard.press('Escape');check(await dialog.isVisible()&&await select.getAttribute('aria-expanded')==='false','Escape closed dialog');
  await select.click();await page.keyboard.press('Tab');check(await select.getAttribute('aria-expanded')==='false','Tab not dismissed');
  await select.click();await dialog.getByRole('button',{name:'Disable select',exact:true}).click();check(await select.isDisabled()&&await dialog.locator('[role=listbox]').count()===0,'disable left interactive menu');await dialog.getByRole('button',{name:'Disable select',exact:true}).click();
  await dialog.getByRole('button',{name:'Empty options',exact:true}).click();await select.click();check(await dialog.locator('[role=option]').count()===0,'empty options not respected');await page.keyboard.press('Escape');await dialog.getByRole('button',{name:'Empty options',exact:true}).click();
  await dialog.locator('label[for="fixture-select"]').click();check(await select.evaluate(el=>el===document.activeElement),'label does not focus visible control');await page.keyboard.press('Escape');await dialog.locator('#implicit-fixture-label > span').click();check(await dialog.getByRole('combobox',{name:'Implicit fixture choice',exact:true}).evaluate(el=>document.activeElement===el),'implicit label focuses hidden form mirror');await page.keyboard.press('Escape');
 });
 await test('dropdown-top-layer-and-mobile-containment',async()=>{
  await page.setViewportSize({width:375,height:812});await select.click();const menu=dialog.getByRole('listbox');check(await menu.evaluate(el=>el.matches(':popover-open')),'dropdown not in top layer');const b=await menu.boundingBox();check(b.x>=0&&b.x+b.width<=375&&b.y>=0&&b.y+b.height<=812,'dropdown out of viewport');await page.waitForTimeout(180);await page.screenshot({path:evidence+'/dropdown-mobile.png'});await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(150);
 });
 await test('tooltip-modal-position-descendants-and-title-update',async()=>{
  await dialog.locator('#fixture-tip').hover();let tip=dialog.locator('.apple-floating-tooltip');await tip.waitFor();check(await tip.innerText()==='fixture old tooltip','wrong tip');check(await tip.evaluate(el=>!!el.closest('dialog[open]')),'tip below modal');
  await dialog.locator('#fixture-child-a').hover();await dialog.locator('#fixture-child-b').hover();check(await tip.count()===1,'descendant transition closes tip');
  await dialog.getByRole('button',{name:'Update title',exact:true}).evaluate(el=>el.click());await page.waitForFunction(()=>document.querySelector('.apple-floating-tooltip')?.textContent==='fixture new tooltip');
  await page.mouse.move(0,0);check(await dialog.locator('#fixture-tip').getAttribute('title')==='fixture new tooltip','restored stale title');
 });
 await test('tooltip-focus-scroll-removal-and-explicit-component',async()=>{
  await dialog.locator('#fixture-tip').focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await dialog.locator('.apple-floating-tooltip').waitFor();await page.keyboard.press('Escape');check(await dialog.locator('.apple-floating-tooltip').count()===0,'Escape leaves tip');
  await dialog.locator('#scroll-tip').hover();await dialog.locator('#fixture-scroller').evaluate(el=>{el.scrollTop=30;});await page.waitForTimeout(30);check(await dialog.locator('.apple-floating-tooltip').count()===0,'scroll leaves tip');
  await dialog.locator('#fixture-tip').hover();await dialog.getByRole('button',{name:'Remove target',exact:true}).evaluate(el=>el.click());await page.waitForTimeout(50);check(await dialog.locator('.apple-floating-tooltip').count()===0,'removed target leaves tip');
  await page.mouse.move(0,0);await page.waitForTimeout(100);await dialog.locator('#fixture-explicit').hover();await dialog.getByRole('tooltip').filter({hasText:'explicit component tooltip'}).waitFor();check(await dialog.getByRole('tooltip').count()===1,'double tooltip');
 });
 await page.evaluate(()=>window.__cleanupFixture());
 await test('mapping-typing-preserves-focus-and-traps-Tab',async()=>{
  await page.getByRole('button',{name:'配置 PlanType 映射',exact:true}).click();const modal=page.getByRole('dialog',{name:'PlanType 映射',exact:true});const input=modal.getByRole('textbox',{name:'第 1 行原始 PlanType',exact:true});await input.fill('');await input.pressSequentially('fixture_plan');check(await input.inputValue()==='fixture_plan','typing remounts input');check(await input.evaluate(el=>document.activeElement===el),'typing loses focus');
  const first=modal.locator('.dialog-header .help-tip-trigger');await first.focus();await page.keyboard.press('Shift+Tab');check(await modal.getByRole('button',{name:'保存映射',exact:true}).evaluate(el=>el===document.activeElement),'Tab escapes modal');await page.keyboard.press('Escape');check(await page.getByRole('button',{name:'配置 PlanType 映射',exact:true}).evaluate(el=>el===document.activeElement),'focus not returned');
 });
 await test('fingerprint-save-cannot-dismiss-or-change-in-flight',async()=>{
  let release;const held=new Promise(r=>release=r);
  await page.route('**/api/model-fingerprint/settings',async route=>{
    if(route.request().method()==='POST'){await held;return route.fulfill({json:{}});}
    return route.fulfill({json:{settings:{models:[],intervalMinutes:360,maxConcurrentAccounts:3,minProbability:0.8,enabledPlanTypes:["free"],matchedConcurrency:{enabled:false,value:10}},profiles:[],groups:[],runtime:{activeAccounts:0,queuedAccounts:0}}});
  });
  try{
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const modal=page.getByRole('dialog',{name:'降智检测设置',exact:true});await modal.getByRole('button',{name:'保存降智检测设置',exact:true}).click();
    await page.keyboard.press('Escape');check(await modal.isVisible(),'Escape dismissed pending save');check(await modal.getByRole('button',{name:'关闭降智检测设置',exact:true}).isDisabled(),'close not disabled');check(await modal.getByRole('button',{name:'移除 free',exact:true}).isDisabled(),'plan switch editable during save');
    release();await modal.waitFor({state:'hidden'});
  }finally{release();await page.unroute('**/api/model-fingerprint/settings');}
 });
 await test('bulk-menu-tooltip-above-menu-and-filter-with-disabled-items',async()=>{
  for(const width of [1440,375]){
   await page.setViewportSize({width,height:width===1440?1000:812});
   await page.locator('.bulk-more-trigger').click();const menu=page.locator('.bulk-dropdown-menu');await menu.waitFor();
   const button=menu.getByRole('menuitem',{name:'登出所有设备',exact:true});check(await button.isDisabled(),'expected disabled menu fixture');
   await button.hover();const tip=page.locator('.apple-floating-tooltip').filter({hasText:'登出所选账号在 OpenAI'});await tip.waitFor();await page.waitForTimeout(150);
   check(await tip.evaluate(el=>el.matches(':popover-open')),'tooltip below browser top layer');
   check(await tip.evaluate(el=>!!el.closest('.bulk-dropdown-menu:popover-open')),'tooltip detached from menu surface');
   const b=await tip.boundingBox();check(b.x>=0&&b.x+b.width<=width+1&&b.y>=0,'menu tooltip outside viewport');
   check(await tip.evaluate(el=>{el.style.pointerEvents='auto';const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);el.style.pointerEvents='';return hit&&el.contains(hit);}), 'tooltip painted below another layer');
   await page.screenshot({path:evidence+'/bulk-menu-tooltip-'+width+'.png'});
   await page.mouse.move(0,0);await tip.waitFor({state:'hidden'});await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  }
 });
 await test('no-component-runtime-errors',async()=>check(!errors.length,errors.join(';')));
 return{passed:results.filter(x=>x.passed).length,total:results.length,results};
}
