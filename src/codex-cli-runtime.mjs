import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { CLI_CALLBACK_SCRIPT } from "./codex-cli-callback.mjs";

export const CODEX_CLI_VERSION = "0.165.0";
export const CODEX_CLI_IMAGE = `sub2api-helper/codex-cli:${CODEX_CLI_VERSION}`;
const fail = (message) => new Error(`CODEX_CLI: ${message}`);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function normalizeCliEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw fail("账号邮箱格式错误");
  return email;
}

export async function cliProfile(root, email) {
  if (!root) throw fail("缺少持久化目录");
  email = normalizeCliEmail(email);
  root = path.resolve(root);
  const key = digest(`codex-cli-account\0${email}`);
  const runId = randomUUID();
  // Stable account key only for mutual exclusion. Every attempt, including a
  // retry for the same account, gets a new container and an empty tmpfs home.
  return { root, key, email, runId, container: `helper-cli-${runId}`,
    hostname: `codex-${runId.replaceAll("-", "")}` };
}

export async function withCliLock(root, name, action) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "codex-cli-locks.sqlite");
  const db = new DatabaseSync(file);
  const key = digest(name), owner = randomUUID();
  let acquired = false;
  const deadline = Date.now() + 35_000;
  try {
    db.exec("PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS cli_locks (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner TEXT NOT NULL)");
    await fs.chmod(file, 0o600);
    for (;;) {
      // All workers see one atomic owner check/replacement. No database
      // transaction remains open while OAuth or gateway requests are running.
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT pid FROM cli_locks WHERE key = ?").get(key);
        let alive = Boolean(current);
        if (current) {
          try { process.kill(Number(current.pid), 0); } catch (error) { if (error.code === "ESRCH") alive = false; }
        }
        if (!alive) {
          db.prepare("INSERT OR REPLACE INTO cli_locks (key,pid,owner) VALUES (?,?,?)").run(key, process.pid, owner);
          acquired = true;
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      if (acquired) break;
      if (Date.now() >= deadline) throw fail("同一环境正在使用，请稍后重试");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return await action();
  } finally {
    try { if (acquired) db.prepare("DELETE FROM cli_locks WHERE key = ? AND owner = ?").run(key, owner); }
    finally { db.close(); }
  }
}

function dockerEnv(proxyUrl) {
  // Do not pass the helper's account tokens, Codex credentials or gateway key
  // into the container. Docker receives proxy values via its own environment.
  const env = { ...process.env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) throw fail("代理协议不受支持");
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = url.href;
  }
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  return env;
}

export function cliContainerArgs(profile, { proxyUrl, workspaceId } = {}) {
  return ["create", "--rm", "--interactive", "--init", "--pull=never", "--name", profile.container,
    "--hostname", profile.hostname, "--user=1000:1000", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--log-driver=none", "--add-host=host.docker.internal:host-gateway",
    "--label", "com.sub2api-helper.codex-oauth=one-shot",
    "--tmpfs", "/tmp:rw,nodev,nosuid,noexec,size=32m",
    "--tmpfs", "/home/node/.codex:rw,nodev,nosuid,noexec,uid=1000,gid=1000,mode=0700,size=128m",
    "--env", "CODEX_HOME=/home/node/.codex", "--env", "NO_PROXY",
    ...(proxyUrl ? ["--env", "HTTP_PROXY", "--env", "HTTPS_PROXY", "--env", "ALL_PROXY"] : []),
    CODEX_CLI_IMAGE, "-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"',
    ...(workspaceId ? ["-c", `forced_chatgpt_workspace_id=${JSON.stringify(workspaceId)}`] : []),
    "app-server"];
}

function docker(args, { input, env, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(fail("Docker 操作超时")); }, timeout);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 1_000_000) { child.kill(); reject(fail("CLI 输出超过大小限制")); }
    });
    child.stderr.resume(); // Never copy token-bearing upstream errors into logs.
    child.on("error", () => { clearTimeout(timer); reject(fail("请检查 Docker 服务及 CLI 镜像")); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(fail("Docker 操作失败，请检查镜像、环境占用或代理")); });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

