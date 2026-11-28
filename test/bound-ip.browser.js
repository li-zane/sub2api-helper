async page => {
  const results = [], errors = [], submissions = [];
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  const check = (value, message) => { if (!value) throw new Error(message); };
  const test = async (name, run) => {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  const email = "review-1@example.test";
  const nodes = [
    { id: 1, name: "Current node", protocol: "http", ipAddress: "203.0.113.7", accountCount: 3 },
    { id: 2, name: "Sibling node", protocol: "socks5", ipAddress: "203.0.113.7", accountCount: 3 },
    { id: 3, name: "Target node", protocol: "https", ipAddress: "203.0.113.8", accountCount: 1 },
  ];
  let bound = 1, rejected = false, failList = false, failHistory = false, emptyHistory = false;
  const history = [
    { ipAddress: "203.0.113.7", lastRequestAt: "2026-11-26T08:00:00.000Z", nodes: [{ id: 1, name: 'Seattle old node' }],
      quality: { checkedAt: '2026-11-26T07:00:00Z', exits: [{ city: 'Seattle', country: 'United States', riskScore: 5 }] } },
    { ipAddress: "203.0.113.4", lastRequestAt: "2026-11-25T08:00:00.000Z" },
    { ipAddress: "2001:db8:1234:5678:abcd:ef01:2345:6789", lastRequestAt: null },
  ];
  const decorate = job => ({
    ...job, assignedProxyId: bound || null, canLogoutAllSessions: true, canForceRelogin: true,
    boundProxyStatus: bound ? "bound" : "direct", boundProxies: nodes.filter(node => node.id === bound),
  });
  let activeJob;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (409|502)\b/.test(message.text())) errors.push(message.text());
  });
  page.setDefaultTimeout(7000);
  await page.route(/\/api\/sub2api\/(?:settings|monitor)$/, route => route.fulfill({ json: {
    configured: true, enabled: false, hasAdminApiKey: true, config: { baseUrl: "https://pool.example.test" },
    profiles: [{ id: "default", name: "Default" }], activeProfileId: "default",
  } }));
  await page.route("**/api/account-proxy-settings", route => route.fulfill({ json: { settings: { mode: "sub2api", proxyUrl: "" } } }));
  await page.route("**/api/sub2api/options", route => failList
    ? route.fulfill({ status: 502, json: { error: "代理列表暂时不可用" } })
    : route.fulfill({ json: { proxies: nodes, groups: [], directAccountCount: 2 } }));
  await page.route("**/api/jobs/*/proxy-history", route => {
    check(Boolean(route.request().headers()["x-console-token"]), "history missing authentication");
    check(route.request().url().includes(activeJob.id), "history requested the wrong account");
    return failHistory ? route.fulfill({ status: 502, json: { error: "历史记录暂时不可用" } })
      : route.fulfill({ json: { history: emptyHistory ? [] : history } });
  });
  await page.route(/\/api\/jobs(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (data.jobs) data.jobs = data.jobs.map(job => {
      if (job.email !== email) return job;
      activeJob = decorate(job);
      return activeJob;
    });
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/jobs/*/proxy-binding", route => {
    const request = route.request();
    check(Boolean(request.headers()["x-console-token"]), "missing authentication");
    check(request.url().includes(activeJob.id), "wrong account");
    const { proxyId } = request.postDataJSON();
    submissions.push(proxyId);
    if (rejected) return route.fulfill({ status: 409, json: { error: "所选代理已不可用，请重新选择" } });
    bound = proxyId;
    const ip = nodes.find(node => node.id === bound)?.ipAddress;
    if (ip && !history.some(item => item.ipAddress === ip)) history.push({ ipAddress: ip, lastRequestAt: null });
    return route.fulfill({ status: 202, json: { job: decorate(activeJob) } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const entry = page.getByRole("button", { name: `切换 ${email} 的绑定 IP`, exact: true });
  const dialog = page.getByRole("dialog", { name: "切换绑定 IP", exact: true });
  const historySection = dialog.getByRole("region", { name: "历史使用的 IP" });
  await test("shows-aggregated-counts-and-cancels-without-changing-binding", async () => {
    await entry.click();
    await dialog.getByText("已绑定 3 个账号").waitFor();
    await historySection.getByText("共 3 个").waitFor();
    check(await historySection.getByText("203.0.113.4", { exact: true }).isVisible(), "deleted exit missing from history");
    check(await historySection.getByRole("listitem").filter({ hasText: "203.0.113.7" }).getByText("当前绑定").isVisible(), "current exit marker missing");
    check(await historySection.getByText("上次使用：2026/11/26 16:00:00", { exact: true }).isVisible(), "request time did not follow display timezone");
    check(await historySection.getByText("暂无请求时间记录", { exact: true }).count() === 1, "unknown timestamp invented a request");
    check(await dialog.getByText("已绑定 3 个账号").count() === 1, "shared IP count was duplicated");
    check(await dialog.getByText("已绑定 1 个账号").isVisible(), "second IP count missing");
    check(await dialog.getByRole("radio", { name: /Current node/ }).isDisabled(), "current node should be unavailable");
    await page.screenshot({ path: evidence + "/bound-ip-desktop.png" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    check(await entry.evaluate(el => document.activeElement === el), "focus not restored");
    check(submissions.length === 0, "cancel sent a write");
  });
  await test("switches-exact-node-and-keeps-selection-after-failure", async () => {
    await entry.click();
    const radio = dialog.getByRole("radio", { name: /Target node/ });
    await radio.check();
    rejected = true;
    await dialog.getByRole("button", { name: "切换并重新登录", exact: true }).click();
    await dialog.getByRole("alert").getByText("所选代理已不可用，请重新选择").waitFor();
    check(await radio.isChecked(), "failed write erased selection");
    rejected = false;
    await dialog.getByRole("button", { name: "切换并重新登录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await entry.getByText("203.0.113.8").waitFor();
    check(submissions.length === 2 && submissions.every(id => id === 3), "wrong node submitted");
  });
  await test("unbinds-and-starts-relogin-from-mobile-dialog", async () => {
    const toast = page.getByRole("button", { name: "关闭操作通知", exact: true });
    if (await toast.count()) { await toast.click(); await toast.waitFor({ state: "hidden" }); }
    await entry.click();
    await dialog.getByText("直连", { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    const box = await dialog.boundingBox();
    check(box && box.x >= 0 && box.x + box.width <= 375, "dialog exceeds viewport");
    await historySection.getByText("共 4 个").waitFor();
    check(await historySection.getByRole("listitem").filter({ hasText: "203.0.113.8" }).getByText("当前绑定").count() === 1, "history current binding did not update");
    check(await historySection.getByRole("listitem").filter({ hasText: "203.0.113.7" }).getByText("当前绑定").count() === 0, "old exit still marked current");
    check(await historySection.evaluate(el => el.scrollWidth <= el.clientWidth), "IPv6 overflows history on mobile");
    await dialog.getByRole("radio", { name: "解除 IP 绑定并改为直连" }).check();
    await page.screenshot({ path: evidence + "/bound-ip-mobile.png" });
    await dialog.getByRole("button", { name: "解除绑定并重新登录", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await entry.getByText("直连", { exact: true }).waitFor();
    check(submissions.at(-1) === 0, "unbind did not request direct mode");
    check(errors.length === 0 && (await page.title()).includes("Helper") && page.url().startsWith("http://127.0.0.1:"), errors.join("; ") || "page identity failed");
    check(await page.locator("vite-error-overlay").count() === 0, "framework overlay visible");
  });
  await test('history-search-finds-saved-name-city-and-IP', async () => {
    await entry.click();
    const search = historySection.getByRole('searchbox', { name: '搜索账号代理记录' });
    await search.fill('Seattle');
    check(await historySection.getByRole('listitem').count() === 1, 'city history filter');
    await historySection.getByText('Seattle old node · #1').waitFor();
    await search.fill('203.0.113.4'); check(await historySection.getByRole('listitem').count() === 1, 'IP history filter');
    await search.fill('nonexistent'); await historySection.getByText('没有匹配的历史记录').waitFor();
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  });
  await test("history-stays-readable-when-proxy-catalog-is-offline", async () => {
    failList = true;
    await entry.click();
    await dialog.getByRole("alert").getByText("代理列表暂时不可用").waitFor();
    await historySection.getByText("203.0.113.4", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    failList = false;
  });
  await test("history-retry-preserves-selected-target-and-sends-no-write", async () => {
    failHistory = true;
    await entry.click();
    await historySection.getByRole("alert").getByText("历史记录暂时不可用").waitFor();
    const radio = dialog.getByRole("radio", { name: /Target node/ });
    await radio.check();
    const before = submissions.length;
    failHistory = false;
    await historySection.getByRole("button", { name: "重试历史记录", exact: true }).click();
    await historySection.getByText("共 4 个").waitFor();
    check(await radio.isChecked(), "history retry reset target selection");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    check(submissions.length === before, "history loading or retry changed the binding");
  });
  await test("empty-history-is-explicit", async () => {
    emptyHistory = true;
    await entry.click();
    await historySection.getByText("暂无历史 IP 记录", { exact: true }).waitFor();
    check(await historySection.getByRole("listitem").count() === 0, "empty history retained another snapshot");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    check(errors.length === 0, errors.join("; "));
  });
  await test("long-history-scrolls-without-hiding-mobile-actions", async () => {
    emptyHistory = false;
    history.push(...Array.from({ length: 25 }, (_, index) => ({ ipAddress: `192.0.2.${index + 1}`, lastRequestAt: null })));
    await page.setViewportSize({ width: 375, height: 667 });
    await entry.click();
    await historySection.getByText("共 29 个").waitFor();
    const list = historySection.getByRole("list");
    check(await list.evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight <= 150), "long history did not get its own scroll area");
    await historySection.getByText("192.0.2.25", { exact: true }).scrollIntoViewIfNeeded();
    check(await historySection.getByText("192.0.2.25", { exact: true }).isVisible(), "oldest entry inaccessible");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    check(errors.length === 0, errors.join("; "));
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
