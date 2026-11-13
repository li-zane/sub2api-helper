async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], calls = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const initialUrl = page.url(); let pending = false, firstJob;
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => ({ ...job, sub2apiInPool: i !== 2,
      canResetSessions: i === 0 && !pending, status: i === 0 && pending ? 'working' : job.status,
      sessionReset: i === 0 && pending ? { status: 'authorizing' } : null }));
    firstJob = data.jobs[0]; await route.fulfill({ json: data });
  });
  await page.route('**/api/jobs/*/session-reset', async route => {
    calls.push(route.request().postDataJSON()); pending = true;
    await route.fulfill({ status: 202, json: { job: { ...firstJob, status: 'working', canResetSessions: false, sessionReset: { status: 'authorizing' } } } });
  });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const rows = page.locator('tr.job-row'), button = rows.first().getByRole('button', { name: '登出设备并重登授权', exact: true });
  await test('row-action-eligibility-and-single-queued-request', async () => {
    check(await button.isEnabled(), 'eligible account lacks reset button');
    check(await rows.nth(1).getByRole('button', { name: '登出设备并重登授权', exact: true }).isDisabled(), 'banned account reset is enabled');
    check(await rows.nth(2).getByRole('button', { name: '登出设备并重登授权', exact: true }).isDisabled(), 'account outside pool reset is enabled');
    await button.click(); check(calls.length === 1, 'reset not submitted exactly once');
    check(await button.isDisabled() && await button.locator('.spin').count() === 1, 'pending reset does not show disabled spinner');
    check(await page.getByText('已加入队列：登出设备、重登 Web 并更新号池凭据', { exact: true }).count() > 0, 'queue toast missing');
    await page.screenshot({ path: evidence + '/session-reset-action-desktop.png' });
  });
  let dialog;
  const open = async () => { await page.getByRole('button', { name: '任务设置', exact: true }).click(); dialog = page.getByRole('dialog', { name: '任务设置', exact: true }); await dialog.waitFor(); };
  await test('optional-cooldown-reset-default-off-save-reopen', async () => {
    await open(); const toggle = dialog.getByRole('checkbox', { name: '冷却结束后重登 Web 并重新授权', exact: true });
    check(!await toggle.isChecked(), 'reset is enabled by default'); await toggle.check();
    const response = page.waitForResponse(r => r.url().endsWith('/api/task-settings') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click(); const saved = await response;
    check(saved.ok() && saved.request().postDataJSON().overloadAutoCooldown.reauthorizeAfterCooldown === true, 'new flag not saved');
    await dialog.waitFor({ state: 'hidden' }); await open(); check(await toggle.isChecked(), 'new flag not restored');
  });
  await test('mobile-option-readable-and-save-remains-visible', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await dialog.getByRole('checkbox', { name: '冷却结束后重登 Web 并重新授权', exact: true }).scrollIntoViewIfNeeded();
    const footer = await dialog.getByRole('button', { name: '保存设置', exact: true }).boundingBox();
    check(footer.y >= 0 && footer.y + footer.height <= 812, 'mobile save offscreen');
    await page.screenshot({ path: evidence + '/session-reset-option-mobile.png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });
  await test('identity-nonblank-no-overlay-or-runtime-errors', async () => {
    check(page.url() === initialUrl && /Helper/.test(await page.title()), 'wrong page');
    check(await rows.count() === 20 && await page.locator('vite-error-overlay').count() === 0, 'blank page or overlay');
    check(errors.length === 0, errors.join('; '));
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
