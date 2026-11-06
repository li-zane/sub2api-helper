async (page) => {
  const results = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const check = (value, message) => { if (!value) throw Error(message); };
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
    finally {
      const modal = page.getByRole("dialog", { name: "账号凭据", exact: true });
      if (await modal.count()) {
        const close = modal.getByRole("button", { name: "关闭", exact: true }).last();
        if (releaseRotation) { releaseRotation(); releaseRotation = null; }
        await close.click({ timeout: 3000 });
      }
    }
  };
  let firstJob, activeRotation = false, originalsReadable = true;
  const checkedAt = "2026-11-06T12:00:00Z";
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map(job => {
      const n = Number(/^review-(\d+)@/.exec(job.email)?.[1] || 0);
      const state = n === 1 ? { totpEnabled: true, passwordEnabled: false, checkedAt }
        : n === 4 ? { totpEnabled: false, passwordEnabled: true, checkedAt }
        : { totpEnabled: null, passwordEnabled: null, checkedAt: null };
      const updated = { ...job, securityState: state, hasTotpKey: true,
        canReplacePassword: !activeRotation, canReplaceTotp: true,
        ...(n === 1 && activeRotation ? { status: "queued", canReplacePassword: false } : {}) };
      if (n === 1) firstJob = updated;
      return updated;
    });
    await route.fulfill({ json: data });
  });
  let password = "Fixture-Password-123!", seed = "JBSWY3DPEHPK3PXP", saved = null;
  await page.route("**/api/jobs/*/credentials", async route => {
    if (route.request().method() === "PUT") {
      saved = route.request().postDataJSON();
      if (Object.hasOwn(saved, "password")) password = saved.password;
      if (Object.hasOwn(saved, "totpSecret")) seed = saved.totpSecret;
    }
    await route.fulfill({ json: { credentials: { password: originalsReadable ? password : "", totpSecret: originalsReadable ? seed : "",
      hasPassword: true, hasTotpKey: true, passwordAvailable: originalsReadable && Boolean(password),
      totpSecretAvailable: originalsReadable && Boolean(seed), sub2apiJson: "{}", persisted: true } } });
  });
  const rotationRequests = [];
  let rotationMode = "success", releaseRotation = null;
  await page.route("**/api/jobs/*/replace-password", async route => {
    rotationRequests.push(route.request().postDataJSON());
    if (rotationMode === "hold-error") await new Promise(resolve => { releaseRotation = resolve; });
    if (rotationMode === "hold-error") return route.fulfill({ status: 502, json: { error: "fixture password rotation rejected" } });
    activeRotation = true;
    await route.fulfill({ json: { job: { ...firstJob, status: "queued", canReplacePassword: false } } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  const row = n => page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: `选择 review-${n}@example.test`, exact: true }) });
  await row(1).getByRole("img", { name: "2FA：已开启", exact: true }).waitFor();
  const openCredentials = async () => {
    await row(1).getByRole("button", { name: "查看或修改账号凭据", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "账号凭据", exact: true });
    await modal.getByRole("button", { name: "一键轮换密码", exact: true }).waitFor();
    return modal;
  };
  await page.evaluate(() => {
    window.confirm = () => true;
    window.__credentialCopies = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__credentialCopies.push(value); } } });
  });

  await test("security-indicators-follow-remote-tristate", async () => {
    check(await row(1).getByRole("img", { name: "密码：未开启", exact: true }).count() === 1, "password false is not shown as off");
    check(await row(4).getByRole("img", { name: "2FA：未开启", exact: true }).count() === 1, "local TOTP presence overrode remote false");
    check(await row(4).getByRole("img", { name: "密码：已开启", exact: true }).count() === 1, "password true is not shown as on");
    check(await row(5).getByRole("img", { name: "2FA：待确认", exact: true }).count() === 1, "unknown TOTP incorrectly shown as off");
    check(await row(5).getByRole("img", { name: "密码：待确认", exact: true }).count() === 1, "unknown password incorrectly shown as off");
    const color = async (n, label) => row(n).getByRole("img", { name: label, exact: true }).locator("i").evaluate(e => getComputedStyle(e).backgroundColor);
    check(await color(1, "2FA：已开启") === "rgb(16, 185, 129)", "enabled lamp is not green");
    check(await color(4, "2FA：未开启") === "rgb(225, 29, 72)", "disabled lamp is not red");
    check(await color(5, "2FA：待确认") === "rgb(134, 134, 139)", "unknown lamp is not gray");
  });
  await test("removed-row-buttons-preserved-bulk-actions", async () => {
    for (const name of ["设置 2FA", "添加密码"]) check(await row(1).getByRole("button", { name, exact: true }).count() === 0, name + " row button remains");
    await page.locator(".bulk-more-trigger").click();
    await page.locator(".bulk-dropdown-menu").waitFor();
    for (const name of ["设置 2FA", "添加密码"]) check(await page.locator(".bulk-dropdown-menu .bulk-dropdown-item").filter({ hasText: name }).count() === 1, name + " bulk action was removed: " + await page.locator(".bulk-dropdown-menu").innerText());
    await page.keyboard.press("Escape");
  });
  await test("copy-current-password-and-seed-not-OTP", async () => {
    const modal = await openCredentials();
    await modal.getByRole("button", { name: "复制密码原文", exact: true }).click();
    await modal.getByRole("button", { name: "复制 2FA 密钥原文", exact: true }).click();
    let copies = await page.evaluate(() => window.__credentialCopies.slice(-2));
    check(copies[0] === password && copies[1] === seed, "copy returned a placeholder or OTP instead of field originals");
    await modal.getByLabel("密码", { exact: true }).fill("edited-current-password");
    await modal.getByLabel("2FA 密钥", { exact: true }).fill("MZXW6YTBON2GK3TB");
    await modal.getByRole("button", { name: "复制密码原文", exact: true }).click();
    await modal.getByRole("button", { name: "复制 2FA 密钥原文", exact: true }).click();
    copies = await page.evaluate(() => window.__credentialCopies.slice(-2));
    check(copies[0] === "edited-current-password" && copies[1] === "MZXW6YTBON2GK3TB", "copy ignored current edits");
    check(await modal.getByRole("button", { name: "一键轮换密码", exact: true }).isDisabled(), "rotation discarded unsaved edits");
  });
  await test("clear-both-fields-saves-local-empty-values", async () => {
    const modal = await openCredentials();
    await modal.getByLabel("密码", { exact: true }).fill("");
    await modal.getByLabel("2FA 密钥", { exact: true }).fill("");
    check(await modal.getByRole("button", { name: "复制密码原文", exact: true }).isDisabled(), "empty password copy is enabled");
    check(await modal.getByRole("button", { name: "复制 2FA 密钥原文", exact: true }).isDisabled(), "empty seed copy is enabled");
    await modal.getByRole("button", { name: "保存凭据", exact: true }).click();
    await modal.getByText("凭据已更新并保存", { exact: true }).waitFor();
    check(saved?.password === "" && saved?.totpSecret === "", "blank credential values were rejected or omitted");
    check((await modal.innerText()).includes("仅删除本地记录"), "local deletion semantics missing");
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
    check(await row(1).getByRole("img", { name: "2FA：已开启", exact: true }).count() === 1, "local deletion changed remote security state");
  });
  await test("unreadable-placeholders-have-disabled-copy", async () => {
    originalsReadable = false;
    const modal = await openCredentials();
    check(await modal.getByRole("button", { name: "复制密码原文", exact: true }).isDisabled(), "unreadable password placeholder can be copied");
    check(await modal.getByRole("button", { name: "复制 2FA 密钥原文", exact: true }).isDisabled(), "unreadable TOTP placeholder can be copied");
    originalsReadable = true;
  });
  await test("password-rotation-single-submit-busy-and-failure", async () => {
    password = "Fixture-Password-123!"; seed = "JBSWY3DPEHPK3PXP"; rotationMode = "hold-error";
    const modal = await openCredentials(), button = modal.getByRole("button", { name: "一键轮换密码", exact: true });
    await button.click();
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') !== null);
    check(await button.isDisabled(), "pending password rotation can be repeated");
    check(await modal.getByLabel("密码", { exact: true }).getAttribute("readonly") !== null, "password editable during submitted rotation");
    check(await modal.getByRole("button", { name: "保存凭据", exact: true }).isDisabled(), "save allowed while rotation pending");
    await button.evaluate(el => { el.click(); el.click(); });
    check(rotationRequests.length === 1, "pending rotation was submitted twice");
    releaseRotation();
    await modal.getByRole("alert").filter({ hasText: "fixture password rotation rejected" }).waitFor();
    check(await button.isEnabled(), "failed request did not release the button");
  });
  await test("password-rotation-queued-job-not-false-success", async () => {
    rotationMode = "success";
    const modal = await openCredentials();
    await page.screenshot({ path: "__UI_TEST_EVIDENCE_DIR__" + "/security-credentials-desktop.png", animations: "disabled" });
    await modal.getByRole("button", { name: "一键轮换密码", exact: true }).click();
    await modal.getByText("密码轮换请求已提交，请等待任务完成后重新读取凭据", { exact: true }).waitFor();
    check(JSON.stringify(rotationRequests.at(-1)) === "{}", "new password should be generated by backend");
    check(await modal.getByRole("button", { name: "一键轮换密码", exact: true }).isDisabled(), "returned queued job did not lock mutations");
    check(!(await modal.innerText()).includes("密码轮换成功"), "request submission incorrectly reported remote success");
    activeRotation = false;
  });
  await test("mobile-copy-and-rotation-layout", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await row(1).locator(".status-badge").filter({ hasText: "已完成" }).waitFor();
    await row(1).getByRole("img", { name: "2FA：已开启", exact: true }).waitFor();
    const modal = await openCredentials();
    await page.screenshot({ path: "__UI_TEST_EVIDENCE_DIR__" + "/security-credentials-mobile.png", animations: "disabled" });
    const rect = await modal.boundingBox(); check(rect.x >= 0 && rect.x + rect.width <= 376, "mobile credential modal overflowed viewport");
    for (const field of await modal.locator(".secret-input-row").all()) check(await field.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "copy buttons overflowed credential field");
    const saveRect = await modal.getByRole("button", { name: "保存凭据", exact: true }).boundingBox();
    check(saveRect.x >= rect.x && saveRect.x + saveRect.width <= rect.x + rect.width, "mobile save control overflowed footer");
    check(errors.length === 0, errors.join("; "));
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
