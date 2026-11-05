async (page) => {
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
  const raw = JSON.stringify({ error: { code: "phone_verification_required", message: "完整反馈：" + "详细响应内容。".repeat(50), trace: "fixture-trace-code" } });
  await page.route(pattern, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? {
      ...job, status: mode === "phone" ? "phone" : "failed", prompt: "请输入需要绑定的手机号",
      createdAt: "2026-11-01T01:02:03Z", lastOperationAt: "2026-11-05T04:05:06Z", lastOperationType: "reauthorize",
      webSessionStatus: "valid", webLoginError: "unrelated old Web failure", lastError: mode === "phone" ? null : raw,
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
    check(await row().getByPlaceholder("+60123456789").isVisible(), "phone entry disappeared during column merge");
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
  await run("recent-operation-mobile-and-empty-state", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await row().locator(".operation-feedback-trigger").scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile document overflow");
    await row().locator(".operation-feedback-trigger").click();
    const modal = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
    const bounds = await modal.boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= 375, "feedback dialog overflows mobile viewport");
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "搜索账号", exact: true }).fill("no-match-recent-operation");
    await page.waitForFunction(() => !document.querySelector("tr.job-row"));
    check(await page.locator("td[colspan='12']").count() === 1, "empty state has stale colspan");
  });
  await page.unrouteAll({ behavior: "wait" });
  check(!errors.length, errors.join("; "));
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
