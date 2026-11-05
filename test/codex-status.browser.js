async (page) => {
  const evidenceDir = "__UI_TEST_EVIDENCE_DIR__";
  const results = [], errors = [], requests = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1480, height: 1000 });
  const initialUrl = page.url();
  let revision = 1, overload = true, cooldown = true, fingerprint = true, phase = 'idle', releaseCheck;
  const points = [0, 1, 2, 3, 4, 5].map((count, i) => ({ start: new Date(Date.UTC(2026, 10, 5, 0, i * 15)).toISOString(), end: new Date(Date.UTC(2026, 10, 5, 0, (i + 1) * 15)).toISOString(), count, requestCount: 1000 + i }));
  const detectionState = () => ({ configured: true, enabled: overload, revision, points });
  const cooldownState = () => ({ configured: true, enabled: cooldown, revision, settings: { windowMinutes: 15, threshold: 5 }, windowCount: 2, phase: 'idle' });
  const fingerprintState = () => ({ enabled: fingerprint, models: [{ model: 'fixture-model', expected: 'fixture-model' }], override: { enabled: null, models: null, intervalMinutes: null }, intervalMinutes: 15, phase, recentResults: [{ status: 'match', checkedAt: '2026-11-05T04:00:00Z' }, { status: 'mismatch', checkedAt: '2026-11-05T03:00:00Z' }] });
  for (const route of ['**/api/sub2api/settings', '**/api/sub2api/monitor']) await page.route(route, r => r.fulfill({ json: { hasAdminApiKey: true, config: { baseUrl: 'http://fixture.test' } } }));
  await page.route('**/api/sub2api/account-status*', route => route.fulfill({ json: { configured: false, accounts: {} } }));
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => ({ ...job, status: 'completed', autoRepairBlocked: false, sub2apiInPool: true, sub2apiEnabled: true, sub2apiPriority: 3,
      lastOperationType: 'relogin', lastOperationAt: '2026-11-05T04:05:06Z', createdAt: '2026-11-01T01:02:03Z',
      overloadDetection: { ...detectionState(), enabled: i === 4 ? false : overload, points: i === 3 ? points.map(p => ({ ...p, count: null })) : points },
      overloadAutoCooldown: { ...cooldownState(), windowCount: i === 1 ? 0 : i === 2 ? 5 : i === 3 ? null : 2 },
      modelFingerprint: { ...fingerprintState(), enabled: i === 4 ? false : fingerprint, phase: i === 5 ? 'queued' : i === 6 ? 'running' : phase },
    }));
    await route.fulfill({ json: data });
  });
  await page.route('**/api/jobs/*/overload-detection', async route => {
    const body = route.request().postDataJSON(); requests.push({ type: 'overload', body }); overload = body.enabled; revision++;
    await route.fulfill({ json: { job: { overloadDetection: detectionState() } } });
  });
  await page.route('**/api/jobs/*/overload-auto-cooldown', async route => {
    const body = route.request().postDataJSON(); requests.push({ type: 'cooldown', body }); cooldown = body.enabled; revision++;
    await route.fulfill({ json: { job: { overloadAutoCooldown: cooldownState() } } });
  });
  await page.route('**/api/jobs/*/model-fingerprint', async route => {
    const body = route.request().postDataJSON(); requests.push({ type: 'fingerprint', body }); fingerprint = body.enabled;
    await route.fulfill({ json: { job: { modelFingerprint: fingerprintState() } } });
  });
  await page.route('**/api/jobs/*/model-fingerprint/check', async route => {
    requests.push({ type: 'check' });
    await new Promise(resolve => { releaseCheck = resolve; });
    phase = 'queued';
    await route.fulfill({ json: { job: { modelFingerprint: fingerprintState() } } });
  });
  await page.route('**/api/jobs/*/model-fingerprint/history', route => route.fulfill({ json: { models: [{ model: 'fixture-model' }], records: [{ checkedAt: '2026-11-05T04:00:00Z', status: 'match', models: [] }] } }));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
  const rows = page.locator('tr.job-row'), row = rows.first();
  const control = name => row.getByRole('switch', { name: new RegExp(name + '$') });

  await run('pool-controls-and-separate-operation-time', async () => {
    const headings = await page.locator('thead th').allTextContents();
    check(headings.length === 12 && headings.includes('Codex 状态'), 'table has wrong headers/column count');
    check(!headings.includes('过载检测') && !headings.includes('降智检测') && !headings.includes('优先级') && !headings.includes('启用'), 'old columns remain');
    check(await row.locator('.pool-status-cell input[type=number]').count() === 1, 'priority is not inside pool cell');
    check(await row.locator('.pool-status-cell').getByRole('switch', { name: '停用号池账号', exact: true }).count() === 1, 'enabled switch is not inside pool cell');
    const poolHeading = page.getByRole('columnheader').filter({ hasText: '号池' });
    await poolHeading.getByRole('button', { name: /^筛选启用/ }).click();
    await page.getByRole('menu', { name: '筛选启用', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    check(await row.locator('.recent-operation-time-cell .time-clock').innerText() === '12:05:06', 'separate column lost operation time');
    check(await row.locator('.recent-operation-cell .time-stack').count() === 0, 'operation time was duplicated');
  });
  await run('codex-controls-two-by-two-and-shared-action-slot', async () => {
    const a = await row.locator('.overload-toggle-control').boundingBox();
    const b = await row.locator('.cooldown-toggle-control').boundingBox();
    const c = await row.locator('.fingerprint-toggle-control').boundingBox();
    const d = await row.locator('.fingerprint-action-pair').boundingBox();
    check(Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 1 && b.x > a.x, 'overload/cooldown must share first row');
    check(Math.abs(c.y + c.height / 2 - d.y - d.height / 2) < 1 && c.y > a.y && Math.abs(c.x - a.x) < 1 && Math.abs(d.x - b.x) < 1, 'fingerprint/actions must share second row');
    check(await row.locator('.fingerprint-action-pair button').count() === 2, 'refresh and settings do not share a slot');
    check(await row.locator('.fingerprint-check-button').innerText() === '', 'refresh must use icon only');
    const chart = await row.locator('.overload-dashboard').boundingBox(), history = await row.locator('.fingerprint-rounds').boundingBox();
    check(history.y >= chart.y + chart.height, 'fingerprint history is not below overload dashboard');
    check(Math.abs(history.x - a.x) < 1 && Math.abs(history.x + history.width - b.x - b.width) < 1, 'fingerprint result bar must align with the top controls');
    check(Math.abs(chart.x - a.x) < 1 && Math.abs(chart.x + chart.width - b.x - b.width) < 1 && Math.abs(history.width - chart.width) < 1, 'controls, curve frame and fingerprint history must share the same width');
    check((await row.locator('.overload-switch').first().boundingBox()).width === 40, 'overload switch was not lengthened');
    check((await row.locator('.status-toggle-track').last().boundingBox()).width === 40, 'fingerprint switch was not lengthened');
    check(Math.abs(a.width - b.width) < 1 && Math.abs(c.width - d.width) < 1 && Math.abs(a.height - c.height) < 1, 'control rows must have equally sized slots');
    const refresh = await row.locator('.fingerprint-check-button').boundingBox(), settings = await row.locator('.fingerprint-action-pair .compact-icon-btn').boundingBox();
    check(Math.abs(refresh.width - settings.width) < 1 && refresh.width > 26, 'action buttons must share their slot evenly');
    check(Math.abs(chart.width - 156) < 1, 'curve frame must use the narrower aligned width');
  });
  await run('energy-period-counts-thresholds-and-colors', async () => {
    const energy = row.locator('.codex-energy');
    check((await energy.nth(0).getAttribute('title')).includes('15min') && (await energy.nth(0).getAttribute('title')).includes('2 次 / 阈值 5 次'), 'rolling 15min hover information incorrect');
    check((await energy.nth(1).getAttribute('title')).includes('90min') && (await energy.nth(1).getAttribute('title')).includes('15 次 / 阈值 15 次'), '90min hover information must sum six intervals and use triple threshold');
    check(await energy.nth(0).innerText() === '' && await energy.nth(1).innerText() === '', 'energy bars should have no visible annotations');
    await energy.nth(0).hover();
    check((await energy.nth(0).getByRole('meter').getAttribute('aria-valuetext')).includes('滚动 15 分钟'), 'energy meter lost its accessible description');
    const bounds = await row.locator('.overload-chart').boundingBox(), left = await energy.nth(0).boundingBox(), right = await energy.nth(1).boundingBox();
    const plot = await row.locator('.overload-plot').boundingBox();
    for (const bar of [left, right]) check(bar.x > bounds.x && bar.x + bar.width < bounds.x + bounds.width && bar.y > bounds.y && bar.y + bar.height < bounds.y + bounds.height, 'energy bar must stay inside the curve frame');
    check(left.x + left.width <= plot.x && right.x >= plot.x + plot.width, 'energy bars overlap the curve plot');
    check(await row.locator('.overload-chart > .codex-energy').count() === 2, 'energy bars must be children of the curve frame');
    check(await energy.nth(0).locator('.codex-energy-fill').evaluate(el => el.style.height) === '40%', '15min height incorrect');
    check(await energy.nth(1).locator('.codex-energy-fill').evaluate(el => el.style.height) === '100%', '90min height incorrect');
    check(await rows.nth(1).locator('.codex-energy').first().getAttribute('class') === 'codex-energy zero', 'zero is not green');
    check(await rows.nth(2).locator('.codex-energy').first().getAttribute('class') === 'codex-energy full', 'threshold is not full/red');
    check((await rows.nth(3).locator('.codex-energy').first().getAttribute('title')).includes('未统计'), 'missing result is displayed as zero');
    check(await rows.nth(4).locator('.codex-energy.unknown').count() === 2, 'disabled overload bars should be gray');
    const colors = await rows.nth(4).locator('.fingerprint-round').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor));
    check(new Set(colors).size === 1, 'disabled fingerprint history is not gray');
    await row.locator('.overload-point').last().focus();
    check((await row.getByRole('tooltip').innerText()).includes('1005 次'), 'chart tooltip lost request-count detail');
    await page.keyboard.press('Escape');
  });
  await run('monitor-switches-save-through-original-endpoints', async () => {
    for (const [label, type] of [['过载检测', 'overload'], ['自动冷却', 'cooldown'], ['降智检测', 'fingerprint']]) {
      await control(label).click();
      await page.waitForFunction(label => [...document.querySelectorAll('tr.job-row:first-child button[role=switch]')].find(el => el.getAttribute('aria-label')?.endsWith(label))?.getAttribute('aria-checked') === 'false', label);
      check(requests.some(request => request.type === type && request.body.enabled === false), type + ' switch did not save');
      await control(label).click();
      await page.waitForFunction(label => [...document.querySelectorAll('tr.job-row:first-child button[role=switch]')].find(el => el.getAttribute('aria-label')?.endsWith(label))?.getAttribute('aria-checked') === 'true', label);
    }
  });
  await run('refresh-pending-queued-running-spins-and-deduplicates', async () => {
    const button = row.locator('.fingerprint-check-button');
    await button.click();
    await page.waitForFunction(() => document.querySelector('tr.job-row .fingerprint-check-button')?.getAttribute('aria-busy') === 'true');
    check(await button.isDisabled() && await button.locator('.spin').count() === 1, 'pending request can be clicked or does not spin');
    await button.evaluate(el => { el.click(); el.click(); });
    check(requests.filter(r => r.type === 'check').length === 1, 'duplicate manual checks submitted');
    releaseCheck();
    await page.waitForFunction(() => document.querySelector('tr.job-row .fingerprint-check-button')?.title === '排队中');
    check(await button.isDisabled() && await button.locator('.spin').count() === 1, 'queued check can be clicked or does not spin');
    phase = 'running'; await page.reload();
    await row.locator('.fingerprint-check-button[title="正在检测"]').waitFor();
    check(await button.isDisabled() && await button.locator('.spin').count() === 1, 'running check can be clicked or does not spin');
    check(await button.locator('.spin').evaluate(el => getComputedStyle(el).animationName) !== 'none', 'spinner has no animation');
    phase = 'idle'; await page.reload();
    await row.locator('.fingerprint-check-button:not(:disabled)').waitFor();
    check(await button.locator('.spin').count() === 0, 'completed check keeps spinning');
  });
  await run('fingerprint-settings-and-history-remain-accessible', async () => {
    const settings = row.locator('.fingerprint-action-pair').getByRole('button', { name: /独立降智检测设置$/ });
    await settings.click();
    await page.getByRole('dialog').getByRole('combobox', { name: '账号检测开关', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await row.locator('.fingerprint-round').last().click();
    await page.getByRole('dialog').getByText('指纹一致', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
  });
  await run('desktop-mobile-identity-console-and-screenshots', async () => {
    check(page.url() === initialUrl && (await page.title()).length > 0, 'wrong page identity');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework error overlay');
    await row.locator('.codex-status').scrollIntoViewIfNeeded();
    await page.locator('.table-frame').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await page.getByRole('columnheader', { name: 'Codex 状态', exact: true }).click();
    const dashboard = await row.locator('.codex-status').boundingBox(), actions = await row.locator('.actions-cell').boundingBox();
    check(dashboard.x + dashboard.width <= actions.x, 'Codex dashboard is obscured after scrolling to the right');
    await page.screenshot({ path: `${evidenceDir}/codex-status-desktop.png` });
    await row.locator('.codex-status').screenshot({ path: `${evidenceDir}/codex-status.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await row.locator('.codex-status').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile document overflow');
    const cell = await row.locator('.codex-status-cell').boundingBox(), controls = await row.locator('.codex-status').boundingBox();
    check(controls.width <= cell.width, 'Codex controls overflow table cell');
    await page.screenshot({ path: `${evidenceDir}/codex-status-mobile.png` });
    check(!errors.length, errors.join('; '));
  });
  if (releaseCheck) releaseCheck();
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
