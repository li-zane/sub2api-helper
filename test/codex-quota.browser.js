async (page) => {
  page.setDefaultTimeout(8000);
  const results = [], errors = [], mutations = [], evidence = "__UI_TEST_EVIDENCE_DIR__";
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.on("pageerror", e => errors.push(e.message));
  let lastZero, manualLimited = false;
  await page.route("**/api/sub2api/account-status*", route => route.fulfill({ json: { configured: false, accounts: {} } }));
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => {
      const usage = i === 0 ? { primary: { usedPercent: 100 }, allowed: true, limitReached: false } : i === 3 ? { primary: { usedPercent: manualLimited ? 100 : 0 }, credits: { balance: "0", unlimited: true }, allowed: !manualLimited, limitReached: manualLimited } : i === 4 ? { allowed: false } : i === 5 ? { credits: { balance: "50", overageLimitReached: true } } : { primary: { usedPercent: 0 }, allowed: true };
      const next = { ...job, status: "completed", webSessionStatus: "absent", autoRepairBlocked: false, sub2apiInPool: i !== 1, sub2apiEnabled: i !== 2, codexStatusEligible: true,
        sub2apiQuotaRestricted: false, sub2apiRateLimited: false, sub2apiUsage: { source: "sub2api", ...usage },
        overloadDetection: { configured: true, enabled: true, revision: 1, points: [] }, overloadAutoCooldown: { configured: true, enabled: true, revision: 1, settings: { threshold: 5, windowMinutes: 15 } },
        modelFingerprint: { enabled: true, models: [{ model: "fixture", expected: "fixture" }], phase: "idle", recentResults: [], override: { enabled: true } } };
      if (i === 3) lastZero = next; return next;
    }); await route.fulfill({ json: data });
  });
  await page.route(/\/api\/jobs\/[^/]+\/(?:overload-detection|overload-auto-cooldown|model-fingerprint(?:\/check)?)$/, route => { mutations.push(route.request().url()); return route.fulfill({ json: {} }); });
  await page.route("**/api/jobs/*/usage?refresh=1", route => {
    manualLimited = true; const usage = { source: "sub2api", primary: { usedPercent: 100 }, limitReached: true, allowed: false };
    return route.fulfill({ json: { usage, job: { ...lastZero, sub2apiUsage: usage, sub2apiQuotaRestricted: true, codexStatusEligible: false } } });
  });
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload(); await page.locator("tr.job-row").first().waitFor();
  const row = i => page.locator("tr.job-row").nth(i);
  await test("quota-pool-and-enable-gates-disable-entire-Codex-controls", async () => {
    for (const i of [0, 1, 2, 4, 5]) {
      const controls = row(i).locator(".codex-status").getByRole("switch"); check(await controls.count() === 3, "switches missing");
      for (const control of await controls.all()) { check(await control.isDisabled(), "restricted switch enabled: " + i); check(await control.getAttribute("aria-checked") === "false", "restricted switch shown on: " + i); }
      for (const button of await row(i).locator(".fingerprint-action-pair button").all()) check(await button.isDisabled(), "probe/settings enabled: " + i);
    }
    check((await row(0).locator(".codex-status").getByRole("switch").first().getAttribute("title")).includes("限额"), "quota explanation missing");
    check((await row(1).locator(".codex-status").getByRole("switch").first().getAttribute("title")).includes("号池"), "pool requirement explanation missing");
  });
  await test("zero-balance-alone-stays-eligible-and-usage-label-agrees", async () => {
    for (const control of await row(3).locator(".codex-status").getByRole("switch").all()) check(await control.isEnabled(), "zero balance wrongly gated");
    for (const i of [0, 4, 5]) check(await row(i).locator(".usage-state").innerText() === "受限", "quota label differs from detection gate: " + i);
    check(await row(3).locator(".usage-state").innerText() === "可用", "zero balance labeled exhausted");
  });
  await test("disabled-controls-do-not-send-mutations-or-checks", async () => {
    await row(0).locator('.codex-status [role="switch"], .fingerprint-action-pair button').evaluateAll(buttons => buttons.forEach(button => button.click()));
    check(mutations.length === 0, "disabled quota controls sent requests");
    await page.screenshot({ path: `${evidence}/codex-quota-desktop.png` });
  });
  await test("manual-usage-refresh-immediately-gates-Codex-without-reload", async () => {
    await row(3).getByRole("button", { name: "从 Sub2API 同步用量", exact: true }).click();
    await row(3).locator(".usage-state").filter({ hasText: "受限" }).waitFor();
    for (const control of await row(3).locator(".codex-status").getByRole("switch").all()) check(await control.isDisabled(), "fresh quota did not stop a control");
    check(await row(3).getByRole("button", { name: "从 Sub2API 同步用量", exact: true }).isEnabled(), "quota blocked manual usage sync");
  });
  await test("mobile-disabled-layout-and-no-runtime-errors", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await row(0).locator(".codex-status").scrollIntoViewIfNeeded();
    check(await row(0).locator(".codex-status").evaluate(e => e.scrollWidth <= e.clientWidth + 1), "quota Codex cell overflow");
    await page.screenshot({ path: `${evidence}/codex-quota-mobile.png` }); check(errors.length === 0, errors.join("; "));
  });
  await page.unrouteAll({ behavior: "wait" }); return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
