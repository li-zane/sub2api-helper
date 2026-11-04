import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readJsonResponse, workspaceFailureTooltip } from "./response-errors.js";
import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  ArrowRight,
  Copy,
  Download,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Filter,
  BriefcaseBusiness,
  Globe2,
  KeyRound,
  ListPlus,
  LoaderCircle,
  Lock,
  LogIn,
  Mail,
  MailCheck,
  LogOut,
  MonitorSmartphone,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings2,
  Shuffle,
  ShieldCheck,
  Smartphone,
  Tags,
  PhoneIncoming,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import { logoutAccountSessions, proxySwitchSelectionState } from "./account-session-actions.mjs";
import { OverloadDetection } from "./overload-detection.jsx";
import { ProxyQualityPanel } from "./proxy-quality.jsx";
import { WebLoginBatch } from "./web-login-batch.jsx";
import { FingerprintSettingsButton, ModelFingerprintCell } from "./model-fingerprint.jsx";
import { HelpTip } from "./help-tip.jsx";
import { AccessibleDialog } from "./accessible-dialog.jsx";

const WEB_STATES = { absent: "Web 未登录", saved: "Web 待验证", valid: "Web 已验证", expired: "Web 已失效", banned: "账号已封禁" };
const BATCH_KEY = "tosub2.web-login-batch";
const POLL_INTERVAL_MS = 900;
const SUB2API_PIPELINE_TIMEOUT_MS = 15 * 60_000;
const LUBAN_API_KEY_STORAGE_KEY = "chatgpt-onboarding.luban-api-key";
const LUBAN_SERVICE_ID_STORAGE_KEY = "chatgpt-onboarding.luban-service-id";
const SMS_PROVIDER_SETTINGS_KEY = "chatgpt-onboarding.sms-provider-settings-v1";
const MAIL_REQUEST_SETTINGS_KEY = "chatgpt-onboarding.mail-request-settings-v1";
const SUB2API_UPLOAD_SETTINGS_KEY = "chatgpt-onboarding.sub2api-upload-settings-v1";
const PLAN_TYPE_MAPPING_STORAGE_KEY = "chatgpt-onboarding.plan-type-mapping-v1";
const DEFAULT_PLAN_TYPE_MAPPING = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  self_serve_business: "Business",
  self_serve_business_prolite: "Business Premium",
  self_serve_business_usage_based: "Business Usage Based",
  self_serve_pro: "Pro",
};
const DEFAULT_TASK_AUTO_ACTION_OPTIONS = [
  { value: "upload", label: "上传到 Sub2API" },
  { value: "rotate-logout-reauthorize-upload", label: "一键轮换并上传" },
  { value: "enable-overload-detection", label: "自动开启过载检测" },
  { value: "enable-overload-cooldown", label: "自动开启过载冷却" },
];
const JOB_STATUS_LABELS = {
  queued: "排队中",
  starting: "启动中",
  working: "处理中",
  password: "待密码",
  mfa_otp: "待 2FA",
  totp_starting: "准备 2FA",
  password_add_starting: "准备密码",
  totp_setup_otp: "激活 2FA",
  email_otp: "待邮箱码",
  phone: "待手机号",
  phone_otp: "待手机码",
  finalizing: "生成中",
  refreshing: "刷新授权",
  completed: "已完成",
  failed: "失败",
  mfa_failed: "2FA 未通过",
  banned: "封禁",
  canceled: "授权已取消",
  reauth_required: "待重新授权",
  resume_available: "可继续",
};
const SUB2API_POOL_FILTER_LABELS = {
  added: "已加入",
  error: "错误",
  not_added: "未加入",
  unknown: "未同步",
};
const SUB2API_ENABLED_FILTER_LABELS = {
  enabled: "已启用",
  disabled: "已停用",
  unknown: "未知",
};
const SUB2API_WS_MODE_OPTIONS = [
  { value: "off", label: "关闭（off）" },
  { value: "ctx_pool", label: "上下文池（ctx_pool）" },
  { value: "passthrough", label: "透传（passthrough）" },
  { value: "http_bridge", label: "HTTP 桥接（http_bridge）" },
];
const SUB2API_WS_MODES = new Set(SUB2API_WS_MODE_OPTIONS.map((option) => option.value));
const SUB2API_WS_MODE_LABELS = Object.fromEntries(SUB2API_WS_MODE_OPTIONS.map((option) => [option.value, option.label]));
const SMS_PROVIDER_EXTERNAL_LINKS = {
  luban: {
    href: "https://lubansms.com/",
    label: "点击获取 API 密钥",
  },
  smsbower: {
    href: "https://smsbower.app/cabinet/profile",
    label: "点击获取 API 密钥",
  },
};
const REGION_NAMES = typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
  : null;

