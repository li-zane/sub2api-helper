async (page) => {
  const evidenceDir = "__UI_TEST_EVIDENCE_DIR__";
  const results = [], errors = [];
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1480, height: 1000 });
  const settings = { configured: true, hasAdminApiKey: true, config: { baseUrl: 'https://pool.example.test', groupIds: [] }, enabled: false };
  await page.route('**/api/account-proxy-settings', r => r.fulfill({ json: { settings: { mode: 'plan', proxyUrl: '', allowDirectFallback: false } } }));
  for (const url of ['**/api/sub2api/settings', '**/api/sub2api/monitor']) await page.route(url, r => r.fulfill({ json: settings }));
  await page.route('**/api/sub2api/options', r => r.fulfill({ json: { groups: [], proxies: [], directAccountCount: 3 } }));
  await page.route('**/api/sub2api/account-status*', r => r.fulfill({ json: { configured: false, accounts: {} } }));
  let ip = '198.51.100.42', ipCalls = 0, browserIpCalls = 0, failIp = false;
  await page.route('**/api/direct-ip', async r => {
    ipCalls++;
    await new Promise(resolve => setTimeout(resolve, 100));
    await r.fulfill({ status: failIp ? 503 : 200, json: failIp ? { error: 'fixture unavailable' } : { ip } });
  });
  await page.route(/https:\/\/(?:api\.ipify\.org|icanhazip\.com)/, r => { browserIpCalls++; return r.fulfill({ json: { ip: '203.0.113.99' } }); });
  const openProxy = async () => {
    await page.getByRole('region', { name: '代理 IP 配置', exact: true }).getByRole('button', { name: '配置', exact: true }).click();
    return page.getByRole('dialog', { name: '代理 IP 配置与检测', exact: true });
  };
  const reload = async () => { await page.reload(); await page.waitForFunction(() => document.querySelectorAll('tr.job-row').length === 20); };
  await run('direct-IP-load-completes-and-reopens-with-fresh-server-result', async () => {
    await reload();
    let modal = await openProxy();
    await modal.getByText(ip, { exact: true }).waitFor({ timeout: 2000 });
    check(!await modal.getByText('读取中…', { exact: true }).count(), 'direct IP remains loading');
    await page.keyboard.press('Escape'); ip = '2001:db8::42';
    modal = await openProxy();
    await modal.getByText(ip, { exact: true }).waitFor({ timeout: 2000 });
    check(browserIpCalls === 0, 'browser egress must not substitute server egress');
    await modal.screenshot({ path: `${evidenceDir}/proxy-review.png` });
    await page.keyboard.press('Escape');
  });
  await run('direct-IP-failure-settles-without-browser-fallback-or-retry-loop', async () => {
    failIp = true; await reload();
    const before = ipCalls, modal = await openProxy();
    await modal.getByText('本机直连', { exact: true }).waitFor({ timeout: 2000 });
    await new Promise(resolve => setTimeout(resolve, 250));
    check(ipCalls === before + 1, 'failed IP lookup retried in a render loop');
    check(browserIpCalls === 0, 'browser IP falsely presented as server IP');
    await page.keyboard.press('Escape');
  });
  await run('null-direct-IP-settles-and-next-open-can-retry', async () => {
    failIp = false; ip = null; await reload();
    let modal = await openProxy();
    await modal.getByText('本机直连', { exact: true }).waitFor({ timeout: 2000 });
    await page.keyboard.press('Escape'); ip = '198.51.100.43';
    modal = await openProxy();
    await modal.getByText(ip, { exact: true }).waitFor({ timeout: 2000 });
    await page.keyboard.press('Escape');
  });
  let releaseOld, historyCalls = 0;
  const history = name => ({ models: [{ model: name }], records: [{ checkedAt: '2026-11-06T00:00:00Z', status: 'match', models: [{ model: name, expected: name, prediction: name, probability: .99, status: 'match', samples: [{ count: 100, expected: 100 }], candidates: [{ model: name, probability: .99 }] }] }] });
  await page.route('**/api/jobs/*/model-fingerprint/history', async r => {
    const index = ++historyCalls;
    if (index === 1) await new Promise(resolve => { releaseOld = resolve; });
    await r.fulfill({ json: history(index === 1 ? 'stale-model' : 'fresh-model') });
  });
  await run('history-manual-refresh-not-overwritten-by-older-poll', async () => {
    await reload();
    await page.locator('tr.job-row').first().locator('.fingerprint-round').last().click();
    const modal = page.getByRole('dialog', { name: /最近 6 轮归因结果/ });
    await modal.getByText('正在读取归因记录…', { exact: true }).waitFor();
    await modal.getByRole('button', { name: '刷新记录', exact: true }).click();
    await modal.locator('.model-name-text').getByText('fresh-model', { exact: true }).waitFor({ timeout: 2000 });
    releaseOld();
    await new Promise(resolve => setTimeout(resolve, 250));
    check(await modal.locator('.model-name-text').innerText() === 'fresh-model', 'older initial response overwrote a manual refresh');
    await modal.getByText('候选归因分布 (Top 1)', { exact: true }).click();
    check(await modal.locator('.candidate-prob-text').innerText() === '99.00%', 'candidate details missing');
    await modal.screenshot({ path: `${evidenceDir}/fingerprint-history-review.png` });
    await page.keyboard.press('Escape');
    check(!errors.length, errors.join('; '));
  });
  releaseOld?.();
  await page.unrouteAll({ behavior: 'wait' });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
