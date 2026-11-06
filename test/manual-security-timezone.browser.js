async (page) => {
  page.setDefaultTimeout(8000);
  const results = [], errors = [], calls = [], evidence = "__UI_TEST_EVIDENCE_DIR__";
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on("pageerror", e => errors.push(e.message));
  const at = "2026-11-06T16:30:45.000Z";
  let security = { totpEnabled: false, passwordEnabled: false, totpCheckedAt: at, passwordCheckedAt: at, checkedAt: at }, currentJob, mode = "success", release;
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map(job => {
      if (job.email !== "review-1@example.test") return job;
      currentJob = { ...job, status: "completed", webSessionAvailable: true, webSessionStatus: "valid", createdAt: at, lastOperationAt: at, webSessionVerifiedAt: at, securityState: security };
      return currentJob;
    });
    await route.fulfill({ json: data });
  });
  await page.route(/\/api\/jobs\/[^/]+\/security-state(?:\?|$)/, async route => {
    const field = new URL(route.request().url()).searchParams.get("field"); calls.push(field);
    if (mode === "hold") await new Promise(resolve => release = resolve);
    if (mode === "error") return route.fulfill({ status: 503, json: { error: "fixture upstream unavailable" } });
    security = { ...security, [field === "totp" ? "totpEnabled" : "passwordEnabled"]: true };
    currentJob = { ...currentJob, securityState: security };
    await route.fulfill({ json: { job: currentJob, securityState: security } });
  });
  await page.route(/\/api\/jobs\/[^/]+\/logs\?view=protocol/, async route => {
    const entry = new URL(route.request().url()).searchParams.get("entry");
    await route.fulfill({ json: { entries: [{ id: "timed", label: "手动核对", type: "security_check", at, status: "completed" }], selectedId: entry, content: entry ? `[${at}] [security] checked\nlegacy without timestamp\n` : "" } });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload();
  const row = n => page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: `选择 review-${n}@example.test`, exact: true }) });
  const twofa = () => row(1).getByRole("button", { name: "核对 2FA 状态", exact: true });
  const password = () => row(1).getByRole("button", { name: "核对 密码 状态", exact: true });
  await row(1).waitFor();
  await test("manual-check-buttons-keep-indicators-and-disabled-reasons", async () => {
    check(await twofa().isEnabled() && await password().isEnabled(), "saved Web account buttons disabled");
    check(await twofa().getByRole("img", { name: "2FA：未开启" }).count() === 1, "remote off state missing");
    check(await row(2).getByRole("button", { name: "核对 2FA 状态", exact: true }).isDisabled(), "banned check enabled");
    check((await row(2).getByRole("button", { name: "核对 2FA 状态", exact: true }).getAttribute("title")).includes("封禁"), "ban reason missing");
    check(await row(5).getByRole("button", { name: "核对 密码 状态", exact: true }).isDisabled(), "no-Web account check enabled");
  });
  await test("single-flight-per-field-check-updates-immediately", async () => {
    mode = "hold"; await twofa().click();
    await page.waitForFunction(() => document.querySelector('.account-security-lights button[aria-busy="true"]'));
    check(await twofa().isDisabled() && await password().isDisabled(), "parallel account checks enabled");
    await twofa().evaluate(el => { el.click(); el.click(); }); check(calls.length === 1 && calls[0] === "totp", "duplicate/wrong-field check");
    mode = "success"; release();
    await twofa().getByRole("img", { name: "2FA：已开启" }).waitFor();
    check(await password().getByRole("img", { name: "密码：未开启" }).count() === 1, "2FA probe changed password evidence");
    await password().focus(); await page.keyboard.press("Enter");
    await password().getByRole("img", { name: "密码：已开启" }).waitFor(); check(calls.join(",") === "totp,password", "keyboard password check missing");
  });
  await test("failed-manual-check-preserves-result-and-releases-button", async () => {
    mode = "error"; await password().click();
    await page.getByText(/核对密码失败：fixture upstream unavailable/).waitFor();
    check(await password().isEnabled(), "error left check disabled");
    check(await password().getByRole("img", { name: "密码：已开启" }).count() === 1, "error erased last remote evidence");
    check((await password().getAttribute("title")).includes("上次核对失败"), "error tooltip missing"); mode = "success";
  });
  async function saveZone(zone) {
    await page.getByRole("button", { name: "任务设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "任务设置", exact: true });
    const field = dialog.getByRole("combobox", { name: "显示时区", exact: true });
    check((await field.boundingBox()).width >= 200, "timezone field is too narrow for IANA names");
    await field.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${evidence}/display-time-zone-settings.png` });
    await field.fill(zone);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  }
  await test("timezone-save-updates-memoized-row-and-tooltips-without-reload", async () => {
    check(await row(1).locator(".added-time-cell .time-clock").innerText() === "00:30:45", "default not Shanghai");
    await saveZone("UTC");
    await row(1).locator(".added-time-cell .time-clock").filter({ hasText: "16:30:45" }).waitFor();
    check(await row(1).locator(".added-time-cell .time-date").innerText() === "11/06", "date not converted");
    check((await twofa().getAttribute("title")).includes("16:30:45"), "security time tooltip not global");
    check((await row(1).locator(".web-session-state").getAttribute("title")).includes("16:30:45"), "Web tooltip not global");
  });
  await test("protocol-list-and-lines-use-global-zone-legacy-is-unchanged", async () => {
    await row(1).getByRole("button", { name: "查看协议日志", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "账号日志与凭据", exact: true });
    const record = dialog.getByRole("button", { name: /手动核对/ }); await record.waitFor();
    check((await record.innerText()).includes("16:30:45"), "record list not UTC"); await record.click();
    await dialog.locator("pre").filter({ hasText: "[security] checked" }).waitFor();
    const text = await dialog.locator("pre").innerText(); check(text.includes("16:30:45 GMT+0"), "protocol timestamp not UTC");
    check(text.includes("legacy without timestamp"), "legacy log changed");
    await page.screenshot({ path: `${evidence}/manual-security-timezone-desktop.png` }); await dialog.getByRole("button", { name: "关闭协议日志", exact: true }).click();
    await saveZone("America/New_York");
    check(await row(1).locator(".added-time-cell .time-clock").innerText() === "11:30:45", "global setting not applied to another zone");
  });
  await test("invalid-zone-stays-unsaved-and-mobile-buttons-fit", async () => {
    await page.getByRole("button", { name: "任务设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "任务设置", exact: true });
    await settings.getByRole("combobox", { name: "显示时区", exact: true }).fill("invalid/zone");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await settings.getByText(/显示时区必须是有效/).waitFor(); await settings.getByRole("button", { name: "取消", exact: true }).click();
    check(await row(1).locator(".added-time-cell .time-clock").innerText() === "11:30:45", "invalid setting changed the display");
    await page.setViewportSize({ width: 375, height: 812 }); await twofa().scrollIntoViewIfNeeded();
    const group = row(1).locator(".account-security-lights"), cell = row(1).locator(".status-cell");
    check(await group.evaluate(e => e.scrollWidth <= e.clientWidth + 1), "security controls overflow");
    check((await group.boundingBox()).width <= (await cell.boundingBox()).width, "buttons wider than status cell");
    await page.screenshot({ path: `${evidence}/manual-security-timezone-mobile.png` }); check(errors.length === 0, errors.join("; "));
  });
  if (release) release(); await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
