async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  const results = [], errors = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  await run("recent-operation-column-order", async () => {
    const headings = await page.locator("thead th").allTextContents();
    check(headings.includes("最近操作") && headings.includes("添加时间"), "merged recent operation and added time headings are missing");
    check(!headings.some(text => ["当前操作", "开始时间"].includes(text)), "old time/operation headings remain");
    check(headings.indexOf("最近操作") + 1 === headings.indexOf("最近操作时间") && headings.indexOf("最近操作时间") + 1 === headings.indexOf("添加时间"), "operation, operation time and added time must be adjacent");
    check(headings.length === 12 && await page.locator("colgroup col").count() === 12, "merged table column geometry is inconsistent");
    check(await page.locator("tr.job-row").first().locator(":scope > td").count() === 12, "row retains a removed column");
  });
  if (!results[0].passed) return { passed: 0, total: 1, results };
  const pattern = /\/api\/jobs(?:\?|$)/;
  let mode = "phone";
  const cooldownOperation = { id: "cooldown-fixture", startedAt: "2026-11-16T03:13:00Z", until: "2026-11-16T09:13:00Z",
    cooldownMinutes: 360, status: "cooling", windowMinutes: 15, windowCount: 4, threshold: 4,
    historyCount: 7, historyMinutes: 90, historyThreshold: 12, triggerReason: "current", finishedAt: null };
  const raw = JSON.stringify({ error: { code: "phone_verification_required", message: "完整反馈：" + "详细响应内容。".repeat(50), trace: "fixture-trace-code" } });
  await page.route(pattern, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? {
      ...job, status: mode.startsWith("cooldown") ? "completed" : mode === "phone" ? "phone" : "failed", prompt: "请输入需要绑定的手机号",
      createdAt: "2026-11-01T01:02:03Z", lastOperationAt: "2026-11-05T04:05:06Z", lastOperationType: "reauthorize",
      webSessionStatus: "valid", webLoginError: "unrelated old Web failure", lastError: mode === "phone" ? null : raw,
      ...(mode.startsWith("pool-") ? {
        lastOperationType: "web_login", webLoginError: null, webLoginCompletedAt: "2026-11-05T04:06:00Z",
        poolRefreshAction: "session-reset", poolRefreshReady: mode === "pool-sync",
        poolRefreshError: mode === "pool-sync" ? "HTTP 503: fixture pool write failed" : "UNEXPECTED_LOGIN_PAGE: /workspace",
        poolRefreshFailure: mode === "pool-sync" ? { stage: "sync", at: "2026-11-05T04:07:10Z" } : null,
      } : {}),
      ...(mode.startsWith("cooldown") ? { overloadAutoCooldown: { ...job.overloadAutoCooldown, operation: {
        ...cooldownOperation, ...(mode === "cooldown-completed" ? { status: "completed", finishedAt: "2026-11-16T09:14:00Z", resumedAt: "2026-11-16T09:14:00Z", completionReason: "automatic" } : {}) } } } : {}),
    } : job);
    await route.fulfill({ json: data });
  });
  const row = () => page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: "选择 review-1@example.test", exact: true }) });
  await run("operation-summary-and-time-alignment", async () => {
    await page.reload();
    const trigger = row().locator(".operation-feedback-trigger");
    await trigger.getByText("重新授权", { exact: true }).waitFor();
    check(await trigger.evaluate(el => el.classList.contains("pending")), "pending operation should use pending tone class");
    check(await row().locator(".recent-operation-result").count() === 0, "separate result text should be removed");
    check(await row().locator(".web-session-state").innerText() === "Web已验", "Web badge moved out of account column");
    const phoneTrigger = row().locator("button.sms-compact-trigger");
    check(await phoneTrigger.isVisible(), "compact phone entry disappeared during column merge");
    await phoneTrigger.click();
    const phoneDialog = page.getByRole("dialog", { name: "手机验证详情 · review-1@example.test", exact: true });
    check(await phoneDialog.getByPlaceholder("+60123456789").isVisible(), "compact phone entry did not reveal the phone input");
    await phoneDialog.getByRole("button", { name: "关闭手机验证浮层", exact: true }).click();
    const tag = await trigger.boundingBox();
    const opCell = await row().locator(".recent-operation-cell").boundingBox();
    check(Math.abs(tag.x + tag.width / 2 - opCell.x - opCell.width / 2) < 1, "operation label is not centered in its column");
    const time = await row().locator(".recent-operation-time").boundingBox();
    const timeCell = await row().locator(".recent-operation-time-cell").boundingBox();
    check(time.x >= tag.x + tag.width, "operation timestamp is not in the next column");
    check(await row().locator(".recent-operation-cell .recent-operation-time").count() === 0, "timestamp still appears in operation column");
    check(Math.abs(time.x + time.width / 2 - timeCell.x - timeCell.width / 2) < 1, "operation timestamp is not centered in its column");
    const addedCell = await row().locator(".added-time-cell").boundingBox();
    for (const selector of [".time-date", ".time-clock"]) {
      const value = await row().locator(".added-time-cell " + selector).boundingBox();
      check(Math.abs(value.x + value.width / 2 - addedCell.x - addedCell.width / 2) < 1, "added timestamp is not horizontally centered: " + selector);
    }
    check((await row().locator(".added-time-cell .time-date").innerText()) === "11/01", "added time does not use createdAt");
  });
  await run("operation-feedback-code-dialog", async () => {
    mode = "failed"; await page.reload();
    await row().locator(".operation-feedback-trigger.error").waitFor();
    const bounds = await row().boundingBox();
    for (const selector of [".recent-operation-overview", ".recent-operation-time-cell .time-stack", ".added-time-cell .time-stack"]) {
      const content = await row().locator(selector).boundingBox();
      check(Math.abs(content.y + content.height / 2 - bounds.y - bounds.height / 2) < 1, "column content is not centered within its row: " + selector);
    }
    const tag = row().getByRole("button", { name: "查看重新授权反馈详情", exact: true });
    await tag.click();
    const modal = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
    await modal.waitFor();
    const text = await modal.locator("pre").innerText();
    check(text.includes('"code": "phone_verification_required"') && text.includes('"trace": "fixture-trace-code"'), "original feedback code/JSON lost");
    check(text.includes("详细响应内容。".repeat(50)), "full feedback was truncated in dialog");
    check(!text.includes("unrelated old Web failure"), "unrelated old operation feedback leaked into latest result");
    await page.keyboard.press("Escape");
    check(await tag.evaluate(element => element === document.activeElement), "focus not restored to operation label");
    await tag.press("Enter"); await modal.waitFor();
    await modal.getByRole("button", { name: "关闭详情", exact: true }).click();
  });
  await run("pool-failure-remains-visible-beside-latest-web-login", async () => {
    for (const [testMode, label, error] of [
      ["pool-authorization", "号池同步待授权", "UNEXPECTED_LOGIN_PAGE: /workspace"],
      ["pool-sync", "号池同步失败", "HTTP 503: fixture pool write failed"],
    ]) {
      mode = testMode;
      await page.reload();
      const trigger = row().getByRole("button", { name: `查看${label}反馈详情`, exact: true });
      await trigger.waitFor();
      const web = row().getByRole("button", { name: "查看Web 登录反馈详情", exact: true });
      check(await web.evaluate(el => el.classList.contains("success")), "pool failure replaced successful Web feedback");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
      const text = await dialog.locator("pre").innerText();
      check(text.includes(error), "pool error is missing from the detail");
      if (testMode === "pool-sync") check(text.includes("12:07:10"), "pool failure time is missing");
      await page.keyboard.press("Escape");
    }
  });
  await run("overload-cooldown-duration-deadline-and-original-details", async () => {
    mode = "cooldown"; await page.reload();
    const trigger = row().getByRole("button", { name: "查看过载冷却反馈详情", exact: true }); await trigger.waitFor();
    check(await trigger.evaluate(el => el.classList.contains("pending")), "cooling badge tone is incorrect");
    const progress = row().getByRole("status", { name: "过载冷却进度", exact: true });
    check((await progress.innerText()).includes("冷却中 · 360 分钟"), "cooldown duration is not visible in recent operation column");
    check(await progress.locator("time").getAttribute("datetime") === cooldownOperation.until, "cooldown deadline missing");
    check((await progress.locator("time").innerText()).includes("17:13:00"), "deadline ignored display timezone");
    check((await row().locator(".recent-operation-time").innerText()).includes("11:13:00"), "operation time is not cooldown start");
    await trigger.click(); const modal = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
    const text = await modal.locator("pre").innerText();
    check(text.includes("4 / 4") && text.includes("7 / 12") && text.includes("预计恢复时间") && text.includes("17:13:00"), "cooldown trigger or original timing details lost");
    check(!text.includes("phone_verification_required") && !text.includes("unrelated old Web failure"), "cooldown reused unrelated previous failure");
    await page.keyboard.press("Escape");
    await row().locator(".recent-operation-cell").screenshot({ path: evidence + "/cooldown-active.png" });
  });
  await run("cooldown-recovery-remains-visible-after-refresh", async () => {
    mode = "cooldown-completed"; await page.reload();
    const trigger = row().getByRole("button", { name: "查看过载冷却反馈详情", exact: true }); await trigger.waitFor();
    check(await trigger.evaluate(el => el.classList.contains("success")), "recovered badge is not successful");
    const progress = row().getByRole("status", { name: "过载冷却进度", exact: true });
    check((await progress.innerText()).includes("已恢复 · 360 分钟"), "completed cooldown no longer appears");
    check((await progress.innerText()).includes("恢复于") && (await progress.locator("time").innerText()).includes("17:14:00"), "actual recovery time missing");
    check((await row().locator(".recent-operation-time").innerText()).includes("17:14:00"), "latest operation time was not updated on recovery");
    await trigger.click(); const modal = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
    const text = await modal.locator("pre").innerText(); check(text.includes("实际恢复时间") && text.includes("11:13:00") && text.includes("17:13:00"), "recovery lost original cooling interval");
    await page.keyboard.press("Escape");
    await row().locator(".recent-operation-cell").screenshot({ path: evidence + "/cooldown-recovered.png" });
  });
  await run("recent-operation-mobile-and-empty-state", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await row().locator(".operation-feedback-trigger").scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile document overflow");
    await row().locator(".operation-feedback-trigger").click();
    const modal = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
    const bounds = await modal.boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= 375, "feedback dialog overflows mobile viewport");
    await modal.screenshot({ path: evidence + "/cooldown-mobile-details.png" });
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "搜索账号", exact: true }).fill("no-match-recent-operation");
    await page.waitForFunction(() => !document.querySelector("tr.job-row"));
    check(await page.locator("td[colspan='12']").count() === 1, "empty state has stale colspan");
  });
  await page.unrouteAll({ behavior: "wait" });
  check(!errors.length, errors.join("; "));
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
