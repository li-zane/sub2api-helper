async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], consoleIssues = [], writes = [], reads = [], deletes = [], statusWrites = [], policyWrites = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (['error', 'warning'].includes(m.type()) && !/Failed to load resource:.*status of (409|502)/.test(m.text())) consoleIssues.push(m.text());
  });
  const nodes = [
    { id: 7, name: 'HTTP node', protocol: 'http', host: 'one.test', port: 8080, ipAddress: '203.0.113.7', username: 'saved-user', hasPassword: true, accountCount: 3 },
    { id: 8, name: 'SOCKS node', protocol: 'socks5h', host: 'two.test', port: 1080, ipAddress: '203.0.113.7', username: '', hasPassword: false, accountCount: 3 },
    { id: 9, name: 'Solo node', protocol: 'https', host: 'solo.test', port: 8443, ipAddress: '203.0.113.9', username: '', hasPassword: false, accountCount: 0 },
  ];
  nodes.forEach(node => { node.status = 'active'; node.allocationPaused = false; node.ipCostCny = 3.8; });
  nodes[0].iproyal = { status: 'matched', order: '987', gb_balance: 0, at: Date.now(),
    expiresAt: new Date(Date.now() + 49 * 3600000).toISOString() };
  for (const node of nodes.slice(0, 2)) Object.assign(node, { historicalAccountCount: 7, lastRequestAt: '2026-11-21T02:15:00.000Z' });
  let patrolEnabled = false, rejectPolicy = false;
  const patrolSettings = { enabled: false, intervalMinutes: 5, autoPause: false, thresholdGbPerIp: 10, syncCost: false, usdToCny: null };
  const settingsWrites = [];
  await page.route('**/api/iproyal/patrol', route => {
    if (route.request().method() === 'PUT') { const patch = route.request().postDataJSON(); settingsWrites.push(patch); Object.assign(patrolSettings, patch); patrolEnabled = patrolSettings.enabled; }
    return route.fulfill({ json: { ...patrolSettings, running: false, message: '' } });
  });
  await page.route('**/api/iproyal/test-connection', route =>
    route.fulfill({ json: { ipCount: 3, orderCount: 2, bandwidthChecked: true } }));
  let reject = false, failRead = false, rejectDelete = false, rejectStatus = false;
  const revision = (id, status = 'active') => String(id).repeat(63).slice(0, 63) + (status === 'active' ? 'a' : 'b');
  await page.route(/\/api\/sub2api\/(?:settings|monitor)$/, route => route.fulfill({ json: {
    configured: true, enabled: false, hasAdminApiKey: true, config: { baseUrl: 'https://pool.example.test' },
    profiles: [{ id: 'default', name: 'Default' }], activeProfileId: 'default',
  } }));
  await page.route('**/api/account-proxy-settings', route => route.fulfill({ json: { settings: { mode: 'sub2api', proxyUrl: '', allowDirectFallback: false } } }));
  await page.route('**/api/direct-ip', route => route.fulfill({ json: { ip: '198.51.100.1' } }));
  await page.route('**/api/sub2api/options', route => {
    const { includeInactiveProxies } = route.request().postDataJSON();
    const proxies = nodes.filter(node => includeInactiveProxies || node.status === 'active');
    return route.fulfill({ json: { proxies: proxies.map(({ username, hasPassword, ...node }) => node), groups: [], directAccountCount: 1 } });
  });
  await page.route(/\/api\/sub2api\/proxies\/\d+\/allocation$/, async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    const node = nodes.find(n => n.id === id), patch = route.request().postDataJSON();
    policyWrites.push({ id, patch });
    await new Promise(resolve => setTimeout(resolve, 200));
    if (rejectPolicy) return route.fulfill({ status: 502, json: { error: '分配成本保存失败' } });
    if (Object.hasOwn(patch, 'ipCostCny')) nodes.filter(n => n.ipAddress === node.ipAddress).forEach(n => { n.ipCostCny = Number(patch.ipCostCny); });
    if (Object.hasOwn(patch, 'allocationPaused')) node.allocationPaused = patch.allocationPaused;
    return route.fulfill({ json: { ip: node.ipAddress, ipCostCny: node.ipCostCny, ipAddedAt: null, allocationPaused: node.allocationPaused } });
  });
  await page.route(/\/api\/sub2api\/proxies\/\d+$/, async route => {
    const request = route.request(), id = Number(new URL(request.url()).pathname.split('/').at(-1));
    check(Boolean(request.headers()['x-console-token']), 'editor request has no console authentication');
    const node = nodes.find(node => node.id === id);
    if (request.method() === 'GET') {
      reads.push(id);
      if (failRead) return route.fulfill({ status: 502, json: { error: 'fixture read unavailable' } });
      return route.fulfill({ json: { proxy: node, revision: revision(id, node.status) } });
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      statusWrites.push({ id, body });
      await new Promise(resolve => setTimeout(resolve, 400));
      check(body.revision === revision(id, node.status), 'status edit used a stale revision');
      if (rejectStatus) return route.fulfill({ status: 502, json: { error: '代理状态保存失败，请重试' } });
      node.status = body.status;
      return route.fulfill({ json: { proxy: node, revision: revision(id, node.status) } });
    }
    if (request.method() === 'DELETE') {
      deletes.push({ id, body: request.postDataJSON() });
      await new Promise(resolve => setTimeout(resolve, 400));
      if (rejectDelete) return route.fulfill({ status: 409, json: { error: '号池仍有账号使用此代理，请先更换绑定' } });
      nodes.splice(nodes.indexOf(node), 1);
      return route.fulfill({ json: { deleted: true, id } });
    }
    check(request.method() === 'PUT', 'editor used an unexpected HTTP method');
    const body = request.postDataJSON(); writes.push({ id, body });
    await new Promise(resolve => setTimeout(resolve, 400));
    if (reject) return route.fulfill({ status: 409, json: { error: '代理配置已变化，请重新读取后再修改' } });
    const { password, revision: ignored, ...fields } = body;
    Object.assign(node, fields); if (password !== undefined) node.hasPassword = Boolean(password);
    return route.fulfill({ json: { proxy: node, revision: revision(id) } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload();
  await page.locator('tbody .job-row').first().waitFor();
  await page.getByRole('region', { name: '代理 IP 配置', exact: true }).getByRole('button', { name: '配置', exact: true }).click();
  const parent = page.getByRole('dialog', { name: '代理 IP 配置与检测', exact: true });
  await test('IPRoyal connection check, patrol switch and zero balance', async () => {
    const section = parent.getByRole('region', { name: 'IPRoyal 巡检', exact: true });
    await section.getByRole('button', { name: '测试连接' }).click();
    await section.getByText(/已验证余额读取/).waitFor();
    const toggle = section.getByRole('switch', { name: 'IPRoyal 巡检', exact: true });
    await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/iproyal/patrol') && r.request().method() === 'PUT'), toggle.check()]);
    check(patrolEnabled, 'patrol was not enabled');
    await section.getByRole('button', { name: '立即巡检' }).click();
    await toggle.uncheck();
    await parent.getByText(/剩余 0\.00 GB/).waitFor();
    await parent.getByText(/有效期剩余 2 天/).waitFor();
    await parent.getByText('历史绑定 7 个账号', { exact: true }).waitFor();
    check(await parent.locator('time[datetime="2026-11-21T02:15:00.000Z"]').count() === 1, 'shared exit should display one request timestamp');
    await page.screenshot({ path: evidence + '/iproyal-patrol.png' });
  });
  await test('patrol settings save interval, order threshold and exchange rate while preserving dirty draft', async () => {
    const section = parent.getByRole('region', { name: 'IPRoyal 巡检', exact: true });
    await section.getByLabel('巡检间隔（分钟）', { exact: true }).fill('13');
    await section.getByRole('switch', { name: '流量达到阈值时暂停新分配', exact: true }).check();
    await section.getByLabel('单 IP 剩余流量阈值（GB）', { exact: true }).fill('12');
    await section.getByRole('switch', { name: '巡检同步 IP 成本', exact: true }).check();
    await section.getByLabel('美元兑人民币汇率', { exact: true }).fill('7.2');
    await page.waitForResponse(r => r.url().endsWith('/api/iproyal/patrol') && r.request().method() === 'GET', { timeout: 13000 });
    check(await section.getByLabel('巡检间隔（分钟）', { exact: true }).inputValue() === '13', 'poll erased unsaved settings');
    await section.getByRole('button', { name: '保存巡检设置', exact: true }).click();
    await section.getByText('巡检已关闭', { exact: true }).waitFor();
    check(patrolSettings.intervalMinutes === 13 && patrolSettings.autoPause && patrolSettings.thresholdGbPerIp === 12 && patrolSettings.syncCost && patrolSettings.usdToCny === 7.2, 'settings fields lost');
    check(await section.getByRole('button', { name: '保存巡检设置', exact: true }).isDisabled(), 'saved settings remain dirty');
    await page.screenshot({ path: evidence + '/iproyal-settings-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    await section.getByLabel('巡检间隔（分钟）', { exact: true }).scrollIntoViewIfNeeded();
    check(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile settings overflow horizontally');
    await page.screenshot({ path: evidence + '/iproyal-settings-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await test('per-IP usage cooldown settings persist and individual cooldown renders independently', async () => {
    const section = parent.getByRole('region', { name: 'IPRoyal 巡检', exact: true });
    await section.getByRole('switch', { name: '单 IP 新增用量超限时冷却', exact: true }).check();
    await section.getByRole('combobox', { name: '单 IP 用量阈值单位', exact: true }).click();
    await section.getByRole('option', { name: 'GB（1000 MB）', exact: true }).click();
    await section.getByLabel('新增用量阈值', { exact: true }).fill('50');
    await section.getByLabel('用量冷却时间（分钟）', { exact: true }).fill('30');
    await section.getByRole('button', { name: '保存巡检设置', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.iproyal-settings-actions button:not(:disabled)'));
    check(patrolSettings.usageCooldownEnabled && patrolSettings.usageUnit === 'GB' && patrolSettings.usageThreshold === 50 && patrolSettings.usageCooldownMinutes === 30, 'cooldown settings lost');
    await page.setViewportSize({ width: 375, height: 812 });
    await section.getByLabel('新增用量阈值', { exact: true }).scrollIntoViewIfNeeded();
    check(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'cooldown form overflow');
    await page.screenshot({ path: evidence + '/iproyal-usage-settings-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await section.getByLabel('新增用量阈值', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: evidence + '/iproyal-usage-settings-desktop.png' });
    const card = parent.locator('.proxy-management-card').filter({ has: page.getByRole('button', { name: '编辑代理 203.0.113.7', exact: true }) });
    const record = { ...nodes[0].iproyal, autoAllocationPaused: true, usageCooldownPaused: true,
      ipUsage: { deltaMb: 51000, triggerMb: 51000, at: Date.now(), since: Date.now() - 300000, cooldownUntil: Date.now() + 1800000 } };
    for (const node of nodes.slice(0, 2)) node.iproyal = structuredClone(record);
    await parent.getByRole('button', { name: '读取代理', exact: true }).click();
    await card.getByText(/单 IP 新增上报：51000.00 MB/).waitFor();
    check(await card.getByRole('switch', { name: '参与分配 · HTTP node · #7', exact: true }).isDisabled(), 'cooled IP remains selectable');
    check(await card.getByRole('switch', { name: '参与分配 · SOCKS node · #8', exact: true }).isDisabled(), 'protocol alias did not cool down');
    check(await parent.getByRole('switch', { name: '参与分配 · Solo node · #9', exact: true }).isEnabled(), 'cooldown leaked to other IP');
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + '/iproyal-usage-cooldown-desktop.png' });
    for (const node of nodes.slice(0, 2)) { node.iproyal.autoAllocationPaused = false; node.iproyal.usageCooldownPaused = false; node.iproyal.ipUsage.cooldownUntil = null; }
    await parent.getByRole('button', { name: '读取代理', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="参与分配 · HTTP node · #7"]')?.disabled);
  });
  await test('allocation and shared IP cost edit inline, failure keeps draft and controls remain independent', async () => {
    const card = parent.locator('.proxy-management-card').filter({ has: page.getByRole('button', { name: '编辑代理 203.0.113.7', exact: true }) });
    const toggle = card.getByRole('switch', { name: '参与分配 · HTTP node · #7', exact: true });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="参与分配 · HTTP node · #7"]')?.getAttribute('aria-checked') === 'false');
    const cost = card.getByLabel('IP 成本（元）· 203.0.113.7', { exact: true });
    check(await card.getByRole('dialog').count() === 0, 'policy editor opened a dialog');
    check(await card.locator('input[type="number"]').count() === 1, 'duplicate costs for shared IP');
    await cost.fill('5.25'); rejectPolicy = true;
    await card.getByRole('button', { name: '保存成本', exact: true }).click();
    await card.getByRole('alert').getByText('分配成本保存失败', { exact: true }).waitFor();
    check(await cost.inputValue() === '5.25', 'failure erased cost draft');
    rejectPolicy = false; await card.getByRole('button', { name: '保存成本', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.proxy-cost-control button')?.disabled && !document.querySelector('.proxy-cost-control input')?.disabled);
    check(nodes[0].allocationPaused && nodes[1].ipCostCny === 5.25 && !nodes[1].allocationPaused, 'cost or node pause leaked across policies');
    check(Object.keys(policyWrites.at(-1).patch).join() === 'ipCostCny', 'cost save overwrote manual policy');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="参与分配 · HTTP node · #7"]')?.getAttribute('aria-checked') === 'true');
    nodes[0].iproyal = { ...nodes[0].iproyal, autoAllocationPaused: true, thresholdGb: 50, ipCount: 5, costSyncEnabled: true, cost: { usdPerIp: 2.43, days: 30 } };
    await parent.getByRole('button', { name: '读取代理', exact: true }).click();
    await card.getByText('自动暂停分配', { exact: false }).waitFor();
    check(await toggle.isDisabled() && await cost.isDisabled(), 'automatic controls are editable');
    check(await card.getByRole('switch', { name: /^代理启用状态 · HTTP node/ }).isEnabled(), 'allocation gate changed node enablement');
    nodes[0].iproyal.autoAllocationPaused = false; nodes[0].iproyal.costSyncEnabled = false;
    await parent.getByRole('button', { name: '读取代理', exact: true }).click();
    await toggle.waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="参与分配 · HTTP node · #7"]')?.disabled);
    check(await cost.inputValue() === '5.25', 'refresh lost confirmed cost');
  });
  const ip = parent.getByRole('button', { name: '编辑代理 203.0.113.7', exact: true });
  const dialog = page.getByRole('dialog', { name: '编辑代理', exact: true });
  await test('click-ip-opens-editor-and-loads-current-connection-without-password', async () => {
    check(await ip.count() === 1, 'shared exit IP was duplicated'); await ip.click();
    await dialog.getByLabel('代理名称 *', { exact: true }).waitFor();
    check(await dialog.getByLabel('代理名称 *', { exact: true }).inputValue() === 'HTTP node', 'current name missing');
    check(await dialog.getByLabel('用户名（可选）', { exact: true }).inputValue() === 'saved-user', 'username missing');
    check(await dialog.getByLabel('密码（可选）', { exact: true }).inputValue() === '', 'saved password was revealed');
    check((await dialog.getByLabel('密码（可选）', { exact: true }).getAttribute('placeholder')).includes('留空保留'), 'password retention hint missing');
    await page.screenshot({ path: evidence + '/proxy-edit-desktop.png' });
  });
  await test('shared-ip-selector-loads-the-correct-node', async () => {
    await dialog.getByRole('combobox', { name: '选择代理节点', exact: true }).click();
    await page.getByRole('option', { name: /SOCKS node/ }).click();
    await page.waitForFunction(() => document.querySelector('.proxy-edit-dialog input')?.value === 'SOCKS node');
    check(reads.at(-1) === 8, 'wrong node ID was requested');
    check(await dialog.getByLabel('端口 *', { exact: true }).inputValue() === '1080', 'node port was not updated');
    check(await dialog.getByLabel('清除已保存密码', { exact: true }).count() === 0, 'password state leaked from previous node');
  });
  await test('invalid-input-does-not-submit-and-server-error-keeps-draft', async () => {
    await dialog.getByLabel('端口 *', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    check(await dialog.getByRole('alert').isVisible(), 'invalid port was not validated'); check(writes.length === 0, 'invalid draft reached the API');
    await dialog.getByLabel('端口 *', { exact: true }).fill('1081');
    await dialog.getByLabel('代理名称 *', { exact: true }).fill('Draft retained'); reject = true;
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await dialog.getByText('代理配置已变化，请重新读取后再修改', { exact: true }).waitFor();
    check(await dialog.getByLabel('代理名称 *', { exact: true }).inputValue() === 'Draft retained', 'failed save erased the draft');
    check(writes.length === 1 && writes[0].id === 8, 'failed save was replayed or targeted the wrong node');
    reject = false; await dialog.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.proxy-edit-dialog input')?.value === 'SOCKS node');
  });
  await test('save-name-and-connection-once-busy-dialog-stays-open-and-list-updates', async () => {
    await dialog.getByLabel('代理名称 *', { exact: true }).fill('Updated SOCKS');
    await dialog.getByLabel('主机地址 / IP *', { exact: true }).fill('updated.test');
    await dialog.getByLabel('端口 *', { exact: true }).fill('1082');
    await dialog.getByRole('combobox', { name: '选择协议', exact: true }).click(); await page.getByRole('option', { name: 'HTTPS', exact: true }).click();
    const done = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/proxies/8'));
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click(); await page.keyboard.press('Escape');
    check(await dialog.isVisible(), 'busy dialog closed'); check(await dialog.getByRole('button', { name: '关闭编辑代理', exact: true }).isDisabled(), 'busy close button remained enabled');
    await done; await dialog.waitFor({ state: 'hidden' });
    check(writes.length === 2 && writes[1].id === 8, 'save was duplicated or wrong node changed');
    check(writes[1].body.name === 'Updated SOCKS' && writes[1].body.host === 'updated.test' && writes[1].body.port === 1082 && writes[1].body.protocol === 'https', 'connection fields lost');
    check(!Object.hasOwn(writes[1].body, 'password'), 'blank password was sent as a reset');
    await parent.getByLabel('代理 IP 账号分配').getByText('Updated SOCKS', { exact: true }).waitFor();
    check(nodes[0].name === 'HTTP node', 'editing another node renamed the first node');
  });
  await test('password-can-be-explicitly-cleared', async () => {
    await ip.click(); await dialog.getByLabel('清除已保存密码', { exact: true }).waitFor();
    await dialog.getByLabel('清除已保存密码', { exact: true }).check();
    check(await dialog.getByLabel('密码（可选）', { exact: true }).isDisabled(), 'clear-password checkbox did not disable password input');
    await dialog.getByLabel('用户名（可选）', { exact: true }).fill('');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    check(writes.at(-1).id === 7 && writes.at(-1).body.password === '', 'explicit password clear was lost');
  });
  await test('list switches one shared-IP node in place and preserves its previous state on failure', async () => {
    const card = parent.locator('.proxy-management-card').filter({ has: page.getByRole('button', { name: '编辑代理 203.0.113.7', exact: true }) });
    const toggle = card.getByRole('switch', { name: /^代理启用状态 · Updated SOCKS/ });
    const sibling = card.getByRole('switch', { name: /^代理启用状态 · HTTP node/ });
    check(await card.getByRole('switch', { name: /^代理启用状态/ }).count() === 2, 'shared IP does not have independent node switches');
    await card.getByText('全部启用', { exact: true }).waitFor();
    check(await toggle.getAttribute('aria-checked') === 'true', 'active node switch starts unchecked');
    rejectStatus = true;
    await toggle.press('Space');
    await card.locator('[role="switch"][aria-busy="true"]').waitFor();
    await toggle.press('Enter'); // Must not replay while pending.
    check(await toggle.isDisabled() && await sibling.isEnabled(), 'pending status should lock only the selected switch');
    await card.getByRole('alert').getByText('代理状态保存失败，请重试').waitFor();
    check(await toggle.getAttribute('aria-checked') === 'true', 'failed save changed the displayed state');
    check(statusWrites.length === 1, 'pending switch replayed a write');
    rejectStatus = false;
    await toggle.click();
    await card.getByText('1/2 启用', { exact: true }).waitFor();
    check(await toggle.getAttribute('aria-checked') === 'false', 'confirmed disable did not update the switch');
    check(await sibling.getAttribute('aria-checked') === 'true', 'switch changed a sibling node');
    check(await card.getByRole('alert').count() === 0, 'retry did not clear the inline error');
    check((await card.locator('.segment-count-pill').innerText()) === '3 个 OAuth 账号', 'toggle changed the binding count');
    check(await dialog.count() === 0, 'toggling from management opened the editor');
    await page.locator('.toast-dismiss').evaluateAll(buttons => buttons.forEach(button => button.click()));
    await page.locator('.toast-dismiss').first().waitFor({ state: 'hidden' });
    await page.screenshot({ path: evidence + '/proxy-management-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await toggle.boundingBox();
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.height >= 44, 'mobile switch is clipped or too small');
    check(await parent.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile proxy manager overflows horizontally');
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: evidence + '/proxy-management-mobile.png' });
    await toggle.press('Enter');
    await card.getByText('全部启用', { exact: true }).waitFor();
    check(await toggle.getAttribute('aria-checked') === 'true', 'keyboard re-enable did not restore the node');
    check(await parent.locator('.proxy-segment-bar.unassigned').getByRole('switch').count() === 0, 'direct connection has an unexpected switch');
    await page.setViewportSize({ width: 1440, height: 1000 });
    check(JSON.stringify(statusWrites) === JSON.stringify([
      { id: 8, body: { status: 'inactive', revision: revision(8) } },
      { id: 8, body: { status: 'inactive', revision: revision(8) } },
      { id: 8, body: { status: 'active', revision: revision(8, 'inactive') } },
    ]), 'status writes were duplicated or included connection fields');
  });
  await test('single-node-mobile-dark-layout-and-keyboard-dismissal', async () => {
    await parent.getByRole('button', { name: '编辑代理 203.0.113.9', exact: true }).click();
    await dialog.getByLabel('代理名称 *', { exact: true }).waitFor();
    check(await dialog.getByRole('combobox', { name: '选择代理节点', exact: true }).count() === 0, 'single node has an unnecessary selector');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: evidence + '/proxy-edit-dark-system.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    const bounds = await dialog.boundingBox(); check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.y >= 0 && bounds.y + bounds.height <= 812, 'mobile dialog leaves viewport');
    check(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'mobile dialog overflows horizontally');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).scrollIntoViewIfNeeded();
    check(await dialog.getByRole('button', { name: '保存修改', exact: true }).isVisible(), 'mobile cannot reach save button');
    await page.screenshot({ path: evidence + '/proxy-edit-mobile.png' });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); check(await parent.isVisible(), 'parent dialog was closed');
  });
  await test('read-error-can-retry-and-runtime-remains-healthy', async () => {
    failRead = true; await ip.click(); await dialog.getByText('fixture read unavailable', { exact: true }).waitFor();
    check(await dialog.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), 'save enabled after a failed read');
    failRead = false; await dialog.getByRole('button', { name: '重新读取', exact: true }).click(); await dialog.getByLabel('代理名称 *', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    check(await ip.evaluate(el => el === document.activeElement), 'focus was not restored to clicked IP');
    check((await page.title()).includes('Helper'), 'wrong page identity'); check(await page.locator('tbody .job-row').count() > 0, 'main content is blank');
    check(await page.locator('vite-error-overlay').count() === 0, 'framework error overlay'); check(errors.length === 0, errors.join('; '));
  });
  await test('delete-confirms-selected-node-and-preserves-its-ip-siblings', async () => {
    const confirm = page.getByRole('dialog', { name: '删除代理', exact: true });
    await ip.click();
    await dialog.getByRole('combobox', { name: '选择代理节点' }).click();
    await page.getByRole('option', { name: /Updated SOCKS/ }).click();
    await page.waitForFunction(() => document.querySelector('.proxy-edit-dialog input')?.value === 'Updated SOCKS');
    const remove = dialog.getByRole('button', { name: '删除代理', exact: true });
    await remove.click();
    await confirm.getByText('Updated SOCKS', { exact: true }).waitFor();
    const cancel = confirm.getByRole('button', { name: '取消', exact: true });
    check(await cancel.evaluate(el => el === document.activeElement), 'cancel did not receive initial focus');
    const bounds = await confirm.boundingBox();
    check(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375, 'mobile confirmation exceeds viewport');
    await page.screenshot({ path: evidence + '/proxy-delete-mobile.png' });
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'hidden' });
    check(deletes.length === 0 && await dialog.isVisible(), 'cancel sent a DELETE or closed the editor');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await remove.click();
    rejectDelete = true;
    await confirm.getByRole('button', { name: '确认删除' }).click();
    await confirm.getByRole('alert').getByText('号池仍有账号使用此代理，请先更换绑定').waitFor();
    check(nodes.length === 3, 'failed deletion removed an entry');
    rejectDelete = false;
    await page.screenshot({ path: evidence + '/proxy-delete-desktop.png' });
    await confirm.getByRole('button', { name: '确认删除' }).click();
    await page.keyboard.press('Escape');
    check(await confirm.getByRole('button', { name: '删除中…' }).isDisabled(), 'pending delete can be repeated');
    await dialog.waitFor({ state: 'hidden' });
    await ip.waitFor();
    await parent.getByLabel('代理 IP 账号分配').getByText('HTTP node', { exact: true }).waitFor();
    check(!nodes.some(node => node.id === 8), 'selected node remained');
    check(deletes.length === 2 && deletes.every(({ id, body }) => id === 8 && body.revision === revision(8)),
      'delete targeted the wrong node or skipped version checking');
    check(await parent.getByText('Updated SOCKS', { exact: true }).count() === 0, 'deleted node is still rendered');
    check(errors.length === 0, errors.join('; '));
    check(consoleIssues.length === 0, consoleIssues.join('; '));
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results,
    metrics: { url: page.url(), title: await page.title(), viewports: ['1440x1000', '375x812'], pageErrors: errors.length, consoleIssues,
      browser: 'Browser plugin not available; repository Playwright CLI' } };
}
