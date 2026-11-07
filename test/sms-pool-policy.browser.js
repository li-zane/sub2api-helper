async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], saves = [];
  const check = (v, text) => { if (!v) throw Error(text); }, run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(6000); page.on("pageerror", e => errors.push(e.message));
  await page.evaluate(() => localStorage.setItem("chatgpt-onboarding.sms-provider-settings-v1", JSON.stringify({ selectedProviderId: "smsbower", maxAutoNumbers: 8, configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", selectionMode: "global", country: "73", maxPrice: "0.05" } } })));
  await page.route("**/api/sms-providers/smsbower/inventory", route => route.fulfill({ json: { estimate: { totalCount: 10, byRank: { gold: 10, silver: 0, bronze: 0 }, countryCount: 1, providerCount: 1 } } }));
  page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/sms-provider-settings") saves.push(req.postDataJSON().settings); });
  await page.reload();
  const open = async () => { await page.getByRole("region", { name: "接码平台配置", exact: true }).getByRole("button", { name: "配置", exact: true }).click(); return page.getByRole("dialog", { name: "接码平台配置", exact: true }); };
  let m = await open(); const threshold = () => m.getByRole("spinbutton", { name: "单个号池失败排除阈值", exact: true });
  await run("legacy setting defaults2 and works for manual acquisition", async () => {
    check(await threshold().inputValue() === "2", "default threshold not2"); check(await threshold().isEnabled(), "manual acquisition cannot configure pool threshold"); check((await m.locator('#sms-pool-failure-help').innerText()).includes("虚拟号码直接排除"), "virtual policy missing");
  });
  await run("strict range and blank validation blocks invalid saves", async () => {
    const before = saves.length;
    for (const value of ["", "0", "11", "1.5"]) { await threshold().fill(value); check(!await threshold().evaluate(e => e.checkValidity()), "invalid threshold accepted " + value); await m.getByRole("button", { name: "保存配置", exact: true }).click(); }
    check(saves.length === before, "invalid value reached server"); await threshold().fill("3"); check(await threshold().evaluate(e => e.checkValidity()), "valid threshold rejected");
  });
  await run("threshold saves and survives reload without changing budget", async () => {
    await m.getByRole("button", { name: "保存配置", exact: true }).click(); await m.waitFor({ state: "hidden" }); check(saves.at(-1).maxFailuresPerPool === 3, "saved payload lost threshold"); check(saves.at(-1).configs.smsbower.maxPrice === "0.05", "budget changed"); check(saves.at(-1).maxAutoNumbers === 8, "total cap changed");
    await page.reload(); m = await open(); check(await threshold().inputValue() === "3", "server threshold did not survive reload"); await threshold().scrollIntoViewIfNeeded(); await page.screenshot({ path: evidence + "/sms-pool-desktop.png" });
  });
  await run("SMSBower-only control and draft preserved after failed save", async () => {
    await m.getByRole("tab", { name: "LubanSMS", exact: true }).click(); check(await threshold().count() === 0, "SMSBower control shown for other provider"); await m.getByRole("tab", { name: "SMSBower", exact: true }).click(); check(await threshold().inputValue() === "3", "provider switch reset threshold");
    await page.route("**/api/sms-provider-settings", route => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "fixture settings write failed" } }) : route.continue());
    await threshold().fill("4"); await m.getByRole("button", { name: "保存配置", exact: true }).click(); await m.getByRole("alert").filter({ hasText: "fixture settings write failed" }).waitFor(); check(await threshold().inputValue() === "4", "failed save lost draft"); await page.unroute("**/api/sms-provider-settings");
  });
  await run("mobile threshold field fits existing dialog", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await threshold().scrollIntoViewIfNeeded(); check(await m.evaluate(e => e.scrollWidth <= e.clientWidth + 1), "mobile modal overflows"); check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page overflows"); check(!errors.length, errors.join("; ")); await page.screenshot({ path: evidence + "/sms-pool-mobile.png" });
  });
  await m.getByRole("button", { name: "取消", exact: true }).click(); await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
