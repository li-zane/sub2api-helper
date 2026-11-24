# IPRoyal 数据中心 IP 巡检

在 helper 的「代理 IP 配置与检测」中点击「测试连接」。测试会分页读取 IPRoyal 库存，并读取第一笔订单的流量。成功后显示 IP 数、订单数和余额接口验证结果。开启「IPRoyal 巡检」会立即匹配当前 Sub2API 池并更新已匹配节点的名称。开关默认关闭。

## 给 X3 配置凭据

1. 部署包含此功能的 helper，沿用之前保存的 Sub2API 后端配置。它的管理员 API Key 用于读取池内 IP 和更新名称。
2. IPRoyal 的 Dashboard 请求实测带有 `Authorization: Bearer …` 和 `Cookie`。在自己的浏览器打开数据中心订单详情，在开发者工具的 Network 中选中 `apid.iproyal.com` 的 `/v1/orders/订单号/bandwidth` 请求，在本机查看 Request Headers。把 Bearer 后面的值填入 `bearer`。可以先只填这一项测试。需要完整登录态时再填该请求发给同一 API 域的 Cookie。登录密码和代理节点的连接密码都无需填写。后台使用的接口和公开 reseller API 各自有不同的鉴权约定。
3. 将下面的 JSON 存入 X3 的私有凭据文件，使用受限文件权限。服务支持 `IPROYAL_CREDENTIALS_FILE` 指定文件路径。真实凭据只在本机或服务器的私密编辑器输入，不放在命令行、聊天或仓库中。

```json
{
  "bearer": "<后台会话的 Bearer 值>",
  "cookie": "<可选，发往 apid.iproyal.com 的 Cookie>"
}
```

X3 使用 systemd 时，可将原始文件保存在 `/etc/tosub2/iproyal.json`，由 root 持有，权限设为 `0600`。在 `systemctl edit tosub2.service` 的服务覆盖配置中添加如下内容，让服务取得自己的只读副本。

```ini
[Service]
LoadCredential=iproyal.json:/etc/tosub2/iproyal.json
Environment=IPROYAL_CREDENTIALS_FILE=%d/iproyal.json
```

首次配置后执行 `sudo systemctl daemon-reload` 和 `sudo systemctl restart tosub2.service`，然后从面板测试连接。会话失效时更新私有文件。使用 systemd 的 LoadCredential 时，重启服务才会装入新副本。现有账户已验证仅 Bearer 即可读取库存、余额及订单价格。

## 间隔、自动暂停和成本

在「IPRoyal 巡检」里修改以下设置后点击「保存巡检设置」。设置保存在运行目录的 `iproyal-settings.json`，重启后保留；旧版只有 `enabled` 的设置会自动补齐默认值。状态轮询不会覆盖正在输入的设置。

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| 巡检间隔 | 5 分钟 | 允许 1–1440 分钟的整数；每轮完成后计时。保存启用状态下的设置会立即触发一轮。 |
| 流量达到阈值时暂停新分配 | 关闭 | 订单剩余 GB ≤ 单 IP 阈值 × 订单完整库存中的独立 IP 数时，暂停对应池节点的新分配。 |
| 单 IP 剩余流量阈值 | 10 GB | 允许 0–1000000 GB；同一 IP 的 HTTP/SOCKS 等重复节点只算一个 IP。 |
| 巡检同步 IP 成本 | 关闭 | 启用后，以订单实付美元总额 ÷ 购买 IP 数 × 汇率，更新每个匹配出口 IP 的人民币成本，四舍五入到分。 |
| 美元兑人民币汇率 | 未填写 | 启用成本同步前必须填写，大于 0 且不超过 1000；由用户设定，巡检不会猜测或自动更改汇率。 |

例如，订单含 5 个独立 IP、单 IP 阈值设为 10 GB，则订单阈值为 50 GB，即使本地只接入其中 1 个 IP，仍使用 50 GB。所有对应节点停止参与新分配，已有账号保持原绑定，节点仍保留自己的启用状态。余额补充至 50 GB 以上并巡检成功后，自动暂停解除；手动暂停会保留。查询失败保留上次余额和自动暂停状态。关闭巡检或关闭自动暂停会解除自动条件，手动策略继续生效。

每张 IP 卡片直接提供各节点的「参与分配」和启停开关，卡片底部只编辑一份共享的 IP 成本。开启成本同步后，对应 IPRoyal IP 的成本由巡检更新，卡片显示同步来源并禁用手动成本编辑。参与分配和启停互相独立。

价格来自订单详情的 `amount_with_vat`（缺省时取 `amount`），除以 `order_product.quantity`；不用产品目录的标价。卡片同时展示美元单 IP 价格与购买天数，例如订单实付 $12.15、5 个 IP、30 天，单 IP 为 $2.43/30 天；按 7.2 汇率同步为 ¥17.50。查询价格失败时保留已有成本并显示价格待刷新，其他流量检查继续。此金额对应当前购买周期，不统一解释为月费，也不会每轮生成重复支出；沿用现有购入日账本规则。

设置 API 为认证后的 `GET/PUT /api/iproyal/patrol`，PUT 接受部分字段并校验；开关字段为 `enabled`、`autoPause`、`syncCost`，数值字段为 `intervalMinutes`、`thresholdGbPerIp`、`usdToCny`。`POST` 同一路径请求立即巡检。节点策略 `PUT /api/sub2api/proxies/{id}/allocation` 支持分别提交 `allocationPaused` 或 `ipCostCny`，不会覆盖未提交的另一项。

## 巡检和命名

- 默认每 5 分钟读取池内节点，可修改间隔。通过 helper 新增节点会请求立即巡检。首次或发现未查验 IP 时，批量读取该 IPRoyal 账户的数据中心库存并按 IP 精确匹配。每 24 小时重查库存，未匹配 IP 可在后续补上归属。
- 单 IP 订单使用纯订单号。多 IP 订单按供应商完整订单中的不同 IP 分配后缀，从 1 开始。首次按 IP 数值顺序编号，后续新增 IP 追加序号。相同 IP 的不同协议节点共用名称。多笔订单同时返回同一 IP 时标记冲突，保留原名称。
- 同一订单每轮读取一次 `gb_balance`，所有关联 IP 显示同一个订单余额。0 GB 正常显示。查询失败保留上次读数和时间，过期数据标记为待刷新。
- 巡检读取 IPRoyal 库存、流量及订单价格，更新 Sub2API 节点名称；按设置应用 helper 的新分配条件与本地 IP 成本。关闭开关停止后续巡检，已写入的名称、成本保留。开启前可先导出要保留的自定义名称。

## 使用的协议

| 用途 | 请求 | 使用字段 |
| --- | --- | --- |
| 库存归属 | `GET https://apid.iproyal.com/v1/orders/proxies?product_id=14&page=1&per_page=20&sort_order=desc` | `data[].ip`、`data[].order_id`、分页元数据 |
| 订单余额 | `GET https://apid.iproyal.com/v1/orders/{order_id}/bandwidth` | `gb_limit`、`gb_used`、`gb_balance` |
| 订单价格 | `GET https://apid.iproyal.com/v1/orders/{order_id}` | `id`、`amount_with_vat`/`amount`、`order_product.quantity`、`order_product.product_plan.duration` |

这些路径来自 Dashboard。服务端将请求固定到该域，并禁止重定向。上游更改路径或响应格式时，面板会报告巡检失败。
