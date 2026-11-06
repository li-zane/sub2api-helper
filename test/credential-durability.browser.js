async (page) => {
  const results = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const test = async (name, fn) => { try { await fn(); results.push({ name, passed: true }); } catch (e) { results.push({ name, passed: false, error: e.message }); } };
  await page.setViewportSize({ width: 1440, height: 1000 });
  const row = page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: "选择 review-1@example.test", exact: true }) });
  await row.waitFor();
  let saved = null;
  await page.route("**/api/jobs/*/credentials", async route => {
    if (route.request().method() === "PUT") saved = route.request().postDataJSON();
    return route.fulfill({ json: { credentials: { password: "fixture-password", passwordAvailable: true, totpSecret: saved ? saved.totpSecret : "JBSWY3DPEHPK3PXP", hasTotpKey: !saved, totpSecretAvailable: !saved, sub2apiJson: "{}", persisted: true } } });
  });
  await test("empty-2FA-save-is-local-delete", async () => {
    await row.getByRole("button", { name: "查看或修改账号凭据", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "账号凭据", exact: true });
    await modal.getByLabel("2FA 密钥", { exact: true }).fill("");
    await modal.getByRole("button", { name: "保存凭据", exact: true }).click();
    await modal.getByText("凭据已更新并保存", { exact: true }).waitFor();
    check(saved?.totpSecret === "", "empty key was rejected or omitted");
    await page.screenshot({ path: "__UI_TEST_EVIDENCE_DIR__" + "/credential-delete-desktop.png" });
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
  });
  await test("invalid-nonempty-2FA-remains-rejected", async () => {
    saved = null;
    await row.getByRole("button", { name: "查看或修改账号凭据", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "账号凭据", exact: true });
    await modal.getByLabel("2FA 密钥", { exact: true }).fill("invalid-key");
    await modal.getByRole("button", { name: "保存凭据", exact: true }).click();
    await modal.getByRole("alert").waitFor(); check(saved === null, "invalid key sent to server");
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
  });
  await page.route(/\/api\/jobs\/[^/]+\/logs(?:\?|$)/, route => route.fulfill({ json: { logs: route.request().url().includes("credentials=1") ? "FIRST_EVENT\n凭据历史 old fixture key -> new fixture key\nactivation_pending\nfailed_preserved" : "recent output" } }));
  await test("credential-history-is-explicit-and-readable", async () => {
    await row.getByRole("button", { name: "查看协议日志", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "协议日志", exact: true });
    await modal.getByText("recent output", { exact: true }).waitFor();
    await modal.getByRole("button", { name: "完整日志与凭据历史", exact: true }).click();
    await modal.locator("pre").filter({ hasText: "FIRST_EVENT" }).waitFor();
    check((await modal.locator("pre").innerText()).includes("activation_pending"), "candidate stage missing");
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
  });
  await test("mobile-history-and-save-controls", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await row.getByRole("button", { name: "查看协议日志", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "协议日志", exact: true });
    await modal.getByRole("button", { name: "完整日志与凭据历史", exact: true }).click();
    await modal.locator("pre").filter({ hasText: "FIRST_EVENT" }).waitFor();
    await page.screenshot({ path: "__UI_TEST_EVIDENCE_DIR__" + "/history-mobile.png" });
    const rect = await modal.boundingBox(); check(rect.x >= 0 && rect.x + rect.width <= 376, "mobile modal escaped viewport");
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click(); check(errors.length === 0, errors.join("; "));
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
