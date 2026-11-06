async (page) => {
  const results = [], errors = [], evidence = "__UI_TEST_EVIDENCE_DIR__";
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  const check = (v, message) => { if (!v) throw Error(message); };
  page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(5000);
  await page.evaluate(() => localStorage.setItem("chatgpt-onboarding.sms-provider-settings-v1", JSON.stringify({ selectedProviderId: "smsbower", configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", countryLabel: "Japan", maxPrice: "0.42" } } })));
  await page.reload();
  const open = async () => {
    await page.getByRole("region", { name: "接码平台配置", exact: true }).getByRole("button", { name: "配置", exact: true }).click();
    return page.getByRole("dialog", { name: "接码平台配置", exact: true });
  };
  await test("legacy-local-config-does-not-enable-paid-acquisition", async () => {
    const modal = await open();
    check(await modal.getByRole("tab", { name: "SMSBower", exact: true }).getAttribute("aria-selected") === "true", "local selected provider not retained");
    check(!await modal.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).isChecked(), "auto acquisition unexpectedly enabled");
    await modal.getByRole("button", { name: "取消", exact: true }).click();
  });
  await test("save-enables-server-automation-and-survives-reload", async () => {
    const modal = await open();
    const limit = modal.getByRole("spinbutton", { name: "每次授权自动取号上限（含首次）" });
    check(await limit.inputValue() === "3" && await limit.isDisabled(), "default bounded limit or opt-in state wrong");
    await modal.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).check();
    await limit.fill("2");
    await modal.getByRole("button", { name: "保存配置", exact: true }).click(); await modal.waitFor({ state: "hidden" });
    await page.reload(); const m = await open();
    await m.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).waitFor();
    check(await m.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).isChecked(), "server setting did not survive reload");
    check(await m.getByRole("spinbutton", { name: "每次授权自动取号上限（含首次）" }).inputValue() === "2", "limit did not survive reload");
    await page.waitForTimeout(250); await page.screenshot({ path: evidence + "/sms-settings-desktop.png" });
    await m.getByRole("button", { name: "取消", exact: true }).click();
  });
  await test("pending-server-save-stays-open-and-failure-preserves-draft", async () => {
    let release;
    await page.route("**/api/sms-provider-settings", async route => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise(r => release = r); await route.fulfill({ status: 503, json: { error: "fixture settings write failed" } });
    });
    const modal = await open(); await modal.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).uncheck();
    await modal.getByRole("button", { name: "保存配置", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sms-settings-dialog button[type="submit"]')?.disabled === true);
    await page.keyboard.press("Escape"); check(await modal.isVisible(), "pending save closed on Escape");
    release(); await modal.getByText("fixture settings write failed", { exact: true }).waitFor();
    check(!await modal.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }).isChecked(), "failed save lost draft");
    await modal.getByRole("button", { name: "取消", exact: true }).click(); await page.unroute("**/api/sms-provider-settings");
  });
  await test("mobile-server-sms-toggle-is-readable-and-within-dialog", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); const modal = await open();
    const b = await modal.boundingBox(); check(b.x >= 0 && b.x + b.width <= 376, "mobile dialog outside viewport");
    const toggle = modal.getByRole("checkbox", { name: "需要手机号时自动取号并接码" }); await toggle.scrollIntoViewIfNeeded();
    check(await toggle.isVisible(), "mobile auto-acquire toggle hidden"); await page.waitForTimeout(250); await page.screenshot({ path: evidence + "/sms-settings-mobile.png" });
    await modal.getByRole("button", { name: "取消", exact: true }).click();
  });
  await test("no-sms-settings-runtime-errors", async () => check(errors.length === 0, errors.join("; ")));
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
