async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], unexpected = [], acknowledgements = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  const until = async predicate => {
    for (const end = Date.now() + 5000; Date.now() < end;) { if (predicate()) return; await page.waitForTimeout(30); }
    throw Error('request state did not settle');
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(web-login|web-session-check|authorize|relogin|session-reset)(?:\?|$)/.test(new URL(request.url()).pathname)) unexpected.push(request.url()); });
  const fixture = { id: 'a'.repeat(32), email: 'subscription-change@example.test', remark: '订阅变更测试', accountCostCny: 12.34,
    userCostUsd: 10, poolPriceMultiplier: 7, profitCents: '5766', profitDisplay: '￥57.66', planType: 'free', lastPaidPlanType: 'team',
    firstSubscribedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-16T01:00:00Z', present: true, canCopyCredentials: true, accountBanned: false,
    lastChange: { revision: 1, at: '2026-11-16T01:00:00Z', unread: true, types: ['subscription'], fromPlanType: 'team', toPlanType: 'free' } };
  let records = [structuredClone(fixture), { ...fixture, id: 'b'.repeat(32), email: 'hidden-plan@example.test', remark: '初始无变化', planType: 'plus', lastPaidPlanType: 'plus', lastChange: null }];
  let failAck = false, interleave = false, reads = 0;
  await page.route('**/api/subscription-history', async route => {
    reads++;
    check(Boolean(route.request().headers()['x-console-token']), 'list lacks authentication');
    await route.fulfill({ json: { records, total: records.length } });
  });
  await page.route('**/api/subscription-history/seen', async route => {
    check(route.request().method() === 'POST', 'read marker must use POST');
    check(Boolean(route.request().headers()['x-console-token']), 'read marker lacks authentication');
    const { changes } = route.request().postDataJSON();
    acknowledgements.push(changes);
    if (failAck) { await route.fulfill({ status: 503, json: { error: 'fixture acknowledgement unavailable' } }); return; }
    if (interleave) {
      interleave = false;
      records[0].lastChange = { ...records[0].lastChange, revision: 5, at: '2026-11-16T05:00:00Z', types: ['banned'] };
      records[0].accountBanned = true;
    }
    let acknowledged = 0;
    for (const change of changes) {
      const record = records.find(record => record.id === change.id);
      if (record?.lastChange?.unread && record.lastChange.revision === change.revision) {
        record.lastChange.unread = false; acknowledged++;
      }
    }
    await route.fulfill({ json: { acknowledged } });
  });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length > 0);
  const button = page.getByRole('button', { name: '历史订阅', exact: true });
  const dialog = page.getByRole('dialog', { name: '历史订阅', exact: true });
  const row = email => dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: `复制邮箱 ${email}`, exact: true }) });
  const open = async () => { await button.click(); await row(fixture.email).waitFor(); };
  const close = async () => { await dialog.getByRole('button', { name: '关闭历史订阅', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
  const refresh = async () => {
    const done = page.waitForResponse(response => new URL(response.url()).pathname === '/api/subscription-history' && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await done;
  };
  await test('first-open-highlights-subscription-change-and-detection-time', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await open();
    await until(() => acknowledgements.length === 1);
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'new subscription notice is not highlighted');
    check(await row(fixture.email).getByText('新变化 ·', { exact: true }).count() === 1, 'unread label is missing');
    check((await row(fixture.email).locator('.sub-history-change').innerText()).includes('→'), 'plan transition is missing');
    check(await row(fixture.email).locator('time').getAttribute('datetime') === fixture.lastChange.at, 'change time used general updatedAt');
    check((await row(fixture.email).locator('time').innerText()).includes('09:00:00'), 'global Asia/Shanghai time zone is not respected');
    check(acknowledgements[0].length === 1 && acknowledgements[0][0].revision === 1, 'acknowledgement contains unchanged records');
    await page.screenshot({ path: evidence + '/subscription-change-first-open.png' });
  });
  await test('poll-keeps-current-visit-highlight-without-new-notice', async () => {
    await until(() => records[0].lastChange.unread === false);
    records[0].remark = '普通同步更新'; records[0].updatedAt = '2026-11-16T07:00:00Z';
    await refresh(); await row(fixture.email).getByText('普通同步更新', { exact: true }).waitFor();
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'poll erased first-view highlight');
    check(await row(fixture.email).locator('time').getAttribute('datetime') === fixture.lastChange.at, 'financial update overwrote change time');
    check(acknowledgements.length === 1, 'poll sent duplicate acknowledgements');
  });
  await test('reopen-retains-time-without-repeating-red-highlight', async () => {
    await close(); await open();
    check(await row(fixture.email).evaluate(el => !el.classList.contains('is-unread')), 'read notice is red on the second opening');
    check(await row(fixture.email).locator('time').getAttribute('datetime') === fixture.lastChange.at, 'read notice lost change time');
    check(await row(fixture.email).locator('.sub-history-unread-label').count() === 0, 'read notice retains new-change label');
  });
  await test('new-ban-highlights-again-with-correct-state-and-time', async () => {
    await close(); records[0].accountBanned = true;
    records[0].lastChange = { ...records[0].lastChange, revision: 2, at: '2026-11-16T02:00:00Z', types: ['banned'], unread: true };
    await open(); await row(fixture.email).getByText('已封禁', { exact: true }).waitFor();
    await until(() => records[0].lastChange.unread === false);
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'new ban did not highlight again');
    check((await row(fixture.email).locator('.sub-history-change').innerText()).includes('账号封禁'), 'ban reason is missing');
    check((await row(fixture.email).locator('time').innerText()).includes('10:00:00'), 'ban time is not shown');
  });
  await test('search-hidden-new-changes-remain-unread-until-rendered', async () => {
    const search = dialog.getByRole('searchbox', { name: '搜索邮箱或备注', exact: true });
    await search.fill(fixture.email);
    records[1].lastChange = { ...fixture.lastChange, revision: 1, at: '2026-11-16T03:00:00Z', fromPlanType: 'plus', unread: true };
    records[0].remark = '搜索状态同步'; const before = acknowledgements.length;
    await refresh(); await row(fixture.email).getByText('搜索状态同步', { exact: true }).waitFor();
    check(records[1].lastChange.unread, 'search-hidden change was silently consumed');
    check(acknowledgements.length === before, 'hidden row was acknowledged');
    await search.fill(''); await row(records[1].email).waitFor();
    await until(() => records[1].lastChange.unread === false);
    check(await row(records[1].email).evaluate(el => el.classList.contains('is-unread')), 'newly visible row was not highlighted');
  });
  await test('unread-notices-fit-dark-and-mobile-layout', async () => {
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: evidence + '/subscription-changes-dark.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await dialog.boundingBox();
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.y >= 0 && bounds.y + bounds.height <= 812, 'mobile dialog leaves viewport');
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile has horizontal overflow');
    check(await row(fixture.email).locator('time').isVisible(), 'mobile hides change time');
    await page.screenshot({ path: evidence + '/subscription-changes-mobile.png' });
    await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await test('failed-read-save-retries-on-next-successful-refresh', async () => {
    await close(); failAck = true; records[0].accountBanned = false;
    records[0].lastChange = { ...fixture.lastChange, revision: 3, at: '2026-11-16T03:30:00Z', unread: true };
    const before = acknowledgements.length;
    const failed = page.waitForResponse(response => response.url().endsWith('/api/subscription-history/seen') && response.status() === 503);
    await open(); await failed;
    check(records[0].lastChange.unread, 'failed save marked the notice as read');
    failAck = false; await refresh(); await until(() => records[0].lastChange.unread === false);
    check(acknowledgements.length === before + 2, 'failed save did not retry exactly once');
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'retry removed current-visit highlight');
  });
  await test('concurrent-new-change-survives-old-acknowledgement', async () => {
    await close(); interleave = true;
    records[0].lastChange = { ...fixture.lastChange, revision: 4, at: '2026-11-16T04:00:00Z', unread: true };
    const done = page.waitForResponse(response => response.url().endsWith('/api/subscription-history/seen'));
    await open(); await done;
    check(records[0].lastChange.revision === 5 && records[0].lastChange.unread, 'stale acknowledgement consumed a new event');
    await close(); await open(); await row(fixture.email).getByText('已封禁', { exact: true }).waitFor();
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'concurrent ban is not red on first view');
    check(await row(fixture.email).locator('time').getAttribute('datetime') === '2026-11-16T05:00:00Z', 'concurrent ban shows stale timestamp');
  });
  await test('close-stops-history-polling-and-runtime-stays-healthy', async () => {
    await close(); const closedReads = reads; await page.waitForTimeout(5500);
    check(reads === closedReads, 'history keeps polling while closed');
    check((await page.title()).includes('Helper'), 'wrong page identity');
    check(await page.locator('tr.job-row').count() > 0, 'account list is blank');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework overlay appeared');
    check(errors.length === 0, errors.join('; ')); check(unexpected.length === 0, 'history triggers account automation');
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
