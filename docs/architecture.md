# 控制台架构：单进程，按功能拆分

控制台继续由 `npm start` 启动。HTTP、任务调度和本地存储仍在同一个 Node 进程中；本次没有增加数据库、网络服务或进程间通信。以下是已从两个入口文件分离出来的边界，并不是整仓迁移计划。

## 一次任务列表请求经过哪里

1. `src/console-server.mjs` 负责鉴权和参数解析。GET 和 POST 使用同一个查询服务；只有 POST 接受显式邮箱集合。
2. `src/job-list-service.mjs` 按原顺序刷新任务、读取号池、同步订阅历史、检查会话，然后生成响应。一次请求始终使用它取得的号池快照。号池读取失败时，普通列表可使用原缓存；显式按号池状态筛选时，错误应返回调用方，而不是把缓存当成新数据。
3. `src/job-list-query.mjs` 接收已读出的行和计算函数，不打开端口、不访问文件。全局统计和筛选选项基于全部任务；跨页选择基于全部命中项；详情只生成当前页。`src/job-store.mjs` 维护任务及账号索引，不缓存可变权限。

改筛选与分页，测查询模块；改数据读取顺序或错误处理，给服务传内存适配器；改参数或鉴权，再测真实 HTTP。不要让服务反向导入启动入口来取得全局变量。

## 定价和弹窗的归属

- 账号成本、倍率的校验、默认值和按分计算利润属于 `shared/`。共享模块不导入前端或服务端。前端保留显示和轮询合并逻辑；订阅历史接口原有的 `profitDisplay` 字段仍是输出契约的一部分。
- `web/src/main.jsx` 决定打开哪个弹窗、传入哪些数据、保存后如何刷新。备注编辑在 `web/src/remark-dialog.jsx`；任务设置表单在 `web/src/task-settings-dialog.jsx`。弹窗通过回调交回结果，不导入应用入口。
- 添加跨端模块时，既要测前端构建，也要检查生产包的文件清单。当前运行时需要 `shared/`；只验证开发模式容易漏掉发布包缺文件的问题。

## 本地验证入口

```sh
npm run build
npm run test:ui:filters
npm run test:account-pricing
node test/subscription-history.mjs
node test/production-console-smoke.mjs
```

测试使用临时数据。生产静态资源由第一条命令生成，因此生产模式的 HTTP 冒烟测试应在构建之后运行。
