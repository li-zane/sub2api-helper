# UI 回归检查

```powershell
npm run build
npm run test:ui:filters
npm run test:ui:browser
node test/console-oauth-proxy-counts-smoke.mjs
```

`test:ui:filters` 使用临时数据和本地 HTTP 服务，已纳入 `npm run check`。

`test:ui:browser` 使用 Playwright CLI 和独立浏览器会话，检查十项契约：Web 登录态、精确邮箱集合、有效方案搜索、键盘帮助、代理弹窗（初始焦点不弹帮助、键盘帮助仍可用）、日志弹窗、批量互斥、移动端操作列、无结果提示和代理分配统计口径。需预先备好 `@playwright/cli` 及其浏览器；运行使用 `npx --no-install`，不会自动安装依赖。任何失败都会返回非零退出码。

所有账号均为 `example.test` 测试数据；批量重新授权接口由浏览器模拟响应，不运行真实登录或账号操作。

手工调试可启动隔离 fixture：

```powershell
npm run test:ui:fixture
# 页面：http://127.0.0.1:44919
npx --no-install --package @playwright/cli playwright-cli -s=ui-fixed open http://127.0.0.1:44919
npx --no-install --package @playwright/cli playwright-cli -s=ui-fixed snapshot
npx --no-install --package @playwright/cli playwright-cli -s=ui-fixed run-code --filename test/ui-regressions.browser.js --raw
```

fixture 默认使用开发前端以即时读取 CSS/JS；生产资源另由 `production-console-smoke.mjs` 验证。设置 `UI_TEST_SERVER` 可运行同一组测试验证代码快照。不要将该变量指向真实账号服务。

代理 IP 分配数量仅统计 OpenAI OAuth 账号，按邮箱去重；API Key、其他平台及尚无授权结果的本地任务不计入。本地已授权且尚未入池的账号在账号级代理模式下补充统计。此数量表示代理绑定，不是实时网络连接数。`console-oauth-proxy-counts-smoke.mjs` 使用混合账号类型覆盖三种代理模式、共享出口 IP、邮箱冲突和未完成本地任务，已纳入 `npm run check`。
