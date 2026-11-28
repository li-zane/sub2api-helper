async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], checks = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (['error','warning'].includes(m.type()) && !/status of 502/.test(m.text())) errors.push(m.text()); });
  const report = (city, ip) => ({ checkedAt: '2026-11-28T01:00:00Z', status: 'ok', stable: true, sessionRotation: 'fixed', successCount: 2, sampleCount: 2,
    latencyMs: 23, chatgpt: { status: 'ok', latencyMs: 51, httpStatus: 200 }, exits: [{ ip, city, region: 'Washington', country: 'United States', countryCode: 'US', riskScore: 7, riskLevel: 'low' }] });
  const nodes = [
    { id: 7, name: 'Seattle HTTP', protocol: 'http', host: 'one.test', port: 8080, ipAddress: '203.0.113.7', city: 'Seattle', quality: report('Seattle','203.0.113.7') },
    { id: 8, name: 'Seattle SOCKS', protocol: 'socks5', host: 'two.test', port: 1080, ipAddress: '203.0.113.7' },
    { id: 9, name: 'Tokyo node', protocol: 'https', host: 'three.test', port: 8443, ipAddress: '203.0.113.9', city: 'Tokyo', quality: report('Tokyo','203.0.113.9') },
  ].map(node => ({ ...node, status: 'active', availableForBinding: true, accountCount: 1, historicalAccountCount: 4, lastRequestAt: '2026-11-28T00:30:00Z', ipCostCny: 3.5 }));
  await page.route(/\/api\/sub2api\/(?:settings|monitor)$/, route => route.fulfill({ json: { configured: true, enabled: false, hasAdminApiKey: true,
    config: { baseUrl: 'https://pool.example.test' }, profiles: [{ id: 'default', name: 'Default' }], activeProfileId: 'default' } }));
  await page.route('**/api/account-proxy-settings', route => route.fulfill({ json: { settings: { mode: 'sub2api', proxyUrl: '', allowDirectFallback: false } } }));
  await page.route('**/api/sub2api/options', route => route.fulfill({ json: { proxies: nodes, groups: [], directAccountCount: 1 } }));
  await page.route('**/api/direct-ip', route => route.fulfill({ json: { ip: '192.0.2.1' } }));
  await page.route('**/api/iproyal/patrol', route => route.fulfill({ json: { enabled: false, intervalMinutes: 5, running: false } }));
  let fail = false;
  await page.route('**/api/proxy-quality/check', async route => {
    check(Boolean(route.request().headers()['x-console-token']), 'missing authentication');
    const target = route.request().postDataJSON(); checks.push(target);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (fail) return route.fulfill({ status: 502, json: { error: '检测服务暂时不可用' } });
    const node = nodes.find(node => node.id === target.proxyId);
    node.quality = report('Seattle', node.ipAddress); node.city = 'Seattle';
    return route.fulfill({ json: { result: node.quality } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
  const open = async () => { await page.getByRole('region', { name: '代理 IP 配置', exact: true }).getByRole('button', { name: '配置', exact: true }).click(); };
  const dialog = page.getByRole('dialog', { name: '代理 IP 配置与检测', exact: true });
  const card = dialog.locator('.proxy-management-card').filter({ has: page.getByRole('button', { name: '编辑代理 203.0.113.7', exact: true }) });
  await open();
  await test('available-IP-count-deduplicates-and-excludes-cooldown-or-paused-nodes', async () => {
    const summary = page.getByRole('region', { name: '代理 IP 配置', exact: true }).getByLabel('可分配代理 IP 数量', { exact: true });
    const count = dialog.getByLabel('可分配代理 IP 数量', { exact: true });
    const refresh = () => dialog.getByRole('button', { name: '读取代理', exact: true }).click();
    const expectCount = async value => { await page.waitForFunction(value => [...document.querySelectorAll('[aria-label="可分配代理 IP 数量"]')].every(el => el.textContent === `可分配 ${value} 个 IP`), value); };
    await expectCount(2); check(await summary.innerText() === '可分配 2 个 IP', 'summary missing or aliases counted twice');
    await dialog.getByRole('searchbox', { name: '搜索代理列表' }).fill('Tokyo');
    check(await count.innerText() === '可分配 2 个 IP', 'search changed overall count');
    await dialog.getByRole('searchbox', { name: '搜索代理列表' }).fill('');
    const saved = nodes.map(node => structuredClone(node));
    try {
      nodes[0].allocationPaused = true; nodes[0].availableForBinding = false;
      await refresh(); await expectCount(2); // The same exit still has an eligible SOCKS node.
      nodes[1].iproyal = { usageCooldownPaused: true, autoAllocationPaused: true }; nodes[1].availableForBinding = false;
      await refresh(); await expectCount(1);
      await count.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + '/available-ip-desktop.png' });
      await page.setViewportSize({ width: 375, height: 812 }); await count.scrollIntoViewIfNeeded();
      check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'count overflow on mobile');
      await page.screenshot({ path: evidence + '/available-ip-mobile.png' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      nodes[2].status = 'inactive'; await refresh(); await expectCount(0);
      nodes[2].status = 'active'; nodes[2].iproyal = { expiresAt: '2020-01-01T00:00:00Z' };
      await refresh(); await expectCount(0);
      nodes[2].iproyal = { autoAllocationPaused: true }; await refresh(); await expectCount(0);
      nodes.splice(0); await refresh(); await expectCount(0);
      nodes.push(...saved.map(node => structuredClone(node))); await refresh(); await expectCount(2);
    } finally { nodes.splice(0, nodes.length, ...saved); await refresh(); }
    await dialog.getByRole('button', { name: '关闭代理 IP 配置', exact: true }).click();
    await summary.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + '/available-ip-summary-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 }); await summary.scrollIntoViewIfNeeded();
    check(await page.getByRole('region', { name: '代理 IP 配置', exact: true }).evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'summary count overflows on mobile');
    await page.screenshot({ path: evidence + '/available-ip-summary-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 }); await open();
  });
  await test('saved-city-and-exit-details-live-inside-the-IP', async () => {
    await card.getByRole('button', { name: '查看 203.0.113.7 · Seattle HTTP 的代理出口', exact: true }).click();
    await card.getByText('United States · Washington · Seattle', { exact: true }).waitFor();
    check(checks.length === 0, 'viewing saved exit unexpectedly triggered a test');
    check(await dialog.locator('.proxy-quality-panel').count() === 0, 'duplicated node diagnostics panel');
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + '/proxy-diagnostics-desktop.png' });
  });
  await test('searches-IP-name-city-and-node-id', async () => {
    const search = dialog.getByRole('searchbox', { name: '搜索代理列表' });
    await search.fill('Tokyo'); check(await dialog.locator('.proxy-management-card').count() === 1, 'city filter');
    await search.fill('Seattle 8'); check(await dialog.locator('.proxy-management-card').count() === 1, 'name/id filter');
    await search.fill('not-found'); await dialog.getByText('没有匹配的代理').waitFor();
    await search.fill('203.0.113.7'); check(await dialog.locator('.proxy-management-card').count() === 1, 'IP filter'); await search.fill('');
  });
  await test('selects-exact-node-tests-once-and-restores-saved-result', async () => {
    await card.getByRole('combobox', { name: '检测节点 · 203.0.113.7', exact: true }).click();
    await card.getByRole('option', { name: /Seattle SOCKS/ }).click();
    await card.getByRole('button', { name: '检测 203.0.113.7 · Seattle SOCKS 的代理质量', exact: true }).click();
    await card.getByText('United States · Washington · Seattle', { exact: true }).waitFor();
    check(checks.length === 1 && checks[0].proxyId === 8, 'wrong or duplicate diagnostic request');
    await dialog.getByRole('button', { name: '关闭代理 IP 配置', exact: true }).click(); await open();
    await card.getByRole('combobox', { name: '检测节点 · 203.0.113.7', exact: true }).click();
    await card.getByRole('option', { name: /Seattle SOCKS/ }).click();
    await card.getByRole('button', { name: '查看 203.0.113.7 · Seattle SOCKS 的代理出口', exact: true }).click();
    await card.getByText('United States · Washington · Seattle', { exact: true }).waitFor();
    check(checks.length === 1, 'reopening triggers another check');
  });
  await test('failure-keeps-last-saved-result-visible', async () => {
    fail = true;
    await card.getByRole('button', { name: '检测 203.0.113.7 · Seattle SOCKS 的代理质量', exact: true }).click();
    await card.getByRole('alert').getByText('检测服务暂时不可用').waitFor();
    await card.getByText('United States · Washington · Seattle', { exact: true }).waitFor();
    fail = false;
  });
  await test('mobile-layout-controls-and-runtime-health', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await card.scrollIntoViewIfNeeded();
    check(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'card horizontal overflow');
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'dialog horizontal overflow');
    await page.screenshot({ path: evidence + '/proxy-diagnostics-mobile.png' });
    check((await page.title()).includes('Helper') && page.url().startsWith('http://127.0.0.1:'), 'page identity');
    check(await page.locator('vite-error-overlay').count() === 0 && errors.length === 0, errors.join('; ') || 'framework overlay');
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
