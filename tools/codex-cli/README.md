# Codex CLI OAuth：一次性授权环境

CLI 的 Dockerfile、锁文件、构建脚本和 Helper 接入代码随 Helper 源码及运行包交付。当前发布脚本不会自动安装 Docker 或构建 CLI 镜像；在 Helper 主机准备 Node.js 22+、Linux 容器 Docker，并用服务访问的同一 Docker daemon 构建一次镜像：

```sh
npm run codex:build
npm run codex:check
```

同一主机的所有 worker 共用这份只读镜像，不需要按账号安装 CLI。镜像固定 `@openai/codex` 0.165.0 和 Node 基础镜像摘要。Helper 服务用户需要访问该 Docker daemon；OAuth 期间不会自动下载或构建镜像。

`codex:check` 是部署就绪探测：启动一个未登录临时环境，生成并取消授权链接，核实清理后退出，不读取真实账号凭据或改动网关设置。使用 rootless Docker 时设置服务的 `DOCKER_HOST` 指向该用户的套接字，并以实际 Helper 服务用户运行此探测。

在控制台保存 Sub2API 后端地址和管理员 API Key，然后打开「任务设置 → Codex 授权方式」，选择「Codex CLI OAuth（账号独立环境）」并保存。账号的授权或重新授权操作会执行以下流程：

1. 为本次任务生成随机环境 ID，启动一个全新容器。`CODEX_HOME` 位于容器独占的 tmpfs 内存目录，权限 0700，没有宿主目录挂载或持久化卷。
2. 官方 CLI app-server 生成 PKCE 授权链接，Helper 把链接交给当前账号已有的 Web 会话。
3. Helper 校验回调的来源、路径及 state，通过 stdin 把回调送到该容器内部的 localhost:1455，由 CLI 兑换并写入 `auth.json`。CLI 返回 302/303 时，Helper 仅跟随同一回环端口的 `/success`，让 CLI 结束本地登录服务并发出完成通知。
4. 收到成功的 `account/login/completed` 通知后，读取 `auth.json`，核对邮箱、工作区及已知的访问令牌有效期，转换成 Sub2API 格式并原子写入导出文件；授权不读取或写入网关 UA。回调页 HTTP 200 本身不表示授权成功。
5. 导出文件保存成功后销毁容器，确认容器已消失。本次 CLI 的 `auth.json`、配置、安装标识和其他临时状态随 tmpfs 释放。同账号再次授权也创建全新环境。

取消、验证失败及导出失败同样执行清理。失败不会覆盖之前的导出文件；若导出已经写入而清理失败，会保留导出并报告清理错误，避免把未完成清理当作成功。进程退出有清理处理；worker 被强制终止后，stdin 关闭使 CLI 退出，Docker `--rm` 删除临时容器。Docker daemon 故障时清理会报错，恢复后应核查带有 `com.sub2api-helper.codex-oauth=one-shot` 标签的残留容器。

任务日志使用 `[env=环境 ID] stage=阶段 start/ok/failed duration_ms=耗时` 关联一次授权的环境创建、链接生成、Web 授权、回调、CLI 完成通知、凭据校验、导出和清理。回调另记 `/auth/callback` 与 `/success` 的 HTTP 状态；失败同时出现清理错误时，两处均记录失败，最终错误保留最初的原因。日志不记录回调查询参数、token 或 CLI 上游响应正文。

临时容器清理仅删除本地 CLI 环境。上游可能把每次新 OAuth 凭据登记成一条设备或会话记录，即使授权复用了原 Web 登录态。该记录与本地容器是否存活无关；远端注销可能撤销导出凭据，因此清理容器不附带设备登出。

导入自动流程曾在授权或上传步骤失败时，后续授权及号池同步成功会接续原队列中尚未完成、且当前套餐规则仍启用的过载检测、冷却和一次降智检测。已完成的 2FA、登出、授权及上传不会重做。服务重启也会核对本地与号池的刷新凭据，再恢复这类后置规则；暂停账号、未同步凭据和未完成的安全设置继续保留原状态。一次降智检测复用原任务 ID，完成后重启不重复检测。

后续 refresh token 刷新使用已导出的凭据，由已配置的 Sub2API 后端完成，携带可用的号池代理 ID，不依赖已销毁的 CLI 环境，也不额外维持第二份活跃 refresh token。刷新令牌失效时，现有重新授权流程会创建新的临时环境。网页登录会话属于 Helper 自身的账号状态，不属于这次被销毁的 CLI 临时环境。

## 多 worker

