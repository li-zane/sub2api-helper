async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], metrics = {};
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, action) => { try { await action(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.emailCopied = value; } } }); });
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => ({ ...job, modelFingerprint: { ...job.modelFingerprint,
      concurrencySyncPending: i === 0, concurrencySyncError: i === 1 ? 'fixture sync error' : null,
      recentResults: [{ status: 'match', checkedAt: new Date().toISOString() }] } }));
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  await page.locator('tr.job-row').first().waitFor();
  const row = () => page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: '选择 review-1@example.test', exact: true }) });
  const renamed = 'changed-login+tag@example.test', finalEmail = 'second-login@example.test';
  const dialog = page.getByRole('dialog', { name: '账号凭据', exact: true });
  await run('codex-chart-and-yellow-outline-are-separated', async () => {
    for (const selector of ['.is-sync-pending', '.is-sync-error']) {
      const rounds = page.locator('.fingerprint-rounds' + selector).first(); await rounds.waitFor();
      const gaps = await rounds.evaluate(el => {
        const rect = el.getBoundingClientRect(), chart = el.closest('.codex-status').querySelector('.overload-chart').getBoundingClientRect();
        const style = getComputedStyle(el), reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        return { layoutGap: rect.top - chart.bottom, visibleGap: rect.top - reach - chart.bottom, width: rect.width, chartWidth: chart.width };
      });
      check(gaps.layoutGap >= 8 && gaps.visibleGap >= 5, 'outline overlaps chart: ' + JSON.stringify(gaps));
      check(Math.abs(gaps.width - gaps.chartWidth) < 1, 'aligned widths changed'); metrics[selector] = gaps;
    }
    await page.locator('.codex-status').first().screenshot({ path: `${evidence}/codex-spacing.png` });
  });
  await run('credential-email-save-updates-list-and-copies-new-value', async () => {
    await row().getByRole('button', { name: '查看或修改账号凭据', exact: true }).click();
    const input = dialog.getByLabel('登录邮箱', { exact: true }); await input.waitFor();
    check(await input.inputValue() === 'review-1@example.test', 'current email missing');
    await input.fill(renamed);
    check(await dialog.getByRole('button', { name: '重新读取凭据', exact: true }).isDisabled(), 'refresh can overwrite draft');
    await dialog.getByRole('button', { name: '保存登录邮箱', exact: true }).click();
    await page.getByText('登录邮箱已保存，变更记录已加入凭据历史', { exact: true }).waitFor();
    const updated = page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 ${renamed}`, exact: true }) });
    await updated.waitFor(); check(await input.inputValue() === renamed, 'saved draft changed');
    await dialog.locator('.credential-dialog-actions').getByRole('button', { name: '关闭', exact: true }).click();
    await updated.getByRole('button', { name: '复制账号凭据', exact: true }).click();
    await page.waitForFunction(email => window.emailCopied?.startsWith(email + '----'), renamed);
  });
  await run('email-collision-keeps-draft-and-server-value', async () => {
    const updated = page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 ${renamed}`, exact: true }) });
    await updated.getByRole('button', { name: '查看或修改账号凭据', exact: true }).click();
    const input = dialog.getByLabel('登录邮箱', { exact: true }); await input.waitFor(); await input.fill('review-2@example.test');
    await dialog.getByRole('button', { name: '保存登录邮箱', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '该邮箱已关联其他账号' }).waitFor();
    check(await input.inputValue() === 'review-2@example.test', 'failed save lost draft');
    check(await updated.count() === 1, 'collision changed saved row');
    await input.fill(finalEmail); await input.press('Enter');
    await page.getByRole('checkbox', { name: `选择 ${finalEmail}`, exact: true }).waitFor();
    await dialog.locator('.credential-dialog-actions').getByRole('button', { name: '关闭', exact: true }).click();
  });
  await run('email-history-is-newest-first-with-expandable-versions', async () => {
    const updated = page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 ${finalEmail}`, exact: true }) });
    await updated.getByRole('button', { name: '查看协议日志', exact: true }).click();
    const log = page.getByRole('dialog', { name: '账号日志与凭据', exact: true });
    await log.getByRole('tab', { name: '凭据历史', exact: true }).click();
    const group = log.locator('[data-credential-type="email"]'); await group.waitFor();
    await group.locator('[data-entry-id]').first().click();
    await log.locator('pre').filter({ hasText: finalEmail }).waitFor();
    check((await log.locator('pre').innerText()).includes(renamed), 'newest change missing old value');
    check((await group.locator('time').first().innerText()) !== '时间未知', 'timestamp missing');
    await group.getByRole('button', { name: '展开 登录邮箱 的 1 条历史记录', exact: true }).click();
    await group.locator('[data-entry-id]').last().click();
    await log.locator('pre').filter({ hasText: 'review-1@example.test' }).waitFor();
    check(!(await log.locator('pre').innerText()).includes(finalEmail), 'wrong version opened');
    await log.getByRole('button', { name: '关闭协议日志', exact: true }).click();
  });
  await run('mobile-email-editor-and-spacing-fit', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const updated = page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 ${finalEmail}`, exact: true }) });
    await updated.getByRole('button', { name: '查看或修改账号凭据', exact: true }).click();
    const input = dialog.getByLabel('登录邮箱', { exact: true }); await input.waitFor();
    check(await input.inputValue() === finalEmail, 'reopened editor forgot email');
    const bounds = await input.boundingBox(); check(bounds.x >= 0 && bounds.x + bounds.width <= 375, 'mobile email input overflows');
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile credential dialog overflows');
    await page.waitForFunction(() => !document.querySelector('.task-toast'));
    await page.screenshot({ path: `${evidence}/login-email-mobile.png` });
    await dialog.locator('.credential-dialog-actions').getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1480, height: 1000 });
    await updated.getByRole('button', { name: '查看或修改账号凭据', exact: true }).click();
    await dialog.getByLabel('登录邮箱', { exact: true }).waitFor();
    await page.screenshot({ path: `${evidence}/login-email-desktop.png` });
    await dialog.locator('.credential-dialog-actions').getByRole('button', { name: '关闭', exact: true }).click();
  });
  await run('no-browser-runtime-errors', async () => check(errors.length === 0, errors.join('; ')));
  return { passed: results.filter(r => r.passed).length, total: results.length, results, metrics };
}
