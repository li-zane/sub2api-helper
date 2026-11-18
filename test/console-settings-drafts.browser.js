async page => {
  const results = [];
  const settingsTitle = "任务设置", proxyTitle = "代理 IP 配置与检测";
  const proxyPath = "**/api/account-proxy-settings";
  const listPath = /\/api\/jobs(?:\?|$)/;
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, run) => {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    finally { await page.unrouteAll({ behavior: "wait" }); await page.reload(); }
  };
  const openProxy = async () => {
    await page.getByRole("region", { name: "代理 IP 配置", exact: true }).getByRole("button", { name: "配置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: proxyTitle, exact: true });
    await dialog.locator("input[aria-label='代理 IP 地址']:enabled").waitFor();
    return dialog;
  };
  const openTask = async () => {
    await page.getByRole("button", { name: settingsTitle, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: settingsTitle, exact: true });
    await dialog.waitFor();
    return dialog;
  };
  const taskSave = dialog => dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  const proxyInput = dialog => dialog.getByRole("textbox", { name: "代理 IP 地址", exact: true });
  const proxySave = dialog => dialog.getByRole("button", { name: "保存代理配置", exact: true });
  const url = port => `http://127.0.0.1:${port}`;
  const defer = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await test("task-save-preserves-unsaved-proxy-draft", async () => {
    let dialog = await openProxy();
    await proxyInput(dialog).fill(url(18080));
    await dialog.locator(".dialog-footer").getByRole("button", { name: "关闭", exact: true }).click();
    const task = await openTask();
    await task.locator("#task-sms-timeout").fill("14");
    await taskSave(task);
    await task.waitFor({ state: "hidden" });
    dialog = await openProxy();
    check(await proxyInput(dialog).inputValue() === url(18080), "task save overwrote proxy input");
    check(await proxySave(dialog).isEnabled(), "task save cleared the proxy dirty flag");
  });
  await test("in-flight-proxy-save-retains-newer-edit-and-retries", async () => {
    const arrived = defer(), release = defer();
    let attempts = 0;
    await page.route(proxyPath, async route => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      if (attempts === 1) { arrived.resolve(); await release.promise; return route.continue(); }
      if (attempts === 2) return route.fulfill({ status: 500, json: { error: "fixture save failure" } });
      return route.continue();
    });
    const dialog = await openProxy(), input = proxyInput(dialog), save = proxySave(dialog);
    await input.fill(url(18081));
    await save.click();
    try {
      await arrived.promise;
      await input.fill(url(18082), { timeout: 2500 });
    } finally { release.resolve(); }
    await save.waitFor();
    check(await input.inputValue() === url(18082) && await save.isEnabled(), "late save acknowledgement cleared newer input");
    await save.click();
    await dialog.getByRole("alert").filter({ hasText: "fixture save failure" }).waitFor();
    check(await input.inputValue() === url(18082) && await save.isEnabled(), "failed save lost the draft");
    const responded = page.waitForResponse(response => response.url().endsWith("/api/account-proxy-settings") && response.request().method() === "POST");
    await save.click();
    check((await responded).ok(), "retry failed");
    await save.waitFor();
    check(await save.isDisabled(), "latest edit was not acknowledged");
  });
  await test("old-list-poll-cannot-undo-task-settings-save", async () => {
    const captured = defer(), release = defer(), delivered = defer();
    let first = true;
    await page.route(listPath, async route => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      const data = await response.json();
      captured.resolve();
      await release.promise;
      try { await route.fulfill({ json: data }); }
      finally { delivered.resolve(); }
    });
    try {
      const task = await openTask();
      await captured.promise;
      await task.locator("#task-limit").fill("8");
      await taskSave(task);
      await task.waitFor({ state: "hidden" });
      await page.evaluate(() => {
        window.fixtureOldLimitSeen = false;
        const element = document.querySelector(".telemetry-capsule");
        const observer = new MutationObserver(() => {
          if (element?.textContent?.includes(" / 4")) window.fixtureOldLimitSeen = true;
        });
        if (element) observer.observe(element, { subtree: true, childList: true, characterData: true });
      });
      release.resolve();
      await delivered.promise;
      await page.waitForTimeout(450);
      check(!await page.evaluate(() => window.fixtureOldLimitSeen), "late list response rolled back the saved limit");
    } finally { release.resolve(); }
  });
  await test("saved-runtime-failure-offers-apply-only-retry", async () => {
    const warning = "设置已保存，运行时应用失败。请重试应用。";
    const status = { status: "pending", scopes: ["tasks"], message: warning };
    let taskPosts = 0, retryPosts = 0, pending = false;
    await page.route("**/api/task-settings", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(), data = await response.json();
      taskPosts++;
      pending = response.ok();
      return route.fulfill({ response, json: { ...data, ...(pending ? { runtimeApply: status } : {}) } });
    });
    await page.route(proxyPath, async route => {
      if (!pending || route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      return route.fulfill({ response, json: { ...await response.json(), runtimeApply: status } });
    });
    await page.route("**/api/task-settings/retry-runtime", async route => {
      check(route.request().method() === "POST" && !route.request().postData(), "retry sent a settings draft");
      retryPosts++;
      pending = false;
      return route.continue();
    });
    const task = await openTask();
    await task.locator("#task-limit").fill("11");
    await taskSave(task);
    await task.waitFor({ state: "hidden" });
    await page.getByRole("alert").filter({ hasText: warning }).waitFor();
    const retry = page.getByRole("button", { name: "重试应用设置", exact: true });
    await retry.click();
    await retry.waitFor({ state: "hidden" });
    check(taskPosts === 1 && retryPosts === 1, "runtime retry repeated the save");
    const reopened = await openTask();
    check(await reopened.locator("#task-limit").inputValue() === "11", "committed value missing after runtime retry");
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
