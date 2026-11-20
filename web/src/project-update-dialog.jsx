import React, { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ExternalLink,
  Github,
  RefreshCw,
  X,
} from "lucide-react";
import { AccessibleDialog } from "./accessible-dialog.jsx";

const labels = {
  checking: "正在核对 GitHub 正式版本",
  downloading: "正在下载并校验运行包",
  draining: "正在等已受理的任务完成",
  installing: "正在切换版本",
  verifying: "正在核对服务与账号绑定",
  succeeded: "更新成功",
  deferred: "仍有任务在运行，本次暂缓更新",
  failed: "更新没有完成，请检查服务后重试",
  interrupted: "更新状态已过期，请重新检查",
};
const active = (phase) =>
  ["checking", "downloading", "draining", "installing", "verifying"].includes(
    phase,
  );
export function ProjectUpdateDialog({ request, onClose }) {
  const id = useId(),
    live = useRef(true),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [accepted, setAccepted] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let closed = false,
      timer;
    async function poll() {
      try {
        const r = await request("/api/project-update");
        if (!closed && !lock.current) {
          setData(r);
          setError("");
          if (r.operation && !active(r.operation.phase)) setAccepted(false);
        }
      } catch (e) {
        if (!closed && !lock.current)
          setError(accepted ? "服务正在切换，稍后会自动重新连接" : e.message);
      }
      if (!closed)
        timer = setTimeout(
          poll,
          accepted || active(data?.operation?.phase) ? 2500 : 12000,
        );
    }
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [request, accepted, data?.operation?.phase]);
  async function action(install) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await request(
        "/api/project-update/" + (install ? "install" : "check"),
        {
          method: "POST",
          body: JSON.stringify(
            install
              ? {
                  version: data.latest.version,
                  revision: data.latest.revision,
                  confirm: true,
                }
              : {},
          ),
        },
      );
      if (live.current) {
        setData(r);
        setAccepted(install);
        setConfirm(false);
      }
    } catch (e) {
      if (live.current) {
        setError(e.message);
        setConfirm(false);
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  }
  const working = accepted || active(data?.operation?.phase);
  return (
    <AccessibleDialog
      className="project-updates"
      labelledBy={id}
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id={id}>版本与更新</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭版本与更新"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div className="project-updates-body">
        <div className="project-package">
          <Github size={22} />
          <div>
            <strong>Sub2api Helper</strong>
            <p>GitHub 正式发布渠道</p>
          </div>
          <span>v{data?.current || "…"}</span>
        </div>
        {data?.latest ? (
          <div className="project-release-meta">
            <strong>
              {data.updateAvailable
                ? "可更新到 v" + data.latest.version
                : "当前已是最新正式版"}
            </strong>
            <a href={data.latest.url} target="_blank" rel="noreferrer">
              查看 v{data.latest.version} 发布说明 <ExternalLink size={12} />
            </a>
          </div>
        ) : (
          <p>检查项目的 GitHub Release，只有确认安装后才会更新。</p>
        )}
        {data && !data.configured && (
          <p>当前主机未启用安装组件，仍可查看发布信息。</p>
        )}
        {data?.operation && (
          <p className="project-update-state" role="status">
            v{data.operation.version} · {labels[data.operation.phase]}
          </p>
        )}
        {accepted && !data?.operation && (
          <p role="status">服务器已接收更新请求。</p>
        )}
        {error && <p role="alert">{error}</p>}
        {confirm && (
          <div className="project-confirm" role="group" aria-label="确认更新">
            <strong>安装 v{data.latest.version}？</strong>
            <p>
              将暂停新任务派发，等在途任务完成后更新，健康检查通过后恢复派发。关闭窗口不影响更新。
            </p>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        {confirm ? (
          <>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirm(false)}
              disabled={busy}
            >
              返回
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => action(true)}
              disabled={busy || working}
            >
              确认安装
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || working || !data}
              onClick={() => action(false)}
            >
              <RefreshCw size={14} />
              {busy ? "正在检查…" : "检查 GitHub 更新"}
            </button>
            {data?.updateAvailable && (
              <button
                type="button"
                className="primary-button"
                disabled={busy || working || !data.configured}
                onClick={() => setConfirm(true)}
              >
                <ArrowDownToLine size={14} />
                安装更新
              </button>
            )}
          </>
        )}
      </div>
    </AccessibleDialog>
  );
}
