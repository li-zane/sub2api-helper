# 控制台架构：单进程，按功能拆分

控制台继续由 `npm start` 启动。后端运行在 Node.js 22+，前端使用 React 和 Vite。HTTP、任务调度和 JSON 存储仍在同一个进程中，不引入新的部署单元。本次先迁移任务列表和订阅历史；账号动作、外部服务适配和其他写入流程保持原有行为。

## 启动和停机

- `src/console-server.mjs` 是 CLI 入口，只处理参数、信号和启动日志。
- `src/console-app.mjs` 组装应用实例，拥有该实例的 token、任务索引、存储和后台定时器。导入和构造不监听端口或写入数据。显式调用 `start()` 恢复状态后开始服务；`stop()` 等待清理，同一实例停机后使用新的实例重新启动。
- `src/console-lifecycle.mjs` 协调并发启动、停机和启动失败清理。只有 CLI 安装进程信号处理器。`src/console-http.mjs` 管理监听、响应编码和静态资源分发。API token 检查仍在统一入口，位于业务路由之前。

## 一次任务列表请求经过哪里

1. `src/console-app.mjs` 先检查 token，再交给 `src/console-read-routes.mjs` 解析参数和调用服务。GET 和 POST 使用同一个查询服务；只有 POST 接受显式邮箱集合。
2. `src/job-list-service.mjs` 按原顺序刷新任务、读取号池、同步订阅历史、检查会话，然后生成响应。一次请求始终使用它取得的号池快照。号池读取失败时，普通列表可使用原缓存；显式按号池状态筛选时，错误应返回调用方，而不是把缓存当成新数据。
3. `src/job-list-query.mjs` 接收已读出的行和计算函数，不打开端口、不访问文件。全局统计和筛选选项基于全部任务；跨页选择基于全部命中项；详情只生成当前页。`src/job-store.mjs` 维护任务及账号索引，不缓存可变权限。

改筛选与分页，测查询模块；改数据读取顺序或错误处理，给服务传内存适配器；改参数或鉴权，再测真实 HTTP。不要让服务反向导入启动入口来取得全局变量。

列表请求与订阅历史接口共享 `src/subscription-history-sync.mjs`。读取调用 `ensureFresh()` 加入正在进行的扫描，空闲时重新检查本地文件。实际数据变化由写入方调用 `invalidate()` 标记。扫描期间积累的变化合并到下一轮，等扫描完成的调用方可读到补扫后的结果。同步失败后，下一次读取可以重试。

## 前端任务列表

`web/src/use-job-list.jsx` 将请求条件、已返回的列表和选择索引放在同一个 reducer 中。筛选修改会清空选择并回到第一页，翻页会保留同一筛选下的跨页选择。新查询等待响应或读取失败时，旧行可供查看，复选框和依赖所选行的批量操作暂停。收到与当前查询匹配的结果后再开放选择。`web/src/job-list-table.jsx` 负责表头、筛选菜单、更新状态和分页视图。

## 设置写入和前端草稿

任务设置、账号代理设置和降智检测设置共用 `src/console-settings.mjs` 的实例级写入队列。局部修改在队列中与最新已提交快照合并。每个配置文件通过原子替换保存，联动写入降智检测文件失败时恢复任务设置文件的原始内容。降智检测的直接入口 `POST /api/model-fingerprint/settings` 仍接受原有完整设置，加上 `{ patch: { ... } }` 格式用于局部修改。

任务、代理模式和降智检测的运行时应用在写盘成功后执行。应用失败时，设置请求仍返回 HTTP 200 和保存的设置，并附上 `runtimeApply` 说明待重试的步骤。页面提供重试按钮。已认证的 `POST /api/task-settings/retry-runtime` 与写入串行，只按最新提交状态重试仍待确认的步骤。停机关闭写入入口并等待已接收的写入完成。

`web/src/use-console-settings.jsx` 区分已保存值和代理草稿。任务设置和降智检测设置弹窗只提交相对打开时的修改。其他表单保存会保留代理草稿，旧的读取和保存响应也会保留较新的编辑。

## 定价和弹窗的归属

任务设置、历史订阅、代理创建、代理编辑和账号日志分别在首次打开时加载。任务设置的代码下载与设置读取并发进行。可取消的加载提示只占用当前弹窗，列表仍然可见。

生产构建为带内容哈希的 JS 和 CSS 生成 Brotli 和 gzip 文件。静态服务根据浏览器支持的编码返回对应内容，旧构建可继续提供原始文件。构建后可运行 `node test/bench/frontend-transfer.mjs` 测量首页 HTML 引用的 JS 和 CSS 响应体字节，运行 `npm run test:ui:deferred` 验证实际浏览器的按需加载和焦点恢复。

- 账号成本、倍率的校验、默认值和按分计算利润属于 `shared/`。共享模块不导入前端或服务端。前端保留显示和轮询合并逻辑；订阅历史接口原有的 `profitDisplay` 字段仍是输出契约的一部分。
- `web/src/main.jsx` 决定打开哪个弹窗、传入哪些数据、保存后如何刷新。备注编辑在 `web/src/remark-dialog.jsx`；任务设置表单在 `web/src/task-settings-dialog.jsx`。弹窗通过回调交回结果，不导入应用入口。
- 添加跨端模块时，既要测前端构建，也要检查生产包的文件清单。当前运行时需要 `shared/`；只验证开发模式容易漏掉发布包缺文件的问题。

## 本地验证入口

```sh
npm run build
npm run test:ui:filters
npm run test:account-pricing
npm run test:console-token
npm run test:subscriptions
npm run test:frontend:poll
npm run test:console-settings
node test/console-settings-consistency.mjs
npm run test:ui:task-settings
npm run test:ui:browser
node test/production-console-smoke.mjs
```

测试使用临时数据。生产静态资源由第一条命令生成，因此生产模式的 HTTP 冒烟测试应在构建之后运行。
