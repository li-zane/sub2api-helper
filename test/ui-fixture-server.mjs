import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Isolated data only: no saved credentials or live account operations.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-ui-browser-"));
console.log("UI_FIXTURE creating isolated data");
for (let n = 1; n <= 24; n++) {
  const dir = path.join(root, `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`);
  await fs.mkdir(dir, { recursive: true });
  const email = `review-${n}@example.test`;
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({
    version: 1, email, status: n === 2 ? "banned" : n === 3 ? "failed" : "completed",
    remark: n === 1 ? "UI regression fixture" : "",
    plan_type: n % 2 ? "team" : "free", workspace_plan_type: n === 1 ? "business" : null,
    result_saved: n !== 2 && n !== 3, created_at: "2026-11-03T00:00:00Z", completed_at: "2026-11-03T00:01:00Z",
  }));
  if (n !== 2 && n !== 3) await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, access_token: "fixture", refresh_token: "fixture" }, extra: {} }] }));
}
console.log(`UI_FIXTURE starting on ${process.env.UI_TEST_PORT || "44919"}`);
const child = spawn(process.execPath, [process.env.UI_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", process.env.UI_TEST_PORT || "44919"], {
  env: { ...process.env, NODE_ENV: process.env.UI_TEST_NODE_ENV || "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" },
  windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
});
process.on("SIGINT", () => child.kill("SIGTERM"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.stdin.setEncoding("utf8");
process.stdin.on("data", text => { if (text.includes("stop")) child.kill("SIGTERM"); });
child.on("error", error => { console.error(error); process.stdin.destroy(); process.exitCode = 1; });
child.on("exit", async code => {
  process.stdin.destroy();
  await fs.rm(root, { recursive: true, force: true });
  process.exitCode = code || 0;
});
