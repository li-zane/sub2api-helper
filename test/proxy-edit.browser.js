async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], writes = [], reads = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
  const nodes = [
    { id: 7, name: 'HTTP node', protocol: 'http', host: 'one.test', port: 8080, ipAddress: '203.0.113.7', username: 'saved-user', hasPassword: true, accountCount: 3 },
    { id: 8, name: 'SOCKS node', protocol: 'socks5h', host: 'two.test', port: 1080, ipAddress: '203.0.113.7', username: '', hasPassword: false, accountCount: 3 },
    { id: 9, name: 'Solo node', protocol: 'https', host: 'solo.test', port: 8443, ipAddress: '203.0.113.9', username: '', hasPassword: false, accountCount: 0 },
  ];
  let reject = false, failRead = false;
  const revision = id => String(id).repeat(64).slice(0, 64);
  await page.route(/\/api\/sub2api\/(?:settings|monitor)$/, route => route.fulfill({ json: {
    configured: true, enabled: false, hasAdminApiKey: true, config: { baseUrl: 'https://pool.example.test' },
    profiles: [{ id: 'default', name: 'Default' }], activeProfileId: 'default',
  } }));
  await page.route('**/api/account-proxy-settings', route => route.fulfill({ json: { settings: { mode: 'sub2api', proxyUrl: '', allowDirectFallback: false } } }));
  await page.route('**/api/sub2api/options', route => route.fulfill({ json: { proxies: nodes.map(({ username, hasPassword, ...node }) => node), groups: [], directAccountCount: 1 } }));
  await page.route(/\/api\/sub2api\/proxies\/\d+$/, async route => {
    const request = route.request(), id = Number(new URL(request.url()).pathname.split('/').at(-1));
    check(Boolean(request.headers()['x-console-token']), 'editor request has no console authentication');
    const node = nodes.find(node => node.id === id);
    if (request.method() === 'GET') {
      reads.push(id);
      if (failRead) return route.fulfill({ status: 502, json: { error: 'fixture read unavailable' } });
      return route.fulfill({ json: { proxy: node, revision: revision(id) } });
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
    await parent.getByText('HTTP node、Updated SOCKS', { exact: true }).first().waitFor();
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
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
