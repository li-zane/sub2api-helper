async (page) => {
  const results = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  const search = page.getByRole("textbox", { name: "搜索账号", exact: true });
  const row = () => page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: "选择 review-1@example.test", exact: true }) });

  await test("Web-state-filter", async () => {
    const filter = page.getByRole("combobox", { name: "筛选 Web 登录态", exact: true });
    check(await filter.count() === 1, "Web state control missing");
    const inactiveColor = await filter.evaluate(element => getComputedStyle(element).color);
    await filter.selectOption("valid");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 0);
    check(await page.getByRole("heading", { name: "没有匹配账号" }).count() === 1, "filtered empty state missing");
    const activeColor = await filter.evaluate(element => getComputedStyle(element).color);
    await filter.selectOption("");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
    check(activeColor !== inactiveColor, "Web filter active styling does not follow its selected value");
  });

  await test("exact-email-list-filter", async () => {
    const button = page.getByRole("button", { name: "邮箱列表筛选", exact: true });
    check(await button.count() === 1, "email-list control missing");
    await button.click();
    await page.getByRole("textbox", { name: "每行一个邮箱（最多 500 个）" }).fill("review-1@example.test\nreview-2@example.test");
    await page.getByRole("button", { name: "应用邮箱筛选", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 2);
    await page.getByRole("button", { name: "清除全部筛选", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  });

  await test("effective-plan-search", async () => {
    await search.fill("business");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length <= 1);
    check(await row().count() === 1, "visible business plan not searchable");
  });
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);

  await test("HelpTip-keyboard", async () => {
    const help = page.getByRole("button", { name: "查看控制台说明", exact: true });
    check(await help.evaluate(e => e.tabIndex >= 0), "help removed from Tab order");
    await help.focus();
    await page.waitForFunction(() => !!document.querySelector('[role="tooltip"]'));
    check(await help.evaluate(e => !!document.getElementById(e.getAttribute("aria-describedby"))), "tooltip not associated with trigger");
    await page.keyboard.press("Escape");
    check(await page.getByRole("tooltip").count() === 0, "Escape does not dismiss help");
  });

  await test("proxy-modal-focus-and-Escape", async () => {
    const trigger = page.getByRole("region", { name: "代理 IP 配置", exact: true }).getByRole("button", { name: "配置", exact: true });
    await trigger.click();
    const modal = page.getByRole("dialog", { name: "代理 IP 配置与检测", exact: true });
    try {
      check(await modal.evaluate(e => e.contains(document.activeElement)), "focus stays behind proxy modal");
      check(await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).evaluate(e => e === document.activeElement), "proxy modal initially focuses the help trigger instead of the close button");
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens automatically on dialog entry");
      await modal.getByRole("button", { name: "查看代理 IP 配置说明", exact: true }).focus();
      await page.waitForFunction(() => !!document.querySelector('dialog [role="tooltip"]'));
      await page.keyboard.press("Escape");
      check(await modal.getByRole("tooltip").count() === 0 && await modal.count() === 1, "Escape must dismiss help before closing the dialog");
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        check(await modal.evaluate(e => e.contains(document.activeElement)), "Tab escaped modal");
      }
      await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).focus();
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "Escape does not close proxy modal");
      check(await trigger.evaluate(e => document.activeElement === e), "focus not restored to trigger");
    } finally {
      if (await modal.count()) await modal.getByRole("button").filter({ hasText: /^关闭$/ }).first().click().catch(async () => { await modal.locator(".dialog-header .icon-button").last().click(); });
    }
  });

  await test("log-modal-focus-and-Escape", async () => {
    const trigger = row().getByRole("button", { name: "查看协议日志", exact: true });
    await trigger.click();
    const modal = page.getByRole("dialog", { name: "协议日志", exact: true });
    try {
      check(await modal.evaluate(e => e.contains(document.activeElement)), "focus stays behind log modal");
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "Escape does not close log modal");
      check(await trigger.evaluate(e => document.activeElement === e), "log focus not restored");
    } finally {
      if (await modal.count()) await modal.locator(".dialog-header .icon-button").last().click();
    }
  });

  await test("batch-row-mutual-exclusion", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/api/jobs/reauthorize-batch", async route => { await pending; await route.fulfill({ json: {} }); });
    try {
      await row().getByRole("checkbox").check();
      await page.locator(".bulk-actions").getByRole("button", { name: "重新授权", exact: true }).click();
      await page.waitForSelector(".workflow-busy");
      for (const name of ["重新授权", "重新登录并授权", "设置 2FA", "添加密码", "登录 Web", "查看或修改账号凭据"]) {
        check(await row().getByRole("button", { name, exact: true }).isDisabled(), name + " enabled while batch busy");
      }
      check(await row().getByRole("button", { name: "查看协议日志", exact: true }).isEnabled(), "read-only logs unnecessarily disabled");
    } finally {
      release();
      await page.waitForFunction(() => !document.querySelector(".workflow-busy"));
      await page.unroute("**/api/jobs/reauthorize-batch");
    }
  });

  await test("mobile-action-column", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    check(await row().locator(".actions-cell").evaluate(e => getComputedStyle(e).position === "static"), "sticky actions obscure mobile table");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "document horizontally overflows");
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await test("search-empty-state", async () => {
    await search.fill("definitely-no-match-987");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 0);
    check(await page.getByRole("heading", { name: "没有匹配账号", exact: true }).count() === 1, "no-results presented as empty database");
    check(!await page.locator(".empty-state").innerText().then(text => text.includes("输入邮箱地址")), "obsolete add-email instruction");
  });
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);

  await test("proxy-distribution-scope", async () => {
    const routes = ["**/api/account-proxy-settings", "**/api/sub2api/settings", "**/api/sub2api/options", "**/api/sub2api/monitor"];
    const poolSettings = { configured: true, hasAdminApiKey: true, config: { baseUrl: "https://pool.example.test", groupIds: [] }, enabled: false };
    await page.route(routes[0], route => route.fulfill({ json: { settings: { mode: "plan", proxyUrl: "", allowDirectFallback: false } } }));
    await page.route(routes[1], route => route.fulfill({ json: poolSettings }));
    await page.route(routes[2], route => route.fulfill({ json: { groups: [], proxies: [{ id: 1, name: "测试出口", ipAddress: "198.51.100.10", accountCount: 7 }], directAccountCount: 3 } }));
    await page.route(routes[3], route => route.fulfill({ json: poolSettings }));
    try {
      await page.reload();
      const trigger = page.getByRole("region", { name: "代理 IP 配置", exact: true }).getByRole("button", { name: "配置", exact: true });
      await trigger.click();
      const modal = page.getByRole("dialog", { name: "代理 IP 配置与检测", exact: true });
      await modal.getByText("未分配代理 · 3 个 OAuth 账号", { exact: true }).waitFor();
      check(await modal.getByText("测试出口 · 198.51.100.10 · 7 个 OAuth 账号", { exact: true }).count() === 1, "per-IP count does not identify its OAuth-only scope");
      const scope = await modal.locator(".proxy-distribution-scope").innerText();
      check(scope.includes("仅统计 OAuth 账号") && scope.includes("不含 API Key") && scope.includes("未完成授权") && scope.includes("不代表实时直连流量"), "proxy distribution scope remains ambiguous");
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens automatically in PlanType mode");
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "first Escape should close the untouched proxy modal");
      await trigger.click();
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens on repeated dialog entry");
      await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).click();
    } finally {
      for (const route of routes) await page.unroute(route);
      await page.reload();
    }
  });
  await test("web-session-monitor-settings", async () => {
    await page.getByRole("button", { name: "任务设置", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "任务设置", exact: true });
    const enabled = modal.getByRole("checkbox", { name: "启用 WebSession 定时检测", exact: true });
    check(!await enabled.isChecked(), "session monitor must default off");
    const interval = modal.getByLabel("检测间隔（分钟）", { exact: true });
    check(await interval.isDisabled(), "interval is enabled while monitor is off");
    await enabled.check();
    check(await interval.isEnabled() && await interval.inputValue() === "15", "monitor interval defaults/control broken");
    check(await modal.getByRole("checkbox", { name: "确认失效或空间变化后自动重登并授权", exact: true }).isChecked(), "auto-relogin default missing");
    await modal.getByRole("button", { name: "取消", exact: true }).click();
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
