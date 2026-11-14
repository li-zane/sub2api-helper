async (page) => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],saves=[],detailReads=[];
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){await page.screenshot({path:evidence+'/failure-'+results.length+'.png'});const dialogs=await page.locator('dialog[open]').evaluateAll(els=>els.map(e=>({name:e.getAttribute('aria-label'),modal:e.matches(':modal'),html:e.outerHTML.slice(0,300)})));results.push({name,passed:false,error:error.message+' dialogs='+JSON.stringify(dialogs)});await page.keyboard.press('Escape');await page.keyboard.press('Escape');}};
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  const defaults=()=>({models:[{model:'fixture-model',expected:'fixture-model'}],intervalMinutes:10,maxConcurrentAccounts:3,minProbability:.8,enabledPlanTypes:[],matchedConcurrency:{enabled:false,value:10},testSequence:{first:'fingerprint',fingerprint:1,candy:4}});
  const profiles=[{id:'business',name:'Business Premium',planTypes:['self_serve_business_prolite'],groupIds:['1','2','3','4','5']},{id:'free',name:'Free',planTypes:['free'],groupIds:['1','2']}],groups=['Default','GPT 高级分组','GPT 标准分组','测试','指纹一致'].map((name,i)=>({id:String(i+1),name}));
  let freezeJobs=false;const waitingJobs=[];
  let groupsUnavailable=false;
  let settings=defaults(),override={enabled:true,models:null,intervalMinutes:null,testSequence:null};
  let state=()=>({enabled:true,models:settings.models,override,intervalMinutes:10,testSequence:override.testSequence||settings.testSequence,sequence:{method:'candy',position:2,total:5},phase:'idle',recentResults:[{status:'match',method:'candy',checkedAt:'2026-11-08T11:00:00Z'},{status:'mismatch',method:'fingerprint',checkedAt:'2026-11-08T10:50:00Z'}]});
  const records=[{id:'candy-round',method:'candy',checkedAt:'2026-11-08T11:00:00Z',status:'match',source:'scheduled',transcriptVersion:1,requestCount:1,durationMs:2345,usage:{inputTokens:100,outputTokens:null,totalTokens:100,complete:false,reportedRequests:1,totalRequests:2},models:[{model:'fixture-model',method:'candy',accountId:'42',status:'match',extractedFinalAnswer:21,expectedAnswer:21,websiteRulePassed:true,usedOutputs:1,reason:'糖果题最终答案为21，单题通过'}]},
    {id:'fingerprint-round',method:'fingerprint',checkedAt:'2026-11-08T10:50:00Z',status:'unknown',source:'manual',requestCount:0,models:[{model:'fixture-model',status:'unknown',usedOutputs:2,reason:'仅获得 2/3 份有效检测样本'}]}];
  await page.route('**/api/model-fingerprint/settings',async route=>{if(route.request().method()==='POST'){settings=route.request().postDataJSON().settings;saves.push({kind:'global',value:settings});}await route.fulfill({json:{settings,profiles,groups:groupsUnavailable?[]:groups,groupsError:groupsUnavailable?'fixture-group-catalog-failed':null,runtime:{activeAccounts:0,queuedAccounts:0,maxConcurrentAccounts:3}}});});
  await page.route('**/api/model-fingerprint/reference',r=>r.fulfill({json:{models:[],builtAt:null}}));
  await page.route('**/api/task-settings',async route=>{if(route.request().method()==='GET'){const r=await route.fetch();const data=await r.json();data.settings.modelFingerprint=settings;data.settings.monitoring={...data.settings.monitoring,fingerprintScanIntervalSeconds:77};await route.fulfill({json:data});}else{const body=route.request().postDataJSON();saves.push({kind:'task',value:body});await route.fulfill({json:{settings:{...body,default:3,current:body.maxActiveJobs,max:20}}});}});
  for(const path of ['**/api/sub2api/settings','**/api/sub2api/monitor'])await page.route(path,r=>r.fulfill({json:{hasAdminApiKey:true,config:{baseUrl:'https://fixture.test'}}}));
  await page.route('**/api/sub2api/account-status*',r=>r.fulfill({json:{configured:false,accounts:{}}}));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{if(freezeJobs)await new Promise(resolve=>waitingJobs.push(resolve));const r=await route.fetch(),data=await r.json();data.taskSettings={...data.taskSettings,modelFingerprint:settings};data.jobs=data.jobs.map(j=>({...j,planType:'free',status:'completed',autoRepairBlocked:false,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,modelFingerprint:state()}));await route.fulfill({json:data});});
  await page.route(/\/api\/jobs\/[^/]+\/model-fingerprint$/,async route=>{override=route.request().postDataJSON();saves.push({kind:'override',value:override});await route.fulfill({json:{job:{modelFingerprint:state()}}});});
  await page.route(/\/model-fingerprint\/history(?:\?|$)/,async route=>{const id=new URL(route.request().url()).searchParams.get('round');if(!id)return route.fulfill({json:{models:settings.models,records,sequence:state().sequence,phase:'idle'}});detailReads.push(id);await route.fulfill({json:{record:{...records[0],models:[{...records[0].models[0],requests:[{sample:1,attempt:1,method:'candy',prompt:'糖果题原文 <script>window.__candyXss=1</script>',response:'最终答案：21',status:'success',accepted:true,extractedFinalAnswer:21,expectedAnswer:21,durationMs:2345,startedAt:'2026-11-08T11:00:00Z'}]}]}}});});
  const choose=async(dialog,name,option)=>{await dialog.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();};
  await page.setViewportSize({width:1480,height:1000});await page.reload();await page.waitForFunction(()=>document.querySelectorAll('tr.job-row').length===20);
  await test('global-test-sequence-validation-and-save',async()=>{
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await d.getByRole('heading',{name:'号池分组加入规则',exact:true}).waitFor();
    await choose(d,'Business Premium 分组 2 加入规则','不降智加入');
    const plans=d.getByRole('combobox',{name:'添加检测 PlanType',exact:true});
    await plans.click();await page.getByRole('option',{name:'free',exact:true}).click();await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.getByRole('button',{name:'移除 free',exact:true}).count()===1,'selected PlanType was not added');
    await plans.fill('Custom_Plan');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    await plans.fill('custom_plan');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.getByRole('button',{name:'移除 custom_plan',exact:true}).count()===1,'custom PlanType was duplicated');
    await d.getByRole('button',{name:'移除 custom_plan',exact:true}).click();
    const matched=d.getByRole('checkbox',{name:'不降智账号独立并发',exact:true}),value=d.getByRole('spinbutton',{name:'不降智账号独立并发值',exact:true});
    check(!await matched.isChecked()&&await value.isDisabled(),'independent concurrency must default off');
    await matched.check();await value.fill('0');
    check(await d.getByText('不降智加入（指纹一致）',{exact:true}).count()===0,'fingerprint-only policy label remains');
    await page.screenshot({path:evidence+'/settings-desktop.png'});
    await page.setViewportSize({width:375,height:812});await choose(d,'Business Premium 分组 2 加入规则','默认加入');await choose(d,'Business Premium 分组 2 加入规则','不降智加入');await page.screenshot({path:evidence+'/groups-mobile.png'});check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'settings horizontal overflow');await page.screenshot({path:evidence+'/settings-mobile.png'});await page.setViewportSize({width:1480,height:1000});
    await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('0');await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('0');await d.getByRole('button',{name:'保存降智检测设置'}).click();check((await d.innerText()).includes('不能同时为 0'),'zero sequence not rejected');check(saves.length===0,'invalid settings sent');
    await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('1');await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('');await d.getByRole('button',{name:'保存降智检测设置'}).click();check(saves.length===0,'empty count silently became zero');
    await choose(d,'检测首项','糖果检测');await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('5');await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('1');await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
    check(JSON.stringify(saves[0].value.testSequence)===JSON.stringify({first:'candy',fingerprint:5,candy:1}),'global request incorrect');
    check(JSON.stringify(saves[0].value.enabledPlanTypes)===JSON.stringify(['free']),'PlanType allowlist not saved');
    check(saves[0].value.matchedConcurrency.enabled&&saves[0].value.matchedConcurrency.value===0,'zero matched concurrency not saved');
    check(saves[0].value.groupPolicies.business['2']==='verified'&&!Object.hasOwn(saves[0].value,'planDefaults'),'group rules not saved alongside allowlist');
  });
  await test('missing-group-catalog-retains-configured-rules',async()=>{
    groupsUnavailable=true;
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await d.getByText(/fixture-group-catalog-failed/).waitFor();
    check((await d.getByRole('combobox',{name:'Business Premium 分组 2 加入规则',exact:true}).innerText()).includes('不降智加入'),'missing catalog reset configured rule');
    await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
    check(saves.at(-1).value.groupPolicies.business['2']==='verified','failed catalog erased saved rule');groupsUnavailable=false;
  });
  await test('mobile-remove-last-PlanType-updates-policy-immediately',async()=>{
    const row=page.locator('tr.job-row').first(),toggle=row.getByRole('switch',{name:/降智检测/});
    await page.waitForFunction(()=>document.querySelector('.fingerprint-toggle-control button')?.getAttribute('aria-checked')==='true');
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await page.setViewportSize({width:375,height:812});
    await d.getByRole('button',{name:'移除 free',exact:true}).click();
    await d.getByRole('checkbox',{name:'不降智账号独立并发',exact:true}).uncheck();
    check(await d.getByRole('spinbutton',{name:'不降智账号独立并发值',exact:true}).isDisabled(),'disabled matched-concurrency input still editable');
    check((await d.innerText()).includes('已全部关闭'),'empty allowlist is not explained');
    await page.screenshot({path:evidence+'/settings-mobile-bottom.png'});
    freezeJobs=true;
    try{await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
      check(await toggle.isDisabled()&&await toggle.getAttribute('aria-checked')==='false','saved empty list was lost before next server poll');
      check(saves.at(-1).value.enabledPlanTypes.length===0&&!saves.at(-1).value.matchedConcurrency.enabled,'empty list/off policy not saved');
    }finally{freezeJobs=false;for(const release of waitingJobs.splice(0))release();await page.setViewportSize({width:1480,height:1000});}
  });
  await test('account-independent-sequence-and-inheritance',async()=>{
    const button=page.locator('tr.job-row').first().getByRole('button',{name:/独立降智检测设置/});await button.click();let d=page.getByRole('dialog');
    check(!await d.getByRole('checkbox',{name:'使用独立检测轮换'}).isChecked(),'inheritance checkbox incorrect');await d.getByRole('checkbox',{name:'使用独立检测轮换'}).check();await choose(d,'账号检测首项','指纹检测');await d.getByRole('spinbutton',{name:'账号指纹检测次数'}).fill('1');await d.getByRole('spinbutton',{name:'账号糖果检测次数'}).fill('3');await d.getByRole('button',{name:'保存账号检测设置'}).click();await d.waitFor({state:'detached'});check(saves.at(-1).value.testSequence.candy===3,'override not submitted');
    await button.click();d=page.getByRole('dialog');await d.getByRole('checkbox',{name:'使用独立检测轮换'}).uncheck();await d.getByRole('button',{name:'保存账号检测设置'}).click();await d.waitFor({state:'detached'});check(saves.at(-1).value.testSequence===null,'inheritance not restored');
  });
  await test('task-settings-removes-degradation-controls-and-preserves-values',async()=>{
    const original=JSON.stringify(settings);
    await page.getByRole('button',{name:'任务设置',exact:true}).click();let d=page.getByRole('dialog',{name:'任务设置',exact:true});
    check(await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).count()===0,'duplicate candy control still visible');
    check(await d.locator('#fingerprint-default-interval, #fingerprint-default-concurrency, #monitor-fingerprintScanIntervalSeconds').count()===0,'degradation settings remain in task dialog');
    await d.getByRole('button',{name:/保存/}).last().click();await d.waitFor({state:'detached'});
    let saved=saves.filter(s=>s.kind==='task').at(-1);check(saved&&!Object.hasOwn(saved.value,'modelFingerprint'),'task save rewrites fingerprint settings');
    check(!Object.hasOwn(saved.value.monitoring||{},'fingerprintScanIntervalSeconds'),'task save rewrites fingerprint scan interval');
    check(JSON.stringify(settings)===original,'fingerprint settings changed');
    await page.getByRole('button',{name:'任务设置',exact:true}).click();d=page.getByRole('dialog',{name:'任务设置',exact:true});await d.getByRole('button',{name:'恢复默认',exact:true}).click();await d.getByRole('button',{name:/保存/}).last().click();await d.waitFor({state:'detached'});
    saved=saves.filter(s=>s.kind==='task').at(-1);check(!Object.hasOwn(saved.value,'modelFingerprint')&&!Object.hasOwn(saved.value.monitoring||{},'fingerprintScanIntervalSeconds'),'restore default overwrites degradation settings');check(JSON.stringify(settings)===original,'restore default changes saved model rules');
  });
  await test('mixed-history-methods-lazy-transcripts-and-usage',async()=>{
    await page.locator('tr.job-row').first().locator('.fingerprint-round').last().click();const d=page.getByRole('dialog'),nodes=d.locator('.fingerprint-timeline-node');await nodes.nth(1).waitFor();check(detailReads.length===0,'eager transcript fetch');check((await nodes.first().innerText()).includes('糖果'),'candy method missing');check((await nodes.first().innerText()).includes('通过'),'candy pass missing');check((await nodes.nth(1).innerText()).includes('2/3'),'fingerprint counts missing');
    const usage=nodes.first().locator('.node-usage-pill');check((await usage.innerText()).includes('已报告小计'),'partial usage presented as a complete total');check((await usage.getAttribute('title')).includes('输出: 未知'),'missing output tokens displayed as zero');
    await nodes.first().locator('.fingerprint-transcripts > summary').click();const sample=nodes.first().locator('.fingerprint-sample');await sample.locator('summary').click();check((await sample.locator('summary').innerText()).includes('答案 21'),'candy result missing');check(!(await sample.locator('summary').innerText()).includes('个数字'),'candy shown as fingerprint');check((await sample.locator('.fingerprint-request-response').innerText())==='最终答案：21','raw reply lost');check(await page.evaluate(()=>!window.__candyXss),'unsafe html rendering');
    await page.screenshot({path:evidence+'/candy-history-desktop.png'});
  });
  await test('compact-mobile-history-and-modal-keyboard',async()=>{
    const d=page.getByRole('dialog');await page.setViewportSize({width:375,height:812});check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'history horizontal overflow');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');await page.screenshot({path:evidence+'/candy-history-mobile.png'});await page.keyboard.press('Escape');check(await d.count()===0,'Escape close failed');check(errors.length===0,errors.join('; '));
  });
  freezeJobs=false;for(const release of waitingJobs.splice(0))release();await page.unrouteAll({behavior:'wait'});return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
