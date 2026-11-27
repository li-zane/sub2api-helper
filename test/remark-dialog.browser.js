async page => {
  const results = [], errors = [];
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  const content = '第一行备注，保留完整内容。\n' + 'longAccountRemarkWithoutSpaces'.repeat(5) + '\n最后一行。';
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of 500\b/.test(message.text())) errors.push(message.text());
  });
  page.setDefaultTimeout(7000);
  const email = 'review-1@example.test';
  const row = page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: `选择 ${email}`, exact: true }) });
  const trigger = row.locator('.account-remark-button');
  const waitRemark = expected => page.waitForFunction(([email, expected]) => {
    const row = [...document.querySelectorAll('tr.job-row')].find(row => row.querySelector('input[type="checkbox"]')?.getAttribute('aria-label') === `选择 ${email}`);
    return (row?.querySelector('.account-remark-text')?.textContent || '') === expected;
  }, [email, expected]);
  await trigger.waitFor();
  const preview = page.getByRole('dialog', { name: /的完整备注$/ });
  const open = async () => {
    await trigger.click();
    if (await trigger.getAttribute('aria-haspopup') === 'dialog') await preview.getByRole('button', { name: '编辑备注', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '账号备注', exact: true }); await dialog.waitFor(); return dialog;
  };
  let writes = 0;
  const fail = async route => { writes++; await route.fulfill({ status: 500, json: { error: 'fixture-remark-error' } }); };
  await page.route(/\/api\/jobs\/[^/]+\/remark$/, fail);
  let dialog = await open();
  const initial = await dialog.locator('#account-remark').inputValue();
  await test('failed-save-retains-draft-and-focus', async () => {
    const input = dialog.locator('#account-remark');
    check(await input.evaluate(el => el === document.activeElement), 'initial focus is not the remark input');
    await input.fill('unsaved draft');
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
    check(await dialog.getByRole('alert').innerText() === 'fixture-remark-error', 'error not displayed');
    check(await input.inputValue() === 'unsaved draft', 'failed request lost draft');
    check(writes === 1, 'failure was not submitted exactly once');
  });
  await test('cancel-discards-draft-without-saving', async () => {
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(writes === 1, 'cancel submitted a request');
    dialog = await open();
    check(await dialog.locator('#account-remark').inputValue() === initial, 'cancel persisted draft');
  });
  await test('successful-save-updates-row-and-reopens', async () => {
    await page.unroute(/\/api\/jobs\/[^/]+\/remark$/, fail);
    await dialog.locator('#account-remark').fill(content);
    const response = page.waitForResponse(r => /\/api\/jobs\/[^/]+\/remark$/.test(r.url()) && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
    check((await response).ok(), 'save failed');
    await dialog.waitFor({ state: 'hidden' });
    await waitRemark(content);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      check(await trigger.locator('.account-remark-text').evaluate(element => {
        const style = getComputedStyle(element), button = element.closest('button').getBoundingClientRect();
        return button.height === 24 && style.whiteSpace === 'nowrap' && style.textOverflow === 'ellipsis'
          && element.scrollWidth > element.clientWidth;
      }), 'remark is not a fixed-height ellipsis at width ' + width);
    }
    dialog = await open();
    check(await dialog.locator('#account-remark').inputValue() === content, 'saved remark not restored');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(errors.length === 0, errors.join('; '));
  });
  await test('hover-preview-keeps-full-text-without-row-growth', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.mouse.move(0, 0);
    const before = await row.boundingBox();
    await trigger.hover();
    await preview.waitFor();
    check(await preview.getByLabel('备注全文').textContent() === content, 'preview truncated or changed newlines');
    await preview.getByLabel('备注全文').hover();
    await page.waitForTimeout(250);
    check(await preview.isVisible(), 'moving to preview closed it');
    check(Math.abs((await row.boundingBox()).height - before.height) < 1, 'preview expanded table row');
    await page.screenshot({ path: evidence + '/remark-preview-desktop.png' });
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: 'hidden' });
  });
  await test('click-pins-preview-and-Escape-restores-trigger', async () => {
    await trigger.click(); await preview.waitFor();
    await page.mouse.move(0, 0); await page.waitForTimeout(250);
    check(await preview.isVisible(), 'click did not pin preview');
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden' });
    check(await trigger.evaluate(el => el === document.activeElement), 'Escape did not restore focus');
    check(await trigger.getAttribute('aria-expanded') === 'false', 'expanded state stale');
  });
  await test('keyboard-can-read-and-open-editor', async () => {
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await trigger.press('Enter'); await preview.waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('account-remark-full'));
    await page.keyboard.press('Tab');
    check(await preview.getByRole('button', { name: '编辑备注', exact: true }).evaluate(el => el === document.activeElement), 'keyboard cannot reach edit');
    await page.keyboard.press('Enter');
    dialog = page.getByRole('dialog', { name: '账号备注', exact: true }); await dialog.waitFor();
    check(await dialog.locator('#account-remark').inputValue() === content, 'keyboard edit lost full content');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  });
  await test('mobile-preview-fits-and-closes-without-saving', async () => {
    await page.setViewportSize({ width: 375, height: 667 });
    await trigger.click(); await preview.waitFor();
    const bounds = await preview.boundingBox();
    check(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 375 && bounds.y + bounds.height <= 667, 'mobile preview exceeds viewport');
    check(await preview.evaluate(el => el.scrollWidth <= el.clientWidth), 'unbroken text overflows');
    check(await preview.getByLabel('备注全文').textContent() === content, 'mobile preview missing full text');
    await page.screenshot({ path: evidence + '/remark-preview-mobile.png' });
    await preview.getByRole('button', { name: '关闭完整备注', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
    check(await trigger.locator('.account-remark-text').textContent() === content, 'closing preview changed remark');
    check(errors.length === 0 && (await page.title()).includes('Helper') && page.url().startsWith('http://127.0.0.1:'), errors.join('; ') || 'page identity failed');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework overlay');
  });
  await test('long-remark-scrolls-and-outside-click-dismisses', async () => {
    dialog = await open();
    const long = '多行备注与原始换行内容。\n'.repeat(100);
    await dialog.locator('#account-remark').fill(long);
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitRemark(long);
    await trigger.click(); await preview.waitFor();
    const full = preview.getByLabel('备注全文');
    check(await full.textContent() === long, 'long remark truncated in preview');
    check(await full.evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 320), 'long preview did not scroll');
    check((await trigger.boundingBox()).height === 24, 'long remark changed badge height');
    await page.mouse.click(1, 1); await preview.waitFor({ state: 'hidden' });
  });
  await test('empty-remark-still-opens-editor-directly', async () => {
    dialog = await open();
    await dialog.locator('#account-remark').fill('');
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitRemark('');
    check((await trigger.boundingBox()).height === 24, 'empty badge height differs');
    await trigger.click();
    dialog = page.getByRole('dialog', { name: '账号备注', exact: true }); await dialog.waitFor();
    check(await dialog.locator('#account-remark').inputValue() === '' && await preview.count() === 0, 'empty remark opened a preview');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    check(errors.length === 0, errors.join('; '));
  });
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
