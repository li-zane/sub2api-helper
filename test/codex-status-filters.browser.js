async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], requests = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const url = new URL(route.request().url()), overload = url.searchParams.get('overload'), fingerprint = url.searchParams.get('fingerprint');
    requests.push({ overload, fingerprint, page: url.searchParams.get('page') });
    const response = await route.fetch({ url: url.origin + '/api/jobs?page=1' }), data = await response.json();
    const byId = new Map(data.jobs.map(j => [j.id, j])), template = data.jobs[0];
    const all = data.selection.map((selection, i) => ({ ...(byId.get(selection.id) || template), ...selection,
      overloadFixture: i % 4 === 0 ? 'normal' : i % 4 === 3 ? null : 'overloaded',
      fingerprintFixture: i % 4 === 1 ? 'mismatch' : i % 4 === 3 ? null : 'match' }));
    const filtered = all.filter(j => (!overload || j.overloadFixture === overload) && (!fingerprint || j.fingerprintFixture === fingerprint));
    const totalPages = Math.max(1, Math.ceil(filtered.length / 20)), currentPage = Math.min(Number(url.searchParams.get('page') || 1), totalPages);
    data.jobs = filtered.slice((currentPage - 1) * 20, currentPage * 20); data.selection = filtered;
    data.pagination = { page: currentPage, pageSize: 20, total: filtered.length, totalPages, totalAll: 24 };
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
  const heading = page.locator('.codex-status-heading');
  const choose = async (name, option) => {
    await heading.getByRole('button', { name: new RegExp('^筛选' + name + '，') }).click();
    await page.getByRole('menu', { name: '筛选' + name, exact: true }).getByRole('menuitemradio', { name: option, exact: true }).click();
  };
  await run('two-labelled-filters-without-column-width-change', async () => {
    check(await heading.getByRole('button').count() === 2, 'missing independent filters');
    check((await heading.innerText()).includes('过载') && (await heading.innerText()).includes('降智'), 'filter triggers indistinguishable');
    const title = await heading.boundingBox(), chart = await page.locator('.codex-status').first().boundingBox();
    check(title.width >= 132 && chart.width === 132, 'Codex data width changed');
  });
  await run('overload-and-fingerprint-combine-reset-and-clear', async () => {
    await choose('过载', '过载'); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 12);
    await choose('降智', '不降智'); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 6);
    check(requests.some(r => r.overload === 'overloaded' && r.fingerprint === 'match'), 'combined filters missing from API query');
    check(await heading.locator('.column-filter-btn.active').count() === 2, 'active states missing');
    await choose('过载', '不过载'); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 6);
    await choose('降智', '降智'); await page.getByRole('heading', { name: '没有匹配账号', exact: true }).waitFor();
    await page.getByRole('button', { name: '清除全部筛选', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20);
    check(await heading.locator('.column-filter-btn.active').count() === 0, 'clear-all left filters active');
  });
  await run('keyboard-and-mobile-popover-stay-in-viewport', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const trigger = heading.getByRole('button', { name: /^筛选过载，/ }); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    const menu = page.getByRole('menu', { name: '筛选过载', exact: true }); await menu.waitFor();
    const bounds = await menu.boundingBox(); check(bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.y >= 0 && bounds.y + bounds.height <= 812, 'mobile popover clipped');
    await menu.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: `${evidence}/codex-filters-mobile.png` });
    await page.keyboard.press('Escape'); check(await menu.count() === 0, 'Escape did not close filter');
    await page.setViewportSize({ width: 1480, height: 1000 }); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    await menu.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: `${evidence}/codex-filters-desktop.png` }); await page.keyboard.press('Escape');
  });
  await run('no-runtime-errors', async () => check(errors.length === 0, errors.join('; ')));
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
