async page => {
 const evidence="__UI_TEST_EVIDENCE_DIR__",results=[],errors=[],writes=[];let refreshes=0,partial=false,failRefresh=false;
 page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 const check=(v,m)=>{if(!v)throw Error(m);},test=async(name,run)=>{try{await run();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});await page.screenshot({path:evidence+'/failure-'+results.length+'.png'}).catch(()=>{});}};
 await page.route(/\/api\/sub2api\/(?:settings|monitor)$/,r=>r.fulfill({json:{configured:true,enabled:false,hasAdminApiKey:true,config:{baseUrl:'https://pool.example.test'},profiles:[{id:'default',name:'Default'}],activeProfileId:'default'}}));
 await page.route('**/api/sub2api/options',r=>{refreshes++;return failRefresh?r.fulfill({status:502,json:{error:'fixture refresh failure'}}):r.fulfill({json:{proxies:[],groups:[],directAccountCount:0}});});
 await page.route('**/api/sub2api/proxies',async r=>{
  const body=r.request().postDataJSON();writes.push(body);await new Promise(resolve=>setTimeout(resolve,450));
  const statuses=partial?['created','existing','failed','unknown']:body.proxies.map(()=>'created');
  const rows=body.proxies.map((p,i)=>({index:i,status:statuses[i],proxy:['created','existing'].includes(statuses[i])?{id:i+1,name:p.name,host:p.host,port:p.port,protocol:p.protocol}:undefined,message:'测试结果 '+statuses[i]}));
  await r.fulfill({json:{results:rows,...Object.fromEntries(['created','existing','failed','unknown'].map(s=>[s,rows.filter(r=>r.status===s).length]))}});
 });
 await page.reload();await page.locator('tbody .job-row').first().waitFor();
 await page.setViewportSize({width:1440,height:1000});
 await test('global-normal-and-abnormal-counts',async()=>{
  const text=await page.locator('.telemetry-capsule').innerText();check(text.includes('正常')&&text.includes('22')&&text.includes('异常')&&text.includes('2')&&!text.includes('已完成'),text);
 });
 const open=async()=>{await page.getByRole('region',{name:'代理 IP 配置',exact:true}).getByRole('button',{name:'配置',exact:true}).click();const parent=page.getByRole('dialog',{name:'代理 IP 配置与检测',exact:true});await parent.getByRole('button',{name:'添加代理',exact:true}).click();const d=page.getByRole('dialog',{name:'添加代理',exact:true});await d.waitFor();return d;};
 let d;try{d=await open();}catch(e){await page.screenshot({path:evidence+'/open-failed.png'});throw Error(e.message+'; pageErrors='+errors.join('; ')+'; dialogs='+JSON.stringify(await page.locator('dialog').evaluateAll(nodes=>nodes.map(n=>({open:n.open,modal:n.matches(':modal'),label:n.getAttribute('aria-labelledby'),inert:n.inert,text:n.innerText.slice(0,100)}))))+'; tree='+await page.locator('body').ariaSnapshot());}
 await test('manual-validation-protocol-expiry-and-busy-lock',async()=>{
  await d.getByRole('button',{name:'添加代理',exact:true}).click();check(await d.getByRole('alert').isVisible(),'empty form not validated');check(writes.length===0,'invalid request sent');
  await d.getByLabel('代理名称 *',{exact:true}).fill('Tokyo');await d.getByLabel('主机地址 / IP *',{exact:true}).fill('proxy.test');await d.getByLabel('端口 *',{exact:true}).fill('1080');
  await d.getByRole('combobox',{name:'选择协议',exact:true}).click();await page.getByRole('option',{name:'SOCKS5H',exact:true}).click();
  await d.getByLabel('用户名（可选）',{exact:true}).fill('user');await d.getByLabel('密码（可选）',{exact:true}).fill('private-secret');await d.getByRole('button',{name:'7天',exact:true}).click();
  const done=page.waitForResponse(r=>r.url().endsWith('/api/sub2api/proxies'));await d.getByRole('button',{name:'添加代理',exact:true}).click();await page.keyboard.press('Escape');check(await d.isVisible(),'busy dialog closed');check(await d.getByRole('button',{name:'关闭添加代理'}).isDisabled(),'close not disabled');await done;await d.getByRole('list',{name:'逐行添加结果'}).waitFor();
  check(writes.length===1,'duplicate submit');const p=writes[0].proxies[0];check(p.protocol==='socks5h'&&p.expires_at>Date.now()/1000&&p.password==='private-secret','fields lost');check(!(await d.innerText()).includes('private-secret'),'secret in results');await page.screenshot({path:evidence+'/proxy-added-desktop.png'});
 });
 await test('continue-adding-refreshes-list-after-each-submission',async()=>{
  const before=refreshes;await d.getByRole('button',{name:'继续添加',exact:true}).click();await d.getByLabel('代理名称 *',{exact:true}).fill('Seoul');await d.getByLabel('主机地址 / IP *',{exact:true}).fill('second.test');await d.getByLabel('端口 *',{exact:true}).fill('8080');
  await d.getByRole('button',{name:'添加代理',exact:true}).click();await d.getByRole('list',{name:'逐行添加结果'}).waitFor();await page.waitForTimeout(80);check(refreshes>before,'second successful creation did not refresh proxy choices');
 });
 await test('four-format-preview-line-errors-and-custom-names',async()=>{
  await d.getByRole('button',{name:'继续添加',exact:true}).click();await d.getByRole('tab',{name:'快捷导入',exact:true}).click();
  await d.locator('textarea').fill('one.test:8080:u:p\n\nbad');check((await d.innerText()).includes('第 3 行'),'line error missing');check(await d.getByRole('button',{name:/导入代理/}).isDisabled(),'invalid import enabled');
  await d.locator('textarea').fill('one.test:8080:u:p\nsocks5://u:p@two.test:1080\nu:p@three.test:8080\nfour.test:8080@u:p');
  await d.getByLabel('第 1 行代理名称',{exact:true}).fill('Custom name');check(await d.getByLabel(/第 \d 行代理名称/).count()===4,'four previews missing');await page.screenshot({path:evidence+'/proxy-import-desktop.png'});
  check(await d.locator('.proxy-batch-options-row').evaluate(el=>{const a=el.querySelector('.custom-select-container').getBoundingClientRect(),b=el.querySelector('.name-prefix-group').getBoundingClientRect();return a.right<=b.left;}),'protocol selector overlaps name prefix');
 });
 await test('partial-results-and-retry-preserve-request-id',async()=>{
  partial=true;await d.getByRole('button',{name:/导入代理/}).click();await d.getByRole('list',{name:'逐行添加结果'}).waitFor();check(await d.getByRole('listitem').count()===4,'partial results lost');check((await d.innerText()).includes('请先读取'),'unknown guidance missing');
  const first=writes.at(-1);check(first.proxies[0].name==='Custom name','custom name not sent');check(first.proxies[1].protocol==='socks5','URL scheme lost');
  await d.getByRole('button',{name:'重试提交',exact:true}).click();await d.getByRole('button',{name:'重试提交',exact:true}).waitFor();check(writes.at(-1).requestId===first.requestId,'retry changed idempotency key');
 });
 await test('edited-draft-uses-new-id',async()=>{
  const before=writes.at(-1).requestId;await d.getByRole('button',{name:'返回修改草稿',exact:true}).click();await d.getByLabel('第 1 行代理名称',{exact:true}).fill('Edited name');partial=false;
  await d.getByRole('button',{name:/导入代理/}).click();await d.getByRole('list',{name:'逐行添加结果'}).waitFor();check(writes.at(-1).requestId!==before,'edited payload reused previous id');
 });
 await test('refresh-failure-keeps-successful-creation-results',async()=>{
  await d.getByRole('button',{name:'继续添加',exact:true}).click();await d.locator('textarea').fill('retry.test:8080:u:p');failRefresh=true;
  await d.getByRole('button',{name:/导入代理/}).click();await d.getByRole('list',{name:'逐行添加结果'}).waitFor();await page.waitForTimeout(150);check((await d.innerText()).includes('已添加'),'successful creation lost');check(!errors.length,errors.join('; '));failRefresh=false;
 });
 await test('mobile-layout-and-modal-focus-return',async()=>{
  await d.getByRole('button',{name:'继续添加',exact:true}).click();await page.setViewportSize({width:375,height:812});await d.locator('textarea').fill('long-hostname-for-mobile-layout.example.test:8080:user:password\nsocks5h://user:password@another.test:1080');
  check(await d.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog horizontal overflow');await page.screenshot({path:evidence+'/proxy-import-mobile.png'});
  await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});const parent=page.getByRole('dialog',{name:'代理 IP 配置与检测',exact:true});check(await parent.isVisible(),'parent dialog lost');check(await parent.getByRole('button',{name:'添加代理',exact:true}).evaluate(el=>el===document.activeElement),'focus not restored');check(!errors.length,errors.join('; '));
 });
 return{passed:results.filter(r=>r.passed).length,total:results.length,results};
}
