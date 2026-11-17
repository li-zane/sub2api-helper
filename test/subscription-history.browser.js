async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], credentialCalls = [], unexpected = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/(web-login|web-session-check|authorize|relogin|session-reset)(?:\?|$)/.test(new URL(request.url()).pathname)) unexpected.push(request.url()); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.historyCopied = value; } } });
  });
  const fixture = { id: 'a'.repeat(32), email: 'history-long-alias+subscription@example.test', remark: '回归测试备注', accountCostCny: 12.34,
    userCostUsd: 10, poolPriceMultiplier: 7, profitCents: '5766', profitDisplay: '￥57.66', planType: 'business', lastPaidPlanType: 'business',
    firstSubscribedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', present: true, canCopyCredentials: true };
  let records = [fixture], failure = false, reads = 0, responseDelay = 0;
  await page.route('**/api/subscription-history', async route => {
    reads++;
    if (responseDelay) await new Promise(resolve => setTimeout(resolve, responseDelay));
    check(Boolean(route.request().headers()['x-console-token']), 'history list lacks console authentication');
    await route.fulfill({ status: failure ? 503 : 200, json: failure ? { error: 'fixture unavailable' } : { records, total: records.length } });
  });
  await page.route('**/api/subscription-history/*/credentials', async route => {
    credentialCalls.push(route.request().url());
    check(Boolean(route.request().headers()['x-console-token']), 'credential copy lacks console authentication');
    await route.fulfill({ json: { text: 'history@example.test----fixture-password----ABCDEFGHIJKLMNOP' } });
  });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length > 0);
  const button = page.getByRole('button', { name: '历史订阅', exact: true });
  let dialog;
  await test('summary-entry-at-right-opens-history', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    check(await button.isEnabled(), 'history button is disabled');
    const order = await button.evaluate(el => el === el.parentElement.querySelector('button:last-child'));
    check(order, 'history is not the last status-bar action');
    await button.click(); dialog = page.getByRole('dialog', { name: '历史订阅', exact: true });
    await dialog.waitFor(); await dialog.getByText(fixture.remark, { exact: true }).waitFor();
    check(credentialCalls.length === 0, 'opening the list fetched credentials');
    check(await dialog.getByText('￥57.66', { exact: true }).count() === 1, 'profit is missing');
    await page.screenshot({ path: evidence + '/subscription-history-desktop.png' });
  });
  await test('compact-header-is-top-left-without-explanatory-copy', async () => {
    const text = await dialog.innerText();
    check(!text.includes('保留所有曾开通非 Free 订阅的账号'), 'retention subtitle is still shown');
    check(!text.includes('账号资料变更后自动更新'), 'footer explanation is still shown');
    const header = await dialog.locator('.sub-history-header').boundingBox();
    const heading = await dialog.locator('.sub-history-heading').boundingBox();
    const title = await dialog.getByRole('heading', { name: '历史订阅', exact: true }).boundingBox();
    check(header && heading && title && Math.abs(heading.x - header.x) <= 1 && Math.abs(heading.y - header.y) <= 1
      && title.x - heading.x < 40 && title.y - heading.y < 8, 'history title is not at the top left');
    const footer = await dialog.locator('.sub-history-footer').boundingBox();
    const close = await dialog.getByRole('button', { name: '关闭', exact: true }).boundingBox();
    check(footer && close && Math.abs(footer.x + footer.width - close.x - close.width) <= 1, 'footer close button is not right aligned');
  });
  await test('copy-email-and-latest-credentials-on-demand', async () => {
    await dialog.getByRole('button', { name: `复制邮箱 ${fixture.email}`, exact: true }).click();
    check(await page.evaluate(() => window.historyCopied) === fixture.email, 'email copy failed');
    await dialog.getByRole('button', { name: `复制 ${fixture.email} 凭据`, exact: true }).click();
    await page.waitForFunction(() => window.historyCopied?.includes('fixture-password'));
    check(credentialCalls.length === 1, 'credential fetch is duplicated');
  });
  await test('search-email-and-remark-with-empty-state', async () => {
    const search = dialog.getByRole('searchbox', { name: '搜索邮箱或备注', exact: true });
    await search.fill('no-matching-account'); await dialog.getByText('没有匹配的记录', { exact: true }).waitFor();
    await search.fill('回归测试'); check(await dialog.getByText(fixture.remark, { exact: true }).count() === 1, 'remark search failed');
    await search.fill('');
  });
  await test('automatic-refresh-updates-visible-finances', async () => {
    records = [{ ...fixture, remark: '自动同步后的备注', profitCents: '12345', profitDisplay: '￥123.45' }];
    await dialog.getByText('自动同步后的备注', { exact: true }).waitFor({ timeout: 12000 });
    check(await dialog.getByText('￥123.45', { exact: true }).count() === 1, 'automatic profit update failed');
    check(credentialCalls.length === 1, 'polling fetched credentials');
  });
  await test('refresh-failure-retains-last-good-record-and-recovers', async () => {
    failure = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await dialog.getByText(/fixture unavailable/).waitFor();
    check(await dialog.getByText('自动同步后的备注', { exact: true }).count() === 1, 'failure cleared cached records');
    failure = false; records = [{ ...fixture, present: false, planType: 'free' }];
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await dialog.getByText('已删除', { exact: true }).waitFor();
    check(await dialog.getByText('￥57.66', { exact: true }).count() === 1, 'recovery did not update record');
  });
  await test('deleted-status-coexists-with-ban-and-free-and-updates-on-refresh', async () => {
    records = [
      { ...fixture, id: 'a'.repeat(32), email: 'deleted-banned@example.test', accountBanned: true, present: false },
      { ...fixture, id: 'b'.repeat(32), email: 'deleted-free@example.test', planType: 'free', present: false },
      { ...fixture, id: 'c'.repeat(32), email: 'deleted-paid@example.test', present: false },
      { ...fixture, id: 'd'.repeat(32), email: 'present-banned@example.test', accountBanned: true },
      { ...fixture, id: 'e'.repeat(32), email: 'present-free@example.test', planType: 'free' },
    ];
    const row = email => dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: `复制邮箱 ${email}`, exact: true }) });
    const refresh = async () => {
      const done = page.waitForResponse(response => new URL(response.url()).pathname === '/api/subscription-history');
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await done;
    };
    await refresh(); await row(records[4].email).waitFor();
    const banned = row(records[0].email), free = row(records[1].email), paid = row(records[2].email);
    check(await banned.getByText('已封禁', { exact: true }).count() === 1, 'deleted account lost its ban status');
    check(await banned.getByText('已删除', { exact: true }).count() === 1, 'deleted banned account lacks deletion status');
    check(await free.getByText('已降为 Free', { exact: true }).count() === 1, 'deleted free account lost its downgrade status');
    check(await free.getByText('已删除', { exact: true }).count() === 1, 'deleted free account lacks deletion status');
    check(await paid.getByText('已删除', { exact: true }).count() === 1, 'ordinary deletion status is missing or duplicated');
    check(await paid.getByText('当前订阅', { exact: true }).count() === 0, 'deleted paid account still appears currently subscribed');
    for (const record of records.slice(3)) check(await row(record.email).getByText('已删除', { exact: true }).count() === 0, 'present account is marked deleted');
    await page.screenshot({ path: evidence + '/subscription-history-combined-statuses.png' });
    records[0] = { ...records[0], present: true, remark: '已恢复到主列表' };
    await refresh(); await banned.getByText('已恢复到主列表', { exact: true }).waitFor();
    check(await banned.getByText('已删除', { exact: true }).count() === 0, 'refresh retained a stale deletion status');
    check(await banned.getByText('已封禁', { exact: true }).count() === 1, 'refresh cleared the ban status');
    records[0] = { ...records[0], present: false, remark: '已从主列表删除' };
    await refresh(); await banned.getByText('已从主列表删除', { exact: true }).waitFor();
    check(await banned.getByText('已删除', { exact: true }).count() === 1, 'refresh did not add deletion status');
  });
  await test('desktop-dark-and-mobile-no-clipping', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: evidence + '/subscription-history-dark.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await dialog.boundingBox();
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.y >= 0 && bounds.y + bounds.height <= 812, 'mobile dialog leaves viewport');
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile dialog has horizontal overflow');
    await page.screenshot({ path: evidence + '/subscription-history-mobile.png' });
    await dialog.getByRole('button', { name: '关闭历史订阅', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const closedReads = reads; await page.waitForTimeout(5500);
    check(reads === closedReads, 'closed dialog continues polling');
    await page.emulateMedia({ colorScheme: 'light' });
  });
  await test('empty-records-and-runtime-health', async () => {
    records = []; await button.click(); await dialog.getByText('暂无历史订阅记录', { exact: true }).waitFor();
    check((await page.title()).includes('Helper'), 'page identity mismatch');
    check(await page.locator('tr.job-row').count() > 0, 'main account list is blank');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework overlay appeared');
    check(errors.length === 0, errors.join('; ')); check(unexpected.length === 0, 'history triggered account automation');
    await dialog.getByRole('button', { name: '关闭历史订阅', exact: true }).click();
  });
  await test('slow-request-survives-poll-and-unknown-plan-is-not-paid', async () => {
    records = [{ ...fixture, planType: null }]; responseDelay = 6500;
    await button.click(); await dialog.getByText('待确认', { exact: true }).waitFor({ timeout: 15000 });
    check(await dialog.getByText('当前订阅', { exact: true }).count() === 0, 'unknown plan was shown as an active subscription');
    responseDelay = 0;
    await dialog.getByRole('button', { name: '关闭历史订阅', exact: true }).click();
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
