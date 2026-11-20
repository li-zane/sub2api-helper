import React, { useEffect, useRef, useState } from "react";
import { Activity, Check, CircleAlert, Database, Globe2, ListPlus, LoaderCircle, Plus, RefreshCw, RotateCcw, Settings2, SlidersHorizontal, Trash2, X } from "lucide-react";
import { DEFAULT_PLAN_TYPE_MAPPING, formatPlanTypeLabel } from "./plan-type-label.mjs";
import { DEFAULT_DISPLAY_TIME_ZONE, normalizeDisplayTimeZone } from "./display-time.mjs";
import { DEFAULT_POOL_PRICE_MULTIPLIER, normalizePoolPriceMultiplier } from "./account-pricing.mjs";
import { taskSettingsPatch } from "./task-settings-form.mjs";
import { MONITOR_FIELDS, DEFAULT_MONITORING, normalizeMonitoring } from "./monitor-settings.mjs";
import { IMPORT_FINGERPRINT_ACTION, normalizeTaskUploadActions, toggleTaskAutoAction } from "./task-auto-actions.mjs";
import { DEFAULT_LOGIN_TIMEOUT_MINUTES, normalizeLoginTimeoutMinutes, DEFAULT_SMS_TIMEOUT_MINUTES, normalizeSmsTimeoutMinutes } from "./login-settings.mjs";
import { trapModalTab } from "./accessible-dialog.jsx";
import { HelpTip } from "./help-tip.jsx";
import { CustomSelect } from "./custom-select.jsx";

const DEFAULT_TASK_AUTO_ACTION_OPTIONS = [
  { value: "authorize-codex", label: "Codex 授权" },
  { value: "upload", label: "上传到 Sub2API" },
  { value: "rotate-logout-reauthorize-upload", label: "一键轮换并上传" },
  { value: "enable-overload-detection", label: "自动开启过载检测" },
  { value: "enable-overload-cooldown", label: "自动开启过载冷却" },
  { value: IMPORT_FINGERPRINT_ACTION, label: "导入后检测一次降智" },
];
const TASK_SETTINGS_MONITOR_FIELDS = Object.freeze(
  MONITOR_FIELDS.filter(field => field.key !== "fingerprintScanIntervalSeconds")
);
const OVERLOAD_SETTINGS_FIELDS = TASK_SETTINGS_MONITOR_FIELDS.filter(field => field.group === "过载监控");
const WEB_SESSION_SETTINGS_FIELDS = TASK_SETTINGS_MONITOR_FIELDS.filter(field => field.group === "WebSession 定时巡检");
const TASK_SETTINGS_MONITOR_GROUPS = [...new Set(TASK_SETTINGS_MONITOR_FIELDS.filter(field => field.group !== "过载监控" && field.group !== "WebSession 定时巡检").map(field => field.group))];

