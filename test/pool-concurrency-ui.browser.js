async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], saves = [];
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); await page.screenshot({ path: evidence + '/failure-' + results.length + '.png' }); } };
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(7000);
  let overrideSaves = [];
  let concurrency = 3, failSave = false, priority = 9, unpooled = false, jobsReads = 0, pendingSave, holdSave = false;
  for (const path of ['**/api/sub2api/settings', '**/api/sub2api/monitor']) await page.route(path, r => r.fulfill({ json: { hasAdminApiKey: true, config: { baseUrl: 'http://fixture.test' } } }));
  await page.route('**/api/sub2api/account-status*', r => r.fulfill({ json: { configured: false, accounts: {} } }));
  await page.route('**/api/sub2api/accounts/*/concurrency', async route => {
    const body = route.request().postDataJSON(); saves.push(body);
    if (failSave) return route.fulfill({ status: 503, json: { error: 'fixture-concurrency-save-failed' } });
    if (holdSave) await new Promise(resolve => { pendingSave = resolve; });
    concurrency = body.concurrency;
    await route.fulfill({ json: { updated: 1, concurrency, status: { inPool: true, enabled: true, concurrency } } });
  });
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    jobsReads++; const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map(job => ({ ...job, status: 'completed', planType: 'free', autoRepairBlocked: false, sub2apiInPool: !unpooled, sub2apiEnabled: true, sub2apiPriority: priority, sub2apiConcurrency: concurrency, codexStatusEligible: !unpooled, canCheckModelFingerprint: !unpooled,
      modelFingerprint: { enabled: true, models: [{ model: 'fixture', expected: 'fixture' }], override: { enabled: true }, phase: 'idle', intervalMinutes: 15, recentResults: [] } }));
    return route.fulfill({ json: data });
  });
  await page.route(/\/api\/jobs\/[^/]+\/model-fingerprint$/, async route => {
    const body=route.request().postDataJSON();overrideSaves.push(body);
    if(body.enabled===true)return route.fulfill({status:409,json:{error:'请先添加 PlanType'}});
    await route.fulfill({json:{job:{modelFingerprint:{enabled:false,override:body,models:[{model:'fixture',expected:'fixture'}],phase:'idle',intervalMinutes:15,recentResults:[]}}}});
  });
  await page.route('**/api/task-settings', async route => {
    const response = await route.fetch(), data = await response.json();
    data.settings.modelFingerprint = { models: ['fixture'], enabledPlanTypes: [], matchedConcurrency: { enabled: false, value: 10 } }; return route.fulfill({ json: data });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  const row = page.locator('tr.job-row').first(), input = row.locator('.sub2api-concurrency-editor input');
  await input.waitFor();
  await test('concurrency-in-pool-column-blur-enter-and-dedup', async () => {
    check(await row.locator('.pool-status-cell .sub2api-concurrency-editor input').count() === 1, 'concurrency is outside pool column');
    await input.fill('7'); await input.press('Tab'); await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled);
    check(saves.length === 1 && saves[0].concurrency === 7, 'blur did not save integer once');
    await input.focus(); await input.press('Tab'); check(saves.length === 1, 'unchanged field wrote again');
    await input.fill('8'); await input.press('Enter'); await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled);
    check(saves.length === 2 && saves[1].concurrency === 8, 'Enter plus blur wrote twice');
    check(await row.locator('.sub2api-priority-editor input').inputValue() === '9', 'partial concurrency response erased priority');
    for (const value of ['', '-1', '10001', '1.5']) { await input.fill(value); await input.press('Tab'); }
    check(saves.length === 2, 'invalid concurrency was sent'); await input.fill('8'); await input.press('Tab');
  });
  await test('failed-concurrency-save-retains-edit-and-can-retry', async () => {
    failSave = true; await input.fill('11'); await input.press('Tab'); await page.getByText('fixture-concurrency-save-failed', { exact: true }).waitFor();
    check(await input.inputValue() === '11', 'failed save lost draft'); failSave = false;
    await input.focus(); await input.press('Tab'); await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled);
    check(concurrency === 11 && saves.length === 4, 'retry did not save');
  });
  await test('server-poll-preserves-focused-draft-and-reconciles-saved-value', async () => {
    await input.fill('13'); const before = jobsReads; concurrency = 12;
    // The real jobs poll runs every few seconds and updates props in place.
    for (let n = 0; n < 80 && jobsReads === before; n++) await page.waitForTimeout(100);
    check(jobsReads > before, 'jobs did not poll'); check(await input.inputValue() === '13', 'poll erased an active draft');
    await input.press('Tab'); await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled); check(concurrency === 13, 'draft was not saved after poll');
  });
  await test('pending-save-deduplicates-and-unknown-can-save-zero', async () => {
    holdSave = true; const count = saves.length; await input.fill('15'); await input.press('Enter');
    for (let n = 0; n < 50 && !pendingSave; n++) await page.waitForTimeout(20);
    check(await input.isDisabled() && saves.length === count + 1, 'pending save did not lock editor'); pendingSave(); pendingSave = null; holdSave = false;
    await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled);
    concurrency = null; await page.reload(); await page.waitForFunction(() => document.querySelector('.sub2api-concurrency-editor input')?.value === '');
    await input.fill('0'); await input.press('Tab'); await page.waitForFunction(() => !document.querySelector('.sub2api-concurrency-editor input').disabled); check(concurrency === 0, 'unknown concurrency could not save zero');
  });
  await test('absent-PlanType-blocks-auto-but-allows-manual-check', async () => {
    const toggle = row.getByRole('switch', { name: /降智检测/ }); check(await toggle.isDisabled(), 'absent PlanType can enable auto detection');
    check(await toggle.getAttribute('aria-checked') === 'false', 'legacy true override bypassed allowlist');
    check(await row.getByRole('button', { name: /立即检测降智/ }).isEnabled(), 'manual check was disabled with PlanType');
    await row.getByRole('button', { name: /独立降智检测设置/ }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: '账号检测开关', exact: true }).click();
    const enable = page.getByRole('option', { name: /独立开启/ }); check(await enable.getAttribute('aria-disabled') === 'true', 'independent enable bypasses list');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button',{name:'保存账号检测设置',exact:true}).click();
    await dialog.waitFor({state:'detached'});
    check(overrideSaves.length===1&&overrideSaves[0].enabled!==true,'stale independent enable prevented saving models');
  });
  await test('desktop-mobile-page-health-and-unpooled-placeholder', async () => {
    check(await page.title() && await row.count() === 1, 'page identity or content missing'); check(await page.locator('vite-error-overlay').count() === 0, 'framework overlay');
    await row.locator('.pool-status-cell').scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + '/pool-concurrency-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 }); check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page overflow');
    await page.screenshot({ path: evidence + '/pool-concurrency-mobile.png' });
    unpooled = true; await page.reload(); await row.waitFor(); check(await row.locator('.sub2api-concurrency-cell').innerText().then(t => t.includes('—')), 'unpooled placeholder missing');
    check(await row.locator('.sub2api-concurrency-editor input').count() === 0, 'unpooled account editable'); check(errors.length === 0, errors.join(';'));
  });
  pendingSave?.(); await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
