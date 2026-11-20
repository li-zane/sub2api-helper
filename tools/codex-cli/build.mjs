import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEX_CLI_IMAGE } from "../../src/codex-cli-runtime.mjs";

const result = spawnSync("docker", ["build", "--tag", CODEX_CLI_IMAGE, fileURLToPath(new URL(".", import.meta.url))],
  { shell: false, windowsHide: true, stdio: "inherit" });
if (result.error) console.error("请先安装并启动 Docker（Linux 容器）。");
process.exitCode = result.status ?? 1;
