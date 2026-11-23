async page => {
  const results = [], errors = [];
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.setDefaultTimeout(6500);
  async function check(name, run) {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); await page.keyboard.press("Escape"); }
  }
  const row = page.locator("tr.job-row").first();
  const chip = label => row.getByRole("button", { name: new RegExp("^" + label + "：") });
  const picker = name => page.getByRole("dialog", { name: "选择" + name });
  const rotation = page.getByRole("dialog", { name: "轮转停止时间" });
  const remark = () => row.locator(".account-remark-button").innerText();
  await page.setViewportSize({ width: 1440, height: 900 });
  await chip("商家").waitFor();
  await check("选择商家、新建车次并写入备注", async () => {
    await chip("商家").click();
    await picker("商家").getByRole("button", { name: "豆姐", exact: true }).click();
    await picker("商家").waitFor({ state: "hidden" });
    await chip("车次").click();
    await picker("车次").getByRole("textbox").fill("晚班车");
    await picker("车次").getByRole("textbox").press("Enter");
    await picker("车次").waitFor({ state: "hidden" });
    if (!(await remark()).endsWith("[商家] 豆姐, [车次] 晚班车。")) throw Error(await remark());
  });
  await check("取消轮转保留原备注，确认后显示停止时间", async () => {
    const before = await remark();
    async function openRotation() {
      await chip("时效").click();
      await picker("时效").getByRole("button", { name: "轮转", exact: true }).click();
      await rotation.waitFor();
    }
    await openRotation();
    await rotation.getByRole("button", { name: "取消" }).click();
    if (await remark() !== before) throw Error("取消改动了备注");
    await openRotation();
    await rotation.getByLabel("停止时间（北京时间）").fill("2027-01-23T10:45");
    await rotation.getByRole("button", { name: "确认修改" }).click();
    await rotation.waitFor({ state: "hidden" });
    if (!(await remark()).endsWith("[时效] 轮转, [停止时间] 2027-01-23 10:45。")) throw Error(await remark());
    await page.reload();
    await row.getByRole("button", { name: /时效：轮转至 2027-01-23 10:45/ }).waitFor();
    await row.locator(".plan-cell").screenshot({ path: evidence + "/plan-tags.png" });
    await openRotation();
    await rotation.getByRole("button", { name: "不指定时间" }).click();
    await rotation.waitFor({ state: "hidden" });
    if (!(await remark()).endsWith("[时效] 轮转。")) throw Error(await remark());
  });
  await check("窄屏标签可选且成本弹窗可保存", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await chip("车次").click();
    const list = picker("车次");
    await list.getByRole("button", { name: "晚班车", exact: true }).waitFor();
    const box = await list.boundingBox();
    if (box.x < 0 || box.x + box.width > 375) throw Error("选项列表溢出视口");
    await list.getByRole("button", { name: "清空车次" }).click();
    await list.waitFor({ state: "hidden" });
    if ((await remark()).includes("[车次]")) throw Error("车次未清空");
    await row.locator(".account-cost-button").click();
    const cost = page.getByRole("dialog", { name: "账号成本", exact: true });
    await cost.getByRole("spinbutton", { name: "账号成本（人民币）" }).fill("12.34");
    await cost.screenshot({ path: evidence + "/account-cost-dialog.png" });
    await cost.getByRole("button", { name: "保存成本" }).click();
    await cost.waitFor({ state: "hidden" });
    if (await row.locator(".account-cost-button").innerText() !== "￥12.34") throw Error("成本未更新");
  });
  await check("页面正常渲染", async () => {
    if (!await page.title() || await page.locator("vite-error-overlay").count() || errors.length) throw Error(errors.join("\n") || "页面异常");
  });
  return { passed: results.filter(result => result.passed).length, total: results.length, results };
}
