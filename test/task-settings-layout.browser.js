async (page) => {
  const results = [], errors = [], evidence = "__UI_TEST_EVIDENCE_DIR__";
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 2562, height: 1200 });
  await page.getByRole('button', { name: '任务设置', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '任务设置', exact: true });
  await modal.waitFor();
  const select = modal.getByRole('combobox', { name: '账号代理分配', exact: true });
  await test('first-open-dropdown-anchored-from-first-frame', async () => {
    await select.evaluate(el => el.addEventListener('click', () => {
      window.__menuFrames = [];
      const capture = () => {
        const menu = document.querySelector('.custom-select-dropdown');
        if (!menu) return;
        const a = el.getBoundingClientRect(), b = menu.getBoundingClientRect();
        window.__menuFrames.push({ triggerLeft: a.left, triggerTop: a.top, triggerBottom: a.bottom, menuLeft: b.left, menuTop: b.top, menuBottom: b.bottom });
        if (window.__menuFrames.length < 8) requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    }, { once: true }));
    await select.click();
    await page.waitForFunction(() => window.__menuFrames?.length === 8);
    const frames = await page.evaluate(() => window.__menuFrames);
    await page.screenshot({ path: evidence + '/first-open-dropdown.png' });
    check(frames.every(f => Math.abs(f.menuLeft - f.triggerLeft) < 12), 'first-open menu not anchored: ' + JSON.stringify(frames[0]));
    check(frames.every(f => Math.min(Math.abs(f.menuTop - f.triggerBottom), Math.abs(f.triggerTop - f.menuBottom)) < 12), 'vertical gap from trigger');
  });
  await page.keyboard.press('Escape');
  await test('reopen-selection-and-resize-remain-anchored', async () => {
    await select.click();
    await modal.getByRole('option', { name: '动态登录 + 按 PlanType 授权', exact: true }).click();
    check((await select.innerText()).includes('动态登录'), 'selection failed');
    await select.click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(180);
    if (await select.getAttribute('aria-expanded') === 'false') await select.click();
    await page.waitForTimeout(160);
    const a = await select.boundingBox(), b = await modal.getByRole('listbox').boundingBox();
    check(Math.abs(a.x - b.x) < 2 && b.x + b.width <= 1440, 'resize/reopen mispositioned');
    await page.keyboard.press('Escape');
    await select.click();
    await modal.getByRole('option', { name: '全局代理', exact: true }).click();
  });
  for (let i = 0; i < 2; i++) {
    await modal.getByRole('button', { name: '添加规则', exact: true }).click();
    await modal.locator('.task-auto-plan-field input').nth(i).fill(i ? 'free' : 'team');
  }
  const first = modal.locator('.task-auto-rule').first();
  const upload = first.getByRole('checkbox', { name: '上传到 Sub2API', exact: true });
  const rotate = first.getByRole('checkbox', { name: '一键轮换并上传', exact: true });
  await test('auto-task-options-two-aligned-columns', async () => {
    await first.scrollIntoViewIfNeeded();
    const boxes = await first.locator('.task-auto-action-option').evaluateAll(nodes => nodes.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
    check(boxes.length === 5, 'missing options including Codex prerequisite');
    check(Math.abs(boxes[0].x - boxes[2].x) < 1 && Math.abs(boxes[1].x - boxes[3].x) < 1, 'option columns not aligned: ' + JSON.stringify(boxes));
    check(Math.max(...boxes.map(b => b.width)) - Math.min(...boxes.map(b => b.width)) < 1, 'unequal option widths');
    check(boxes[0].y === boxes[1].y && boxes[2].y === boxes[3].y, 'option rows not aligned');
    await page.screenshot({ path: evidence + '/auto-task-options-desktop.png' });
  });
  await test('upload-modes-exclusive-in-both-directions', async () => {
    await upload.check(); await rotate.check();
    check(await rotate.isChecked() && !await upload.isChecked(), 'rotate retains plain upload');
    check(!await first.getByRole('checkbox', {name:'Codex 授权',exact:true}).isChecked(), 'rotation schedules a redundant early authorization');
    await upload.check();
    check(await upload.isChecked() && !await rotate.isChecked(), 'plain upload retains rotate');
    await first.getByRole('checkbox', { name: '自动开启过载统计', exact: true }).check();
    await rotate.check();
    check(await first.getByRole('checkbox', { name: '自动开启过载统计', exact: true }).isChecked(), 'upload change clears independent task');
    check(await first.getByText('新账号先登录 Web；一键轮换依次完成 2FA、登出设备、重登 Web、授权与上传，无需额外勾选 Codex 授权。', { exact: true }).isVisible(), 'upload relationship not explained');
  });
  await test('exclusive-upload-values-save-and-reopen', async () => {
    await modal.locator('.task-auto-rule').nth(1).getByRole('checkbox', { name: '上传到 Sub2API', exact: true }).check();
    const reply = page.waitForResponse(r => r.url().endsWith('/api/task-settings') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: '保存设置', exact: true }).click();
    const response = await reply, body = response.request().postDataJSON();
    check(response.ok(), 'save failed: ' + await response.text());
    check(body.autoActions.team.includes('rotate-logout-reauthorize-upload') && !body.autoActions.team.includes('upload'), 'duplicate upload in request');
    check(body.autoActions.free.length === 2 && body.autoActions.free.includes('authorize-codex') && body.autoActions.free.includes('upload'), 'plain upload lost its OAuth prerequisite');
    await modal.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '任务设置', exact: true }).click();
    await modal.waitFor();
    check(await rotate.isChecked() && !await upload.isChecked(), 'saved mode not restored');
  });
  await test('mobile-rules-and-first-open-select-stay-in-viewport', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await first.scrollIntoViewIfNeeded();
    const inside = await first.locator('.task-auto-action-option').evaluateAll(nodes => nodes.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1; }));
    check(inside, 'mobile options overflow');
    await page.screenshot({ path: evidence + '/auto-task-options-mobile.png' });
    await modal.getByRole('combobox', { name: 'Codex 授权方式', exact: true }).click();
    await page.waitForTimeout(160);
    check(await modal.getByRole('listbox').count(), 'focus scroll dismissed first-open menu');
    const b = await modal.getByRole('listbox').boundingBox();
    check(b.x >= 0 && b.y >= 0 && b.x + b.width <= 376 && b.y + b.height <= 812, 'first-open mobile menu outside viewport');
    await page.keyboard.press('Escape');
  });
  if (await modal.count()) await modal.getByRole('button', { name: '取消', exact: true }).click();
  await test('no-runtime-errors', async () => check(!errors.length, errors.join('; ')));
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
