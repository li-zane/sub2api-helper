async page => {
  const results=[],errors=[],evidence="__UI_TEST_EVIDENCE_DIR__";let phase='working',incomplete=true;
  const check=(v,m)=>{if(!v)throw Error(m)};
  const run=async(name,fn)=>{try{await fn();results.push({name,passed:true})}catch(e){results.push({name,passed:false,error:e.message})}};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{
    const response=await route.fetch(),data=await response.json();
    data.jobs=data.jobs.map((j,i)=>i===0?{...j,status:phase,lastOperationType:'replace_2fa',totpRotationIncomplete:incomplete,totpRotationStage:incomplete?'disabling':'confirmed',hasTotpKey:true,canReplaceTotp:true}:j);
    await route.fulfill({json:data});
  });
  await page.route('**/api/jobs/*/credentials',route=>route.fulfill({json:{credentials:{password:'fixture-password',totpSecret:'JBSWY3DPEHPK3PXP',persisted:true,sub2apiJson:'{}'}}}));
  const open=async()=>{
    await page.reload();await page.locator('tr.job-row').first().getByRole('button',{name:'查看或修改账号凭据',exact:true}).click();
    const d=page.getByRole('dialog',{name:'账号凭据',exact:true});await d.waitFor();await d.locator('input[type="password"]').first().waitFor();return d;
  };
  await run('running-rotation-never-displays-historical-failure',async()=>{
    const d=await open();check((await d.innerText()).includes('2FA 轮换进行中'),'running status missing');check(!(await d.innerText()).includes('上次 2FA 轮换未完成'),'pending marker rendered as historical failure');
    await page.screenshot({path:`${evidence}/rotation-running.png`}).catch(()=>{});
  });
  await run('finished-incomplete-is-not-account-completed-success',async()=>{
    phase='completed';const d=await open();check((await d.innerText()).includes('当前状态：2FA 轮换未完成'),'completed OAuth was confused with 2FA success');check((await d.innerText()).includes('上次 2FA 轮换未完成'),'actual failure explanation missing');
  });
  await run('rotation-view-no-runtime-errors',async()=>{check(!errors.length,errors.join('; '))});
  const result = { passed: results.filter(r => r.passed).length, total: results.length, results };
  return result;
}
