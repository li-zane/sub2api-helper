async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], consoleIssues = [], detailReads = [];
  page.setDefaultTimeout(7000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error','warning'].includes(m.type())) consoleIssues.push(m.text()); });
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({name,passed:true}); } catch (e) { results.push({name,passed:false,error:e.message}); await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}); } };
  const api = patch => page.evaluate(async patch => {
    const {token} = await fetch('/api/bootstrap').then(r=>r.json());
    const response = await fetch('/api/model-fingerprint/settings',{headers:{'x-console-token':token,'content-type':'application/json'},...(patch ? {method:'POST',body:JSON.stringify({patch})} : {})});
    if (!response.ok) throw Error(await response.text()); return (await response.json()).settings;
  },patch);
  const open = async () => { await page.getByRole('button',{name:'降智检测设置',exact:true}).click(); const d=page.getByRole('dialog',{name:'降智检测设置',exact:true}); await d.waitFor(); return d; };
  const save = async d => { const next=page.waitForResponse(r=>r.url().endsWith('/api/model-fingerprint/settings')&&r.request().method()==='POST'); await d.getByRole('button',{name:'保存降智检测设置',exact:true}).click(); const r=await next; check(r.ok(),await r.text()); await d.waitFor({state:'hidden'}); };
  const choose = async (d, name, option) => { await d.getByRole('combobox',{name,exact:true}).click(); await page.getByRole('option',{name:option,exact:true}).click(); };
  await page.setViewportSize({width:1440,height:1000});
  let d;
  await test('default-off-enable-validation-save-and-reopen',async()=>{
    d=await open(); const section=d.getByRole('region',{name:'前置正则检测'});
    check(!await section.getByRole('checkbox',{name:'启用前置正则检测',exact:true}).isChecked(),'must default off');
    check(await section.getByRole('textbox',{name:'前置检测模型',exact:true}).isDisabled(),'fields should be disabled');
    await section.getByRole('checkbox',{name:'启用前置正则检测',exact:true}).check();
    await section.getByRole('textbox',{name:'前置检测模型',exact:true}).fill('quick-model');
    await section.getByRole('textbox',{name:'前置提示词',exact:true}).fill('Reply with READY only. This request starts a new conversation.');
    await section.getByRole('textbox',{name:'前置正则表达式',exact:true}).fill('[');
    await d.getByRole('button',{name:'保存降智检测设置',exact:true}).click();
    check((await d.getByRole('alert').innerText()).includes('语法无效'),'invalid regex feedback missing');
    check(!(await api()).precheck.enabled,'invalid form persisted');
    await section.getByRole('textbox',{name:'前置正则表达式',exact:true}).fill('^READY$');
    await section.getByRole('textbox',{name:'前置正则标志',exact:true}).fill('i');
    await choose(d,'降智判断条件','未命中正则时疑似降智');
    await d.getByRole('textbox',{name:'默认检测模型',exact:true}).fill('fallback-model');
    await section.scrollIntoViewIfNeeded(); await page.screenshot({path:evidence+'/precheck-settings-desktop.png'});
    await save(d); const saved=await api();
    check(saved.precheck.enabled && saved.precheck.degradedWhen==='no_match' && saved.precheck.skipFallbackOnPass,'settings did not persist');
    d=await open(); check(await d.getByRole('textbox',{name:'前置正则表达式',exact:true}).inputValue()==='^READY$','regex draft not restored');
  });
  await test('nested-patch-preserves-concurrent-edits-and-both-modes',async()=>{
    await api({precheck:{pattern:'READY|OK'}});
    await choose(d,'降智判断条件','命中正则时疑似降智');
    await d.getByRole('checkbox',{name:'前置未降智时跳过糖果／指纹兜底',exact:true}).uncheck();
    await save(d); const saved=await api();
    check(saved.precheck.pattern==='READY|OK','concurrent regex overwritten');
    check(saved.precheck.degradedWhen==='match'&&!saved.precheck.skipFallbackOnPass,'condition or fallback setting lost');
  });
  await test('mobile-keyboard-and-layout',async()=>{
    await page.setViewportSize({width:375,height:812}); d=await open();
    const section=d.getByRole('region',{name:'前置正则检测'}); await section.scrollIntoViewIfNeeded();
    check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'horizontal overflow');
    check(await section.locator('input,textarea').evaluateAll(nodes=>nodes.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})),'input clipping');
    await page.screenshot({path:evidence+'/precheck-settings-mobile.png'});
    await page.keyboard.press('Escape'); await d.waitFor({state:'hidden'});
    check(await page.getByRole('button',{name:'降智检测设置',exact:true}).evaluate(el=>el===document.activeElement),'focus not returned');
  });
  const regexModel={model:'quick-model',method:'regex',accountId:'42',status:'mismatch',regexMatched:true,pattern:'BAD',flags:'i',degradedWhen:'match',reason:'命中正则，疑似降智，待兜底确认'};
  const request={sample:1,attempt:1,method:'regex',prompt:'独立提示词 <script>window.__regexXss=1</script>',response:'BAD',status:'success',accepted:true,regexMatched:true,assessmentStatus:'mismatch',durationMs:500,startedAt:'2026-11-26T10:00:00Z'};
  const records=[
    {id:'combined-unknown',method:'candy',status:'mismatch',checkedAt:'2026-11-26T12:00:02Z',source:'manual',transcriptVersion:1,requestCount:2,
      precheck:{status:'mismatch',fallbackMethod:'candy',fallbackExecuted:true,fallbackStatus:'unknown',degradedByFallback:true,models:[regexModel]},
      models:[{model:'fallback-model',method:'candy',accountId:'42',status:'unknown',expectedAnswer:21,extractedFinalAnswer:null,reason:'未能提取明确的最终答案'}]},
    {id:'combined-error',method:'fingerprint',status:'mismatch',checkedAt:'2026-11-26T11:00:02Z',source:'manual',transcriptVersion:1,requestCount:1,
      precheck:{status:'mismatch',fallbackMethod:'fingerprint',fallbackExecuted:true,fallbackStatus:'error',degradedByFallback:true,models:[regexModel],fallbackFailure:{code:'REFERENCE',message:'参考库加载失败'}},models:[]},
    {id:'fallback',method:'candy',status:'match',checkedAt:'2026-11-26T10:00:02Z',source:'manual',transcriptVersion:1,requestCount:2,
      precheck:{status:'mismatch',fallbackMethod:'candy',fallbackExecuted:true,models:[regexModel]},
      models:[{model:'fallback-model',method:'candy',accountId:'42',status:'match',expectedAnswer:21,extractedFinalAnswer:21,usedOutputs:1,reason:'糖果题最终答案为21'}]},
    {id:'pass',method:'regex',status:'match',checkedAt:'2026-11-26T09:00:00Z',source:'scheduled',transcriptVersion:1,requestCount:1,
      sequencePosition:2,precheck:{status:'match',fallbackMethod:'fingerprint',fallbackExecuted:false,sequenceAdvanced:true},models:[{...regexModel,status:'match',regexMatched:false,reason:'未命中正则，按设置判为未降智'}]},
    {id:'legacy-pass',method:'regex',status:'match',checkedAt:'2026-11-25T09:00:00Z',source:'scheduled',transcriptVersion:1,requestCount:1,
      precheck:{status:'match',fallbackMethod:'candy',fallbackExecuted:false},models:[{...regexModel,status:'match',regexMatched:false,reason:'旧版前置通过'}]},
  ];
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const r=await route.fetch(), data=await r.json();
    data.jobs=data.jobs.map(j=>({...j,sub2apiInPool:true,sub2apiEnabled:true,codexStatusEligible:true,
      modelFingerprint:{...(j.modelFingerprint||{}),models:[{model:'fallback-model'}],enabled:false,phase:'idle',recentResults:records.map(({checkedAt,status,method})=>({checkedAt,status,method}))}}));
    await route.fulfill({json:data});
  });
  await page.route(/\/model-fingerprint\/history(?:\?|$)/,async route=>{
    const id=new URL(route.request().url()).searchParams.get('round');
    if(!id) return route.fulfill({json:{records,models:[{model:'fallback-model'}],phase:'idle',sequence:{method:'fingerprint',position:2,total:2}}});
    detailReads.push(id); const record=records.find(r=>r.id===id);
    return route.fulfill({json:{record:{...record,precheck:{...record.precheck,models:[{...regexModel,requests:[request]}]},models:[{...record.models[0],requests:[{...request,method:'candy',prompt:'糖果题',response:'最终答案：21',extractedFinalAnswer:21}]}]}}});
  });
  await test('history-shows-precheck-and-final-fallback-with-lazy-transcripts',async()=>{
    await page.setViewportSize({width:1440,height:1000}); await page.reload();
    const row=page.locator('tr.job-row').first(); await row.locator('.fingerprint-round').first().click();
    const history=page.getByRole('dialog',{name:/最近 6 轮归因结果/}); await history.waitFor();
    check((await history.innerText()).includes('已进入糖果兜底'),'fallback stage missing');
    check((await history.innerText()).includes('已跳过兜底，轮换进度已推进'),'new shortcut advancement missing');
    check((await history.innerText()).includes('已跳过兜底，轮换进度保留'),'legacy shortcut should retain its original meaning');
    check(detailReads.length===0,'eager transcript load');
    await history.getByRole('listitem').filter({hasText:'已进入糖果兜底'}).getByText('Prompt 与回答（2 次请求）',{exact:true}).click();
    await history.getByText(/前置正则 · 请求 1/).click();
    await history.locator('.fingerprint-request-prompt').first().waitFor();
    check(detailReads.length===1,'transcript should load once');
    check((await history.innerText()).includes('独立新对话，无历史上下文'),'fresh-context note missing');
    check(!await page.evaluate(()=>window.__regexXss),'transcript executed HTML');
    await page.screenshot({path:evidence+'/precheck-history-desktop.png'});
    await page.setViewportSize({width:375,height:812});
    check(await history.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'history horizontal overflow');
    await page.screenshot({path:evidence+'/precheck-history-mobile.png'});
  });
  await test('combined-degradation-shows-rule-and-raw-fallback-reason',async()=>{
    const history=page.getByRole('dialog',{name:/最近 6 轮归因结果/});
    check(await history.getByText('按规则判为降智',{exact:true}).count()===2,'combined verdict labels missing');
    const unknown=history.getByRole('listitem').filter({hasText:'糖果兜底证据不足，本轮按降智处理'});
    check((await unknown.innerText()).includes('未能提取明确的最终答案'),'raw unknown evidence lost');
    const failed=history.getByRole('listitem').filter({hasText:'指纹兜底失败，本轮按降智处理'});
    check((await failed.innerText()).includes('参考库加载失败'),'raw setup failure lost');
    await page.setViewportSize({width:1440,height:1000}); await unknown.scrollIntoViewIfNeeded();
    await page.screenshot({path:evidence+'/combined-verdict-desktop.png'});
    await page.setViewportSize({width:375,height:812}); await unknown.scrollIntoViewIfNeeded();
    check(await history.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'combined verdict horizontal overflow');
    await page.screenshot({path:evidence+'/combined-verdict-mobile.png'});
  });
  await test('runtime-health',async()=>{
    check(new URL(page.url()).hostname==='127.0.0.1','wrong page'); check((await page.title()).includes('Helper'),'wrong title');
    check(!errors.length,errors.join('; ')); check(!consoleIssues.length,consoleIssues.join('; '));
    check(await page.locator('vite-error-overlay').count()===0,'framework overlay');
  });
  console.log('UI_METRICS '+JSON.stringify({url:page.url(),title:await page.title(),viewports:['1440x1000','375x812'],pageErrors:errors,consoleIssues,browser:'Browser plugin not available; repository Playwright CLI'}));
  return {passed:results.filter(r=>r.passed).length,total:results.length,results};
}
