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

首次配置后执行 `sudo systemctl daemon-reload` 和 `sudo systemctl restart tosub2.service`，然后从面板测试连接。会话失效时更新私有文件。使用 systemd 的 LoadCredential 时，重启服务才会装入新副本。网页两种凭据同时存在时实测可读，Bearer 单独使用能否成功以「测试连接」为准。

## 巡检和命名

- 每 5 分钟读取池内节点。通过 helper 新增节点会请求立即巡检。首次或发现未查验 IP 时，批量读取该 IPRoyal 账户的数据中心库存并按 IP 精确匹配。每 24 小时重查库存，未匹配 IP 可在后续补上归属。
- 单 IP 订单使用纯订单号。多 IP 订单按供应商完整订单中的不同 IP 分配后缀，从 1 开始。首次按 IP 数值顺序编号，后续新增 IP 追加序号。相同 IP 的不同协议节点共用名称。多笔订单同时返回同一 IP 时标记冲突，保留原名称。
- 同一订单每轮读取一次 `gb_balance`，所有关联 IP 显示同一个订单余额。0 GB 正常显示。查询失败保留上次读数和时间，过期数据标记为待刷新。
- 查询和改名只涉及 IPRoyal 库存、流量与 Sub2API 节点名称。关闭开关停止后续巡检，已写入的名称保留。开启前可先导出要保留的自定义名称。

## 使用的协议

| 用途 | 请求 | 使用字段 |
| --- | --- | --- |
| 库存归属 | `GET https://apid.iproyal.com/v1/orders/proxies?product_id=14&page=1&per_page=20&sort_order=desc` | `data[].ip`、`data[].order_id`、分页元数据 |
| 订单余额 | `GET https://apid.iproyal.com/v1/orders/{order_id}/bandwidth` | `gb_limit`、`gb_used`、`gb_balance` |

这两个路径来自 Dashboard。服务端将请求固定到该域，并禁止重定向。上游更改路径或响应格式时，面板会报告巡检失败。
