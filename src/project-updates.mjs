import fs from "node:fs/promises";
import net from "node:net";
import pkg from "../package.json" with { type: "json" };

export const PROJECT_VERSION = pkg.version;
export const REPO = "li-zane/sub2api-helper";
const github = "https://github.com/" + REPO;
const socketPath = "/run/tosub2-update.sock",
  statePath = "/run/tosub2-update/status.json";
const names = ["helper-linux-x64-node22.tar.gz", "SHA256SUMS"];
const versionRE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const phases = new Set([
  "checking",
  "downloading",
  "draining",
  "installing",
  "verifying",
  "succeeded",
  "failed",
  "deferred",
  "interrupted",
]);
const err = (status, message) => Object.assign(Error(message), { status });
export function compareVersions(a, b) {
  if (!versionRE.test(a) || !versionRE.test(b))
    throw err(502, "版本号格式不正确");
  const av = a.split(".").map(Number),
    bv = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (av[i] !== bv[i]) return Math.sign(av[i] - bv[i]);
  return 0;
}
export function stableRelease(data) {
  const tag = data?.tag_name || "",
    version = tag.slice(1);
  if (
    tag !== "v" + version ||
    !versionRE.test(version) ||
    data.draft !== false ||
    data.prerelease !== false ||
    !/^[a-f0-9]{40}$/.test(data.target_commitish) ||
    data.html_url !== github + "/releases/tag/" + tag ||
    !names.every((name) =>
      data.assets?.some(
        (a) =>
          a.name === name &&
          a.size > 0 &&
          a.browser_download_url ===
            github + "/releases/download/" + tag + "/" + name,
      ),
    )
  )
    throw err(502, "GitHub 尚无可安装的正式版本或发布包不完整");
  return {
    version,
    revision: data.target_commitish,
    url: data.html_url,
    publishedAt: data.published_at || null,
  };
}
async function latestRelease() {
  let r;
  try {
    r = await fetch(
      "https://api.github.com/repos/" + REPO + "/releases/latest",
      {
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "sub2api-helper-updater/" + PROJECT_VERSION,
        },
      },
    );
  } catch {
    throw err(502, "连接 GitHub 超时或失败，请稍后重试");
  }
  if (!r.ok) throw err(502, "GitHub 发布查询失败（HTTP " + r.status + "）");
  return stableRelease(await r.json());
}
async function bridgeAvailable() {
  try {
    return (
      process.platform === "linux" && (await fs.stat(socketPath)).isSocket()
    );
  } catch {
    return false;
  }
}
async function readState() {
  try {
    const s = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (
      !phases.has(s.phase) ||
      !versionRE.test(s.version) ||
      !Number.isFinite(Date.parse(s.updatedAt))
    )
      return null;
    const stale =
      Date.now() - Date.parse(s.updatedAt) > 50 * 60000 &&
      !["succeeded", "failed", "deferred"].includes(s.phase);
    return {
      version: s.version,
      phase: stale ? "interrupted" : s.phase,
      updatedAt: s.updatedAt,
    };
  } catch {
    return null;
  }
}
async function sendInstall(release) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    let reply = "";
    const fail = () => {
      s.destroy();
      reject(err(503, "更新服务暂不可用，请检查服务器更新组件"));
    };
    s.setTimeout(8000, fail);
    s.on("error", fail);
    s.on("end", () => {
      if (!reply.includes("\n")) fail();
    });
    s.on("connect", () =>
      s.write(
        JSON.stringify({
          version: release.version,
          revision: release.revision,
        }) + "\n",
      ),
    );
    s.on("data", (chunk) => {
      reply += chunk.toString();
      if (reply.length > 512) return fail();
      if (!reply.includes("\n")) return;
      s.destroy();
      try {
        const r = JSON.parse(reply.trim());
        if (r.accepted) resolve();
        else
          reject(
            err(
              409,
              r.reason === "busy"
                ? "另一个更新正在处理"
                : "更新请求已过期或不适用，请重新检查",
            ),
          );
      } catch {
        fail();
      }
    });
  });
}
export function createProjectUpdates({
  current = PROJECT_VERSION,
  load = latestRelease,
  available = bridgeAvailable,
  state = readState,
  install = sendInstall,
} = {}) {
  let latest = null,
    checkedAt = null,
    checking = null,
    installing = false;
  const refresh = () =>
    (checking ??= Promise.resolve()
      .then(load)
      .then((r) => {
        latest = r;
        checkedAt = new Date().toISOString();
        return r;
      })
      .finally(() => {
        checking = null;
      }));
  const snapshot = async () => ({
    current,
    latest,
    checkedAt,
    configured: await available(),
    operation: await state(),
    updateAvailable: !!latest && compareVersions(latest.version, current) > 0,
  });
  return {
    snapshot,
    check: async () => {
      await refresh();
      return snapshot();
    },
    apply: async (input) => {
      if (
        input?.confirm !== true ||
        !versionRE.test(input?.version || "") ||
        !/^[a-f0-9]{40}$/.test(input?.revision || "")
      )
        throw err(400, "请确认刚刚检查到的版本");
      if (installing) throw err(409, "更新正在提交");
      installing = true;
      try {
        const r = await refresh();
        if (
          r.version !== input.version ||
          r.revision !== input.revision ||
          compareVersions(r.version, current) <= 0
        )
          throw err(409, "没有可安装的新版本，请重新检查");
        if (!(await available())) throw err(503, "尚未安装服务器更新组件");
        await install(r);
        return snapshot();
      } finally {
        installing = false;
      }
    },
  };
}
