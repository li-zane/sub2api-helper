async (page) => {
  const results = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  const search = page.getByRole("textbox", { name: "搜索账号", exact: true });
  const row = () => page.locator("tr.job-row").filter({ has: page.getByRole("checkbox", { name: "选择 review-1@example.test", exact: true }) });

  await test("Web-state-filter", async () => {
    const filter = page.getByRole("combobox", { name: "筛选 Web 登录态", exact: true });
    check(await filter.count() === 1, "Web state control missing");
    const inactiveColor = await filter.evaluate(element => getComputedStyle(element).color);
    await filter.selectOption("valid");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 0);
    check(await page.getByRole("heading", { name: "没有匹配账号" }).count() === 1, "filtered empty state missing");
    const activeColor = await filter.evaluate(element => getComputedStyle(element).color);
    await filter.selectOption("");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
    check(activeColor !== inactiveColor, "Web filter active styling does not follow its selected value");
  });

  await test("banned-account-Web-state", async () => {
    const filter = page.getByRole("combobox", { name: "筛选 Web 登录态", exact: true });
    await filter.selectOption("banned");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 1);
    const banned = page.locator("tr.job-row");
    check(await banned.getByText("账号封禁", { exact: true }).isVisible(), "ban must override the ordinary Web state");
    check(await banned.getByRole("button", { name: "登录 Web", exact: true }).isEnabled(), "known bans must retain the explicit manual Web-only login");
    check((await banned.getByRole("button", { name: "登录 Web", exact: true }).getAttribute("title")).includes("不执行 Codex 授权"), "manual Web login must explain the ban and OAuth boundary");
    for (const name of ["Codex 授权"]) check(await banned.getByRole("button", { name, exact: true }).isDisabled(), "banned OAuth must remain disabled: " + name);
    check(await banned.locator(".bound-ip-cell").innerText() === "未绑定", "released ban must not appear as direct or bound");
    let reads = 0;
    const providerReads = /\/api\/jobs\/[^/]+\/(?:sessions|workspaces)$/;
    await page.route(providerReads, route => { reads++; return route.fulfill({ json: {} }); });
    try {
      for (const [button, title, refresh] of [["查看已登录设备和会话", "已登录设备与会话", "刷新设备列表"], ["查看并切换工作空间", "工作空间", "刷新工作空间"]]) {
        await banned.getByRole("button", { name: button, exact: true }).click();
        const modal = page.getByRole("dialog", { name: title, exact: true });
        check(await modal.getByText("账号已封禁", { exact: true }).isVisible(), title+": confirmed ban explanation missing");
        check((await modal.innerText()).includes("已停止读取设备、会话和工作空间"), "ban does not explain stopped actions");
        check(await modal.getByRole("button", { name: refresh, exact: true }).isDisabled(), "banned dialog still allows refresh");
        check(await modal.getByRole("button", { name: "重试", exact: true }).count() === 0, "banned dialog must not suggest retry");
        check(await modal.locator(".dialog-count-pill").count() === 0, "ban must not show a misleading zero count");
        await modal.getByRole("button", { name: title === "工作空间" ? "关闭工作空间" : "关闭已登录设备与会话", exact: true }).click();
      }
      check(reads === 0, "opening known-ban dialogs must not request upstream data");
    } finally { await page.unroute(providerReads); }
    await filter.selectOption("");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  });

  await test("open-dialog-updates-on-ban", async () => {
    let blocked = false;
    const jobsPattern = /\/api\/jobs(?:\?|$)/;
    await page.route(jobsPattern, async route => {
      const response = await route.fetch(); const data = await response.json();
      if (blocked) data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? { ...job, status: "banned", autoRepairBlocked: true, webSessionStatus: "banned", autoRepairBlockedReason: "account_deactivated", boundProxyStatus: "unbound" } : job);
      await route.fulfill({ json: data });
    });
    await page.route("**/api/jobs/*/sessions", route => route.fulfill({ json: { sessions: { devices: [{ id: "cached", displayName: "Cached browser" }] } } }));
    await page.route("**/api/jobs/*/workspaces", route => route.fulfill({ json: { workspaces: { workspaces: [{ id: "cached", name: "Cached workspace", structure: "personal", planType: "free", current: true }] } } }));
    try {
      for (const [button,title] of [["查看已登录设备和会话","已登录设备与会话"],["查看并切换工作空间","工作空间"]]) {
        blocked = false; await page.reload();
        await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
        await row().getByRole("button", { name: button, exact: true }).click();
        const modal=page.getByRole("dialog", { name: title, exact: true });
        await modal.getByText(title === "工作空间" ? "Cached workspace" : "Cached browser", { exact: true }).waitFor();
        blocked = true;
        await modal.getByText("账号已封禁", { exact: true }).waitFor();
        check((await modal.innerText()).includes("account_deactivated"), "live ban reason missing");
        check(await modal.locator(".session-list,.workspace-list").count() === 0, "cached records survive a confirmed ban");
        await modal.getByRole("button", { name: title === "工作空间" ? "关闭工作空间" : "关闭已登录设备与会话", exact: true }).click();
      }
    } finally {
      await page.unroute(jobsPattern); await page.unroute("**/api/jobs/*/sessions"); await page.unroute("**/api/jobs/*/workspaces");
      await page.reload(); await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
    }
  });

  await test("web-relogin-cooldown-explanation", async () => {
    const jobsPattern = /\/api\/jobs(?:\?|$)/;
    await page.route(jobsPattern, async route => {
      const response=await route.fetch(); const data=await response.json();
      data.jobs=data.jobs.map(job=>job.email === "review-1@example.test" ? { ...job,webSessionStatus:"expired",webLoginError:"previous login failed",webSessionRepairRetryAt:"2026-11-04T14:16:57.007Z" } : job);
      await route.fulfill({ json:data });
    });
    try {
      await page.reload();
      await row().locator(".operation-feedback-trigger").click();
      const detail = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
      const text = await detail.locator("pre").innerText();
      check(text.includes("Web 自动重登冷却中") && text.includes("到期后由巡检调度"), "cooldown must explain scheduling after the earliest retry time");
      check(text.includes("可手动检测 Web 会话，确认失效后立即重登"), "manual retry must remain discoverable");
      await page.keyboard.press("Escape");
      check(await row().getByRole("button",{name:"检测 Web 会话",exact:true}).isEnabled(),"cooldown must not block a manual login");
    } finally { await page.unroute(jobsPattern); await page.reload(); await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20); }
  });

  await test("plan-and-Web-credential-sync", async () => {
    let mode="pending_update";
    const jobsPattern=/\/api\/jobs(?:\?|$)/;
    await page.route(jobsPattern,async route=>{
      const response=await route.fetch();const data=await response.json();
      data.jobs=data.jobs.map(job=>job.email === "review-1@example.test" ? {...job,planType:"free",webSessionStatus:mode==="read_failed"?"unavailable":mode==="pending_update"?"expired":"valid",webSessionReadError:mode==="read_failed"?"EACCES":null,webCredentialSync:{status:mode,reason:mode==="read_failed"?"EACCES":"workspace_mismatch",webPlanType:mode==="pending_update"?"team":"free",planType:"free"}}:job);
      await route.fulfill({json:data});
    });
    try {
      for(const [state,label] of [["pending_update","Web 凭据待更新"],["refreshing","Web 凭据更新中"],["read_failed","Web 凭据读取失败"],["authorization_pending","Codex 凭据待更新"],["synced",null]]){
        mode=state;await page.reload();await page.waitForFunction(()=>document.querySelectorAll("tr.job-row").length===20);
        check(await row().locator(".plan-tag").innerText()==="Free","sync status must not replace the current Free plan");
        if(label){
          const note=row().locator(".credential-sync-note");await note.waitFor();check(await note.innerText()===label,"credential sync label missing: "+state);
          if(state==="pending_update")check((await note.getAttribute("title")).includes("签发时套餐：Team"),"old Web token plan missing from tooltip");
          if(state==="read_failed"){
            check((await note.getAttribute("title")).includes("EACCES"),"permission error code missing");
            check(await row().getByText("Web读取失败",{exact:true}).isVisible(),"permission error still presented as Web expiry");
          }
        }else check(await row().locator(".credential-sync-note").count()===0,"resolved sync warning persists");
      }
    }finally{await page.unroute(jobsPattern);await page.reload();await page.waitForFunction(()=>document.querySelectorAll("tr.job-row").length===20);}
  });

  await test("exact-email-list-filter", async () => {
    const button = page.getByRole("button", { name: "邮箱列表筛选", exact: true });
    check(await button.count() === 1, "email-list control missing");
    await button.click();
    await page.getByRole("textbox", { name: "每行一个邮箱（最多 500 个）" }).fill("review-1@example.test\nreview-2@example.test");
    await page.getByRole("button", { name: "应用邮箱筛选", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 2);
    await page.getByRole("button", { name: "清除全部筛选", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
  });

  await test("effective-plan-search", async () => {
    await search.fill("business");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length <= 1);
    check(await row().count() === 1, "visible business plan not searchable");
  });
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);

  await test("HelpTip-keyboard", async () => {
    const help = page.getByRole("button", { name: "查看控制台说明", exact: true });
    check(await help.evaluate(e => e.tabIndex >= 0), "help removed from Tab order");
    await help.focus();
    await page.waitForFunction(() => !!document.querySelector('[role="tooltip"]'));
    check(await help.evaluate(e => !!document.getElementById(e.getAttribute("aria-describedby"))), "tooltip not associated with trigger");
    await page.keyboard.press("Escape");
    check(await page.getByRole("tooltip").count() === 0, "Escape does not dismiss help");
  });

  await test("proxy-modal-focus-and-Escape", async () => {
    const trigger = page.getByRole("region", { name: "代理 IP 配置", exact: true }).getByRole("button", { name: "配置", exact: true });
    await trigger.click();
    const modal = page.getByRole("dialog", { name: "代理 IP 配置与检测", exact: true });
    try {
      check(await modal.evaluate(e => e.contains(document.activeElement)), "focus stays behind proxy modal");
      check(await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).evaluate(e => e === document.activeElement), "proxy modal initially focuses the help trigger instead of the close button");
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens automatically on dialog entry");
      await modal.getByRole("button", { name: "查看代理 IP 配置说明", exact: true }).focus();
      await page.waitForFunction(() => !!document.querySelector('dialog [role="tooltip"]'));
      await page.keyboard.press("Escape");
      check(await modal.getByRole("tooltip").count() === 0 && await modal.count() === 1, "Escape must dismiss help before closing the dialog");
      for (let i = 0; i < 15; i++) {
        await page.keyboard.press("Tab");
        check(await modal.evaluate(e => e.contains(document.activeElement)), "Tab escaped modal");
      }
      await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).focus();
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "Escape does not close proxy modal");
      check(await trigger.evaluate(e => document.activeElement === e), "focus not restored to trigger");
    } finally {
      if (await modal.count()) await modal.getByRole("button").filter({ hasText: /^关闭$/ }).first().click().catch(async () => { await modal.locator(".dialog-header .icon-button").last().click(); });
    }
  });

  await test("log-modal-focus-and-Escape", async () => {
    const trigger = row().getByRole("button", { name: "查看协议日志", exact: true });
    await trigger.click();
    const modal = page.getByRole("dialog", { name: "账号日志与凭据", exact: true });
    try {
      check(await modal.evaluate(e => e.contains(document.activeElement)), "focus stays behind log modal");
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "Escape does not close log modal");
      check(await trigger.evaluate(e => document.activeElement === e), "log focus not restored");
    } finally {
      if (await modal.count()) await modal.locator(".dialog-header .icon-button").last().click();
    }
  });

  await test("batch-row-mutual-exclusion", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route("**/api/jobs/reauthorize-batch", async route => { await pending; await route.fulfill({ json: {} }); });
    try {
      await row().getByRole("checkbox").check();
      await page.locator(".bulk-actions").getByRole("button", { name: "重新授权", exact: true }).click();
      await page.waitForSelector(".workflow-busy");
      for (const name of ["Codex 授权", "检测 Web 会话"]) {
        check(await row().getByRole("button", { name, exact: true }).isDisabled(), name + " enabled while batch busy");
      }
      for (const name of ["设置 2FA", "添加密码"]) {
        check(await row().getByRole("button", { name, exact: true }).count() === 0, name + " still appears in the row action column");
      }
      for (const name of ["查看协议日志", "查看或修改账号凭据", "查看已登录设备和会话", "查看并切换工作空间", "下载导入文件"]) {
        check(await row().getByRole("button", { name, exact: true }).isEnabled(), name + " unnecessarily disabled while batch busy");
      }
      check((await row().getByRole("button", { name: "检测 Web 会话", exact: true }).getAttribute("title")).includes("批量操作"), "batch lock does not explain the reason");
    } finally {
      release();
      await page.waitForFunction(() => !document.querySelector(".workflow-busy"));
      await page.unroute("**/api/jobs/reauthorize-batch");
    }
  });

  await test("Web-session-check-controls-and-progress", async () => {
    let single = 0, batches = 0, forced = 0;
    const id = "11111111-1111-4111-8111-000000000001";
    const paths = ["**/api/jobs/*/web-session-check", "**/api/jobs/web-session-check-batch", "**/api/jobs/web-session-check-progress", "**/api/jobs/*/web-login"];
    await page.route(paths[0], route => { single++; return route.fulfill({ json: { job: { id } } }); });
    await page.route(paths[1], route => { batches++; return route.fulfill({ json: { jobs: [{ id, webSessionCheckAttemptId: "check-"+batches }], failed: [], skippedJobs: [] } }); });
    await page.route(paths[2], route => route.fulfill({ json: { progress: [{ id, email: "review-1@example.test", phase: batches === 1 ? "failed" : "success", error: batches === 1 ? "HTTP 503" : null, renewed: false }] } }));
    await page.route(paths[3], route => { forced++; return route.fulfill({ json: {} }); });
    try {
      await row().getByRole("button", { name: "检测 Web 会话", exact: true }).click();
      check(single === 1 && forced === 0, "row control must check before login");
      await row().getByRole("checkbox").check();
      await page.locator(".bulk-actions").getByRole("button", { name: "检测 Web 会话", exact: true }).click();
      const progress = page.getByRole("region", { name: "Web 会话检测批次", exact: true });
      await progress.getByRole("status").filter({ hasText: "失败 1" }).waitFor();
      await progress.getByRole("button", { name: "仅重试失败项", exact: true }).click();
      await progress.getByRole("status").filter({ hasText: "成功 1" }).waitFor();
      check(batches === 2 && forced === 0, "failed retries must return to session checks");
      check((await progress.innerText()).includes("检测中"), "check phase must have a visible label");
      await progress.getByRole("button", { name: "关闭进度", exact: true }).click();
      await row().getByRole("checkbox").uncheck();
    } finally { for (const url of paths) await page.unroute(url); }
  });

  await test("single-Web-check-pending-and-error", async () => {
    let pending = true;
    const pattern = /\/api\/jobs(?:\?|$)/;
    await page.route(pattern, async route => {
      const response = await route.fetch(), data = await response.json();
      data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? { ...job, canLoginWeb: !pending, webSessionCheckPending: pending, webSessionCheckStatus: pending ? "checking" : "failed", webSessionCheckError: pending ? null : "HTTP 503" } : job);
      await route.fulfill({ json: data });
    });
    try {
      await page.reload();
      await row().locator(".operation-feedback-trigger").click();
      let detail = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
      check((await detail.locator("pre").innerText()).includes("正在检测 Web 会话并核对套餐与自动化开关"), "pending check feedback missing from operation details");
      await page.keyboard.press("Escape");
      check(await row().getByRole("button", { name: "检测 Web 会话", exact: true }).isDisabled(), "pending check allows duplicate submission");
      pending = false; await page.reload();
      await row().locator(".operation-feedback-trigger").click();
      detail = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
      const text = await detail.locator("pre").innerText();
      check(text.includes("Web 会话检测失败") && text.includes("HTTP 503"), "check error code missing from operation details");
      await page.keyboard.press("Escape");
      check(await row().getByRole("button", { name: "检测 Web 会话", exact: true }).isEnabled(), "failed check cannot retry");
    } finally { await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20); }
  });

  await test("Web-maintenance-pause-explains-manual-resume", async () => {
    const pattern = /\/api\/jobs(?:\?|$)/;
    await page.route(pattern, async route => {
      const response = await route.fetch(), data = await response.json();
      data.jobs = data.jobs.map(job => job.email === "review-1@example.test"
        ? { ...job, webSessionMaintenancePause: { reason: "logout", at: "2026-11-01T00:00:00Z" } } : job);
      await route.fulfill({ json: data });
    });
    try {
      await page.reload();
      await row().locator(".operation-feedback-trigger").click();
      const detail = page.getByRole("dialog", { name: "最近操作反馈", exact: true });
      const text = await detail.locator("pre").innerText();
      check(text.includes("Web 自动维护已暂停") && text.includes("已主动登出；手动检测或重新登录可恢复。"), "maintenance pause explanation missing");
      await page.keyboard.press("Escape");
      check(await row().getByRole("button", { name: "检测 Web 会话", exact: true }).isEnabled(), "paused maintenance prevents manual resume");
    } finally { await page.unroute(pattern); await page.reload(); await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20); }
  });

  await test("authorization-buttons-phone-and-checkpoint-states", async () => {
    let mode = "phone", single = 0;
    const pattern = /\/api\/jobs(?:\?|$)/;
    await page.route(pattern, async route => {
      const response = await route.fetch(), data = await response.json();
      data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? {
        ...job, status: mode === "phone" ? "phone" : "canceled", canDownload: true,
        canLoginWeb: mode !== "phone", canForceRelogin: mode !== "phone", canRegenerate: false,
        canRetry: mode !== "phone", canResume: mode === "continue", canSetupTotp: false,
        canAddPassword: false, canLogoutAllSessions: mode !== "phone", webSessionAvailable: true,
        webSessionStatus: "valid", prompt: "请输入需要绑定的手机号", poolRefreshAction: mode === "phone" ? "reauthorize" : null,
      } : job);
      await route.fulfill({ json: data });
    });
    const mutations = ["**/api/jobs/*/authorize"];
    await page.route(mutations[0], route => { single++; return route.fulfill({ json: {} }); });
    try {
      await page.reload();
      await row().getByRole("button", { name: "取消任务", exact: true }).waitFor();
      for (const name of ["检测 Web 会话", "Codex 授权", "登出所有设备"]) {
        const button = row().getByRole("button", { name, exact: true });
        check(await button.isDisabled(), name + " overlaps phone input");
        check((await button.getAttribute("title")).includes("等待绑定手机号"), name + " hides phone lock reason");
      }
      for (const name of ["查看或修改账号凭据", "查看已登录设备和会话", "查看并切换工作空间", "下载导入文件"]) {
        check(await row().getByRole("button", { name, exact: true }).isEnabled(), name + " blocked during phone input");
      }
      for (mode of ["continue", "missing"]) {
        await page.reload();
        const button = row().getByRole("button", { name: "Codex 授权", exact: true });
        check(await button.isEnabled(), "single OAuth entry disabled for " + mode);
        for (const name of ["继续授权", "重试授权", "重新开始授权"]) check(await row().getByRole("button", {name,exact:true}).count() === 0, "duplicate authorization entry remains");
        await Promise.all([page.waitForResponse(r => r.url().endsWith('/authorize')), button.click()]);
      }
      check(single === 2, "both terminal states must use the unified endpoint");
    } finally { await page.unrouteAll({ behavior: "wait" }); await page.reload(); }
  });

  await test("read-dialogs-preserve-mutation-locks", async () => {
    const pattern = /\/api\/jobs(?:\?|$)/;
    await page.route(pattern, async route => {
      const response = await route.fetch(), data = await response.json();
      data.jobs = data.jobs.map(job => job.email === "review-1@example.test" ? {
        ...job, status: "phone", canForceRelogin: false, canLoginWeb: false, canLogoutAllSessions: false,
        canReplaceTotp: false, canDownload: true, webSessionAvailable: true,
      } : job);
      await route.fulfill({ json: data });
    });
    await page.route("**/api/jobs/*/credentials", route => route.fulfill({ json: { credentials: { password: "fixture", passwordAvailable: true, sub2apiJson: "{}" } } }));
    await page.route("**/api/jobs/*/sessions", route => route.fulfill({ json: { sessions: { devices: [{ id: "other", sessionId: "other-session", displayName: "Other browser", isCurrentDevice: false }] } } }));
    await page.route("**/api/jobs/*/workspaces", route => route.fulfill({ json: { workspaces: { currentWorkspaceId: "a", workspaces: [{ id: "b", name: "Other workspace", structure: "personal", availability: "available", canAccessWithSession: true }] } } }));
    try {
      await page.reload();
      await row().getByRole("button", { name: "查看或修改账号凭据", exact: true }).click();
      let modal = page.getByRole("dialog", { name: "账号凭据", exact: true });
      await modal.getByText("当前仅查看凭据。", { exact: false }).waitFor();
      check(await modal.getByRole("textbox", { name: "密码", exact: true }).getAttribute("readonly") !== null, "credentials remain editable while phone login waits");
      check(await modal.getByRole("button", { name: "保存凭据", exact: true }).isDisabled(), "credential read unlocks save");
      await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
      await row().getByRole("button", { name: "查看已登录设备和会话", exact: true }).click();
      modal = page.getByRole("dialog", { name: "已登录设备与会话", exact: true });
      await modal.getByText("Other browser", { exact: true }).waitFor();
      check(await modal.getByRole("button", { name: "登出 Other browser", exact: true }).isDisabled(), "session read unlocks device logout");
      check(await modal.getByRole("button", { name: "一键登出所有设备", exact: true }).isDisabled(), "session read unlocks logout-all");
      await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
      await row().getByRole("button", { name: "查看并切换工作空间", exact: true }).click();
      modal = page.getByRole("dialog", { name: "工作空间", exact: true });
      await modal.getByText("Other workspace", { exact: true }).waitFor();
      check(await modal.locator(".workspace-item").isDisabled(), "workspace read unlocks switch");
      check((await modal.locator(".workspace-item").getAttribute("title")).includes("等待绑定手机号"), "switch lock lacks reason");
      await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await page.reload();
    }
  });

  await test("mobile-action-column", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    check(await row().locator(".actions-cell").evaluate(e => getComputedStyle(e).position === "static"), "sticky actions obscure mobile table");
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "document horizontally overflows");
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await test("search-empty-state", async () => {
    await search.fill("definitely-no-match-987");
    await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 0);
    check(await page.getByRole("heading", { name: "没有匹配账号", exact: true }).count() === 1, "no-results presented as empty database");
    check(!await page.locator(".empty-state").innerText().then(text => text.includes("输入邮箱地址")), "obsolete add-email instruction");
  });
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);

  await test("proxy-distribution-scope", async () => {
    const routes = ["**/api/account-proxy-settings", "**/api/sub2api/settings", "**/api/sub2api/options", "**/api/sub2api/monitor"];
    const poolSettings = { configured: true, hasAdminApiKey: true, config: { baseUrl: "https://pool.example.test", groupIds: [] }, enabled: false };
    await page.route(routes[0], route => route.fulfill({ json: { settings: { mode: "plan", proxyUrl: "", allowDirectFallback: false } } }));
    await page.route(routes[1], route => route.fulfill({ json: poolSettings }));
    await page.route(routes[2], route => route.fulfill({ json: { groups: [], proxies: [{ id: 1, name: "测试出口", ipAddress: "198.51.100.10", accountCount: 7 }], directAccountCount: 3 } }));
    await page.route(routes[3], route => route.fulfill({ json: poolSettings }));
    try {
      await page.reload();
      const trigger = page.getByRole("region", { name: "代理 IP 配置", exact: true }).getByRole("button", { name: "配置", exact: true });
      await trigger.click();
      const modal = page.getByRole("dialog", { name: "代理 IP 配置与检测", exact: true });
      await modal.getByText("未分配代理 · 3 个 OAuth 账号", { exact: true }).waitFor();
      check(await modal.getByText("测试出口 · 198.51.100.10 · 7 个 OAuth 账号", { exact: true }).count() === 1, "per-IP count does not identify its OAuth-only scope");
      const scope = await modal.locator(".proxy-distribution-scope").innerText();
      check(scope.includes("仅统计 OAuth 账号") && scope.includes("不含 API Key") && scope.includes("未完成授权") && scope.includes("不代表实时直连流量"), "proxy distribution scope remains ambiguous");
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens automatically in PlanType mode");
      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "first Escape should close the untouched proxy modal");
      await trigger.click();
      check(await modal.getByRole("tooltip").count() === 0, "proxy help opens on repeated dialog entry");
      await modal.getByRole("button", { name: "关闭代理 IP 配置", exact: true }).click();
    } finally {
      for (const route of routes) await page.unroute(route);
      await page.reload();
    }
  });
  await test("web-session-monitor-settings", async () => {
    await page.getByRole("button", { name: "任务设置", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "任务设置", exact: true });
    const enabled = modal.getByRole("checkbox", { name: "启用 WebSession 定时检测", exact: true });
    check(!await enabled.isChecked(), "session monitor must default off");
    const interval = modal.getByLabel("检测间隔（分钟）", { exact: true });
    check(await interval.isDisabled(), "interval is enabled while monitor is off");
    await enabled.check();
    check(await interval.isEnabled() && await interval.inputValue() === "15", "monitor interval defaults/control broken");
    check(await modal.getByRole("checkbox", { name: "确认失效或空间变化后自动重登并授权", exact: true }).isChecked(), "auto-relogin default missing");
    await modal.getByRole("button", { name: "取消", exact: true }).click();
  });

  await test("usage-quota-and-reset-cards", async () => {
    await page.setViewportSize({ width: 1307, height: 900 });
    const jobsPattern = /\/api\/jobs(?:\?|$)/;
    await page.route(jobsPattern, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      if (Array.isArray(data.jobs)) {
        data.jobs = data.jobs.map((job, idx) => {
          if (idx === 0) {
            return {
              ...job,
              canDownload: true,
              sub2apiUsage: {
                source: "sub2api",
                allowed: true,
                limitReached: false,
                fetchedAt: "2026-11-04T06:00:00Z",
                primary: { usedPercent: 24, limitWindowSeconds: 18000, resetAfterSeconds: 7200 },
                secondary: { usedPercent: 48, limitWindowSeconds: 604800, resetAfterSeconds: 172800 },
                credits: { hasCredits: true, unlimited: false, balance: "250.0000000000", overageLimitReached: false },
                resetCredits: { availableCount: 0, credits: [] },
              },
            };
          }
          if (idx === 1) {
            return {
              ...job,
              canDownload: true,
              sub2apiUsage: {
                source: "sub2api",
                allowed: true,
                limitReached: false,
                primary: { usedPercent: 62, limitWindowSeconds: 18000, resetAfterSeconds: 3600 },
                credits: { hasCredits: true, unlimited: false, balance: "961.5884507500", overageLimitReached: false },
                resetCredits: { availableCount: 2, credits: [{ expiresAt: "2026-12-01T00:00:00Z" }] },
              },
            };
          }
          if (idx === 2) {
            return {
              ...job,
              canDownload: true,
              sub2apiUsage: {
                source: "sub2api",
                allowed: true,
                limitReached: false,
                primary: { usedPercent: 10, limitWindowSeconds: 18000, resetAfterSeconds: 1800 },
                credits: { hasCredits: true, unlimited: false, balance: "0", overageLimitReached: false },
                resetCredits: null,
              },
            };
          }
          if (idx === 3) {
            return {
              ...job,
              canDownload: true,
              sub2apiUsage: {
                source: "sub2api",
                allowed: true,
                limitReached: false,
                primary: { usedPercent: 15, limitWindowSeconds: 18000, resetAfterSeconds: 1800 },
                credits: { hasCredits: false, unlimited: false, balance: null, overageLimitReached: false },
                resetCredits: null,
              },
            };
          }
          if (idx === 4) {
            return {
              ...job,
              canDownload: true,
              sub2apiUsage: {
                source: "sub2api",
                allowed: true,
                limitReached: false,
                primary: { usedPercent: 15, limitWindowSeconds: 18000, resetAfterSeconds: 1800 },
                credits: { hasCredits: false, unlimited: false, balance: "invalid-value", overageLimitReached: false },
                resetCredits: { availableCount: 1, credits: [] },
              },
            };
          }
          return job;
        });
      }
      await route.fulfill({ json: data });
    });
    try {
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll(".usage-meta-pills").length >= 5);
      const rows = page.locator("tr.job-row");
      const row0Pills = rows.nth(0).locator(".usage-meta-pills");
      check((await row0Pills.locator(".usage-window").innerText()).trim() === "额度 250.00", "250.0000000000 not formatted as 250.00");
      check((await row0Pills.locator(".usage-reset-credits").innerText()).trim() === "重置卡 0 张", "0 reset cards not shown as 0 张");
      check(await row0Pills.locator(".usage-window").getAttribute("title") === "额度 250.0000000000", "raw balance not preserved in title");
      const box0Quota = await row0Pills.locator(".usage-window").boundingBox();
      const box0Reset = await row0Pills.locator(".usage-reset-credits").boundingBox();
      check(Math.abs(box0Quota.y - box0Reset.y) <= 2 && Math.abs(box0Quota.height - box0Reset.height) <= 1, "quota and reset card pills are not aligned on the same row at 1307px");

      const row1Pills = rows.nth(1).locator(".usage-meta-pills");
      check((await row1Pills.locator(".usage-window").innerText()).trim() === "额度 961.59", "961.5884507500 not rounded to 961.59");
      check((await row1Pills.locator(".usage-reset-credits").innerText()).trim() === "重置卡 2 张", "positive reset card count missing");
      check((await row1Pills.locator(".usage-reset-credits").getAttribute("title") || "").includes("重置卡到期时间："), "reset card expiration tooltip missing");

      const row2Pills = rows.nth(2).locator(".usage-meta-pills");
      check((await row2Pills.locator(".usage-window").innerText()).trim() === "额度 0.00", "0 balance not formatted as 0.00");
      check((await row2Pills.locator(".usage-reset-credits").innerText()).trim() === "重置卡 未知", "null resetCredits not shown as 未知");
      const zeroBorder = await row0Pills.locator(".usage-reset-credits").evaluate(e => getComputedStyle(e).borderStyle);
      const unknownBorder = await row2Pills.locator(".usage-reset-credits").evaluate(e => getComputedStyle(e).borderStyle);
      check(zeroBorder !== unknownBorder, "0 张 and 未知 reset card pills are not visually distinguished");

      const row3Pills = rows.nth(3).locator(".usage-meta-pills");
      check(await row3Pills.locator(".usage-window").count() === 0, "null balance must not be converted to 0.00");
      const row4Pills = rows.nth(4).locator(".usage-meta-pills");
      check(await row4Pills.locator(".usage-window").count() === 0, "invalid balance must not be converted to 0.00");
    } finally {
      await page.unroute(jobsPattern);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length === 20);
    }
  });

  await test("session-dialog-ui-and-states", async () => {
    let mode = "list";
    await page.route("**/api/jobs/*/sessions", async (route) => {
      if (mode === "error") {
        return route.fulfill({ status: 502, json: { error: "上游网关连接超时 (502)" } });
      }
      if (mode === "empty") {
        return route.fulfill({ json: { sessions: { devices: [] } } });
      }
      return route.fulfill({
        json: {
          sessions: {
            devices: [
              {
                id: "dev-current",
                sessionId: "sess-1",
                displayName: "MacBook Pro",
                description: "MacBook Pro · macOS 15.1 Sequoia Ultra-Long-Device-Identifier-Name-For-Overflow-Check",
                platform: "macos",
                osVersion: "15.1",
                isCurrentDevice: true,
                isTrustedDevice: true,
                lastSignedInTimestamp: 1790000000,
                lastSignedInCity: "San Francisco",
                lastSignedInRegionCode: "CA",
                lastSignedInCountry: "US",
                lastSignedInIp: "2001:db8:abcd:1234:5678:9012:3456:7890",
                helperLoginProxy: { kind: "proxy", name: "Helper-Login-Proxy-Long-Node-Name-For-Mobile-Overflow-Check", proxyId: "12", recordedAt: "2026-11-05T01:00:00Z" },
                appSessions: ["Codex CLI", "ChatGPT Web"],
              },
              {
                id: "dev-other",
                deviceIdHash: "hash-2",
                displayName: "Windows Workstation",
                description: "Windows 11 Pro",
                platform: "windows",
                osVersion: "11",
                isCurrentDevice: false,
                isTrustedDevice: false,
                lastSignedInTimestamp: 1789900000,
                lastSignedInCity: "Tokyo",
                lastSignedInCountry: "JP",
                lastSignedInIp: null,
                appSessions: [],
              },
            ],
          },
        },
      });
    });
    try {
      const trigger = row().getByRole("button", { name: "查看已登录设备和会话", exact: true });
      await trigger.click();
      const modal = page.getByRole("dialog", { name: "已登录设备与会话", exact: true });
      await modal.locator(".session-item").first().waitFor();
      check(await modal.getByRole("tooltip").count() === 0, "session IP HelpTip must not auto-open on dialog entry");
      check(await modal.getByRole("button", { name: "关闭已登录设备与会话", exact: true }).evaluate(e => e === document.activeElement), "initial focus not on session dialog close button");
      check(await modal.locator(".session-item.current .session-badge.current").innerText() === "当前会话", "current session badge missing");
      check(await modal.locator(".session-item").first().locator(".session-login-ip code").innerText() === "2001:db8:abcd:1234:5678:9012:3456:7890", "login IP code missing");
      check((await modal.locator(".session-item").nth(1).locator(".session-login-ip").innerText()).includes("上游未提供"), "missing IP must remain 上游未提供");
      check((await modal.locator(".session-item").first().locator(".session-login-proxy").innerText()).includes("Helper-Login-Proxy-Long"), "known Helper login proxy missing");
      check(await modal.locator(".session-item").nth(1).locator(".session-login-proxy").count() === 0, "unknown device must not inherit proxy label");
      check(await modal.locator(".session-item").first().locator(".session-logout-button").isDisabled(), "current device single logout must remain disabled");
      check(await modal.locator(".session-item").nth(1).locator(".session-logout-button").isEnabled(), "secondary device logout should be enabled");
      await page.setViewportSize({ width: 390, height: 700 });
      check(await modal.locator(".session-list").evaluate(e => e.scrollWidth <= e.clientWidth + 1), "long IPv6 creates a horizontal scrollbar on narrow screens");
      check(await modal.locator(".session-login-ip code").evaluate(e => e.getBoundingClientRect().right <= e.closest(".session-item").getBoundingClientRect().right), "IPv6 overflows its device card");
      check(await modal.locator(".session-login-proxy").evaluate(e => e.getBoundingClientRect().right <= e.closest(".session-item").getBoundingClientRect().right), "proxy name overflows device card");
      await page.setViewportSize({ width: 1440, height: 1000 });

      mode = "error";
      await modal.getByRole("button", { name: "刷新设备列表", exact: true }).click();
      await modal.getByRole("alert").waitFor();
      check(await modal.locator(".session-empty").count() === 0, "error state must not simultaneously show empty state");
      const errText = await modal.getByRole("alert").innerText();
      check(errText.includes("上游网关连接超时") && !errText.includes("未登录账号"), "error state message inaccurate");

      mode = "empty";
      await modal.getByRole("button", { name: "重试", exact: true }).click();
      await modal.locator(".session-empty").waitFor();
      check(await modal.getByRole("alert").count() === 0, "alert should clear after empty retry succeeds");

      await page.keyboard.press("Escape");
      check(await modal.count() === 0, "Escape should close session dialog");
      check(await trigger.evaluate(e => e === document.activeElement), "focus not restored after closing session dialog");
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.unroute("**/api/jobs/*/sessions");
    }
  });

  await test("workspace-dialog-ui-and-states", async () => {
    let mode = "list";
    await page.route("**/api/jobs/*/workspaces", async (route) => {
      if (mode === "error") {
        return route.fulfill({ status: 503, json: { error: "工作空间服务暂时不可用 (503)" } });
      }
      return route.fulfill({
        json: {
          workspaces: {
            currentWorkspaceId: "ws-team-1",
            workspaces: [
              {
                id: "ws-team-1",
                name: "Acme Enterprise Collaboration Workspace With Very Long Organization Name",
                structure: "workspace",
                planType: "business",
                role: "account-owner",
                current: true,
                canAccess: mode !== "inactive",
                deactivated: mode === "inactive",
                availabilityReason: mode === "inactive" ? "deactivated" : "available",
                availabilityLabel: mode === "inactive" ? "空间已停用" : "",
              },
              {
                id: "ws-personal",
                name: "个人默认空间",
                structure: "personal",
                planType: "plus",
                role: "owner",
                current: false,
                canAccess: true,
                deactivated: false,
                availabilityReason: "available",
                availabilityLabel: "",
              },
              {
                id: "ws-deactivated",
                name: "已归档研发空间",
                structure: "workspace",
                planType: "team",
                role: "standard-user",
                current: false,
                canAccess: false,
                deactivated: true,
                availabilityReason: "deactivated",
                availabilityLabel: "空间已停用",
                availabilityMessage: "该组织空间已被管理员停用",
              },
            ],
          },
        },
      });
    });
    await page.route("**/api/jobs/*/workspaces/switch", async (route) => {
      await route.fulfill({
        json: {
          currentWorkspaceId: "ws-personal",
          sub2api: { configured: true, updated: 1 },
        },
      });
    });
    try {
      const trigger = row().getByRole("button", { name: "查看并切换工作空间", exact: true });
      await trigger.click();
      const modal = page.getByRole("dialog", { name: "工作空间", exact: true });
      await modal.locator(".workspace-item").first().waitFor();
      check(await modal.getByRole("button", { name: "关闭工作空间", exact: true }).evaluate(e => e === document.activeElement), "initial focus not on workspace dialog close button");
      const items = modal.locator(".workspace-item");
      check(await items.count() === 3, "expected 3 workspaces");
      check((await items.nth(0).innerText()).includes("当前空间") && (await items.nth(0).innerText()).includes("组织"), "current org workspace badges missing");
      check((await items.nth(1).innerText()).includes("个人") && (await items.nth(1).locator(".workspace-item-action").innerText()).trim() === "切换", "personal switchable workspace missing");
      check(await items.nth(2).isDisabled(), "deactivated workspace must be disabled");
      check((await items.nth(2).locator(".workspace-item-action").innerText()).trim() === "已停用", "disabled workspace must not disguise as 切换");
      mode = "inactive";
      await modal.getByRole("button", { name: "刷新工作空间", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".workspace-item.selected.is-disabled"));
      check((await items.nth(0).locator(".workspace-item-action").innerText()).trim() === "已停用", "inactive current workspace must prioritize its unavailable action state");
      check(await items.nth(0).locator(".workspace-badge.current").count() === 1, "current workspace identity badge must remain visible");
      mode = "list";
      await modal.getByRole("button", { name: "刷新工作空间", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".workspace-item.selected.is-disabled"));

      await items.nth(1).click();
      await modal.getByRole("status").waitFor();
      check((await modal.getByRole("status").innerText()).includes("已切换到“个人默认空间”"), "workspace switch success notice missing");

      mode = "error";
      await page.setViewportSize({ width: 1307, height: 900 });
      await modal.getByRole("button", { name: "关闭", exact: true }).click();
      check(await modal.count() === 0, "close button did not close workspace dialog");
      check(await trigger.evaluate(e => e === document.activeElement), "focus not restored after closing workspace dialog");

      await trigger.click();
      const errModal = page.getByRole("dialog", { name: "工作空间", exact: true });
      await errModal.getByRole("alert").waitFor();
      check(await errModal.locator(".workspace-empty").count() === 0, "workspace error state must not show empty state simultaneously");
      await errModal.getByRole("button", { name: "关闭", exact: true }).click();
    } finally {
      await page.unroute("**/api/jobs/*/workspaces");
      await page.unroute("**/api/jobs/*/workspaces/switch");
    }
  });
  return { passed: results.filter(r => r.passed).length, total: results.length, results };
}
