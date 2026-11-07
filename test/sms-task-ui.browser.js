async (page) => {
  const evidence = "__UI_TEST_EVIDENCE_DIR__";
  page.setDefaultTimeout(8000);
  let interactionStep = "not-started";
  const results = [], errors = [], requests = [], mutations = [];
  const metrics = {};
  page.on("request", request => {
    if (request.method() !== "GET" && /\/api\/jobs\//.test(request.url())) mutations.push(request.url());
  });
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const run = async (name, fn) => {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: `${error.message} [${interactionStep}]`,
      });
    }
  };
  page.on("pageerror", error => errors.push(error.message));

  await page.evaluate(() => {
    localStorage.setItem(
      "chatgpt-onboarding.sms-provider-settings-v1",
      JSON.stringify({
        selectedProviderId: "smsbower",
        configs: {
          smsbower: {
            apiKey: "fixture-sms-key",
            service: "dr",
            country: "1001",
            countryLabel: "Japan",
            maxPrice: "0.42",
          },
        },
      })
    );
  });

  await page.route("**/api/sub2api/account-status*", route =>
    route.fulfill({ json: { configured: false, accounts: {} } })
  );

  await page.route(/\/api\/jobs\/[^/]+\/(?:input|sms-number)$/, async route => {
    const req = route.request();
    const body = req.postDataJSON?.() || {};
    requests.push({ url: req.url(), body });
    await route.fulfill({ json: { ok: true } });
  });

  const smsFixtures = [
    {
      status: "completed",
      smsStatus: "completed",
      smsProviderName: "SMSBower",
      expectedShortLabel: "已接码",
      expectedTitle: "SMSBower：手机验证已通过，订单已完成",
      expectedTone: "tone-success",
    },
    {
      status: "phone_otp",
      smsStatus: "waiting_sms",
      smsProviderName: "SMSBower",
      currentPhone: "+60123456789",
      expectedShortLabel: "等验证码",
      expectedTitle: "SMSBower：验证码已发送，正在等待短信",
      expectedTone: "tone-waiting",
    },
    {
      status: "phone",
      smsStatus: "requesting",
      smsProviderName: "SMSBower",
      expectedShortLabel: "取号中",
      expectedTitle: "SMSBower：正在获取手机号",
      expectedTone: "tone-running",
    },
    {
      status: "phone",
      smsStatus: "number_acquired",
      smsProviderName: "SMSBower",
      currentPhone: "+819012345678",
      expectedShortLabel: "发码中",
      expectedTitle: "SMSBower：已获取手机号，正在发送验证码",
      expectedTone: "tone-running",
    },
    {
      status: "phone_otp",
      smsStatus: "submitting",
      smsProviderName: "SMSBower",
      currentPhone: "+819012345678",
      expectedShortLabel: "提交中",
      expectedTitle: "SMSBower：已收到验证码，正在自动提交",
      expectedTone: "tone-running",
    },
    {
      status: "phone_otp",
      smsStatus: "submitted",
      smsProviderName: "SMSBower",
      currentPhone: "+819012345678",
      expectedShortLabel: "已提交",
      expectedTitle: "SMSBower：验证码已自动提交",
      expectedTone: "tone-running",
    },
    {
      status: "phone_otp",
      smsStatus: "manual_submitted",
      smsProviderName: "SMSBower",
      currentPhone: "+819012345678",
      expectedShortLabel: "核验中",
      expectedTitle: "SMSBower：已停止自动读取，正在验证手动输入的验证码",
      expectedTone: "tone-running",
    },
    {
      status: "phone",
      smsStatus: "error",
      smsProviderName: "SMSBower-Enterprise-LongPlatformName-Global",
      smsError: "上游平台余额不足或所选国家当前无可用号码，请更换国家或稍后重试",
      phoneError: "该手机号已被绑定次数过多，请更换其他号码后重新验证",
      currentPhone: "+120255501998877",
      expectedShortLabel: "接码异常",
      expectedTitle: "SMSBower-Enterprise-LongPlatformName-Global：上游平台余额不足或所选国家当前无可用号码，请更换国家或稍后重试",
      expectedTone: "tone-error",
    },
  ];

  await page.route(/\/api\/jobs(?:\?|$)/, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.jobs = data.jobs.map((job, idx) => {
      const fx = smsFixtures[idx];
      if (!fx) return job;
      return {
        ...job,
        status: fx.status,
        autoRepairBlocked: false,
        smsStatus: fx.smsStatus,
        smsProviderName: fx.smsProviderName,
        smsError: fx.smsError || null,
        phoneError: fx.phoneError || null,
        currentPhone: fx.currentPhone || null,
        lastOperationAt: "2026-11-05T04:05:06Z",
        lastOperationType: "reauthorize",
      };
    });
    await route.fulfill({ json: data });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("tr.job-row").length >= 8);

  const row = i => page.locator("tr.job-row").nth(i);
  const triggerOf = i => row(i).locator("button.sms-compact-trigger");
  const openPopover = page.locator(".sms-task-popover[ role='dialog' ]");

  // Capture Screenshot 1: Compact table entries across states
  await page.locator(".table-frame").screenshot({ path: `${evidence}/sms-compact-table.png` });
  const cellBox = await row(0).locator(".recent-operation-cell").boundingBox();
  await page.screenshot({ path: `${evidence}/sms-compact-preview.png`, clip: {
    x: Math.max(0, cellBox.x - 130), y: Math.max(0, cellBox.y - 40), width: 620, height: 420,
  } });

  await run("table-column-width-and-row-height-do-not-expand-for-sms-tasks", async () => {
    interactionStep = "checking-compact-table-metrics";
    const baselineHeight = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tr.job-row")];
      const nonSmsRow = rows.slice(8).find(r => !r.querySelector(".sms-compact-trigger") && !r.querySelector(".inline-entry"));
      return nonSmsRow ? nonSmsRow.getBoundingClientRect().height : 68;
    });
    metrics.nonSmsRowHeight = baselineHeight;
    metrics.operationColumnWidth = (await row(0).locator(".recent-operation-cell").boundingBox()).width;
    metrics.smsRowHeights = [];

    for (let i = 0; i < smsFixtures.length; i++) {
      const fx = smsFixtures[i];
      const trigger = triggerOf(i);
      await trigger.waitFor();
      const text = (await trigger.innerText()).trim();
      check(text === fx.expectedShortLabel, `row ${i} compact label mismatch: expected ${fx.expectedShortLabel}, got ${text}`);

      const rowMetrics = await trigger.evaluate(el => {
        const td = el.closest("td.recent-operation-cell");
        const tr = el.closest("tr.job-row");
        const tdRect = td.getBoundingClientRect();
        const trRect = tr.getBoundingClientRect();
        const btnRect = el.getBoundingClientRect();
        return {
          tdWidth: tdRect.width,
          trHeight: trRect.height,
          btnWidth: btnRect.width,
          btnHeight: btnRect.height,
          fitsCell: btnRect.left >= tdRect.left - 0.5 && btnRect.right <= tdRect.right + 0.5,
          isCompleted: el.classList.contains("is-completed"),
          hasInlineCardInCell: Boolean(td.querySelector(".sms-status-card, .phone-target-pill, .phone-error-card, .inline-entry")),
        };
      });

      check(!rowMetrics.hasInlineCardInCell, `row ${i} should not render multi-layer cards directly inside table cell`);
      check(rowMetrics.tdWidth <= 126, `row ${i} recent-operation-cell widened to ${rowMetrics.tdWidth}px (expected ~120px)`);
      check(rowMetrics.trHeight <= baselineHeight + 4, `row ${i} height inflated to ${rowMetrics.trHeight}px vs baseline ${baselineHeight}px`);
      check(rowMetrics.fitsCell && rowMetrics.btnHeight <= 22, `row ${i} trigger is not compact (${rowMetrics.btnWidth}x${rowMetrics.btnHeight})`);
      check(await trigger.evaluate((el, tone) => el.classList.contains(tone), fx.expectedTone), `row ${i} missing ${fx.expectedTone}`);
      metrics.smsRowHeights.push(rowMetrics.trHeight);
      if (i === 0) {
        check(rowMetrics.isCompleted && rowMetrics.btnHeight <= 19, `completed trigger should be lighter/smaller, got height ${rowMetrics.btnHeight}`);
      }
    }
  });

  await run("popover-open-close-no-side-effects-preserves-unsubmitted-input-and-restores-focus", async () => {
    interactionStep = "popover-open-close-and-focus";
    const r1Trigger = triggerOf(1);
    await r1Trigger.click();
    await openPopover.waitFor({ state: "visible" });
    check(mutations.length === 0, "opening popover must not trigger any mutation requests");

    // Capture Screenshot 2: Opened floating popover on waiting_sms task
    await page.locator(".table-frame").screenshot({ path: `${evidence}/sms-open-popover.png` });
    await openPopover.screenshot({ path: `${evidence}/sms-popover-detail.png` });

    const otpInput = openPopover.getByRole("textbox", { name: "+60123456789 的验证码" });
    await otpInput.fill("654");
    check((await otpInput.inputValue()) === "654", "OTP input did not accept partial value");

    // Press Escape to close popover and check focus returns to trigger
    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });
    check(mutations.length === 0, "closing popover must not trigger any mutation requests");

    const focusReturned = await r1Trigger.evaluate(el => document.activeElement === el);
    check(focusReturned, "Escape close did not return focus to compact trigger button");

    // Reopen and verify unsubmitted input is preserved
    await r1Trigger.click();
    await openPopover.waitFor({ state: "visible" });
    check((await otpInput.inputValue()) === "654", "unsubmitted input value was lost after closing and reopening popover");

    // Close via header close button
    await openPopover.getByRole("button", { name: "关闭手机验证浮层" }).click();
    await openPopover.waitFor({ state: "hidden" });
  });

  await run("long-platform-phone-and-errors-fully-readable-in-popover", async () => {
    interactionStep = "popover-long-error-readability";
    await triggerOf(7).click();
    await openPopover.waitFor({ state: "visible" });

    const card = openPopover.locator(".sms-status-card");
    const pill = openPopover.locator(".phone-target-pill");
    const errCard = openPopover.locator(".phone-error-card");
    await card.waitFor();
    await pill.waitFor();
    await errCard.waitFor();

    const readability = await openPopover.evaluate(pop => {
      const smsSec = pop.querySelector(".sms-status-secondary");
      const phoneErr = pop.querySelector(".phone-error-text");
      const phoneNum = pop.querySelector(".phone-target-number");
      const popRect = pop.getBoundingClientRect();
      return {
        smsErrorText: smsSec?.textContent || "",
        smsErrorClipped: smsSec ? smsSec.scrollHeight > smsSec.clientHeight + 2 : true,
        phoneErrorText: phoneErr?.textContent || "",
        phoneErrorClipped: phoneErr ? phoneErr.scrollHeight > phoneErr.clientHeight + 2 : true,
        phoneText: phoneNum?.textContent || "",
        withinViewport: popRect.left >= 0 && popRect.right <= window.innerWidth,
      };
    });

    check(readability.smsErrorText.includes("上游平台余额不足或所选国家当前无可用号码"), "full smsError not shown");
    check(!readability.smsErrorClipped, "long smsError is clipped/truncated inside popover");
    check(readability.phoneErrorText.includes("该手机号已被绑定次数过多"), "full phoneError not shown");
    check(!readability.phoneErrorClipped, "long phoneError is clipped/truncated inside popover");
    check(readability.phoneText === "+120255501998877", "full currentPhone not shown");
    check(readability.withinViewport, "popover overflows viewport");

    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });
  });

  await run("manual-actions-and-disabled-states-in-popover-without-title-selector-brittleness", async () => {
    // Row 2 has status=phone, smsStatus=requesting -> platform button disabled while requesting
    interactionStep = "row2-requesting-disabled-check";
    await triggerOf(2).click();
    await openPopover.waitFor({ state: "visible" });
    const r2Submit = openPopover.getByRole("button", { name: "发送手机验证码" });
    const r2Platform = openPopover.getByRole("button", { name: "SMSBower取号" });
    check(await r2Submit.isDisabled(), "empty phone submit should be disabled");
    check(await r2Platform.isDisabled(), "platform button should be disabled when smsStatus is requesting");
    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });

    // Row 7 has status=phone, smsStatus=error -> platform button enabled when smsProvider ready
    interactionStep = "row7-platform-and-phone-submit";
    await triggerOf(7).click();
    await openPopover.waitFor({ state: "visible" });
    const r7Input = openPopover.getByPlaceholder("+60123456789");
    const r7Submit = openPopover.getByRole("button", { name: "发送手机验证码" });
    const r7Platform = openPopover.getByRole("button", { name: "SMSBower取号" });
    check(!(await r7Platform.isDisabled()), "platform button should be enabled when ready and not requesting");
    await r7Platform.click();
    await page.waitForFunction(() => {
      const btn = document.querySelector(".sms-task-popover .platform-number-button");
      return btn && !btn.disabled;
    });
    check(requests.some(r => r.url.endsWith("/sms-number") && r.body.providerId === "smsbower"), "requestSmsNumber did not post expected payload");

    await r7Input.fill("+60123456789");
    check(!(await r7Submit.isDisabled()), "filled phone submit should be enabled");
    await r7Submit.click();
    await page.waitForFunction(() => {
      const btn = document.querySelector('.sms-task-popover button[aria-label="发送手机验证码"]');
      return btn && btn.disabled;
    });
    check(requests.some(r => r.url.endsWith("/input") && r.body.action === "phone" && r.body.value === "+60123456789"), "phone submit action mismatch");
    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });

    // Row 1 has status=phone_otp, currentPhone="+60123456789" -> OTP input, submit, 重发, 换号
    interactionStep = "row1-otp-resend-change";
    await triggerOf(1).click();
    await openPopover.waitFor({ state: "visible" });
    const r1Input = openPopover.getByRole("textbox", { name: "+60123456789 的验证码" });
    const r1Submit = openPopover.getByRole("button", { name: "提交手机验证码" });
    await r1Input.fill("");
    check(await r1Submit.isDisabled(), "empty otp submit should be disabled");

    const inputBox = await r1Input.boundingBox();
    check(inputBox.width >= 140, `OTP input in popover should be wide enough (${inputBox.width}px)`);

    await r1Input.fill("123456");
    check(!(await r1Submit.isDisabled()), "filled otp submit should be enabled");
    await r1Submit.click();
    await page.waitForFunction(() => {
      const btn = document.querySelector('.sms-task-popover button[aria-label="提交手机验证码"]');
      return btn && btn.disabled;
    });
    check(requests.some(r => r.url.endsWith("/input") && r.body.action === "phone_otp" && r.body.value === "123456"), "phone_otp submit action mismatch");

    await openPopover.getByRole("button", { name: "重发" }).click();
    check(requests.some(r => r.url.endsWith("/input") && r.body.action === "resend_phone" && r.body.value === ""), "resend_phone action mismatch");

    await openPopover.getByRole("button", { name: "换号" }).click();
    check(requests.some(r => r.url.endsWith("/input") && r.body.action === "change_phone" && r.body.value === ""), "change_phone action mismatch");

    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });
  });

  await run("keyboard-enter-submits-once-and-popover-tab-cycle-stays-inside", async () => {
    interactionStep = "keyboard-submit-and-focus-trap";
    await triggerOf(1).click();
    await openPopover.waitFor({ state: "visible" });
    const input = openPopover.getByRole("textbox", { name: "+60123456789 的验证码" });
    const close = openPopover.getByRole("button", { name: "关闭手机验证浮层" });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    check(await openPopover.getByRole("button", { name: "换号" }).evaluate(el => el === document.activeElement), "reverse Tab escaped popover");
    await page.keyboard.press("Tab");
    check(await close.evaluate(el => el === document.activeElement), "Tab did not cycle to first popover control");
    await input.fill("234567");
    const before = requests.length;
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/input") && r.request().postDataJSON()?.value === "234567"),
      input.press("Enter"),
    ]);
    await page.waitForFunction(() => document.querySelector('.sms-task-popover input')?.value === "");
    check(requests.length === before + 1 && requests.at(-1).body.action === "phone_otp", "Enter did not submit exactly one OTP request");
    await input.fill("987");
    await page.mouse.click(2, 2);
    await openPopover.waitFor({ state: "hidden" });
    await triggerOf(1).click();
    await openPopover.waitFor({ state: "visible" });
    check(await input.inputValue() === "987", "outside-close lost unsubmitted input");
    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });
    check(requests.length === before + 1, "closing/reopening submitted an unexpected request");
  });

  await run("narrow-375px-viewport-trigger-and-popover-fit-cleanly", async () => {
    interactionStep = "mobile-375px-check";
    await page.setViewportSize({ width: 375, height: 812 });
    await triggerOf(1).scrollIntoViewIfNeeded();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "375px viewport has horizontal document overflow");
    await triggerOf(1).click();
    await openPopover.waitFor({ state: "visible" });
    const popFits = await openPopover.evaluate(pop => {
      const r = pop.getBoundingClientRect();
      return r.left >= 4 && r.right <= window.innerWidth - 4;
    });
    check(popFits, "popover overflows 375px mobile viewport");
    await page.screenshot({ path: `${evidence}/sms-mobile.png` });
    await page.keyboard.press("Escape");
    await openPopover.waitFor({ state: "hidden" });
  });

  await page.unrouteAll({ behavior: "wait" });
  check(!errors.length, errors.join("; "));
  return {
    passed: results.filter(r => r.passed).length,
    total: results.length,
    results,
    metrics: { ...metrics, interactionStep, actions: requests.map(r => r.body.action || "number") },
  };
}
