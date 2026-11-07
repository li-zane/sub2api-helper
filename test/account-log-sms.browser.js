async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], phone = "+5511999999999";
  const check = (v, text) => { if (!v) throw Error(text); }, run = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  page.setDefaultTimeout(6000); page.on("pageerror", e => errors.push(e.message));
  const entries = [{ id: "sms-operation", label: "Codex 重新授权", type: "reauthorize", at: "2026-11-07T05:30:00Z", status: "completed", tags: ["sms"] }, { id: "plain-operation", label: "Web 登录", type: "web_login", at: "2026-11-07T05:20:00Z", status: "completed", tags: [] }];
  const protocol = `[2026-11-07T05:30:00Z] [sms-order] 国家 Brazil（ID 73）；手机号 ${phone}；金额 0.02 USD\nOTP 654321\n<img src=x onerror=window.__smsXss=true>\n`;
  await page.route(/\/api\/jobs\/[^/]+\/logs(?:\?.*)?$/, async route => {
    const u = new URL(route.request().url()), selected = u.searchParams.get("entry"), view = u.searchParams.get("view") || "protocol";
    const credentials = [{ id: "password-current", type: "password", stage: "current", at: "2026-11-07T05:30:00Z", label: "密码 · 当前版本", tags: ["sms"] }];
    await route.fulfill({ json: { view, entries: view === "protocol" ? entries : credentials, selectedId: selected, content: selected ? view === "protocol" ? selected === "sms-operation" ? protocol : "[mfa] TOTP 654321\nEmail OTP 123456" : '{"password":"fixture-password"}' : "", retention: "任务协议日志保留至删除账号" } });
  });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copiedSmsLog = text; } } }));
  const row = page.locator('tr.job-row').filter({ has: page.getByRole("checkbox", { name: "选择 review-1@example.test", exact: true }) }); await row.getByRole("button", { name: "查看协议日志", exact: true }).click();
  const m = page.getByRole("dialog", { name: "账号日志与凭据", exact: true }), sms = m.locator('[data-entry-id="sms-operation"]'), plain = m.locator('[data-entry-id="plain-operation"]');
  await run("SMS label belongs only to involved protocol operation", async () => { await sms.waitFor(); check(await sms.locator('.account-log-sms-tag').innerText() === "接码", "SMS badge missing"); check(await plain.locator('.account-log-sms-tag').count() === 0, "plain login got badge"); });
  await run("actual phone red; OTP/time plain; text safely rendered", async () => {
    await sms.click(); const pre = m.locator('.log-dialog-viewer'); await pre.getByText(phone, { exact: true }).waitFor(); check(await pre.locator('.protocol-log-phone').count() === 1, "OTP/time highlighted as phone"); check(await pre.locator('.protocol-log-phone').evaluate(e => getComputedStyle(e).color) === "rgb(255, 107, 122)", "phone not red"); check((await pre.innerText()).includes("国家 Brazil（ID 73）"), "country missing"); check((await pre.innerText()).includes("OTP 654321"), "OTP changed"); check(await pre.locator('img').count() === 0 && !await page.evaluate(() => window.__smsXss), "HTML injected"); await page.screenshot({ path: evidence + "/sms-log-desktop.png" });
  });
  await run("copy is plain full text with no highlight markup", async () => { const text = await m.locator('.log-dialog-viewer').innerText(); await m.getByRole("button", { name: "复制内容", exact: true }).click(); check(await page.evaluate(() => window.__copiedSmsLog) === text, "copy differs from rendered plain text"); });
  await run("plain operation and credentials never get SMS highlighting", async () => {
    await plain.click(); await m.locator('.log-dialog-viewer').getByText('Email OTP 123456').waitFor(); check(await m.locator('.protocol-log-phone').count() === 0, "plain OTP highlighted"); await m.getByRole("tab", { name: "凭据历史", exact: true }).click(); await m.locator('[data-entry-id="password-current"]').waitFor(); check(await m.locator('.account-log-sms-tag').count() === 0, "credential history tagged as task");
  });
  await run("mobile log rendering fits without runtime errors", async () => {
    await m.getByRole("tab", { name: "协议日志", exact: true }).click(); await sms.click(); await m.locator('.protocol-log-phone').waitFor(); await page.setViewportSize({ width: 375, height: 812 }); check(await m.evaluate(e => e.scrollWidth <= e.clientWidth + 1), "mobile dialog overflows"); check(!errors.length, errors.join("; ")); await page.screenshot({ path: evidence + "/sms-log-mobile.png" });
  });
  await m.getByRole("button", { name: "关闭协议日志", exact: true }).click(); await page.unrouteAll({ behavior: "wait" });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
