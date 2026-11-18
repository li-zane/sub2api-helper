async (page) => {
  const results = [];
  const evidenceDir = "__UI_TEST_EVIDENCE_DIR__";
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  const deferred = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  };
  const pattern = "**/api/jobs?*";
  const query = route => new URL(route.request().url()).searchParams;
  const search = page.getByRole("textbox", { name: "搜索账号", exact: true });
  const row = email => page.getByRole("checkbox", { name: `选择 ${email}`, exact: true });
  const header = page.getByRole("checkbox", { name: "选择当前页全部任务", exact: true });
  const selectAll = page.getByRole("button", { name: "全选", exact: true });
  const bulk = page.getByRole("button", { name: "批量复制凭据", exact: true });
  const more = page.getByRole("button", { name: "更多", exact: true });
  const count = page.locator(".selection-count strong");
  const status = page.locator(".job-list-status");
  const first = "review-1@example.test";
  const second = "review-2@example.test";
  const runtimeErrors = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().includes("503")) runtimeErrors.push(message.text());
  });
  const rows = n => page.waitForFunction(n => document.querySelectorAll("tr.job-row").length === n, n, { timeout: 4000 });
  const waitEnabled = locator => locator.locator("xpath=self::*[not(@disabled)]").waitFor({ timeout: 4000 });
  const expectPaused = async () => {
    check(await header.isDisabled(), "page checkbox can select stale rows");
    check(await selectAll.isDisabled(), "toolbar can select stale rows");
    check(await bulk.isDisabled(), "selection-dependent action is enabled");
    check(await more.isDisabled(), "additional selection actions are openable");
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await rows(20);

  await test("delayed-search-disables-every-selection-entry", async () => {
    const response = deferred();
    const started = deferred();
    await page.route(pattern, async route => {
      if (query(route).get("search") === second) {
        started.release();
        await response.promise;
      }
      await route.continue();
    });
    try {
      await row(first).check();
      check(await count.innerText() === "1", "fixture selection did not start");
      await search.fill(second);
      await started.promise;
      await expectPaused();
      check(await row(first).isDisabled(), "previous row remains selectable");
      check(await count.innerText() === "0", "filter change did not immediately clear selection");
      check(await status.getAttribute("role") === "status" && await status.isVisible(), "loading is not announced");
      check(await page.getByRole("table").getAttribute("aria-busy") === "true", "table is missing its loading state");
      await page.screenshot({ path: evidenceDir + "/job-list-search-pending.png" });
      response.release();
      await rows(1);
      await header.check();
      check(await row(second).isChecked() && await count.innerText() === "1", "header selected outside confirmed result");
      check(await bulk.isEnabled(), "confirmed selection cannot be used");
    } finally {
      response.release();
      await page.unrouteAll({ behavior: "wait" });
      await search.fill("");
      await rows(20);
    }
  });

  await test("returning-to-previous-search-requires-a-fresh-response", async () => {
    const leave = deferred();
    const returned = deferred();
    let left = false;
    await page.route(pattern, async route => {
      if (query(route).get("search") === second) {
        left = true;
        await leave.promise;
      } else if (left) {
        await returned.promise;
      }
      await route.continue();
    });
    try {
      await row(first).check();
      const filteredRequest = page.waitForRequest(req => new URL(req.url()).searchParams.get("search") === second, { timeout: 4000 });
      await search.fill(second);
      await filteredRequest;
      const returningRequest = page.waitForRequest(req => new URL(req.url()).pathname === "/api/jobs"
        && !new URL(req.url()).searchParams.has("search"), { timeout: 4000 });
      await search.fill("");
      await returningRequest;
      await expectPaused();
      check(await count.innerText() === "0", "returning to former query reused its selection");
      leave.release();
      returned.release();
      await waitEnabled(header);
      check(await row(first).isEnabled() && await row(second).isEnabled(), "returning query did not restore its own rows");
    } finally {
      leave.release();
      returned.release();
      await page.unrouteAll({ behavior: "wait" });
      await page.reload();
      await rows(20);
    }
  });

  await test("failed-search-pauses-until-current-results-arrive", async () => {
    const nextResponse = deferred();
    let requests = 0;
    await page.route(pattern, async route => {
      if (query(route).get("search") === first) {
        if (requests++ === 0) return route.fulfill({ status: 503, json: { error: "fixture list unavailable" } });
        await nextResponse.promise;
      }
      await route.continue();
    });
    try {
      await search.fill(first);
      await status.getByText("账号列表更新失败，等待重试。", { exact: true }).waitFor({ timeout: 4000 });
      await expectPaused();
      nextResponse.release();
      await rows(1);
      await selectAll.click();
      check(await row(first).isChecked() && await count.innerText() === "1", "toolbar selected outside recovered result");
    } finally {
      nextResponse.release();
      await page.unrouteAll({ behavior: "wait" });
      await search.fill("");
      await rows(20);
    }
  });

  await test("same-query-poll-keeps-selection-until-a-failure", async () => {
    const started = deferred();
    const releaseFirst = deferred();
    const releaseRetry = deferred();
    let requests = 0;
    await page.route(pattern, async route => {
      if (requests++ === 0) {
        started.release();
        await releaseFirst.promise;
        return route.fulfill({ status: 503, json: { error: "fixture poll unavailable" } });
      }
      await releaseRetry.promise;
      await route.continue();
    });
    try {
      await row(first).check();
      await started.promise;
      check(await bulk.isEnabled() && await row(first).isChecked(), "pending poll disrupted a valid selection");
      check(await page.getByRole("table").getAttribute("aria-busy") !== "true", "same-query poll put the table in loading state");
      releaseFirst.release();
      await status.getByText("账号列表更新失败，等待重试。", { exact: true }).waitFor({ timeout: 4000 });
      await expectPaused();
      check(await row(first).isChecked() && await count.innerText() === "1", "poll failure discarded the remembered selection");
      releaseRetry.release();
      await waitEnabled(bulk);
      check(await row(first).isChecked() && await count.innerText() === "1", "poll recovery lost selected row");
    } finally {
      releaseFirst.release();
      releaseRetry.release();
      await page.unrouteAll({ behavior: "wait" });
      await page.reload();
      await rows(20);
    }
  });

  await test("delayed-page-change-preserves-cross-page-selection", async () => {
    const response = deferred();
    const started = deferred();
    await page.route(pattern, async route => {
      if (query(route).get("page") === "2") {
        started.release();
        await response.promise;
      }
      await route.continue();
    });
    try {
      await header.check();
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await started.promise;
      check(await count.innerText() === "20", "page change discarded the remembered selection");
      check(await header.isDisabled() && await bulk.isDisabled(), "stale page can change or use selection");
      response.release();
      await rows(4);
      await header.check();
      check(await count.innerText() === "24", "selecting another page did not accumulate");
      await page.getByRole("button", { name: "上一页", exact: true }).click();
      await rows(20);
      check(await header.isChecked() && await count.innerText() === "24", "returning to page one lost selected rows");
    } finally {
      response.release();
      await page.unrouteAll({ behavior: "wait" });
      await page.reload();
      await rows(20);
    }
  });

  await test("automatic-filter-reset-requires-results-for-the-new-filter", async () => {
    let removeOption = false;
    const response = deferred();
    const started = deferred();
    await page.route(pattern, async route => {
      if (removeOption && query(route).get("status") === "failed") {
        const incoming = await route.fetch();
        const data = await incoming.json();
        data.filterOptions.statuses = data.filterOptions.statuses.filter(value => value !== "failed");
        return route.fulfill({ json: data });
      }
      if (removeOption && !query(route).has("status")) {
        started.release();
        await response.promise;
      }
      await route.continue();
    });
    try {
      const allStatuses = page.getByRole("button", { name: "筛选状态，当前：全部", exact: true });
      await allStatuses.click();
      await page.getByRole("menuitemradio", { name: "失败", exact: true }).click();
      await rows(1);
      await header.check();
      check(await count.innerText() === "1", "filtered selection did not start");
      removeOption = true;
      await started.promise;
      check(await allStatuses.isVisible(), "unavailable filter was not cleared");
      await expectPaused();
      check(await count.innerText() === "0", "automatic filter clear retained the previous selection");
      response.release();
      await rows(20);
      check(await count.innerText() === "0" && await header.isEnabled(), "new list is not selectable after automatic filter clear");
    } finally {
      response.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  await test("fixture-page-and-console-health", async () => {
    check(new URL(page.url()).hostname === "127.0.0.1" && await page.title() === "Sub2api Helper", "unexpected fixture page");
    check(await page.getByRole("heading", { name: "账号列表", exact: true }).isVisible(), "list page is blank");
    check(await page.locator("vite-error-overlay").count() === 0, "framework error overlay is present");
    check(runtimeErrors.length === 0, "browser errors: " + runtimeErrors.join(", "));
    await page.screenshot({ path: evidenceDir + "/job-list-selection-ready.png" });
  });

  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
