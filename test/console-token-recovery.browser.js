async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", baseline = false;
  const results = [], errors = [], rejected = [], acceptedPosts = [];
  let expectedToken = "fixture-console-1", realToken = "", bootstraps = 0, navigations = 0;
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource.*403/.test(message.text())) errors.push(message.text());
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/bootstrap") {
      const response = await route.fetch(), data = await response.json();
      realToken = data.token; bootstraps++;
      return route.fulfill({ response, json: { ...data, token: expectedToken } });
    }
    if (request.headers()["x-console-token"] !== expectedToken) {
      rejected.push({ path: url.pathname, method: request.method() });
      return route.fulfill({ status: 403, json: { error: "Invalid console token", code: "INVALID_CONSOLE_TOKEN" } });
    }
    if (request.method() === "POST") acceptedPosts.push({ path: url.pathname, body: request.postDataJSON() });
    const response = await route.fetch({ headers: { ...request.headers(), "x-console-token": realToken } });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  const search = page.getByPlaceholder("搜索账号邮箱、备注、订阅方案...");
  await search.fill("review-1@");
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 1);
  await page.evaluate(() => { window.__tokenRecoveryMarker = "unchanged-page"; });
  const initialNavigationCount = navigations;
  if (baseline) {
    await run("baseline-old-token-persists-without-refresh", async () => {
      expectedToken = "fixture-console-2";
      await page.getByText("Invalid console token", { exact: true }).waitFor();
      check(bootstraps === 1 && rejected.length > 0, "baseline unexpectedly recovered");
      check(navigations === initialNavigationCount, "page reloaded");
      await page.screenshot({ path: `${evidence}/console-token-baseline.png` });
    });
    return { passed: results.filter(r => r.passed).length, total: results.length, results };
  }
  await run("poll-recovers-without-navigation-or-losing-search", async () => {
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/jobs"
      && response.request().headers()["x-console-token"] === "fixture-console-2" && response.status() === 200);
    expectedToken = "fixture-console-2"; await recovered;
    check(bootstraps === 2, "refresh was not shared");
    check(await search.inputValue() === "review-1@", "search lost after token recovery");
    check(await page.evaluate(() => window.__tokenRecoveryMarker) === "unchanged-page", "page context lost");
    check(navigations === initialNavigationCount, "recovery reloaded the page");
    check(await page.getByText("Invalid console token", { exact: true }).count() === 0, "stale auth error leaked into UI");
  });
  await run("component-post-retries-once-and-keeps-draft", async () => {
    await page.getByRole("button", { name: "降智检测设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "降智检测设置", exact: true }); await dialog.waitFor();
    await dialog.getByRole("spinbutton", { name: "默认检测间隔（分钟）", exact: true }).fill("720");
    expectedToken = "fixture-console-3";
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/model-fingerprint/settings"
        && response.request().method() === "POST" && response.request().headers()["x-console-token"] === "fixture-console-3" && response.status() === 200),
      dialog.getByRole("button", { name: "保存降智检测设置", exact: true }).click(),
    ]);
    await dialog.waitFor({ state: "detached" });
    check(bootstraps === 3, "POST did not recover with one refresh");
    const writes = acceptedPosts.filter(r => r.path === "/api/model-fingerprint/settings");
    check(writes.length === 1 && Number(writes[0].body.patch.intervalMinutes) === 720, "write duplicated or draft changed");
    check(rejected.some(r => r.path === "/api/model-fingerprint/settings" && r.method === "POST"), "write expiry scenario was not exercised");
  });
  await run("old-props-use-current-token-and-dialog-state-persists", async () => {
    const dialog = page.getByRole("dialog", { name: "降智检测设置", exact: true });
    if (await dialog.count()) await dialog.getByRole("button", { name: "关闭降智检测设置", exact: true }).click();
    await page.getByRole("button", { name: "降智检测设置", exact: true }).click(); await dialog.waitFor();
    check(await dialog.getByRole("spinbutton", { name: "默认检测间隔（分钟）", exact: true }).inputValue() === "720", "saved settings missing");
    check(bootstraps === 3, "old React token props caused another refresh");
    await dialog.getByRole("button", { name: "关闭降智检测设置", exact: true }).click();
    check(await search.inputValue() === "review-1@", "filter state lost after POST");
    check(navigations === initialNavigationCount, "POST recovery navigated away");
  });
  await run("desktop-mobile-identity-and-console", async () => {
    check(/Sub2api Helper/i.test(await page.title()), "wrong page title");
    check(await page.locator("tr.job-row").count() === 1, "page blank or wrong data");
    check(await page.locator("vite-error-overlay").count() === 0, "framework error overlay");
    await page.screenshot({ path: `${evidence}/console-token-desktop.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: `${evidence}/console-token-mobile.png` });
    check(errors.length === 0, errors.join("; "));
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
