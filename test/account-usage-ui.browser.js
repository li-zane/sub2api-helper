async (page) => {
  const results = [], errors = [], consoleErrors = [], saves = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503')) consoleErrors.push(message.text()); });
  await page.setViewportSize({ width: 1480, height: 1000 });
  const initialUrl = page.url();
  let priority = 3, failSave = false;
  for (const route of ['**/api/sub2api/settings', '**/api/sub2api/monitor']) await page.route(route, r => r.fulfill({ json: { hasAdminApiKey: true, config: { baseUrl: 'http://fixture.test' } } }));
  await page.route('**/api/sub2api/account-status*', route => route.fulfill({ json: { configured: false, accounts: {} } }));
  await page.route('**/api/sub2api/accounts/*/priority', async route => {
    saves.push(route.request().postDataJSON());
    if (failSave) return route.fulfill({ status: 503, json: { error: 'fixture-save-failed' } });
    priority = Number(saves.at(-1).priority);
    return route.fulfill({ json: { priority, status: { inPool: true, enabled: true, priority } } });
  });
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => ({ ...job, status: 'completed', autoRepairBlocked: false, webSessionStatus: 'valid', canDownload: true, sub2apiInPool: true, sub2apiEnabled: true, sub2apiPriority: priority,
      boundProxyStatus: i === 0 ? 'direct' : 'unbound', boundProxies: [], boundIps: [],
      lastOperationType: 'relogin', lastOperationAt: '2026-11-05T04:05:06Z', createdAt: '2026-11-01T01:02:03Z',
      sub2apiUsage: { source: 'sub2api', fetchedAt: '2026-11-05T04:00:00Z', allowed: true, limitReached: false,
        primary: { usedPercent: 10, limitWindowSeconds: 18000 }, secondary: null, credits: null, resetCredits: { availableCount: 0, credits: [] },
        totals: i === 1 ? { accountCost: null, userCost: null, tokens: null, stale: true } : { accountCost: 12.3456, userCost: 0.00123456, tokens: 999500, fetchedAt: '2026-11-05T04:00:00Z', stale: false } },
      modelFingerprint: { enabled: false, models: [], override: { enabled: false, models: null, intervalMinutes: null }, intervalMinutes: 15, phase: 'idle', recentResults: [{ status: 'match', checkedAt: '2026-11-05T04:00:00Z' }, { status: 'mismatch', checkedAt: '2026-11-05T03:00:00Z' }] },
    }));
    return route.fulfill({ json: data });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
  const rows = page.locator('tr.job-row'), row = rows.first();
  await run('recent-operation-horizontal', async () => {
    const tag = await row.locator('.operation-feedback-trigger').boundingBox(), time = await row.locator('.recent-operation-time').boundingBox();
    check(time.x >= tag.x + tag.width, 'time must be to the right of the operation label');
    check(Math.abs(time.y - tag.y) < 6, 'time should start beside the label');
  });
  await run('all-binding-states-use-cards', async () => {
    check(await row.locator('.bound-proxy').innerText() === '直连', 'direct connection has no card');
    check(await rows.nth(1).locator('.bound-proxy').innerText() === '未绑定', 'unbound state has no card');
  });
  await run('disabled-fingerprint-gray-keeps-history', async () => {
    const colors = await row.locator('.fingerprint-round').evaluateAll(nodes => nodes.map(e => getComputedStyle(e).backgroundColor));
    check(new Set(colors).size === 1, 'disabled fingerprint history still has active colors');
    check(await row.locator('.fingerprint-round[title*="不一致"]').count() === 1, 'history label was erased');
  });
  await run('priority-blur-autosave-and-dedup', async () => {
    check(await page.locator('.priority-save-button').count() === 0, 'manual save buttons remain');
    const input = row.locator('.sub2api-priority-editor input');
    await input.fill('7'); await input.press('Tab');
    await page.waitForFunction(() => document.querySelector('.sub2api-priority-editor input').value === '7' && !document.querySelector('.sub2api-priority-editor input').disabled);
    check(saves.length === 1 && saves[0].priority === '7', 'blur did not save exactly once');
    await input.focus(); await input.press('Tab');
    check(saves.length === 1, 'unchanged priority saved again');
    await input.fill('8'); await input.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.sub2api-priority-editor input').disabled);
    check(saves.length === 2 && saves[1].priority === '8', 'Enter/blur submitted twice');
    await input.fill(''); await input.press('Tab');
    check(saves.length === 2, 'empty priority was sent as zero');
    await input.fill('10001'); await input.press('Tab');
    check(saves.length === 2, 'out-of-range priority was submitted');
    await input.fill('8'); await input.press('Tab');
  });
  await run('priority-failed-save-is-retryable', async () => {
    failSave = true;
    const input = row.locator('.sub2api-priority-editor input');
    await input.fill('9'); await input.press('Tab');
    await page.getByText('fixture-save-failed', { exact: true }).waitFor();
    failSave = false;
    await input.focus(); await input.press('Tab');
    await page.waitForFunction(() => document.querySelector('.sub2api-priority-editor input').value === '9' && !document.querySelector('.sub2api-priority-editor input').disabled);
    check(saves.at(-1).priority === '9', 'failed save cannot be retried');
  });
  await run('lifetime-totals-three-significant-digits', async () => {
    const totals = row.locator('.usage-total-pills');
    check((await totals.innerText()).replace(/\s+/g, ' ').includes('A $12.3'), 'account billed total not shown');
    check((await totals.innerText()).includes('U $0.00123'), 'user billed cost lost precision');
    check((await totals.innerText()).includes('T 1M'), 'token unit was not promoted at rounded boundary');
    check((await totals.getAttribute('title')).includes('累计'), 'total period not identified');
    check((await rows.nth(1).locator('.usage-total-pills').innerText()).includes('A —'), 'missing data became zero');
  });
  await run('priority-zero-from-unknown', async () => {
    priority = null; await page.reload();
    const input = row.locator('.sub2api-priority-editor input');
    await page.waitForFunction(() => document.querySelector('.sub2api-priority-editor input')?.value === '');
    const response = page.waitForResponse(response => response.url().includes('/priority') && response.request().method() === 'POST');
    await input.fill('0'); await input.press('Tab'); await response;
    check(saves.at(-1).priority === '0', 'unknown priority must allow saving zero');
  });
  await run('desktop-mobile-render-and-evidence', async () => {
    check(page.url() === initialUrl && (await page.title()).length > 0, 'wrong page identity');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework overlay');
    await row.locator('.usage-total-pills').waitFor();
    await page.screenshot({ path: 'C:/Temp/UserTemp/tosub2-usage-ui-20261105/desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile document overflow');
    await row.locator('.operation-feedback-trigger').scrollIntoViewIfNeeded();
    const a = await row.locator('.operation-feedback-trigger').boundingBox(), b = await row.locator('.recent-operation-time').boundingBox();
    check(b.x >= a.x + a.width, 'mobile recent-operation layout is stacked');
    await page.screenshot({ path: 'C:/Temp/UserTemp/tosub2-usage-ui-20261105/mobile.png' });
    check(!errors.length, errors.join('; '));
    check(!consoleErrors.length, consoleErrors.join('; '));
  });
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