export function TaskSettingsDialog({ settings, availablePlanTypes, planTypeMapping, returnFocusRef, onClose, onSave }) {
  const dialogRef = useRef(null);
  const initialSettings = useRef(settings);
  const [limit, setLimit] = useState(() => String(settings.maxActiveJobs));
  const [loginTimeout, setLoginTimeout] = useState(() => String(settings.loginTimeoutMinutes ?? DEFAULT_LOGIN_TIMEOUT_MINUTES));
  const [smsTimeout, setSmsTimeout] = useState(() => String(settings.smsTimeoutMinutes ?? DEFAULT_SMS_TIMEOUT_MINUTES));
  const [displayTimeZone, setTimeZone] = useState(settings.displayTimeZone || DEFAULT_DISPLAY_TIME_ZONE);
  const [priceMultiplier, setPriceMultiplier] = useState(String(settings.poolPriceMultiplier ?? DEFAULT_POOL_PRICE_MULTIPLIER));
  const [monitoring, setMonitoring] = useState(() => Object.fromEntries(TASK_SETTINGS_MONITOR_FIELDS.map(field => [field.key, String(settings.monitoring?.[field.key] ?? DEFAULT_MONITORING[field.key])])));
  const [overloadRule, setOverloadRule] = useState(() => ({ windowMinutes: String(settings.overloadAutoCooldown?.windowMinutes || 15), threshold: String(settings.overloadAutoCooldown?.threshold || 10), cooldownMinutes: String(settings.overloadAutoCooldown?.cooldownMinutes || 60) }));
  const [resetAfterCooldown, setResetAfterCooldown] = useState(settings.overloadAutoCooldown?.reauthorizeAfterCooldown === true);
  const [webMonitor, setWebMonitor] = useState(() => ({ enabled: settings.webSessionMonitor?.enabled === true, autoRelogin: settings.webSessionMonitor?.autoRelogin !== false, intervalMinutes: String(settings.webSessionMonitor?.intervalMinutes || 15), retryMinutes: String(settings.webSessionMonitor?.retryMinutes || 60) }));
  const [accountProxyMode, setAccountProxyMode] = useState(() => ["sub2api", "plan"].includes(settings.accountProxyMode) ? settings.accountProxyMode : "global");
  const [codexAuthMode, setCodexAuthMode] = useState(() => settings.codexAuthMode || "local");
  const [autoRows, setAutoRows] = useState(() => taskAutoActionRows(settings.autoActions));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const actionOptions = Array.isArray(settings.autoActionOptions) && settings.autoActionOptions.length
    ? settings.autoActionOptions
    : DEFAULT_TASK_AUTO_ACTION_OPTIONS;
  const planTypeSuggestions = [...new Set([
    ...Object.keys(DEFAULT_PLAN_TYPE_MAPPING),
    ...(Array.isArray(availablePlanTypes) ? availablePlanTypes : []),
    ...autoRows.map((row) => row.planType).filter(Boolean),
  ])].sort();

  useEffect(() => {
    const dialog = dialogRef.current;
    const initialFocus = dialog.querySelector('[data-dialog-initial-focus]:not(:disabled), .dialog-header .icon-button:not(:disabled)');
    initialFocus?.setAttribute("autofocus", "");
    dialog.showModal();
    return () => {
      dialog.close();
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  function resetDefaults() {
    setLimit(String(settings.default));
    setLoginTimeout(String(DEFAULT_LOGIN_TIMEOUT_MINUTES));
    setSmsTimeout(String(DEFAULT_SMS_TIMEOUT_MINUTES));
    setTimeZone(DEFAULT_DISPLAY_TIME_ZONE);
    setPriceMultiplier(String(DEFAULT_POOL_PRICE_MULTIPLIER));
    setOverloadRule({ windowMinutes: "15", threshold: "10", cooldownMinutes: "60" });
    setResetAfterCooldown(false);
    setWebMonitor({ enabled: false, autoRelogin: true, intervalMinutes: "15", retryMinutes: "60" });
    setMonitoring(Object.fromEntries(TASK_SETTINGS_MONITOR_FIELDS.map(field => [field.key, String(field.default)])));
    setAccountProxyMode("global");
    setCodexAuthMode("local");
    setError("");
  }

  function monitoringField(field) {
    return <label key={field.key} className="settings-field" htmlFor={`monitor-${field.key}`}>
      <span>{field.label}（{field.unit}）</span>
      <input id={`monitor-${field.key}`} type="number" min={field.min} max={field.max} step="1" required
        value={monitoring[field.key]} disabled={saving}
        onChange={event => setMonitoring(current => ({ ...current, [field.key]: event.target.value }))} />
    </label>;
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    let validTimeZone, poolPriceMultiplier;
    try { validTimeZone = normalizeDisplayTimeZone(displayTimeZone); poolPriceMultiplier = normalizePoolPriceMultiplier(priceMultiplier); } catch (error) { setError(error.message); return; }
    const value = Number(limit);
    if (!Number.isInteger(value) || value < settings.min || value > settings.max) {
      setError(`同时运行任务数必须是 ${settings.min} 到 ${settings.max} 的整数`);
      return;
    }
    let loginTimeoutMinutes, smsTimeoutMinutes;
    try { loginTimeoutMinutes = normalizeLoginTimeoutMinutes(Number(loginTimeout)); smsTimeoutMinutes = normalizeSmsTimeoutMinutes(Number(smsTimeout)); }
    catch (error) { setError(error.message); return; }
    const overloadAutoCooldown = Object.fromEntries(Object.entries(overloadRule).map(([key, value]) => [key, Number(value)]));
    if (resetAfterCooldown || Object.hasOwn(settings.overloadAutoCooldown || {}, "reauthorizeAfterCooldown"))
      overloadAutoCooldown.reauthorizeAfterCooldown = resetAfterCooldown;
    if (!Number.isInteger(overloadAutoCooldown.windowMinutes) || overloadAutoCooldown.windowMinutes < 1 || overloadAutoCooldown.windowMinutes > 1440
      || !Number.isInteger(overloadAutoCooldown.threshold) || overloadAutoCooldown.threshold < 1 || overloadAutoCooldown.threshold > 100000
      || !Number.isInteger(overloadAutoCooldown.cooldownMinutes) || overloadAutoCooldown.cooldownMinutes < 1 || overloadAutoCooldown.cooldownMinutes > 43200) {
      setError("自动冷却规则需填写有效整数：窗口 1–1440 分钟、阈值 1–100000 次、冷却 1–43200 分钟");
      return;
    }
    const configuredRows = autoRows
      .map((row) => ({ planType: String(row.planType || "").trim(), actions: [...new Set(row.actions || [])] }))
      .filter((row) => row.planType || row.actions.length);
    if (configuredRows.some((row) => !row.planType || !row.actions.length)) {
      setError("每个自动任务规则都需要填写 PlanType 并至少选择一个命令");
      return;
    }
    const seen = new Set();
    for (const row of configuredRows) {
      const key = row.planType.toLowerCase();
      if (seen.has(key)) {
        setError("PlanType 自动任务规则不能重复");
        return;
      }
      seen.add(key);
    }
    const autoActions = Object.fromEntries(configuredRows.map((row) => [row.planType, row.actions]));
    const webSessionMonitor = { ...webMonitor, intervalMinutes: Number(webMonitor.intervalMinutes), retryMinutes: Number(webMonitor.retryMinutes) };
    if (!Number.isInteger(webSessionMonitor.intervalMinutes) || webSessionMonitor.intervalMinutes < 1 || webSessionMonitor.intervalMinutes > 1440
      || !Number.isInteger(webSessionMonitor.retryMinutes) || webSessionMonitor.retryMinutes < 15 || webSessionMonitor.retryMinutes > 1440) {
      setError("WebSession 检测间隔需为 1–1440 分钟，重登重试间隔需为 15–1440 分钟");
      return;
    }
    let monitoringValues;
    try {
      if (Object.values(monitoring).some(value => !String(value).trim())) throw new Error("请填写全部自动监控参数");
      const normalized = normalizeMonitoring(
        Object.fromEntries(Object.entries(monitoring).map(([key, value]) => [key, Number(value)])),
        settings.monitoring || DEFAULT_MONITORING
      );
      const { fingerprintScanIntervalSeconds: _excluded, ...restMonitoring } = normalized;
      monitoringValues = restMonitoring;
    } catch (error) { setError(error.message); return; }
    setSaving(true);
    setError("");
    try {
      await onSave(taskSettingsPatch({ maxActiveJobs: value, loginTimeoutMinutes, smsTimeoutMinutes, displayTimeZone: validTimeZone, poolPriceMultiplier, autoActions, accountProxyMode, codexAuthMode, overloadAutoCooldown, webSessionMonitor, monitoring: monitoringValues }, initialSettings.current));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="batch-dialog task-settings-dialog"
      onKeyDown={trapModalTab}
      aria-labelledby="task-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || saving) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <form onSubmit={save} className="task-settings-form" noValidate>
        <div className="dialog-header">
          <div className="section-title-row">
            <Settings2 size={18} className="task-header-icon" aria-hidden="true" />
            <h2 id="task-settings-title">任务设置</h2>
            <HelpTip label="任务设置说明">
              任务设置保存到服务端，所有浏览器共用。服务重启后保留此设置。
            </HelpTip>
          </div>
          <button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} disabled={saving} aria-label="关闭任务设置"><X size={18} /></button>
        </div>
        <div className="task-settings-body">
        <section className="task-auto-settings task-basic-section" aria-labelledby="task-basic-title">
          <div className="section-title-row">
            <SlidersHorizontal size={15} className="task-section-icon" aria-hidden="true" />
            <h3 id="task-basic-title">基础并发与代理</h3>
          </div>
          <div className="task-two-fields">
            <label className="settings-field task-limit-field" htmlFor="task-limit">
              <span className="field-label-row">
                同时运行任务数
                <HelpTip label="同时运行任务数说明">
                  登录、OAuth 授权及 Web 会话检测共用此并发。可设置 {settings.min}–{settings.max} 条，默认 {settings.default} 条。超过上限的任务自动排队，并发越高服务器和代理负载越大。调高后立即启动排队任务；调低后等待当前任务完成再按新上限调度。
                </HelpTip>
              </span>
              <div>
                <input id="task-limit" type="number" min={settings.min} max={settings.max} step="1" required
                  value={limit} onChange={(event) => setLimit(event.target.value)} disabled={saving}
                  aria-invalid={Boolean(error)} />
                <span>条</span>
              </div>
            </label>
          </div>
          <div className="task-auth-mode-fields">
            <div className="task-display-pricing-row">
              <label className="settings-field" htmlFor="task-display-time-zone">
                <span className="field-label-row">显示时区<HelpTip label="显示时区说明">全局页面时间与日志时间使用此时区。原始时间戳保持 UTC，不改变检测间隔或任务调度。支持 IANA 时区，例如 Asia/Shanghai、UTC、America/New_York。</HelpTip></span>
                <input id="task-display-time-zone" aria-label="显示时区" list="display-time-zones" value={displayTimeZone} onChange={event => setTimeZone(event.target.value)} disabled={saving} required style={{ width: "min(320px, 60%)", minWidth: 0, textAlign: "left" }} />
                <datalist id="display-time-zones">{["Asia/Shanghai", "UTC", "Asia/Tokyo", "America/Los_Angeles", "America/New_York", "Europe/London"].map(zone => <option key={zone} value={zone} />)}</datalist>
              </label>
              <label className="settings-field" htmlFor="task-pool-price-multiplier">
                <span className="field-label-row">号池价格倍率<HelpTip label="号池价格倍率说明">自定义 1 美元号池用户收费折合多少人民币，仅用于利润展示，不是实时汇率；不会修改号池计费或额度。默认 1，支持最多 6 位小数。</HelpTip></span>
                <div className="pool-price-multiplier-input"><span>1$ =</span><input id="task-pool-price-multiplier" aria-label="号池价格倍率" type="number" required min="0.000001" max="1000000" step="0.000001"
                  value={priceMultiplier} onChange={event => setPriceMultiplier(event.target.value)} disabled={saving} /><span>元</span></div>
              </label>
            </div>
            <div className="task-two-fields">
              <label className="settings-field" htmlFor="task-login-timeout">
                <span className="field-label-row">登录超时
                  <HelpTip label="登录超时说明">Web、Codex 登录默认限时 3 分钟，包含邮箱和 2FA 等待、不含排队。进入手机号验证后改用独立接码时限，换号、重发和授权收尾都不重置或切回登录时限。超时保留原凭据；2FA 未通过时暂停自动登录，手动触发可恢复。</HelpTip>
                </span>
                <div><input id="task-login-timeout" type="number" min="1" max="1440" step="1" required value={loginTimeout} disabled={saving} onChange={event => setLoginTimeout(event.target.value)} /><span>分钟</span></div>
              </label>
              <label className="settings-field" htmlFor="task-sms-timeout">
                <span className="field-label-row">接码时限
                  <HelpTip label="接码时限说明">默认 10 分钟。从首次进入手机号验证开始，覆盖取号、等待短信、换号、验证码验证和后续授权收尾；仅切换一次，不因重发或换号重置，也不在验证码通过后切回登录时限。超时终止本次尝试并取消号码订单；未完成手机验证的账号暂停自动 OAuth，等待手动触发。</HelpTip>
                </span>
                <div><input id="task-sms-timeout" aria-label="接码时限（分钟）" type="number" min="1" max="1440" step="1" required value={smsTimeout} onChange={event => setSmsTimeout(event.target.value)} disabled={saving} /><span>分钟</span></div>
              </label>
            </div>
            <label className="settings-field task-auth-mode-field" htmlFor="task-proxy-mode">
              <span className="field-label-row">
                账号代理分配
                <HelpTip label="账号代理分配说明">
                  {accountProxyMode === "plan"
                    ? "仅首次网页登录使用全局动态代理；识别 PlanType 后按对应方案分配并绑定 IP。后续网页登录、Codex 授权、刷新与号池同步均复用该绑定，服务重启后保留。只有选择“均衡分配（toSub2）”的方案参与自动均衡。"
                    : accountProxyMode === "sub2api"
                    ? "导入任务开始时按出口 IP 负载分配并绑定，登录、授权和号池同步沿用同一代理。需先在代理 IP 配置中读取可用代理。"
                    : "所有任务使用代理 IP 配置中的全局代理；未配置时使用账号原代理或服务器出口。"}
                </HelpTip>
              </span>
              <CustomSelect
                id="task-proxy-mode"
                value={accountProxyMode}
                onChange={(event) => setAccountProxyMode(event.target.value)}
                disabled={saving}
                aria-label="账号代理分配"
                options={[
                  { value: "global", label: "全局代理" },
                  { value: "sub2api", label: "Sub2API 均衡分配（登录前绑定）" },
                  { value: "plan", label: "动态登录 + 按 PlanType 授权" },
                ]}
              />
            </label>
            <label className="settings-field task-auth-mode-field" htmlFor="task-codex-auth-mode">
              <span className="field-label-row">
                Codex 授权方式
                <HelpTip label="Codex 授权方式说明">
                  {codexAuthMode === "sub2api"
                    ? "使用已保存的 Sub2API 后端和管理员 Key，由号池生成授权链接、兑换和刷新令牌；toSub2 完成登录并保存凭据。需要先配置 Sub2API。"
                    : codexAuthMode === "cli"
                    ? "每次授权新建独立的官方 Codex CLI 临时环境，当前账号的 Web 会话完成授权；凭据导出后销毁环境，并将网关 OpenAI Codex UA 同步为 CLI 实际值。需要先配置 Sub2API 并准备 CLI 镜像。"
                    : "由 toSub2 生成授权链接并直接兑换、刷新令牌，沿用当前授权流程。"}
                </HelpTip>
              </span>
              <CustomSelect
                id="task-codex-auth-mode"
                value={codexAuthMode}
                onChange={(event) => setCodexAuthMode(event.target.value)}
                disabled={saving}
                aria-label="Codex 授权方式"
                options={[
                  { value: "local", label: "本地授权（toSub2 生成链接和凭据）" },
                  { value: "sub2api", label: "Sub2API 授权（号池生成链接和凭据）" },
                  { value: "cli", label: "Codex CLI OAuth（账号独立环境）" },
                ]}
              />
            </label>
            {codexAuthMode === "cli" && <p className="cli-auth-note">每次授权使用独立临时环境，凭据导出后清理；自动同步网关全局 OpenAI Codex UA。</p>}
          </div>
        </section>
        <section className="task-auto-settings" aria-labelledby="web-session-monitor-title">
          <div className="section-title-row">
            <Globe2 size={15} className="task-section-icon" aria-hidden="true" />
            <h3 id="web-session-monitor-title">WebSession 定时巡检</h3>
            <HelpTip label="WebSession 定时巡检说明">由服务端执行，关闭页面后仍运行。使用原设备身份和账号代理检查会话、设备与空间；确认会话失效或空间/PlanType 变化后，通过共享登录队列重新登录授权，并应用新方案、同步号池。网络、403 或上游故障只记录失败，不当作掉线。会话检测成功后按当前套餐核对过载检测、过载冷却及继承套餐规则的降智检测。已有 Web 登录态会定期测活；本地已授权或曾成功登录 Web 的账号缺失会话时可自动补登。主动登出或取消任务会暂停维护，手动检测或登录可恢复。</HelpTip>
          </div>
          <div className="task-checkbox-group">
            <label className="task-auto-action-option"><input type="checkbox" checked={webMonitor.enabled} disabled={saving} onChange={e => setWebMonitor(v => ({ ...v, enabled: e.target.checked }))} /><span>启用 WebSession 定时检测</span></label>
            <label className="task-auto-action-option"><input type="checkbox" checked={webMonitor.autoRelogin} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, autoRelogin: e.target.checked }))} /><span>确认失效或空间变化后自动重登并授权</span></label>
          </div>
          <div className="task-two-fields">
            <label className="settings-field" htmlFor="web-session-check-interval"><span>检测间隔（分钟）</span><input id="web-session-check-interval" type="number" min="1" max="1440" value={webMonitor.intervalMinutes} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, intervalMinutes: e.target.value }))} /></label>
            <label className="settings-field" htmlFor="web-session-retry-interval"><span>重登重试间隔（分钟）</span><input id="web-session-retry-interval" type="number" min="15" max="1440" value={webMonitor.retryMinutes} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, retryMinutes: e.target.value }))} /></label>
            {WEB_SESSION_SETTINGS_FIELDS.map(monitoringField)}
          </div>
          <div className="task-auto-empty">默认关闭；默认每 15 分钟检测，60 分钟内最多自动重登一次。需要验证码时保留在现有任务队列中等待处理。</div>
          <div className="task-auto-empty">到期任务扫描默认每 30 秒在本地检查哪些账号已到检测时间；实际会话检测按上方检测间隔执行，并共用任务并发。</div>
        </section>
        {TASK_SETTINGS_MONITOR_GROUPS.map(group => (
          <section className="task-auto-settings" key={group} aria-label={group}>
            <div className="section-title-row">
              {group === "号池与用量同步" ? <Database size={15} className="task-section-icon" aria-hidden="true" />
                : group === "号池异常恢复" ? <RefreshCw size={15} className="task-section-icon" aria-hidden="true" />
                : <RotateCcw size={15} className="task-section-icon" aria-hidden="true" />}
              <h3>{group}</h3>
            </div>
            <div className="task-two-fields">
              {TASK_SETTINGS_MONITOR_FIELDS.filter(field => field.group === group).map(monitoringField)}
            </div>
            <div className="task-auto-empty">{group === "号池异常恢复" ? "跟随号池状态刷新，发现可恢复错误立即加入共享授权队列，不另设巡检；重试间隔仅用于失败后的再次尝试，设为 0 时不设失败冷却。"
              : "仅请求号池，默认网络并发 100。调用与过载默认每 60 秒统一统计；曲线每格跟随下方的过载统计窗口，默认 15 分钟一格，展示 6 格。当前格和图表累计共用采集，任一达到各自阈值就冷却；历史格缓存复用，冷却到期独立恢复。关闭页面后继续同步。"}</div>
          </section>
        ))}
        <section className="task-auto-settings task-overload-settings" aria-labelledby="task-overload-title">
          <div className="section-title-row">
            <Activity size={15} className="task-section-icon" aria-hidden="true" />
            <h3 id="task-overload-title">过载</h3>
            <HelpTip label="过载设置说明">冷却读取号池已有请求日志，不主动发起模型测试。统计频率在“号池与用量同步”中统一设置，每次统计后判断当前固定格或图表累计是否达到各自阈值，任一达到就冷却。账号的“过载”和“冷却”开关分别开启。</HelpTip>
          </div>
          <div className="task-overload-cooldown">
          <div className="section-title-row">
            <h4 id="overload-auto-cooldown-title">自动冷却</h4>
            <HelpTip label="过载自动冷却说明">
              当前固定格达到阈值，或图表累计（默认 90 分钟）达到阈值的 3 倍，任一满足就暂停号池分配，与两侧能量条一致。复用同一次采集；累计数据不完整时只判断当前格。每个账号独立保存冷却截止时间，到期自动恢复，重启后继续计时。“冷却”可单独开启；恢复当格跳过旧次数，下一固定格重新判断两项阈值，累计仍超限时会再次冷却。
            </HelpTip>
          </div>
          <div className="overload-rule-fields">
            {[{ key: "windowMinutes", label: "过载统计窗口", unit: "分钟", max: 1440 }, { key: "threshold", label: "过载触发阈值", unit: "次", max: 100000 }, { key: "cooldownMinutes", label: "自动冷却时长", unit: "分钟", max: 43200 }].map(field => <label key={field.key} className="settings-field" htmlFor={`overload-rule-${field.key}`}>
              <span>{field.label}</span><div><input id={`overload-rule-${field.key}`} type="number" min={1} max={field.max} step="1" value={overloadRule[field.key]} disabled={saving} onChange={event => setOverloadRule(current => ({ ...current, [field.key]: event.target.value }))} /><span>{field.unit}</span></div>
            </label>)}
          </div>
          <div className="task-auto-empty">当前 {overloadRule.windowMinutes || "—"} 分钟固定格达到 {overloadRule.threshold || "—"} 次，或图表累计达到 {overloadRule.threshold ? Number(overloadRule.threshold) * 3 : "—"} 次，冷却 {overloadRule.cooldownMinutes || "—"} 分钟；到期及时恢复。</div>
          <label className="task-auto-action-option"><input type="checkbox" checked={resetAfterCooldown} disabled={saving}
            onChange={event => setResetAfterCooldown(event.target.checked)} /><span>冷却前登出所有设备，结束后重登授权</span></label>
          <div className="task-auto-empty">默认关闭。开启后，触发冷却时先暂停调度并登出所有设备，确认登出后开始冷却；到期重新登录 Web、完成 Codex 授权并更新原号池凭据，成功后恢复调度，失败保持暂停。整个流程沿用原绑定 IP，不轮换密码或 2FA。</div>
          </div>
          <details className="task-overload-advanced">
            <summary>冷却操作并发</summary>
            <div className="task-two-fields">{OVERLOAD_SETTINGS_FIELDS.filter(field => field.key.endsWith("Concurrency")).map(monitoringField)}</div>
            <div className="task-auto-empty">仅控制暂停、到期恢复及失败重试的网络并发，默认 100；不再单独查询过载日志。</div>
          </details>
        </section>
        <section className="task-auto-settings" aria-labelledby="task-auto-settings-title">
          <div className="task-auto-settings-heading">
            <div className="section-title-row">
              <ListPlus size={15} className="task-section-icon" aria-hidden="true" />
              <h3 id="task-auto-settings-title">批量导入后的自动任务</h3>
              <HelpTip label="自动任务说明">
                按首次 Web 登录识别到的原始 PlanType 执行命令。没有规则的 PlanType 不会自动执行其它操作。
              </HelpTip>
            </div>
            <button type="button" className="secondary-button" onClick={() => setAutoRows((current) => [...current, { planType: "", actions: [] }])} disabled={saving}>
              <Plus size={15} />添加规则
            </button>
          </div>
          {autoRows.length === 0 && <div className="task-auto-empty">暂未配置自动任务</div>}
          <div className="task-auto-rule-list">
            {autoRows.map((row, index) => (
              <div className="task-auto-rule" key={index}>
                <div className="settings-field task-auto-plan-field">
                  <span><label htmlFor={`task-auto-plan-${index}`}>PlanType</label></span>
                  <CustomSelect editable id={`task-auto-plan-${index}`} value={row.planType} placeholder="选择或输入 PlanType" width="100%"
                    aria-label={`第 ${index + 1} 条自动任务的 PlanType`}
                    options={planTypeSuggestions.map(planType => ({ value: planType, label: planType,
                      description: formatPlanTypeLabel(planType, planTypeMapping) !== planType ? formatPlanTypeLabel(planType, planTypeMapping) : undefined }))}
                    onChange={(event) => setAutoRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, planType: event.target.value } : item))}
                    disabled={saving} />
                  {row.planType && <small>{formatPlanTypeLabel(row.planType, planTypeMapping)}</small>}
                </div>
                <div className="task-auto-action-group">
                  <div className="task-auto-action-options" aria-label={`${row.planType || "PlanType"} 自动命令`}>
                    {actionOptions.map((option) => (
                      <label key={option.value} className="task-auto-action-option">
                        <input type="checkbox" checked={row.actions.includes(option.value)} disabled={saving || (option.value === "authorize-codex" && row.actions.includes("rotate-logout-reauthorize-upload"))}
                          onChange={(event) => setAutoRows((current) => current.map((item, itemIndex) => {
                            if (itemIndex !== index) return item;
                            return { ...item, actions: toggleTaskAutoAction(item.actions, option.value, event.target.checked) };
                          }))} />
                        <span>{option.value === "enable-overload-detection" ? "自动开启过载统计" : option.label}</span>
                      </label>
                    ))}
                  </div>
                  <small className="task-auto-empty">新账号先登录 Web；一键轮换依次完成 2FA、登出设备、重登 Web、授权与上传，无需额外勾选 Codex 授权。</small>
                  {row.actions.includes(IMPORT_FINGERPRINT_ACTION) && <small className="task-auto-empty">一次性检测需要号池中已启用的账号和已配置的检测模型。</small>}
                </div>
                <button type="button" className="icon-button danger" title="删除自动任务规则" aria-label="删除自动任务规则" onClick={() => setAutoRows((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={saving}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
        </div>
        {error && <div className="dialog-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <div className="dialog-footer">
          <button type="button" className="selection-text-button" onClick={resetDefaults} disabled={saving} title="恢复基础与监控参数，保留已配置的 PlanType 自动任务">恢复默认</button>
          <span className="dialog-actions-spacer" />
          <button type="button" className="cancel-button" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存设置
          </button>
        </div>
      </form>
    </dialog>
  );
}

function taskAutoActionRows(autoActions) {
  if (!autoActions || typeof autoActions !== "object" || Array.isArray(autoActions)) return [];
  return Object.entries(autoActions).map(([planType, actions]) => ({
    planType,
    actions: Array.isArray(actions) ? normalizeTaskUploadActions([...new Set(actions)]) : [],
  }));
}