function ColumnHeaderFilter({ title, value, onChange, options, activeLabel, align = "left" }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const active = Boolean(value);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleSelect = (val) => {
    onChange(val);
    setOpen(false);
  };

  return (
    <div className={`column-filter-container ${open ? "is-open" : ""}`} ref={containerRef}>
      <button
        type="button"
        className={`column-filter-btn ${active ? "active" : ""} ${open ? "open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        title={`筛选${title}（当前：${activeLabel}）`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`筛选${title}，当前：${activeLabel}`}
      >
        <Filter size={11} className="column-filter-icon" aria-hidden="true" />
        {active && <span className="column-filter-dot" aria-hidden="true" />}
      </button>

      {open && (
        <div className={`column-filter-dropdown align-${align}`} role="menu" aria-label={`筛选${title}`}>
          <div className="column-filter-dropdown-header">
            <span>筛选 {title}</span>
            {active && (
              <button
                type="button"
                className="column-filter-reset-btn"
                onClick={() => handleSelect("")}
                title="重置筛选为全部"
              >
                重置
              </button>
            )}
          </div>
          <div className="column-filter-options">
            {options.map((opt) => {
              const isSelected = value === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`column-filter-option ${isSelected ? "selected" : ""}`}
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => handleSelect(opt.value)}
                >
                  <span className="column-filter-option-label">{opt.label}</span>
                  {isSelected && <Check size={12} className="column-filter-check" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [token, setToken] = useState("");
  const [features, setFeatures] = useState({});
  const [jobs, setJobs] = useState([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [lockedOnly, setLockedOnly] = useState(false);
  const [webSessionFilter, setWebSessionFilter] = useState("");
  const [webBatch, setWebBatch] = useState(() => { try { const b = JSON.parse(sessionStorage.getItem(BATCH_KEY)); return b && Array.isArray(b.attempts) && Array.isArray(b.failed) && Array.isArray(b.skipped) ? b : null; } catch { return null; } });
  useEffect(() => { if (webBatch) sessionStorage.setItem(BATCH_KEY, JSON.stringify(webBatch)); else sessionStorage.removeItem(BATCH_KEY); }, [webBatch]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const [emailFilter, setEmailFilter] = useState([]);
  const [accountTypeFilter, setAccountTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [planTypeFilter, setPlanTypeFilter] = useState("");
  const [sub2apiPoolFilter, setSub2apiPoolFilter] = useState("");
  const [sub2apiEnabledFilter, setSub2apiEnabledFilter] = useState("");
  const [planTypeOptions, setPlanTypeOptions] = useState([]);
  const [statusOptions, setStatusOptions] = useState([]);
  const [sub2apiPoolOptions, setSub2apiPoolOptions] = useState([]);
  const [sub2apiEnabledOptions, setSub2apiEnabledOptions] = useState([]);
  const [planTypeUnknown, setPlanTypeUnknown] = useState(false);
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState(null);
  const [selectedJobIds, setSelectedJobIds] = useState(() => new Set());
  const [jobSelectionIndex, setJobSelectionIndex] = useState([]);
  const [batchAction, setBatchAction] = useState("");
  const [sessionActionError, setSessionActionError] = useState("");
  const logoutRunningRef = useRef(false);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  const [stats, setStats] = useState({ active: 0, queued: 0, completed: 0 });
  const [taskSettings, setTaskSettings] = useState(null);
  const [taskSettingsOpen, setTaskSettingsOpen] = useState(false);
  const [taskSettingsOpening, setTaskSettingsOpening] = useState(false);
  const taskSettingsButtonRef = useRef(null);
  const [smsSettings, setSmsSettings] = useState(readSmsProviderSettings);
  const [smsSettingsOpen, setSmsSettingsOpen] = useState(false);
  const [smsSettingsDraft, setSmsSettingsDraft] = useState(readSmsProviderSettings);
  const [smsSettingsError, setSmsSettingsError] = useState("");
  const [smsNumberOptions, setSmsNumberOptions] = useState([]);
  const [smsOptionsLoading, setSmsOptionsLoading] = useState(false);
  const [mailRequestSettings, setMailRequestSettings] = useState(readMailRequestSettings);
  const [mailRequestSettingsDraft, setMailRequestSettingsDraft] = useState(readMailRequestSettings);
  const [mailRequestSettingsOpen, setMailRequestSettingsOpen] = useState(false);
  const [mailRequestSettingsError, setMailRequestSettingsError] = useState("");
  const [mailRequestSettingsSaving, setMailRequestSettingsSaving] = useState(false);
  const [sub2apiSettings, setSub2apiSettings] = useState(readSub2ApiSettings);
  const [sub2apiSettingsDraft, setSub2apiSettingsDraft] = useState(readSub2ApiSettings);
  const [sub2apiGroups, setSub2apiGroups] = useState([]);
  const [sub2apiProxies, setSub2apiProxies] = useState([]);
  const [sub2apiSettingsOpen, setSub2apiSettingsOpen] = useState(false);
  const [sub2apiSettingsError, setSub2apiSettingsError] = useState("");
  const [sub2apiGroupsLoading, setSub2apiGroupsLoading] = useState(false);
  const [sub2apiSettingsSaving, setSub2apiSettingsSaving] = useState(false);
  const [sub2apiPlanTypeDraft, setSub2apiPlanTypeDraft] = useState("");
  const [sub2apiMonitorChecking, setSub2apiMonitorChecking] = useState(false);
  const [sub2apiMonitorStatus, setSub2apiMonitorStatus] = useState({
    configured: false,
    enabled: false,
    running: false,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
    intervalMinutes: 5,
  });
  const [uploadNotice, setUploadNotice] = useState("");
  const [accountProxyUrl, setAccountProxyUrl] = useState("");
  const [accountProxyMode, setAccountProxyMode] = useState("global");
  const [accountProxyDistribution, setAccountProxyDistribution] = useState([]);
  const [accountProxyDirectCount, setAccountProxyDirectCount] = useState(0);
  const [allowDirectFallback, setAllowDirectFallback] = useState(false);
  const [proxySettingsLoaded, setProxySettingsLoaded] = useState(false);
  const [proxySettingsDirty, setProxySettingsDirty] = useState(false);
  const [proxySettingsSaving, setProxySettingsSaving] = useState(false);
  const [proxySettingsError, setProxySettingsError] = useState("");
  const [proxySettingsOpen, setProxySettingsOpen] = useState(false);
  const [planTypeMapping, setPlanTypeMapping] = useState(readPlanTypeMapping);
  const [planTypeMappingOpen, setPlanTypeMappingOpen] = useState(false);
  const [planTypeMappingDraft, setPlanTypeMappingDraft] = useState(() => planTypeMappingRows(readPlanTypeMapping()));
  const [planTypeMappingError, setPlanTypeMappingError] = useState("");
  const [planTypeMappingSaving, setPlanTypeMappingSaving] = useState(false);
  const [credentialJob, setCredentialJob] = useState(null);
  const [remarkJob, setRemarkJob] = useState(null);
  const [sessionJob, setSessionJob] = useState(null);
  const [workspaceJob, setWorkspaceJob] = useState(null);
  const [operationDetail, setOperationDetail] = useState(null);
  const [sub2apiAccountStatus, setSub2apiAccountStatus] = useState({ configured: false, fetchedAt: null, accounts: {} });
  const [sub2apiToggleBusy, setSub2apiToggleBusy] = useState(() => new Set());
  const [sub2apiPriorityBusy, setSub2apiPriorityBusy] = useState(() => new Set());
  const [accountUsageByJobId, setAccountUsageByJobId] = useState({});

  const accountUsageJobKey = jobs
    .filter((job) => job.canDownload)
    .map((job) => `${job.id}:${job.lastOperationAt || job.updatedAt || ""}:${JSON.stringify(job.sub2apiUsage || null)}`)
    .join("|");

  useEffect(() => writeLocalJson(SMS_PROVIDER_SETTINGS_KEY, smsSettings), [smsSettings]);
  useEffect(() => writeLocalJson(MAIL_REQUEST_SETTINGS_KEY, mailRequestSettings), [mailRequestSettings]);
  useEffect(() => {
    const browserSettings = { ...sub2apiSettings };
    browserSettings.adminApiKey = "";
    writeLocalJson(SUB2API_UPLOAD_SETTINGS_KEY, browserSettings);
  }, [sub2apiSettings]);
  useEffect(() => writeLocalJson(PLAN_TYPE_MAPPING_STORAGE_KEY, planTypeMapping), [planTypeMapping]);

  useEffect(() => {
    let stopped = false;
    fetch("/api/bootstrap")
      .then(readResponse)
      .then((data) => {
        if (!stopped) {
          setToken(data.token);
          setFeatures(data.features || {});
          setTaskSettings(data.taskSettings || null);
        }
      })
      .catch((requestError) => setError(requestError.message));
    return () => {
      stopped = true;
    };
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    async function refreshProxySettings() {
      try {
        const data = await apiFetch(token, "/api/account-proxy-settings");
        if (stopped) return;
        if (!proxySettingsDirty) {
          setAccountProxyUrl(data.settings.proxyUrl || "");
          setAccountProxyMode(["sub2api", "plan"].includes(data.settings.mode) ? data.settings.mode : "global");
          setAllowDirectFallback(data.settings.allowDirectFallback === true);
        }
        setProxySettingsLoaded(true);
      } catch (requestError) {
        if (!stopped) setProxySettingsError(requestError.message);
      }
    }
    void refreshProxySettings();
    const timer = window.setInterval(refreshProxySettings, 15_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [token, proxySettingsDirty]);

  useEffect(() => {
    if (!token || !["sub2api", "plan"].includes(accountProxyMode) || !hasUsableSub2ApiSettings(sub2apiSettings)) return undefined;
    let stopped = false;
    const refresh = () => apiFetch(token, "/api/sub2api/options", {
      method: "POST", body: JSON.stringify({ config: sub2apiSettings }),
    }).then((data) => {
      if (stopped) return;
      setAccountProxyDistribution(Array.isArray(data.proxies) ? data.proxies : []);
      setAccountProxyDirectCount(data.directAccountCount || 0);
    })
      .catch((error) => { if (!stopped) setProxySettingsError(error.message); });
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [token, accountProxyMode, sub2apiSettings]);

  async function saveAccountProxySettings() {
    if (proxySettingsSaving) return;
    setProxySettingsSaving(true);
    setProxySettingsError("");
    try {
      const data = await apiFetch(token, "/api/account-proxy-settings", {
        method: "POST",
        body: JSON.stringify({ proxyUrl: String(accountProxyUrl).trim(), allowDirectFallback }),
      });
      setAccountProxyUrl(data.settings.proxyUrl || "");
      setAccountProxyMode(["sub2api", "plan"].includes(data.settings.mode) ? data.settings.mode : "global");
      setAllowDirectFallback(data.settings.allowDirectFallback === true);
      setProxySettingsDirty(false);
      setProxySettingsLoaded(true);
    } catch (requestError) {
      setProxySettingsError(requestError.message);
    } finally {
      setProxySettingsSaving(false);
    }
  }

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    const localMapping = readPlanTypeMapping();
    apiFetch(token, "/api/plan-type-mapping")
      .then((data) => {
        if (stopped) return;
        const serverMapping = normalizePlanTypeMapping(data?.mapping);
        const shouldMigrate = data?.configured !== true && hasCustomPlanTypeMapping(localMapping);
        const merged = {
          ...DEFAULT_PLAN_TYPE_MAPPING,
          ...(shouldMigrate ? localMapping : serverMapping),
        };
        setPlanTypeMapping(merged);
        setPlanTypeMappingDraft(planTypeMappingRows(merged));
        if (shouldMigrate) {
          return apiFetch(token, "/api/plan-type-mapping", {
            method: "POST",
            body: JSON.stringify({ mapping: localMapping }),
          });
        }
        return null;
      })
      .catch((requestError) => {
        if (!stopped) setError(requestError.message);
      });
    return () => {
      stopped = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void apiFetch(token, "/api/mail-request-config", {
      method: "POST",
      body: JSON.stringify({ config: buildMailRequestConfig(mailRequestSettings) }),
    }).catch((requestError) => setError(requestError.message));
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const filters = {
          search: searchQuery.trim() || undefined,
          lockedOnly: lockedOnly || undefined,
          webSession: webSessionFilter || undefined,
          accountType: accountTypeFilter || undefined,
          status: statusFilter || undefined,
          planType: planTypeFilter || undefined,
          sub2apiPool: sub2apiPoolFilter || undefined,
          sub2apiEnabled: sub2apiEnabledFilter || undefined,
        };
        const data = emailFilter.length
          ? await apiFetch(token, "/api/jobs/query", {
              method: "POST",
              body: JSON.stringify({ page, emails: emailFilter, ...filters }),
            })
          : await apiFetch(token, `/api/jobs?${new URLSearchParams({
              page: String(page),
              ...(filters.search ? { search: filters.search } : {}),
              ...(filters.lockedOnly ? { lockedOnly: "true" } : {}),
              ...(filters.webSession ? { webSession: filters.webSession } : {}),
              ...(filters.accountType ? { accountType: filters.accountType } : {}),
              ...(filters.status ? { status: filters.status } : {}),
              ...(filters.planType ? { planType: filters.planType } : {}),
              ...(filters.sub2apiPool ? { sub2apiPool: filters.sub2apiPool } : {}),
              ...(filters.sub2apiEnabled ? { sub2apiEnabled: filters.sub2apiEnabled } : {}),
            }).toString()}`);
        if (!stopped) {
          setJobs(data.jobs);
          setCredentialJob((current) => data.jobs.find((job) => job.id === current?.id) || current);
          setSessionJob((current) => data.jobs.find((job) => job.id === current?.id) || current);
          setWorkspaceJob((current) => data.jobs.find((job) => job.id === current?.id) || current);
          setJobSelectionIndex(data.selection || data.jobs);
          setPagination(data.pagination || { page, pageSize: 20, total: data.jobs.length, totalPages: 1 });
          setStats(data.stats || { active: 0, queued: 0, completed: 0 });
          if (data.taskSettings) setTaskSettings(data.taskSettings);
          const nextPlanTypeOptions = Array.isArray(data.filterOptions?.planTypes) ? data.filterOptions.planTypes : [];
          const nextPlanTypeUnknown = data.filterOptions?.planTypeUnknown === true;
          const nextStatusOptions = Array.isArray(data.filterOptions?.statuses)
            ? data.filterOptions.statuses.filter((value) => Object.hasOwn(JOB_STATUS_LABELS, value))
            : [];
          const nextPoolOptions = Array.isArray(data.filterOptions?.sub2apiPools)
            ? data.filterOptions.sub2apiPools.filter((value) => Object.hasOwn(SUB2API_POOL_FILTER_LABELS, value))
            : [];
          const nextEnabledOptions = Array.isArray(data.filterOptions?.sub2apiEnabled)
            ? data.filterOptions.sub2apiEnabled.filter((value) => Object.hasOwn(SUB2API_ENABLED_FILTER_LABELS, value))
            : [];
          setPlanTypeOptions(nextPlanTypeOptions);
          setPlanTypeUnknown(nextPlanTypeUnknown);
          setStatusOptions(nextStatusOptions);
          setSub2apiPoolOptions(nextPoolOptions);
          setSub2apiEnabledOptions(nextEnabledOptions);
          if (statusFilter && !nextStatusOptions.includes(statusFilter)) setStatusFilter("");
          if (planTypeFilter && (planTypeFilter === "__unknown__"
            ? !nextPlanTypeUnknown
            : !nextPlanTypeOptions.includes(planTypeFilter))) setPlanTypeFilter("");
          if (sub2apiPoolFilter && !nextPoolOptions.includes(sub2apiPoolFilter)) setSub2apiPoolFilter("");
          if (sub2apiEnabledFilter && !nextEnabledOptions.includes(sub2apiEnabledFilter)) setSub2apiEnabledFilter("");
          if (data.pagination?.page && data.pagination.page !== page) setPage(data.pagination.page);
          setError("");
        }
      } catch (requestError) {
        if (!stopped) setError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [token, page, searchQuery, lockedOnly, webSessionFilter, emailFilter, accountTypeFilter, statusFilter, planTypeFilter, sub2apiPoolFilter, sub2apiEnabledFilter]);

  useEffect(() => {
    if (!token || !features.sub2apiMonitor) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        const data = await apiFetch(token, "/api/sub2api/monitor");
        if (!stopped) {
          setSub2apiMonitorStatus(data);
          setSub2apiSettings((current) => mergeServerSub2ApiSettings(current, data));
        }
      } catch {}
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiMonitor]);

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    apiFetch(token, "/api/sub2api/settings")
      .then((data) => {
        if (!stopped) setSub2apiSettings((current) => mergeServerSub2ApiSettings(current, data));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !features.sub2apiAccountStatus) return undefined;
    let stopped = false;
    const load = async () => {
      try {
        if (!stopped) await refreshSub2ApiAccountStatus();
      } catch {
        // A missing or temporarily unavailable Sub2API backend leaves the local task list usable.
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [token, features.sub2apiAccountStatus, sub2apiSettings.baseUrl, sub2apiSettings.hasStoredAdminApiKey]);

  useEffect(() => {
    if (!token || !features.accountUsage) return undefined;
    const usageJobs = jobs.filter((job) => job.canDownload);
    const usageJobIds = usageJobs.map((job) => job.id);
    setAccountUsageByJobId((current) => {
      const next = { ...current };
      for (const jobId of Object.keys(next)) {
        if (!usageJobIds.includes(jobId)) delete next[jobId];
      }
      for (const jobId of usageJobIds) {
        const job = usageJobs.find((item) => item.id === jobId);
        next[jobId] = job?.sub2apiUsage
          ? { status: "ready", ...job.sub2apiUsage }
          : { status: "ready", source: "sub2api", primary: null, secondary: null, credits: null, allowed: null, limitReached: null };
      }
      return next;
    });
  }, [token, features.accountUsage, accountUsageJobKey]);

  const pageJobIds = useMemo(() => jobs.map((job) => job.id), [jobs]);
  const smsProviderDefinitions = Array.isArray(features.smsProviders) ? features.smsProviders : [];
  const activeSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettings),
    [smsProviderDefinitions, smsSettings],
  );
  const draftSmsProvider = useMemo(
    () => resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft),
    [smsProviderDefinitions, smsSettingsDraft],
  );
  const selectedJobs = useMemo(
    () => jobSelectionIndex.filter((job) => selectedJobIds.has(job.id)),
    [jobSelectionIndex, selectedJobIds],
  );
  const activeCredentialJob = credentialJob
    ? jobs.find((job) => job.id === credentialJob.id) || credentialJob
    : null;
  const activeSessionJob = sessionJob
    ? jobs.find((job) => job.id === sessionJob.id) || sessionJob
    : null;
  const activeWorkspaceJob = workspaceJob
    ? jobs.find((job) => job.id === workspaceJob.id) || workspaceJob
    : null;
  const activeLogJob = expandedJobId
    ? jobs.find((job) => job.id === expandedJobId) || null
    : null;
  const downloadableSelectedCount = selectedJobs.filter((job) => job.canDownload).length;
  const allPageSelected = pageJobIds.length > 0 && pageJobIds.every((id) => selectedJobIds.has(id));
  const canDownloadSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && downloadableSelectedCount > 0;
  const canReauthorizeSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canRegenerate || job.canRetry);
  const forceReloginSelectedCount = selectedJobs.filter((job) => job.canForceRelogin).length;
  const webLoginSelectedCount = selectedJobs.filter((job) => job.canLoginWeb).length;
  const canLoginWebSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size && webLoginSelectedCount > 0;
  const canForceReloginSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && forceReloginSelectedCount > 0;
  const canLogoutSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && selectedJobs.some((job) => job.canLogoutAllSessions);
  const sessionEligibleSelectedCount = selectedJobs.filter((job) => job.canLogoutAllSessions && job.canForceRelogin).length;
  const canCooldownSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && sessionEligibleSelectedCount > 0;
  const proxySwitchSelection = proxySwitchSelectionState(selectedJobs, {
    mode: accountProxyMode,
    proxySettingsDirty,
    sub2apiReady: hasUsableSub2ApiSettings(sub2apiSettings),
    selectedCount: selectedJobIds.size,
  });
  const canSwitchProxySelected = proxySwitchSelection.canSwitch;
  const canUploadSelected = selectedJobs.length > 0 && downloadableSelectedCount > 0;
  const canRotateAndUploadSelected = selectedJobs.length > 0
    && selectedJobs.length === selectedJobIds.size
    && selectedJobs.every((job) => job.canReplaceTotp && job.canDownload);
  const totpSetupSelectedCount = selectedJobs.filter((job) => job.canSetupTotp).length;
  const canSetupTotpSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && totpSetupSelectedCount > 0;
  const passwordAddSelectedCount = selectedJobs.filter((job) => job.canAddPassword).length;
  const canAddPasswordSelected = selectedJobs.length > 0 && selectedJobs.length === selectedJobIds.size
    && passwordAddSelectedCount > 0;
  const hasJobFilters = Boolean(searchQuery.trim() || lockedOnly || webSessionFilter || emailFilter.length || accountTypeFilter || statusFilter || planTypeFilter || sub2apiPoolFilter || sub2apiEnabledFilter);
  const availablePlanTypes = [...new Set([
    ...planTypeOptions,
    ...jobs.map((job) => job.planType).filter(Boolean),
    ...(planTypeFilter && planTypeFilter !== "__unknown__" ? [planTypeFilter] : []),
  ])].sort();
  // PlanType bindings are persisted as a global reverse index (PlanType ->
  // profile), but the editor is scoped to the selected profile. Keeping the
  // view scoped prevents a binding from appearing to follow the user when they
  // switch profiles, while preserving the backend format and migration path.
  const activeProfileBindings = Object.entries(sub2apiSettingsDraft.planTypeBindings || {})
    .filter(([, profileId]) => String(profileId) === String(sub2apiSettingsDraft.activeProfileId));

  async function refreshAccountUsage(jobId) {
    if (!token || !features.accountUsage) return;
    setAccountUsageByJobId((current) => ({ ...current, [jobId]: { status: "loading" } }));
    try {
      const data = await apiFetch(token, `/api/jobs/${encodeURIComponent(jobId)}/usage?refresh=1`);
      setJobs((current) => current.map((job) => job.id === jobId ? { ...job, sub2apiUsage: data.usage || null } : job));
      setJobSelectionIndex((current) => current.map((job) => job.id === jobId ? { ...job, sub2apiUsage: data.usage || null } : job));
      setAccountUsageByJobId((current) => ({
        ...current,
        [jobId]: { status: "ready", ...(data.usage || {}) },
      }));
    } catch (requestError) {
      setAccountUsageByJobId((current) => ({
        ...current,
        [jobId]: { status: "error", error: requestError.message },
      }));
    }
  }

  function openSmsSettings() {
    const draft = withSmsProviderDefaults(smsProviderDefinitions, smsSettings);
    setSmsSettingsDraft(draft);
    setSmsSettingsError("");
    setSmsSettingsOpen(true);
  }

  async function openTaskSettings() {
    setTaskSettingsOpening(true);
    try {
      const data = await apiFetch(token, "/api/task-settings");
      setTaskSettings(data.settings);
      setTaskSettingsOpen(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setTaskSettingsOpening(false);
    }
  }

  async function refreshAccountProxyDistribution() {
    if (!hasUsableSub2ApiSettings(sub2apiSettings)) {
      const message = "请先配置 Sub2API 后端地址和管理员 API Key";
      setProxySettingsError(message);
      throw new Error(message);
    }
    setProxySettingsSaving(true);
    setProxySettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: sub2apiSettings }),
      });
      const proxies = Array.isArray(data.proxies) ? data.proxies : [];
      setAccountProxyDistribution(proxies);
      setAccountProxyDirectCount(data.directAccountCount || 0);
      setProxySettingsError("");
      return proxies;
    } catch (requestError) {
      setProxySettingsError(requestError.message);
      throw requestError;
    } finally {
      setProxySettingsSaving(false);
    }
  }

  function openMailRequestSettings() {
    setMailRequestSettingsDraft({ ...mailRequestSettings });
    setMailRequestSettingsError("");
    setMailRequestSettingsOpen(true);
  }

  async function saveMailRequestSettings(event) {
    event.preventDefault();
    let config;
    try {
      config = buildMailRequestConfig(mailRequestSettingsDraft);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
      return;
    }
    setMailRequestSettingsSaving(true);
    setMailRequestSettingsError("");
    try {
      await apiFetch(token, "/api/mail-request-config", {
        method: "POST",
        body: JSON.stringify({ config }),
      });
      setMailRequestSettings(normalizeMailRequestSettings(mailRequestSettingsDraft));
      setMailRequestSettingsOpen(false);
    } catch (requestError) {
      setMailRequestSettingsError(requestError.message);
    } finally {
      setMailRequestSettingsSaving(false);
    }
  }

  function openSub2ApiSettings() {
    const normalized = normalizeSub2ApiSettings({ ...sub2apiSettings, monitorEnabled: Boolean(sub2apiMonitorStatus.enabled) });
    setSub2apiSettingsDraft(normalized);
    setSub2apiSettingsError("");
    setSub2apiSettingsOpen(true);
  }

  function updateSub2ApiDraftProfile(patch) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const activeId = normalized.activeProfileId;
      const resolvedPatch = typeof patch === "function" ? patch(normalized) : patch;
      const profiles = normalized.profiles.map((profile) => profile.id === activeId
        ? normalizeSub2ApiProfile({ ...profile, ...resolvedPatch }, 0, profile)
        : profile);
      const active = profiles.find((profile) => profile.id === activeId) || profiles[0];
      return { ...normalized, ...active, profiles };
    });
  }

  function selectSub2ApiProfile(profileId) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const active = normalized.profiles.find((profile) => profile.id === String(profileId)) || normalized.profiles[0];
      return { ...normalized, ...active, activeProfileId: active.id };
    });
  }

  function addSub2ApiProfile() {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const id = `profile-${Date.now()}`;
      const profile = normalizeSub2ApiProfile({ id, name: `方案 ${normalized.profiles.length + 1}` }, normalized.profiles.length);
      return { ...normalized, ...profile, profiles: [...normalized.profiles, profile], activeProfileId: id };
    });
  }

  function removeSub2ApiProfile() {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      if (normalized.profiles.length <= 1 || normalized.activeProfileId === "default") return current;
      const remaining = normalized.profiles.filter((profile) => profile.id !== normalized.activeProfileId);
      const active = remaining[0];
      const planTypeBindings = Object.fromEntries(Object.entries(normalized.planTypeBindings)
        .filter(([, profileId]) => profileId !== normalized.activeProfileId));
      return { ...normalized, ...active, profiles: remaining, activeProfileId: active.id, planTypeBindings };
    });
  }

  function updateSub2ApiPlanTypeBinding(planType, profileId) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const next = { ...normalized.planTypeBindings };
      const key = String(planType || "").trim();
      if (key) next[key] = String(profileId);
      return { ...normalized, planTypeBindings: next };
    });
  }

  function removeSub2ApiPlanTypeBinding(planType) {
    setSub2apiSettingsDraft((current) => {
      const normalized = normalizeSub2ApiSettings(current);
      const next = { ...normalized.planTypeBindings };
      delete next[planType];
      return { ...normalized, planTypeBindings: next };
    });
  }

  function addSub2ApiPlanTypeBinding() {
    const planType = String(sub2apiPlanTypeDraft || "").trim();
    if (!planType) return;
    updateSub2ApiPlanTypeBinding(planType, sub2apiSettingsDraft.activeProfileId);
    setSub2apiPlanTypeDraft("");
  }

  async function loadSub2ApiOptions(settings = sub2apiSettingsDraft) {
    setSub2apiGroupsLoading(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/options", {
        method: "POST",
        body: JSON.stringify({ config: settings }),
      });
      setSub2apiGroups(Array.isArray(data.groups) ? data.groups : []);
      setSub2apiProxies(Array.isArray(data.proxies) ? data.proxies : []);
    } catch (requestError) {
      setSub2apiGroups([]);
      setSub2apiProxies([]);
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiGroupsLoading(false);
    }
  }

  async function refreshSub2ApiAccountStatus(forceRefresh = false) {
    const data = await apiFetch(token, `/api/sub2api/account-status${forceRefresh ? "?refresh=1" : ""}`);
    setSub2apiAccountStatus(data);
    setJobs((current) => current.map((job) => mergeSub2ApiStatusIntoJob(job, data)));
    setJobSelectionIndex((current) => current.map((job) => mergeSub2ApiStatusIntoJob(job, data)));
    return data;
  }

  async function saveSub2ApiSettings(event) {
    event.preventDefault();
    const baseUrl = String(sub2apiSettingsDraft.baseUrl || "").trim();
    const adminApiKey = String(sub2apiSettingsDraft.adminApiKey || "").trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      setSub2apiSettingsError("请输入 http:// 或 https:// 开头的 Sub2API 后端地址");
      return;
    }
    if (!adminApiKey && !sub2apiSettingsDraft.hasStoredAdminApiKey) {
      setSub2apiSettingsError("请输入 Sub2API 管理员 API Key");
      return;
    }
    for (const profile of sub2apiSettingsDraft.profiles) {
      for (const [field, label] of [["autoResetCredit5hThresholdPercent", "5h"], ["autoResetCredit7dThresholdPercent", "7d"]]) {
        const value = String(profile[field] ?? "").trim();
        if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) < 0.1 || Number(value) > 100) {
          setSub2apiSettingsError(`方案“${profile.name}”的 ${label} 自动用重置卡阈值必须为 0.1–100%`);
          return;
        }
      }
      const rule = profile.importDatePriority;
      if (!/^\d+$/.test(String(rule.min)) || !/^\d+$/.test(String(rule.max)) || Number(rule.min) > Number(rule.max) || Number(rule.max) > 10000) {
        setSub2apiSettingsError(`方案“${profile.name}”的日期优先级范围必须为 0–10000 的整数，且下限不能大于上限`);
        return;
      }
    }
    const nextSettings = {
      ...readSub2ApiSettings(sub2apiSettingsDraft),
      baseUrl: baseUrl.replace(/\/+$/, ""),
      adminApiKey,
      hasStoredAdminApiKey: true,
    };
    setSub2apiSettingsSaving(true);
    try {
      const savedSettings = await apiFetch(token, "/api/sub2api/settings", {
        method: "POST",
        body: JSON.stringify({ config: nextSettings }),
      });
      const monitor = features.sub2apiMonitor
        ? await apiFetch(token, "/api/sub2api/monitor", {
        method: "POST",
        body: JSON.stringify({ enabled: nextSettings.monitorEnabled, config: nextSettings }),
      })
        : { ...savedSettings, enabled: false };
      setSub2apiSettings(mergeServerSub2ApiSettings(nextSettings, { ...savedSettings, ...monitor }));
      setSub2apiMonitorStatus((current) => ({ ...current, ...monitor }));
      void refreshSub2ApiAccountStatus(true).catch(() => {});
      setSub2apiSettingsOpen(false);
      setSub2apiSettingsError("");
      const profileSync = savedSettings.profileSync || monitor.profileSync;
      if (profileSync) {
        const notice = formatProfileSyncNotice(profileSync);
        if (profileSync.failed || (profileSync.error && !profileSync.updated)) setError(notice);
        else setUploadNotice(notice);
      }
      const dateSync = savedSettings.datePrioritySync || monitor.datePrioritySync;
      if (dateSync?.error || dateSync?.failed) setError(`配置已保存，日期优先级同步未完成：${dateSync.error || `${dateSync.failed} 条更新失败`}`);
      else if (dateSync) setUploadNotice(`配置已保存，按导入日期更新了 ${dateSync.updated} 条账号的优先级`);
    } catch (requestError) {
      setSub2apiSettingsError(requestError.message);
    } finally {
      setSub2apiSettingsSaving(false);
    }
  }

  async function checkSub2ApiMonitorNow() {
    if (!sub2apiMonitorStatus.enabled || sub2apiMonitorChecking) return;
    setSub2apiMonitorChecking(true);
    setSub2apiSettingsError("");
    try {
      const data = await apiFetch(token, "/api/sub2api/monitor/check", { method: "POST" });
      setSub2apiMonitorStatus(data);
      setUploadNotice(formatMonitorResult(data.result));
      setError("");
    } catch (requestError) {
      if (sub2apiSettingsOpen) setSub2apiSettingsError(requestError.message);
      else setError(requestError.message);
    } finally {
      setSub2apiMonitorChecking(false);
    }
  }

  function setSub2ApiGroupChecked(groupId, checked) {
    updateSub2ApiDraftProfile((normalized) => {
      const selected = new Set(normalized.groupIds || []);
      if (checked) selected.add(String(groupId));
      else selected.delete(String(groupId));
      return { groupIds: [...selected] };
    });
  }

  async function performSub2ApiUpload(ids) {
    return apiFetch(token, "/api/sub2api/upload", {
      method: "POST",
      body: JSON.stringify({ ids, config: sub2apiSettings }),
    });
  }

  async function toggleSub2ApiAccount(job, enabled) {
    if (!job?.sub2apiInPool || sub2apiToggleBusy.has(job.id)) return;
    setSub2apiToggleBusy((current) => new Set(current).add(job.id));
    try {
      const data = await apiFetch(token, `/api/sub2api/accounts/${encodeURIComponent(job.id)}/schedulable`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
      const status = data.status || {};
      const fields = sub2ApiStatusJobFields(status);
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, ...fields } : item));
      setJobSelectionIndex((current) => current.map((item) => item.id === job.id ? { ...item, ...fields } : item));
      setSub2apiAccountStatus((current) => ({
        ...current,
        fetchedAt: status.fetchedAt || current.fetchedAt,
        accounts: {
          ...(current.accounts || {}),
          [String(job.email || "").toLowerCase()]: status,
        },
      }));
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSub2apiToggleBusy((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }

  async function updateSub2ApiPriority(job, priority) {
    if (!job?.sub2apiInPool || sub2apiPriorityBusy.has(job.id)) return;
    setSub2apiPriorityBusy((current) => new Set(current).add(job.id));
    try {
      const data = await apiFetch(token, `/api/sub2api/accounts/${encodeURIComponent(job.id)}/priority`, {
        method: "POST",
        body: JSON.stringify({ priority }),
      });
      const status = {
        ...(data.status || {}),
        priority: data.status?.priority ?? data.priority ?? null,
      };
      const fields = sub2ApiStatusJobFields(status);
      const emailKey = String(job.email || "").toLowerCase();
      setJobs((current) => current.map((item) => (
        item.id === job.id || String(item.email || "").toLowerCase() === emailKey
          ? { ...item, ...fields }
          : item
      )));
      setJobSelectionIndex((current) => current.map((item) => (
        item.id === job.id || String(item.email || "").toLowerCase() === emailKey
          ? { ...item, ...fields }
          : item
      )));
      setSub2apiAccountStatus((current) => ({
        ...current,
        configured: true,
        fetchedAt: status.fetchedAt || current.fetchedAt,
        accounts: {
          ...(current.accounts || {}),
          [emailKey]: status,
        },
      }));
      setUploadNotice(`已更新 ${job.email} 的 Sub2API 优先级为 ${status.priority}`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSub2apiPriorityBusy((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }

  function formatSub2ApiUploadNotice(data) {
    if (Object.hasOwn(data || {}, "created") || Object.hasOwn(data || {}, "updated")) {
      const created = Math.max(0, Number(data?.created) || 0);
      const updated = Math.max(0, Number(data?.updated) || 0);
      const total = created + updated;
      return `已同步 ${total} 条（新增 ${created}，原地更新 ${updated}）${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`;
    }
    const rawResults = Array.isArray(data.result) ? data.result : [data.result || {}];
    const countField = (result, keys) => {
      const value = Number(keys.map((key) => result?.[key]).find((candidate) => candidate !== undefined) ?? 0);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    const createdKeys = ["account_created", "success"];
    const hasCreatedCount = rawResults.some((result) => createdKeys.some((key) => result?.[key] !== undefined));
    const created = hasCreatedCount
      ? rawResults.reduce((total, result) => total + countField(result, createdKeys), 0)
      : Number(data.uploaded || 0);
    const failed = rawResults.reduce((total, result) => total + countField(result, ["account_failed", "failed"]), 0);
    return `已上传 ${created} 条${failed ? `，失败 ${failed} 条` : ""}${data.skipped ? `，跳过未完成任务 ${data.skipped} 条` : ""}`;
  }

  async function uploadSelected(ids) {
    if (!hasUsableSub2ApiSettings(sub2apiSettings)) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址和管理员 API Key");
      return;
    }
    if (batchAction) return;
    setBatchAction("upload");
    setUploadNotice("");
    try {
      const data = await performSub2ApiUpload(ids);
      setUploadNotice(formatSub2ApiUploadNotice(data));
      void refreshSub2ApiAccountStatus(true).catch(() => {});
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function queryPipelineJobs(ids, emailById) {
    const emails = ids.map((id) => emailById.get(id)).filter(Boolean);
    if (emails.length !== ids.length) throw new Error("无法读取一键流程中的账号信息");
    const pages = [];
    let pageNumber = 1;
    let totalPages = 1;
    do {
      const data = await apiFetch(token, "/api/jobs/query", {
        method: "POST",
        body: JSON.stringify({ page: pageNumber, emails }),
      });
      pages.push(data);
      totalPages = Math.max(1, Number(data.pagination?.totalPages) || 1);
      pageNumber += 1;
    } while (pageNumber <= totalPages);
    const jobsById = new Map(pages.flatMap((data) => data.jobs || []).map((job) => [job.id, job]));
    if (jobsById.size !== ids.length) throw new Error("一键流程中的账号列表已发生变化，请刷新后重试");
    setJobs((current) => current.map((job) => jobsById.get(job.id) || job));
    const selectionById = new Map(pages.flatMap((data) => data.selection || []).map((job) => [job.id, job]));
    setJobSelectionIndex((current) => current.map((job) => selectionById.get(job.id) || job));
    return ids.map((id) => jobsById.get(id));
  }

  async function waitForPipelineJobs(ids, emailById, label, predicate, failurePredicate = null) {
    const deadline = Date.now() + SUB2API_PIPELINE_TIMEOUT_MS;
    let latest = [];
    while (Date.now() < deadline) {
      latest = await queryPipelineJobs(ids, emailById);
      const completed = latest.filter(predicate).length;
      setUploadNotice(`${label} ${completed}/${ids.length}`);
      const failed = latest.find((job) => failurePredicate?.(job) || (
        ["failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(job.status) && !predicate(job)
      ));
      if (failed) {
        const detail = extractResponseMessage(failed.totpSetupError || failed.lastError || failed.prompt || "任务失败");
        throw new Error(`${failed.email}：${detail || "任务未完成"}`);
      }
      if (latest.every(predicate)) return latest;
      await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`${label}超时，请查看任务状态后重试`);
  }

  async function rotateLogoutReauthorizeUploadSelected() {
    if (!canRotateAndUploadSelected || batchAction) return;
    if (!hasUsableSub2ApiSettings(sub2apiSettings)) {
      openSub2ApiSettings();
      setUploadNotice("请先配置 Sub2API 后端地址和管理员 API Key");
      return;
    }
    const ids = [...selectedJobIds];
    const emailById = new Map(selectedJobs.map((job) => [job.id, job.email]));
    const count = ids.length;
    if (!window.confirm(`确定对选中的 ${count} 个账号依次轮换 2FA、登出所有设备、重新授权并上传到 Sub2API 吗？当前会话会失效。`)) return;

    setBatchAction("rotate-logout-reauthorize-upload");
    setError("");
    setUploadNotice("正在轮换 2FA 0/" + count);
    try {
      const preflightJobs = await queryPipelineJobs(ids, emailById);
      const preflightFailure = preflightJobs.find((job) => !job.canReplaceTotp || !job.canDownload);
      if (preflightFailure) {
        throw new Error(`${preflightFailure.email} 当前不满足轮换 2FA 或上传条件，请刷新后重试`);
      }
      const rotationResults = await Promise.allSettled(ids.map((id) => apiFetch(token, `/api/jobs/${id}/replace-2fa`, {
        method: "POST",
        body: JSON.stringify({}),
      })));
      const rotationError = rotationResults.find((result) => result.status === "rejected");
      if (rotationError) throw new Error(`启动 2FA 轮换失败：${rotationError.reason?.message || "请求失败"}`);
      await waitForPipelineJobs(
        ids,
        emailById,
        "正在轮换 2FA",
        (job) => job.status === "completed"
          && job.lastOperationType === "replace_2fa"
          && job.hasTotpKey
          && !job.totpRotationIncomplete,
        (job) => (job.status === "completed" && job.totpRotationIncomplete) || job.status === "totp_setup_otp",
      );

      let loggedOut = 0;
      setUploadNotice("正在登出所有设备 0/" + count);
      const logoutResults = await Promise.allSettled(ids.map(async (id) => {
        const result = await apiFetch(token, `/api/jobs/${id}/sessions/logout-all`, { method: "POST" });
        loggedOut += 1;
        setUploadNotice(`正在登出所有设备 ${loggedOut}/${count}`);
        return result;
      }));
      const logoutError = logoutResults.find((result) => result.status === "rejected");
      if (logoutError) throw new Error(`登出所有设备失败：${logoutError.reason?.message || "请求失败"}`);

      setUploadNotice("正在重新授权 0/" + count);
      // logout-all invalidates the saved session/refresh token. Start a full
      // credential-backed login instead of the refresh-token regeneration path.
      const reauthorize = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      if (reauthorize.started !== count) {
        throw new Error(`重新授权只启动了 ${reauthorize.started || 0}/${count} 个账号`);
      }
      await waitForPipelineJobs(
        ids,
        emailById,
        "正在重新授权",
        (job) => job.status === "completed"
          && job.lastOperationType === "relogin"
          && job.canDownload,
      );

      setUploadNotice("正在上传到 Sub2API");
      const uploaded = await performSub2ApiUpload(ids);
      setUploadNotice(formatSub2ApiUploadNotice(uploaded));
      setSelectedJobIds(new Set());
    } catch (requestError) {
      setError(`一键流程已停止：${requestError.message}`);
      setUploadNotice("一键流程未完成，已保留当前选择");
    } finally {
      setBatchAction("");
    }
  }

  async function loadSmsNumberOptions(settings = smsSettingsDraft) {
    const resolved = resolveSmsProvider(smsProviderDefinitions, settings);
    if (!resolved.definition?.optionsEndpoint) return;
    if (!String(resolved.config.apiKey || "").trim()) {
      setSmsSettingsError("请先填写 API Key");
      return;
    }
    setSmsOptionsLoading(true);
    setSmsSettingsError("");
    try {
      const data = await apiFetch(token, resolved.definition.optionsEndpoint, {
        method: "POST",
        body: JSON.stringify({ config: resolved.config }),
      });
      const options = Array.isArray(data.options) ? data.options : [];
      setSmsNumberOptions(options);
      const current = resolved.config.maxPrice
        ? options.find((option) => option.country === resolved.config.country) || options[0]
        : options[0];
      if (!current) throw new Error("当前没有可购买的国家号码");
      updateSmsProviderConfig(resolved.id, {
        country: current.country,
        maxPrice: String(current.price),
        countryLabel: formatSmsCountryName(current),
      });
    } catch (requestError) {
      setSmsNumberOptions([]);
      setSmsSettingsError(requestError.message);
    } finally {
      setSmsOptionsLoading(false);
    }
  }

  function updateSmsProviderConfig(providerId, values) {
    setSmsSettingsDraft((current) => ({
      ...current,
      configs: {
        ...(current.configs || {}),
        [providerId]: {
          ...(current.configs?.[providerId] || {}),
          ...values,
        },
      },
    }));
  }

  function saveSmsSettings(event) {
    event.preventDefault();
    const resolved = resolveSmsProvider(smsProviderDefinitions, smsSettingsDraft);
    if (!resolved.definition) {
      setSmsSettingsError("请选择接码平台");
      return;
    }
    const missing = resolved.definition.fields.find((field) => (
      field.required !== false && !String(resolved.config[field.key] || "").trim()
    ));
    if (missing) {
      setSmsSettingsError(`请填写${missing.label}`);
      return;
    }
    if (resolved.id === "custom") {
      const customEntries = inspectCustomSmsEntries(resolved.config.entries);
      if (customEntries.error) {
        setSmsSettingsError(customEntries.error);
        return;
      }
    }
    setSmsSettings(withSmsProviderDefaults(smsProviderDefinitions, smsSettingsDraft));
    setSmsSettingsOpen(false);
    setSmsSettingsError("");
  }

  useEffect(() => {
    const valid = new Set(jobSelectionIndex.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) return current;
      return next;
    });
  }, [jobSelectionIndex]);

  useEffect(() => {
    setExpandedJobId(null);
  }, [page]);

  function openPlanTypeMapping() {
    setPlanTypeMappingDraft(planTypeMappingRows(planTypeMapping));
    setPlanTypeMappingError("");
    setPlanTypeMappingOpen(true);
  }

  function resetPlanTypeMapping() {
    setPlanTypeMappingDraft(planTypeMappingRows(DEFAULT_PLAN_TYPE_MAPPING));
    setPlanTypeMappingError("");
  }

  async function savePlanTypeMapping(event) {
    event.preventDefault();
    if (planTypeMappingSaving) return;
    const next = {};
    for (const row of planTypeMappingDraft) {
      const raw = String(row.raw || "").trim();
      const label = String(row.label || "").trim();
      if (!raw && !label) continue;
      if (!raw || !label) {
        setPlanTypeMappingError("每一行都需要填写原始 PlanType 和显示标签");
        return;
      }
      if (raw.length > 128 || label.length > 128) {
        setPlanTypeMappingError("PlanType 和显示标签最多 128 个字符");
        return;
      }
      next[raw] = label;
    }
    setPlanTypeMappingSaving(true);
    setPlanTypeMappingError("");
    try {
      const saved = await apiFetch(token, "/api/plan-type-mapping", {
        method: "POST",
        body: JSON.stringify({ mapping: next }),
      });
      const normalized = { ...DEFAULT_PLAN_TYPE_MAPPING, ...normalizePlanTypeMapping(saved.mapping || next) };
      setPlanTypeMapping(normalized);
      setPlanTypeMappingDraft(planTypeMappingRows(normalized));
      setPlanTypeMappingOpen(false);
    } catch (requestError) {
      setPlanTypeMappingError(requestError.message);
    } finally {
      setPlanTypeMappingSaving(false);
    }
  }

  async function createJob(event) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs", {
        method: "POST",
        body: JSON.stringify({ email: email.trim() }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs([data.job], current).slice(0, 20));
      setEmail("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch(event) {
    event.preventDefault();
    if (!batchText.trim() || batchBusy) return;
    setBatchBusy(true);
    try {
      const data = await apiFetch(token, "/api/jobs/batch", {
        method: "POST",
        body: JSON.stringify({ text: batchText }),
      });
      setPage(1);
      if (page === 1) setJobs((current) => mergeJobs(data.jobs, current).slice(0, 20));
      setBatchText("");
      setBatchError("");
      setBatchOpen(false);
      setError("");
      if (data.remarkSync?.error) setUploadNotice(`账号已导入，备注已保存在本地；号池同步未完成：${data.remarkSync.error}`);
      else if (data.remarkSync?.updated) setUploadNotice(`账号已导入，已同步 ${data.remarkSync.updated} 条号池记录的备注`);
    } catch (requestError) {
      setBatchError(requestError.message);
    } finally {
      setBatchBusy(false);
    }
  }

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      setEmailFilter(emails);
      setSelectedJobIds(new Set());
      setExpandedJobId(null);
      setPage(1);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    setEmailFilter([]);
    setSearchQuery("");
    setLockedOnly(false);
    setWebSessionFilter("");
    setAccountTypeFilter("");
    setStatusFilter("");
    setFilterText("");
    setPlanTypeFilter("");
    setSub2apiPoolFilter("");
    setSub2apiEnabledFilter("");
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
    setFilterError("");
  }

  function applyColumnFilter(setter, value) {
    setter(value);
    setSelectedJobIds(new Set());
    setExpandedJobId(null);
    setPage(1);
  }

  function toggleJobSelection(jobId) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function toggleAllOnPage() {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      pageJobIds.forEach((id) => {
        if (allPageSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }

  async function downloadSelected() {
    if (!canDownloadSelected || batchAction) return;
    setBatchAction("download");
    try {
      const response = await fetch("/api/jobs/download-batch", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "批量下载失败");
      await saveDownloadResponse(response, `sub2api-import-oauth-${downloadableSelectedCount}-accounts-${localTimestamp()}.json`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function reauthorizeSelected() {
    if (!canReauthorizeSelected || batchAction) return;
    setBatchAction("reauthorize");
    try {
      await apiFetch(token, "/api/jobs/reauthorize-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function setupTotpSelected() {
    if (!canSetupTotpSelected || batchAction) return;
    const skipped = selectedJobIds.size - totpSetupSelectedCount;
    const message = `确定为选中的 ${totpSetupSelectedCount} 个账号设置 2FA 吗？${skipped ? `另有 ${skipped} 个账号不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("setup-2fa");
    try {
      const data = await apiFetch(token, "/api/jobs/setup-2fa-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号设置 2FA${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function addPasswordSelected() {
    if (!canAddPasswordSelected || batchAction) return;
    const skipped = selectedJobIds.size - passwordAddSelectedCount;
    const message = `确定为选中的 ${passwordAddSelectedCount} 个无密码账号生成并添加随机强密码吗？${skipped ? `另有 ${skipped} 个账号已有密码或不符合条件，将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("add-password");
    try {
      const data = await apiFetch(token, "/api/jobs/add-password-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setUploadNotice(`已开始为 ${data.started} 个账号添加密码${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function runSelectedPoolAction(action) {
    if (!selectedJobIds.size || batchAction) return;
    if (action === "switch-proxy" && (!["sub2api", "plan"].includes(accountProxyMode) || proxySettingsDirty)) {
      setProxySettingsError(proxySwitchSelection.reason);
      return;
    }
    const switching = action === "switch-proxy";
    if (switching && !proxySwitchSelection.canSwitch) {
      setError(proxySwitchSelection.reason);
      return;
    }
    const actionIds = switching ? proxySwitchSelection.eligible.map((job) => job.id) : [...selectedJobIds];
    const actionCount = switching ? actionIds.length : sessionEligibleSelectedCount;
    const skippedCount = switching ? proxySwitchSelection.skippedCount : 0;
    const endpoint = action === "cooldown" ? "/api/jobs/cooldown-batch" : "/api/jobs/switch-proxy-batch";
    const label = action === "cooldown" ? "一键冷却" : "一键切换 IP";
    if (!window.confirm(action === "cooldown"
      ? `确定登出选中账号的所有设备，并在任务设置的冷却时长后重新登录、授权和同步号池凭据吗？共 ${sessionEligibleSelectedCount} 个账号。`
      : `确定为 ${actionCount} 个账号手动应用当前方案吗？直连方案会清除原代理绑定，固定代理使用指定节点，均衡分配更换出口；然后登出所有设备、重新登录授权并同步号池。方案配置本身不会修改。${skippedCount ? `其余 ${skippedCount} 个账号将跳过。` : ""}`)) return;
    setBatchAction(action);
    setError("");
    setUploadNotice(`${label}正在处理 ${actionCount} 个账号`);
    try {
      const data = await apiFetch(token, endpoint, {
        method: "POST",
        body: JSON.stringify({ ids: actionIds }),
      });
      const failed = Array.isArray(data.failed) ? data.failed : [];
      setUploadNotice(action === "cooldown"
        ? `冷却已开始 ${data.started} 个账号，时长 ${data.cooldownMinutes} 分钟${failed.length ? `，失败 ${failed.length} 个` : ""}`
        : `已启动切换 IP 并重新授权 ${data.started} 个账号${skippedCount + Number(data.skipped || 0) ? `，跳过 ${skippedCount + Number(data.skipped || 0)} 个` : ""}${failed.length ? `，失败 ${failed.length} 个` : ""}`);
      if (failed.length) setError(failed.slice(0, 5).map((item) => `${item.email}：${item.error}`).join("；"));
      setSelectedJobIds(new Set());
      void refreshSub2ApiAccountStatus(true).catch(() => {});
    } catch (requestError) {
      setError(`${label}失败：${requestError.message}`);
    } finally {
      setBatchAction("");
    }
  }

  async function logoutAllDevices(targetJobs, bulk = false) {
    if (batchAction || logoutRunningRef.current || !token) return;
    const eligible = targetJobs.filter((job) => job.canLogoutAllSessions);
    if (!eligible.length) return;
    const skipped = targetJobs.length - eligible.length;
    const subject = bulk ? `选中的 ${eligible.length} 个账号` : `账号 ${eligible[0].email}`;
    if (!window.confirm(`确定登出${subject}的所有设备和会话吗？当前会话也会失效，之后可能需要重新登录。${skipped ? `另有 ${skipped} 个账号正在运行或没有已保存的授权，将跳过。` : ""}`)) return;
    logoutRunningRef.current = true;
    setBatchAction(bulk ? "logout-all" : `logout-all:${eligible[0].id}`);
    setSessionActionError("");
    setError("");
    setUploadNotice(`正在提交全部设备登出请求 0/${eligible.length}`);
    try {
      const results = await logoutAccountSessions(eligible,
        (url, options) => apiFetch(token, url, options),
        (completed, total) => setUploadNotice(`正在提交全部设备登出请求 ${completed}/${total}`));
      const succeeded = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      setUploadNotice(`全部设备登出请求：成功 ${succeeded.length} 个，失败 ${failed.length} 个${skipped ? `，跳过 ${skipped} 个` : ""}。服务端可能需要几分钟完成传播。`);
      if (bulk) {
        const succeededIds = new Set(succeeded.map((result) => result.job.id));
        setSelectedJobIds((current) => new Set([...current].filter((id) => !succeededIds.has(id))));
      }
      if (failed.length) {
        setSessionActionError(`登出失败：${failed.slice(0, 5).map(({ job, error }) => `${job.email}：${error}`).join("；")}${failed.length > 5 ? `；另有 ${failed.length - 5} 个失败账号` : ""}。可稍后重试。`);
      }
    } catch (requestError) {
      setSessionActionError(requestError.message);
    } finally {
      logoutRunningRef.current = false;
      setBatchAction("");
    }
  }

  async function loginWebSelected(ids = [...selectedJobIds]) {
    if (!Array.isArray(ids) || !ids.length || batchAction) return;
    setBatchAction("web-login");
    try {
      const data = await apiFetch(token, "/api/jobs/web-login-batch", {
        method: "POST", body: JSON.stringify({ ids }),
      });
      const failed = data.failed || [], skipped = data.skippedJobs || [];
      setWebBatch({ attempts: data.jobs.map(job => ({ id: job.id, attemptId: job.webLoginAttemptId })), failed, skipped });
      setSelectedJobIds(new Set([...failed, ...skipped].map(item => item.id)));
      setError("");
    } catch (requestError) { setError(requestError.message); }
    finally { setBatchAction(""); }
  }

  async function forceReloginSelected() {
    if (!canForceReloginSelected || batchAction) return;
    const skipped = selectedJobIds.size - forceReloginSelectedCount;
    const message = `确定让选中的 ${forceReloginSelectedCount} 个账号跳过刷新令牌，重新登录并授权吗？${skipped ? `另有 ${skipped} 个进行中账号将自动跳过。` : ""}`;
    if (!window.confirm(message)) return;
    setBatchAction("relogin");
    try {
      const data = await apiFetch(token, "/api/jobs/relogin-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setUploadNotice(`已开始重新登录并授权 ${data.started} 个账号${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`);
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function exportSelectedSource() {
    if (!selectedJobIds.size || batchAction) return;
    setBatchAction("source");
    try {
      const response = await fetch("/api/jobs/export-source", {
        method: "POST",
        headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "原始信息导出失败");
      await saveDownloadResponse(response, `chatgpt-account-source-${selectedJobIds.size}-accounts-${localTimestamp()}.txt`);
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteAccount(job) {
    if (!token || batchAction) return;
    if (!window.confirm(`确定删除账号 ${job.email} 吗？对应的本地授权文件、保存的凭据也会被删除；如已配置 Sub2API，还会同步删除该邮箱对应的号池账号。此操作不可恢复。`)) return;
    setBatchAction(`delete:${job.id}`);
    try {
      const result = await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [job.id] }),
      });
      const email = job.email.toLowerCase();
      const deletedIds = new Set([...jobs, ...jobSelectionIndex]
        .filter((item) => item.email.toLowerCase() === email)
        .map((item) => item.id));
      deletedIds.add(job.id);
      setJobs((current) => current.filter((item) => item.email.toLowerCase() !== email));
      setJobSelectionIndex((current) => current.filter((item) => item.email.toLowerCase() !== email));
      setSelectedJobIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      setExpandedJobId((current) => deletedIds.has(current) ? null : current);
      setCredentialJob((current) => current?.email.toLowerCase() === email ? null : current);
      setSessionJob((current) => current?.email.toLowerCase() === email ? null : current);
      setWorkspaceJob((current) => current?.email.toLowerCase() === email ? null : current);
      setError("");
      const synchronized = Number(result?.sub2api?.deleted || 0);
      setUploadNotice(synchronized
        ? `已删除账号 ${job.email}，并同步删除 ${synchronized} 个号池账号`
        : `已删除账号 ${job.email}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function deleteSelected() {
    if (!selectedJobIds.size || batchAction) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 条任务吗？对应的本地授权文件也会被删除。`)) return;
    setBatchAction("delete");
    try {
      const result = await apiFetch(token, "/api/jobs/delete-batch", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedJobIds] }),
      });
      setJobs((current) => current.filter((job) => !selectedJobIds.has(job.id)));
      setSelectedJobIds(new Set());
      setError("");
      const synchronized = Number(result?.sub2api?.deleted || 0);
      setUploadNotice(synchronized
        ? `已删除 ${result.deleted} 条任务，并同步删除 ${synchronized} 个号池账号`
        : `已删除 ${result.deleted} 条任务`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  async function cancelAllRunningJobs() {
    const runningCount = (stats.active || 0) + (stats.queued || 0);
    if (!runningCount || batchAction) return;
    if (!window.confirm(`确定停止全部 ${runningCount} 条进行中和排队任务吗？`)) return;
    setBatchAction("cancel-all");
    try {
      await apiFetch(token, "/api/jobs/cancel-all", { method: "POST" });
      setSelectedJobIds(new Set());
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBatchAction("");
    }
  }

  return (
    <div className={`app-layout ${batchAction ? "workflow-busy" : ""}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-block">
            <div className="brand-mark"><ShieldCheck size={18} strokeWidth={2.2} /></div>
            <div className="brand-copy">
              <div className="brand-title-group">
                <h1>Sub2api Helper</h1>
                <span className="brand-badge">Pro Console</span>
                <HelpTip title="控制台说明" label="查看控制台说明">
                  本地多任务协议登录与号池管理中心，支持自动邮箱/短信接码、2FA 轮换、Web 会话管理、Sub2API 号池同步与代理纯净度检测。
                </HelpTip>
              </div>
            </div>
          </div>

          <div className="telemetry-capsule" aria-label="任务统计">
            <span className="summary-pill" title="进行中任务数 / 同时运行任务数上限">
              <i className="status-dot active" />
              <span>进行中</span>
              <strong>{stats.active}{taskSettings ? ` / ${taskSettings.maxActiveJobs}` : ""}</strong>
            </span>
            <span className="telemetry-divider" aria-hidden="true" />
            <span className="summary-pill">
              <i className="status-dot queued" />
              <span>排队中</span>
              <strong>{stats.queued || 0}</strong>
            </span>
            <span className="telemetry-divider" aria-hidden="true" />
            <span className="summary-pill">
              <i className="status-dot complete" />
              <span>已完成</span>
              <strong>{stats.completed}</strong>
            </span>
          </div>

          <div className="topbar-actions">
            <button
              className="secondary-button topbar-action-button"
              type="button"
              onClick={openPlanTypeMapping}
              disabled={!token}
              title="配置 PlanType 映射"
              aria-label="配置 PlanType 映射"
            >
              <Tags size={14} />
              PlanType 映射
            </button>
            {features.modelFingerprint && <FingerprintSettingsButton token={token} planTypes={availablePlanTypes} />}
            {features.taskSettings && (
              <button ref={taskSettingsButtonRef} type="button" className="secondary-button topbar-action-button" onClick={openTaskSettings} disabled={!token || taskSettingsOpening}>
                {taskSettingsOpening ? <LoaderCircle className="spin" size={14} /> : <Settings2 size={14} />}任务设置
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="app-shell">

      <div className="provider-grid" aria-label="核心服务配置">
        <section className="provider-card sms-provider-card" aria-label="接码平台配置">
          <div className="provider-card-header">
            <div className="provider-heading">
              <span className="provider-icon sms"><PhoneIncoming size={16} /></span>
              <strong>接码平台</strong>
              <HelpTip title="接码平台配置" label="查看接码平台说明">
                用于登录或绑定手机验证时自动取号与接收短信验证码。支持鲁班 SMS、SMSBower 及自定义接码 API。
              </HelpTip>
            </div>
            <div className="provider-card-actions">
              <button type="button" className="secondary-button provider-settings-button" onClick={openSmsSettings} disabled={!smsProviderDefinitions.length}>
                <Settings2 size={14} />配置
              </button>
            </div>
          </div>
          <div className="provider-card-body">
            <div className="provider-primary-row">
              <span className="provider-name">{activeSmsProvider.name || "未选择"}</span>
              <span className={`provider-status-pill ${activeSmsProvider.ready ? "ready" : "pending"}`}>
                {activeSmsProvider.ready ? "已就绪" : "待配置"}
              </span>
            </div>
            <div className="provider-status-row">
              <span className={`provider-ready ${activeSmsProvider.ready ? "" : "incomplete"}`}>
                {activeSmsProvider.ready ? <Check size={13} /> : <CircleAlert size={13} />}
                <span className="provider-ready-text">
                  {activeSmsProvider.ready
                    ? (activeSmsProvider.summary ? `已配置 · ${activeSmsProvider.summary}` : "已配置完成")
                    : "点击右上角配置 API 凭据"}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section className="provider-card mail-request-card" aria-label="邮件接码请求配置">
          <div className="provider-card-header">
            <div className="provider-heading">
              <span className="provider-icon mail"><MailCheck size={16} /></span>
              <strong>邮件 API</strong>
              <HelpTip title="邮件 API 请求配置" label="查看邮件 API 说明">
                配置自动拉取邮箱验证码的 HTTP 请求方式（GET / POST）与公共请求头，配置保存在当前浏览器。
              </HelpTip>
            </div>
            <div className="provider-card-actions">
              <button type="button" className="secondary-button provider-settings-button" onClick={openMailRequestSettings} disabled={!token}>
                <Settings2 size={14} />配置
              </button>
            </div>
          </div>
          <div className="provider-card-body">
            <div className="provider-primary-row">
              <span className="provider-name" title={mailRequestSettings.url || mailRequestSettings.method}>
                {mailRequestSettings.method}{mailRequestSettings.method === "POST" && mailRequestSettings.url ? ` · ${mailRequestSettings.url}` : " 请求模式"}
              </span>
              <span className="provider-status-pill ready">已就绪</span>
            </div>
            <div className="provider-status-row">
              <span className="provider-ready">
                <Check size={13} />
                <span className="provider-ready-text">{formatMailRequestSummary(mailRequestSettings)}</span>
              </span>
            </div>
          </div>
        </section>

        <section className="provider-card sub2api-card" aria-label="Sub2API 配置与号池监控">
          <div className="provider-card-header">
            <div className="provider-heading">
              <span className="provider-icon sub2api"><Send size={16} /></span>
              <strong>Sub2API</strong>
              <HelpTip title="Sub2API 与号池监控" label="查看 Sub2API 说明">
                <div>后端地址：{sub2apiSettings.baseUrl || "未配置"}</div>
                {hasUsableSub2ApiSettings(sub2apiSettings) && (
                  <div>
                    路由策略：{sub2apiSettings.groupIds.length ? `${sub2apiSettings.groupIds.length} 个号池` : "默认号池"}
                    {sub2apiSettings.proxyId === "balanced" ? " · 均衡分配" : sub2apiSettings.proxyId ? " · 已指定代理" : ""}
                    {" · WS "}{SUB2API_WS_MODE_LABELS[sub2apiSettings.wsMode] || sub2apiSettings.wsMode}
                  </div>
                )}
                {features.sub2apiMonitor && (
                  <div>
                    异常巡检：{sub2apiMonitorStatus.running ? "正在巡检" : sub2apiMonitorStatus.enabled ? `已启用${sub2apiMonitorStatus.lastCheckAt ? `（${formatRelativeMonitorTime(sub2apiMonitorStatus.lastCheckAt)}）` : ""}` : "未启用"}
                  </div>
                )}
              </HelpTip>
            </div>
            <div className="provider-card-actions">
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button
                  type="button"
                  className="icon-button monitor-check-button"
                  onClick={checkSub2ApiMonitorNow}
                  disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}
                  title="立即检查 Sub2API 异常账号"
                  aria-label="立即检查 Sub2API 异常账号"
                >
                  <RefreshCw className={sub2apiMonitorChecking || sub2apiMonitorStatus.running ? "spin" : ""} size={14} />
                </button>
              )}
              <button type="button" className="secondary-button provider-settings-button" onClick={openSub2ApiSettings} disabled={!token}>
                <Settings2 size={14} />配置
              </button>
            </div>
          </div>
          <div className="provider-card-body">
            <div className="provider-primary-row">
              <span className="provider-name" title={sub2apiSettings.baseUrl || undefined}>{sub2apiSettings.baseUrl || "未配置后端地址"}</span>
              <span className={`provider-status-pill ${hasUsableSub2ApiSettings(sub2apiSettings) ? "ready" : "pending"}`}>
                {hasUsableSub2ApiSettings(sub2apiSettings) ? "已连接" : "待配置"}
              </span>
            </div>
            <div className="provider-status-row">
              <span className={`provider-ready ${hasUsableSub2ApiSettings(sub2apiSettings) ? "" : "incomplete"}`}>
                {hasUsableSub2ApiSettings(sub2apiSettings) ? <Check size={13} /> : <CircleAlert size={13} />}
                <span className="provider-ready-text">
                  {hasUsableSub2ApiSettings(sub2apiSettings)
                    ? `${sub2apiSettings.groupIds.length ? `已配置 · ${sub2apiSettings.groupIds.length} 个号池` : "已配置 · 默认号池"}${features.sub2apiMonitor ? (sub2apiMonitorStatus.running ? " · 巡检中" : sub2apiMonitorStatus.enabled ? " · 监控开启" : "") : ""}`
                    : "未完成配置"}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section className="provider-card account-proxy-card" aria-label="代理 IP 配置">
          <div className="provider-card-header">
            <div className="provider-heading">
              <span className="provider-icon proxy"><Globe2 size={16} /></span>
              <strong>代理 IP</strong>
              <HelpTip title="代理 IP 与分配说明" label="查看代理 IP 说明">
                <div>当前模式：{accountProxyMode === "plan" ? "动态登录 · 按 PlanType 授权" : accountProxyMode === "sub2api" ? "Sub2API 出口 IP 均衡分配" : "全局代理"}</div>
                <div>支持 http://、https://、socks5:// 和 socks5h://；用户名中包含 -sid- 时会自动轮换会话编号。</div>
                {["sub2api", "plan"].includes(accountProxyMode) && (
                  <div>
                    {accountProxyDistribution.length
                      ? `已读取 ${accountProxyDistribution.length} 个代理节点 / ${proxyDistributionByIp(accountProxyDistribution).length} 个出口 IP（未分配代理 ${accountProxyDirectCount} 个 OAuth 账号）`
                      : "请点击“配置”读取 Sub2API 代理以启用账号级分配"}
                  </div>
                )}
                {["sub2api", "plan"].includes(accountProxyMode) && <div>仅统计 OAuth 账号：号池 OpenAI OAuth 账号与本地已授权账号，按邮箱去重；不含 API Key 和未完成授权的任务，并非实时连接数。</div>}
              </HelpTip>
            </div>
            <div className="provider-card-actions">
              <button
                type="button"
                className="secondary-button provider-settings-button"
                onClick={() => setProxySettingsOpen(true)}
                disabled={!token}
              >
                <Settings2 size={14} />配置
              </button>
            </div>
          </div>
          <div className="provider-card-body">
            <div className="provider-primary-row">
              <span className="provider-name" title={accountProxyUrl || undefined}>
                {accountProxyMode === "sub2api"
                  ? "Sub2API 均衡分配"
                  : accountProxyMode === "plan"
                    ? (accountProxyUrl.trim() ? `按 PlanType · ${accountProxyUrl.trim()}` : "按 PlanType 授权")
                    : (accountProxyUrl.trim() || "未配置全局代理")}
              </span>
              <span className={`provider-status-pill ${(accountProxyMode === "sub2api" ? accountProxyDistribution.length > 0 : Boolean(accountProxyUrl.trim())) ? "ready" : "pending"}`}>
                {(accountProxyMode === "sub2api" ? accountProxyDistribution.length > 0 : Boolean(accountProxyUrl.trim())) ? "已启用" : "直连出口"}
              </span>
            </div>
            <div className="provider-status-row">
              <span className={`provider-ready ${(accountProxyMode === "sub2api" ? accountProxyDistribution.length > 0 : Boolean(accountProxyUrl.trim())) ? "" : "incomplete"}`}>
                {(accountProxyMode === "sub2api" ? accountProxyDistribution.length > 0 : Boolean(accountProxyUrl.trim())) ? <Check size={13} /> : <CircleAlert size={13} />}
                <span className="provider-ready-text">
                  {!proxySettingsLoaded
                    ? "正在读取配置"
                    : proxySettingsDirty
                      ? "修改待保存"
                      : accountProxyMode === "sub2api"
                        ? (accountProxyDistribution.length ? `已读取 ${accountProxyDistribution.length} 个代理节点` : "待读取 Sub2API 代理")
                        : accountProxyUrl.trim()
                          ? `已配置${allowDirectFallback ? " · 允许直连回退" : ""}`
                          : "未配置 · 默认服务器出口"}
                </span>
              </span>
            </div>
          </div>
        </section>
      </div>

      <section className="workspace">
        <div className="section-heading">
          <div className="section-title-group">
            <h2>账号列表</h2>
            <span className="task-count-badge">
              {pagination.total || 0}
            </span>
            <HelpTip title="账号列表说明" label="查看账号列表说明">
              使用右侧“批量添加”导入账号（完整支持邮箱、密码与 2FA）；在搜索栏输入关键词可实时过滤账号。
            </HelpTip>
          </div>

          <button
            className="primary-button add-batch-button"
            type="button"
            onClick={() => { setBatchError(""); setBatchOpen(true); }}
            disabled={!token}
          >
            <ListPlus size={15} />
            批量添加
          </button>

          <div className="section-toolbar">
            <div className="account-search-bar">
              <Search size={14} className="search-icon" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => {
                  applyColumnFilter(setSearchQuery, event.target.value);
                }}
                placeholder="搜索账号邮箱、备注、订阅方案..."
                aria-label="搜索账号"
              />
              {searchQuery && (
                <button
                  type="button"
                  className="search-clear-button"
                  onClick={() => applyColumnFilter(setSearchQuery, "")}
                  title="清空搜索"
                  aria-label="清空搜索"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <div className="account-filter-controls" aria-label="账号筛选">
              <div className="filter-select-wrapper">
                <select className="web-state-filter" data-active={Boolean(webSessionFilter)} aria-label="筛选 Web 登录态" value={webSessionFilter}
                  onChange={(event) => applyColumnFilter(setWebSessionFilter, event.target.value)}>
                  <option value="">全部 Web 状态</option>
                  {Object.entries(WEB_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <ChevronDown size={12} className="filter-select-chevron" aria-hidden="true" />
              </div>
              <button type="button" className={`secondary-button filter-chip-button ${emailFilter.length ? "filter-active" : ""}`} disabled={!token}
                onClick={() => { setFilterError(""); setFilterText(emailFilter.join("\n")); setFilterOpen(true); }}>
                <Filter size={13} />{emailFilter.length ? `邮箱列表 ${emailFilter.length}` : "邮箱列表筛选"}
              </button>
              <label className={`locked-only-filter ${lockedOnly ? "active" : ""}`}>
                <input type="checkbox" checked={lockedOnly} onChange={(event) => applyColumnFilter(setLockedOnly, event.target.checked)} />
                仅封禁 / 已锁定
              </label>
              {hasJobFilters && (
                <button type="button" className="selection-text-button clear-filters-button" onClick={clearEmailFilter}>
                  清除全部筛选
                </button>
              )}
            </div>
          </div>
        </div>

        {sessionActionError && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{sessionActionError}</span>
            <button type="button" onClick={() => setSessionActionError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {error && (
          <div className="global-error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭"><X size={16} /></button>
          </div>
        )}
        {webBatch && <WebLoginBatch token={token} batch={webBatch} onRetry={loginWebSelected} onClose={() => setWebBatch(null)} busy={Boolean(batchAction)} />}
        {uploadNotice && (
          <div className="global-success" role="status">
            {batchAction ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
            <span>{uploadNotice}</span>
            <button type="button" onClick={() => setUploadNotice("")} title="关闭"><X size={16} /></button>
          </div>
        )}

        {features.bulkActions && jobs.length > 0 && (
          <div className={`selection-toolbar ${selectedJobIds.size ? "has-selection" : ""}`}>
            <div className="selection-summary">
              <span className="selection-count"><strong>{selectedJobIds.size}</strong> 已选</span>
              <span className="selection-detail">
                共 {jobs.length} 项{downloadableSelectedCount > 0 ? ` · 可下载 ${downloadableSelectedCount} 项` : ""}
              </span>
              <button type="button" className="selection-text-button" onClick={toggleAllOnPage} disabled={allPageSelected || !pageJobIds.length || Boolean(batchAction)}>
                {allPageSelected ? "已全选" : "全选"}
              </button>
              {selectedJobIds.size > 0 && (
                <button type="button" className="selection-text-button" onClick={() => setSelectedJobIds(new Set())} disabled={Boolean(batchAction)}>
                  清除选择
                </button>
              )}
              <HelpTip title="批量操作说明" label="查看批量操作说明">
                <div>勾选列表中的账号后可执行批量下载、上传号池、重新授权、Web 登录，或在“更多”中换绑 IP、冷却及配置 2FA。</div>
                {features.accountSessions && selectedJobIds.size > 0 && (
                  <div style={{ marginTop: 4 }}>代理状态：{proxySwitchSelection.reason}</div>
                )}
              </HelpTip>
            </div>
            <div className="bulk-actions">
              {features.cancelAll && (stats.active > 0 || stats.queued > 0) && (
                <button
                  type="button"
                  className="stop-all-button"
                  onClick={cancelAllRunningJobs}
                  disabled={Boolean(batchAction)}
                  title="停止所有正在运行或排队中的任务"
                >
                  {batchAction === "cancel-all" ? <LoaderCircle className="spin" size={14} /> : <Ban size={14} />}
                  <span>停止全部</span>
                </button>
              )}

              <div className="bulk-btn-group">
                <button
                  type="button"
                  className="secondary-button bulk-button"
                  onClick={downloadSelected}
                  disabled={!canDownloadSelected || Boolean(batchAction)}
                  title="批量下载选中账号的凭据文件"
                >
                  {batchAction === "download" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
                  <span>下载</span>
                </button>

                {features.sub2apiUpload && (
                  <button
                    type="button"
                    className="primary-button bulk-button bulk-primary"
                    onClick={() => uploadSelected([...selectedJobIds])}
                    disabled={!canUploadSelected || Boolean(batchAction)}
                    title="批量上传选中账号到 Sub2API 号池"
                  >
                    {batchAction === "upload" ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
                    <span>上传号池</span>
                  </button>
                )}

                {features.sub2apiPipeline && (
                  <button
                    type="button"
                    className="secondary-button bulk-button pipeline-button"
                    onClick={rotateLogoutReauthorizeUploadSelected}
                    disabled={!canRotateAndUploadSelected || Boolean(batchAction)}
                    title="依次轮换 2FA、登出所有设备、重新授权并上传到 Sub2API"
                  >
                    {batchAction === "rotate-logout-reauthorize-upload" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                    <span>轮换上传</span>
                  </button>
                )}

                <button
                  type="button"
                  className="secondary-button bulk-button"
                  onClick={reauthorizeSelected}
                  disabled={!canReauthorizeSelected || Boolean(batchAction)}
                  title="为选中的账号重新获取 Codex 授权令牌"
                >
                  {batchAction === "reauthorize" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                  <span>重新授权</span>
                </button>

                {features.webLogin && (
                  <button
                    type="button"
                    className="secondary-button bulk-button"
                    onClick={() => loginWebSelected()}
                    disabled={!canLoginWebSelected || Boolean(batchAction)}
                    title="仅登录 Web 端，与授权共用任务并发池，不执行 Codex 授权或号池上传"
                  >
                    {batchAction === "web-login" ? <LoaderCircle className="spin" size={14} /> : <Globe2 size={14} />}
                    <span>登录 Web</span>
                  </button>
                )}

                <BulkMoreMenu
                  features={features}
                  batchAction={batchAction}
                  selectedCount={selectedJobIds.size}
                  canForceReloginSelected={canForceReloginSelected}
                  forceReloginSelected={forceReloginSelected}
                  canSwitchProxySelected={canSwitchProxySelected}
                  proxySwitchSelection={proxySwitchSelection}
                  runSelectedPoolAction={runSelectedPoolAction}
                  canCooldownSelected={canCooldownSelected}
                  taskSettings={taskSettings}
                  canLogoutSelected={canLogoutSelected}
                  logoutAllDevices={logoutAllDevices}
                  selectedJobs={selectedJobs}
                  canSetupTotpSelected={canSetupTotpSelected}
                  setupTotpSelected={setupTotpSelected}
                  canAddPasswordSelected={canAddPasswordSelected}
                  addPasswordSelected={addPasswordSelected}
                  exportSelectedSource={exportSelectedSource}
                />
              </div>

              <button
                type="button"
                className="delete-button bulk-button"
                onClick={deleteSelected}
                disabled={!selectedJobIds.size || Boolean(batchAction)}
                title="删除所选账号"
              >
                {batchAction === "delete" ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                <span>删除</span>
              </button>
            </div>
          </div>
        )}

        <div className="table-frame">
          <table>
            <colgroup>
              <col className="select-column" />
              <col className="account-column" />
              <col className="plan-column" />
              <col className="usage-column" />
              <col className="pool-column" />
              <col className="enabled-column" />
              <col className="priority-column" />
              <col className="status-column" />
              <col className="step-column" />
              <col className="time-column" />
              <col className="op-time-column" />
              <col className="bound-ip-column" />
              <col className="overload-column" />
              <col className="fingerprint-column" />
              <col className="actions-column" />
            </colgroup>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!features.bulkActions || !pageJobIds.length || Boolean(batchAction)}
                    aria-label="选择当前页全部任务"
                  />
                </th>
                <th className="account-heading">
                  <div className="column-filter-heading">
                    <span>账号</span>
                    <ColumnHeaderFilter
                      title="账号"
                      value={accountTypeFilter}
                      onChange={(v) => applyColumnFilter(setAccountTypeFilter, v)}
                      options={[
                        { value: "", label: "全部" },
                        { value: "password_totp", label: "密码 + 2FA" },
                        { value: "pool_only", label: "仅号池" },
                      ]}
                      activeLabel={accountTypeFilter === "password_totp" ? "密码+2FA" : accountTypeFilter === "pool_only" ? "仅号池" : "全部"}
                    />
                  </div>
                </th>
                <th>
                  <div className="column-filter-heading">
                    <span>Plan type</span>
                    <ColumnHeaderFilter
                      title="Plan type"
                      value={planTypeFilter}
                      onChange={(v) => applyColumnFilter(setPlanTypeFilter, v)}
                      options={[
                        { value: "", label: "全部" },
                        ...(planTypeUnknown ? [{ value: "__unknown__", label: "未知" }] : []),
                        ...availablePlanTypes.map((value) => ({ value, label: formatPlanTypeLabel(value, planTypeMapping) })),
                      ]}
                      activeLabel={planTypeFilter === "__unknown__" ? "未知" : planTypeFilter ? formatPlanTypeLabel(planTypeFilter, planTypeMapping) : "全部"}
                    />
                  </div>
                </th>
                <th className="usage-heading">用量</th>
                <th>
                  <div className="column-filter-heading">
                    <span>号池</span>
                    <ColumnHeaderFilter
                      title="号池"
                      value={sub2apiPoolFilter}
                      onChange={(v) => applyColumnFilter(setSub2apiPoolFilter, v)}
                      options={[
                        { value: "", label: "全部" },
                        ...sub2apiPoolOptions.map((value) => ({ value, label: SUB2API_POOL_FILTER_LABELS[value] })),
                      ]}
                      activeLabel={sub2apiPoolFilter ? SUB2API_POOL_FILTER_LABELS[sub2apiPoolFilter] : "全部"}
                    />
                  </div>
                </th>
                <th>
                  <div className="column-filter-heading">
                    <span>启用</span>
                    <ColumnHeaderFilter
                      title="启用"
                      value={sub2apiEnabledFilter}
                      onChange={(v) => applyColumnFilter(setSub2apiEnabledFilter, v)}
                      options={[
                        { value: "", label: "全部" },
                        ...sub2apiEnabledOptions.map((value) => ({ value, label: SUB2API_ENABLED_FILTER_LABELS[value] })),
                      ]}
                      activeLabel={sub2apiEnabledFilter ? SUB2API_ENABLED_FILTER_LABELS[sub2apiEnabledFilter] : "全部"}
                    />
                  </div>
                </th>
                <th className="priority-heading">优先级</th>
                <th>
                  <div className="column-filter-heading">
                    <span>状态</span>
                    <ColumnHeaderFilter
                      title="状态"
                      value={statusFilter}
                      onChange={(v) => applyColumnFilter(setStatusFilter, v)}
                      options={[
                        { value: "", label: "全部" },
                        ...statusOptions.map((value) => ({ value, label: JOB_STATUS_LABELS[value] || value })),
                      ]}
                      activeLabel={statusFilter ? (JOB_STATUS_LABELS[statusFilter] || statusFilter) : "全部"}
                    />
                  </div>
                </th>
                <th>当前操作</th>
                <th>开始时间</th>
                <th>最近操作时间</th>
                <th className="bound-ip-heading">绑定 IP</th>
                <th className="overload-heading">过载检测</th>
                <th className="fingerprint-heading">降智检测</th>
                <th className="actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && <EmptyState filtered={hasJobFilters} />}
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  token={token}
                  workflowBusy={Boolean(batchAction)}
                  expanded={expandedJobId === job.id}
                  onToggleLogs={() => setExpandedJobId((current) => current === job.id ? null : job.id)}
                  onError={setError}
                  selected={selectedJobIds.has(job.id)}
                  onToggleSelected={() => toggleJobSelection(job.id)}
                  onDelete={() => deleteAccount(job)}
                  deleteAvailable={Boolean(features.bulkActions)}
                  deleteDisabled={!token || Boolean(batchAction)}
                  deleteBusy={batchAction === `delete:${job.id}`}
                  selectionSupported={Boolean(features.bulkActions && !batchAction)}
                  smsProviderAvailable={smsProviderDefinitions.length > 0}
                  smsProvider={activeSmsProvider}
                  onUpload={() => uploadSelected([job.id])}
                  sub2apiUploadAvailable={Boolean(features.sub2apiUpload && hasUsableSub2ApiSettings(sub2apiSettings))}
                  sub2apiToggleAvailable={Boolean(features.sub2apiAccountToggle && hasUsableSub2ApiSettings(sub2apiSettings))}
                  sub2apiToggleBusy={sub2apiToggleBusy.has(job.id)}
                  onToggleSub2Api={(enabled) => toggleSub2ApiAccount(job, enabled)}
                  sub2apiPriorityAvailable={Boolean(features.sub2apiAccountPriority && hasUsableSub2ApiSettings(sub2apiSettings))}
                  sub2apiPriorityBusy={sub2apiPriorityBusy.has(job.id)}
                  onUpdateSub2ApiPriority={(priority) => updateSub2ApiPriority(job, priority)}
                  totpSetupAvailable={Boolean(features.totpSetup)}
                  passwordAddAvailable={Boolean(features.passwordAdd)}
                  forceReloginAvailable={Boolean(features.forceRelogin)}
                  webLoginAvailable={Boolean(features.webLogin)}
                  accountProxyUrl={accountProxyUrl}
                  planTypeMapping={planTypeMapping}
                  accountUsage={accountUsageByJobId[job.id]}
                  accountUsageAvailable={Boolean(features.accountUsage)}
                  onRefreshUsage={() => refreshAccountUsage(job.id)}
                  credentialsAvailable={Boolean(features.credentialDetails)}
                  onOpenCredentials={() => setCredentialJob(job)}
                  remarksAvailable={Boolean(features.accountRemarks)}
                  onOpenRemark={() => setRemarkJob(job)}
                  sessionsAvailable={Boolean(features.accountSessions)}
                  onOpenSessions={() => setSessionJob(job)}
                  onLogoutAllSessions={() => logoutAllDevices([job])}
                  logoutAllBusy={batchAction === `logout-all:${job.id}`}
                  workspacesAvailable={Boolean(features.accountWorkspaces)}
                  onOpenWorkspaces={() => setWorkspaceJob(job)}
                  onOpenOperationDetail={(detail) => setOperationDetail({ email: job.email, ...detail })}
                />
              ))}
            </tbody>
          </table>
        </div>
        {features.pagination && pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="任务分页">
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} title="上一页">
              <ChevronLeft size={17} />
            </button>
            <span>第 <strong>{pagination.page}</strong> / {pagination.totalPages} 页</span>
            <button type="button" className="icon-button" onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))} disabled={page >= pagination.totalPages} title="下一页">
              <ChevronRight size={17} />
            </button>
          </nav>
        )}
      </section>
      {remarkJob && (
        <RemarkDialog
          token={token}
          job={remarkJob}
          onClose={() => setRemarkJob(null)}
          onSaved={(data) => {
            const email = data.job.email.toLowerCase();
            const merge = (current) => current.map((item) => item.email.toLowerCase() === email ? { ...item, remark: data.job.remark, remarkSyncPending: data.job.remarkSyncPending, updatedAt: data.job.updatedAt } : item);
            setJobs(merge);
            setJobSelectionIndex(merge);
            setUploadNotice(data.sub2api?.error
              ? `备注已保存在本地；号池同步未完成：${data.sub2api.error}`
              : data.sub2api?.matched
                ? `备注已${data.job.remark ? "保存" : "清空"}，已同步同邮箱的 ${data.sub2api.matched} 条号池记录`
                : `本地备注已${data.job.remark ? "保存" : "清空"}，上传账号时会同步到号池`);
            setRemarkJob(null);
          }}
        />
      )}
      {activeCredentialJob && (
          <CredentialDialog
          key={activeCredentialJob.id}
          token={token}
          job={activeCredentialJob}
          accountProxyUrl={accountProxyUrl}
          totpReplaceAvailable={Boolean(features.totpReplace)}
          onClose={() => setCredentialJob(null)}
          onError={setError}
        />
      )}
      {activeSessionJob && (
        <SessionDialog
          key={activeSessionJob.id}
          token={token}
          job={activeSessionJob}
          onClose={() => setSessionJob(null)}
          onError={setError}
        />
      )}
      {activeWorkspaceJob && (
        <WorkspaceDialog
          key={activeWorkspaceJob.id}
          token={token}
          job={activeWorkspaceJob}
          planTypeMapping={planTypeMapping}
          onClose={() => setWorkspaceJob(null)}
          onError={setError}
          onJobUpdate={(nextJob) => {
            setJobs((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
            setJobSelectionIndex((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
          }}
          onWorkspaceSwitched={() => {
            // The server invalidates its Sub2API status cache after the
            // in-place credential update. Refresh once immediately so the
            // account row keeps its pool badge/priority without waiting for
            // the regular 15-second status poll.
            void refreshSub2ApiAccountStatus(true).catch(() => {});
          }}
        />
      )}
      {activeLogJob && (
        <LogDialog
          key={activeLogJob.id}
          token={token}
          job={activeLogJob}
          onClose={() => setExpandedJobId(null)}
        />
      )}
      {operationDetail && (
        <OperationDetailDialog detail={operationDetail} onClose={() => setOperationDetail(null)} />
      )}
      {proxySettingsOpen && (
        <AccessibleDialog className="proxy-settings-dialog" labelledBy="proxy-settings-title"
          closeDisabled={proxySettingsSaving} onClose={() => setProxySettingsOpen(false)}>
            <div className="dialog-header">
              <div>
                <h2 id="proxy-settings-title">代理 IP 配置与检测</h2>
                <HelpTip title="代理 IP 配置说明" label="查看代理 IP 配置说明">
                  支持 http://、https://、socks5:// 和 socks5h:// 协议；用户名中包含 -sid- 时会自动轮换会话编号。代理配置保存到服务端，所有浏览器共用。
                </HelpTip>
              </div>
              <div className="dialog-header-actions">
                <a
                  className="provider-external-link"
                  href="https://invite.zooproxy.com/share/ez2v2jdb7"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  获取代理 IP
                </a>
                <button type="button" className="icon-button" autoFocus data-dialog-initial-focus onClick={() => setProxySettingsOpen(false)} disabled={proxySettingsSaving} title="关闭" aria-label="关闭代理 IP 配置">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="proxy-dialog-body">
              <div className="proxy-mode-banner">
                <Globe2 size={15} />
                <span>
                  {accountProxyMode === "plan"
                    ? "当前模式：动态登录 · 按 PlanType 授权"
                    : accountProxyMode === "sub2api"
                      ? "当前模式：Sub2API 出口 IP 均衡分配"
                      : "当前模式：全局代理"}
                </span>
                <HelpTip title="代理分配模式" label="查看代理分配模式说明">
                  可在顶部“任务设置”中切换全局代理、Sub2API 均衡分配或动态登录 + 按 PlanType 授权模式。
                </HelpTip>
              </div>

              {["sub2api", "plan"].includes(accountProxyMode) && (
                <div className="proxy-sub2api-section">
                  <div className="proxy-sub2api-header">
                    <span className={`provider-ready ${accountProxyDistribution.length ? "" : "incomplete"}`}>
                      {accountProxyDistribution.length ? <Check size={14} /> : <CircleAlert size={14} />}
                      <span className="provider-ready-text">
                        {accountProxyDistribution.length
                          ? `已读取 ${accountProxyDistribution.length} 个代理节点 / ${proxyDistributionByIp(accountProxyDistribution).length} 个出口 IP`
                          : "读取 Sub2API 代理以启用账号级分配"}
                      </span>
                      <HelpTip title="节点分配规则" label="查看节点分配规则">
                        {accountProxyMode === "plan"
                          ? "按 PlanType 方案首次分配，已有绑定保持不变。"
                          : "新账号按出口 IP 均衡分配，已有绑定保持不变。"}
                      </HelpTip>
                    </span>
                    <button
                      type="button"
                      className="secondary-button compact-btn"
                      onClick={() => { void refreshAccountProxyDistribution().catch(() => {}); }}
                      disabled={proxySettingsSaving || !token}
                    >
                      {proxySettingsSaving ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}读取代理
                    </button>
                  </div>
                  {(accountProxyDistribution.length > 0 || accountProxyDirectCount > 0) && (
                    <div className="proxy-distribution" aria-label="代理 IP 账号分配">
                      {proxyDistributionByIp(accountProxyDistribution).map((proxy) => (
                        <span key={proxy.ipAddress}>{proxy.names.join("、")} · {proxy.ipAddress} · {proxy.accountCount} 个 OAuth 账号</span>
                      ))}
                      <span>未分配代理 · {accountProxyDirectCount} 个 OAuth 账号</span>
                      <p className="proxy-distribution-scope">仅统计 OAuth 账号：号池 OpenAI OAuth 账号与本地已授权账号，按邮箱去重；不含 API Key 和未完成授权的任务。未分配代理是配置状态，不代表实时直连流量。</p>
                    </div>
                  )}
                </div>
              )}

              {accountProxyMode !== "sub2api" && (
                <div className="proxy-global-section">
                  <label className="settings-field wide-settings-field">
                    <span className="field-label-row">
                      <span>全局代理地址</span>
                      <HelpTip title="全局代理说明" label="查看全局代理说明">
                        {!proxySettingsLoaded
                          ? "正在读取服务端配置"
                          : proxySettingsDirty
                            ? "尚未保存，任务仍使用已保存配置"
                            : accountProxyUrl.trim()
                              ? "已保存到服务端，所有浏览器共用"
                              : "未配置全局代理时，保留账号代理或使用服务器默认出口"}
                      </HelpTip>
                    </span>
                    <div className="provider-field account-proxy-field">
                      <Globe2 size={15} aria-hidden="true" />
                      <input
                        value={accountProxyUrl}
                        onChange={(event) => { setAccountProxyUrl(event.target.value); setProxySettingsDirty(true); }}
                        disabled={!proxySettingsLoaded || proxySettingsSaving}
                        placeholder="socks5h://用户名:密码@主机:端口"
                        spellCheck="false"
                        aria-label="代理 IP 地址"
                      />
                    </div>
                  </label>
                  <label className="proxy-fallback-option">
                    <input
                      type="checkbox"
                      checked={allowDirectFallback}
                      onChange={(event) => { setAllowDirectFallback(event.target.checked); setProxySettingsDirty(true); }}
                      disabled={!proxySettingsLoaded || proxySettingsSaving}
                    />
                    <span>代理失败时允许回退本地出口 IP</span>
                  </label>
                </div>
              )}

              {proxySettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{proxySettingsError}</div>}

              <ProxyQualityPanel
                token={token}
                mode={accountProxyMode}
                proxies={accountProxyDistribution}
                globalProxyUrl={accountProxyUrl}
                dirty={proxySettingsDirty}
              />
            </div>

            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setProxySettingsOpen(false)} disabled={proxySettingsSaving}>关闭</button>
              <button
                type="button"
                className="primary-button"
                onClick={saveAccountProxySettings}
                disabled={!proxySettingsLoaded || proxySettingsSaving || !proxySettingsDirty}
              >
                {proxySettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                {proxySettingsSaving ? "保存中…" : "保存代理配置"}
              </button>
            </div>
        </AccessibleDialog>
      )}
      {smsSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSmsSettingsOpen(false);
        }}>
          <form className="batch-dialog sms-settings-dialog" onSubmit={saveSmsSettings} role="dialog" aria-modal="true" aria-labelledby="sms-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sms-settings-title">接码平台配置</h2>
                <HelpTip title="接码平台说明" label="查看接码平台配置说明">
                  <div>配置保存在当前浏览器。</div>
                  {draftSmsProvider.definition?.description && <div>{draftSmsProvider.definition.description}</div>}
                </HelpTip>
              </div>
              <div className="dialog-header-actions">
                {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id] && (
                  <a
                    className="provider-external-link"
                    href={SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    {SMS_PROVIDER_EXTERNAL_LINKS[draftSmsProvider.id].label}
                  </a>
                )}
                <button type="button" className="icon-button" onClick={() => setSmsSettingsOpen(false)} title="关闭">
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="provider-tabs" role="tablist" aria-label="选择接码平台">
              {smsProviderDefinitions.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="tab"
                  aria-selected={draftSmsProvider.id === provider.id}
                  className={draftSmsProvider.id === provider.id ? "active" : ""}
                  onClick={() => {
                    setSmsSettingsDraft((current) => withSmsProviderDefaults(smsProviderDefinitions, {
                      ...current,
                      selectedProviderId: provider.id,
                    }));
                    setSmsSettingsError("");
                  }}
                >
                  {provider.name}
                </button>
              ))}
            </div>

            {draftSmsProvider.definition && (
              <div className="provider-config-section">
                <div className="provider-config-grid">
                  {draftSmsProvider.definition.fields.filter((field) => field.type !== "hidden").map((field) => (
                    <label key={field.key} className={`settings-field ${["price-select", "textarea"].includes(field.type) ? "wide-settings-field" : ""}`}>
                      <span>{field.label}</span>
                      {field.type === "price-select" ? (
                        <div className="price-select-row">
                          <div className="price-select-box">
                            <Settings2 size={15} />
                            <select
                              value={draftSmsProvider.config.country || ""}
                              onChange={(event) => {
                                const selected = smsNumberOptions.find((option) => option.country === event.target.value);
                                if (!selected) return;
                                updateSmsProviderConfig(draftSmsProvider.id, {
                                  country: selected.country,
                                  maxPrice: String(selected.price),
                                  countryLabel: formatSmsCountryName(selected),
                                });
                              }}
                              disabled={!smsNumberOptions.length || smsOptionsLoading}
                              aria-label="SMSBower 国家与价格"
                            >
                              {!smsNumberOptions.length && (
                                <option value={draftSmsProvider.config.country || ""}>
                                  {smsOptionsLoading ? "正在查询实时价格..." : "请先查询实时价格"}
                                </option>
                              )}
                              {smsNumberOptions.map((option) => (
                                <option key={option.country} value={option.country}>{formatSmsPriceOption(option)}</option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="price-refresh-button"
                            onClick={() => loadSmsNumberOptions()}
                            disabled={smsOptionsLoading || !draftSmsProvider.config.apiKey}
                          >
                            {smsOptionsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                            {smsOptionsLoading ? "查询中" : "查询价格"}
                          </button>
                        </div>
                      ) : field.type === "textarea" ? (
                        <textarea
                          className="settings-textarea"
                          value={draftSmsProvider.config[field.key] || ""}
                          onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                          placeholder={field.placeholder}
                          rows="8"
                          autoComplete="off"
                          spellCheck="false"
                        />
                      ) : (
                        <div>
                          {field.type === "password" ? <KeyRound size={15} /> : <Settings2 size={15} />}
                          <input
                            type={field.type || "text"}
                            value={draftSmsProvider.config[field.key] || ""}
                            onChange={(event) => updateSmsProviderConfig(draftSmsProvider.id, { [field.key]: event.target.value })}
                            placeholder={field.placeholder}
                            autoComplete="off"
                            spellCheck="false"
                          />
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {smsSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{smsSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setSmsSettingsOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!draftSmsProvider.definition}>
                <Check size={17} />保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {mailRequestSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !mailRequestSettingsSaving) setMailRequestSettingsOpen(false);
        }}>
          <form className="batch-dialog mail-request-settings-dialog" onSubmit={saveMailRequestSettings} role="dialog" aria-modal="true" aria-labelledby="mail-request-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="mail-request-settings-title">邮件 API 请求配置</h2>
                <HelpTip title="邮件 API 请求说明" label="查看邮件 API 请求说明">
                  配置保存在当前浏览器，请求内容不会写入任务日志。
                </HelpTip>
              </div>
              <button type="button" className="icon-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="provider-tabs mail-method-tabs" role="tablist" aria-label="邮件 API 请求方式">
              {["GET", "POST"].map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={mailRequestSettingsDraft.method === method}
                  className={mailRequestSettingsDraft.method === method ? "active" : ""}
                  onClick={() => setMailRequestSettingsDraft((current) => ({ ...current, method }))}
                >
                  {method}
                </button>
              ))}
            </div>

            <div className="provider-config-grid mail-request-config-grid">
              {mailRequestSettingsDraft.method === "POST" && (
                <label className="settings-field wide-settings-field">
                  <span className="mail-request-url-label">
                    统一 POST 请求 URL
                    <small>必填</small>
                    <HelpTip title="POST 请求体说明" label="查看 POST 请求体说明">
                      每个账号自己的请求体请在批量添加账号时一并导入。
                    </HelpTip>
                  </span>
                  <input
                    className="mail-request-url-input"
                    type="url"
                    value={mailRequestSettingsDraft.url}
                    onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mail.example/api/messages"
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>
              )}
              <label className="settings-field wide-settings-field">
                <span>请求头 JSON</span>
                <textarea
                  className="settings-textarea"
                  value={mailRequestSettingsDraft.headersText}
                  onChange={(event) => setMailRequestSettingsDraft((current) => ({ ...current, headersText: event.target.value }))}
                  placeholder={'{"Authorization":"Bearer ...","Referer":"https://mail.example/"}'}
                  rows="7"
                  autoComplete="off"
                  spellCheck="false"
                />
              </label>
            </div>

            {mailRequestSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{mailRequestSettingsError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setMailRequestSettingsOpen(false)} disabled={mailRequestSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={mailRequestSettingsSaving || !token}>
                {mailRequestSettingsSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {sub2apiSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSub2apiSettingsOpen(false);
        }}>
          <form className="batch-dialog sub2api-settings-dialog" onSubmit={saveSub2ApiSettings} role="dialog" aria-modal="true" aria-labelledby="sub2api-settings-title">
            <div className="dialog-header">
              <div>
                <h2 id="sub2api-settings-title">Sub2API 配置</h2>
                <HelpTip title="Sub2API 配置说明" label="查看 Sub2API 配置说明">
                  <div>配置保存到 x1 服务端设置文件；管理员 Key 不写入任务文件、日志或浏览器存储。</div>
                  <div>分组为空时，上传使用 Sub2API 默认号池，监控检查全部 OpenAI 账号；选择 OpenAI 或 Composite 分组后只监控这些号池。</div>
                  <div>Codex 指纹收敛和 WS mode 会写入每个上传或巡检更新的 OpenAI OAuth 账号（需确认 Sub2API 的 gateway.openai_ws.mode_router_v2_enabled 已开启）。</div>
                </HelpTip>
              </div>
              <button type="button" className="icon-button" onClick={() => setSub2apiSettingsOpen(false)} title="关闭"><X size={18} /></button>
            </div>
            <div className="provider-config-grid sub2api-config-grid">
              <label className="settings-field wide-settings-field">
                <span>Sub2API 后端地址</span>
                <input
                  type="url"
                  value={sub2apiSettingsDraft.baseUrl}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="例如 http://127.0.0.1:8080"
                  autoComplete="url"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>管理员 API Key</span>
                <input
                  type="password"
                  value={sub2apiSettingsDraft.adminApiKey}
                  onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, adminApiKey: event.target.value }))}
                  placeholder={sub2apiSettingsDraft.hasStoredAdminApiKey ? "已保存到 x1，留空保持不变" : "输入 sub2api 管理员 API Key"}
                  autoComplete="off"
                />
              </label>
              {features.sub2apiMonitor && (
                <label className="settings-field wide-settings-field sub2api-monitor-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sub2apiSettingsDraft.monitorEnabled)}
                    onChange={(event) => setSub2apiSettingsDraft((current) => ({ ...current, monitorEnabled: event.target.checked }))}
                  />
                  <span className="field-label-row">
                    <strong>每 5 分钟监控异常账号</strong>
                    <HelpTip title="异常账号监控" label="查看异常账号监控说明">
                      只自动处理上次完整登录未人工输入密码、邮箱码或登录 2FA 的任务。
                    </HelpTip>
                  </span>
                </label>
              )}
              <section className="sub2api-profile-manager wide-settings-field" aria-label="Sub2API 配置方案">
                <div className="sub2api-profile-header">
                  <div className="field-label-row">
                    <strong>配置方案</strong>
                    <HelpTip title="配置方案与回退规则" label="查看配置方案说明">
                      <div>管理地址、管理员密钥和自动检测为全局设置；号池、代理、模型、并发等内容按方案独立保存。保存后，改动的参数会自动同步到已绑定 PlanType 的号池账号。</div>
                      <div>未绑定回退规则：账号的 PlanType 没有绑定方案时，会使用当前方案“{sub2apiSettingsDraft.name || "当前方案"}”；已绑定的 PlanType 优先使用绑定方案。</div>
                    </HelpTip>
                  </div>
                  <button type="button" className="secondary-button compact-btn" onClick={addSub2ApiProfile}><Plus size={14} />新增方案</button>
                </div>
                <div className="sub2api-profile-controls">
                  <label className="settings-field">
                    <span>当前方案</span>
                    <select value={sub2apiSettingsDraft.activeProfileId} onChange={(event) => selectSub2ApiProfile(event.target.value)}>
                      {sub2apiSettingsDraft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label className="settings-field sub2api-profile-name-field">
                    <span>方案名称</span>
                    <input
                      value={sub2apiSettingsDraft.name || ""}
                      maxLength="80"
                      onChange={(event) => updateSub2ApiDraftProfile({ name: event.target.value })}
                      placeholder="例如 Business Premium"
                    />
                  </label>
                  <button type="button" className="icon-button danger" onClick={removeSub2ApiProfile} disabled={sub2apiSettingsDraft.profiles.length <= 1 || sub2apiSettingsDraft.activeProfileId === "default"} title={sub2apiSettingsDraft.activeProfileId === "default" ? "默认方案不可删除" : "删除当前方案"} aria-label="删除当前方案"><Trash2 size={16} /></button>
                </div>
                <div className="sub2api-binding-panel">
                  <div className="sub2api-binding-heading">
                    <span className="field-label-row">
                      <span>PlanType 绑定（当前方案）</span>
                      <HelpTip title="PlanType 绑定说明" label="查看 PlanType 绑定说明">
                        左框是账号实际检测到的原始 PlanType（括号内显示原始值）；右框是匹配后使用的 Sub2API 配置方案。箭头表示“检测类型 → 配置方案”。仅显示绑定到“{sub2apiSettingsDraft.name || "当前方案"}”的检测类型；切换方案后列表会随之切换。
                      </HelpTip>
                    </span>
                  </div>
                  <div className="sub2api-binding-list">
                    {activeProfileBindings.map(([planType, profileId]) => (
                      <div className="sub2api-binding-row" key={planType}>
                        <select value={planType} onChange={(event) => {
                          const next = event.target.value;
                          removeSub2ApiPlanTypeBinding(planType);
                          if (next) updateSub2ApiPlanTypeBinding(next, profileId);
                        }}>
                          <option value={planType}>{formatPlanTypeLabel(planType, planTypeMapping)} ({planType})</option>
                          {availablePlanTypes.filter((value) => value !== planType).map((value) => <option key={value} value={value}>{formatPlanTypeLabel(value, planTypeMapping)} ({value})</option>)}
                        </select>
                        <span aria-hidden="true">→</span>
                        <select value={profileId} onChange={(event) => updateSub2ApiPlanTypeBinding(planType, event.target.value)}>
                          {sub2apiSettingsDraft.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                        </select>
                        <button type="button" className="icon-button danger" onClick={() => removeSub2ApiPlanTypeBinding(planType)} title="删除绑定" aria-label="删除绑定"><Trash2 size={15} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="sub2api-binding-add">
                    <input
                      list="sub2api-plan-type-options"
                      value={sub2apiPlanTypeDraft}
                      maxLength="128"
                      onChange={(event) => setSub2apiPlanTypeDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSub2ApiPlanTypeBinding(); } }}
                      placeholder="输入或选择 PlanType，例如 free"
                      aria-label="添加 PlanType 绑定"
                    />
                    <datalist id="sub2api-plan-type-options">
                      {availablePlanTypes.map((value) => <option key={value} value={value}>{formatPlanTypeLabel(value, planTypeMapping)}</option>)}
                    </datalist>
                    <button type="button" className="secondary-button compact-btn" onClick={addSub2ApiPlanTypeBinding} disabled={!sub2apiPlanTypeDraft.trim()}><Plus size={14} />绑定</button>
                  </div>
                </div>
                <fieldset className="settings-field wide-settings-field import-date-priority-section">
                  <legend className="field-label-row">
                    <span>按导入日期设置优先级（当前方案）</span>
                    <HelpTip title="导入日期优先级说明" label="查看导入日期优先级说明">
                      此设置绑定当前配置方案，该方案服务的所有 PlanType 共用同一套日期排序。按上海时区的导入日期从早到晚分组，同日同级，超出范围统一使用上限。例如 2–5：13 日 → 2，14 日 → 3，第 4 个日期及以后 → 5。开启后优先于固定优先级；保存、上传与号池同步时自动计算。
                    </HelpTip>
                  </legend>
                  <label className="import-date-priority-toggle">
                    <input type="checkbox" checked={sub2apiSettingsDraft.importDatePriority.enabled} onChange={(event) => updateSub2ApiDraftProfile({ importDatePriority: { ...sub2apiSettingsDraft.importDatePriority, enabled: event.target.checked } })} />
                    <span>开启日期优先级</span>
                  </label>
                  <div className="import-date-priority-range">
                    <label className="settings-field"><span>优先级下限</span><input type="number" min="0" max="10000" step="1" disabled={!sub2apiSettingsDraft.importDatePriority.enabled} value={sub2apiSettingsDraft.importDatePriority.min} onChange={(event) => updateSub2ApiDraftProfile({ importDatePriority: { ...sub2apiSettingsDraft.importDatePriority, min: event.target.value } })} /></label>
                    <span aria-hidden="true">—</span>
                    <label className="settings-field"><span>优先级上限</span><input type="number" min="0" max="10000" step="1" disabled={!sub2apiSettingsDraft.importDatePriority.enabled} value={sub2apiSettingsDraft.importDatePriority.max} onChange={(event) => updateSub2ApiDraftProfile({ importDatePriority: { ...sub2apiSettingsDraft.importDatePriority, max: event.target.value } })} /></label>
                  </div>
                </fieldset>
              </section>
              <fieldset className="settings-field wide-settings-field sub2api-group-field">
                <legend>目标号池（可多选）</legend>
                <section className="sub2api-group-picker" aria-label="目标号池">
                  {sub2apiGroups.length ? sub2apiGroups.map((group) => {
                    const groupId = String(group.id);
                    return (
                      <label key={group.id} className="sub2api-group-option">
                        <input
                          type="checkbox"
                          checked={(sub2apiSettingsDraft.groupIds || []).includes(groupId)}
                          onChange={(event) => setSub2ApiGroupChecked(groupId, event.target.checked)}
                        />
                        <span>{group.name}</span>
                        <small>{formatSub2ApiGroupPlatform(group.platform)} · ID: {group.id}</small>
                      </label>
                    );
                  }) : <div className="sub2api-group-empty">暂无可选号池</div>}
                </section>
                <section className="sub2api-group-selection" aria-label="号池选择操作">
                  <span>已选 {(sub2apiSettingsDraft.groupIds || []).length} 个</span>
                  <button
                    type="button"
                    onClick={() => updateSub2ApiDraftProfile({ groupIds: sub2apiGroups.map((group) => String(group.id)) })}
                    disabled={!sub2apiGroups.length || sub2apiGroups.every((group) => (sub2apiSettingsDraft.groupIds || []).includes(String(group.id)))}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSub2ApiDraftProfile({ groupIds: [] })}
                    disabled={!sub2apiSettingsDraft.groupIds?.length}
                  >
                    清空
                  </button>
                </section>
              </fieldset>
              <label className="settings-field">
                <span className="field-label-row">
                  <span>代理 IP</span>
                  <HelpTip title="方案代理 IP 说明" label="查看方案代理 IP 说明">
                    “均衡分配”由 toSub2 按出口 IP 的账号数分配；在任务设置中启用“动态登录 + 按 PlanType 授权”后生效。
                  </HelpTip>
                </span>
                <select
                  value={sub2apiSettingsDraft.proxyId}
                  onChange={(event) => updateSub2ApiDraftProfile({ proxyId: event.target.value })}
                >
                  <option value="">使用账号原配置</option>
                  <option value="direct">直连（无代理）</option>
                  <option value="balanced">均衡分配（toSub2）</option>
                  {sub2apiProxies.map((proxy) => <option key={proxy.id} value={String(proxy.id)}>{formatSub2ApiProxy(proxy)}</option>)}
                </select>
              </label>
              <label className="settings-field">
                <span>Codex 指纹收敛</span>
                <select
                  value={sub2apiSettingsDraft.codexFingerprintMode}
                  onChange={(event) => updateSub2ApiDraftProfile({ codexFingerprintMode: event.target.value })}
                >
                  <option value="off">关闭（透传）</option>
                  <option value="device">仅设备</option>
                  <option value="session">设备+会话（推荐）</option>
                  <option value="full">完全收敛</option>
                </select>
              </label>
              <div className="settings-field wide-settings-field">
                <div className="field-label-row">
                  <span>自动使用重置卡</span>
                  <HelpTip title="自动使用重置卡说明" label="查看自动使用重置卡说明">
                    任一用量窗口达到所设百分比时，由 Sub2API 自动使用可用重置卡。范围 0.1–100%；关闭时保留阈值。保存后，开关与两个阈值一起同步至该方案绑定的账号。
                  </HelpTip>
                  <button type="button" role="switch" aria-label="自动使用重置卡"
                    className={`status-toggle sub2api-auto-reset-toggle ${sub2apiSettingsDraft.autoResetCreditEnabled ? "on" : ""}`}
                    aria-checked={sub2apiSettingsDraft.autoResetCreditEnabled}
                    onClick={() => updateSub2ApiDraftProfile({ autoResetCreditEnabled: !sub2apiSettingsDraft.autoResetCreditEnabled })}>
                    <span className="status-toggle-track"><span className="status-toggle-thumb" /></span>
                    <span>{sub2apiSettingsDraft.autoResetCreditEnabled ? "已开启" : "已关闭"}</span>
                  </button>
                </div>
                <div className="sub2api-reset-thresholds">
                  <label className="settings-field">
                    <span>5h 用量阈值（%）</span>
                    <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal"
                      disabled={!sub2apiSettingsDraft.autoResetCreditEnabled}
                      value={sub2apiSettingsDraft.autoResetCredit5hThresholdPercent}
                      onChange={(event) => updateSub2ApiDraftProfile({ autoResetCredit5hThresholdPercent: event.target.value })} />
                  </label>
                  <label className="settings-field">
                    <span>7d 用量阈值（%）</span>
                    <input type="number" min="0.1" max="100" step="0.1" inputMode="decimal"
                      disabled={!sub2apiSettingsDraft.autoResetCreditEnabled}
                      value={sub2apiSettingsDraft.autoResetCredit7dThresholdPercent}
                      onChange={(event) => updateSub2ApiDraftProfile({ autoResetCredit7dThresholdPercent: event.target.value })} />
                  </label>
                </div>
              </div>
              <label className="settings-field wide-settings-field">
                <span>WS mode</span>
                <select
                  value={sub2apiSettingsDraft.wsMode}
                  onChange={(event) => updateSub2ApiDraftProfile({ wsMode: event.target.value })}
                >
                  {SUB2API_WS_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <div className="sub2api-three-fields wide-settings-field">
                <label className="settings-field">
                  <span>并发数</span>
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    value={sub2apiSettingsDraft.concurrency}
                    onChange={(event) => updateSub2ApiDraftProfile({ concurrency: event.target.value })}
                    placeholder="留空用原值"
                  />
                </label>
                <label className="settings-field">
                  <span>负载因子</span>
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    value={sub2apiSettingsDraft.loadFactor}
                    onChange={(event) => updateSub2ApiDraftProfile({ loadFactor: event.target.value })}
                    placeholder="留空用原值"
                  />
                </label>
                <label className="settings-field">
                  <span>优先级</span>
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    value={sub2apiSettingsDraft.priority}
                    disabled={sub2apiSettingsDraft.importDatePriority.enabled}
                    onChange={(event) => updateSub2ApiDraftProfile({ priority: event.target.value })}
                    placeholder="留空用原值"
                  />
                </label>
              </div>
              <label className="settings-field wide-settings-field">
                <span className="field-label-row">
                  <span>账号命名模板</span>
                  <HelpTip title="账号命名模板说明" label="查看账号命名模板说明">
                    留空保留导入文件原名；支持 {'{email}'}、{'{planType}'}、{'{planType_disp}'}（映射值）、{'{accountId}'}、{'{name}'}。
                  </HelpTip>
                </span>
                <input
                  type="text"
                  maxLength="256"
                  value={sub2apiSettingsDraft.accountNameTemplate}
                  onChange={(event) => updateSub2ApiDraftProfile({ accountNameTemplate: event.target.value })}
                  placeholder="例如：chatgpt-{email}"
                  spellCheck="false"
                />
              </label>
              <label className="settings-field wide-settings-field">
                <span>允许使用的模型</span>
                <textarea
                  className="sub2api-model-textarea"
                  value={sub2apiSettingsDraft.modelWhitelist}
                  onChange={(event) => updateSub2ApiDraftProfile({ modelWhitelist: event.target.value })}
                  placeholder={"每行一个模型，也支持逗号分隔，例如：\ngpt-5\ngpt-5-mini\ngpt-4.1"}
                  rows="4"
                  spellCheck="false"
                />
              </label>
            </div>
            {features.sub2apiMonitor && sub2apiMonitorStatus.configured && (
              <div className={`sub2api-monitor-status ${sub2apiMonitorStatus.lastError ? "error" : ""}`}>
                <ShieldCheck size={15} />
                <span>{sub2apiMonitorStatus.lastError
                  ? `上次巡检失败：${sub2apiMonitorStatus.lastError}`
                  : sub2apiMonitorStatus.lastCheckAt
                    ? formatMonitorResult(sub2apiMonitorStatus.lastResult)
                    : "尚未执行号池巡检"}</span>
              </div>
            )}
            {sub2apiSettingsError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{sub2apiSettingsError}</div>}
            <div className="dialog-actions sub2api-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => loadSub2ApiOptions()} disabled={sub2apiGroupsLoading || !token}>
                {sub2apiGroupsLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}读取配置
              </button>
              {features.sub2apiMonitor && sub2apiMonitorStatus.enabled && (
                <button type="button" className="secondary-button" onClick={checkSub2ApiMonitorNow} disabled={sub2apiMonitorChecking || sub2apiMonitorStatus.running}>
                  {sub2apiMonitorChecking || sub2apiMonitorStatus.running ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setSub2apiSettingsOpen(false)} disabled={sub2apiSettingsSaving}>取消</button>
              <button type="submit" className="primary-button" disabled={sub2apiSettingsSaving}>
                {sub2apiSettingsSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存配置
              </button>
            </div>
          </form>
        </div>
      )}
      {taskSettingsOpen && taskSettings && (
        <TaskSettingsDialog
          token={token}
          settings={taskSettings}
          availablePlanTypes={availablePlanTypes}
          planTypeMapping={planTypeMapping}
          returnFocusRef={taskSettingsButtonRef}
          onClose={() => setTaskSettingsOpen(false)}
          onSaved={(settings) => {
            setTaskSettings(settings);
            setAccountProxyMode(["sub2api", "plan"].includes(settings.accountProxyMode) ? settings.accountProxyMode : "global");
            setProxySettingsDirty(false);
            setTaskSettingsOpen(false);
            setUploadNotice(`任务设置已保存，最多同时运行 ${settings.maxActiveJobs} 条任务`);
          }}
        />
      )}
      {planTypeMappingOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPlanTypeMappingOpen(false);
        }}>
          <form className="batch-dialog plan-type-mapping-dialog" onSubmit={savePlanTypeMapping} role="dialog" aria-modal="true" aria-labelledby="plan-type-mapping-title">
            <div className="dialog-header">
              <div>
                <h2 id="plan-type-mapping-title">PlanType 映射</h2>
                <span className="task-count-badge">{planTypeMappingDraft.length} 项</span>
                <HelpTip title="PlanType 映射说明" label="查看 PlanType 映射说明">
                  把 OAuth 原始参数转换为账号列表中的显示标签。保存后即时同步至服务端并生效。
                </HelpTip>
              </div>
              <button type="button" className="icon-button" onClick={() => setPlanTypeMappingOpen(false)} title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="mapping-info-banner">
              <span>将 OAuth 授权返回的原始计划标识转换为账号列表中直观统一的标签，修改后即时提供预览效果。</span>
            </div>

            <div className="plan-type-mapping-table-header" aria-hidden="true">
              <span className="header-col-raw">原始 PlanType 标识</span>
              <span className="header-col-arrow"></span>
              <span className="header-col-label">显示标签名称</span>
              <span className="header-col-preview">效果预览</span>
              <span className="header-col-action">操作</span>
            </div>

            <div className="plan-type-mapping-list">
              {planTypeMappingDraft.length === 0 ? (
                <div className="task-auto-empty">暂无映射项，可点击下方“添加映射项”或“恢复默认”</div>
              ) : (
                planTypeMappingDraft.map((row, index) => (
                  <div className="plan-type-mapping-row" key={`${row.raw || "new"}-${index}`}>
                    <div className="mapping-input-wrapper raw-wrapper">
                      <input
                        value={row.raw}
                        onChange={(event) => setPlanTypeMappingDraft((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, raw: event.target.value } : item))}
                        placeholder="例如：self_serve_business"
                        spellCheck="false"
                        aria-label={`第 ${index + 1} 行原始 PlanType`}
                      />
                    </div>
                    <span className="plan-type-mapping-arrow" aria-hidden="true">
                      <ArrowRight size={14} />
                    </span>
                    <div className="mapping-input-wrapper label-wrapper">
                      <input
                        value={row.label}
                        onChange={(event) => setPlanTypeMappingDraft((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))}
                        placeholder="例如：Business"
                        aria-label={`第 ${index + 1} 行显示标签`}
                      />
                    </div>
                    <div className="mapping-preview-cell">
                      <span className="plan-tag" title="列表渲染预览">
                        {row.label.trim() || row.raw.trim() || "未命名"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="icon-button danger mapping-delete-btn"
                      onClick={() => setPlanTypeMappingDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      title="删除此项映射"
                      aria-label={`删除第 ${index + 1} 行映射`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <button
              type="button"
              className="mapping-add-button"
              onClick={() => setPlanTypeMappingDraft((current) => [...current, { raw: "", label: "" }])}
            >
              <Plus size={15} />
              <span>添加映射项</span>
            </button>

            {planTypeMappingError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{planTypeMappingError}</div>}

            <div className="dialog-footer">
              <button type="button" className="selection-text-button" onClick={resetPlanTypeMapping} title="重置为默认官方方案映射">
                <RotateCcw size={13} />
                恢复默认
              </button>
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={() => setPlanTypeMappingOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={planTypeMappingSaving || !token}>
                {planTypeMappingSaving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                {planTypeMappingSaving ? "保存中…" : "保存映射"}
              </button>
            </div>
          </form>
        </div>
      )}
      {filterOpen && (
        <AccessibleDialog className="email-filter-dialog" labelledBy="email-filter-title" onClose={() => setFilterOpen(false)}>
          <form onSubmit={applyEmailFilter}>
            <div className="dialog-header">
              <h2 id="email-filter-title">邮箱列表筛选</h2>
              <button type="button" className="icon-button" aria-label="关闭邮箱列表筛选" onClick={() => setFilterOpen(false)}><X size={18} /></button>
            </div>
            <label className="batch-label" htmlFor="email-filter-input">每行一个邮箱（最多 500 个）</label>
            <textarea id="email-filter-input" value={filterText} onChange={(event) => setFilterText(event.target.value)}
              autoFocus spellCheck="false" placeholder={"a@example.com\nb@example.com"} />
            {filterError && <div className="dialog-error" role="alert">{filterError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setFilterOpen(false)}>取消</button>
              <button type="submit" className="primary-button" disabled={!filterText.trim()}>应用邮箱筛选</button>
            </div>
          </form>
        </AccessibleDialog>
      )}
      {batchOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !batchBusy) setBatchOpen(false);
        }}>
          <form className="batch-dialog" onSubmit={createBatch} role="dialog" aria-modal="true" aria-labelledby="batch-title">
            <div className="dialog-header">
              <div>
                <h2 id="batch-title">批量添加账号</h2>
                <span className="task-count-badge">{countBatchLines(batchText)}</span>
                <HelpTip title="批量导入格式说明" label="查看批量导入格式说明">
                  <div>
                    {mailRequestSettings.method === "POST"
                      ? "每行：邮箱----编码请求体，或 邮箱----密码----编码请求体；邮箱及可识别字段顺序不限。"
                      : "每行一个账号：账号----密码----2FA(备注)，括号内默认为备注；原有格式仍可使用。"}
                  </div>
                  <div>超出并发上限后自动排队执行。</div>
                </HelpTip>
              </div>
              <button type="button" className="icon-button" onClick={() => setBatchOpen(false)} disabled={batchBusy} title="关闭">
                <X size={18} />
              </button>
            </div>
            <label className="batch-label" htmlFor="batch-input">账号列表</label>
            <textarea
              id="batch-input"
              value={batchText}
              onChange={(event) => setBatchText(event.target.value)}
              placeholder={mailRequestSettings.method === "POST"
                ? "a@example.com----eyJtYWlsYm94X2lkIjoiaWQtYSJ9\nb@example.com----账号密码----mailbox_id%3Did-b"
                : "name@example.com----账号密码----JBSWY3DPEHPK3PXP(首批账号)\nname2@icloud.com----https://mail.example/messages/name2\nBASE32二步验证密钥::name3@example.dev::账号密码"}
              spellCheck="false"
              autoFocus
            />
            {batchError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{batchError}</div>}
            <div className="dialog-footer">
              <button type="button" className="cancel-button" onClick={() => setBatchOpen(false)} disabled={batchBusy}>取消</button>
              <button type="submit" className="primary-button" disabled={!batchText.trim() || batchBusy || countBatchLines(batchText) > 500}>
                {batchBusy ? <LoaderCircle className="spin" size={17} /> : <ListPlus size={17} />}
                创建 {countBatchLines(batchText) || ""} 条任务
              </button>
            </div>
          </form>
        </div>
      )}
      </main>
    </div>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="15">
        <div className="empty-state">
          <div className="empty-state-icon"><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "没有符合当前搜索或筛选条件的账号，请调整条件或清除筛选。" : "点击右上方“批量添加”导入一个或多个账号。"}</p>
        </div>
      </td>
    </tr>
  );
}

function OperationDetailText({ text, className, onOpen }) {
  const value = String(text ?? "");
  if (!value) return null;
  function open() {
    onOpen?.({ title: "当前操作详情", text: value });
  }
  return (
    <div
      className={`${className} operation-detail-trigger`}
      role="button"
      tabIndex="0"
      title="点击查看详细内容"
      aria-label="查看当前操作详细内容"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      {value}
    </div>
  );
}

function RemarkDialog({ token, job, onClose, onSaved }) {
  const [remark, setRemark] = useState(job.remark || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => previousFocus?.focus();
  }, []);
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/remark`, { method: "POST", body: JSON.stringify({ remark }) });
      onSaved(data);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <form className="batch-dialog remark-dialog" role="dialog" aria-modal="true" aria-labelledby="remark-title" onSubmit={save} onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) onClose();
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)")];
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="dialog-header">
          <div>
            <div className="section-title-row">
              <h2 id="remark-title">账号备注</h2>
              <HelpTip label="账号备注同步说明">
                与号池备注双向同步：保存会更新同邮箱账号的完整备注，清空也会同步。号池修改会在下一次同步时回显，编辑中的内容会保留。
              </HelpTip>
            </div>
            <span>{job.email}</span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭备注"><X size={18} /></button>
        </div>
        <label className="batch-label" htmlFor="account-remark">备注内容</label>
        <textarea id="account-remark" className="remark-input" value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={2000} disabled={saving} autoFocus placeholder="例如：首批账号、到期时间、用途" />
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-footer">
          <button type="button" className="cancel-button" onClick={onClose} disabled={saving}>取消</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存备注</button>
        </div>
      </form>
    </div>
  );
}

function OperationDetailDialog({ detail, onClose }) {
  return (
    <div className="modal-backdrop operation-detail-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="batch-dialog operation-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="operation-detail-title">
        <div className="dialog-header">
          <div>
            <h2 id="operation-detail-title">{detail.title || "当前操作详情"}</h2>
            {detail.email && <span>{detail.email}</span>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭" aria-label="关闭详情">
            <X size={18} />
          </button>
        </div>
        <pre className="operation-detail-content">{detail.text}</pre>
        <div className="dialog-actions">
          <span className="dialog-actions-spacer" />
          <button type="button" className="cancel-button" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

function BulkMoreMenu({
  features,
  batchAction,
  selectedCount,
  canForceReloginSelected,
  forceReloginSelected,
  canSwitchProxySelected,
  proxySwitchSelection,
  runSelectedPoolAction,
  canCooldownSelected,
  taskSettings,
  canLogoutSelected,
  logoutAllDevices,
  selectedJobs,
  canSetupTotpSelected,
  setupTotpSelected,
  canAddPasswordSelected,
  addPasswordSelected,
  exportSelectedSource,
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const moreActionBusy = [
    "relogin", "cooldown", "switch-proxy", "logout-all",
    "setup-2fa", "add-password", "source",
  ].includes(batchAction);

  const hasSessionItems = Boolean(features.forceRelogin || features.accountSessions);
  const hasSecurityItems = Boolean(features.totpSetup || features.passwordAdd || features.sourceExport);

  if (!hasSessionItems && !hasSecurityItems) return null;

  return (
    <div className="bulk-more-menu-wrapper" ref={menuRef}>
      <button
        type="button"
        className={`secondary-button bulk-button bulk-more-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        title="展开更多批量操作"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {moreActionBusy ? (
          <LoaderCircle className="spin" size={14} />
        ) : (
          <MoreHorizontal size={14} />
        )}
        <span>更多</span>
        <ChevronDown size={12} className={`bulk-more-arrow ${open ? "open" : ""}`} />
      </button>

      {open && (
        <div className="bulk-dropdown-menu" role="menu">
          {hasSessionItems && (
            <div className="bulk-dropdown-section">
              <div className="bulk-dropdown-label">会话与网络</div>
              {features.forceRelogin && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canForceReloginSelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); forceReloginSelected(); }}
                  title="重新执行完整登录流程并申请新授权"
                >
                  {batchAction === "relogin" ? <LoaderCircle className="spin" size={14} /> : <LogIn size={14} />}
                  <span>重登并授权</span>
                </button>
              )}
              {features.accountSessions && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canSwitchProxySelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); runSelectedPoolAction("switch-proxy"); }}
                  title={canSwitchProxySelected ? `${proxySwitchSelection.reason}；按当前方案换绑代理 IP，登出并重新授权` : proxySwitchSelection.reason}
                >
                  {batchAction === "switch-proxy" ? <LoaderCircle className="spin" size={14} /> : <Shuffle size={14} />}
                  <span>换绑代理 IP</span>
                </button>
              )}
              {features.accountSessions && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canCooldownSelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); runSelectedPoolAction("cooldown"); }}
                  title={taskSettings?.accountProxyCooldownMinutes ? `冷却 ${taskSettings.accountProxyCooldownMinutes} 分钟后重新授权并同步号池` : "冷却后重新授权并同步号池"}
                >
                  {batchAction === "cooldown" ? <LoaderCircle className="spin" size={14} /> : <LogOut size={14} />}
                  <span>一键冷却</span>
                </button>
              )}
              {features.accountSessions && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canLogoutSelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); logoutAllDevices(selectedJobs, true); }}
                  title="登出所选账号在 OpenAI 的所有已登录设备与会话"
                >
                  {batchAction === "logout-all" ? <LoaderCircle className="spin" size={14} /> : <LogOut size={14} />}
                  <span>登出所有设备</span>
                </button>
              )}
            </div>
          )}

          {hasSecurityItems && (
            <div className="bulk-dropdown-section">
              <div className="bulk-dropdown-label">凭据与安全</div>
              {features.totpSetup && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canSetupTotpSelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); setupTotpSelected(); }}
                  title="批量为所选账号配置 TOTP 双重验证"
                >
                  {batchAction === "setup-2fa" ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}
                  <span>设置 2FA</span>
                </button>
              )}
              {features.passwordAdd && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!canAddPasswordSelected || Boolean(batchAction)}
                  onClick={() => { setOpen(false); addPasswordSelected(); }}
                  title="批量为无密码的邮箱验证码账号绑定新密码"
                >
                  {batchAction === "add-password" ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}
                  <span>添加密码</span>
                </button>
              )}
              {features.sourceExport && (
                <button
                  type="button"
                  className="bulk-dropdown-item"
                  role="menuitem"
                  disabled={!selectedCount || Boolean(batchAction)}
                  onClick={() => { setOpen(false); exportSelectedSource(); }}
                  title="导出所选账号的原始导入信息"
                >
                  {batchAction === "source" ? <LoaderCircle className="spin" size={14} /> : <FileText size={14} />}
                  <span>导出原始凭据</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JobRow({ job, token, workflowBusy = false, expanded, onToggleLogs, onError, selected, onToggleSelected, onDelete, deleteAvailable, deleteDisabled, deleteBusy, selectionSupported, smsProviderAvailable, smsProvider, onUpload, sub2apiUploadAvailable, sub2apiToggleAvailable, sub2apiToggleBusy, onToggleSub2Api, sub2apiPriorityAvailable, sub2apiPriorityBusy, onUpdateSub2ApiPriority, totpSetupAvailable, passwordAddAvailable, forceReloginAvailable, webLoginAvailable, accountProxyUrl, planTypeMapping, accountUsage, accountUsageAvailable, onRefreshUsage, credentialsAvailable, onOpenCredentials, remarksAvailable, onOpenRemark, sessionsAvailable, onOpenSessions, onLogoutAllSessions, logoutAllBusy, workspacesAvailable, onOpenWorkspaces, onOpenOperationDetail }) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [priorityValue, setPriorityValue] = useState(() => job.sub2apiPriority === null || job.sub2apiPriority === undefined ? "" : String(job.sub2apiPriority));
  const [accountNameCopied, setAccountNameCopied] = useState(false);
  const rowBusy = submitting || workflowBusy;

  useEffect(() => setValue(""), [job.status]);
  useEffect(() => {
    setPriorityValue(job.sub2apiPriority === null || job.sub2apiPriority === undefined ? "" : String(job.sub2apiPriority));
  }, [job.sub2apiPriority]);

  function savePriority() {
    if (!sub2apiPriorityAvailable || job.sub2apiInPool !== true || sub2apiPriorityBusy) return;
    onUpdateSub2ApiPriority(priorityValue.trim());
  }

  async function sendInput(action, submittedValue = value) {
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/input`, {
        method: "POST",
        body: JSON.stringify({ action, value: submittedValue }),
      });
      setValue("");
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function retry() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function regenerate() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function forceRelogin() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/relogin`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function loginWeb() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/web-login`, { method: "POST", body: JSON.stringify({}) });
      onError("");
    } catch (requestError) { onError(requestError.message); }
    finally { setSubmitting(false); }
  }

  async function setupTotp() {
    if (workflowBusy || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/setup-2fa`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function addPassword() {
    if (workflowBusy || submitting) return;
    if (!window.confirm("确定为该账号生成并添加随机强密码吗？成功后会自动更新账号原始信息。")) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/add-password`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyTotpSecret() {
    try {
      await navigator.clipboard.writeText(job.totpSetupSecret || "");
      onError("");
    } catch {
      onError("无法自动复制，请手动选择 2FA 密钥");
    }
  }

  async function copyAccountName() {
    try {
      await copyText(job.email || "");
      setAccountNameCopied(true);
      window.setTimeout(() => setAccountNameCopied(false), 1_600);
    } catch {
      onError("无法自动复制账号名，请手动选择账号名");
    }
  }

  async function requestSmsNumber() {
    if (!smsProvider.ready) return;
    setSubmitting(true);
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sms-number`, {
        method: "POST",
        body: JSON.stringify({ providerId: smsProvider.id, config: smsProvider.config }),
      });
      onError("");
    } catch (requestError) {
      onError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function download() {
    try {
      const response = await fetch(`/api/jobs/${job.id}/download`, {
        headers: { "x-console-token": token },
      });
      if (!response.ok) throw new Error((await response.json()).error || "下载失败");
      await saveDownloadResponse(response, `${job.email}-sub2api-import-oauth-${localTimestamp()}.json`);
    } catch (requestError) {
      onError(requestError.message);
    }
  }

  const inputConfig = getInputConfig(job.status, job.currentPhone);
  const terminal = ["completed", "failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(job.status);

  return (
    <tr className={`job-row status-${job.status}`}>
      <td className="select-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          disabled={!selectionSupported}
          aria-label={`选择 ${job.email}`}
        />
      </td>
      <td className="account-column">
        <div className="account-cell">
          <div className="account-details">
            <div className="account-title-line">
              <button type="button" className={`account-name-copy ${accountNameCopied ? "copied" : ""}`} onClick={copyAccountName} title={accountNameCopied ? "已复制" : "点击复制账号名"} aria-label={`复制账号名 ${job.email}`}>
                <strong>{job.email}</strong>
                {accountNameCopied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              </button>
              <span className="account-id">{shortId(job.id)}</span>
            </div>
            <div className="account-meta">
              <div className="account-meta-line">
                <LoginMethodBadge job={job} />
                {job.webSessionStatus && job.webSessionStatus !== "absent" && (
                  <span className={`web-session-state ${job.webSessionStatus === "banned" ? "expired" : job.webSessionStatus}`} title={job.webSessionStatus === "banned" ? extractResponseMessage(job.autoRepairBlockedReason || "账号已确认封禁，已停止 Web 重登") : job.webSessionVerifiedAt ? `最近验证：${formatDateTime(job.webSessionVerifiedAt)}` : "读取工作区或设备后验证"}>
                    {job.webSessionStatus === "banned" ? <Ban size={11} aria-hidden="true" /> : <Globe2 size={11} aria-hidden="true" />}
                    {job.webSessionStatus === "banned" ? "账号封禁" : job.webSessionStatus === "valid" ? "Web已验" : job.webSessionStatus === "expired" ? "Web失效" : "Web待验"}
                  </span>
                )}
              </div>
              {remarksAvailable && (
                <div className="account-meta-line">
                  <button type="button" className={`account-remark-button ${job.remark ? "has-remark" : ""}`} onClick={onOpenRemark} title={job.remark || "添加备注"} aria-label={`编辑 ${job.email} 的备注`}>
                    <FileText size={11} aria-hidden="true" />
                    <span>{job.remark || "备注"}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className={`plan-cell ${job.planType ? "" : "unknown"}`} title={job.planType || "未知"}>
        <span className="plan-tag">{formatPlanTypeLabel(job.planType, planTypeMapping)}</span>
        {job.sub2apiInPool === true && job.sub2apiPlanType && job.planType
          && job.sub2apiPlanType !== job.planType && (
          <span
            className="plan-sync-note"
            title={`本地工作空间：${job.planType}；Sub2API 号池：${job.sub2apiPlanType}`}
            aria-label={`Sub2API 号池中的 PlanType 为 ${formatPlanTypeLabel(job.sub2apiPlanType, planTypeMapping)}`}
          >
            号池：{formatPlanTypeLabel(job.sub2apiPlanType, planTypeMapping)}
          </span>
        )}
      </td>
      <td className="usage-cell-column">
        <AccountUsageCell usage={accountUsage} available={job.canDownload} enabled={accountUsageAvailable} onRefresh={onRefreshUsage} />
      </td>
      <td className="pool-status-cell">
        <Sub2ApiPoolBadge inPool={job.sub2apiInPool} remoteStatus={job.sub2apiRemoteStatus} />
      </td>
      <td className="pool-enabled-cell">
        <Sub2ApiEnabledToggle
          inPool={job.sub2apiInPool}
          enabled={job.sub2apiEnabled}
          available={sub2apiToggleAvailable}
          busy={sub2apiToggleBusy}
          onChange={onToggleSub2Api}
        />
      </td>
      <td
        className={`sub2api-priority-cell ${job.sub2apiInPool !== true ? "unknown" : ""}`}
        title={job.sub2apiInPool !== true ? "尚未同步 Sub2API 优先级" : "编辑并保存 Sub2API 优先级"}
      >
        {job.sub2apiInPool === true ? (
          <div className="sub2api-priority-editor">
            <input
              type="number"
              min="0"
              max="10000"
              step="1"
              inputMode="numeric"
              value={priorityValue}
              onChange={(event) => setPriorityValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  savePriority();
                }
              }}
              disabled={!sub2apiPriorityAvailable || sub2apiPriorityBusy}
              aria-label={`编辑 ${job.email} 的 Sub2API 优先级`}
            />
            <button
              type="button"
              className="icon-button priority-save-button"
              onClick={savePriority}
              disabled={!sub2apiPriorityAvailable || sub2apiPriorityBusy}
              title="保存 Sub2API 优先级"
              aria-label="保存 Sub2API 优先级"
            >
              {sub2apiPriorityBusy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            </button>
          </div>
        ) : "—"}
      </td>
      <td><StatusBadge status={job.status} webSessionStatus={job.webSessionStatus} /></td>
      <td className="step-cell">
        {job.assignedProxyId && <span className="prompt-line">绑定代理 #{job.assignedProxyId}</span>}
        {job.poolRefreshAction && <OperationDetailText
          text={job.poolRefreshError
            ? `号池凭据待更新：${job.poolRefreshError}${job.poolRefreshReady ? "；稍后自动重试同步" : "；请重试登录授权"}`
            : job.poolRefreshDueAt
              ? `冷却中，将于 ${new Date(job.poolRefreshDueAt).toLocaleString()} 重新登录并更新号池凭据`
              : job.poolRefreshReady ? "正在更新号池凭据" : "正在重新登录授权，完成后更新号池凭据"}
          className="prompt-line" onOpen={onOpenOperationDetail} />}
        {job.prompt && <OperationDetailText text={job.prompt} className="prompt-line" onOpen={onOpenOperationDetail} />}
        {job.webSessionRepairRetryAt && <OperationDetailText text={`Web 自动重登冷却中，最早于 ${formatDateTime(job.webSessionRepairRetryAt)} 重试；到期后由巡检调度。可手动登录 Web 立即重试。`} className="prompt-line" onOpen={onOpenOperationDetail} />}
        {job.status === "canceled" && job.webSessionStatus === "valid" && (
          <OperationDetailText text="上次 Codex 授权已取消；Web 会话已验证，Web 登录不会改变授权任务结果。" className="prompt-line" onOpen={onOpenOperationDetail} />
        )}
        {job.lastError && <OperationDetailText text={extractResponseMessage(job.lastError)} className="row-error" onOpen={onOpenOperationDetail} />}
        {job.autoRepairBlocked && (
          <OperationDetailText text={`号池监控已永久跳过：${extractResponseMessage(job.autoRepairBlockedReason || "账号已不可用")}`} className="row-error" onOpen={onOpenOperationDetail} />
        )}
        {job.banProxyReleasePending && <OperationDetailText text={job.banProxyReleaseError ? `封禁账号 IP 解绑待重试：${job.banProxyReleaseError}` : "封禁账号 IP 正在解绑"} className="row-error" onOpen={onOpenOperationDetail} />}
        {job.totpSetupError && <OperationDetailText text={`2FA：${extractResponseMessage(job.totpSetupError)}`} className="row-error" onOpen={onOpenOperationDetail} />}
        {job.passwordAddError && <OperationDetailText text={`添加密码：${extractResponseMessage(job.passwordAddError)}`} className="row-error" onOpen={onOpenOperationDetail} />}
        {job.mailApiError && job.status === "email_otp" && <OperationDetailText text={job.mailApiError} className="mail-error" onOpen={onOpenOperationDetail} />}
        {job.currentPhone && ["working", "phone", "phone_otp"].includes(job.status) && (
          <div className="phone-target"><Smartphone size={13} />当前手机号：<strong>{job.currentPhone}</strong></div>
        )}
        {job.phoneError && <div className="phone-error"><CircleAlert size={13} />{job.phoneError}</div>}
        {job.smsStatus && !["idle", "unavailable"].includes(job.smsStatus) && (
          <div className={`sms-status ${job.smsStatus === "error" ? "error" : ""}`}>
            {job.smsStatus === "error" ? <CircleAlert size={13} /> : <PhoneIncoming size={13} />}
            <span>{smsStatusText(job)}</span>
          </div>
        )}
        {job.status === "totp_setup_otp" && job.totpSetupSecret && (
          <div className="totp-setup-secret">
            <span>2FA 密钥</span>
            <code>{job.totpSetupSecret}</code>
            <button type="button" className="icon-button" onClick={copyTotpSecret} title="复制 2FA 密钥">
              <Copy size={15} />
            </button>
          </div>
        )}
        {inputConfig && (
          <div className="inline-entry">
            <div className="compact-input">
              {inputConfig.icon}
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && value && !submitting) sendInput(inputConfig.action);
                }}
                inputMode={inputConfig.inputMode}
                type={inputConfig.type || "text"}
                placeholder={inputConfig.placeholder}
                aria-label={inputConfig.placeholder}
                autoComplete={inputConfig.autoComplete || "one-time-code"}
              />
            </div>
            <button
              type="button"
              className="icon-button submit"
              onClick={() => sendInput(inputConfig.action)}
              disabled={!value || submitting}
              title={inputConfig.submitLabel}
            >
              {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
            </button>
            {job.status === "email_otp" && (
              <button type="button" className="text-action" onClick={() => sendInput("resend_email", "")} disabled={submitting}>
                <RefreshCw size={14} />重发
              </button>
            )}
            {job.status === "phone_otp" && (
              <>
                <button type="button" className="text-action" onClick={() => sendInput("resend_phone", "")} disabled={submitting}>
                  <RefreshCw size={14} />重发
                </button>
                <button type="button" className="text-action" onClick={() => sendInput("change_phone", "")} disabled={submitting}>
                  <RotateCcw size={14} />换号
                </button>
              </>
            )}
            {job.status === "phone" && smsProviderAvailable && (
              <>
                <span className="input-separator" aria-hidden="true" />
                <button
                  type="button"
                  className="platform-number-button"
                  onClick={requestSmsNumber}
                  disabled={!smsProvider.ready || submitting || job.smsStatus === "requesting"}
                  title={smsProvider.ready ? `使用 ${smsProvider.name} 取号` : "请先完成接码平台配置"}
                >
                  {submitting || job.smsStatus === "requesting" ? <LoaderCircle className="spin" size={15} /> : <PhoneIncoming size={15} />}
                  {smsProvider.name || "平台"}取号
                </button>
              </>
            )}
          </div>
        )}
      </td>
      <td className="time-cell">
        <div className="time-stack" title={formatDateTime(job.createdAt)}>
          <span className="time-date">{formatTimeParts(job.createdAt).date}</span>
          <span className="time-clock">{formatTimeParts(job.createdAt).time}</span>
        </div>
      </td>
      <td className="operation-time-cell">
        <div className="time-stack" title={formatDateTime(job.lastOperationAt || job.createdAt)}>
          <span className="time-date">{formatTimeParts(job.lastOperationAt || job.createdAt).date}</span>
          <span className="time-clock">{formatTimeParts(job.lastOperationAt || job.createdAt).time}</span>
          <span className="operation-type-badge">{operationLabel(job.lastOperationType)}</span>
        </div>
      </td>
      <BoundProxyCell job={job} />
      <td className="overload-cell"><OverloadDetection job={job} token={token} onError={onError} /></td>
      <td className="fingerprint-cell"><ModelFingerprintCell job={job} token={token} onError={onError} /></td>
      <td className="actions-cell">
        <div className="row-actions">
          {/* Row 1: 管理与数据 (7 buttons) */}
          <button
            type="button"
            className="icon-button"
            onClick={onOpenCredentials}
            disabled={!credentialsAvailable || rowBusy}
            title={credentialsAvailable ? "查看或修改账号凭据" : "暂无凭据管理权限"}
            aria-label="查看或修改账号凭据"
          >
            <KeyRound size={13} />
          </button>
          <button
            type="button"
            className="secondary-button icon-only-action"
            onClick={loginWeb}
            disabled={!webLoginAvailable || rowBusy || !job.canLoginWeb}
            title={job.autoRepairBlocked ? "账号已确认封禁，已停止 Web 重登；如需确认解封，请使用重新登录并授权" : job.webLoginError || (job.canLoginWeb ? `${WEB_STATES[job.webSessionStatus || "absent"]}：登录 Web` : "当前状态不可登录 Web")}
            aria-label="登录 Web"
          >
            {submitting ? <LoaderCircle className="spin" size={13} /> : <Globe2 size={13} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSessions}
            disabled={!sessionsAvailable || rowBusy || (!job.canDownload && !job.webSessionAvailable && !isBlockedAccount(job))}
            title={isBlockedAccount(job) ? "账号已封禁，查看封禁原因" : job.canDownload || job.webSessionAvailable ? "查看已登录设备和会话" : "暂无可读取的已登录会话"}
            aria-label="查看已登录设备和会话"
          >
            <MonitorSmartphone size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenWorkspaces}
            disabled={!workspacesAvailable || rowBusy || (!job.canDownload && !job.webSessionAvailable && !isBlockedAccount(job))}
            title={isBlockedAccount(job) ? "账号已封禁，查看封禁原因" : job.canDownload || job.webSessionAvailable ? "查看并切换工作空间" : "暂无可切换的工作空间"}
            aria-label="查看并切换工作空间"
          >
            <BriefcaseBusiness size={13} />
          </button>
          <button
            type="button"
            className="download-button icon-only-action"
            onClick={download}
            disabled={rowBusy || !job.canDownload}
            title={job.canDownload ? "下载导入文件" : "尚未完成授权，暂无导入文件可下载"}
            aria-label="下载导入文件"
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="secondary-button icon-only-action"
            onClick={onUpload}
            disabled={rowBusy || !job.canDownload || !sub2apiUploadAvailable}
            title={!sub2apiUploadAvailable ? "尚未配置 Sub2API 后端地址" : job.canDownload ? "上传到已配置的 Sub2API 号池" : "尚未完成授权，暂不能上传号池"}
            aria-label="上传到已配置的 Sub2API 号池"
          >
            <Send size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onToggleLogs}
            title="查看协议日志"
            aria-label="查看协议日志"
          >
            <FileText size={13} />
          </button>

          {/* Row 2: 授权、重试与安全 (7 buttons) */}
          <button
            type="button"
            className="regenerate-button icon-only-action"
            onClick={regenerate}
            disabled={rowBusy || !job.canRegenerate}
            title={job.canRegenerate ? "重新授权：优先使用刷新令牌，失效后自动重新登录" : "当前状态不可重新授权"}
            aria-label="重新授权"
          >
            {submitting ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          </button>
          <button
            type="button"
            className="relogin-button icon-only-action"
            onClick={forceRelogin}
            disabled={rowBusy || !forceReloginAvailable || !job.canForceRelogin}
            title={job.canForceRelogin ? "跳过刷新令牌和旧检查点，完整重新登录后自动授权" : "当前不可执行重新登录"}
            aria-label="重新登录并授权"
          >
            {submitting ? <LoaderCircle className="spin" size={13} /> : <LogIn size={13} />}
          </button>
          {!terminal ? (
            <button
              type="button"
              className="icon-button danger"
              onClick={cancel}
              disabled={rowBusy}
              title="取消任务"
              aria-label="取消任务"
            >
              <Ban size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="retry-button icon-only-action"
              onClick={retry}
              disabled={rowBusy || !job.canRetry}
              title={job.canRetry ? (job.securityCheckRequired ? "手动重试" : job.canResume ? "继续流程" : "重新授权") : "当前无需重试"}
              aria-label={job.securityCheckRequired ? "手动重试" : job.canResume ? "继续流程" : "重试"}
            >
              {submitting ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={setupTotp}
            disabled={rowBusy || !totpSetupAvailable || !job.canSetupTotp}
            title={job.hasTotpKey ? "已设置 2FA（可在凭据管理中查看或更换）" : job.canSetupTotp ? "设置 2FA" : "当前不可设置 2FA"}
            aria-label="设置 2FA"
          >
            {submitting ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={addPassword}
            disabled={rowBusy || !passwordAddAvailable || !job.canAddPassword}
            title={job.hasPassword ? "已设置密码（可在凭据管理中查看或修改）" : job.canAddPassword ? "添加密码" : "当前不可添加密码"}
            aria-label="添加密码"
          >
            {submitting ? <LoaderCircle className="spin" size={13} /> : <Lock size={13} />}
          </button>
          <button
            type="button"
            className="icon-button danger"
            onClick={onLogoutAllSessions}
            disabled={rowBusy || deleteDisabled || !job.canLogoutAllSessions || !sessionsAvailable}
            title={job.canLogoutAllSessions ? "登出所有设备和会话（包括当前会话）" : "账号正在运行或没有已保存的授权，暂不能登出所有设备"}
            aria-label="登出所有设备"
          >
            {logoutAllBusy ? <LoaderCircle className="spin" size={13} /> : <LogOut size={13} />}
          </button>
          <button
            type="button"
            className="icon-button danger"
            onClick={onDelete}
            disabled={rowBusy || deleteDisabled || !deleteAvailable}
            title="删除账号"
            aria-label="删除账号"
          >
            {deleteBusy ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
          </button>
        </div>
      </td>
    </tr>
  );
}

function TaskSettingsDialog({ token, settings, availablePlanTypes, planTypeMapping, returnFocusRef, onClose, onSaved }) {
  const dialogRef = useRef(null);
  const [limit, setLimit] = useState(() => String(settings.maxActiveJobs));
  const [cooldownMinutes, setCooldownMinutes] = useState(() => String(settings.accountProxyCooldownMinutes || 60));
  const [overloadRule, setOverloadRule] = useState(() => ({ windowMinutes: String(settings.overloadAutoCooldown?.windowMinutes || 15), threshold: String(settings.overloadAutoCooldown?.threshold || 10), cooldownMinutes: String(settings.overloadAutoCooldown?.cooldownMinutes || 60) }));
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
    dialog.showModal();
    dialog.querySelector("input").focus();
    return () => {
      dialog.close();
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const value = Number(limit);
    if (!Number.isInteger(value) || value < settings.min || value > settings.max) {
      setError(`同时运行任务数必须是 ${settings.min} 到 ${settings.max} 的整数`);
      return;
    }
    const cooldownValue = Number(cooldownMinutes);
    if (!Number.isInteger(cooldownValue) || cooldownValue < 1 || cooldownValue > 43_200) {
      setError("冷却时长必须是 1 到 43200 分钟的整数");
      return;
    }
    const overloadAutoCooldown = Object.fromEntries(Object.entries(overloadRule).map(([key, value]) => [key, Number(value)]));
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
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(token, "/api/task-settings", {
        method: "POST",
        body: JSON.stringify({ maxActiveJobs: value, autoActions, accountProxyCooldownMinutes: Number(cooldownMinutes), accountProxyMode, codexAuthMode, overloadAutoCooldown, webSessionMonitor }),
      });
      onSaved(data.settings);
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
      aria-labelledby="task-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form onSubmit={save} className="task-settings-form" noValidate>
        <div className="dialog-header">
          <div className="section-title-row">
            <h2 id="task-settings-title">任务设置</h2>
            <HelpTip label="任务设置说明">
              任务设置保存到服务端，所有浏览器共用。服务重启后保留此设置。
            </HelpTip>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={saving} aria-label="关闭任务设置"><X size={18} /></button>
        </div>
        <div className="task-two-fields">
          <label className="settings-field task-limit-field" htmlFor="task-limit">
            <span className="field-label-row">
              同时运行任务数
              <HelpTip label="同时运行任务数说明">
                可设置 {settings.min}–{settings.max} 条，默认 {settings.default} 条。超过上限的任务自动排队，并发越高服务器和代理负载越大。调高后立即启动排队任务；调低后等待当前任务完成再按新上限调度。
              </HelpTip>
            </span>
            <div>
              <input id="task-limit" type="number" min={settings.min} max={settings.max} step="1" required autoFocus
                value={limit} onChange={(event) => setLimit(event.target.value)} disabled={saving}
                aria-invalid={Boolean(error)} />
              <span>条</span>
            </div>
          </label>
          <label className="settings-field task-cooldown-field" htmlFor="task-cooldown-minutes">
            <span className="field-label-row">
              一键冷却时长
              <HelpTip label="一键冷却时长说明">
                批量工具栏中点击“一键冷却”时，暂停号池分配的默认时长（1–43200 分钟）。
              </HelpTip>
            </span>
            <div>
              <input id="task-cooldown-minutes" type="number" min="1" max="43200" step="1" required
                value={cooldownMinutes} onChange={(event) => setCooldownMinutes(event.target.value)} disabled={saving} />
              <span>分钟</span>
            </div>
          </label>
        </div>
        <div className="task-two-fields">
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
            <select id="task-proxy-mode" value={accountProxyMode} onChange={(event) => setAccountProxyMode(event.target.value)} disabled={saving}>
              <option value="global">全局代理</option>
              <option value="sub2api">Sub2API 均衡分配（登录前绑定）</option>
              <option value="plan">动态登录 + 按 PlanType 授权</option>
            </select>
          </label>
          <label className="settings-field task-auth-mode-field" htmlFor="task-codex-auth-mode">
            <span className="field-label-row">
              Codex 授权方式
              <HelpTip label="Codex 授权方式说明">
                {codexAuthMode === "sub2api"
                  ? "使用已保存的 Sub2API 后端和管理员 Key，由号池生成授权链接、兑换和刷新令牌；toSub2 完成登录并保存凭据。需要先配置 Sub2API。"
                  : "由 toSub2 生成授权链接并直接兑换、刷新令牌，沿用当前授权流程。"}
              </HelpTip>
            </span>
            <select id="task-codex-auth-mode" value={codexAuthMode} onChange={(event) => setCodexAuthMode(event.target.value)} disabled={saving}>
              <option value="local">本地授权（toSub2 生成链接和凭据）</option>
              <option value="sub2api">Sub2API 授权（号池生成链接和凭据）</option>
            </select>
          </label>
        </div>
        <section className="task-auto-settings" aria-labelledby="web-session-monitor-title">
          <div className="section-title-row">
            <h3 id="web-session-monitor-title">WebSession 定时巡检</h3>
            <HelpTip label="WebSession 定时巡检说明">由服务端执行，关闭页面后仍运行。使用原设备身份和账号代理检查会话、设备与空间；确认会话失效或空间/PlanType 变化后，通过共享登录队列重新登录授权，并应用新方案、同步号池。网络、403 或上游故障只记录失败，不当作掉线。仅检查已有 Web 登录态的账号；主动登出后不自动补登。</HelpTip>
          </div>
          <label className="task-auto-action-option"><input type="checkbox" checked={webMonitor.enabled} disabled={saving} onChange={e => setWebMonitor(v => ({ ...v, enabled: e.target.checked }))} /><span>启用 WebSession 定时检测</span></label>
          <label className="task-auto-action-option"><input type="checkbox" checked={webMonitor.autoRelogin} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, autoRelogin: e.target.checked }))} /><span>确认失效或空间变化后自动重登并授权</span></label>
          <div className="overload-rule-fields">
            <label className="settings-field" htmlFor="web-session-check-interval"><span>检测间隔（分钟）</span><input id="web-session-check-interval" type="number" min="1" max="1440" value={webMonitor.intervalMinutes} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, intervalMinutes: e.target.value }))} /></label>
            <label className="settings-field" htmlFor="web-session-retry-interval"><span>重登重试间隔（分钟）</span><input id="web-session-retry-interval" type="number" min="15" max="1440" value={webMonitor.retryMinutes} disabled={saving || !webMonitor.enabled} onChange={e => setWebMonitor(v => ({ ...v, retryMinutes: e.target.value }))} /></label>
          </div>
          <div className="task-auto-empty">默认关闭；默认每 15 分钟检测，60 分钟内最多自动重登一次。需要验证码时保留在现有任务队列中等待处理。</div>
        </section>
        <section className="task-auto-settings overload-cooldown-settings" aria-labelledby="overload-auto-cooldown-title">
          <div className="section-title-row">
            <h3 id="overload-auto-cooldown-title">过载自动冷却</h3>
            <HelpTip label="过载自动冷却说明">
              每分钟检查最近一段时间的过载次数，达到阈值后暂停号池分配，到期自动恢复（在账号的“过载检测”列单独开启）。当前规则：最近 {overloadRule.windowMinutes || "—"} 分钟内过载达到 {overloadRule.threshold || "—"} 次，冷却 {overloadRule.cooldownMinutes || "—"} 分钟。恢复后重新计数，服务重启后继续计时。
            </HelpTip>
          </div>
          <div className="overload-rule-fields">
            {[{ key: "windowMinutes", label: "过载统计窗口", unit: "分钟", max: 1440 }, { key: "threshold", label: "过载触发阈值", unit: "次", max: 100000 }, { key: "cooldownMinutes", label: "自动冷却时长", unit: "分钟", max: 43200 }].map(field => <label key={field.key} className="settings-field" htmlFor={`overload-rule-${field.key}`}>
              <span>{field.label}</span><div><input id={`overload-rule-${field.key}`} type="number" min="1" max={field.max} step="1" value={overloadRule[field.key]} disabled={saving} onChange={event => setOverloadRule(current => ({ ...current, [field.key]: event.target.value }))} /><span>{field.unit}</span></div>
            </label>)}
          </div>
        </section>
        <section className="task-auto-settings" aria-labelledby="task-auto-settings-title">
          <div className="task-auto-settings-heading">
            <div className="section-title-row">
              <h3 id="task-auto-settings-title">批量导入后的自动任务</h3>
              <HelpTip label="自动任务说明">
                按授权完成后识别到的原始 PlanType 执行命令。没有规则的 PlanType 不会自动执行其它操作。
              </HelpTip>
            </div>
            <button type="button" className="secondary-button" onClick={() => setAutoRows((current) => [...current, { planType: "", actions: [] }])} disabled={saving}>
              <Plus size={15} />添加规则
            </button>
          </div>
          <datalist id="task-plan-type-suggestions">
            {planTypeSuggestions.map((planType) => <option key={planType} value={planType}>{formatPlanTypeLabel(planType, planTypeMapping)}</option>)}
          </datalist>
          {autoRows.length === 0 && <div className="task-auto-empty">暂未配置自动任务</div>}
          <div className="task-auto-rule-list">
            {autoRows.map((row, index) => (
              <div className="task-auto-rule" key={`${row.planType || "new"}-${index}`}>
                <label className="settings-field task-auto-plan-field">
                  <span>PlanType</span>
                  <input list="task-plan-type-suggestions" value={row.planType} placeholder="例如 self_serve_business_prolite"
                    onChange={(event) => setAutoRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, planType: event.target.value } : item))}
                    disabled={saving} />
                  {row.planType && <small>{formatPlanTypeLabel(row.planType, planTypeMapping)}</small>}
                </label>
                <div className="task-auto-action-options" aria-label={`${row.planType || "PlanType"} 自动命令`}>
                  {actionOptions.map((option) => (
                    <label key={option.value} className="task-auto-action-option">
                      <input type="checkbox" checked={row.actions.includes(option.value)} disabled={saving}
                        onChange={(event) => setAutoRows((current) => current.map((item, itemIndex) => {
                          if (itemIndex !== index) return item;
                          const next = new Set(item.actions);
                          if (event.target.checked) next.add(option.value);
                          else next.delete(option.value);
                          return { ...item, actions: [...next] };
                        }))} />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
                <button type="button" className="icon-button danger" title="删除自动任务规则" aria-label="删除自动任务规则" onClick={() => setAutoRows((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={saving}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
        {error && <div className="dialog-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <div className="dialog-footer">
          <button type="button" className="selection-text-button" onClick={() => { setLimit(String(settings.default)); setCooldownMinutes("60"); setOverloadRule({ windowMinutes: "15", threshold: "10", cooldownMinutes: "60" }); setWebMonitor({ enabled: false, autoRelogin: true, intervalMinutes: "15", retryMinutes: "60" }); setAccountProxyMode("global"); setCodexAuthMode("local"); }} disabled={saving}>恢复默认</button>
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
    actions: Array.isArray(actions) ? [...new Set(actions)] : [],
  }));
}

function LogDialog({ token, job, onClose }) {
  const [logs, setLogs] = useState("正在读取日志...");
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const viewerRef = useRef(null);
  const initialLoadedRef = useRef(false);

  const load = async ({ manual = false } = {}) => {
    if (manual) setRefreshing(true);
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/logs`);
      setLogs(data.logs || "暂无日志");
      if (!initialLoadedRef.current) {
        initialLoadedRef.current = true;
        window.requestAnimationFrame(() => {
          if (viewerRef.current) viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
        });
      }
    } catch (error) {
      setLogs(`日志读取失败：${error.message}`);
    } finally {
      if (manual) setRefreshing(false);
    }
  };

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const data = await apiFetch(token, `/api/jobs/${job.id}/logs`);
        if (stopped) return;
        setLogs(data.logs || "暂无日志");
        if (!initialLoadedRef.current) {
          initialLoadedRef.current = true;
          window.requestAnimationFrame(() => {
            if (viewerRef.current) viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
          });
        }
      } catch (error) {
        if (!stopped) setLogs(`日志读取失败：${error.message}`);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1_200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [job.id, token]);

  async function copyLogs() {
    if (!logs) return;
    try {
      await navigator.clipboard.writeText(logs);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  }

  return (
    <AccessibleDialog className="log-dialog" labelledBy="log-dialog-title" onClose={onClose}>
        <div className="dialog-header">
          <div>
            <div className="section-title-row">
              <h2 id="log-dialog-title">协议日志</h2>
              <StatusBadge status={job.status} webSessionStatus={job.webSessionStatus} />
            </div>
            <span>{job.email}</span>
          </div>
          <div className="dialog-header-actions">
            <button type="button" className="secondary-button compact-button" onClick={copyLogs} title="复制协议日志">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制" : "复制日志"}
            </button>
            <button type="button" className="icon-button" onClick={() => load({ manual: true })} disabled={refreshing} title="刷新日志" aria-label="刷新日志">
              <RefreshCw className={refreshing ? "spin" : ""} size={16} />
            </button>
            <button type="button" className="icon-button" autoFocus onClick={onClose} title="关闭" aria-label="关闭协议日志">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="log-dialog-body">
          <pre ref={viewerRef} className="log-dialog-viewer" tabIndex="0">{logs}</pre>
        </div>
        <div className="dialog-actions log-dialog-actions">
          <span className="log-dialog-meta">每 1.2 秒自动同步实时输出</span>
          <span className="dialog-actions-spacer" />
          <button type="button" className="cancel-button" onClick={onClose}>关闭</button>
        </div>
    </AccessibleDialog>
  );
}

function CredentialDialog({ token, job, accountProxyUrl, totpReplaceAvailable, onClose, onError }) {
  const [details, setDetails] = useState(null);
  const [password, setPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [sub2apiJson, setSub2apiJson] = useState("");
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [totpDirty, setTotpDirty] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [totpSeconds, setTotpSeconds] = useState(0);
  const [totpCodeError, setTotpCodeError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setDialogError("");
    setNotice("");
    apiFetch(token, `/api/jobs/${job.id}/credentials`)
      .then((data) => {
        if (stopped) return;
        const next = data.credentials || {};
        setDetails(next);
        setPassword(next.password || "");
        setTotpSecret(next.totpSecret || "");
        setSub2apiJson(next.sub2apiJson || "");
        setPasswordDirty(false);
        setTotpDirty(false);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [job.id, token]);

  useEffect(() => {
    let stopped = false;
    async function refreshTotpCode() {
      const normalized = normalizeTotpForDisplay(totpSecret);
      const seconds = 30 - (Math.floor(Date.now() / 1000) % 30);
      if (!stopped) setTotpSeconds(seconds);
      if (!normalized) {
        if (!stopped) {
          setTotpCode("");
          setTotpCodeError("");
        }
        return;
      }
      try {
        const code = await generateTotpCode(normalized);
        if (!stopped) {
          setTotpCode(code);
          setTotpCodeError("");
        }
      } catch (error) {
        if (!stopped) {
          setTotpCode("");
          setTotpCodeError(error.message || "2FA 密钥无法生成动态验证码");
        }
      }
    }
    void refreshTotpCode();
    const timer = window.setInterval(refreshTotpCode, 1_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [totpSecret]);

  async function refreshCredentials() {
    setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/credentials`);
      const next = data.credentials || {};
      setDetails(next);
      setPassword(next.password || "");
      setTotpSecret(next.totpSecret || "");
      setSub2apiJson(next.sub2apiJson || "");
      setPasswordDirty(false);
      setTotpDirty(false);
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    const body = {};
    if (passwordDirty) body.password = password;
    if (totpDirty) {
      const normalized = totpSecret.toUpperCase().replace(/[\s=]/g, "");
      if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
        setDialogError("2FA 密钥必须是 16 到 128 位 Base32 字符");
        return;
      }
      body.totpSecret = normalized;
    }
    if (!Object.keys(body).length) {
      setNotice("没有需要保存的修改");
      return;
    }
    setSaving(true);
    setDialogError("");
    setNotice("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/credentials`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const next = data.credentials || {};
      setDetails(next);
      setPassword(next.password || "");
      setTotpSecret(next.totpSecret || "");
      setSub2apiJson(next.sub2apiJson || sub2apiJson);
      setPasswordDirty(false);
      setTotpDirty(false);
      setNotice(next.persisted === false
        ? "已更新当前进程凭据，但系统未提供持久凭据存储"
        : "凭据已更新并保存");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function replaceTotp() {
    const confirmed = window.confirm(
      "确定轮换该账号的 2FA 吗？服务会先停用旧 2FA，再创建并激活新密钥；如果远端创建失败，账号可能暂时没有 2FA，需要在本窗口重试。",
    );
    if (!confirmed) return;
    setReplacing(true);
    setDialogError("");
    setNotice("");
    try {
      const body = {};

      await apiFetch(token, `/api/jobs/${job.id}/replace-2fa`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice("2FA 轮换已排队，请等待任务完成后重新读取凭据");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setReplacing(false);
    }
  }

  async function copySub2apiJson() {
    if (!sub2apiJson) return;
    try {
      await navigator.clipboard.writeText(sub2apiJson);
      setNotice("Sub2API JSON 已复制");
      onError("");
    } catch {
      setDialogError("无法自动复制 Sub2API JSON，请在滚动区域中手动选择");
    }
  }

  async function copyTotpCode() {
    if (!totpCode) return;
    try {
      await navigator.clipboard.writeText(totpCode);
      setNotice("动态验证码已复制");
      onError("");
    } catch {
      setDialogError("无法自动复制动态验证码，请手动选择验证码");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving && !replacing) onClose();
    }}>
      <form className="batch-dialog credential-dialog" onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
        <div className="dialog-header">
          <div>
            <h2 id="credential-dialog-title">账号凭据</h2>
            <span>{job.email}</span>
          </div>
          <div className="dialog-header-actions">
            <button
              type="button"
              className="icon-button"
              onClick={refreshCredentials}
              disabled={loading || refreshing || saving || replacing || passwordDirty || totpDirty}
              title={passwordDirty || totpDirty ? "请先保存当前修改" : "重新读取凭据"}
              aria-label="重新读取凭据"
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={17} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} disabled={saving || replacing} title="关闭">
              <X size={18} />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="credential-loading"><LoaderCircle className="spin" size={18} />正在读取凭据</div>
        ) : (
          <>
            <div className="credential-field">
              <span>密码</span>
              <div className="secret-input-row">
                <KeyRound size={15} aria-hidden="true" />
                <input
                  aria-label="密码"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); setPasswordDirty(true); }}
                  placeholder={details?.passwordAvailable ? "凭据已保存" : details?.hasPassword ? "原文不可恢复，请重新录入" : "未保存密码"}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button type="button" className="secret-toggle" onClick={() => setShowPassword((value) => !value)} title={showPassword ? "隐藏密码" : "显示密码"}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {details?.hasPassword && !details?.passwordAvailable && (
              <div className="credential-warning credential-warning-block">
                该账号只保留了密码存在标记，旧版本没有保存密码原文。请重新录入并保存，之后即可查看。
              </div>
            )}
            <div className="credential-field">
              <span>2FA 密钥</span>
              <div className="secret-input-row">
                <ShieldCheck size={15} aria-hidden="true" />
                <input
                  aria-label="2FA 密钥"
                  type={showTotp ? "text" : "password"}
                  value={totpSecret}
                  onChange={(event) => { setTotpSecret(event.target.value); setTotpDirty(true); }}
                  placeholder={details?.totpSecretAvailable ? "密钥已保存" : details?.hasTotpKey ? "原文不可恢复，请重新录入" : "未保存 2FA 密钥"}
                  autoComplete="off"
                  spellCheck="false"
                  inputMode="text"
                />
                <button type="button" className="secret-toggle" onClick={() => setShowTotp((value) => !value)} title={showTotp ? "隐藏 2FA 密钥" : "显示 2FA 密钥"}>
                  {showTotp ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {details?.hasTotpKey && !details?.totpSecretAvailable && (
              <div className="credential-warning credential-warning-block">
                该账号只保留了 2FA 存在标记，旧版本没有保存密钥原文。请重新录入并保存，之后即可生成动态验证码。
              </div>
            )}
            <section className="totp-code-panel" aria-labelledby="totp-code-title">
              <div className="totp-code-heading">
                <div className="section-title-row">
                  <strong id="totp-code-title">当前动态验证码</strong>
                  <HelpTip label="动态验证码说明">每 30 秒自动更新一次 6 位 TOTP 验证码。</HelpTip>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={copyTotpCode}
                  disabled={!totpCode}
                  title="复制动态验证码"
                  aria-label="复制动态验证码"
                >
                  <Copy size={16} />
                </button>
              </div>
              {totpCode ? (
                <div className="totp-code-value" aria-live="polite">
                  <code>{totpCode}</code>
                  <span className="totp-code-countdown">{totpSeconds} 秒后更新</span>
                </div>
              ) : totpCodeError ? (
                <div className="credential-warning credential-warning-block">{totpCodeError}</div>
              ) : (
                <div className="credential-json-empty">保存可读取的 2FA 密钥后，这里会显示动态验证码</div>
              )}
              <div className="totp-code-progress" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, (totpSeconds / 30) * 100))}%` }} />
              </div>
            </section>
            <section className="credential-json-section" aria-labelledby="sub2api-json-title">
              <div className="credential-json-heading">
                <div className="section-title-row">
                  <strong id="sub2api-json-title">Sub2API JSON</strong>
                  <HelpTip label="Sub2API JSON 说明">完整授权导入凭据内容已放在下方可滚动区域中，可直接一键复制。</HelpTip>
                </div>
                <button type="button" className="icon-button" onClick={copySub2apiJson} disabled={!sub2apiJson} title="复制 Sub2API JSON" aria-label="复制 Sub2API JSON">
                  <Copy size={16} />
                </button>
              </div>
              {sub2apiJson ? (
                <pre className="credential-json-viewer" tabIndex="0">{sub2apiJson}</pre>
              ) : (
                <div className="credential-json-empty">当前任务还没有可用的 Sub2API 导入 JSON</div>
              )}
            </section>
            <div className="credential-meta">
              <span>当前状态：{job.status}</span>
              {details?.persisted === false && <span className="credential-warning">系统未提供持久凭据存储</span>}
            </div>
            {job.totpRotationIncomplete && (
              <div className="credential-warning credential-warning-block">上次 2FA 轮换未完成：远端旧密钥状态可能已变化，请重试完成轮换后再继续登录。</div>
            )}
            {dialogError && <div className="dialog-error" role="alert"><CircleAlert size={15} />{dialogError}</div>}
            {notice && <div className="credential-notice" role="status"><Check size={15} />{notice}</div>}
            <div className="dialog-actions credential-dialog-actions">
              {totpReplaceAvailable && job.canReplaceTotp && (
                <button type="button" className="danger-button" onClick={replaceTotp} disabled={saving || replacing}>
                  {replacing ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}轮换 2FA
                </button>
              )}
              <span className="dialog-actions-spacer" />
              <button type="button" className="cancel-button" onClick={onClose} disabled={saving || replacing}>关闭</button>
              <button type="submit" className="primary-button" disabled={loading || saving || replacing || (!passwordDirty && !totpDirty)}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存凭据
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function isBlockedAccount(job) {
  return Boolean(job.autoRepairBlocked || job.status === "banned" || job.webSessionStatus === "banned");
}

function AccountBlockedWebState({ job }) {
  return (
    <div className="dialog-error dialog-state-panel error" role="alert">
      <Ban size={18} aria-hidden="true" />
      <div className="dialog-state-text">
        <strong>账号已封禁</strong>
        <span>{extractResponseMessage(job.autoRepairBlockedReason || "账号已被删除、封禁或永久停用")}</span>
        <small>已停止读取设备、会话和工作空间，Web 重登及自动维护已关闭。{job.banProxyReleasePending ? "IP 解绑待重试。" : job.boundProxyStatus === "unbound" ? "IP 绑定已解除。" : "IP 解绑状态待同步。"}确认解封后可使用“重新登录并授权”验证恢复。</small>
      </div>
    </div>
  );
}

function SessionDialog({ token, job, onClose, onError }) {
  const blocked = isBlockedAccount(job);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadSessions({ initial = false } = {}) {
    if (blocked) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/sessions`);
      setDevices(data.sessions?.devices || []);
      onError("");
    } catch (error) {
      setDevices([]);
      setDialogError(error.message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    setDevices([]);
    setNotice("");
    if (blocked) { setLoading(false); setDialogError(""); return; }
    setLoading(true);
    setDialogError("");
    apiFetch(token, `/api/jobs/${job.id}/sessions`)
      .then((data) => {
        if (!stopped) setDevices(data.sessions?.devices || []);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [job.id, token, blocked]);

  async function logoutDevice(device) {
    if (blocked) return;
    if (device.isCurrentDevice) {
      setDialogError("当前设备不能在这里单独登出，请使用一键登出");
      return;
    }
    const label = device.description || device.displayName || "该设备";
    if (!window.confirm(`确定登出 ${label} 吗？`)) return;
    setAction(device.id);
    setDialogError("");
    setNotice("");
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sessions/logout`, {
        method: "POST",
        body: JSON.stringify(device.sessionId
          ? { sessionId: device.sessionId }
          : { deviceIdHash: device.deviceIdHash }),
      });
      setDevices((current) => current.filter((item) => item.id !== device.id));
      setNotice("设备已登出");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  async function logoutAll() {
    if (blocked || action || !job.canLogoutAllSessions) return;
    if (!window.confirm("确定登出该账号的所有设备和会话吗？当前会话也会失效，需要重新登录。")) return;
    setAction("all");
    setDialogError("");
    setNotice("");
    try {
      await apiFetch(token, `/api/jobs/${job.id}/sessions/logout-all`, { method: "POST" });
      setDevices([]);
      setNotice("已提交全部设备登出请求，服务端可能需要几分钟完成传播");
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  return (
    <AccessibleDialog
      className="session-dialog"
      labelledBy="session-dialog-title"
      closeDisabled={Boolean(action)}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="dialog-heading-group">
          <div className="section-title-row">
            <h2 id="session-dialog-title">已登录设备与会话</h2>
            <HelpTip label="登录 IP 说明">
              登录 IP 仅显示上游返回的设备记录；缺失时标注“上游未提供”，不以账号绑定的代理 IP 代替。
            </HelpTip>
            {!blocked && !loading && !dialogError && (
              <span className="dialog-count-pill">{devices.length} 台设备</span>
            )}
          </div>
          <div className="dialog-subtitle-row">
            <span className="dialog-account-email" title={job.email}>{job.email}</span>
          </div>
        </div>
        <div className="dialog-header-actions">
          <button
            type="button"
            className="icon-button dialog-header-btn"
            onClick={() => loadSessions()}
            disabled={blocked || loading || refreshing || Boolean(action)}
            title="刷新设备列表"
            aria-label="刷新设备列表"
          >
            <RefreshCw className={refreshing ? "spin" : ""} size={15} />
          </button>
          <button
            type="button"
            className="icon-button dialog-header-btn"
            autoFocus
            data-dialog-initial-focus
            onClick={onClose}
            disabled={Boolean(action)}
            title="关闭"
            aria-label="关闭已登录设备与会话"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="dialog-body">
        {blocked ? <AccountBlockedWebState job={job} /> : loading ? (
          <div className="credential-loading dialog-state-panel" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div className="dialog-state-text">
              <strong>正在读取设备和会话</strong>
              <span>正在同步该账号的上游活跃设备记录，请稍候…</span>
            </div>
          </div>
        ) : devices.length ? (
          <div className="session-list" aria-live="polite">
            {devices.map((device) => {
              const titleText = device.description || device.displayName || "未知设备";
              const platformText = formatSessionPlatform(device);
              const locationText = formatSessionLocation(device);
              const signedInIso = device.lastSignedInTimestamp
                ? new Date(device.lastSignedInTimestamp * 1000).toISOString()
                : null;
              const canLogoutSingle = !device.isCurrentDevice && Boolean(device.sessionId || device.deviceIdHash);
              return (
                <article
                  className={`session-item${device.isCurrentDevice ? " current" : ""}${device.isTrustedDevice ? " trusted" : ""}`}
                  key={device.id}
                >
                  <div className="session-item-icon" aria-hidden="true">
                    <MonitorSmartphone size={17} />
                  </div>
                  <div className="session-item-main">
                    <div className="session-item-heading">
                      <strong className="session-item-title" title={titleText}>{titleText}</strong>
                      <div className="session-item-badges">
                        {device.isCurrentDevice && <span className="session-badge current">当前会话</span>}
                        {device.isTrustedDevice && <span className="session-badge trusted">可信设备</span>}
                      </div>
                    </div>
                    {(
                      (device.description && device.displayName && device.displayName !== device.description)
                      || platformText
                      || locationText
                      || signedInIso
                    ) && (
                      <div className="session-item-meta">
                        {device.description && device.displayName && device.displayName !== device.description && (
                          <span className="session-meta-chip" title={device.displayName}>{device.displayName}</span>
                        )}
                        {platformText && <span className="session-meta-chip">{platformText}</span>}
                        {locationText && <span className="session-meta-item" title={locationText}>{locationText}</span>}
                        {signedInIso && (
                          <time className="session-meta-item" dateTime={signedInIso}>
                            最近登录 {formatDateTime(signedInIso)}
                          </time>
                        )}
                      </div>
                    )}
                    <div className="session-item-details">
                      <div className={`session-login-ip${device.lastSignedInIp ? "" : " unavailable"}`}>
                        <span className="session-detail-label">最近登录 IP</span>
                        {device.lastSignedInIp
                          ? <code>{device.lastSignedInIp}</code>
                          : <span className="session-ip-empty">上游未提供</span>}
                      </div>
                      {device.appSessions?.length > 0 && (
                        <div className="session-apps" title={`应用：${device.appSessions.join("、")}`}>
                          <span className="session-detail-label">应用</span>
                          <span className="session-apps-value">{device.appSessions.join("、")}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-button danger session-logout-button"
                    onClick={() => logoutDevice(device)}
                    disabled={Boolean(action) || !canLogoutSingle}
                    title={device.isCurrentDevice ? "当前会话请使用一键登出" : !canLogoutSingle ? "该设备缺少可单独登出的会话标识" : "登出该设备"}
                    aria-label={`登出 ${device.displayName || device.description || "设备"}`}
                  >
                    {action === device.id ? <LoaderCircle className="spin" size={14} /> : <LogOut size={14} />}
                    <span className="session-logout-label">{device.isCurrentDevice ? "当前" : "登出"}</span>
                  </button>
                </article>
              );
            })}
          </div>
        ) : dialogError ? (
          <div className="dialog-error dialog-state-panel error" role="alert">
            <CircleAlert size={18} />
            <div className="dialog-state-text">
              <strong>读取设备与会话失败</strong>
              <span>{dialogError}</span>
              <small>请求未完成，并不代表账号未登录或会话已失效；可点击重试重新读取。</small>
            </div>
            <button
              type="button"
              className="secondary-button compact-btn dialog-state-retry"
              onClick={() => loadSessions()}
              disabled={refreshing || Boolean(action)}
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={13} />重试
            </button>
          </div>
        ) : (
          <div className="session-empty dialog-state-panel">
            <MonitorSmartphone size={22} />
            <div className="dialog-state-text">
              <strong>没有可显示的设备或会话</strong>
              <span>上游当前未返回设备记录，或刚刚完成登出操作；点击右上角刷新可重新读取。</span>
            </div>
          </div>
        )}

        {!blocked && !loading && devices.length > 0 && dialogError && (
          <div className="dialog-error" role="alert">
            <CircleAlert size={15} />
            <span>{dialogError}</span>
          </div>
        )}
        {!blocked && notice && (
          <div className="credential-notice" role="status">
            <Check size={15} />
            <span>{notice}</span>
          </div>
        )}
      </div>

      <div className="dialog-actions session-dialog-actions">
        <button
          type="button"
          className="danger-button session-logout-all-button"
          onClick={logoutAll}
          disabled={blocked || loading || Boolean(action) || !job.canLogoutAllSessions}
        >
          {action === "all" ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}一键登出所有设备
        </button>
        <span className="dialog-actions-spacer" />
        <button type="button" className="cancel-button" onClick={onClose} disabled={Boolean(action)}>关闭</button>
      </div>
    </AccessibleDialog>
  );
}

function formatSessionLocation(device) {
  const parts = [device.lastSignedInCity, device.lastSignedInRegionCode, device.lastSignedInCountry]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(parts)].join(" · ");
}

function formatSessionPlatform(device) {
  const titleLower = String(device.description || device.displayName || "").toLowerCase();
  const map = { macos: "macOS", windows: "Windows", ios: "iOS", ipad: "iPadOS", android: "Android", linux: "Linux", web: "Web" };
  const parts = [];
  const rawPlatform = String(device.platform || "").trim();
  const rawOs = String(device.osVersion || "").trim();
  if (rawPlatform) {
    const label = map[rawPlatform.toLowerCase()] || rawPlatform;
    const combined = rawOs && !label.toLowerCase().includes(rawOs.toLowerCase()) ? `${label} ${rawOs}` : label;
    if (!titleLower.includes(combined.toLowerCase())) {
      parts.push(combined);
    } else if (!titleLower.includes(label.toLowerCase())) {
      parts.push(label);
    }
  } else if (rawOs && !titleLower.includes(rawOs.toLowerCase())) {
    parts.push(rawOs);
  }
  const rawModel = String(device.deviceModel || "").trim();
  if (rawModel && !titleLower.includes(rawModel.toLowerCase())) {
    parts.push(rawModel);
  }
  return [...new Set(parts)].join(" · ");
}

function WorkspaceDialog({ token, job, planTypeMapping, onClose, onError, onJobUpdate, onWorkspaceSwitched }) {
  const blocked = isBlockedAccount(job);
  const [workspaces, setWorkspaces] = useState([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [action, setAction] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadWorkspaces({ initial = false } = {}) {
    if (blocked) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setDialogError("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/workspaces`);
      const listedWorkspaces = data.workspaces?.workspaces || [];
      setWorkspaces(listedWorkspaces);
      setCurrentWorkspaceId(data.workspaces?.currentWorkspaceId || listedWorkspaces.find((item) => item.current)?.id || null);
    } catch (error) {
      setWorkspaces([]);
      setDialogError(error.message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    setWorkspaces([]);
    setCurrentWorkspaceId(null);
    setNotice("");
    setDialogError("");
    if (blocked) { setLoading(false); return; }
    setLoading(true);
    apiFetch(token, `/api/jobs/${job.id}/workspaces`)
      .then((data) => {
        if (stopped) return;
        const listedWorkspaces = data.workspaces?.workspaces || [];
        setWorkspaces(listedWorkspaces);
        setCurrentWorkspaceId(data.workspaces?.currentWorkspaceId || listedWorkspaces.find((item) => item.current)?.id || null);
      })
      .catch((error) => {
        if (!stopped) setDialogError(error.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => { stopped = true; };
  }, [job.id, token, blocked]);

  useEffect(() => {
    if (blocked || job.lastOperationType !== "workspace_switch" || job.status !== "completed") return;
    void loadWorkspaces();
  }, [job.lastOperationAt, job.lastOperationType, job.status, blocked]);

  async function switchWorkspace(workspace) {
    if (blocked) return;
    if (!workspace?.id || workspace.id === currentWorkspaceId || action) return;
    if (isWorkspaceEntryDisabled(workspace)) return;
    setAction(workspace.id);
    setDialogError("");
    setNotice("");
    try {
      const data = await apiFetch(token, `/api/jobs/${job.id}/workspaces/switch`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      if (data.job) onJobUpdate(data.job);
      onWorkspaceSwitched?.();
      setCurrentWorkspaceId(workspace.id);
      setWorkspaces((current) => current.map((item) => ({ ...item, current: item.id === workspace.id })));
      if (data.sub2api?.error) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新；号池同步失败：${data.sub2api.error}`);
      } else if (data.sub2api?.statusRefreshError) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，号池中 ${data.sub2api.updated || 0} 条凭据已更新，但状态刷新失败：${data.sub2api.statusRefreshError}`);
      } else if (data.sub2api?.updated) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新，号池中 ${data.sub2api.updated} 条凭据已原地同步。`);
      } else if (data.sub2api?.configured) {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已更新；号池中没有找到同邮箱账号。`);
      } else {
        setNotice(`已切换到“${workspace.name || workspace.id}”，PlanType 已同步更新。`);
      }
      onError("");
    } catch (error) {
      setDialogError(error.message);
    } finally {
      setAction("");
    }
  }

  return (
    <AccessibleDialog
      className="workspace-dialog"
      labelledBy="workspace-dialog-title"
      closeDisabled={Boolean(action)}
      onClose={onClose}
    >
      <div className="dialog-header">
        <div className="dialog-heading-group">
          <div className="section-title-row">
            <h2 id="workspace-dialog-title">工作空间</h2>
            {!blocked && !loading && !dialogError && (
              <span className="dialog-count-pill">{workspaces.length} 个空间</span>
            )}
          </div>
          <div className="dialog-subtitle-row">
            <span className="dialog-account-email" title={job.email}>{job.email}</span>
          </div>
        </div>
        <div className="dialog-header-actions">
          <button
            type="button"
            className="icon-button dialog-header-btn"
            onClick={() => loadWorkspaces()}
            disabled={blocked || loading || refreshing || Boolean(action)}
            title="刷新工作空间"
            aria-label="刷新工作空间"
          >
            <RefreshCw className={refreshing ? "spin" : ""} size={15} />
          </button>
          <button
            type="button"
            className="icon-button dialog-header-btn"
            autoFocus
            data-dialog-initial-focus
            onClick={onClose}
            disabled={Boolean(action)}
            title="关闭"
            aria-label="关闭工作空间"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="dialog-body">
        {blocked ? <AccountBlockedWebState job={job} /> : loading ? (
          <div className="credential-loading dialog-state-panel" role="status" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div className="dialog-state-text">
              <strong>正在读取工作空间</strong>
              <span>正在获取该账号关联的个人与组织空间列表，请稍候…</span>
            </div>
          </div>
        ) : workspaces.length ? (
          <div className="workspace-list" aria-live="polite">
            {workspaces.map((workspace) => {
              const selected = workspace.id === currentWorkspaceId || (currentWorkspaceId === null && workspace.current === true);
              const disabled = isWorkspaceEntryDisabled(workspace);
              const availabilityLabel = resolveWorkspaceAvailabilityLabel(workspace);
              const disabledActionText = resolveWorkspaceDisabledActionText(workspace);
              const failureTooltip = disabled ? workspaceFailureTooltip(workspace, availabilityLabel) : undefined;
              const isPersonal = workspace.structure === "personal";
              const displayName = workspace.name || workspace.id;
              const planLabel = formatPlanTypeLabel(workspace.planType, planTypeMapping);
              const planTone = resolveWorkspacePlanTone(workspace.planType);
              const roleLabel = formatWorkspaceRole(workspace.role);
              return (
                <button
                  type="button"
                  className={`workspace-item${selected ? " selected" : ""}${disabled ? " is-disabled" : ""}`}
                  key={workspace.id}
                  onClick={() => switchWorkspace(workspace)}
                  disabled={disabled || selected || Boolean(action)}
                  title={failureTooltip}
                >
                  <span className={`workspace-item-icon${selected ? " selected" : ""}${disabled ? " disabled" : ""}`} aria-hidden="true">
                    <BriefcaseBusiness size={17} />
                  </span>
                  <span className="workspace-item-main">
                    <span className="workspace-item-heading">
                      <strong className="workspace-item-title" title={displayName}>{displayName}</strong>
                      <span className="workspace-item-badges">
                        <span className={`workspace-badge structure ${isPersonal ? "personal" : "organization"}`}>
                          {isPersonal ? "个人" : "组织"}
                        </span>
                        <span
                          className={`workspace-badge plan-badge ${planTone}`}
                          title={workspace.planType ? `PlanType: ${workspace.planType}` : "PlanType 未知"}
                        >
                          {planLabel}
                        </span>
                        {selected && (
                          <span className="workspace-badge current">
                            <Check size={11} aria-hidden="true" />当前空间
                          </span>
                        )}
                        {disabled ? (
                          <span className="workspace-badge disabled" title={failureTooltip}>
                            {availabilityLabel}
                          </span>
                        ) : (
                          !selected && <span className="workspace-badge available">可用</span>
                        )}
                      </span>
                    </span>
                    <span className="workspace-item-meta">
                      <code className="workspace-id-code" title={`空间 ID: ${workspace.id}`}>{workspace.id}</code>
                      {roleLabel && (
                        <span className="workspace-meta-pill" title={`空间权限: ${workspace.role}`}>
                          权限：{roleLabel}
                        </span>
                      )}
                      {disabled && workspace.availabilityMessage && (
                        <span className="workspace-meta-reason" title={workspace.availabilityMessage}>
                          {workspace.availabilityMessage}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={`workspace-item-action${action === workspace.id ? " switching" : disabled ? " disabled" : selected ? " current" : " switchable"}`}>
                    {action === workspace.id ? (
                      <>
                        <LoaderCircle className="spin" size={13} />
                        <span>切换中</span>
                      </>
                    ) : disabled ? (
                      <>
                        <Ban size={12} aria-hidden="true" />
                        <span>{disabledActionText}</span>
                      </>
                    ) : selected ? (
                      <>
                        <Check size={13} aria-hidden="true" />
                        <span>当前空间</span>
                      </>
                    ) : (
                      <span>切换</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ) : dialogError ? (
          <div className="dialog-error dialog-state-panel error" role="alert">
            <CircleAlert size={18} />
            <div className="dialog-state-text">
              <strong>读取工作空间失败</strong>
              <span>{dialogError}</span>
              <small>未能获取该账号的工作空间列表；可点击重试重新读取。</small>
            </div>
            <button
              type="button"
              className="secondary-button compact-btn dialog-state-retry"
              onClick={() => loadWorkspaces()}
              disabled={refreshing || Boolean(action)}
            >
              <RefreshCw className={refreshing ? "spin" : ""} size={13} />重试
            </button>
          </div>
        ) : (
          <div className="workspace-empty dialog-state-panel">
            <BriefcaseBusiness size={22} />
            <div className="dialog-state-text">
              <strong>没有可用的工作空间</strong>
              <span>该账号当前没有返回可切换的个人或组织空间。</span>
            </div>
          </div>
        )}

        {!blocked && !loading && workspaces.length > 0 && dialogError && (
          <div className="dialog-error" role="alert">
            <CircleAlert size={15} />
            <span>{dialogError}</span>
          </div>
        )}
        {!blocked && notice && (
          <div className="credential-notice" role="status">
            <Check size={15} />
            <span>{notice}</span>
          </div>
        )}
      </div>

      <div className="dialog-actions workspace-dialog-actions">
        <span className="dialog-actions-spacer" />
        <button type="button" className="cancel-button" onClick={onClose} disabled={Boolean(action)}>关闭</button>
      </div>
    </AccessibleDialog>
  );
}

function isWorkspaceEntryDisabled(workspace) {
  return Boolean(
    workspace?.canAccess === false
      || workspace?.deactivated
      || (workspace?.availabilityReason && workspace.availabilityReason !== "available"),
  );
}

function resolveWorkspaceAvailabilityLabel(workspace) {
  if (workspace?.availabilityLabel) return workspace.availabilityLabel;
  const codeSuffix = workspace?.availabilityCode ? `（${workspace.availabilityCode}）` : "";
  if (workspace?.deactivated || workspace?.availabilityReason === "deactivated") return `空间已停用${codeSuffix}`;
  if (workspace?.availabilityReason === "removed") return `已移出空间${codeSuffix}`;
  if (workspace?.availabilityReason === "banned") return `空间封禁${codeSuffix || "（402）"}`;
  if (workspace?.availabilityReason === "inaccessible" || workspace?.canAccess === false) return `无权访问${codeSuffix}`;
  return `已失效${codeSuffix}`;
}

function resolveWorkspaceDisabledActionText(workspace) {
  if (workspace?.deactivated || workspace?.availabilityReason === "deactivated") return "已停用";
  if (workspace?.availabilityReason === "inaccessible" || (workspace?.canAccess === false && !workspace?.availabilityReason)) return "无权限";
  if (workspace?.availabilityReason === "removed") return "已失效";
  if (workspace?.availabilityReason === "banned") return "已失效";
  return "不可用";
}

function resolveWorkspacePlanTone(planType) {
  const raw = String(planType || "").trim().toLowerCase();
  if (!raw || raw === "unknown") return "unknown";
  if (raw.includes("free")) return "free";
  if (raw.includes("business") || raw.includes("enterprise") || raw.includes("pro")) return "business";
  if (raw.includes("team")) return "team";
  if (raw.includes("plus")) return "plus";
  return "default";
}

function formatWorkspaceRole(role) {
  if (!role) return "";
  const normalized = String(role).trim().toLowerCase();
  const map = {
    "account-owner": "所有者",
    owner: "所有者",
    "account-admin": "管理员",
    admin: "管理员",
    "standard-user": "成员",
    member: "成员",
    user: "成员",
    reader: "只读",
    viewer: "只读",
  };
  return map[normalized] || String(role).trim();
}

function StatusBadge({ status, webSessionStatus = "absent" }) {
  const description = status === "canceled"
    ? `上次 Codex 授权任务已取消；${WEB_STATES[webSessionStatus] || "Web 状态未知"}。Web 登录状态与授权任务结果分别记录。`
    : undefined;
  const config = {
    queued: ["排队中", <LoaderCircle size={14} />],
    starting: ["启动中", <LoaderCircle className="spin" size={14} />],
    working: ["处理中", <LoaderCircle className="spin" size={14} />],
    password: ["待密码", <KeyRound size={14} />],
    mfa_otp: ["待 2FA", <ShieldCheck size={14} />],
    totp_starting: ["准备 2FA", <LoaderCircle className="spin" size={14} />],
    password_add_starting: ["准备密码", <LoaderCircle className="spin" size={14} />],
    totp_setup_otp: ["激活 2FA", <ShieldCheck size={14} />],
    email_otp: ["待邮箱码", <Mail size={14} />],
    phone: ["待手机号", <Smartphone size={14} />],
    phone_otp: ["待手机码", <Smartphone size={14} />],
    finalizing: ["生成中", <LoaderCircle className="spin" size={14} />],
    refreshing: ["刷新授权", <RefreshCw className="spin" size={14} />],
    completed: ["已完成", <Check size={14} />],
    failed: ["失败", <CircleAlert size={14} />],
    mfa_failed: ["2FA 未通过", <CircleAlert size={14} />],
    banned: ["封禁", <Ban size={14} />],
    canceled: ["授权已取消", <Ban size={14} />],
    reauth_required: ["待重新授权", <RefreshCw size={14} />],
    resume_available: ["可继续", <RotateCcw size={14} />],
  }[status] || [status, null];
  return <span className={`status-badge ${status}`} title={description} aria-label={description}>{config[1]}{config[0]}</span>;
}

const usageCreditBalanceFormatter = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsageCreditBalance(value) {
  if (value === null || value === undefined || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? usageCreditBalanceFormatter.format(value) : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const parsed = Number(text);
    // Keep decimal strings exact instead of first rounding them to binary floats.
    return Number.isFinite(parsed) ? usageCreditBalanceFormatter.format(text) : null;
  }
  if (text === "未知") return "未知";
  return null;
}

function AccountUsageCell({ usage, available, enabled, onRefresh }) {
  if (!enabled) {
    return <span className="usage-state muted" title="服务端尚未启用 Sub2API 用量同步">未启用</span>;
  }
  if (!available) {
    return <span className="usage-state muted">待授权</span>;
  }
  if (!usage || usage.status === "loading") {
    return <span className="usage-state muted">查询中...</span>;
  }
  if (usage.status === "error") {
    return (
      <button type="button" className="usage-retry" onClick={onRefresh} title={usage.error || "重新读取 Sub2API 用量"}>
        <RefreshCw size={13} />重试
      </button>
    );
  }
  const primary = usage.primary;
  const secondary = usage.secondary;
  const credits = usage.credits;
  const resetCredits = usage.resetCredits;
  if (!primary && !secondary && !credits && !resetCredits && usage.allowed === null && usage.limitReached === null) {
    return (
      <span className="usage-empty">
        <span className="usage-state muted" title="从 Sub2API 同步用量（重置卡未知）">暂无用量</span>
        {onRefresh && <button type="button" className="usage-refresh-icon" onClick={onRefresh} title="从 Sub2API 同步用量" aria-label="从 Sub2API 同步用量"><RefreshCw size={12} /></button>}
      </span>
    );
  }
  const restricted = usage.limitReached === true || usage.allowed === false || credits?.overageLimitReached === true;
  const windows = [
    { key: "primary", label: usageWindowLabel("5h", primary), value: primary },
    { key: "secondary", label: usageWindowLabel("7d", secondary), value: secondary },
  ].filter((item) => item.value);
  const formattedBalance = formatUsageCreditBalance(credits?.balance);
  const resetCreditCount = Number.isInteger(resetCredits?.availableCount) && resetCredits.availableCount >= 0
    ? resetCredits.availableCount
    : null;
  const resetCreditsTitle = resetCredits?.credits?.length
    ? `重置卡到期时间：${resetCredits.credits.map((credit) => formatDateTime(credit.expiresAt)).join("、")}`
    : "从 Sub2API 同步可用重置卡数量；点击刷新可查询最新数量";
  return (
    <div className={`account-usage ${restricted ? "restricted" : ""}`} title={usage.fetchedAt ? `Sub2API 同步于 ${formatDateTime(usage.fetchedAt)}` : "Sub2API 用量"}>
      <div className="usage-state-row">
        <span className="usage-state">{restricted ? "受限" : usage.allowed === true ? "可用" : "已读取"}</span>
        {onRefresh && <button type="button" className="usage-refresh-icon" onClick={onRefresh} title="从 Sub2API 同步用量" aria-label="从 Sub2API 同步用量"><RefreshCw size={13} /></button>}
      </div>
      {windows.map((item) => <UsageWindowProgress key={item.key} tone={item.key} label={item.label} window={item.value} />)}
      <div className="usage-meta-pills">
        {credits && credits.unlimited === true && (
          <span className="usage-meta-pill usage-window">
            <span><strong>无限额度</strong></span>
          </span>
        )}
        {formattedBalance !== null && (
          <span className={`usage-meta-pill usage-window${formattedBalance === "未知" ? " is-unknown" : ""}`} title={`额度 ${credits?.balance ?? formattedBalance}`}>
            <span>额度 <strong>{formattedBalance}</strong></span>
          </span>
        )}
        <span
          className={`usage-meta-pill usage-reset-credits ${resetCreditCount === null ? "is-unknown" : resetCreditCount > 0 ? "has-cards" : "is-zero"}`}
          title={resetCreditsTitle}
        >
          <span>重置卡 <strong>{resetCreditCount !== null ? `${resetCreditCount} 张` : "未知"}</strong></span>
        </span>
      </div>
    </div>
  );
}

function UsageWindowProgress({ tone, label, window }) {
  const percent = usageWindowPercent(window);
  const percentText = percent === null ? "—" : `${Math.round(percent)}%`;
  const resetText = formatUsageReset(window);
  return (
    <div className="usage-window-block" title={`${label}窗口${percent === null ? "暂无百分比" : `已用 ${percentText}`}${resetText ? `，${resetText}` : ""}`}>
      <span className={`usage-window-label ${tone}`}>{label}</span>
      <div
        className={`usage-progress ${percent === null ? "empty" : percent >= 100 ? "critical" : percent >= 80 ? "warning" : ""}`}
        role="progressbar"
        aria-label={`${label}窗口用量`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
      >
        <span style={{ width: percent === null ? "0%" : `${percent}%` }} />
      </div>
      <strong className="usage-window-percent">{percentText}</strong>
      {resetText && <span className="usage-window-reset">{resetText}</span>}
    </div>
  );
}

function usageWindowPercent(window) {
  const direct = Number(window?.usedPercent);
  if (Number.isFinite(direct)) return Math.min(100, Math.max(0, direct));
  const used = Number(window?.used);
  const limit = Number(window?.limit);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    return Math.min(100, Math.max(0, (used / limit) * 100));
  }
  const remaining = Number(window?.remaining);
  if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
    return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
  }
  return null;
}

function usageWindowLabel(fallback, window) {
  const seconds = Number(window?.limitWindowSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

function formatUsageReset(window) {
  if (window?.resetAt) return `${formatUsageResetAt(window.resetAt)}重置`;
  if (Number.isFinite(Number(window?.resetAfterSeconds))) {
    return `${formatUsageDuration(window.resetAfterSeconds)}后重置`;
  }
  return "";
}

function formatUsageDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}秒`;
  if (value < 3600) return `${Math.floor(value / 60)}分`;
  if (value < 86_400) return `${Math.floor(value / 3600)}小时`;
  return `${Math.floor(value / 86_400)}天`;
}

function formatUsageResetAt(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "待重置";
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds <= 0) return "现在";
  return seconds <= 86_400 ? `${formatUsageDuration(seconds)}后` : formatDateTime(value);
}

function Sub2ApiPoolBadge({ inPool, remoteStatus }) {
  const hasError = inPool === true && remoteStatus === "error";
  const state = hasError ? "error" : inPool === true ? "added" : inPool === false ? "not-added" : "unknown";
  const label = hasError ? "错误" : inPool === true ? "已加入" : inPool === false ? "未加入" : "未同步";
  return <span className={`pool-badge ${state}`} title={hasError ? "已加入号池，但 Sub2API 中账号状态为错误" : undefined}>{label}</span>;
}

function Sub2ApiEnabledToggle({ inPool, enabled, available, busy, onChange }) {
  if (inPool !== true) {
    return <span className="muted">—</span>;
  }
  const known = typeof enabled === "boolean";
  const disabled = !available || !known || busy;
  return (
    <button
      type="button"
      role="switch"
      className={`status-toggle ${enabled === true ? "on" : ""}`}
      aria-checked={enabled === true}
      aria-label={known ? (enabled ? "停用号池账号" : "启用号池账号") : "号池启用状态未知"}
      title={!available ? "请先配置 Sub2API" : known ? (enabled ? "点击停用" : "点击启用") : "正在同步号池状态"}
      disabled={disabled}
      onClick={() => onChange?.(!enabled)}
    >
      <span className="status-toggle-track"><span className="status-toggle-thumb">{busy ? <LoaderCircle className="spin" size={11} /> : null}</span></span>
      <span className="status-toggle-label">{busy ? "更新中" : known ? (enabled ? "启用" : "停用") : "未知"}</span>
    </button>
  );
}

function LoginMethodBadge({ job }) {
  if (job.poolOnly) {
    return <span className="mail-mode unknown-mode"><Database size={11} />仅号池</span>;
  }
  if (job.loginMode === "password") {
    const methods = ["密码", job.hasTotpKey ? "2FA" : "", job.autoEmailOtp ? "自动收码" : ""].filter(Boolean);
    return (
      <span className="mail-mode password-mode">
        {job.hasTotpKey ? <ShieldCheck size={11} /> : <KeyRound size={11} />}
        {methods.join(" · ")}
      </span>
    );
  }
  if (job.autoEmailOtp) {
    return (
      <span className={`mail-mode ${["error", "timeout"].includes(job.mailStatus) ? "error" : ""}`}>
        {job.hasTotpKey ? <ShieldCheck size={11} /> : <MailCheck size={11} />}
        {job.hasTotpKey ? "自动收码 · 2FA" : "自动收码"}
      </span>
    );
  }
  if (job.loginMode === "manual") {
    return (
      <span className="mail-mode unknown-mode">
        <CircleAlert size={11} />未记录凭据
      </span>
    );
  }
  if (!job.hasTotpKey) return null;
  return (
    <span className="mail-mode">
      <ShieldCheck size={11} />邮箱码 · 2FA
    </span>
  );
}

function getInputConfig(status, currentPhone) {
  if (status === "password") {
    return { action: "password", placeholder: "输入账号密码", submitLabel: "提交密码", inputMode: "text", type: "password", autoComplete: "current-password", icon: <KeyRound size={15} /> };
  }
  if (status === "mfa_otp") {
    return { action: "mfa_otp", placeholder: "6 位 2FA 验证码", submitLabel: "提交 2FA 验证码", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "totp_setup_otp") {
    return { action: "totp_setup_otp", placeholder: "新 2FA 的 6 位验证码", submitLabel: "激活新的 2FA", inputMode: "numeric", icon: <ShieldCheck size={15} /> };
  }
  if (status === "email_otp") {
    return { action: "email_otp", placeholder: "6 位邮箱验证码", submitLabel: "提交邮箱验证码", inputMode: "numeric", icon: <Mail size={15} /> };
  }
  if (status === "phone") {
    return { action: "phone", placeholder: "+60123456789", submitLabel: "发送手机验证码", inputMode: "tel", icon: <Smartphone size={15} /> };
  }
  if (status === "phone_otp") {
    return { action: "phone_otp", placeholder: currentPhone ? `${currentPhone} 的验证码` : "手机验证码", submitLabel: "提交手机验证码", inputMode: "numeric", icon: <Smartphone size={15} /> };
  }
  return null;
}

function smsStatusText(job) {
  const providerName = job.smsProviderName || "接码平台";
  if (job.smsError) return `${providerName}：${job.smsError}`;
  return {
    requesting: `${providerName}：正在获取手机号`,
    number_acquired: `${providerName}：已获取手机号，正在发送验证码`,
    waiting_sms: `${providerName}：验证码已发送，正在等待短信`,
    submitting: `${providerName}：已收到验证码，正在自动提交`,
    submitted: `${providerName}：验证码已自动提交`,
    manual_submitted: `${providerName}：已停止自动读取，正在验证手动输入的验证码`,
    completed: `${providerName}：手机验证已通过，订单已完成`,
  }[job.smsStatus] || `${providerName}：处理中`;
}

async function saveDownloadResponse(response, fallbackName) {
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = downloadFilename(response.headers.get("content-disposition")) || fallbackName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function downloadFilename(contentDisposition) {
  if (!contentDisposition) return "";
  const encodedMatch = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(contentDisposition);
  const rawName = encodedMatch?.[1] || plainMatch?.[1] || plainMatch?.[2] || "";
  try {
    return decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_");
  } catch {
    return rawName.trim().replace(/^"|"$/g, "").replace(/[\\/]/g, "_");
  }
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatProfileSyncNotice(sync) {
  const planTypes = (sync.planTypes || []).join("、");
  const fields = (sync.fieldLabels || []).join("、");
  const parts = [];
  if (fields) {
    parts.push(`已将方案变更（${fields}）同步到 ${planTypes} 的号池账号：更新 ${Number(sync.updated || 0)} / ${Number(sync.matched || 0)} 条`);
  }
  if (sync.failed) parts.push(`失败 ${sync.failed} 条`);
  if (sync.incomplete) parts.push("Sub2API 账号列表不完整，可能有账号未更新");
  if (sync.skippedFieldLabels?.length) parts.push(`${sync.skippedFieldLabels.join("、")}已清空，号池账号保留原值`);
  if (sync.error) parts.push(sync.error);
  return parts.join("；") || "配置已保存";
}

function formatMonitorResult(result) {
  if (!result || typeof result !== "object") return "号池巡检已完成";
  const parts = [`检查 ${Number(result.checked || 0)} 条异常记录`];
  if (result.started) parts.push(`已启动自动修复 ${result.started} 条`);
  if (result.updated) parts.push(`已更新 ${result.updated} 条`);
  if (result.planTypeUpdated) parts.push(`已按订阅方案更新 ${result.planTypeUpdated} 条`);
  if (result.planTypeSkipped) parts.push(`订阅方案未绑定 ${result.planTypeSkipped} 条`);
  if (result.planTypeUpdateFailed) parts.push(`订阅方案更新失败 ${result.planTypeUpdateFailed} 条`);
  if (result.proxyFallbackUpdated) parts.push(`代理失效回退 ${result.proxyFallbackUpdated} 条`);
  if (result.proxyFallbackFailed) parts.push(`代理回退失败 ${result.proxyFallbackFailed} 条`);
  if (result.planTypeScanIncomplete) parts.push("订阅扫描不完整，已保留上次基线");
  if (result.blocked) parts.push(`永久跳过 ${result.blocked} 条`);
  if (result.ineligible) parts.push(`需人工 ${result.ineligible} 条`);
  if (result.missingTask) parts.push(`本地无任务 ${result.missingTask} 条`);
  if (result.busy) parts.push(`正在运行 ${result.busy} 条`);
  if (result.cooldown) parts.push(`冷却中 ${result.cooldown} 条`);
  return parts.join("，");
}

function formatRelativeMonitorTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "刚刚检查";
  if (elapsed < 60_000) return "刚刚检查";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前检查`;
  return `${Math.floor(elapsed / (60 * 60_000))} 小时前检查`;
}

async function apiFetch(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-console-token": token,
      ...(options.headers || {}),
    },
  });
  return readResponse(response);
}

async function copyText(value) {
  const text = String(value ?? "");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

async function readResponse(response) {
  return readJsonResponse(response);
}

function shortId(id) {
  return `#${id.slice(0, 8)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(isToday ? {} : { month: "2-digit", day: "2-digit" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatTimeParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "-", time: "" };
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return {
    date: `${month}/${day}`,
    time: `${hours}:${minutes}:${seconds}`,
  };
}

function operationLabel(type) {
  return ({
    initial_authorization: "首次授权",
    reauthorize: "重新授权",
    relogin: "重新登录并授权",
    web_login: "Web 登录",
    automatic_relogin: "号池自动重登并授权",
    resume: "继续中断流程",
    setup_2fa: "设置 2FA",
    replace_2fa: "更换 2FA",
    add_password: "添加密码",
    account_update: "更新账号资料",
    proxy_update: "更新代理 IP",
    cooldown: "账号冷却",
  })[type] || "账号操作";
}

function countBatchLines(value) {
  return String(value || "").split(/\r?\n/).filter((line) => line.trim()).length;
}

function parseEmailFilter(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一个筛选邮箱");
  if (lines.length > 500) throw new Error("一次最多筛选 500 个邮箱");
  lines.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error(`第 ${index + 1} 行邮箱格式错误`);
    }
  });
  return [...new Set(lines)];
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function readLocalSetting(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function normalizeTotpForDisplay(secret) {
  let value = String(secret || "").trim();
  if (/^otpauth:\/\//i.test(value)) {
    try {
      value = new URL(value).searchParams.get("secret") || "";
    } catch {
      return "";
    }
  }
  const normalized = value.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized) ? normalized : "";
}

function decodeTotpBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const output = [];
  let buffer = 0;
  let bits = 0;
  for (const character of secret) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("2FA 密钥不是有效的 Base32 格式");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

async function generateTotpCode(secret, timestamp = Date.now()) {
  const normalized = normalizeTotpForDisplay(secret);
  if (!normalized) throw new Error("2FA 密钥不是有效的 Base32 格式");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前浏览器不支持生成动态验证码");
  const keyBytes = decodeTotpBase32(normalized);
  const counter = Math.floor(Number(timestamp) / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const counterView = new DataView(counterBytes);
  counterView.setUint32(0, Math.floor(counter / 0x100000000));
  counterView.setUint32(4, counter >>> 0);
  const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await subtle.sign("HMAC", key, counterBytes));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function normalizePlanTypeMapping(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  Object.entries(source).slice(0, 100).forEach(([raw, label]) => {
    const normalizedRaw = String(raw || "").trim();
    const normalizedLabel = String(label || "").trim();
    if (normalizedRaw && normalizedLabel && normalizedRaw.length <= 128 && normalizedLabel.length <= 128) {
      result[normalizedRaw] = normalizedLabel;
    }
  });
  return result;
}

function hasCustomPlanTypeMapping(value) {
  const mapping = normalizePlanTypeMapping(value);
  return Object.entries(mapping).some(([raw, label]) => DEFAULT_PLAN_TYPE_MAPPING[raw] !== label);
}

function readPlanTypeMapping() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PLAN_TYPE_MAPPING_STORAGE_KEY) || "null");
    const normalized = normalizePlanTypeMapping(stored);
    if (Object.keys(normalized).length) {
      const usageBasedLabel = normalized.self_serve_business_usage_based;
      if (usageBasedLabel && /business\s+pre(?:mium|nium)/i.test(usageBasedLabel)) {
        delete normalized.self_serve_business_usage_based;
      }
      return { ...DEFAULT_PLAN_TYPE_MAPPING, ...normalized };
    }
  } catch {}
  return { ...DEFAULT_PLAN_TYPE_MAPPING };
}

function planTypeMappingRows(mapping) {
  return Object.entries(normalizePlanTypeMapping(mapping)).map(([raw, label]) => ({ raw, label }));
}

function formatPlanTypeLabel(value, mapping = DEFAULT_PLAN_TYPE_MAPPING) {
  const raw = String(value || "").trim();
  if (!raw) return "未知";
  return normalizePlanTypeMapping(mapping)[raw] || raw;
}

function readLocalTextSetting(key) {
  let value = readLocalSetting(key).trim();
  for (let attempt = 0; attempt < 4 && value; attempt += 1) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return value;
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") return value;
      value = decoded.trim();
    } catch {
      return value;
    }
  }
  return value;
}

function readSmsProviderSettings() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SMS_PROVIDER_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object" && stored.configs && typeof stored.configs === "object") {
      return stored;
    }
  } catch {}
  return {
    selectedProviderId: "luban",
    configs: {
      luban: {
        apiKey: readLocalSetting(LUBAN_API_KEY_STORAGE_KEY),
        serviceId: readLocalSetting(LUBAN_SERVICE_ID_STORAGE_KEY),
      },
    },
  };
}

function normalizeMailRequestSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  let headersText = typeof stored.headersText === "string" ? stored.headersText : "";
  if (!headersText && stored.headers && typeof stored.headers === "object" && !Array.isArray(stored.headers)) {
    headersText = JSON.stringify(stored.headers, null, 2);
  }
  return {
    method: String(stored.method || "GET").toUpperCase() === "POST" ? "POST" : "GET",
    url: typeof stored.url === "string" ? stored.url.trim() : "",
    headersText: headersText.trim() || "{}",
  };
}

function readMailRequestSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(MAIL_REQUEST_SETTINGS_KEY) || "null");
    return normalizeMailRequestSettings(stored);
  } catch {
    return normalizeMailRequestSettings({});
  }
}

function buildMailRequestConfig(settings) {
  const normalized = normalizeMailRequestSettings(settings);
  let headers;
  try {
    headers = JSON.parse(normalized.headersText || "{}");
  } catch {
    throw new Error("请求头必须是有效的 JSON 对象");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("请求头必须是 JSON 对象，例如 {\"Authorization\":\"Bearer ...\"}");
  }
  if (normalized.method === "POST") {
    try {
      const parsedUrl = new URL(normalized.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error();
    } catch {
      throw new Error("POST 模式必须填写有效的 HTTP 或 HTTPS 请求 URL");
    }
  }
  return {
    method: normalized.method,
    url: normalized.method === "POST" ? normalized.url : "",
    headers,
  };
}

function formatMailRequestSummary(settings) {
  try {
    const config = buildMailRequestConfig(settings);
    const headerCount = Object.keys(config.headers).length;
    return `${config.method === "POST" ? "已配置统一 URL · " : ""}${headerCount} 个请求头`;
  } catch {
    return "配置需要检查";
  }
}

function normalizeSub2ApiSettings(value) {
  const stored = value && typeof value === "object" ? value : {};
  const rawGroupIds = Array.isArray(stored.groupIds)
    ? stored.groupIds
    : String(stored.groupId || "").trim()
      ? [stored.groupId]
      : [];
  const rawWsMode = stored.wsMode ?? stored.openaiWsMode ?? stored.openaiOAuthResponsesWebsocketsV2Mode;
  const wsMode = String(rawWsMode ?? "off").trim().toLowerCase();
  const legacyProfile = {
    id: "default",
    name: "默认方案",
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: String(stored.proxyId || ""),
    concurrency: String(stored.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? ""),
    priority: String(stored.priority ?? ""),
    importDatePriority: normalizeImportDatePrioritySettings(stored.importDatePriority),
    accountNameTemplate: String(stored.accountNameTemplate || ""),
    modelWhitelist: String(stored.modelWhitelist || ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : "session",
    autoResetCreditEnabled: stored.autoResetCreditEnabled === true,
    autoResetCredit5hThresholdPercent: String(stored.autoResetCredit5hThresholdPercent ?? 100),
    autoResetCredit7dThresholdPercent: String(stored.autoResetCredit7dThresholdPercent ?? 100),
    wsMode: SUB2API_WS_MODES.has(wsMode) ? wsMode : "off",
  };
  const rawProfiles = Array.isArray(stored.profiles) ? stored.profiles : [];
  const profiles = rawProfiles.length
    ? rawProfiles.map((profile, index) => normalizeSub2ApiProfile(profile, index, legacyProfile))
    : [legacyProfile];
  const activeProfileId = profiles.some((profile) => profile.id === String(stored.activeProfileId || ""))
    ? String(stored.activeProfileId)
    : profiles[0].id;
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) || profiles[0];
  const planTypeBindings = stored.planTypeBindings && typeof stored.planTypeBindings === "object"
    ? Object.fromEntries(Object.entries(stored.planTypeBindings)
      .map(([planType, profileId]) => [String(planType).trim(), String(profileId).trim()])
      .filter(([planType, profileId]) => planType && profiles.some((profile) => profile.id === profileId)))
    : {};
  return {
    baseUrl: String(stored.baseUrl || ""),
    adminApiKey: String(stored.adminApiKey || ""),
    ...activeProfile,
    profiles,
    activeProfileId,
    planTypeBindings,
    hasStoredAdminApiKey: stored.hasStoredAdminApiKey === true,
    monitorEnabled: stored.monitorEnabled === true,
  };
}

function normalizeSub2ApiProfile(value, index = 0, fallback = {}) {
  const stored = value && typeof value === "object" ? value : {};
  const fallbackProfile = fallback && typeof fallback === "object" ? fallback : {};
  const rawGroupIds = Array.isArray(stored.groupIds) ? stored.groupIds : fallbackProfile.groupIds || [];
  const rawProxyId = stored.proxyId ?? fallbackProfile.proxyId ?? "";
  const wsMode = String(stored.wsMode ?? fallbackProfile.wsMode ?? "off").trim().toLowerCase();
  return {
    id: String(stored.id || `profile-${index + 1}`).trim() || `profile-${index + 1}`,
    name: String(stored.name || `方案 ${index + 1}`),
    groupIds: [...new Set(rawGroupIds.map((id) => String(id).trim()).filter(Boolean))],
    proxyId: rawProxyId === 0 || String(rawProxyId).trim() === "0" ? "" : String(rawProxyId),
    concurrency: String(stored.concurrency ?? fallbackProfile.concurrency ?? ""),
    loadFactor: String(stored.loadFactor ?? fallbackProfile.loadFactor ?? ""),
    priority: String(stored.priority ?? fallbackProfile.priority ?? ""),
    importDatePriority: normalizeImportDatePrioritySettings(stored.importDatePriority ?? fallbackProfile.importDatePriority),
    accountNameTemplate: String(stored.accountNameTemplate ?? fallbackProfile.accountNameTemplate ?? ""),
    modelWhitelist: String(stored.modelWhitelist ?? fallbackProfile.modelWhitelist ?? ""),
    codexFingerprintMode: ["off", "device", "session", "full"].includes(stored.codexFingerprintMode)
      ? stored.codexFingerprintMode
      : fallbackProfile.codexFingerprintMode || "session",
    autoResetCreditEnabled: stored.autoResetCreditEnabled ?? fallbackProfile.autoResetCreditEnabled ?? false,
    autoResetCredit5hThresholdPercent: String(stored.autoResetCredit5hThresholdPercent ?? fallbackProfile.autoResetCredit5hThresholdPercent ?? 100),
    autoResetCredit7dThresholdPercent: String(stored.autoResetCredit7dThresholdPercent ?? fallbackProfile.autoResetCredit7dThresholdPercent ?? 100),
    wsMode: SUB2API_WS_MODES.has(wsMode) ? wsMode : "off",
  };
}

function normalizeImportDatePrioritySettings(value) {
  return { enabled: value?.enabled === true, min: String(value?.min ?? 2), max: String(value?.max ?? 5) };
}

function hasUsableSub2ApiSettings(settings) {
  return Boolean(settings?.baseUrl && (settings.adminApiKey || settings.hasStoredAdminApiKey));
}

function mergeServerSub2ApiSettings(current, serverState) {
  const serverConfig = serverState?.config && typeof serverState.config === "object"
    ? serverState.config
    : {};
  const serverHasSettingsState = typeof serverState?.hasAdminApiKey === "boolean"
    || serverState?.config !== undefined;
  const hasStoredAdminApiKey = serverHasSettingsState
    ? serverState?.hasAdminApiKey === true
    : current.hasStoredAdminApiKey === true;
  const serverProfiles = Array.isArray(serverState?.profiles)
    ? serverState.profiles
    : undefined;
  const serverPlanTypeBindings = serverState?.planTypeBindings
    && typeof serverState.planTypeBindings === "object"
    && !Array.isArray(serverState.planTypeBindings)
    ? serverState.planTypeBindings
    : undefined;
  return normalizeSub2ApiSettings({
    ...current,
    ...serverConfig,
    ...(typeof serverState?.baseUrl === "string" ? { baseUrl: serverState.baseUrl } : {}),
    ...(serverProfiles ? { profiles: serverProfiles } : {}),
    ...(serverPlanTypeBindings ? { planTypeBindings: serverPlanTypeBindings } : {}),
    ...(typeof serverState?.activeProfileId === "string" ? { activeProfileId: serverState.activeProfileId } : {}),
    adminApiKey: serverHasSettingsState ? "" : (hasStoredAdminApiKey ? "" : current.adminApiKey),
    hasStoredAdminApiKey,
    monitorEnabled: serverState?.monitorEnabled !== undefined
      ? serverState.monitorEnabled === true
      : serverState?.enabled !== undefined
        ? serverState.enabled === true
        : current.monitorEnabled,
  });
}

function readSub2ApiSettings(value) {
  try {
    const stored = value || JSON.parse(window.localStorage.getItem(SUB2API_UPLOAD_SETTINGS_KEY) || "null");
    if (stored && typeof stored === "object") return normalizeSub2ApiSettings(stored);
  } catch {}
  return normalizeSub2ApiSettings({});
}

function formatSub2ApiProxy(proxy) {
  const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "");
  const host = String(proxy.host || "");
  const port = proxy.port ? `:${proxy.port}` : "";
  const endpoint = host ? `${protocol}://${host}${port}` : "地址未知";
  const ip = String(proxy.ipAddress || "").trim();
  return `${proxy.name || `代理 ${proxy.id}`} | ${endpoint}${ip ? ` | 出口 IP：${ip}` : ""}`;
}

function formatSub2ApiGroupPlatform(platform) {
  const value = String(platform || "").trim().toLowerCase();
  return value === "composite" ? "Composite" : value === "openai" ? "OpenAI" : value || "未知平台";
}

function withSmsProviderDefaults(definitions, settings) {
  const configs = { ...(settings?.configs || {}) };
  definitions.forEach((provider) => {
    const current = { ...(configs[provider.id] || {}) };
    provider.fields.forEach((field) => {
      if (!String(current[field.key] || "").trim() && field.defaultValue) current[field.key] = field.defaultValue;
    });
    configs[provider.id] = current;
  });
  const selectedProviderId = definitions.some((provider) => provider.id === settings?.selectedProviderId)
    ? settings.selectedProviderId
    : definitions[0]?.id || settings?.selectedProviderId || "luban";
  return { selectedProviderId, configs };
}

function resolveSmsProvider(definitions, settings) {
  const normalized = withSmsProviderDefaults(definitions, settings || {});
  const definition = definitions.find((provider) => provider.id === normalized.selectedProviderId) || null;
  const config = definition ? normalized.configs[definition.id] || {} : {};
  const requiredFieldsReady = Boolean(definition) && definition.fields.every((field) => (
    field.required === false || String(config[field.key] || "").trim()
  ));
  const customEntries = definition?.id === "custom" ? inspectCustomSmsEntries(config.entries) : null;
  const ready = requiredFieldsReady && !customEntries?.error;
  const summary = definition?.id === "custom"
    ? (customEntries?.count ? `${customEntries.count} 个号码` : "")
    : definition
    ? definition.fields
      .filter((field) => field.summary || field.summaryKey)
      .map((field) => config[field.summaryKey || field.key])
      .filter(Boolean)
      .join(" / ")
    : "";
  return {
    id: definition?.id || "",
    name: definition?.name || "",
    definition,
    config,
    ready,
    summary,
  };
}

function inspectCustomSmsEntries(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { count: 0, error: "请粘贴至少一条手机号和接码 API" };
  if (lines.length > 500) return { count: 0, error: "自定义接码一次最多导入 500 条" };
  const phones = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const delimiterAt = lines[index].indexOf("----");
    if (delimiterAt < 0) return { count: 0, error: `第 ${index + 1} 行格式错误，请使用 手机号----接码API` };
    const phone = lines[index].slice(0, delimiterAt).trim();
    const apiUrl = lines[index].slice(delimiterAt + 4).trim();
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
      return { count: 0, error: `第 ${index + 1} 行手机号必须使用 +861871291167 这种国际格式` };
    }
    try {
      const parsed = new URL(apiUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    } catch {
      return { count: 0, error: `第 ${index + 1} 行接码 API 必须是有效的 HTTP 或 HTTPS 地址` };
    }
    phones.add(phone);
  }
  return { count: phones.size, error: "" };
}

function formatSmsCountryName(option) {
  if (option.iso && REGION_NAMES) {
    try {
      return REGION_NAMES.of(option.iso) || option.title;
    } catch {}
  }
  return option.title || `国家 ${option.country}`;
}

function formatSmsPriceOption(option) {
  const name = formatSmsCountryName(option);
  return `${name} | 价格 ${option.price} | 库存 ${option.count}`;
}

function writeLocalJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function writeLocalTextSetting(key, value) {
  try {
    window.localStorage.setItem(key, String(value || ""));
  } catch {
    // Private browsing modes may disable localStorage; the current tab still works.
  }
}

function proxyDistributionByIp(proxies) {
  const groups = new Map();
  for (const proxy of proxies) {
    const ipAddress = proxy.ipAddress || `${proxy.host}:${proxy.port}`;
    let group = groups.get(ipAddress);
    if (!group) { group = { ipAddress, names: [], accountCount: 0 }; groups.set(ipAddress, group); }
    if (!group.names.includes(proxy.name)) group.names.push(proxy.name);
    // The API already aggregates accounts across all nodes sharing this exit IP.
    group.accountCount = Math.max(group.accountCount, proxy.accountCount || 0);
  }
  return [...groups.values()];
}

function BoundProxyCell({ job }) {
  const proxies = Array.isArray(job.boundProxies) ? job.boundProxies : (job.boundIps || []).map((ipAddress) => ({ id: ipAddress, ipAddress, name: "" }));
  const label = job.banProxyReleasePending ? "解绑待重试" : job.boundProxyStatus === "direct" ? "直连" : job.boundProxyStatus === "bound" ? "待获取" : "未绑定";
  const visible = job.boundProxyStatus === "direct" ? [] : proxies;
  return <td className="bound-ip-cell" title={visible.length ? visible.map((proxy) => `${proxy.name}${proxy.ipAddress ? ` · ${proxy.ipAddress}` : ""}`).join("、") : label}>
    {visible.length ? visible.map((proxy) => <span className="bound-proxy" key={proxy.id}>
      {proxy.name && <span className="bound-proxy-name">{proxy.name}</span>}
      <span className="bound-proxy-ip">{proxy.ipAddress || "出口 IP 待获取"}</span>
    </span>) : <span className="muted">{label}</span>}
  </td>;
}

function sub2ApiStatusJobFields(status) {
  const fields = {
    sub2apiInPool: status?.inPool ?? null,
    sub2apiEnabled: status?.enabled ?? null,
    sub2apiPriority: status?.priority ?? null,
    sub2apiAccountId: status?.accountId || null,
    sub2apiAccountIds: Array.isArray(status?.accountIds) ? status.accountIds : [],
    ...(Array.isArray(status?.boundIps) ? { boundIps: status.boundIps, boundProxyStatus: status.boundProxyStatus || (status.proxyIds?.length ? "bound" : "direct") } : {}),
    ...(status?.accountBlocked ? { autoRepairBlocked: true, autoRepairBlockedReason: status.accountBlockReason, webSessionStatus: "banned", canLoginWeb: false } : {}),
    ...(Array.isArray(status?.boundProxies) ? { boundProxies: status.boundProxies } : {}),
    sub2apiGroupIds: Array.isArray(status?.groupIds) ? status.groupIds : [],
    sub2apiRemoteStatus: status?.remoteStatus || null,
    sub2apiUsage: status?.usage || null,
    // Keep the remote PlanType separate from the local account/workspace
    // PlanType. A workspace switch updates the local OAuth bundle first, while
    // Sub2API may still be serving its previous snapshot until the account
    // update completes. Overwriting `planType` here caused the table to
    // oscillate on every 15-second status refresh.
    sub2apiPlanType: String(status?.sub2apiPlanType || status?.planType || "").trim() || null,
  };
  if (typeof status?.remark === "string") fields.remark = status.remark;
  return fields;
}

function mergeSub2ApiStatusIntoJob(job, state) {
  if (!state?.fetchedAt) return job;
  const key = String(job.email || "").toLowerCase();
  const status = state.accounts?.[key];
  if (!status) return { ...job, ...sub2ApiStatusJobFields({ inPool: false }), sub2apiPlanType: null };
  const fields = sub2ApiStatusJobFields(status);
  if (Date.parse(state.fetchedAt) < Date.parse(job.updatedAt || "")) delete fields.remark;
  // `planType` is the account's currently selected workspace and is supplied
  // by the completed local OAuth output. Only use the remote value as a
  // fallback for legacy jobs that never persisted a local PlanType.
  const localPlanType = String(job.workspacePlanType || job.planType || "").trim();
  if (!localPlanType && fields.sub2apiPlanType) fields.planType = fields.sub2apiPlanType;
  return { ...job, ...fields };
}

function mergeJobs(...groups) {
  const unique = new Map();
  groups.flat().forEach((job) => {
    if (!unique.has(job.id)) unique.set(job.id, job);
  });
  return [...unique.values()];
}

const appRoot = globalThis.__chatgptOnboardingRoot || createRoot(document.getElementById("root"));
globalThis.__chatgptOnboardingRoot = appRoot;
appRoot.render(<App />);
