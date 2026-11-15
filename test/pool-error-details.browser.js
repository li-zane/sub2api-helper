async page => {
 const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],pageErrors=[];let phase='error',source='jobs',poolSnapshotReady=false;
 page.setDefaultTimeout(7000);page.on('pageerror',e=>pageErrors.push(e.message));
 const errors=[{accountId:'2912',code:'deactivated_workspace',message:'Workspace has been deactivated',httpStatus:402},{accountId:'2913',code:'invalid_grant',message:'Refresh token expired',httpStatus:401}];
 const check=(v,m)=>{if(!v)throw Error(m);},test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
 const current=()=>phase==='error'?errors:phase==='unknown'?[{accountId:'2912',code:null,message:'上游未提供错误详情',httpStatus:null}]:[];
 // Both endpoints read the same server cache. Once status refresh has delivered
 // an error, later /jobs polls must stop returning the obsolete active snapshot.
 await page.route(/\/api\/jobs\?/,async route=>{const response=await route.fetch(),data=await response.json(),fromJobs=source==='jobs'||poolSnapshotReady;data.jobs=data.jobs.map(j=>j.email!=='review-1@example.test'?j:{...j,sub2apiInPool:true,sub2apiEnabled:true,sub2apiRemoteStatus:fromJobs&&phase!=='active'?'error':'active',sub2apiRemoteErrors:fromJobs?current():[],overloadDetection:{...j.overloadDetection,configured:true,lastError:'fixture-sync-error'},codexStatusEligible:true});await route.fulfill({response,json:data});});
 await page.route(/\/api\/sub2api\/account-status/,async r=>{await page.locator('tbody .job-row').filter({hasText:'review-1@example.test'}).waitFor();await r.fulfill({json:{configured:true,fetchedAt:new Date().toISOString(),accounts:{'review-1@example.test':{inPool:true,enabled:true,remoteStatus:phase==='active'?'active':'error',remoteErrors:current()}}}});poolSnapshotReady=true;});
 await page.reload();const row=page.locator('tbody .job-row').filter({hasText:'review-1@example.test'});await row.waitFor();await page.setViewportSize({width:1480,height:1000});
 await test('compact-error-badge-reveals-details-only-after-click',async()=>{
  const trigger=row.getByRole('button',{name:'查看号池错误详情',exact:true});await trigger.waitFor();check((await trigger.innerText()).trim()==='错误','badge must only show error label');check(!/deactivated_workspace|Workspace has been deactivated/.test(await row.innerText()),'error details leaked into table');check(await trigger.getAttribute('title')==='点击查看号池错误详情','error details exposed on hover');check(await page.getByRole('dialog',{name:'号池错误详情',exact:true}).count()===0,'error dialog opened without click');
  check(await row.locator('.overload-error').count()===0,'errored account still shows Codex exclamation');check(await row.getByRole('switch',{name:/过载检测/}).isDisabled(),'error account detection became enabled');await page.screenshot({path:evidence+'/compact-error-row.png'});await trigger.click();const d=page.getByRole('dialog',{name:'号池错误详情',exact:true});await d.waitFor();
  const text=await d.innerText();for(const expected of ['deactivated_workspace','invalid_grant','HTTP 402','HTTP 401','Workspace has been deactivated','#2912','#2913'])check(text.includes(expected),expected+' missing');await page.screenshot({path:evidence+'/pool-errors-desktop.png'});await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});check(await trigger.evaluate(el=>el===document.activeElement),'focus not restored');
 });
 await test('status-poll-update-also-carries-error-details',async()=>{
  source='status';poolSnapshotReady=false;await page.reload();const trigger=row.getByRole('button',{name:/查看号池错误详情/});await trigger.waitFor();check(!/deactivated_workspace/.test(await row.innerText()),'polling exposed error code inline');await trigger.click();const d=page.getByRole('dialog',{name:'号池错误详情',exact:true});await d.waitFor();check((await d.innerText()).includes('deactivated_workspace'),'status-only details missing');await page.keyboard.press('Escape');
 });
 await test('missing-upstream-code-has-explicit-message',async()=>{
  phase='unknown';await page.reload();await row.getByRole('button',{name:/查看号池错误详情/}).click();const d=page.getByRole('dialog',{name:'号池错误详情',exact:true});await d.waitFor();const text=await d.innerText();check(text.includes('上游未提供错误代码')&&text.includes('上游未提供错误详情'),'unknown misleading');await d.getByRole('button',{name:'关闭号池错误详情',exact:true}).click();
 });
 await test('mobile-details-wrap-and-remain-keyboard-accessible',async()=>{
  phase='error';source='jobs';await page.reload();await page.setViewportSize({width:375,height:812});await row.getByRole('button',{name:/查看号池错误详情/}).click();const d=page.getByRole('dialog',{name:'号池错误详情',exact:true});await d.waitFor();check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'mobile horizontal overflow');await page.screenshot({path:evidence+'/pool-errors-mobile.png'});await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});
 });
 await test('recovery-closes-details-and-next-error-does-not-reopen-them',async()=>{
  await page.setViewportSize({width:1480,height:1000});await row.getByRole('button',{name:/查看号池错误详情/}).click();const d=page.getByRole('dialog',{name:'号池错误详情',exact:true});await d.waitFor();phase='active';await d.waitFor({state:'hidden'});phase='error';await row.getByRole('button',{name:/查看号池错误详情/}).waitFor();check(await page.getByRole('dialog',{name:'号池错误详情',exact:true}).count()===0,'resolved dialog reopened on later error without click');
 });
 await test('active-status-clears-stale-error-code',async()=>{
  phase='active';await page.reload();await row.waitFor();check(await row.getByRole('button',{name:/查看号池错误详情/}).count()===0,'old error still shown');check((await row.innerText()).includes('已加入'),'normal badge missing');check(!pageErrors.length,pageErrors.join('; '));
 });
 return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
