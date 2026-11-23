# Sub2API Helper 发布习惯

由通用 `$project-release` 读取。仅适用于本项目，相对路径以仓库根目录为准。

## Git 与检查

- 个人仓库 `https://github.com/li-zane/sub2api-helper.git`，`origin/main`；不拉取原作者上游、不强推。
- 除非用户明确限定范围，每次发布纳入本项目全部待提交改进和待推送提交，包括源码、测试、文档和非敏感 `.agents` 配置。按主题使用英语 `type(scope): description` 提交。运行数据、凭据和临时产物留在本地。
- `.github/workflows/check.yml` 在 Linux/Windows 各分 4 组，通过 `npm run check:ci -- --shard N/4` 执行完整检查；清单自动展开自 `npm run check`，每组内部保留原执行顺序，各组均构建生产前端。全部 8 组通过后才发布运行包。
- 每个平台第 1 组执行发布工具测试和依赖审计；Linux 第 1 组生成唯一运行包。每组将逐项测试耗时保存为 Actions artifact，并在运行摘要中列出最慢的测试。新推送取消同一分支尚在执行的旧测试组，发布运行包的任务仍排队执行。
- 依赖审计使用 `npm run audit:dependencies`，打印原始 npm 审计结果；尚无上游修复的 Picomatch 公告仅在全部本地解析器防护及哈希校验通过后接受，其他 high/critical 问题仍阻止发布。具体边界见 `.agents/ci/dependency-mitigation.md`；安装时自动应用防护，不跳过安装脚本。
- `main` 推送或手动运行该流水线，检查全部通过后发布不可覆盖的 GitHub Release `helper-<40位提交SHA>`。每个提交保留运行包。正式版按 package.json 和 package-lock.json 中的项目版本创建 vMAJOR.MINOR.PATCH Release；已使用的正式版本号不移动。
- 构建环境 Linux x64 / Node 22；产物 `helper-linux-x64-node22.tar.gz` 含源码、生产前端及 Node 依赖，另附 `SHA256SUMS`。包内 `release.json` 记录每个文件的哈希和链接目标；禁止打包运行数据、密钥、`.env`、`tmp/`、测试输出或 `.git/`。

## 线上环境与命令

- SSH 别名 `x3`；代码 `/opt/tosub2/app`；systemd `tosub2.service`，用户 `tosub2`。
- 运行数据 `/var/lib/tosub2`，凭据 `/etc/tosub2/credentials.env`，Python 环境 `/opt/tosub2/venv`；不打印或提交秘密。
- 内部 API `http://127.0.0.1:4399`，公网入口沿用现有认证。匿名 401 不代表故障。
- 安装命令 `/usr/local/sbin/helper-update`，初始工具位于 `/usr/local/lib/sub2api-helper-release/`；服务更新后优先读取当前代码中的 `.agents/release/`。调用前复制本次脚本到独立临时目录，避免更新过程中脚本被替换。
- Codex CLI OAuth 使用 `tosub2` 用户自己的 rootless Docker，不把服务用户加入宿主 `docker` 组。用户服务 `helper-codex-docker.service`，套接字 `/run/tosub2-codex/docker.sock`，镜像及容器运行数据在 `/var/lib/tosub2-codex/docker`；不放进账号目录的升级备份。Helper 通过服务环境 `DOCKER_HOST=unix:///run/tosub2-codex/docker.sock` 连接，保留已有 systemd 隔离设置。
- CLI 镜像由 `tools/codex-cli` 的固定版本与基础镜像摘要构建，发布前在构建机验证；x3 仅导入已校验摘要的镜像，不现场执行 npm 构建。新版本更新 CLI 时先准备对应镜像，再排空切换 Helper。验证以服务用户启动全新未登录 CLI、生成/取消链接、销毁容器，不对真实账号授权；也不自动切换全局授权方式或写网关 UA。

```bash
# 只验证最新产物，不切换或重启
ssh x3 'helper-update --check'
# 更新到最新通过检查并发布的版本
ssh x3 'helper-update'
# 固定到已核实的完整提交 SHA
ssh x3 'helper-update <40位SHA> --wait-seconds 1200'
```

推送后核实对应提交的 GitHub Actions 运行；若未自动创建，显式调度 `Check` 的 `workflow_dispatch`，`ref=main`，并再次核实运行 SHA。等待该提交的全部检查和 Release 就绪，再按用户本轮授权执行更新。仅修改发布配置、规则或安装命令不代表要求切换业务版本；不执行更新时仍应使用 `--check` 验证完整下载和校验路径。

## 更新、验证与清理

1. 确认线上是干净的个人 `main`，记录精确旧 SHA；锁定本次部署。解析不可变 Release，校验 GitHub 资产摘要、`SHA256SUMS`、完整文件清单、平台和提交号，并核实 Node 22 与 Python 环境。x3 不执行 npm 安装、前端构建或源码测试。
2. 使用 Git fetch 获取精确已发布提交，只允许沿个人 main 快进；不直接更新到尚未发布的最新源码。Python 依赖声明变化时在停服前停止，单独准备兼容环境。
3. 切换前仅暂停新任务派发，不改账号和监控开关；已受理任务及其输入、取消继续。安装器进程持有临时维护标记，成功、超时或进程退出均不应遗留有效暂停。新服务在验证期间保持暂停，移除标记并核实派发就绪后才报告成功。每 15 秒只读检查所有分页的运行任务，最多等待 1200 秒；超时退出 75 并保留线上服务，不取消任务。账号分页不完整或读取期间集合变化时停止发布。`--wait-seconds` 可明确调整等待上限。
4. 任务空闲后临时保存账号/IP 绑定、旧 SHA、旧前端、Node 依赖、数据和服务配置，再停止服务、快进源码并安装已构建运行包。验证服务用户读取权限后启动。
5. 验证 systemd active、精确 SHA/干净 main、所有分页的账号集合及代理绑定不变、生产 JS/CSS 的 HTTP 内容哈希一致。不对真实账号执行重登、轮换、登出或付费操作来测试。
6. 切换后失败使用本次临时 `ROLLBACK.sh` 恢复旧 SHA、前端及依赖，保留业务新写入的数据。回滚后是旧 SHA 的 detached HEAD；再次发布前先核实失败 main，保存其分支引用后恢复 main 指向实际运行的旧 SHA，不直接切回失败版本。
7. 成功验证后删除本次暂存产物、旧前端、旧依赖及数据备份，不保留服务器历史运行版本。失败且尚需恢复/排查的副本保留为 root-only；不得清理当前应用、运行数据或服务凭据。GitHub 的不可变 Release 可继续作为版本来源。

## 项目脚本

`.agents/release/` 中的 `bundle.py` 打包及校验文件，`download.py` 下载 GitHub 产物，`helper-update` 是命令入口，`deploy-x3.sh` 负责等待与切换，`state-check.py` 只读核对生产状态，`rollback-x3.sh` 恢复本次临时备份。发布脚本有变化时同步更新安装的初始工具；不复用聊天临时目录中的旧副本。
