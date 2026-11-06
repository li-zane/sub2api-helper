async (page) => {
  const root = "__UI_TEST_ROOT__", evidence = "__UI_TEST_EVIDENCE_DIR__";
  const results = [], errors = []; let selectChecks = 0, helpChecks = 0;
  const check = (v, m) => { if (!v) throw Error(m); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(3000);
  await page.route('**/api/direct-ip', r => r.fulfill({ json: { ip: '198.51.100.8' } }));
  await page.route('**/api/jobs/*/sessions', r => r.fulfill({ json: { sessions: [], total: 0 } }));
  await page.route('**/api/jobs/*/workspaces', r => r.fulfill({ json: { workspaces: [], total: 0 } }));
  await page.route('**/api/jobs/*/credentials', r => r.fulfill({ json: { credentials: {} } }));
  await page.route('**/api/jobs/*/logs', r => r.fulfill({ json: { logs: 'fixture log' } }));
  await page.route('**/api/jobs/*/model-fingerprint/history', r => r.fulfill({ json: { records: [], models: [] } }));
  const regionConfig = name => page.getByRole('region', { name, exact: true }).getByRole('button', { name: '配置', exact: true });
  const row = () => page.locator('tr.job-row').filter({ has: page.getByRole('checkbox', { name: '选择 review-1@example.test', exact: true }) });
  const cases = [
    ['接码平台配置', () => regionConfig('接码平台配置')],
    ['邮件 API 请求配置', () => regionConfig('邮件接码请求配置')],
    ['Sub2API 配置', () => regionConfig('Sub2API 配置与号池监控')],
    ['代理 IP 配置与检测', () => regionConfig('代理 IP 配置')],
    ['批量添加账号', () => page.getByRole('button', { name: '批量添加', exact: true })],
    ['邮箱列表筛选', () => page.getByRole('button', { name: '邮箱列表筛选', exact: true })],
    ['PlanType 映射', () => page.getByRole('button', { name: '配置 PlanType 映射', exact: true })],
    ['任务设置', () => page.getByRole('button', { name: '任务设置', exact: true })],
    ['账号备注', () => row().getByRole('button', { name: '编辑 review-1@example.test 的备注', exact: true })],
    ['账号凭据', () => row().getByRole('button', { name: '查看或修改账号凭据', exact: true })],
    ['已登录设备与会话', () => row().getByRole('button', { name: '查看已登录设备和会话', exact: true })],
    ['工作空间', () => row().getByRole('button', { name: '查看并切换工作空间', exact: true })],
    ['账号日志与凭据', () => row().getByRole('button', { name: '查看协议日志', exact: true })],
    ['最近操作反馈', () => row().locator('.operation-feedback-trigger')],
    ['降智检测设置', () => page.getByRole('button', { name: '降智检测设置', exact: true })],
    [/最近 6 轮归因结果/, () => row().locator('.fingerprint-round').last()],
  ];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const [name, trigger] of cases) {
      await test(`modal-${name}-${viewport.width}-position-focus-Escape`, async () => {
        const button = trigger(); await button.click();
        const modal = page.getByRole('dialog', { name, exact: typeof name === 'string' });
        try {
          await modal.waitFor(); await page.waitForTimeout(220);
          const b = await modal.boundingBox();
          check(b.x >= -1 && b.y >= -1 && b.x + b.width <= viewport.width + 1 && b.y + b.height <= viewport.height + 1, 'modal outside viewport: ' + JSON.stringify(b));
          check(await modal.evaluate(el => el.contains(document.activeElement)), 'focus remained behind modal');
          const combos = modal.getByRole('combobox');
          for (let i = 0; i < await combos.count(); i++) {
            const combo = combos.nth(i);
            if (!await combo.isEnabled() || await combo.getAttribute('aria-haspopup') !== 'listbox') continue;
            await combo.click(); await page.waitForTimeout(150);
            const menu = modal.getByRole('listbox');
            const bounds = await menu.boundingBox();
            check(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, 'first-open select outside viewport');
            await page.keyboard.press('Escape'); check(await modal.isVisible(), 'select Escape closed its parent'); selectChecks++;
          }
          const help = modal.locator('.help-tip-trigger').first();
          if (await help.count()) {
            await help.click(); await page.waitForTimeout(150);
            const tip = page.locator('.help-tip-popover'), b = await tip.boundingBox();
            check(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= viewport.width + 1 && b.y + b.height <= viewport.height + 1, 'help popup outside viewport');
            await page.keyboard.press('Escape'); check(await modal.isVisible(), 'help Escape closed parent'); helpChecks++;
          }
          const controls = modal.locator('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]');
          const last = await controls.evaluateAll(nodes => nodes.filter(el => el.tabIndex >= 0 && el.getClientRects().length).at(-1)?.outerHTML);
          if (last) {
            await controls.evaluateAll(nodes => nodes.filter(el => el.tabIndex >= 0 && el.getClientRects().length).at(-1)?.focus());
            await page.keyboard.press('Tab');
            check(await modal.evaluate(el => el.contains(document.activeElement)), 'Tab escaped modal');
          }
          await page.mouse.move(0, 0);
          if (await page.locator('.help-tip-popover').count()) {
            await page.keyboard.press('Escape');
            check(await modal.isVisible(), 'help Escape closed its parent modal');
          }
          await page.keyboard.press('Escape');
          check(!await modal.count(), 'Escape did not close modal');
          check(await button.evaluate(el => document.activeElement === el), 'opener focus not restored');
        } finally {
          if (await modal.count()) {
            const close = modal.locator('.dialog-header button').last();
            if (await close.isEnabled()) await close.click();
          }
        }
      });
    }
  }
  await test('column-filter-first-open-within-viewport-and-not-clipped', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    const trigger = page.getByRole('button', { name: /^筛选Plan type，当前/ });
    await trigger.click(); await page.waitForTimeout(180);
    const menu = page.getByRole('menu', { name: '筛选Plan type', exact: true });
    try {
      const b = await menu.boundingBox();
      check(b.x >= 0 && b.x + b.width <= 375 && b.y >= 0 && b.y + b.height <= 812, 'filter popup exceeds viewport: ' + JSON.stringify(b));
      check(await menu.evaluate(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 8); return hit && el.contains(hit); }), 'filter popup clipped by table container');
    } finally { await page.keyboard.press('Escape'); }
  });
  await test('bulk-menu-first-open-position-and-outside-dismiss', async () => {
    await row().getByRole('checkbox').check();
    const trigger = page.locator('.bulk-actions').getByRole('button', { name: '更多', exact: true });
    try {
      await trigger.click(); await page.waitForTimeout(180);
      const menu = page.locator('.bulk-dropdown-menu'), b = await menu.boundingBox();
      check(b.x >= 0 && b.y >= 0 && b.x + b.width <= 375 && b.y + b.height <= 812, 'bulk menu exceeds viewport: ' + JSON.stringify(b));
      await menu.screenshot({ path: evidence + '/bulk-menu-mobile.png' });
      await page.keyboard.press('Escape'); check(await menu.count() === 0, 'bulk menu Escape failed');
      await trigger.click(); await page.mouse.click(2, 2); check(await menu.count() === 0, 'bulk menu outside click failed');
    } finally { await row().getByRole('checkbox').uncheck(); }
  });
  await test('long-help-near-edge-remains-readable-and-dismisses', async () => {
    await page.setViewportSize({ width: 375, height: 320 });
    await page.evaluate(async root => { window.__cleanupPopupFixture = (await import('/@fs/' + root + '/test/popup-audit-fixture.jsx')).mount(); }, root);
    try {
      await page.getByRole('button', { name: 'Long edge help', exact: true }).click();
      const tip = page.getByRole('tooltip').filter({ hasText: '第 18 项配置' }); await tip.waitFor();
      await page.waitForTimeout(150); const b = await tip.boundingBox();
      await page.screenshot({ path: evidence + '/edge-help.png' });
      check(b.x >= 0 && b.y >= 0 && b.x + b.width <= 375 && b.y + b.height <= 320, 'long help exceeds viewport: ' + JSON.stringify(b));
      check(await tip.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0; }), 'overflowing help cannot scroll');
      await tip.focus(); check(await tip.isVisible(), 'focusing help content dismissed it');
      await page.keyboard.press('Escape');
      await tip.waitFor({ state: 'hidden' });
      check(await tip.count() === 0, 'help Escape failed');
    } finally { await page.evaluate(() => window.__cleanupPopupFixture?.()); }
  });
  await test('pending-form-save-cannot-dismiss-or-leak-focus', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    let release; const pending = new Promise(r => release = r);
    await page.route('**/api/mail-request-config', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await pending; return route.fulfill({ json: {} });
    });
    const button = regionConfig('邮件接码请求配置'); await button.click();
    const modal = page.getByRole('dialog', { name: '邮件 API 请求配置', exact: true });
    try {
      await modal.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.keyboard.press('Escape'); check(await modal.isVisible(), 'Escape discarded a pending save');
      check(await modal.locator('.dialog-header .icon-button').isDisabled(), 'close enabled during save');
      await page.mouse.click(2, 2); check(await modal.isVisible(), 'backdrop discarded a pending save');
      await page.keyboard.press('Tab'); check(await modal.evaluate(el => el.contains(document.activeElement)), 'pending form leaked focus');
      release(); await modal.waitFor({ state: 'hidden' });
      check(await button.evaluate(el => document.activeElement === el), 'pending save lost opener focus');
    } finally { release(); await page.unroute('**/api/mail-request-config'); }
  });
  await test('no-popup-runtime-errors', async () => check(!errors.length, errors.join('; ')));
  return { passed: results.filter(r => r.passed).length, total: results.length, results, metrics: { dialogTypes: cases.length, selectFirstOpens: selectChecks, helpFirstOpens: helpChecks } };
}
