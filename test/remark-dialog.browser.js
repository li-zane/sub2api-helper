async page => {
  const results = [], errors = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  const row = page.locator('tr.job-row').first();
  const trigger = row.locator('.account-remark-button');
  await trigger.waitFor();
  const open = async () => { await trigger.click(); const dialog = page.getByRole('dialog', { name: '账号备注', exact: true }); await dialog.waitFor(); return dialog; };
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
    await dialog.locator('#account-remark').fill('fixture saved remark');
    const response = page.waitForResponse(r => /\/api\/jobs\/[^/]+\/remark$/.test(r.url()) && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click();
    check((await response).ok(), 'save failed');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('tr.job-row .account-remark-button')?.getAttribute('title') === 'fixture saved remark');
    dialog = await open();
    check(await dialog.locator('#account-remark').inputValue() === 'fixture saved remark', 'saved remark not restored');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    check(errors.length === 0, errors.join('; '));
  });
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
