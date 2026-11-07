async (page) => {
  await page.route("**/api/sms-providers/smsbower/inventory", route => route.fulfill({ json: { estimate: { totalCount: 10, byRank: { gold: 10, silver: 0, bronze: 0 }, countryCount: 1, providerCount: 1 }, fetchedAt: new Date().toISOString() } }));
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], calls = [];
  const check = (v, text) => { if (!v) throw Error(text); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(5000);
  await page.evaluate(() => localStorage.setItem("chatgpt-onboarding.sms-provider-settings-v1", JSON.stringify({ selectedProviderId: "smsbower", configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", countryLabel: "Japan", maxPrice: "0.043" } } })));
  await page.route("**/api/sms-providers/smsbower/options", async route => { calls.push(route.request().postDataJSON()); await route.fulfill({ json: { options: [
    { country: "73", title: "Brazil", price: 0.01, currency: "USD", count: 50 },
    { country: "1001", title: "Japan", price: 0.18, currency: "USD", count: 20 },
  ] } }); });
  await page.reload();
  const open = async () => { await page.getByRole("region", { name: "接码平台配置", exact: true }).getByRole("button", { name: "配置", exact: true }).click(); return page.getByRole("dialog", { name: "接码平台配置", exact: true }); };
  let m = await open(); const cap = () => m.getByRole("spinbutton", { name: "最高价格（USD）", exact: true });
  await run("manual cap retained by query and country selection", async () => {
    check(await cap().inputValue() === "0.043", "existing cap lost"); await cap().fill("0.04");
    await m.getByRole("button", { name: "查询价格", exact: true }).click();
    const countries = m.getByRole("combobox", { name: "SMSBower 国家与价格" }); await countries.waitFor(); await countries.click();
    await page.getByRole("option").filter({ hasText: "Brazil" }).click();
    check(await cap().inputValue() === "0.04", "country selection overwrote cap");
    await m.getByRole("button", { name: "查询价格", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.price-refresh-button')?.disabled);
    check(await cap().inputValue() === "0.04", "price refresh overwrote cap");
    check((await m.locator('.price-select-row .sms-price-note').innerText()).includes("Gold → Silver → Bronze"), "rank policy missing");
    check(calls.at(-1).config.country === "73", "query changed selected country");
  });
  await run("budget input validates empty zero and decimal step", async () => {
    for (const value of ["", "0", "-1", "0.0000001"]) { await cap().fill(value); check(!await cap().evaluate(e => e.checkValidity()), "invalid cap accepted " + value); }
    await cap().fill("0.04"); check(await cap().evaluate(e => e.checkValidity()), "valid cap rejected");
    await page.screenshot({ path: evidence + "/smsbower-ranked-desktop.png" });
  });
  await run("budget and country survive save and reload", async () => {
    await m.getByRole("button", { name: "保存配置", exact: true }).click(); await m.waitFor({ state: "hidden" });
    await page.reload(); m = await open(); check(await cap().inputValue() === "0.04", "budget not persisted");
    await m.getByRole("button", { name: "查询价格", exact: true }).click(); await page.waitForFunction(() => !document.querySelector('.price-refresh-button')?.disabled);
    check(calls.at(-1).config.country === "73", "country not persisted"); check(await cap().inputValue() === "0.04", "reload query changed budget");
  });
  await run("mobile layout preserves existing styling without overflow", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await cap().scrollIntoViewIfNeeded();
    check(await m.evaluate(e => e.scrollWidth <= e.clientWidth + 1), "modal overflows"); check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page overflows");
    await page.screenshot({ path: evidence + "/smsbower-ranked-mobile.png" }); check(!errors.length, errors.join("; "));
  });
  await m.getByRole("button", { name: "取消", exact: true }).click(); await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
