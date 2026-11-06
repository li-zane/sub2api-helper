async(page)=>{
  await page.addInitScript(()=>{window.__rowRenders={};window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(renderer){this.renderers.set(1,renderer);return 1;},onCommitFiberRoot(_id,root){const walk=f=>{if(!f)return;if(f.type?.name==='JobRow'&&(f.flags&1)){const email=f.memoizedProps?.job?.email;if(email)window.__rowRenders[email]=(window.__rowRenders[email]||0)+1;}walk(f.child);walk(f.sibling);};walk(root.current);},onCommitFiberUnmount(){}};});
  let fixed,requests=0,change=false;
  await page.route(/\/api\/jobs(?:\?|$)/,async route=>{if(route.request().method()!=='GET')return route.continue();if(!fixed)fixed=await(await route.fetch()).json();const data=structuredClone(fixed);if(change)data.jobs[0].remark='performance fixture updated';requests++;return route.fulfill({json:data});});
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('tr.job-row').length===20);await page.waitForTimeout(1600);
  const initial=await page.evaluate(()=>Object.values(window.__rowRenders).reduce((a,b)=>a+b,0));
  await page.evaluate(()=>{window.__rowRenders={};});const at=requests;while(requests<at+3)await page.waitForTimeout(100);await page.waitForTimeout(100);
  const unchanged=await page.evaluate(()=>window.__rowRenders);change=true;const second=requests;while(requests<second+1)await page.waitForTimeout(100);await page.waitForTimeout(100);const changed=await page.evaluate(()=>window.__rowRenders);
  await page.unrouteAll({behavior:'wait'});
  const metrics={initialRowRenders:initial,unchangedPollRenders:Object.values(unchanged).reduce((a,b)=>a+b,0),changedPollRenders:changed};
  const correct=initial>=20&&metrics.unchangedPollRenders===0&&Object.keys(changed).length===1&&Object.values(changed)[0]===1;
  return {passed:correct?1:0,total:1,results:[{name:'polling-render-isolation',passed:correct,error:correct?undefined:JSON.stringify(metrics)}],metrics};
}
