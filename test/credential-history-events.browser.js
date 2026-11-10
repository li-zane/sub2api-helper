async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], details = [], writes = [];
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); await page.screenshot({ path: evidence + '/' + name + '-failed.png' }).catch(() => {}); } };
  page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
  const entries = [
    { id: 'totp-old', type: '2fa', stage: 'historical', compact: true, label: '2FA · 历史密钥', at: '2026-10-01T00:00:00Z' },
    { id: 'current-2fa', type: '2fa', stage: 'current', compact: true, label: '2FA · 当前本地密钥', at: '2026-11-09T00:00:00Z' },
    { id: 'space-initial', type: 'workspaces', stage: 'discovered', at: '2026-11-08T00:00:00Z' },
    { id: 'space-changed', type: 'workspaces', stage: 'changed', at: '2026-11-10T00:00:00Z' },
    { id: 'phone-ok', type: 'phone', stage: 'verified', at: '2026-11-10T01:00:00Z' },
    { id: 'totp-candidate', type: '2fa', stage: 'candidate_failed', compact: true, label: '2FA · 候选密钥 · 未完成', at: '2026-11-10T02:00:00Z' },
  ];
  const contents = {
    'phone-ok': { after: { phone: '+12025550111', countryName: 'USA', cost: { amount: '0.35', currency: 'USD' } } },
    'space-changed': { changes: { updated: [{ before: { planType: 'business_premium' }, after: { planType: 'free', deactivated: true, availabilityCode: 'deactivated_workspace' } }] } },
    'space-initial': { after: { workspaces: [{ id: 'personal', name: '个人账户' }] } },
    'current-2fa': { after: { totpSecret: 'FIXTURE_CURRENT_KEY', localRecord: true, remoteEnabled: null }, records: [{ stage: 'activated' }, { stage: 'confirmed' }] },
    'totp-old': { after: { totpSecret: 'FIXTURE_HISTORICAL_KEY' } },
    'totp-candidate': { after: { totpSecret: 'FIXTURE_CANDIDATE_KEY', localRecord: false }, note: '候选不代表生效' },
  };
  await page.route('**/api/jobs/*/logs?*', async route => {
    const url = new URL(route.request().url()), id = url.searchParams.get('entry'), view = url.searchParams.get('view');
    if (id) details.push(id);
    await route.fulfill({ json: { view, entries: view === 'credentials' ? entries : [], selectedId: id, content: id ? JSON.stringify(contents[id], null, 2) : '', retention: '同一 2FA 密钥合并展示；原始记录完整保留' } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('tr.job-row').first().getByRole('button', { name: '查看协议日志', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号日志与凭据', exact: true });
  await dialog.getByRole('tab', { name: '凭据历史', exact: true }).click();
  const group = type => dialog.locator(`[data-credential-type="${type}"]`), entry = id => dialog.locator(`[data-entry-id="${id}"]`);
  await group('phone').waitFor();
  await test('new-categories-are-grouped-collapsed-and-lazy', async () => {
    check(await dialog.locator('.account-credential-group').count() === 3, 'credential category missing');
    check((await group('phone').innerText()).includes('接码手机号 · 已验证'), 'accepted phone label missing');
    check((await group('workspaces').innerText()).includes('工作空间 · 空间变化'), 'workspace label missing');
    check(await dialog.locator('.account-credential-version').count() === 0, 'history starts expanded');
    check(details.length === 0, 'private details were prefetched');
  });
  await test('workspace-changes-and-successful-phone-details', async () => {
    await entry('phone-ok').click(); await dialog.locator('pre').filter({ hasText: '+12025550111' }).waitFor();
    check((await dialog.locator('pre').innerText()).includes('USD'), 'actual cost currency missing');
    await entry('space-changed').click(); await dialog.locator('pre').filter({ hasText: 'deactivated_workspace' }).waitFor();
    check((await dialog.locator('pre').innerText()).includes('business_premium'), 'previous workspace state missing');
    await group('workspaces').locator('.account-credential-toggle').click();
    await entry('space-initial').click(); await dialog.locator('pre').filter({ hasText: '个人账户' }).waitFor();
  });
  await test('totp-version-status-and-original-key-remain-accessible', async () => {
    check((await entry('totp-candidate').innerText()).includes('候选密钥 · 未完成'), 'candidate falsely presented as effective');
    await group('2fa').locator('.account-credential-toggle').click();
    check(await group('2fa').locator('.account-credential-version').count() === 2, 'version grouping count wrong');
    await entry('current-2fa').click(); await dialog.locator('pre').filter({ hasText: 'FIXTURE_CURRENT_KEY' }).waitFor();
    check((await entry('current-2fa').innerText()).includes('当前本地密钥'), 'local state confused with remote confirmation');
    await entry('totp-old').click(); await dialog.locator('pre').filter({ hasText: 'FIXTURE_HISTORICAL_KEY' }).waitFor();
    await dialog.screenshot({ path: evidence + '/history-desktop.png' });
  });
  await test('mobile-layout-and-copy-stay-usable', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await entry('phone-ok').scrollIntoViewIfNeeded(); await entry('phone-ok').click(); await dialog.locator('pre').filter({ hasText: '+12025550111' }).waitFor();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__historyCopy = text; } } }); });
    await dialog.getByRole('button', { name: '复制内容', exact: true }).click();
    check((await page.evaluate(() => window.__historyCopy)).includes('+12025550111'), 'phone detail copy failed');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page overflows');
    await dialog.screenshot({ path: evidence + '/history-mobile.png' });
  });
  await test('history-reads-do-not-write-or-throw', async () => { check(writes.length === 0, 'read UI mutated an account'); check(errors.length === 0, errors.join('; ')); });
  await dialog.getByRole('button', { name: '关闭协议日志', exact: true }).click();
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
