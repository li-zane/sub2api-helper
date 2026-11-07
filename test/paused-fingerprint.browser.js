async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], mutations = [];
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } };
  page.on("pageerror", e => errors.push(e.message));
  const old = ["match", "mismatch", "unknown", "match", "error", "match"].map((status, i) => ({ status, checkedAt: `2026-11-01T0${6-i}:00:00Z` }));
  let resumed = false;
  await page.route("**/api/sub2api/account-status*", r => r.fulfill({ json: { configured: false, accounts: {} } }));
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => {
      const quota = [0, 3, 5].includes(i) && !(i === 0 && resumed), rate = i === 4;
      const records = i === 3 ? [] : i === 0 && resumed ? [{ status: "mismatch", checkedAt: "2026-11-07T01:00:00Z" }, ...old.slice(0, 5)] : old;
      const state = { enabled: i === 1 || i === 0 && resumed, models: [{ model: "fixture", expected: "fixture" }], phase: "idle", override: { enabled: false }, recentResults: records, result: null };
      if (i === 5) { delete state.recentResults; state.previousResult = old[0]; }
      return { ...job, status: "completed", autoRepairBlocked: false, webSessionStatus: "absent", sub2apiInPool: true, sub2apiEnabled: true,
        sub2apiRateLimited: rate, sub2apiQuotaRestricted: quota, codexStatusEligible: !quota && !rate,
        sub2apiUsage: { source: "sub2api", primary: { usedPercent: quota ? 100 : 0 }, allowed: !quota },
        overloadDetection: { configured: true, enabled: false, revision: 1, points: [] }, overloadAutoCooldown: { configured: true, enabled: false, revision: 1, settings: { threshold: 5, windowMinutes: 15 } }, modelFingerprint: state };
    });
    await route.fulfill({ json: data });
  });
  await page.route(/\/api\/jobs\/[^/]+\/(?:overload-detection|overload-auto-cooldown|model-fingerprint(?:\/check)?)$/, r => { mutations.push(r.request().url()); return r.fulfill({ json: {} }); });
  await page.route("**/api/jobs/*/model-fingerprint/history", r => r.fulfill({ json: { records: old.map(r => ({ ...r, models: [] })), models: [] } }));
  await page.setViewportSize({ width: 1480, height: 1000 }); await page.reload(); await page.locator("tr.job-row").first().waitFor();
  const row = i => page.locator("tr.job-row").nth(i), bars = i => row(i).locator(".fingerprint-round");
  const snapshot = async i => bars(i).evaluateAll(nodes => nodes.map(e => ({ color: getComputedStyle(e).backgroundColor, title: e.title, key: e.getAttribute("class") })));
  await row(0).locator(".codex-status").scrollIntoViewIfNeeded();
  await row(0).locator(".codex-status").screenshot({ path: `${evidence}/paused-fingerprint.png` });
  await run("quota-and-429-pauses-retain-existing-result-colors-and-time", async () => {
    const reference = await snapshot(1); check(new Set(reference.map(r => r.color)).size === 3, "fixture lacks status colors");
    for (const i of [0, 4]) {
      const current = await snapshot(i);
      check(current.every((r, j) => r.color === reference[j].color), "PAUSED_HISTORY_REPRODUCED: paused historical colors were replaced with gray");
      check(current.every(r => /历史结果/.test(r.title) && /2026\/11\/01/.test(r.title)), "historical timestamp or history label missing");
    }
  });
  await run("ordinary-poll-does-not-clear-reorder-or-restamp-history", async () => {
    const before = await snapshot(0);
    await page.waitForResponse(r => /\/api\/jobs(?:\?|$)/.test(r.url()) && r.request().method() === "GET", { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row .fingerprint-round").length >= 6);
    check(JSON.stringify(await snapshot(0)) === JSON.stringify(before), "unchanged server records changed the displayed history");
  });
  await run("paused-controls-stay-disabled-and-history-remains-readable", async () => {
    for (const i of [0, 4]) {
      for (const control of await row(i).locator('.codex-status [role="switch"], .fingerprint-action-pair button').all()) check(await control.isDisabled(), "pause re-enabled a probe");
      await row(i).locator('.codex-status [role="switch"], .fingerprint-action-pair button').evaluateAll(nodes => nodes.forEach(e => e.click()));
    }
    check(mutations.length === 0, "paused controls submitted a mutation");
    await bars(0).last().click(); await page.getByRole("dialog").waitFor();
    check(await page.getByRole("dialog").getByText("指纹一致", { exact: true }).count() > 0, "history detail inaccessible while paused");
    await page.keyboard.press("Escape");
  });
  await run("manual-disable-gray-empty-gray-and-legacy-result-retained", async () => {
    check(new Set((await snapshot(2)).map(r => r.color)).size === 1, "manual-disable gray behavior changed");
    check(new Set((await snapshot(3)).map(r => r.color)).size === 1 && await row(3).locator(".fingerprint-round.empty").count() === 6, "empty history invented results");
    const legacy = await snapshot(5), reference = await snapshot(1);
    check(legacy.at(-1).color === reference.at(-1).color && /2026\/11\/01/.test(legacy.at(-1).title), "previousResult fallback was grayed or lost");
  });
  await run("only-an-actual-new-record-advances-the-result-strip", async () => {
    const before = await snapshot(0); resumed = true; await page.reload(); await row(0).waitFor();
    const current = await snapshot(0);
    check(current.at(-1).key.includes("mismatch") && /2026\/11\/07/.test(current.at(-1).title), "new result did not advance the strip");
    check(current.slice(0, 5).every((r, i) => r.color === before[i+1].color), "old results changed instead of shifting one slot");
  });
  await run("mobile-paused-history-layout-and-no-runtime-errors", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await row(4).locator(".codex-status").scrollIntoViewIfNeeded();
    check(await row(4).locator(".codex-status").evaluate(e => e.scrollWidth <= e.clientWidth + 1), "Codex history overflows cell");
    check(errors.length === 0, errors.join("; "));
    await page.screenshot({ path: `${evidence}/paused-fingerprint-mobile.png` });
  });
  await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
