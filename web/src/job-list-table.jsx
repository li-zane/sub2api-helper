import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Filter, Mail } from "lucide-react";
import { AnchoredPopover } from "./anchored-popover.jsx";
import { OVERLOAD_FILTER_LABELS, FINGERPRINT_FILTER_LABELS } from "./codex-status-filter.mjs";
import { JOB_STATUS_LABELS, SUB2API_POOL_FILTER_LABELS, SUB2API_ENABLED_FILTER_LABELS } from "./job-list-filters.mjs";
import { formatPlanTypeLabel } from "./plan-type-label.mjs";

export function JobListTable({ list, selectionEnabled, paginationEnabled, operationPending, planTypeMapping, renderRow }) {
  const {
    jobs, hasJobFilters, allPageSelected, pageJobIds, displaySelectedIds, toggleJobSelection, toggleAllOnPage, listPhase,
    applyColumnFilter, page, setPage, pagination, availablePlanTypes,
    accountTypeFilter, planTypeFilter, planTypeUnknown, sub2apiPoolFilter, sub2apiPoolOptions, sub2apiEnabledFilter,
    sub2apiEnabledOptions, statusFilter, statusOptions, overloadFilter, fingerprintFilter,
  } = list;
  const isLoading = listPhase === "loading";
  const statusText = isLoading
    ? "正在更新账号列表…"
    : listPhase === "error" ? "账号列表更新失败，等待重试。" : "";
  return (
    <>
      <div className="job-list-status" role="status">{statusText}</div>
      <div className="table-frame">
            <table aria-busy={isLoading}>
            <colgroup>
              <col className="select-column" />
              <col className="account-column" />
              <col className="plan-column" />
              <col className="usage-column" />
              <col className="pool-column" />
              <col className="status-column" />
              <col className="step-column" />
              <col className="time-column" />
              <col className="time-column" />
              <col className="bound-ip-column" />
              <col className="codex-status-column" />
              <col className="actions-column" />
            </colgroup>
            <thead>
              <tr>
                <th className="select-heading">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllOnPage}
                    disabled={!selectionEnabled || !pageJobIds.size || operationPending}
                    aria-label="选择当前页全部任务"
                  />
                </th>
                <th className="account-heading">
                  <div className="column-filter-heading">
                    <span>账号</span>
                    <ColumnHeaderFilter
                      title="账号"
                      value={accountTypeFilter}
                      onChange={(v) => applyColumnFilter("accountType", v)}
                      options={[
                        { value: "", label: "全部" },
                        { value: "password_totp", label: "密码 + 2FA" },
                        { value: "pool_only", label: "仅号池" },
                      ]}
                      activeLabel={accountTypeFilter === "password_totp" ? "密码+2FA" : accountTypeFilter === "pool_only" ? "仅号池" : "全部"}
                    />
                  </div>
                </th>
                <th className="plan-heading">
                  <div className="column-filter-heading">
                    <span>Plan type</span>
                    <ColumnHeaderFilter
                      title="Plan type"
                      value={planTypeFilter}
                      onChange={(v) => applyColumnFilter("planType", v)}
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
                <th className="pool-heading">
                  <div className="column-filter-heading">
                    <span>号池</span>
                    <ColumnHeaderFilter
                      title="号池"
                      value={sub2apiPoolFilter}
                      onChange={(v) => applyColumnFilter("sub2apiPool", v)}
                      options={[
                        { value: "", label: "全部" },
                        ...sub2apiPoolOptions.map((value) => ({ value, label: SUB2API_POOL_FILTER_LABELS[value] })),
                      ]}
                      activeLabel={sub2apiPoolFilter ? SUB2API_POOL_FILTER_LABELS[sub2apiPoolFilter] : "全部"}
                    />
                    <ColumnHeaderFilter
                      title="启用"
                      value={sub2apiEnabledFilter}
                      onChange={(v) => applyColumnFilter("sub2apiEnabled", v)}
                      options={[
                        { value: "", label: "全部" },
                        ...sub2apiEnabledOptions.map((value) => ({ value, label: SUB2API_ENABLED_FILTER_LABELS[value] })),
                      ]}
                      activeLabel={sub2apiEnabledFilter ? SUB2API_ENABLED_FILTER_LABELS[sub2apiEnabledFilter] : "全部"}
                    />
                  </div>
                </th>
                <th className="status-heading">
                  <div className="column-filter-heading">
                    <span>状态</span>
                    <ColumnHeaderFilter
                      title="状态"
                      value={statusFilter}
                      onChange={(v) => applyColumnFilter("status", v)}
                      options={[
                        { value: "", label: "全部" },
                        ...statusOptions.map((value) => ({ value, label: JOB_STATUS_LABELS[value] || value })),
                      ]}
                      activeLabel={statusFilter ? (JOB_STATUS_LABELS[statusFilter] || statusFilter) : "全部"}
                    />
                  </div>
                </th>
                <th className="recent-operation-heading">最近操作</th>
                <th className="recent-operation-time-heading">最近操作时间</th>
                <th className="added-time-heading">添加时间</th>
                <th className="bound-ip-heading">绑定 IP</th>
                <th className="codex-status-heading" aria-label="Codex 状态">
                  <div className="column-filter-heading codex-status-filters">
                    <span className="codex-status-title">Codex 状态</span>
                    <ColumnHeaderFilter title="过载" buttonLabel="过载" value={overloadFilter}
                      onChange={value => applyColumnFilter("overload", value)}
                      options={[{ value: "", label: "全部" }, ...Object.entries(OVERLOAD_FILTER_LABELS).map(([value, label]) => ({ value, label }))]}
                      activeLabel={OVERLOAD_FILTER_LABELS[overloadFilter] || "全部"} align="right" />
                    <ColumnHeaderFilter title="降智" buttonLabel="降智" value={fingerprintFilter}
                      onChange={value => applyColumnFilter("fingerprint", value)}
                      options={[{ value: "", label: "全部" }, ...Object.entries(FINGERPRINT_FILTER_LABELS).map(([value, label]) => ({ value, label }))]}
                      activeLabel={FINGERPRINT_FILTER_LABELS[fingerprintFilter] || "全部"} align="right" />
                  </div>
                </th>
                <th className="actions-heading">操作</th>
              </tr>
            </thead>
            <tbody>
              {!jobs.length && !statusText && <EmptyState filtered={hasJobFilters} />}
              {jobs.map((job) => (
                renderRow(job, {
                  selected: displaySelectedIds.has(job.id),
                  canSelect: pageJobIds.has(job.id),
                  onToggleSelected: () => toggleJobSelection(job.id),
                })
              ))}
            </tbody>
        </table>
      </div>
      {paginationEnabled && pagination.totalPages > 1 && (
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
    </>
  );
}

function ColumnHeaderFilter({ title, value, onChange, options, activeLabel, align = "left", buttonLabel }) {
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
        {buttonLabel && <span>{buttonLabel}</span>}
        <Filter size={11} className="column-filter-icon" aria-hidden="true" />
        {active && <span className="column-filter-dot" aria-hidden="true" />}
      </button>

      {open && (
        <AnchoredPopover className={`column-filter-dropdown align-${align}`} role="menu" aria-label={`筛选${title}`} anchorRef={containerRef} align={align} onClose={() => setOpen(false)}>
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
        </AnchoredPopover>
      )}
    </div>
  );
}

function EmptyState({ filtered = false }) {
  return (
    <tr>
      <td colSpan="12">
        <div className="empty-state">
          <div className="empty-state-icon"><Mail size={24} /></div>
          <h3>{filtered ? "没有匹配账号" : "暂无授权任务"}</h3>
          <p>{filtered ? "没有符合当前搜索或筛选条件的账号，请调整条件或清除筛选。" : "点击右上方“批量添加”导入一个或多个账号。"}</p>
        </div>
      </td>
    </tr>
  );
}
