async page => {
 const evidence="__UI_TEST_EVIDENCE_DIR__";
 const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const test=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message})}};
 const check=(v,m)=>{if(!v)throw Error(m)};
 const open=async()=>{await page.getByRole('button',{name:'任务设置',exact:true}).click();return page.getByRole('dialog',{name:'任务设置',exact:true})};
 await test('sms-deadline-default-independent-and-persisted',async()=>{
  const d=await open(),sms=d.getByRole('spinbutton',{name:'接码时限（分钟）',exact:true});
  check(await sms.inputValue()==='10','default SMS budget must be10');await sms.fill('7');
  const save=d.getByRole('button',{name:/保存/}).last();await save.click();await d.waitFor({state:'hidden'});
  await page.reload();const restored=await open();check(await restored.getByRole('spinbutton',{name:'接码时限（分钟）',exact:true}).inputValue()==='7','SMS setting lost on reload');
  check(await restored.locator('#task-login-timeout').inputValue()==='3','SMS save changed login budget');
  await page.screenshot({path:evidence+'/sms-timeout-desktop.png'});
 });
 await test('sms-timeout-mobile-existing-layout-no-overflow',async()=>{
  await page.setViewportSize({width:375,height:812});const d=page.getByRole('dialog',{name:'任务设置',exact:true}),sms=d.getByRole('spinbutton',{name:'接码时限（分钟）',exact:true});await sms.scrollIntoViewIfNeeded();const b=await sms.boundingBox();check(b.x>=0&&b.x+b.width<=375,'SMS input overflows');await page.screenshot({path:evidence+'/sms-timeout-mobile.png'});
 });
 await test('auth-settings-no-runtime-errors',async()=>check(errors.length===0,errors.join(';')));
 return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
