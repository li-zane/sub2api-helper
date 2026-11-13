async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], metrics = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.setDefaultTimeout(5000);
  const initialUrl = page.url();
  const open = async () => {
    await page.getByRole('button', { name: '任务设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '任务设置', exact: true });
    await dialog.waitFor(); await page.waitForTimeout(240); return dialog;
  };
  const visibleFooter = async dialog => {
    const state = await dialog.evaluate(el => {
      const d = el.getBoundingClientRect(), s = el.querySelector('button[type=submit]').getBoundingClientRect();
      const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
      return { dialog: { top: d.top, bottom: d.bottom }, save: { top: s.top, bottom: s.bottom, left: s.left, right: s.right },
        viewport: { width: innerWidth, height: innerHeight }, hit: Boolean(hit?.closest('button[type=submit]')) };
    });
    metrics.push(state);
    check(state.dialog.top >= -1 && state.dialog.bottom <= state.viewport.height + 1, 'dialog extends beyond viewport');
    check(state.save.top >= state.dialog.top && state.save.bottom <= state.dialog.bottom && state.save.right <= state.viewport.width && state.save.left >= 0,
      'save button is outside the mobile viewport: ' + JSON.stringify(state));
    check(state.hit, 'save button is covered or clipped');
    return state.save;
  };

  for (const viewport of [{ width: 375, height: 812 }, { width: 320, height: 568 }, { width: 812, height: 375 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    const dialog = await open();
    await test(`visible-save-without-auto-scroll-${viewport.width}x${viewport.height}`, async () => {
      await page.screenshot({ path: evidence + `/task-settings-${viewport.width}x${viewport.height}.png` });
      await visibleFooter(dialog);
    });
    await dialog.getByRole('button', { name: '关闭任务设置', exact: true }).click();
  }

  await page.setViewportSize({ width: 375, height: 667 });
  let dialog = await open();
  const body = dialog.locator('.task-settings-body');
  await test('touch-and-wheel-scroll-body-while-actions-stay-visible', async () => {
    check(await body.count() === 1, 'task settings has no separate scroll container');
    const initial = await body.evaluate(el => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
    check(initial.scrollHeight > initial.clientHeight && ['auto', 'scroll'].includes(initial.overflow), 'settings body is not scrollable');
    const saveBefore = await visibleFooter(dialog), backgroundBefore = await page.evaluate(() => scrollY);
    const box = await body.boundingBox(), cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      const x = box.x + 30, from = box.y + box.height - 25, to = box.y + 25;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * i / 12 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('.task-settings-body').scrollTop > 20);
    } finally { await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach(); }
    const swiped = await body.evaluate(el => el.scrollTop);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 700);
    await page.waitForFunction(before => document.querySelector('.task-settings-body').scrollTop > before, swiped);
    check(Math.abs((await visibleFooter(dialog)).top - saveBefore.top) < 1, 'scrolling moved footer out of place');
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    check((await body.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)) <= 1, 'cannot reach last setting');
    check(await dialog.getByRole('button', { name: '添加规则', exact: true }).isVisible(), 'last settings section is missing');
    await page.mouse.wheel(0, 600); await page.waitForTimeout(100);
    check(await page.evaluate(() => scrollY) === backgroundBefore, 'scroll escaped into page behind modal');
    await visibleFooter(dialog);
    await page.screenshot({ path: evidence + '/task-settings-mobile-scrolled.png' });
  });
  await test('focused-input-and-short-viewport-keep-save-visible', async () => {
    await dialog.locator('#task-login-timeout').fill('5');
    await page.setViewportSize({ width: 375, height: 320 });
    await visibleFooter(dialog);
    check((await body.boundingBox()).height > 25, 'short viewport leaves no scrollable settings');
    await page.screenshot({ path: evidence + '/task-settings-short-viewport.png' });
    await page.setViewportSize({ width: 375, height: 667 });
  });
  await test('mobile-save-and-reopen-persists-edited-settings', async () => {
    // Bounding/hit checks run before click, so Playwright cannot hide an offscreen footer by auto-scrolling it.
    await visibleFooter(dialog);
    const response = page.waitForResponse(r => r.url().endsWith('/api/task-settings') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click();
    const saved = await response; check(saved.ok(), 'mobile save failed');
    check(saved.request().postDataJSON().loginTimeoutMinutes === 5, 'changed setting was not submitted');
    await dialog.waitFor({ state: 'hidden' }); dialog = await open();
    check(await dialog.locator('#task-login-timeout').inputValue() === '5', 'saved setting did not survive reopening');
    await visibleFooter(dialog); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  });
  if (await page.getByRole('dialog', { name: '任务设置', exact: true }).count()) {
    await page.getByRole('dialog', { name: '任务设置', exact: true }).getByRole('button', { name: '关闭任务设置', exact: true }).click();
  }
  await test('page-identity-and-no-runtime-overlay-errors', async () => {
    check(page.url() === initialUrl && /Helper/.test(await page.title()), 'wrong application page');
    check(await page.getByRole('button', { name: '任务设置', exact: true }).count() === 1, 'application shell is blank');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework error overlay');
    check(errors.length === 0, errors.join('; '));
  });
  return { passed: results.filter(item => item.passed).length, total: results.length, results, metrics };
}