现有调度器在一个 Helper 进程中按 `maxActiveJobs` 启动多个 OAuth 子进程。它们使用同一个任务状态目录和 Docker daemon：

- 不同账号可以同时授权；每次任务拥有独立的进程、tmpfs、主机名、网络命名空间和 OAuth state/PKCE。
- 各容器内部均可使用 1455 回调端口，无宿主端口发布，所以并行任务不会争用宿主的 1455。
- 同一账号通过共享 SQLite 协调锁互斥。持有者 PID 检查、失效锁回收及抢占在短事务内完成，防止多个重试进程同时接管。OAuth 期间不持有数据库事务，所以其他账号继续并行。等待超时会报错，不抢占仍在运行的任务。
- 网关 UA 是全局配置，仅点击任务设置中的同步按钮时执行 GET/合并/PUT/读回，并使用同一把网关锁。相同 UA 跳过 PUT，账号 OAuth 不参与 UA 同步。
- 状态目录仅保留 SQLite 协调库和不含凭据的 UA 审计记录，不再保存按账号的 CLI 配置或登录目录。正常结束后删除对应锁记录，数据库本身供后续 worker 继续协调。

这些锁针对同主机、同 PID 命名空间、共享状态目录的当前 worker 架构。多台独立主机或多个 PID 命名空间的 Helper 副本需要分布式租约及统一的网关 UA 写入者；当前实现没有把本地协调库当成分布式锁。

容器提供进程、文件系统状态和网络命名空间隔离，但共享宿主内核。相同镜像的 UA、TLS 实现可以相同，出口 IP 由代理配置决定；这里的独立环境不等于不同硬件指纹或独立公网 IP。CLI 使用当前账号选定的代理，不继承宿主 Codex 认证。宿主回环代理通过 `host.docker.internal` 访问，代理需接受来自 Docker 的连接。

## 凭据与 UA

`tokens.account_id` 映射到 `credentials.chatgpt_account_id`，不会用 JWT 的 `sid` 代替工作区 ID。access/refresh/id token 原样保留；过期时间、套餐及用户 ID 从相应声明读取。字段一致性校验不等于对本地 JWT 的独立签名验证。

任务设置显示当前 CLI UA 和号池 UA，并提供“重新读取”“同步 CLI UA 到号池”按钮。打开设置仅做对比读取；CLI 探针只执行 `initialize`，不生成授权链接、不登录账号，结束后销毁临时容器。探测结果在 Helper 进程中缓存 10 分钟，并发读取共用一次探测；重新读取会强制刷新，失败不显示旧缓存为当前值。

UA 使用 CLI `initialize` 实际返回的 `userAgent`。仅手动点击同步时写入 Sub2API 全局 `openai_codex_user_agent`，立即生效，不依赖“保存设置”，也不改变授权方式。服务端使用自己的探测值，不接受浏览器任意指定 UA；号池配置或已展示的 UA 变更时，要求重新读取确认。由于设置接口 PUT 对部分旧字段采用整体保存语义，会先 GET 全部设置、合并 UA、PUT 保存并再次 GET 核对。其他管理客户端同时编辑设置时应避免与同步重叠；该接口没有原子字段更新保证。旧 UA 与同步时间保存在不含账号 token 的 `gateway-ua-last-sync.json`。

源码回退不会撤销网关 UA 或删除 Helper 的导出凭据。此前版本创建的持久卷也不会被新代码批量删除；本版本的新授权任务全部使用一次性 tmpfs。

验证命令：

```sh
node test/codex-cli-oauth.mjs
node test/codex-cli-callback.mjs
node test/codex-cli-ua.mjs
node test/sub2api-oauth-flow.mjs
node test/codex-cli-docker.mjs
node test/codex-cli-login-docker.mjs
```

单元测试使用模拟凭据和本地网关，验证回调跳转边界、阶段日志、导出在清理前落盘、失败保留和不依赖 Docker 的后续刷新。worker Docker 测试启动三个真实独立 worker，同时运行官方 CLI，检查独立回调、相同账号串行、干净重试、取消/异常退出清理，并让三个 worker 同时同步模拟网关，确认仅写入一次 UA。

登录 Docker 回归在 `--network=none` 的容器内启动本地模拟 OAuth 服务，向官方 CLI 提供合成凭据，验证回调 → `/success` → 完成通知 → Sub2API 导出 → 清理的整个流程，以及 token 兑换被拒绝时的错误通知。它执行实际生产回调桥接代码，不访问外部授权服务或使用真实账号。Linux CI 第 1 组必须通过这两项 Docker 测试后才生成运行包。
