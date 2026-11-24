async (page) => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],consoleIssues=[],saves=[],detailReads=[];
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){await page.screenshot({path:evidence+'/failure-'+results.length+'.png'});const dialogs=await page.locator('dialog[open]').evaluateAll(els=>els.map(e=>({name:e.getAttribute('aria-label'),modal:e.matches(':modal'),html:e.outerHTML.slice(0,300)})));results.push({name,passed:false,error:error.message+' dialogs='+JSON.stringify(dialogs)});await page.keyboard.press('Escape');await page.keyboard.press('Escape');}};
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleIssues.push(m.text());});
  const defaults=()=>({models:[{model:'fixture-model',expected:'fixture-model'}],intervalMinutes:10,maxConcurrentAccounts:3,minProbability:.8,enabledPlanTypes:[],groupPolicies:{plus:{'2':'verified'}},matchedConcurrency:{enabled:false,value:10},testSequence:{first:'fingerprint',fingerprint:1,candy:4}});
  const profiles=[{id:'business',name:'Business Premium',planTypes:['Self_Serve_Business_Prolite','business_disabled'],groupIds:['1','2','3','4','5']},{id:'free',name:'Free',planTypes:['free'],groupIds:['1','2']},{id:'plus',name:'Plus',planTypes:['plus'],groupIds:['2']}],groups=['Default','GPT 高级分组','GPT 标准分组','测试','指纹一致'].map((name,i)=>({id:String(i+1),name}));
  let freezeJobs=false;const waitingJobs=[];
  let groupsUnavailable=false;
  let settings=defaults(),override={enabled:true,models:null,intervalMinutes:null,testSequence:null};
  let state=()=>({enabled:true,models:settings.models,override,intervalMinutes:10,testSequence:override.testSequence||settings.testSequence,sequence:{method:'candy',position:2,total:5},phase:'idle',recentResults:[{status:'match',method:'candy',checkedAt:'2026-11-08T11:00:00Z'},{status:'mismatch',method:'fingerprint',checkedAt:'2026-11-08T10:50:00Z'}]});
  const records=[{id:'candy-round',method:'candy',checkedAt:'2026-11-08T11:00:00Z',status:'match',source:'scheduled',transcriptVersion:1,requestCount:1,durationMs:2345,usage:{inputTokens:100,outputTokens:null,totalTokens:100,complete:false,reportedRequests:1,totalRequests:2},models:[{model:'fixture-model',method:'candy',accountId:'42',status:'match',extractedFinalAnswer:21,expectedAnswer:21,websiteRulePassed:true,usedOutputs:1,reason:'糖果题最终答案为21，单题通过'}]},
    {id:'fingerprint-round',method:'fingerprint',checkedAt:'2026-11-08T10:50:00Z',status:'unknown',source:'manual',requestCount:0,models:[{model:'fixture-model',status:'unknown',usedOutputs:2,reason:'仅获得 2/3 份有效检测样本'}]}];
  await page.route('**/api/model-fingerprint/settings',async route=>{if(route.request().method()==='POST'){
    const patch=route.request().postDataJSON().patch;
    const previous=settings;settings={...previous,...patch};
    for(const key of ['testSequence','matchedConcurrency','matchedPriority'])if(patch[key])settings[key]={...previous[key],...patch[key]};
    saves.push({kind:'global',value:settings,patch});
  }await route.fulfill({json:{settings,profiles,groups:groupsUnavailable?[]:groups,groupsError:groupsUnavailable?'fixture-group-catalog-failed':null,runtime:{activeAccounts:0,queuedAccounts:0,maxConcurrentAccounts:3}}});});
  await page.route('**/api/model-fingerprint/reference',r=>r.fulfill({json:{models:[],builtAt:null}}));
  await page.route('**/api/task-settings',async route=>{if(route.request().method()==='GET'){const r=await route.fetch();const data=await r.json();data.settings.modelFingerprint=settings;data.settings.monitoring={...data.settings.monitoring,fingerprintScanIntervalSeconds:77};await route.fulfill({json:data});}else{const body=route.request().postDataJSON();saves.push({kind:'task',value:body});await route.fulfill({json:{settings:{...body,default:3,current:body.maxActiveJobs,max:20}}});}});
  let poolConfig={baseUrl:'https://fixture.test',profiles:[{id:'default',name:'默认方案',fingerprintPoolPolicies:{free:{concurrency:{enabled:true,value:10},rotation:{rateMultiplier:1.25}}}}],activeProfileId:'default',planTypeBindings:{free:'default',plus:'default'}};
  for(const path of ['**/api/sub2api/settings','**/api/sub2api/monitor'])await page.route(path,r=>{
    if(r.request().method()==='POST') poolConfig=r.request().postDataJSON().config;
    return r.fulfill({json:{hasAdminApiKey:true,config:poolConfig,profiles:poolConfig.profiles,
      activeProfileId:poolConfig.activeProfileId,planTypeBindings:poolConfig.planTypeBindings}});
  });
  await page.route('**/api/sub2api/account-status*',r=>r.fulfill({json:{configured:false,accounts:{}}}));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{if(freezeJobs)await new Promise(resolve=>waitingJobs.push(resolve));const r=await route.fetch(),data=await r.json();data.taskSettings={...data.taskSettings,modelFingerprint:settings};data.jobs=data.jobs.map(j=>({...j,planType:'free',status:'completed',autoRepairBlocked:false,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,modelFingerprint:state()}));await route.fulfill({json:data});});
  await page.route(/\/api\/jobs\/[^/]+\/model-fingerprint$/,async route=>{override=route.request().postDataJSON();saves.push({kind:'override',value:override});await route.fulfill({json:{job:{modelFingerprint:state()}}});});
  await page.route(/\/model-fingerprint\/history(?:\?|$)/,async route=>{const id=new URL(route.request().url()).searchParams.get('round');if(!id)return route.fulfill({json:{models:settings.models,records,sequence:state().sequence,phase:'idle'}});detailReads.push(id);await route.fulfill({json:{record:{...records[0],models:[{...records[0].models[0],requests:[{sample:1,attempt:1,method:'candy',prompt:'糖果题原文 <script>window.__candyXss=1</script>',response:'最终答案：21',status:'success',accepted:true,extractedFinalAnswer:21,expectedAnswer:21,durationMs:2345,startedAt:'2026-11-08T11:00:00Z'}]}]}}});});
  const choose=async(dialog,name,option)=>{await dialog.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();};
  await page.setViewportSize({width:1480,height:1000});await page.reload();await page.waitForFunction(()=>document.querySelectorAll('tr.job-row').length===20);
  await test('global-test-sequence-validation-and-save',async()=>{
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await d.getByRole('heading',{name:'号池分组加入规则',exact:true}).waitFor();
    check(await d.locator('.fingerprint-group-profile').count()===0,'disabled PlanType rules visible');
    const plans=d.getByRole('combobox',{name:'添加检测 PlanType',exact:true});
    await plans.fill('self_serve_business_prolite');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.locator('.fingerprint-group-profile').count()===1,'disabled profiles not filtered');
    check(!(await d.locator('.fingerprint-group-profile').innerText()).includes('business_disabled'),'disabled PlanType leaked into profile header');
    const rule=d.getByRole('button',{name:'Business Premium 分组 2 加入规则',exact:true});
    check(await rule.getAttribute('aria-pressed')==='false','default rule incorrect');await rule.click();check(await rule.getAttribute('aria-pressed')==='true'&&(await rule.innerText())==='不降智加入','click did not enable conditional rule');
    await rule.press('Enter');check(await rule.getAttribute('aria-pressed')==='false','keyboard did not toggle rule');await rule.press('Space');check(await rule.getAttribute('aria-pressed')==='true','Space did not toggle rule');
    await plans.click();await page.getByRole('option',{name:'free',exact:true}).click();await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.getByRole('button',{name:'移除 free',exact:true}).count()===1,'selected PlanType was not added');
    await plans.fill('Custom_Plan');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    await plans.fill('custom_plan');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.getByRole('button',{name:'移除 custom_plan',exact:true}).count()===1,'custom PlanType was duplicated');
    await d.getByRole('button',{name:'移除 custom_plan',exact:true}).click();
    check(await d.getByRole('checkbox',{name:/不降智账号独立并发|不降智账号独立优先级/}).count()===0,'pool controls remain in detection settings');
    check(await d.getByText('不降智加入（指纹一致）',{exact:true}).count()===0,'fingerprint-only policy label remains');
    await page.screenshot({path:evidence+'/settings-desktop.png'});
    await page.setViewportSize({width:375,height:812});await rule.click();check(await rule.getAttribute('aria-pressed')==='false','mobile toggle off failed');await rule.click();check(await rule.getAttribute('aria-pressed')==='true','mobile toggle on failed');await page.screenshot({path:evidence+'/groups-mobile.png'});check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'settings horizontal overflow');await page.screenshot({path:evidence+'/settings-mobile.png'});await page.setViewportSize({width:1480,height:1000});
    await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('0');await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('0');await d.getByRole('button',{name:'保存降智检测设置'}).click();check((await d.innerText()).includes('不能同时为 0'),'zero sequence not rejected');check(saves.length===0,'invalid settings sent');
    await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('1');await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('');await d.getByRole('button',{name:'保存降智检测设置'}).click();check(saves.length===0,'empty count silently became zero');
    settings={...settings,minProbability:0.95};
    await choose(d,'检测首项','糖果检测');await d.getByRole('spinbutton',{name:'指纹检测次数',exact:true}).fill('5');await d.getByRole('spinbutton',{name:'糖果检测次数',exact:true}).fill('1');await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
    check(!Object.hasOwn(saves[0].patch,'minProbability')&&saves[0].value.minProbability===0.95,'unchanged threshold overwrote a newer value');
    check(JSON.stringify(saves[0].value.testSequence)===JSON.stringify({first:'candy',fingerprint:5,candy:1}),'global request incorrect');
    check(JSON.stringify(saves[0].value.enabledPlanTypes)===JSON.stringify(['free','self_serve_business_prolite']),'PlanType allowlist not saved');
    check(!Object.hasOwn(saves[0].patch,'matchedConcurrency')&&!Object.hasOwn(saves[0].patch,'matchedPriority'),'detection save sent old pool settings');
    check(saves[0].value.groupPolicies.business['2']==='verified'&&!Object.hasOwn(saves[0].value,'planDefaults'),'group rules not saved alongside allowlist');
    check(saves[0].value.groupPolicies.plus['2']==='verified','hidden rules erased on save');
  });
  await test('draft-PlanType-changes-hide-and-restore-group-rules',async()=>{
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await d.getByRole('button',{name:'移除 self_serve_business_prolite',exact:true}).click();
    check(await d.getByRole('button',{name:'Business Premium 分组 2 加入规则',exact:true}).count()===0,'removed PlanType rules remain visible');
    const plans=d.getByRole('combobox',{name:'添加检测 PlanType',exact:true});await plans.fill('self_serve_business_prolite');await d.getByRole('button',{name:'添加类型',exact:true}).click();
    check(await d.getByRole('button',{name:'Business Premium 分组 2 加入规则',exact:true}).getAttribute('aria-pressed')==='true','re-enabling PlanType lost draft policy');
    await d.getByRole('button',{name:'取消',exact:true}).click();await d.waitFor({state:'detached'});
  });
  await test('pool-concurrency-and-priority-by-plan-validate-and-save-on-mobile',async()=>{
    const open=()=>page.getByRole('region',{name:'Sub2API 配置与号池监控'}).getByRole('button',{name:'配置',exact:true}).click();
    await open();
    const d=page.getByRole('dialog',{name:'Sub2API 配置',exact:true});
    const panel=d.locator('.fpp-section');
    const free=panel.getByRole('tab',{name:/^Free\b/i}),plus=panel.getByRole('tab',{name:/^Plus\b/i});
    const save=d.getByRole('button',{name:'保存配置',exact:true});
    const card=panel.getByRole('tabpanel');
    const checkTierOrder=async()=>{
      const order=await card.locator('.fpp-ladder-grid').evaluateAll(grids=>grids.map(grid=>
        [...grid.children].map(tile=>tile.querySelector('.fpp-step-label').childNodes[0].textContent.trim()).join(',')));
      check(order.length===2&&order.every(tiers=>tiers==='不降智轮转,不降智长效,降智轮转,降智长效'),'four mutually exclusive cases are missing');
    };
    const firstConcurrency=panel.getByRole('spinbutton',{name:/不降智长效\s*并发/});
    const firstPriority=panel.getByRole('spinbutton',{name:/不降智长效\s*优先级/});
    const concurrencySwitch=panel.getByRole('switch',{name:/分级并发/});
    const prioritySwitch=panel.getByRole('switch',{name:/分级优先级/});
    await free.click();
    await checkTierOrder();
    check(await firstConcurrency.inputValue()==='10','legacy concurrency was not migrated into the matching case');
    await prioritySwitch.click();
    await firstPriority.fill('0');
    await save.click();await d.waitFor({state:'detached'});
    check(poolConfig.profiles[0].fingerprintPoolPolicies.free.concurrency.matchedLongTerm===10,'editing priority replaced legacy concurrency');
    await open();await free.click();
    await firstConcurrency.fill('-1');
    await plus.click();
    check(await prioritySwitch.getAttribute('aria-checked')==='false'&&await concurrencySwitch.getAttribute('aria-checked')==='false','Free switches leaked into Plus');
    await save.click();
    check(await free.getAttribute('aria-selected')==='true'&&await firstConcurrency.getAttribute('aria-invalid')==='true','invalid concurrency in other tab was not selected');
    check(await firstConcurrency.evaluate(el=>document.activeElement===el),'invalid concurrency field did not receive focus');
    await firstConcurrency.fill('0');
    const rotatingPriority=panel.getByRole('spinbutton',{name:/^不降智轮转\s*优先级/});
    const rotatingConcurrency=panel.getByRole('spinbutton',{name:/^不降智轮转\s*并发/});
    const degradedRotationPriority=panel.getByRole('spinbutton',{name:/^降智轮转\s*优先级/});
    const degradedRotationConcurrency=panel.getByRole('spinbutton',{name:/^降智轮转\s*并发/});
    check(await panel.getByRole('spinbutton').count()===8,'pool policy must contain only concurrency and priority tiers');
    await rotatingPriority.fill('15');
    await firstConcurrency.fill('-1');
    await rotatingConcurrency.fill('1.5');
    await save.click();
    check(await rotatingConcurrency.getAttribute('aria-invalid')==='true'&&await rotatingConcurrency.evaluate(el=>document.activeElement===el),'first invalid tier did not receive focus');
    await firstConcurrency.fill('0');
    await rotatingConcurrency.fill('5');
    await degradedRotationConcurrency.fill('6');
    check(await degradedRotationPriority.getAttribute('placeholder')==='跳过'&&await degradedRotationPriority.inputValue()==='','empty case is not displayed as skip');
    await panel.getByRole('spinbutton',{name:/^降智长效\s*并发/}).fill('9');
    await card.screenshot({path:evidence+'/tiered-policy-desktop.png'});
    await page.setViewportSize({width:375,height:812});
    await checkTierOrder();
    const grids=panel.locator('.fpp-ladder-grid');
    await grids.first().evaluate(el=>new Promise(resolve=>requestAnimationFrame(resolve)));
    check(await grids.evaluateAll(els=>els.length===2&&els.every(el=>{
      const bounds=el.getBoundingClientRect(),dialog=el.closest('[role="dialog"]').getBoundingClientRect();
      return bounds.left>=dialog.left-1&&bounds.right<=dialog.right+1&&bounds.right<=innerWidth+1;
    })),'policy grids are clipped by the mobile modal');
    check(await grids.locator('.fpp-step-label').evaluateAll(labels=>labels.every(label=>label.scrollWidth<=label.clientWidth+1)),
      'tier labels are clipped on mobile');
    await card.screenshot({path:evidence+'/tiered-policy-mobile.png'});
    check(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'policy controls overflow on mobile');
    await save.click();await d.waitFor({state:'detached'});
    const policy=poolConfig.profiles[0].fingerprintPoolPolicies.free;
    check(policy.concurrency.enabled&&policy.concurrency.matchedLongTerm===0&&policy.concurrency.mismatchedLongTerm===9&&policy.concurrency.value===undefined,'concurrency tiers or legacy migration did not save');
    check(policy.priority.enabled&&policy.priority.matchedLongTerm===0&&policy.priority.mismatchedLongTerm===null,'zero/blank tier did not save');
    check(policy.concurrency.matchedRotation===5&&policy.concurrency.mismatchedRotation===6&&policy.priority.matchedRotation===15&&policy.priority.mismatchedRotation===null,'rotation cases did not save independently');
    check(!Object.hasOwn(policy,'rotation'),'retired rotation billing was saved');
    await open();await free.click();
    check(await panel.getByRole('spinbutton').count()===8,'retired billing control reappeared');
    check(await rotatingConcurrency.inputValue()==='5','saved rotation concurrency did not reopen');
    check(await firstConcurrency.inputValue()==='0'&&await firstPriority.inputValue()==='0','saved tiers did not reopen');
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:1480,height:1000});
  });
  await test('missing-group-catalog-retains-configured-rules',async()=>{
    groupsUnavailable=true;
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await d.getByText(/fixture-group-catalog-failed/).waitFor();
    check(await d.getByRole('button',{name:'Business Premium 分组 2 加入规则',exact:true}).getAttribute('aria-pressed')==='true','missing catalog reset configured rule');
    await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
    check(saves.at(-1).value.groupPolicies.business['2']==='verified','failed catalog erased saved rule');groupsUnavailable=false;
  });
  await test('mobile-remove-last-PlanType-updates-policy-immediately',async()=>{
    const row=page.locator('tr.job-row').first(),toggle=row.getByRole('switch',{name:/降智检测/});
    await page.waitForFunction(()=>document.querySelector('.fingerprint-toggle-control button')?.getAttribute('aria-checked')==='true');
    await page.getByRole('button',{name:'降智检测设置',exact:true}).click();const d=page.getByRole('dialog',{name:'降智检测设置',exact:true});
    await page.setViewportSize({width:375,height:812});
    await d.getByRole('button',{name:'移除 self_serve_business_prolite',exact:true}).click();
    await d.getByRole('button',{name:'移除 free',exact:true}).click();
    check(await d.locator('.fingerprint-group-profile').count()===0,'all PlanTypes off still displays group rules');
    check((await d.innerText()).includes('已全部关闭'),'empty allowlist is not explained');
    await page.screenshot({path:evidence+'/settings-mobile-bottom.png'});
    freezeJobs=true;
    try{await d.getByRole('button',{name:'保存降智检测设置'}).click();await d.waitFor({state:'detached'});
      check(await toggle.isDisabled()&&await toggle.getAttribute('aria-checked')==='false','saved empty list was lost before next server poll');
      check(saves.at(-1).value.enabledPlanTypes.length===0,'empty list not saved');
      check(saves.at(-1).value.groupPolicies.business['2']==='verified'&&saves.at(-1).value.groupPolicies.plus['2']==='verified','hidden policies erased when disabling all PlanTypes');
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
  check(consoleIssues.length===0,consoleIssues.join('; '));check((await page.title()).includes('Helper'),'wrong page identity');
  check(await page.locator('vite-error-overlay').count()===0,'framework overlay');
  const metrics={url:page.url(),title:await page.title(),viewports:['1480x1000','375x812'],pageErrors:errors.length,consoleIssues,browser:'Browser plugin not available; repository Playwright CLI'};
  freezeJobs=false;for(const release of waitingJobs.splice(0))release();await page.unrouteAll({behavior:'wait'});return {passed:results.filter(r=>r.passed).length,total:results.length,results,metrics};
}
