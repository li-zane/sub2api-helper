async page => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__", results = [], errors = [], writes = [], batches = [];
  const check = (value, message) => { if (!value) throw Error(message); };
  const run = async (name, fn) => { try { await fn(); results.push({name,passed:true}); } catch(error) { results.push({name,passed:false,error:error.message}); } };
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  let releaseStatus, releasePolls, emails = [], jobCalls = 0;
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  const pollGate = new Promise(resolve => { releasePolls = resolve; });
  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    if (++jobCalls > 1) await pollGate;
    const response = await route.fetch(), data = await response.json();
    data.jobs = data.jobs.map((job, i) => i > 2 ? job : {
      ...job, status: i === 2 ? "banned" : "completed", autoRepairBlocked: i === 2,
      webSessionStatus: i === 2 ? "banned" : "valid", webSessionAvailable: true,
      canLoginWeb: i !== 1, webLoginPending: i === 1,
      canRegenerate: true, canForceRelogin: true, canRetry: true, canResume: false,
      sub2apiInPool: true, sub2apiEnabled: false,
      sub2apiUsage: {allowed:true,primary:{usedPercent:10},totals:{tokens:1000}},
    });
    data.selection = data.jobs;
    emails = data.jobs.slice(0, 3).map(job => job.email);
    await route.fulfill({json:data});
  });
  await page.route("**/api/sub2api/account-status*", async route => {
    await statusGate;
    await route.fulfill({json:{configured:true,fetchedAt:new Date().toISOString(),accounts:Object.fromEntries(emails.map(email => [email,{
      inPool:true,enabled:false,accountBlocked:true,accountBlockReason:"account_deactivated",usage:{allowed:true,primary:{usedPercent:10}},
    }]))}});
  });
  await page.route(/\/api\/jobs\/[^/]+\/(?:web-login|regenerate|relogin|retry|usage)(?:\?|$)/, async route => {
    writes.push({url:route.request().url(),method:route.request().method()});
    await route.fulfill({json:route.request().url().includes("/usage") ? {usage:{allowed:true,primary:{usedPercent:37},totals:{tokens:2048}}} : {job:{}}});
  });
  await page.route("**/api/jobs/reauthorize-batch", async route => {
    batches.push(route.request().postDataJSON());
    await route.fulfill({json:{started:1,skipped:0}});
  });
  await page.setViewportSize({width:1480,height:1000});
  try {
    await page.reload();await page.locator("tr.job-row").nth(2).waitFor();
    const row = i => page.locator("tr.job-row").nth(i);
    const oauthDisabled = async r => {
      for (const name of ["Codex 授权"]) check(await r.getByRole("button",{name,exact:true}).isDisabled(),`${name} unexpectedly enabled`);
    };
    await run("already-banned-row-ignores-stale-true-OAuth-capabilities", async () => {
      await oauthDisabled(row(2));
      check(await row(2).getByRole("button",{name:"登录 Web",exact:true}).isEnabled(),"manual Web wrongly disabled for banned row");
    });
    await run("fresh-pool-ban-preserves-manual-Web-and-closes-all-OAuth-controls", async () => {
      releaseStatus();
      await row(0).getByRole("button",{name:"登录 Web",exact:true}).waitFor();
      check(await row(0).getByRole("button",{name:"登录 Web",exact:true}).isEnabled(),"pool sync disabled backend-approved manual Web login");
      await oauthDisabled(row(0));
      check(await row(1).getByRole("button",{name:"登录 Web",exact:true}).isDisabled(),"pool sync re-enabled a pending Web attempt");
    });
    await run("batch-OAuth-blocked-for-both-direct-and-pool-synchronized-ban", async () => {
      for (const i of [2,0]) {
        await row(i).getByRole("checkbox").check();
        check(await page.locator(".bulk-button").filter({hasText:/^重新授权$/}).isDisabled(),"batch reauthorization enabled for banned selection");
        check(await page.locator(".bulk-button").filter({hasText:/^检测 Web 会话$/}).isEnabled(),"batch manual Web disabled for eligible banned selection");
        await page.locator(".bulk-more-trigger").click();
        check(await page.getByRole("menuitem",{name:"重新开始授权",exact:true}).count()===0,"duplicate forced authorization remains");
        await page.keyboard.press("Escape");
        await row(i).getByRole("checkbox").uncheck();
      }
    });
    await run("manual-Web-only-and-usage-refresh-keep-original-endpoints", async () => {
      await Promise.all([page.waitForResponse(r => r.url().endsWith("/web-login")),row(0).getByRole("button",{name:"登录 Web",exact:true}).click()]);
      await Promise.all([page.waitForResponse(r => r.url().endsWith("/usage?refresh=1")),row(0).getByRole("button",{name:"从 Sub2API 同步用量",exact:true}).click()]);
      check(writes.some(r=>r.url.endsWith("/web-login")),"missing explicit Web-only endpoint");
      check(writes.some(r=>r.url.endsWith("/usage?refresh=1")),"manual usage refresh was disabled");
      check(!writes.some(r=>/\/(?:regenerate|relogin|retry)$/.test(r.url)),"banned OAuth request escaped frontend gate");
    });
    await run("mixed-forced-authorization-batch-excludes-banned-IDs", async () => {
      await row(0).getByRole("checkbox").check();await row(3).getByRole("checkbox").check();
      check(await page.locator(".bulk-button").filter({hasText:/^重新授权$/}).isDisabled(),"mixed normal batch must not authorize a banned account");
      await row(0).getByRole("checkbox").uncheck();
      await Promise.all([
        page.waitForResponse(r=>r.url().endsWith("/reauthorize-batch")),
        page.locator(".bulk-button").filter({hasText:/^重新授权$/}).click(),
      ]);
      check(batches.length===1 && batches[0].ids.length===1,"mixed batch must include exactly one healthy ID");
      const bannedId=new URL(writes.find(r=>r.url.endsWith("/web-login")).url).pathname.split("/")[3];
      check(!batches[0].ids.includes(bannedId),"banned account leaked into forced batch payload");
    });
    await run("banned-detail-message-points-to-manual-Web-instead-of-OAuth", async () => {
      await row(0).getByRole("button",{name:"查看已登录设备和会话",exact:true}).click();
      const dialog=page.locator(".session-dialog");await dialog.waitFor({state:"visible"});
      check((await dialog.innerText()).includes("可在操作列手动“登录 Web”核查"),"blocked dialog still describes Web as disabled");
      check(!(await dialog.innerText()).includes("确认解封后可使用“重新开始授权”"),"blocked dialog suggests a disabled OAuth entry");
      await page.keyboard.press("Escape");await dialog.waitFor({state:"hidden"});
    });
    await run("no-style-change-or-runtime-errors-desktop-and-375px", async () => {
      await row(0).locator(".actions-cell").scrollIntoViewIfNeeded();
      await row(0).locator(".actions-cell").screenshot({path:`${evidence}/banned-actions.png`});
      await page.setViewportSize({width:375,height:812});
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"mobile document overflow");
      check(errors.length===0,errors.join("; "));
    });
  } finally { releaseStatus();releasePolls();await page.unrouteAll({behavior:"wait"}); }
  return {passed:results.filter(r=>r.passed).length,total:results.length,results,metrics:{mutationEndpoints:writes.map(r=>new URL(r.url).pathname)}};
}
