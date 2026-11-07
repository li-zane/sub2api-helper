async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], calls = []; let mode = "normal", release;
  const check = (v, text) => { if (!v) throw Error(text); }, run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(6000); page.on("pageerror", e => errors.push(e.message));
  await page.evaluate(() => localStorage.setItem("chatgpt-onboarding.sms-provider-settings-v1", JSON.stringify({ selectedProviderId: "smsbower", configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", countryLabel: "Japan", maxPrice: "0.04" } } })));
  await page.route("**/api/sms-providers/smsbower/inventory", async route => {
    const config = route.request().postDataJSON().config, kind = mode; calls.push(config);
    if (kind === "hold") await new Promise(r => release = r);
    const zero = Number(config.maxPrice) < 0.005, narrow = Number(config.maxPrice) <= 0.01, global = config.selectionMode === "global";
    const byRank = zero ? { gold: 0, silver: 0, bronze: 0 } : narrow ? global ? { gold: 0, silver: 11, bronze: 43 } : { gold: 0, silver: 0, bronze: 30 } : global ? { gold: 22, silver: 31, bronze: 43 } : { gold: 10, silver: 20, bronze: 30 };
    try { await route.fulfill(kind === "error" ? { status: 503, json: { error: "fixture inventory unavailable" } } : { json: { estimate: { totalCount: Object.values(byRank).reduce((a, b) => a + b, 0), byRank, countryCount: zero ? 0 : global ? 3 : 1, providerCount: zero ? 0 : global ? 7 : 3 }, fetchedAt: new Date().toISOString() } }); } catch {}
  });
  await page.reload();
  const open = async () => { await page.getByRole("region", { name: "接码平台配置", exact: true }).getByRole("button", { name: "配置", exact: true }).click(); return page.getByRole("dialog", { name: "接码平台配置", exact: true }); };
  let m = await open(); const estimate = () => m.getByRole("region", { name: "号码库存预估", exact: true });
  const cap = () => m.getByRole("spinbutton", { name: "最高价格（USD）", exact: true });
  const setMode = async label => { await m.getByRole("combobox", { name: "SMSBower 选号方式", exact: true }).click(); await page.getByRole("option", { name: label, exact: true }).click(); check(await m.getByRole("combobox", { name: "SMSBower 选号方式", exact: true }).getAttribute("aria-expanded") === "false", "selected menu reopened through label activation"); };
  await run("legacy defaults to fixed-country and auto-estimates read-only", async () => {
    await estimate().getByRole("status").filter({ hasText: "预估可用约 60 个" }).waitFor(); check(calls[0].selectionMode === "country" && calls[0].country === "1001", "old country scope lost"); check((await estimate().innerText()).includes("Gold 10 · Silver 20 · Bronze 30"), "rank counts missing");
  });
  await run("global mode hides inactive country and estimates all eligible stock", async () => {
    await setMode("不限国家"); await estimate().getByRole("status").filter({ hasText: "预估可用约 96 个" }).waitFor(); check(await m.getByRole("combobox", { name: "SMSBower 国家与价格" }).count() === 0, "inactive country still displayed"); check(calls.at(-1).country === "", "global request still restricted by saved country"); check(await cap().inputValue() === "0.04", "mode switch overwrote cap"); check((await estimate().innerText()).includes("Gold 22 · Silver 31 · Bronze 43 · 3 个国家"), "global breakdown wrong"); await page.screenshot({ path: evidence + "/smsbower-global-desktop.png" });
  });
  await run("cap changes debounced; invalid cap hides stale values; zero is real", async () => {
    const before = calls.length; for (const value of ["0.03", "0.02", "0.01"]) { await cap().fill(value); await page.waitForTimeout(80); }
    await estimate().getByRole("status").filter({ hasText: "预估可用约 54 个" }).waitFor(); check(calls.length === before + 1, "typing triggered excessive requests");
    await cap().fill("0"); await page.waitForTimeout(750); check(!((await estimate().innerText()).includes("54 个")), "invalid cap retained old estimate"); check(await estimate().getByRole("button", { name: "刷新预估", exact: true }).isDisabled(), "invalid cap can query");
    await cap().fill("0.000001"); await estimate().getByRole("status").filter({ hasText: "预估可用约 0 个" }).waitFor();
  });
  await run("mode change aborts stale response without overwriting current scope", async () => {
    mode = "hold"; await cap().fill("0.04"); await page.waitForFunction(() => document.querySelector('[aria-label="号码库存预估"] button')?.disabled); await page.waitForTimeout(650); const oldRelease = release; check(!!oldRelease, "held request missing");
    mode = "normal"; await setMode("指定国家"); await estimate().getByRole("status").filter({ hasText: "预估可用约 60 个" }).waitFor(); oldRelease(); await page.waitForTimeout(100); check((await estimate().innerText()).includes("60 个"), "stale global reply overwrote country estimate");
  });
  await run("failed refresh retains same-scope estimate with stale label", async () => {
    mode = "error"; await estimate().getByRole("button", { name: "刷新预估", exact: true }).click(); await estimate().getByRole("alert").filter({ hasText: "fixture inventory unavailable" }).waitFor(); check((await estimate().innerText()).includes("60 个（上次预估）"), "failure erased successful estimate"); mode = "normal";
  });
  await run("mode persists and mobile estimate layout fits", async () => {
    await setMode("不限国家"); await estimate().getByRole("status").filter({ hasText: "预估可用约 96 个" }).waitFor(); await m.getByRole("button", { name: "保存配置", exact: true }).click(); await m.waitFor({ state: "hidden" });
    await page.reload(); m = await open(); await estimate().getByRole("status").filter({ hasText: "预估可用约 96 个" }).waitFor(); check((await m.getByRole("combobox", { name: "SMSBower 选号方式", exact: true }).innerText()).includes("不限国家"), "saved global mode lost");
    await page.setViewportSize({ width: 375, height: 812 }); await estimate().scrollIntoViewIfNeeded(); check(await m.evaluate(e => e.scrollWidth <= e.clientWidth + 1), "mobile dialog overflows"); check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page overflows"); check(!errors.length, errors.join("; ")); await page.screenshot({ path: evidence + "/smsbower-global-mobile.png" });
  });
  if (release) release(); await m.getByRole("button", { name: "取消", exact: true }).click(); await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
