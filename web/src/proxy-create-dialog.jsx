import React, { useState, useRef, useMemo, useId } from "react";
import { AccessibleDialog } from "./accessible-dialog.jsx";
import { CustomSelect } from "./custom-select.jsx";
import { parseProxyLines, normalizeProxyInput } from "./proxy-input.mjs";
import {
  X,
  Plus,
  RotateCcw,
  Check,
  AlertCircle,
  Clock,
  Info,
  LoaderCircle,
  Calendar,
  Globe2,
  FileText,
  ShieldCheck,
  Edit3
} from "lucide-react";
import "./proxy-create-dialog.css";

const PROTOCOL_OPTIONS = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
  { value: "socks5h", label: "SOCKS5H" },
];

function generateUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getFutureDateStr(days) {
  const d = new Date(Date.now() + days * 86400 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateStrToUnix(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  const target = new Date(y, m - 1, d, 23, 59, 59);
  const unix = Math.floor(target.getTime() / 1000);
  return Number.isSafeInteger(unix) ? unix : null;
}

function ExpirationControl({ value, onChange, disabled }) {
  const daysOptions = [7, 30, 90, 180];
  const todayStr = useMemo(() => getFutureDateStr(0), []);

  return (
    <div className="proxy-expire-group">
      <div className="proxy-expire-header">
        <span className="proxy-field-title">到期时间（可选）</span>
        <span className={`proxy-expire-hint ${value ? "has-value" : ""}`}>
          {value ? `有效至 ${value} 23:59:59` : "留空则永久有效"}
        </span>
      </div>
      <div className="proxy-expire-controls">
        <div className="proxy-pill-group" role="group" aria-label="快捷选择到期时间">
          {daysOptions.map((days) => {
            const targetDate = getFutureDateStr(days);
            const isSelected = value === targetDate;
            return (
              <button
                key={days}
                type="button"
                className={`proxy-pill-btn ${isSelected ? "is-active" : ""}`}
                disabled={disabled}
                onClick={() => onChange(targetDate)}
              >
                {days}天
              </button>
            );
          })}
          {value && (
            <button
              type="button"
              className="proxy-pill-btn is-clear"
              disabled={disabled}
              onClick={() => onChange("")}
              title="清除有效期"
            >
              清除
            </button>
          )}
        </div>
        <div className="proxy-date-wrapper">
          <input
            type="date"
            className="proxy-date-input"
            value={value}
            min={todayStr}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-label="选择到期日期"
          />
        </div>
      </div>
    </div>
  );
}

export function ProxyCreateDialog({ request, onClose, onCreated }) {
  const [tab, setTab] = useState("manual"); // "manual" | "import"
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const [error, setError] = useState("");
  const [submitResult, setSubmitResult] = useState(null);

  // Manual mode state
  const [manualName, setManualName] = useState("");
  const [manualProtocol, setManualProtocol] = useState("http");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState("");
  const [manualUsername, setManualUsername] = useState("");
  const [manualPassword, setManualPassword] = useState("");
  const [manualExpiresDate, setManualExpiresDate] = useState("");

  // Quick import mode state
  const [importText, setImportText] = useState("");
  const [defaultProtocol, setDefaultProtocol] = useState("http");
  const [namePrefix, setNamePrefix] = useState("");
  const [importExpiresDate, setImportExpiresDate] = useState("");
  const [customNames, setCustomNames] = useState({});

  // Idempotency: reuse requestId if draft is unchanged, new ID if draft changed
  const currentRequestIdRef = useRef(null);
  const lastSubmittedPayloadRef = useRef(null);

  function getRequestIdForPayload(proxies) {
    const serialized = JSON.stringify(proxies);
    if (!currentRequestIdRef.current || lastSubmittedPayloadRef.current !== serialized) {
      currentRequestIdRef.current = generateUUID();
      lastSubmittedPayloadRef.current = serialized;
    }
    return currentRequestIdRef.current;
  }

  // Parse lines for Quick Import in real-time
  const parsedLines = useMemo(() => {
    if (!importText.trim()) return [];
    const expiresAt = dateStrToUnix(importExpiresDate);
    return parseProxyLines(importText, {
      protocol: defaultProtocol,
      namePrefix: namePrefix.trim(),
      expiresAt,
    });
  }, [importText, defaultProtocol, namePrefix, importExpiresDate]);

  const rawNonEmptyLineCount = useMemo(() => {
    return importText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean).length;
  }, [importText]);

  const validParsedCount = useMemo(() => {
    return parsedLines.filter((row) => !row.error && row.proxy).length;
  }, [parsedLines]);

  const errorParsedCount = useMemo(() => {
    return parsedLines.filter((row) => Boolean(row.error)).length;
  }, [parsedLines]);

  const handleTabChange = (nextTab) => {
    if (busy) return;
    setError("");
    setTab(nextTab);
  };

  const handleTabKeyDown = (e) => {
    if (busy) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const nextTab = tab === "manual" ? "import" : "manual";
      setTab(nextTab);
      document.getElementById(`proxy-tab-${nextTab}`)?.focus();
    }
  };

  const handleCustomNameChange = (line, value) => {
    if (busy) return;
    setCustomNames((prev) => ({
      ...prev,
      [line]: value,
    }));
  };

  const handleResetDraft = () => {
    if (busy) return;
    setSubmitResult(null);
    setError("");
    if (tab === "manual") {
      setManualName("");
      setManualHost("");
      setManualPort("");
      setManualUsername("");
      setManualPassword("");
      setManualExpiresDate("");
    } else {
      setImportText("");
      setNamePrefix("");
      setCustomNames({});
      setImportExpiresDate("");
    }
    currentRequestIdRef.current = null;
    lastSubmittedPayloadRef.current = null;
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (busyRef.current) return;
    setError("");

    let normalizedProxies = [];

    if (tab === "manual") {
      const expiresAt = dateStrToUnix(manualExpiresDate);
      const candidate = {
        name: manualName.trim(),
        protocol: manualProtocol,
        host: manualHost.trim(),
        port: manualPort.trim(),
        username: manualUsername.trim(),
        password: manualPassword.trim(),
        expires_at: expiresAt,
      };

      try {
        const validated = normalizeProxyInput(candidate);
        normalizedProxies = [validated];
      } catch (err) {
        setError(err.message || "请输入有效的代理配置");
        return;
      }
    } else {
      // Quick Import mode
      if (!importText.trim()) {
        setError("请先在文本框中输入代理信息");
        return;
      }

      if (rawNonEmptyLineCount > 100) {
        setError("单次最多导入 100 条代理，当前已有 " + rawNonEmptyLineCount + " 行");
        return;
      }

      if (parsedLines.length === 0) {
        setError("未识别到有效的代理数据");
        return;
      }

      const errors = [];
      const validatedList = [];

      for (const item of parsedLines) {
        if (item.error) {
          errors.push(`第 ${item.line} 行：${item.error}`);
          continue;
        }

        const candidateName = (customNames[item.line] ?? item.proxy.name).trim();
        try {
          const validated = normalizeProxyInput({
            ...item.proxy,
            name: candidateName,
          });
          validatedList.push(validated);
        } catch (err) {
          errors.push(`第 ${item.line} 行：${err.message}`);
        }
      }

      if (errors.length > 0) {
        setError(`存在格式错误的代理，请修正后再提交（共 ${errors.length} 处，例如：${errors[0]}）`);
        return;
      }

      normalizedProxies = validatedList;
    }

    const requestId = getRequestIdForPayload(normalizedProxies);

    busyRef.current = true;
    setBusy(true);

    try {
      const response = await request("/api/sub2api/proxies", {
        method: "POST",
        body: JSON.stringify({
          proxies: normalizedProxies,
          requestId,
        }),
      });

      setSubmitResult(response);

      // Trigger list refresh if any proxy was created or found existing
      if (response.created > 0 || response.existing > 0) {
        onCreated?.();
      }
    } catch (err) {
      if (err.message?.includes("新的提交标识") || err.message?.includes("已变更")) {
        currentRequestIdRef.current = generateUUID();
      }
      setError(err.message || "添加代理失败，请检查网络或后端配置");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const hasResults = Boolean(submitResult);
  const allSucceeded =
    hasResults &&
    (submitResult.failed ?? 0) === 0 &&
    (submitResult.unknown ?? 0) === 0;

  return (
    <AccessibleDialog
      className="batch-dialog proxy-create-dialog"
      labelledBy="proxy-create-title"
      closeDisabled={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="dialog-header">
        <div className="proxy-create-heading-group">
          <div className="proxy-create-title-row">
            <Globe2 size={18} className="proxy-title-icon" aria-hidden="true" />
            <h2 id="proxy-create-title">添加代理</h2>
          </div>
          <span className="proxy-create-subtitle">向 Sub2API 号池添加代理 IP 节点</span>
        </div>
        <div className="dialog-header-actions">
          <button
            type="button"
            className="icon-button"
            autoFocus
            data-dialog-initial-focus
            onClick={() => {
              if (!busy) onClose();
            }}
            disabled={busy}
            title="关闭"
            aria-label="关闭添加代理"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="proxy-create-body">
        {/* Tab switchers */}
        <div className="proxy-tabs-bar" role="tablist" aria-label="添加模式">
          <button
            type="button"
            role="tab"
            id="proxy-tab-manual"
            aria-selected={tab === "manual"}
            aria-controls="proxy-panel-manual"
            tabIndex={tab === "manual" ? 0 : -1}
            disabled={busy}
            className={`proxy-tab-button ${tab === "manual" ? "is-active" : ""}`}
            onClick={() => handleTabChange("manual")}
            onKeyDown={handleTabKeyDown}
          >
            手动添加
          </button>
          <button
            type="button"
            role="tab"
            id="proxy-tab-import"
            aria-selected={tab === "import"}
            aria-controls="proxy-panel-import"
            tabIndex={tab === "import" ? 0 : -1}
            disabled={busy}
            className={`proxy-tab-button ${tab === "import" ? "is-active" : ""}`}
            onClick={() => handleTabChange("import")}
            onKeyDown={handleTabKeyDown}
          >
            快捷导入
          </button>
        </div>

        {/* Global error banner */}
        {error && (
          <div className="proxy-error-banner" role="alert">
            <AlertCircle size={15} className="proxy-error-icon" />
            <span className="proxy-error-text">{error}</span>
          </div>
        )}

        {/* Results View when submitResult is present */}
        {hasResults && (
          <div className="proxy-results-container" aria-label="添加结果">
            <div className="proxy-results-summary-card">
              <div className="proxy-summary-badges">
                {submitResult.created > 0 && (
                  <span className="proxy-stat-badge stat-created">
                    <Check size={13} /> 成功添加 {submitResult.created}
                  </span>
                )}
                {submitResult.existing > 0 && (
                  <span className="proxy-stat-badge stat-existing">
                    <Info size={13} /> 已存在跳过 {submitResult.existing}
                  </span>
                )}
                {submitResult.failed > 0 && (
                  <span className="proxy-stat-badge stat-failed">
                    <AlertCircle size={13} /> 失败 {submitResult.failed}
                  </span>
                )}
                {submitResult.unknown > 0 && (
                  <span className="proxy-stat-badge stat-unknown">
                    <Clock size={13} /> 结果待确认 {submitResult.unknown}
                  </span>
                )}
              </div>
            </div>

            {submitResult.unknown > 0 && (
              <div className="proxy-unknown-notice" role="status">
                <AlertCircle size={15} />
                <span>
                  有 {submitResult.unknown} 条代理创建结果待确认（可能在服务端已添加但网络超时）。请先读取或刷新号池代理列表确认，系统未自动重试，避免重复创建。
                </span>
              </div>
            )}

            <div className="proxy-results-list" role="list" aria-label="逐行添加结果">
              {submitResult.results.map((item, idx) => {
                const isCreated = item.status === "created";
                const isExisting = item.status === "existing";
                const isFailed = item.status === "failed";
                const isUnknown = item.status === "unknown";

                return (
                  <div
                    key={idx}
                    className={`proxy-result-row status-${item.status}`}
                    role="listitem"
                  >
                    <div className="proxy-result-status-icon">
                      {isCreated && <Check size={14} className="icon-created" />}
                      {isExisting && <Info size={14} className="icon-existing" />}
                      {isFailed && <AlertCircle size={14} className="icon-failed" />}
                      {isUnknown && <Clock size={14} className="icon-unknown" />}
                    </div>
                    <div className="proxy-result-details">
                      <div className="proxy-result-primary">
                        <strong className="proxy-result-title">
                          {item.proxy?.name || `代理 #${idx + 1}`}
                        </strong>
                        {item.proxy && (
                          <span className="proxy-result-meta">
                            {item.proxy.protocol?.toUpperCase()} · {item.proxy.host}:{item.proxy.port}
                          </span>
                        )}
                      </div>
                      <div className="proxy-result-message">{item.message}</div>
                    </div>
                    <div className="proxy-result-tag-col">
                      <span className={`proxy-result-tag tag-${item.status}`}>
                        {isCreated ? "已添加" : isExisting ? "已存在" : isFailed ? "失败" : "待确认"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Form View (when not viewing exclusively completed results or user wants to edit) */}
        {!hasResults && (
          <>
            {/* MANUAL MODE PANEL */}
            {tab === "manual" && (
              <div
                id="proxy-panel-manual"
                role="tabpanel"
                aria-labelledby="proxy-tab-manual"
                className="proxy-tab-content"
              >
                <div className="proxy-form-grid">
                  <div className="proxy-form-row">
                    <label className="proxy-input-group">
                      <span className="proxy-field-title">代理名称 *</span>
                      <input
                        type="text"
                        className="proxy-text-input"
                        placeholder="如：香港节点-01"
                        value={manualName}
                        disabled={busy}
                        onChange={(e) => setManualName(e.target.value)}
                        maxLength={100}
                        required
                      />
                    </label>

                    <div className="proxy-input-group">
                      <span className="proxy-field-title">协议 *</span>
                      <CustomSelect
                        value={manualProtocol}
                        options={PROTOCOL_OPTIONS}
                        disabled={busy}
                        aria-label="选择协议"
                        onChange={(e) => setManualProtocol(e?.target?.value ?? e)}
                      />
                    </div>
                  </div>

                  <div className="proxy-form-row host-port-row">
                    <label className="proxy-input-group host-input-group">
                      <span className="proxy-field-title">主机地址 / IP *</span>
                      <input
                        type="text"
                        className="proxy-text-input"
                        placeholder="如：1.2.3.4 或 proxy.example.com"
                        value={manualHost}
                        disabled={busy}
                        onChange={(e) => setManualHost(e.target.value)}
                        required
                      />
                    </label>

                    <label className="proxy-input-group port-input-group">
                      <span className="proxy-field-title">端口 *</span>
                      <input
                        type="number"
                        className="proxy-text-input"
                        placeholder="1–65535"
                        min="1"
                        max="65535"
                        value={manualPort}
                        disabled={busy}
                        onChange={(e) => setManualPort(e.target.value)}
                        required
                      />
                    </label>
                  </div>

                  <div className="proxy-form-row">
                    <label className="proxy-input-group">
                      <span className="proxy-field-title">用户名（可选）</span>
                      <input
                        type="text"
                        className="proxy-text-input"
                        placeholder="无认证请留空"
                        value={manualUsername}
                        disabled={busy}
                        onChange={(e) => setManualUsername(e.target.value)}
                        autoComplete="off"
                      />
                    </label>

                    <label className="proxy-input-group">
                      <span className="proxy-field-title">密码（可选）</span>
                      <input
                        type="password"
                        className="proxy-text-input"
                        placeholder="无认证请留空"
                        value={manualPassword}
                        disabled={busy}
                        onChange={(e) => setManualPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    </label>
                  </div>

                  <ExpirationControl
                    value={manualExpiresDate}
                    onChange={setManualExpiresDate}
                    disabled={busy}
                  />
                </div>
              </div>
            )}

            {/* QUICK IMPORT PANEL */}
            {tab === "import" && (
              <div
                id="proxy-panel-import"
                role="tabpanel"
                aria-labelledby="proxy-tab-import"
                className="proxy-tab-content"
              >
                {/* Format hints */}
                <div className="proxy-format-hints">
                  <div className="proxy-format-hints-title">支持格式（每行一条）：</div>
                  <div className="proxy-format-chips">
                    <span className="proxy-format-chip">
                      <code>hostname:port:user:pass</code>
                    </span>
                    <span className="proxy-format-chip">
                      <code>protocol://user:pass@host:port</code>
                    </span>
                    <span className="proxy-format-chip">
                      <code>user:pass@hostname:port</code>
                    </span>
                    <span className="proxy-format-chip">
                      <code>hostname:port@user:pass</code>
                    </span>
                    <span className="proxy-format-note">亦支持 host:port（无认证）</span>
                  </div>
                </div>

                {/* Multiline textarea */}
                <div className="proxy-textarea-group">
                  <div className="proxy-textarea-header">
                    <span className="proxy-field-title">代理列表文本</span>
                    <span
                      className={`proxy-lines-counter ${rawNonEmptyLineCount > 100 ? "is-overflow" : ""}`}
                    >
                      {rawNonEmptyLineCount} / 100 条
                    </span>
                  </div>
                  <textarea
                    className="proxy-import-textarea"
                    rows={5}
                    value={importText}
                    disabled={busy}
                    placeholder={`在此粘贴代理配置，每行一条，例如：\n1.2.3.4:8080:username:password\nsocks5://user:pass@example.com:1080\nuser:pass@1.2.3.4:8080\nexample.com:8080@user:pass\n1.2.3.4:8080`}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                </div>

                {/* Batch options row */}
                <div className="proxy-batch-options-row">
                  <div className="proxy-input-group default-protocol-group">
                    <span className="proxy-field-title">默认协议</span>
                    <CustomSelect
                      value={defaultProtocol}
                      options={PROTOCOL_OPTIONS}
                      disabled={busy}
                      aria-label="默认协议"
                      onChange={(e) => setDefaultProtocol(e?.target?.value ?? e)}
                    />
                  </div>

                  <label className="proxy-input-group name-prefix-group">
                    <span className="proxy-field-title">名称前缀（可选）</span>
                    <input
                      type="text"
                      className="proxy-text-input"
                      placeholder="如：hk-node（自动生成 hk-node-1, hk-node-2）"
                      value={namePrefix}
                      disabled={busy}
                      onChange={(e) => setNamePrefix(e.target.value)}
                    />
                  </label>
                </div>

                <ExpirationControl
                  value={importExpiresDate}
                  onChange={setImportExpiresDate}
                  disabled={busy}
                />

                {/* Preview and row-level naming */}
                <div className="proxy-preview-section">
                  <div className="proxy-preview-header">
                    <span className="proxy-field-title">解析预览与逐行命名</span>
                    <div className="proxy-preview-stats">
                      {validParsedCount > 0 && (
                        <span className="proxy-preview-stat-item valid">
                          有效 {validParsedCount} 条
                        </span>
                      )}
                      {errorParsedCount > 0 && (
                        <span className="proxy-preview-stat-item error">
                          错误 {errorParsedCount} 行
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="proxy-preview-body">
                    {parsedLines.length === 0 ? (
                      <div className="proxy-preview-empty">
                        在上方文本框中输入代理后实时解析预览，可在此直接修改各行名称。
                      </div>
                    ) : (
                      <div className="proxy-preview-list">
                        {parsedLines.map((row) => {
                          if (row.error) {
                            return (
                              <div
                                key={row.line}
                                className="proxy-preview-row is-error"
                              >
                                <span className="proxy-preview-line-badge is-error">
                                  第 {row.line} 行
                                </span>
                                <span className="proxy-preview-error-desc">
                                  <AlertCircle size={13} /> {row.error}
                                </span>
                              </div>
                            );
                          }

                          const currentName =
                            customNames[row.line] !== undefined
                              ? customNames[row.line]
                              : row.proxy.name;

                          return (
                            <div key={row.line} className="proxy-preview-row">
                              <span className="proxy-preview-line-badge">
                                #{row.line}
                              </span>
                              <span className="proxy-preview-proto">
                                {row.proxy.protocol?.toUpperCase()}
                              </span>
                              <span className="proxy-preview-endpoint">
                                {row.proxy.host}:{row.proxy.port}
                              </span>
                              <span className="proxy-preview-auth">
                                {row.proxy.username ? (
                                  <span className="auth-user" title={`认证用户: ${row.proxy.username}`}>
                                    {row.proxy.username}
                                  </span>
                                ) : (
                                  <span className="auth-none">无认证</span>
                                )}
                              </span>
                              <div className="proxy-preview-name-box">
                                <Edit3 size={12} className="proxy-name-edit-icon" />
                                <input
                                  type="text"
                                  className="proxy-row-name-input"
                                  value={currentName}
                                  disabled={busy}
                                  placeholder="自定义名称"
                                  onChange={(e) =>
                                    handleCustomNameChange(row.line, e.target.value)
                                  }
                                  aria-label={`第 ${row.line} 行代理名称`}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Dialog Footer Actions */}
      <div className="dialog-footer proxy-dialog-footer">
        {hasResults ? (
          <div className="proxy-footer-results-actions">
            <button
              type="button"
              className="cancel-button"
              disabled={busy}
              onClick={() => {
                if (!busy) onClose();
              }}
            >
              关闭
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setSubmitResult(null)}
            >
              返回修改草稿
            </button>
            {!allSucceeded ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={handleSubmit}
              >
                {busy ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
                <span>{busy ? "正在提交..." : "重试提交"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={handleResetDraft}
              >
                继续添加
              </button>
            )}
          </div>
        ) : (
          <div className="proxy-footer-form-actions">
            <button
              type="button"
              className="cancel-button"
              disabled={busy}
              onClick={() => {
                if (!busy) onClose();
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                (tab === "import" && (validParsedCount === 0 || errorParsedCount > 0))
              }
              onClick={handleSubmit}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Plus size={14} />
              )}
              <span>
                {busy
                  ? "正在添加..."
                  : tab === "manual"
                  ? "添加代理"
                  : `导入代理 (${validParsedCount})`}
              </span>
            </button>
          </div>
        )}
      </div>
    </AccessibleDialog>
  );
}
