# Sub2API Helper 发布习惯

由通用 `$project-release` 读取。仅适用于本项目，相对路径以仓库根目录为准。

## Git 与检查

- 个人仓库 `https://github.com/li-zane/sub2api-helper.git`，`origin/main`；不拉取原作者上游、不强推。
- 英语 `type(scope): description` 提交，只包含本次相关改动及非敏感 `.agents` 配置；保留其他工作、运行数据和凭据。
- `.github/workflows/check.yml` 在 Linux/Windows 执行生产构建、发布工具测试、`npm run check` 和依赖审计。任一检查失败，不发布运行包。
- `main` 推送或手动运行该流水线，检查全部通过后发布不可覆盖的 GitHub Release `helper-<40位提交SHA>`。包版本以提交 SHA 为准，不自动修改 `package.json` 版本。
- 构建环境 Linux x64 / Node 22；产物 `helper-linux-x64-node22.tar.gz` 含源码、生产前端及 Node 依赖，另附 `SHA256SUMS`。包内 `release.json` 记录每个文件的哈希和链接目标；禁止打包运行数据、密钥、`.env`、`tmp/`、测试输出或 `.git/`。

## 线上环境与命令

- SSH 别名 `x3`；代码 `/opt/tosub2/app`；systemd `tosub2.service`，用户 `tosub2`。
- 运行数据 `/var/lib/tosub2`，凭据 `/etc/tosub2/credentials.env`，Python 环境 `/opt/tosub2/venv`；不打印或提交秘密。
- 内部 API `http://127.0.0.1:4399`，公网入口沿用现有认证。匿名 401 不代表故障。
- 安装命令 `/usr/local/sbin/helper-update`，初始工具位于 `/usr/local/lib/sub2api-helper-release/`；服务更新后优先读取当前代码中的 `.agents/release/`。调用前复制本次脚本到独立临时目录，避免更新过程中脚本被替换。

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
3. 每 15 秒只读检查所有分页的运行任务，最多等待 1200 秒；超时退出 75 并保留线上服务，不取消任务。账号分页不完整或读取期间集合变化时停止发布。`--wait-seconds` 可明确调整等待上限。
4. 任务空闲后临时保存账号/IP 绑定、旧 SHA、旧前端、Node 依赖、数据和服务配置，再停止服务、快进源码并安装已构建运行包。验证服务用户读取权限后启动。
5. 验证 systemd active、精确 SHA/干净 main、所有分页的账号集合及代理绑定不变、生产 JS/CSS 的 HTTP 内容哈希一致。不对真实账号执行重登、轮换、登出或付费操作来测试。
6. 切换后失败使用本次临时 `ROLLBACK.sh` 恢复旧 SHA、前端及依赖，保留业务新写入的数据。回滚后是旧 SHA 的 detached HEAD；再次发布前先核实失败 main，保存其分支引用后恢复 main 指向实际运行的旧 SHA，不直接切回失败版本。
7. 成功验证后删除本次暂存产物、旧前端、旧依赖及数据备份，不保留服务器历史运行版本。失败且尚需恢复/排查的副本保留为 root-only；不得清理当前应用、运行数据或服务凭据。GitHub 的不可变 Release 可继续作为版本来源。

## 项目脚本

`.agents/release/` 中的 `bundle.py` 打包及校验文件，`download.py` 下载 GitHub 产物，`helper-update` 是命令入口，`deploy-x3.sh` 负责等待与切换，`state-check.py` 只读核对生产状态，`rollback-x3.sh` 恢复本次临时备份。发布脚本有变化时同步更新安装的初始工具；不复用聊天临时目录中的旧副本。
