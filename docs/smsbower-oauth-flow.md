# SMSBower 余额、选价与 Codex OAuth 接码路径

核对日期：2026-11-07。SMSBower 接口规则依据官方文档；OpenAI 侧的具体网页认证路径来自本项目当前代码观察，不作为公开、稳定 API 的承诺。

## 余额与货币

- 接码配置切换到 SMSBower 后，点击“查询余额”。使用当前输入的 API Key；仅查询、不保存配置、不取号。
- 服务端调用 `getBalance`，解析 `ACCESS_BALANCE:<十进制余额>`。余额为零正常展示；失败保留上次查询值并显示错误，换 Key 或平台后旧值不再展示。没有自动轮询。
- SMSBower 官方已切换 USD：余额、报价、`maxPrice` 均以美元标注，不进行人民币换算。价格 `0.004` 显示为 `0.004 USD`，不四舍五入成零。
- 订单实际金额来自 `getNumberV2.activationCost`，与报价/最高价不是一回事。响应未带币种时使用 SMSBower 的 USD 合同默认值；明确返回的币种仍优先。
- helper 接口：`POST /api/sms-providers/smsbower/balance`，请求体仅需 `{ "config": { "apiKey": "API_KEY" } }`。复用控制台认证；API Key 不出现在页面 URL 或响应中。

## 国家、价格上限与等级优先级

1. 选择 **指定国家** 或 **不限国家** 模式，并填写 **最高价格（USD）**，例如 `0.04`。旧配置默认指定国家模式。保留旧配置的国家和上限；没有上限时停止取号，查询价格或切换国家不会覆盖预算。
2. 查询列表仍显示 `getPrices` 的国家汇总参考价，不代表 Gold 起价或成交价。保存配置后才用于后续任务。
3. 每次取号前读取 `getPricesV3(service,country)` 的供应商价格、库存，再与官网公开报价目录 `/activations/getPricesByService` 的 `positions.rank.description`、`agent_ids` 匹配。国家用 `activate_org_code` 对应 API 国家代码，不用官网内部 ID。服务代码与内部 ID 从目录核对，不把等级按供应商编号或价格猜出来。
4. 指定国家模式只看该国，不限国家模式读取所有国家的供应商报价；两种模式均仅保留价格 **小于等于上限**、有库存且等级明确的供应商，顺序为 **Gold → Silver → Bronze**；同等级优先低价，同价优先库存多。官网价格用于显示等级，个人 API 报价用于预算判断，以兼容平台的账号优惠价。
5. 逐个供应商调用 `getNumberV2`，传 `providerIds` 固定供应商，`maxPrice` 使用该供应商本次报价（不高于用户上限）。只有明确 `NO_NUMBERS` 才继续下一个供应商；全部无号则停止，不加预算；指定国家模式不跨国，不限国家模式可继续其他国家的候选供应商。
6. `BAD_ACTION` 才兼容回退 `getNumber`，并保留相同供应商和价格限制。超时、HTTP 异常、格式异常、余额不足均停止，避免重复付费取号。已返回订单 ID 的异常响应保留为待取消订单；V2 返回超出请求上限或非 USD 的金额也按异常订单处理。
7. 等级来源是官网公开报价端点，不是官方文档的稳定客户 API 合同。端点不可用、服务不匹配或等级未知时不盲目购买；未知等级不冒充 Bronze。目录请求不带 API Key 或登录 Cookie。
8. 日志记录实际取到的国家名称与 API 国家 ID、等级、供应商 ID、手机号和实际金额。涉及接码的任务记录带“接码”标签，详情中的实际手机号标红；复制仍为纯文本。原来的接码时限、风控换号次数上限、超时订单取消和回调验证保持不变。

## 预估可用数量

