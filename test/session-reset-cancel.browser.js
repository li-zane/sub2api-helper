async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let canceled = false, cancelCalls = 0, target;
  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/cancel')) {
      cancelCalls++; canceled = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (!['/api/jobs', '/api/jobs/query'].includes(url.pathname)) return route.continue();
    const response = await route.fetch(), data = await response.json();
    if (data.jobs?.length) {
      target ||= data.jobs[0].id;
      data.jobs = data.jobs.map(job => job.id !== target ? job : { ...job,
        status: canceled ? 'canceled' : 'completed', displayStatus: canceled ? 'canceled' : 'completed', canCancel: !canceled,
        lastOperationType: 'session_reset', canDownload: true,
        poolRefreshAction: canceled ? null : 'session-reset', poolRefreshReady: !canceled,
        poolRefreshError: canceled ? null : 'fixture synchronization pending',
        sessionReset: { status: canceled ? 'failed' : 'syncing', poolPaused: true, error: canceled ? '用户取消了会话重建' : null },
      });
    }
    return route.fulfill({ response, json: data });
  });
  await page.reload();
  const row = page.locator('tr.job-row').first();
  const cancel = row.getByRole('button', { name: '取消任务', exact: true });
  await cancel.waitFor();
  if (!await cancel.isEnabled()) throw Error('syncing cancellation is disabled');
  await page.screenshot({ path: evidence + '/sync-cancel-before.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await cancel.scrollIntoViewIfNeeded();
  if (!await cancel.isEnabled()) throw Error('mobile cancellation is unavailable');
  await page.screenshot({ path: evidence + '/sync-cancel-mobile.png' });
  await cancel.click();
  await cancel.waitFor({ state: 'hidden' });
  if (cancelCalls !== 1) throw Error('cancellation submitted more than once');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: evidence + '/sync-cancel-after.png' });
  if (!/Helper/.test(await page.title()) || !page.url().startsWith('http://127.0.0.1:')) throw Error('wrong page');
  if (await page.locator('tr.job-row').count() === 0 || await page.locator('vite-error-overlay').count()) throw Error('blank page or framework overlay');
  if (errors.length) throw Error(errors.join('; '));
  console.log('SYNC_CANCEL_UI_PASS completed OAuth + syncing exposes cancel; desktop/mobile; one submission; canceled state hides button; no page errors');
  return { passed: 1, total: 1, results: [{ name: 'sync-cancel-desktop-mobile-and-terminal-state', passed: true }] };
}
