async page => {
  const results = [], requests = [], errors = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  const chunk = name => new RegExp(`/assets/${name}-[\\w-]{8,}\\.(?:js|css)$`);
  const deferred = ["task-settings-dialog", "subscription-history", "proxy-create-dialog", "proxy-edit-dialog", "account-log-dialog"];
  const taskChunk = /\/assets\/task-settings-dialog-[\w-]{8,}\.js$/;
  const historyChunk = /\/assets\/subscription-history-[\w-]{8,}\.js$/;
  const taskButton = page.getByRole("button", { name: "任务设置", exact: true });
  const historyButton = page.getByRole("button", { name: "历史订阅", exact: true });
  const row = page.locator("tr.job-row").first();
  const hasFocus = locator => locator.evaluate(element => document.activeElement === element);
  const runtimeError = error => errors.push(error.message);
  const record = request => requests.push(new URL(request.url()).pathname);
  const run = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };

  // The runner has already visited the page. Install routing before reload so
  // this measurement also exercises a cold HTTP cache. Only slow the user click.
  let delayTask = false, releaseTask;
  const gate = new Promise(resolve => { releaseTask = resolve; });
  const slowTask = async route => {
    if (delayTask) await gate;
    await route.continue();
  };
  await page.route(taskChunk, slowTask);
  page.setDefaultTimeout(7000);
  page.on("request", record);
  page.on("pageerror", runtimeError);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await run("production-first-page-skips-five-dialog-bundles", async () => {
      await row.waitFor();
      check(await page.title() === "Sub2api Helper" && new URL(page.url()).hostname === "127.0.0.1", "wrong fixture page");
      const entry = requests.find(url => /\/assets\/index-[\w-]{8,}\.js$/.test(url));
      check(entry, "expected Vite production assets (UI_TEST_NODE_ENV=production)");
      const eager = requests.filter(url => deferred.some(name => chunk(name).test(url)));
      check(!eager.length, `dialog assets requested before first use: ${eager.join(", ")}`);
      // Absence of a request alone also passes if a dialog was inlined. The
      // production entry must actually contain independently emitted JS imports.
      const entryCode = await page.evaluate(url => fetch(url).then(response => response.text()), entry);
      for (const name of deferred) {
        check(new RegExp(`import\\([^)]*?${name}-[\\w-]{8,}\\.js`).test(entryCode), `missing dynamic import for ${name}`);
      }
    });

    await run("slow-task-chunk-keeps-list-visible-and-cancelable", async () => {
      delayTask = true;
      try {
        await Promise.all([page.waitForRequest(taskChunk, { timeout: 7000 }), taskButton.click()]);
        await row.waitFor({ state: "visible" });
        const loading = page.getByRole("dialog");
        await loading.getByRole("button", { name: /取消|关闭/ }).first().waitFor();
        await page.screenshot({ path: evidence + "/deferred-task-loading.png" });
        await page.keyboard.press("Escape");
        await loading.waitFor({ state: "hidden" });
        check(await hasFocus(taskButton), "cancel did not restore task opener focus");
        const finished = page.waitForResponse(taskChunk, { timeout: 7000 });
        releaseTask();
        const response = await finished;
        check(response.ok(), "task chunk request failed after cancellation");
        await response.finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        check(!await loading.count(), "late task chunk reopened the canceled dialog");
      } finally { delayTask = false; releaseTask(); }
    });

    await run("reopened-task-dialog-restores-keyboard-focus", async () => {
      await taskButton.click();
      const taskDialog = page.getByRole("dialog", { name: "任务设置", exact: true });
      await taskDialog.getByRole("button", { name: "保存设置", exact: true }).waitFor();
      check(await taskDialog.evaluate(element => element.contains(document.activeElement)), "task dialog opened without focus");
      await page.keyboard.press("Escape");
      await taskDialog.waitFor({ state: "hidden" });
      check(await hasFocus(taskButton), "closing task dialog did not restore opener focus");
    });

    await run("history-dialog-fetches-its-assets-on-first-open", async () => {
      check(!requests.some(url => chunk("subscription-history").test(url)), "history chunk loaded before the history button was used");
      const [response] = await Promise.all([page.waitForResponse(historyChunk, { timeout: 7000 }), historyButton.click()]);
      check(response.ok(), `history script returned ${response.status()}`);
      const history = page.getByRole("dialog", { name: "历史订阅", exact: true });
      await history.getByRole("heading", { name: "历史订阅", exact: true }).waitFor();
      check(requests.some(url => /\/assets\/subscription-history-[\w-]{8,}\.css$/.test(url)), "history stylesheet missing");
      await history.getByRole("button", { name: "关闭历史订阅", exact: true }).click();
      await history.waitFor({ state: "hidden" });
      check(await hasFocus(historyButton), "closing history did not restore opener focus");
      check(!errors.length, errors.join("\n"));
    });

    await run("transient-download-failure-allows-history-recovery", async () => {
      await page.reload();
      await row.waitFor();
      let attempts = 0, offline = true;
      const interrupted = route => { attempts++; return offline
        ? route.fulfill({ status: 503, contentType: "text/plain", body: "fixture temporary failure" })
        : route.continue(); };
      await page.route(historyChunk, interrupted);
      try {
        await historyButton.click();
        const errorDialog = page.getByRole("dialog", { name: "历史订阅加载失败", exact: true });
        try { await errorDialog.waitFor(); }
        catch (error) { throw new Error(`expected failure dialog after ${attempts} request(s); visible headings: ${await page.getByRole("dialog").getByRole("heading").allTextContents()}; ${error.message}`); }
        check(await row.isVisible(), "download failure hid the job list");
        const failedAttempts = attempts;
        offline = false;
        await errorDialog.getByRole("button", { name: "重试", exact: true }).click();
        try {
          await page.getByRole("dialog", { name: "历史订阅", exact: true }).waitFor();
        } catch (error) { throw new Error(`restore failed after ${attempts} network attempt(s): ${error.message}`); }
        check(attempts > failedAttempts, `retry did not re-request the script after ${failedAttempts} initial attempts`);
      } finally { await page.unroute(historyChunk, interrupted); }
    });
  } finally {
    releaseTask();
    await page.unroute(taskChunk, slowTask);
    page.off("request", record);
    page.off("pageerror", runtimeError);
  }
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