export async function deliverCliCallbackToContainer(id, callbackUrl, { env, onProgress } = {}) {
  const raw = await docker(["exec", "--interactive", id, "node", "--input-type=module", "-e", CLI_CALLBACK_SCRIPT],
    { input: callbackUrl, env, timeout: 100_000 });
  let result;
  try { result = JSON.parse(raw); } catch { throw fail("CLI 回调桥接响应格式错误"); }
  const callbackStatus = Number.isInteger(result?.callbackStatus) ? result.callbackStatus : null;
  const successStatus = Number.isInteger(result?.successStatus) ? result.successStatus : null;
  onProgress?.(`本地回调 HTTP ${callbackStatus ?? "未返回"}；/success HTTP ${successStatus ?? "未访问"}`);
  if (result?.ok !== true) {
    const stage = result?.stage === "success" ? "/success" : "/auth/callback";
    const codes = ["INVALID_DESTINATION", "MISSING_LOCATION", "HTTP_STATUS", "TIMEOUT", "CONNECTION"];
    const code = codes.includes(result?.code) ? result.code : "BRIDGE_RESPONSE";
    throw fail(`CLI 回调收尾失败：${stage} ${code}`);
  }
  if (callbackStatus !== 200 && !(result.followedSuccess === true && [302, 303].includes(callbackStatus) && successStatus === 200)) {
    throw fail("CLI 回调收尾结果不完整");
  }
  return result;
}

export async function openCliSession(profile, options = {}) {
  const env = dockerEnv(options.proxyUrl);
  // Save the returned ID before attaching. Failed creates must never remove
  // another process's container with the same account name.
  const id = (await docker(cliContainerArgs(profile, options), { env })).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw fail("Docker 返回的容器标识无效");
  const pending = new Map();
  const notifications = new Map();
  let sequence = 0, ended = false, closed = false;
  const child = spawn("docker", ["start", "--attach", "--interactive", id], { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const abort = () => {
    ended = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fail("CLI 进程已结束")); }
    pending.clear();
  };
  child.on("error", abort);
  child.on("close", abort);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (line.length > 1_000_000) { abort(); child.kill(); return; }
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (item) {
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) {
        const invalidRefresh = /invalid_grant|refresh_token_(?:expired|reused|invalidated)|refresh token.{0,80}(?:expired|invalid|already been used)/i.test(String(message.error.message || ""));
        item.reject(invalidRefresh ? new Error("REFRESH_TOKEN_INVALID: CLI 刷新令牌已失效，请重新授权") : fail("CLI 请求失败，请重新授权或检查连接"));
      } else item.resolve(message.result);
    } else if (message.method === "account/login/completed") {
      notifications.set(message.params?.loginId, message.params);
    }
  });
  const cleanupSync = () => spawnSync("docker", ["rm", "--force", id], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
  const signal = () => { cleanupSync(); process.exit(143); };
  process.once("exit", cleanupSync);
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (ended) { reject(fail("CLI 进程已结束")); return; }
    const requestId = ++sequence;
    const timer = setTimeout(() => { pending.delete(requestId); reject(fail("CLI 请求超时")); }, 120_000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  const session = {
    request,
    async deliverCallback(callbackUrl) {
      // The caller validates state/origin first; the bridge also limits the
      // destination. Callback codes travel on stdin, never in process arguments.
      return deliverCliCallbackToContainer(id, callbackUrl, { env, onProgress: options.onProgress });
    },
    async waitForLogin(loginId) {
      const deadline = Date.now() + 120_000;
      while (!notifications.has(loginId)) {
        if (ended || Date.now() >= deadline) throw fail("等待 CLI 登录结果超时");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!notifications.get(loginId).success) throw fail("CLI 未完成授权，请重试");
    },
    async readAuth() {
      const raw = await docker(["exec", id, "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/home/node/.codex/auth.json'))"]);
      try { return JSON.parse(raw); } catch { throw fail("CLI 认证文件格式错误"); }
    },
    async discardAuth() {
      await request("account/logout", {}).catch(() => {});
      await docker(["exec", id, "node", "-e", "require('node:fs').rmSync('/home/node/.codex/auth.json',{force:true})"]);
    },
    async close() {
      if (closed) return;
      child.stdin.end();
      await docker(["rm", "--force", id]).catch(() => {});
      try {
        // --rm can win the race with explicit removal. A successful empty
        // listing confirms cleanup; daemon errors must not count as success.
        if ((await docker(["ps", "--all", "--quiet", "--filter", `id=${id}`])).trim()) throw fail("临时授权容器尚未清理");
        closed = true;
        process.off("exit", cleanupSync); process.off("SIGTERM", signal); process.off("SIGINT", signal);
      } finally { child.kill(); lines.close(); abort(); }
    },
  };
  try {
    const initialized = await request("initialize", { clientInfo: { name: "codex_cli_rs", version: CODEX_CLI_VERSION } });
    session.userAgent = initialized.userAgent;
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return session;
  } catch (error) { await session.close(); throw error; }
}
