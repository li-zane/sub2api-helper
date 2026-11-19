async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], writes = [], reads = [], deletes = [], statusWrites = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => { try { await run(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
  const nodes = [
    { id: 7, name: 'HTTP node', protocol: 'http', host: 'one.test', port: 8080, ipAddress: '203.0.113.7', username: 'saved-user', hasPassword: true, accountCount: 3 },
    { id: 8, name: 'SOCKS node', protocol: 'socks5h', host: 'two.test', port: 1080, ipAddress: '203.0.113.7', username: '', hasPassword: false, accountCount: 3 },
    { id: 9, name: 'Solo node', protocol: 'https', host: 'solo.test', port: 8443, ipAddress: '203.0.113.9', username: '', hasPassword: false, accountCount: 0 },
  ];
  nodes.forEach(node => { node.status = 'active'; });
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
    const toggle = card.getByRole('switch', { name: /Updated SOCKS/ });
    const sibling = card.getByRole('switch', { name: /HTTP node/ });
    check(await card.getByRole('switch').count() === 2, 'shared IP does not have independent node switches');
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
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
