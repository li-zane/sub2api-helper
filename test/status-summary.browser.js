async page => {
  const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[];
  const check=(v,m)=>{if(!v)throw Error(m);};
  const test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'});}};
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.setViewportSize({width:1480,height:1000});await page.reload();
  const rows=page.locator('tbody tr.job-row'),capsule=page.locator('.telemetry-capsule');
  const button=label=>capsule.getByRole('button',{name:'筛选'+label+'账号',exact:true});
  const waitRows=async n=>{await page.waitForFunction(n=>document.querySelectorAll('tbody tr.job-row').length===n,n);};
  const clear=async()=>{const b=page.getByRole('button',{name:'清除全部筛选',exact:true});if(await b.count())await b.click();await waitRows(20);};
  await waitRows(20);
  await test('identity-counts-and-abnormal-toggle-clear-selection',async()=>{
    check(new URL(page.url()).hostname==='127.0.0.1'&&(await page.title()).length>0,'wrong page identity');
    check(!await page.locator('vite-error-overlay').count(),'framework error overlay');
    check(await button('正常').locator('strong').innerText()==='22','normal count differs from server');
    check(await button('异常').locator('strong').innerText()==='1','historical task failure still counted abnormal');
    await rows.first().locator('input[type=checkbox]').first().check();
    await button('异常').click();await waitRows(1);
    check(await button('异常').getAttribute('aria-pressed')==='true','active filter not marked');
    check((await rows.first().innerText()).includes('review-2@example.test'),'banned account missing');
    check(await page.locator('.selection-count strong').innerText()==='0','selection survived category change');
    check(await page.getByRole('button',{name:'清除状态统计筛选',exact:true}).isVisible(),'clear chip missing');
    await page.screenshot({path:evidence+'/abnormal-filter-desktop.png'});
    await button('异常').click();await waitRows(20);check(await button('异常').getAttribute('aria-pressed')==='false','second click did not clear');
  });
  await test('normal-pagination-and-filter-switch-reset-page',async()=>{
    await button('正常').click();await waitRows(20);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await waitRows(2);
    check(await button('正常').locator('strong').innerText()==='22','summary changed to page count');
    check((await page.getByRole('navigation',{name:'任务分页',exact:true}).innerText()).includes('2 / 2'),'wrong filtered page');
    await button('异常').click();await waitRows(1);check((await rows.first().innerText()).includes('review-2@example.test'),'category switch kept obsolete page');
    await page.getByRole('button',{name:'清除状态统计筛选',exact:true}).click();await waitRows(20);
  });
  await test('summary-intersects-search-and-exact-email-list',async()=>{
    await page.getByRole('textbox',{name:'搜索账号',exact:true}).fill('review-3@example.test');await waitRows(1);
    await button('异常').click();await waitRows(0);
    check(await button('异常').locator('strong').innerText()==='1','global count must remain unchanged for empty intersection');
    await page.getByRole('button',{name:'清除状态统计筛选',exact:true}).click();await waitRows(1);
    check((await rows.first().innerText()).includes('review-3@example.test'),'clearing category discarded search');
    await clear();await page.getByRole('button',{name:'邮箱列表筛选',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'邮箱列表筛选',exact:true});await dialog.locator('textarea').fill('review-1@example.test\nreview-2@example.test\nreview-3@example.test');
    await dialog.getByRole('button',{name:'应用邮箱筛选',exact:true}).click();await waitRows(3);
    await button('异常').click();await waitRows(1);check((await rows.first().innerText()).includes('review-2@example.test'),'POST email/health intersection not applied');
    await clear();check(await button('异常').getAttribute('aria-pressed')==='false','clear all retained category');
  });
  await test('active-and-queued-empty-filters-and-keyboard',async()=>{
    for(const label of ['进行中','排队中']){
      await button(label).focus();await page.keyboard.press('Enter');await waitRows(0);
      check(await button(label).getAttribute('aria-pressed')==='true','keyboard did not select '+label);
      await page.keyboard.press('Space');await waitRows(20);
      check(await button(label).getAttribute('aria-pressed')==='false','keyboard did not clear '+label);
    }
  });
  await test('mobile-summary-filter-and-console-health',async()=>{
    await page.setViewportSize({width:375,height:812});await button('异常').click();await waitRows(1);
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile document overflow');
    for(const b of await capsule.getByRole('button').all()){const r=await b.boundingBox();check(r&&r.x>=0&&r.x+r.width<=375,'summary off screen');}
    check(await page.getByRole('button',{name:'清除状态统计筛选',exact:true}).isVisible(),'mobile filter chip inaccessible');
    await page.screenshot({path:evidence+'/abnormal-filter-mobile.png'});
    await page.getByRole('button',{name:'清除状态统计筛选',exact:true}).click();await waitRows(20);
    check(!errors.length,errors.join('; '));
  });
  return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