- 填写预算后，页面延迟 600ms 自动查询；切换范围或国家会重新预估，也可手动刷新。
- 认证接口 `POST /api/sms-providers/smsbower/inventory` 只调用等级目录和 `getPricesV3`，不买号、不发码、不保存设置。返回 `totalCount`、`byRank`、`countryCount`、`providerCount` 和查询时间。
- 预估与实际购买使用同一套预算、库存、等级过滤逻辑；实际购买会重新读取行情，不复用预估快照。
- 数量为符合条件的国家/供应商库存合计；平台可能共享库存，因此不是唯一手机号的去重总数，也不是成功接码保证。
- 无可用库存显示 0；查询失败显示错误，不伪装为 0。同范围刷新失败可保留标记为“上次预估”的旧值；换 Key、预算或范围后不会显示旧范围数据。

## Codex OAuth 包含接码时的实际路径

```text
授权入口
 ├─ 已有可刷新 OAuth → 刷新令牌 → 成功则结束，不走接码
 └─ 无刷新令牌／明确失效
      → 核对并复用保存的 Web 会话；失效才重新登录 Web
      → 获取 Codex 授权链接，保留 state / PKCE 上下文
      → auth.openai.com/oauth/authorize
      → 必要时完成授权服务器自己的密码／邮箱 OTP／TOTP 验证
      → 按页面分支选择已有账号 session
          ├─ 已满足手机号条件 → 跳过买号
          └─ 返回 add_phone
               → helper 进入手机号步骤
               → SMSBower 等级目录 + getPricesV3 → 预算内 Gold/Silver/Bronze → getNumberV2（指定供应商）
               → 保存订单与手机号、实际金额日志
               → /api/accounts/add-phone/send
               → SMSBower setStatus(1)，getStatus 等待短信
               → /api/accounts/phone-otp/validate
               → 上游确认通过后 setStatus(6)
      → 必要时 /api/accounts/workspace/select
      → OAuth callback，校验 state 和回调地址
      → 兑换 OAuth 凭据 → 保存授权文件
      → 若任务要求上传，再更新／上传号池记录
```

### 路径中的几个区别

- Web 与授权服务器的登录状态独立：Web 有效不代表 OAuth 侧一定免密码、邮箱码或手机号校验。项目保留有效 Web 会话，在原授权上下文中完成所要求的验证。
- `session/select` 只在授权页提供已有账号选择时调用；已直接得到回调或其他合法分支时不会强行重走账号/空间选择。
- 本地授权模式自行生成 state/PKCE，并向 `/oauth/token` 兑换；Sub2API 授权模式先调用号池 `/api/v1/admin/openai/generate-auth-url`，最终调用 `/api/v1/admin/openai/exchange-code`。SMSBower 不负责 OAuth 令牌兑换。
- 接码自动化需要“需要手机号时自动取号并接码”已保存并开启；否则停留在手动输入步骤。每次授权自动取号上限默认 3 个、可配置；重发或换号不会无限重置预算。本次没有修改此行为。
- 登录时限默认 3 分钟；首次进入手机号阶段切换到接码时限（默认 10 分钟），此后不切回、不因重发/换号重置。短信验证码通过后，剩余 OAuth 步骤仍受这份剩余时限约束。
- SMSBower 订单完成只表示手机验证已通过，不表示 OAuth 回调、凭据兑换或号池上传完成；后几步仍可能单独失败。
- 超时、取消或弃用已购号码时，提交 `setStatus(8)` 取消；平台若暂时拒绝取消，持久化队列继续重试。退款和最终计费以上游订单状态为准。

## 代码入口

- `src/smsbower.mjs` / `src/smsbower-ranked.mjs`：余额、国家汇总价、两种模式候选与库存预估、V2 取号、短信查询和订单状态。
- `src/sms-providers.mjs` / `src/console-server.mjs`：查询认证、自动取号、订单记录、收码与取消队列。
- `src/protocol-login.mjs`：Web 会话复用、OAuth 分支、手机号验证、工作空间及回调。
- `src/sub2api-oauth.mjs` / `src/login-timeout.mjs`：号池 OAuth 换证与一次性接码时限。

## 官方资料

- [SMSBower 客户 API](https://smsbower.online/api/?page=client)
- [SMSBower 转换 USD 的说明](https://smsbower.app/cn/blog/transition-to-usd)

- [OpenAI 官方 Codex 身份认证说明](https://learn.chatgpt.com/docs/auth)（官方登录方式；上文细化的网页端点以本项目代码为准）。
