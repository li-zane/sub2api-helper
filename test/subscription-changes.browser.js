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
  const planRevisions = new Map(), seenRevisions = new Map();
  const unreadPlanChanges = () => records.filter(record => {
    if (record.lastChange?.types.includes('subscription')) planRevisions.set(record.id, record.lastChange.revision);
    return (planRevisions.get(record.id) || 0) > (seenRevisions.get(record.id) || 0);
  }).length;
  await page.route('**/api/jobs**', async route => {
    if (!['/api/jobs', '/api/jobs/query'].includes(new URL(route.request().url()).pathname)) { await route.continue(); return; }
    const response = await route.fetch(), data = await response.json();
    data.stats.historicalSubscriptionUnreadPlanChanges = unreadPlanChanges();
    data.stats.historicalSubscriptionUnreadChanges = records.filter(record => record.lastChange?.unread).length;
    await route.fulfill({ response, json: data });
  });
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
    unreadPlanChanges();
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
        seenRevisions.set(record.id, change.revision);
      }
    }
    await route.fulfill({ json: { acknowledged } });
  });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length > 0);
  const button = page.getByRole('button', { name: '历史订阅', exact: true });
  const badge = button.locator('.subscription-change-dot');
  const dialog = page.getByRole('dialog', { name: '历史订阅', exact: true });
  const row = email => dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: `复制邮箱 ${email}`, exact: true }) });
  const open = async () => { await button.click(); await row(fixture.email).waitFor(); };
  const close = async () => { await dialog.getByRole('button', { name: '关闭历史订阅', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
  const refresh = async () => {
    const done = page.waitForResponse(response => new URL(response.url()).pathname === '/api/subscription-history' && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await done;
  };
  await test('unread-plan-dot-appears-before-opening-without-history-polling', async () => {
    await badge.waitFor();
    check(reads === 0 && acknowledgements.length === 0, 'badge loads or acknowledges history before opening');
    check((await button.getAttribute('title')).includes('1 个账号有未读的账号变化'), 'badge tooltip has no count');
    check(await badge.getAttribute('role') === 'status', 'badge lacks an accessible status');
    const bounds = await button.boundingBox(), dotBounds = await badge.boundingBox();
    check(dotBounds && bounds && dotBounds.x >= bounds.x && dotBounds.x + dotBounds.width <= bounds.x + bounds.width && dotBounds.y >= bounds.y, 'badge is outside the history button');
    await page.screenshot({ path: evidence + '/subscription-plan-badge.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    check(await badge.isVisible(), 'mobile label-hiding styles also hide the badge');
    await page.screenshot({ path: evidence + '/subscription-plan-badge-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
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
    await badge.waitFor({ state: 'hidden' });
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
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs');
    await badge.waitFor();
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
    await badge.waitFor();
    check(acknowledgements.length === before, 'hidden row was acknowledged');
    await search.fill(''); await row(records[1].email).waitFor();
    await until(() => records[1].lastChange.unread === false);
    await badge.waitFor({ state: 'hidden' });
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
    await page.reload(); await badge.waitFor();
    await open(); await failed;
    check(records[0].lastChange.unread, 'failed save marked the notice as read');
    check(await badge.isVisible(), 'failed acknowledgement cleared the badge');
    failAck = false; await refresh(); await until(() => records[0].lastChange.unread === false);
    await badge.waitFor({ state: 'hidden' });
    check(acknowledgements.length === before + 2, 'failed save did not retry exactly once');
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'retry removed current-visit highlight');
  });
  await test('concurrent-new-change-survives-old-acknowledgement', async () => {
    await close(); interleave = true;
    records[0].lastChange = { ...fixture.lastChange, revision: 4, at: '2026-11-16T04:00:00Z', unread: true };
    const done = page.waitForResponse(response => response.url().endsWith('/api/subscription-history/seen'));
    await open(); await done;
    check(records[0].lastChange.revision === 5 && records[0].lastChange.unread, 'stale acknowledgement consumed a new event');
    await badge.waitFor();
    await close(); await open(); await row(fixture.email).getByText('已封禁', { exact: true }).waitFor();
    check(await row(fixture.email).evaluate(el => el.classList.contains('is-unread')), 'concurrent ban is not red on first view');
    check(await row(fixture.email).locator('time').getAttribute('datetime') === '2026-11-16T05:00:00Z', 'concurrent ban shows stale timestamp');
    await badge.waitFor({ state: 'hidden' });
  });
  await test('recovery-alone-lights-badge-before-opening', async () => {
    await close(); records[0].accountBanned = false;
    records[0].lastChange = { ...records[0].lastChange, revision: 6, at: new Date().toISOString(), types: ['recovered'], unread: true };
    await badge.waitFor(); await open();
    await until(() => records[0].lastChange.unread === false);
    check((await row(fixture.email).locator('.sub-history-change').innerText()).includes('封禁解除'), 'recovery label missing');
    await badge.waitFor({ state: 'hidden' });
  });
  const selectChanges = async label => {
    await dialog.getByRole('combobox', { name: '账号变化筛选', exact: true }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  };
  const visibleEmails = () => dialog.locator('.sub-history-email-text').allTextContents();
  await test('recent-change-windows-sort-and-compose-with-search-without-reading-hidden-rows', async () => {
    await selectChanges('最近 24 小时变化');
    const atHoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
    // Deliberately unsorted, and recently synced even when no meaningful change exists.
    records = [72, 5, 480, 1, 960, null].map((hours, index) => ({
      ...fixture, id: String(index + 1).repeat(32), email: `recent-${index}@example.test`, remark: `筛选测试 ${index}`,
      updatedAt: atHoursAgo(0), lastChange: hours === null ? null : {
        ...fixture.lastChange, at: atHoursAgo(hours), unread: true,
      },
    }));
    await refresh(); await row(records[3].email).waitFor();
    check(JSON.stringify(await visibleEmails()) === JSON.stringify([records[3].email, records[1].email]), '24h filter/order incorrect');
    await until(() => !records[1].lastChange.unread && !records[3].lastChange.unread);
    check(records[0].lastChange.unread && records[2].lastChange.unread && records[4].lastChange.unread, 'time-hidden change consumed');
    await badge.waitFor();
    const search = dialog.getByRole('searchbox', { name: '搜索邮箱或备注', exact: true });
    await search.fill('筛选测试 1');
    check(JSON.stringify(await visibleEmails()) === JSON.stringify([records[1].email]), 'search and date filters did not intersect');
    await search.fill('筛选测试 0');
    await dialog.getByText('没有匹配的记录', { exact: true }).waitFor();
    check(records[0].lastChange.unread, 'search revealed an out-of-range change');
    await search.fill('');
    await selectChanges('最近 7 天变化');
    check(JSON.stringify(await visibleEmails()) === JSON.stringify([records[3].email, records[1].email, records[0].email]), '7d filter/order incorrect');
    await until(() => !records[0].lastChange.unread);
    await selectChanges('最近 30 天变化');
    check((await visibleEmails()).length === 4 && (await visibleEmails())[3] === records[2].email, '30d filter/order incorrect');
    await until(() => !records[2].lastChange.unread);
    check(records[4].lastChange.unread, 'older than 30d was consumed');
    await page.screenshot({ path: evidence + '/subscription-recent-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'recent filter causes mobile overflow');
    const filter = dialog.getByRole('combobox', { name: '账号变化筛选', exact: true });
    const box = await filter.boundingBox(); check(box && box.x >= 0 && box.x + box.width <= 375, 'mobile filter leaves viewport');
    await filter.click(); await page.getByRole('option', { name: '最近 30 天变化', exact: true }).waitFor();
    await page.getByRole('listbox', { name: '账号变化筛选', exact: true }).evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: evidence + '/subscription-recent-mobile.png' });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await test('visit-unread-filter-survives-ack-and-resets-on-reopen', async () => {
    await selectChanges('本次未读变化');
    await row(records[4].email).waitFor();
    await until(() => !records[4].lastChange.unread);
    await refresh();
    check((await visibleEmails()).length === 5, 'read acknowledgement made visit changes disappear');
    check(await row(records[5].email).count() === 0, 'ordinary sync appears as a change');
    await badge.waitFor({ state: 'hidden' });
    await close(); await button.click(); await row(records[0].email).waitFor();
    await selectChanges('本次未读变化');
    await dialog.getByText('没有匹配的记录', { exact: true }).waitFor();
    check((await visibleEmails()).length === 0, 'reopen kept previous visit unread membership');
    await dialog.getByRole('button', { name: '清除筛选', exact: true }).click();
    check((await visibleEmails()).length === 6, 'clear filters did not restore all records');
    await selectChanges('最近 7 天变化');
    check((await visibleEmails()).length === 3, 'read changes cannot be revisited by time');
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
