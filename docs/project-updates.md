# 版本与更新

项目从 **v0.1.0** 开始使用正式发布版本号。点击控制台顶栏的版本号进入「版本与更新」。「检查 GitHub 更新」只读本项目的正式 Release。发现新版本后，再次确认才会安装。安装在独立的系统服务中进行；关闭弹窗或 helper 在切换时重启都不影响进度。重新打开可查看结果。

安装使用正式版本对应的精确提交和经校验的 Linux x64 / Node 22 运行包。安装器暂停新派发、等待在途任务完成、验证启动与账号绑定；超时推迟，不强停任务。切换失败沿用原部署回滚流程。未启用安装组件的主机也可以检查版本和发布信息。

## x3

首次迁移到语义化版本，从已有环境使用原来的 `helper-update <完整提交 SHA>`。然后从已校验且由 root 管理的生产 checkout 注册更新组件：

```sh
sudo bash /opt/tosub2/app/.agents/release/install-update-agent.sh
systemctl is-active tosub2-update.socket
```

更新组件仅监听本机 Unix socket。Web 进程仍以普通用户运行，没有 sudo 或 shell 权限。继续使用现有的管理员访问控制，不要直接公开控制台及其 bootstrap/API。更新组件会独立核验正式标签、提交、下载内容和版本顺序。也可以运行 `helper-update v0.1.0 --check` 只校验发布包。

## 发布下一版

1. 同步修改 `package.json` 和 `package-lock.json` 中的项目版本，在 `docs/releases/vX.Y.Z.md` 写变更说明。
2. 合入 main 并通过全部 8 组检查。CI 保留每个提交的运行包，并为未使用的版本号创建 `vX.Y.Z` 正式 Release。相同版本号不会覆盖已发布版本。
3. 在项目内检查并按需安装。不重装当前版本，不从正式更新入口降级。
