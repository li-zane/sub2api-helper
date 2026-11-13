async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], calls = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const originalUrl = page.url(); let release, pending = false;
  const points = Array.from({ length: 6 }, (_, i) => ({ start: new Date(Date.UTC(2026, 10, 13, 0, i * 15)).toISOString(),
    end: new Date(Date.UTC(2026, 10, 13, 0, (i + 1) * 15)).toISOString(), count: i, requestCount: 10 + i }));
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => ({ ...job, status: 'completed', autoRepairBlocked: false,
      sub2apiInPool: true, sub2apiEnabled: i !== 0, codexStatusEligible: i !== 0, canResetSessions: true,
      canForceRelogin: true, canLogoutAllSessions: true, sessionReset: null,
      overloadDetection: { configured: true, enabled: i !== 0, revision: 1, bucketMinutes: 15, points },
      overloadAutoCooldown: { configured: true, enabled: true, revision: 1, phase: i === 0 ? 'cooling' : 'idle',
        coolingUntil: i === 0 ? '2026-11-14T01:00:00Z' : null, settings: { windowMinutes: 15, threshold: 5 } },
      modelFingerprint: { ...job.modelFingerprint, enabled: false, phase: 'idle', recentResults: [{ status: 'mismatch', checkedAt: '2026-11-13T00:00:00Z' }] } }));
    data.selection = data.jobs;
    await route.fulfill({ json: data });
  });
  await page.route('**/api/jobs/session-reset-batch', async route => {
    calls.push(route.request().postDataJSON());
    if (pending) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 202, json: { started: 1, skipped: 0, failed: [], cooldownMinutes: calls.at(-1).cooldownMinutes } });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
  const row = page.locator('tr.job-row').first(), chart = row.locator('.overload-chart');
  await test('cooldown-gray-frame-keeps-chart-and-history-without-status-line', async () => {
    check(await chart.locator('..').locator('.overload-cooldown-status').count() === 0, 'old cooldown status line remains');
    check(await chart.getAttribute('class').then(value => value.includes('is-cooling')), 'cooldown frame not marked gray');
    check((await chart.getAttribute('title')).includes('冷却至'), 'cooldown deadline not available on hover');
    const coolingBg = await chart.evaluate(el => getComputedStyle(el).backgroundColor);
    const normalBg = await page.locator('tr.job-row').nth(1).locator('.overload-chart').evaluate(el => getComputedStyle(el).backgroundColor);
    check(coolingBg !== normalBg, 'cooldown frame looks identical to active frame');
    const lines = await chart.locator('.overload-line,.overload-request-line').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).stroke));
    check(lines.length === 2 && lines[0] === lines[1], 'both curves are not gray');
    check(await chart.locator('.overload-point').count() === 6, 'history points were discarded');
    check(await row.locator('.fingerprint-round.mismatch').count() === 1, 'fingerprint history was discarded');
    await page.locator('.table-frame').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await page.getByRole('columnheader', { name: 'Codex 状态', exact: true }).click();
    await row.locator('.codex-status').screenshot({ path: evidence + '/cooldown-gray-frame.png' });
  });
  await test('codex-authorization-uses-codex-mark', async () => {
    const button = row.getByRole('button', { name: 'Codex 授权', exact: true });
    check(await button.locator('svg path').getAttribute('d').then(value => value.startsWith('M8.086')), 'Codex icon not used');
  });
  const open = async () => {
    await row.getByRole('checkbox').check(); await page.locator('.bulk-more-trigger').click();
    check(await page.getByRole('menuitem', { name: '一键冷却', exact: true }).count() === 0, 'old menu label remains');
    await page.getByRole('menuitem', { name: '一键重登', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '一键重登', exact: true }); await dialog.waitFor(); return dialog;
  };
  await test('batch-dialog-default-zero-cancel-and-validation', async () => {
    const dialog = await open(), input = dialog.getByRole('spinbutton', { name: '冷却时间（分钟）', exact: true });
    check(await input.inputValue() === '0', 'delay is not zero by default');
    await input.fill('-1'); await dialog.getByRole('button', { name: '开始重登', exact: true }).click();
    check(calls.length === 0, 'invalid delay submitted');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    check(calls.length === 0, 'cancel submitted a reset');
  });
  await test('zero-delay-request-is-deduplicated-and-shows-pending', async () => {
    pending = true;
    const dialog = await open(); await dialog.getByRole('button', { name: '开始重登', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.session-reset-dialog button[type=submit]')?.disabled === true);
    check(calls.length === 1 && calls[0].cooldownMinutes === 0 && calls[0].ids.length === 1, 'wrong batch request');
    await dialog.locator('form').evaluate(form => form.requestSubmit()); check(calls.length === 1, 'duplicate batch submitted');
    release(); pending = false; await dialog.waitFor({ state: 'hidden' });
    await page.locator('.task-toast').getByText('已加入重登队列 1 个账号，不冷却', { exact: true }).waitFor();
  });
  await test('custom-delay-is-per-request-and-mobile-dialog-fits', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const dialog = await open(), input = dialog.getByRole('spinbutton', { name: '冷却时间（分钟）', exact: true });
    check(await input.inputValue() === '0', 'previous delay leaked into next open'); await input.fill('7');
    const box = await dialog.boundingBox(); check(box.x >= 0 && box.x + box.width <= 375 && box.y + box.height <= 812, 'mobile dialog clipped');
    await page.screenshot({ path: evidence + '/batch-relogin-mobile.png' });
    await dialog.getByRole('button', { name: '开始重登', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    check(calls.length === 2 && calls[1].cooldownMinutes === 7, 'custom minutes not sent');
  });
  await test('task-settings-removed-old-fixed-delay-and-console-is-healthy', async () => {
    await page.getByRole('button', { name: '任务设置', exact: true }).click();
    check(await page.locator('#task-cooldown-minutes').count() === 0, 'old fixed delay remains in settings');
    await page.keyboard.press('Escape');
    check(page.url() === originalUrl && /Helper/.test(await page.title()), 'wrong page');
    check(await page.locator('tr.job-row').count() === 20 && await page.locator('vite-error-overlay').count() === 0, 'blank page or overlay');
    check(errors.length === 0, errors.join('; '));
  });
  if (release) release();
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
