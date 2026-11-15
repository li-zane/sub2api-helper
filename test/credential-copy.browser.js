async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], requests = [], downloads = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  let revision = 1, fail = false, release;
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', d => downloads.push(d.suggestedFilename()));
  await page.addInitScript(() => {
    window.copiedCredentials = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
      if (window.rejectClipboard) throw Error('clipboard rejected');
      window.copiedCredentials.push(value);
    } } });
  });
  const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
  const line = n => `review-${n}@example.test----${revision > 1 ? '' : 'fixture-password-' + n}----${revision > 1 ? '' : 'JBSWY3DPEHPK3PXP'}`;
  await page.route('**/api/jobs/copy-credentials', async route => {
    const request = route.request(), body = request.postDataJSON();
    requests.push(body.ids);
    check(request.method() === 'POST', 'copy is not a POST');
    check(Boolean(request.headers()['x-console-token']), 'missing console authentication');
    if (release) await new Promise(resolve => { release = resolve; });
    if (fail) return route.fulfill({ status: 409, json: { error: 'fixture credential read failed' } });
    await route.fulfill({ json: { text: body.ids.map(value => line(Number(value.slice(-12)))).join('\n'), count: body.ids.length } });
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length > 0);
  const row = n => page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 review-${n}@example.test`, exact: true }) });
  const single = n => row(n).getByRole('button', { name: '复制账号凭据', exact: true });
  const bulk = page.getByRole('button', { name: '批量复制凭据', exact: true });
  const copied = () => page.evaluate(() => window.copiedCredentials);
  const waitCopied = count => page.waitForFunction(n => window.copiedCredentials.length === n, count);
  await test('single-copies-three-fields-without-download', async () => {
    check(await bulk.isDisabled(), 'bulk copy enabled with no selection');
    check(await page.getByRole('button', { name: '下载导入文件', exact: true }).count() === 0, 'old download action remains');
    await single(1).click(); await waitCopied(1);
    check((await copied())[0] === line(1), 'single format mismatch');
    check(JSON.stringify(requests[0]) === JSON.stringify([id(1)]), 'wrong account copied');
    await page.getByText('账号凭据已复制', { exact: true }).waitFor();
  });
  await test('banned-and-no-oauth-accounts-remain-copyable', async () => {
    check(await single(2).isEnabled(), 'banned credential copy disabled');
    check(await single(3).isEnabled(), 'no-OAuth credential copy disabled');
    await single(2).click(); await waitCopied(2);
    check((await copied())[1] === line(2), 'banned account mismatch');
  });
  await test('batch-copies-all-selected-accounts-one-per-line', async () => {
    for (const n of [2, 1, 3]) await row(n).getByRole('checkbox').check();
    await bulk.click(); await waitCopied(3);
    check((await copied())[2] === [2, 1, 3].map(line).join('\n'), 'batch order/fields mismatch');
    check(requests[2].length === 3, 'batch omitted an account without OAuth');
    await page.getByText('已复制 3 个账号的凭据', { exact: true }).waitFor();
  });
  await test('copy-refetches-latest-values-and-preserves-empty-columns', async () => {
    revision = 2;
    await single(1).click(); await waitCopied(4);
    check((await copied())[3] === 'review-1@example.test--------', 'copy reused a stale password or omitted empty columns');
    revision = 1;
  });
  await test('pending-single-and-batch-copies-disable-their-controls', async () => {
    release = () => {};
    const previousRequests = requests.length;
    await single(1).click();
    await page.waitForFunction(() => document.querySelector('tr.job-row button[aria-label="复制账号凭据"]:disabled'));
    check(requests.length === previousRequests + 1, 'single dispatched duplicate requests');
    const resolveSingle = release; release = undefined; resolveSingle();
    await waitCopied(5);
    release = () => {};
    await bulk.click(); check(await bulk.isDisabled(), 'bulk copy is clickable while pending');
    // Let the route capture its resolver before releasing it.
    for (const end = Date.now() + 5000; requests.length < previousRequests + 2 && Date.now() < end;) await page.waitForTimeout(20);
    check(requests.length === previousRequests + 2, 'batch request was not dispatched');
    const resolveBulk = release; release = undefined; resolveBulk();
    await waitCopied(6); check(await bulk.isEnabled(), 'bulk copy stays disabled after completion');
  });
  await test('read-and-clipboard-errors-do-not-report-copy-success', async () => {
    fail = true;
    await single(1).click(); await page.getByText('fixture credential read failed', { exact: true }).waitFor();
    check((await copied()).length === 6, 'failed read overwrote clipboard');
    fail = false;
    await page.evaluate(() => { window.rejectClipboard = true; });
    await bulk.click(); await page.getByText('clipboard rejected', { exact: true }).waitFor();
    check((await copied()).length === 6, 'rejected clipboard was marked copied');
    check(await bulk.isEnabled(), 'clipboard error left action stuck');
    await page.evaluate(() => { window.rejectClipboard = false; });
  });
  await test('clipboard-fallback-and-runtime-health', async () => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      document.execCommand = command => {
        if (command !== 'copy') return false;
        window.copiedCredentials.push(document.activeElement.value); return true;
      };
    });
    await single(3).click(); await waitCopied(7);
    check((await copied())[6] === line(3), 'fallback clipboard format mismatch');
    check(await page.locator('textarea[readonly]').count() === 0, 'fallback textarea was not removed');
    check(downloads.length === 0, 'credential action downloaded a file');
    check(errors.length === 0, errors.join('; '));
    await page.setViewportSize({ width: 1480, height: 1000 });
    await page.screenshot({ path: evidence + '/credential-copy-desktop.png' });
  });
  if (release) { const resolve = release; release = undefined; resolve(); }
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
