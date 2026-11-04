# WebSession 定时巡检

在顶部 **任务设置 → WebSession 定时巡检** 启用后保存。默认关闭；检测间隔默认 15 分钟（1–1440），重登重试间隔默认 60 分钟（15–1440），也可关闭自动重登、仅检测。

- 巡检由服务端定时器运行，关闭浏览器后仍执行。检查已有 Web 登录态，主动登出删除登录态后不自动补登；忙碌、封禁、已取消的任务跳过。
- 每轮先使用保存的 Cookie 和原浏览器/设备身份校验 WebSession，即使缓存 access token 尚未过期也访问 `/api/auth/session`；成功后读取可用工作空间与登录设备，持久化摘要。
- 只有确认 Web 会话失效、当前空间不可用、PlanType 改变，或现有绑定不符合已确认的当前 PlanType 方案，才进入原有共享登录队列。网络、403、5xx 和代理失败仅记录检测失败，保留原绑定，不据此认定掉线或 Free。
- 自动修复重新确认空间和 PlanType，再执行 Codex 授权；仅当当前空间不可用且上游明确返回唯一可用个人空间时，允许本次自动修复选用它。无法确认时停止，不猜测 Free，不选择其他企业空间。
- PlanType 代理模式下，修复登录沿用当前出口，登录后按新 PlanType 应用直连/固定节点/均衡方案，然后同步号池。普通手动登录保留原先的工作空间选择规则。设备身份与 Cookie 沿用原存储，不执行“登出全部设备”。需要 OTP/2FA 人工输入时停留在现有任务队列。
- 启用自动重登后，修改 PlanType 方案造成的代理绑定不一致也会在巡检中触发重新应用；仅检测模式只记录状态，不入队。已有 Web 登录态但没有 Codex 授权文件的账号只补登 Web，不自动创建 Codex 授权。
- `web-session-monitor.json` 保存检测时间、设备/空间摘要和重登冷却时间，不保存访问令牌、Cookie、验证码或密码；重启后沿用。原始 WebSession 仍由 `web-session.json` 管理。

接口均需控制台令牌：

- `GET /api/web-session-monitor`：设置、运行状态和各账号最近快照。
- `POST /api/web-session-monitor/check`，请求 `{}`：启用后立即巡检，仍遵守账号互斥和重登冷却。
- `POST /api/task-settings` 中的 `webSessionMonitor`：`{ enabled, intervalMinutes, autoRelogin, retryMinutes }`。

验证：`node test/web-session-monitor.mjs`、`node test/console-web-session-monitor-smoke.mjs`、`node test/account-web-session.mjs`、`node test/web-plan-identity.mjs`、`npm run test:ui:browser`。所有 HTTP 测试使用本地模拟账号/上游，不操作真实账号。
