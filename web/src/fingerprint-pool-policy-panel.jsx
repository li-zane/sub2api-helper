import React, { useEffect, useId, useMemo, useRef } from "react";
import { formatPlanTypeLabel } from "./plan-type-label.mjs";
import {
  PRIORITY_STEP_FIELDS,
  createDefaultPolicyDraft,
  isPriorityAllEmpty,
  policyToDraft,
  resolveProfilePlanTypes,
  togglePolicyDraftSwitch,
  validatePolicyDraft,
} from "./fingerprint-pool-policy.mjs";
import "./fingerprint-pool-policy.css";

function getTabStatusSummary({ draft, residual, hasError }) {
  if (residual) return "残留策略，仅查看或移除";
  if (hasError) return "存在输入错误";
  const parts = [];
  if (draft?.concurrency?.enabled) parts.push("已启用独立并发");
  if (draft?.priority?.enabled) parts.push("已启用分级优先级");
  return parts.join("、");
}

export function FingerprintPoolPolicyPanel({
  activeProfile,
  profiles = [],
  planTypeBindings = {},
  availablePlanTypes = [],
  planTypeMapping = {},
  draftsByKey = {},
  removedResidualKeys = [],
  selectedPlanType = "",
  onSelectPlanType,
  onChangeDraft,
  onRemoveResidual,
  focusRequest = null,
  onHandledFocusRequest,
  disabled = false,
  headerTip = null,
}) {
  const baseId = useId();
  const tabRefs = useRef(new Map());
  const inputRefs = useRef(new Map());

  const activeProfileId = String(activeProfile?.id ?? "");
  const savedPolicies = activeProfile?.fingerprintPoolPolicies || {};

  const { allTabs } = useMemo(() => resolveProfilePlanTypes({
    activeProfileId,
    profiles,
    planTypeBindings,
    availablePlanTypes,
    savedPolicies,
    removedResidualKeys,
  }), [activeProfileId, profiles, planTypeBindings, availablePlanTypes, savedPolicies, removedResidualKeys]);

  const activeTab = useMemo(() => {
    if (!allTabs.length) return null;
    return allTabs.find((tab) => tab.key === selectedPlanType) || allTabs[0];
  }, [allTabs, selectedPlanType]);

  // Keep parent selection synchronized when bindings or profile change.
  useEffect(() => {
    if (!allTabs.length) return;
    if (!selectedPlanType || !allTabs.some((tab) => tab.key === selectedPlanType)) {
      onSelectPlanType?.(allTabs[0].key);
    }
  }, [allTabs, selectedPlanType, onSelectPlanType]);

  const tabMetaMap = useMemo(() => {
    const map = new Map();
    for (const tab of allTabs) {
      const draft = tab.residual
        ? policyToDraft(savedPolicies[tab.key])
        : (draftsByKey[tab.key] || policyToDraft(savedPolicies[tab.key]) || createDefaultPolicyDraft());
      const validation = tab.residual
        ? { valid: true, errors: { concurrency: "", matchedFirstTrip: "", mismatchedFirstTrip: "", matchedLongTerm: "" } }
        : validatePolicyDraft(draft);

      map.set(tab.key, {
        draft,
        errors: validation.errors,
        hasError: !validation.valid,
        isActiveDot: !tab.residual && validation.valid && (Boolean(draft.concurrency?.enabled) || Boolean(draft.priority?.enabled)),
      });
    }
    return map;
  }, [allTabs, draftsByKey, savedPolicies]);

  // Auto-scroll selected tab into view for narrow horizontal tablists.
  useEffect(() => {
    if (!activeTab) return;
    const tabEl = tabRefs.current.get(activeTab.key);
    if (!tabEl || typeof tabEl.scrollIntoView !== "function") return;
    const reduceMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tabEl.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTab?.key]);

  // Handle cross-tab validation failure focus target.
  useEffect(() => {
    if (!focusRequest || focusRequest.profileId !== activeProfileId) return;
    if (!activeTab || activeTab.key !== focusRequest.planType) return;
    const inputEl = inputRefs.current.get(`${activeTab.key}:${focusRequest.field}`);
    if (inputEl && !inputEl.disabled) {
      inputEl.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      inputEl.focus?.();
    }
    onHandledFocusRequest?.(focusRequest.seq);
  }, [focusRequest, activeProfileId, activeTab?.key, onHandledFocusRequest]);

  function handleTabKeyDown(event, index) {
    if (!allTabs.length) return;
    let nextIndex = -1;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % allTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + allTabs.length) % allTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = allTabs.length - 1;
    if (nextIndex < 0) return;

    event.preventDefault();
    const nextTab = allTabs[nextIndex];
    onSelectPlanType?.(nextTab.key);
    tabRefs.current.get(nextTab.key)?.focus?.();
  }

  function updateSectionSwitch(planKey, section, enabled) {
    const meta = tabMetaMap.get(planKey);
    const nextDraft = togglePolicyDraftSwitch(meta?.draft, section, enabled);
    onChangeDraft?.(planKey, nextDraft);
  }

  function updateConcurrencyValue(planKey, event) {
    const isBad = Boolean(event.target.validity?.badInput);
    const meta = tabMetaMap.get(planKey);
    const currentDraft = meta?.draft || createDefaultPolicyDraft();
    onChangeDraft?.(planKey, {
      ...currentDraft,
      concurrency: {
        ...currentDraft.concurrency,
        value: event.target.value,
      },
      __badInputs: {
        ...(currentDraft.__badInputs || {}),
        concurrency: isBad,
      },
    });
  }

  function updatePriorityValue(planKey, fieldKey, event) {
    const isBad = Boolean(event.target.validity?.badInput);
    const meta = tabMetaMap.get(planKey);
    const currentDraft = meta?.draft || createDefaultPolicyDraft();
    onChangeDraft?.(planKey, {
      ...currentDraft,
      priority: {
        ...currentDraft.priority,
        [fieldKey]: event.target.value,
      },
      __badInputs: {
        ...(currentDraft.__badInputs || {}),
        [fieldKey]: isBad,
      },
    });
  }

  if (!allTabs.length) {
    return (
      <section className={`fpp-section${disabled ? " is-disabled" : ""}`} aria-label="按 PlanType 配置指纹分池策略">
        <div className="fpp-header">
          <div className="fpp-title-wrap">
            <span>按 PlanType 指纹分池策略</span>
            {headerTip}
          </div>
        </div>
        <div className="fpp-empty-state">当前方案未绑定 PlanType，配置后可按类型设置</div>
      </section>
    );
  }

  const activeMeta = tabMetaMap.get(activeTab.key);
  const activeDraft = activeMeta?.draft || createDefaultPolicyDraft();
  const activeErrors = activeMeta?.errors || {};
  const activeLabel = formatPlanTypeLabel(activeTab.rawValue, planTypeMapping);
  const activeTabId = `${baseId}-tab-${activeTab.key}`;
  const activePanelId = `${baseId}-panel-${activeTab.key}`;
  const concLegendId = `${baseId}-conc-legend`;
  const concInputId = `${baseId}-conc-input`;
  const concHintId = `${baseId}-conc-hint`;
  const concErrorId = `${baseId}-conc-error`;
  const prioLegendId = `${baseId}-prio-legend`;
  const footnoteId = `${baseId}-prio-footnote`;
  const emptyWarnId = `${baseId}-prio-empty-warn`;

  const isResidual = Boolean(activeTab.residual);
  const concLocked = disabled || isResidual || !activeDraft.concurrency.enabled;
  const prioLocked = disabled || isResidual || !activeDraft.priority.enabled;
  const allPriorityEmpty = !isResidual && isPriorityAllEmpty(activeDraft);
  const prioritySharedDescribedBy = [
    footnoteId,
    allPriorityEmpty ? emptyWarnId : "",
  ].filter(Boolean).join(" ");

  return (
    <section className={`fpp-section${disabled ? " is-disabled" : ""}`} aria-label="按 PlanType 配置指纹分池策略">
      <div className="fpp-header">
        <div className="fpp-title-wrap">
          <span>按 PlanType 指纹分池策略</span>
          {headerTip}
        </div>
      </div>

      <div className="fpp-tablist" role="tablist" aria-label="按 PlanType 配置指纹分池策略">
        {allTabs.map((tab, index) => {
          const isSelected = tab.key === activeTab.key;
          const tabMeta = tabMetaMap.get(tab.key);
          const displayLabel = formatPlanTypeLabel(tab.rawValue, planTypeMapping);
          const showRawCode = displayLabel.toLowerCase() !== tab.key;
          const statusSummary = getTabStatusSummary({
            draft: tabMeta?.draft,
            residual: tab.residual,
            hasError: tabMeta?.hasError,
          });
          const accessibleName = statusSummary
            ? `${displayLabel}${showRawCode ? ` (${tab.key})` : ""}，${statusSummary}`
            : `${displayLabel}${showRawCode ? ` (${tab.key})` : ""}`;
          const tabId = `${baseId}-tab-${tab.key}`;
          const panelId = `${baseId}-panel-${tab.key}`;

          if (tab.residual) {
            return (
              <div
                key={tab.key}
                className={`fpp-tab-residual-wrap${isSelected ? " is-selected" : ""}`}
              >
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.key, el);
                    else tabRefs.current.delete(tab.key);
                  }}
                  type="button"
                  role="tab"
                  id={tabId}
                  aria-selected={isSelected}
                  aria-controls={panelId}
                  aria-label={accessibleName}
                  title={tab.rawValue}
                  tabIndex={isSelected ? 0 : -1}
                  disabled={disabled}
                  className="fpp-tab fpp-tab-residual"
                  onClick={() => onSelectPlanType?.(tab.key)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <span>{displayLabel}</span>
                  <span className="fpp-residual-tag" aria-hidden="true">残留</span>
                  <span className="sr-only">，{statusSummary}</span>
                </button>
                <button
                  type="button"
                  className="fpp-residual-remove-pill-btn"
                  disabled={disabled}
                  aria-label={`移除 ${displayLabel} 冗余策略`}
                  title="移除此条冗余策略"
                  onClick={() => onRemoveResidual?.(tab.key)}
                >
                  移除
                </button>
              </div>
            );
          }

          return (
            <button
              key={tab.key}
              ref={(el) => {
                if (el) tabRefs.current.set(tab.key, el);
                else tabRefs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={isSelected}
              aria-controls={panelId}
              aria-label={accessibleName}
              title={tab.rawValue}
              tabIndex={isSelected ? 0 : -1}
              disabled={disabled}
              className={`fpp-tab${tabMeta?.hasError ? " is-error" : ""}`}
              onClick={() => onSelectPlanType?.(tab.key)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {(tabMeta?.hasError || tabMeta?.isActiveDot) && (
                <span
                  className={`fpp-tab-dot${tabMeta?.hasError ? " is-error" : ""}`}
                  aria-hidden="true"
                />
              )}
              <span>{displayLabel}</span>
              {showRawCode && <span className="fpp-tab-code">({tab.key})</span>}
              {statusSummary && <span className="sr-only">，{statusSummary}</span>}
            </button>
          );
        })}
      </div>

      <div
        key={`${activeProfileId}:${activeTab.key}`}
        className="fpp-card"
        role="tabpanel"
        id={activePanelId}
        aria-labelledby={activeTabId}
      >
        {isResidual && (
          <div className="fpp-residual-banner" role="note">
            <span>
              {activeTab.boundElsewhere
                ? `“${activeLabel}” (${activeTab.key}) 已绑定到方案“${activeTab.boundElsewhere.ownerName}”，当前方案中保留的是历史冗余配置，仅作只读展示。`
                : `“${activeLabel}” (${activeTab.key}) 已不在当前方案绑定或可用 PlanType 列表中，仅作只读展示。`}
            </span>
            <button
              type="button"
              className="fpp-residual-banner-btn"
              disabled={disabled}
              onClick={() => onRemoveResidual?.(activeTab.key)}
            >
              移除冗余策略
            </button>
          </div>
        )}

        <fieldset className="fpp-pane" aria-labelledby={concLegendId}>
          <legend id={concLegendId} className="sr-only">不降智独立并发</legend>
          <div className="fpp-concurrency-row">
            <span className="fpp-pane-title" aria-hidden="true">不降智独立并发</span>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(activeDraft.concurrency.enabled)}
              aria-label={`启用 ${activeLabel} 不降智独立并发`}
              disabled={disabled || isResidual}
              className={`fpp-switch fpp-concurrency-switch${activeDraft.concurrency.enabled ? " is-on" : ""}`}
              onClick={() => updateSectionSwitch(activeTab.key, "concurrency", !activeDraft.concurrency.enabled)}
            >
              <span className="fpp-switch-thumb" aria-hidden="true" />
            </button>
            <div className="fpp-conc-input-group">
              <label htmlFor={concInputId} className="sr-only">{`${activeLabel} 不降智独立并发上限`}</label>
              <input
                ref={(el) => {
                  const refKey = `${activeTab.key}:concurrency`;
                  if (el) inputRefs.current.set(refKey, el);
                  else inputRefs.current.delete(refKey);
                }}
                id={concInputId}
                type="number"
                inputMode="numeric"
                min={0}
                max={10000}
                step={1}
                placeholder="10"
                disabled={concLocked}
                value={activeDraft.concurrency.value}
                onChange={(event) => updateConcurrencyValue(activeTab.key, event)}
                aria-invalid={activeErrors.concurrency ? "true" : undefined}
                aria-describedby={[concHintId, activeErrors.concurrency ? concErrorId : ""].filter(Boolean).join(" ")}
                className={`fpp-number-input fpp-conc-input${activeErrors.concurrency ? " is-invalid" : ""}`}
              />
              <span id={concHintId} className="fpp-range-hint">0–10000</span>
            </div>
          </div>
          {activeErrors.concurrency && (
            <div id={concErrorId} className="fpp-inline-error fpp-conc-error" role="alert">
              {activeErrors.concurrency}
            </div>
          )}
        </fieldset>

        <fieldset className="fpp-pane" aria-labelledby={prioLegendId}>
          <legend id={prioLegendId} className="sr-only">分级优先级</legend>
          <div className="fpp-priority-header">
            <span className="fpp-pane-title" aria-hidden="true">分级优先级</span>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(activeDraft.priority.enabled)}
              aria-label={`启用 ${activeLabel} 分级优先级`}
              disabled={disabled || isResidual}
              className={`fpp-switch${activeDraft.priority.enabled ? " is-on" : ""}`}
              onClick={() => updateSectionSwitch(activeTab.key, "priority", !activeDraft.priority.enabled)}
            >
              <span className="fpp-switch-thumb" aria-hidden="true" />
            </button>
          </div>

          <div className="fpp-priority-grid">
            {PRIORITY_STEP_FIELDS.map((step) => {
              const stepInputId = `${baseId}-prio-${step.key}`;
              const stepErrorId = `${baseId}-prio-err-${step.key}`;
              const stepError = activeErrors[step.key] || "";
              const describedBy = [prioritySharedDescribedBy, stepError ? stepErrorId : ""].filter(Boolean).join(" ");
              return (
                <div className="fpp-step-tile" key={step.key}>
                  <div className="fpp-step-head">
                    <span className="fpp-step-badge" aria-hidden="true">{step.step}</span>
                    <label htmlFor={stepInputId} className="fpp-step-label">
                      {step.label}
                      <span className="sr-only">优先级</span>
                    </label>
                  </div>
                  <div className="fpp-step-control">
                    <input
                      ref={(el) => {
                        const refKey = `${activeTab.key}:${step.key}`;
                        if (el) inputRefs.current.set(refKey, el);
                        else inputRefs.current.delete(refKey);
                      }}
                      id={stepInputId}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={10000}
                      step={1}
                      placeholder="跳过"
                      disabled={prioLocked}
                      value={activeDraft.priority[step.key]}
                      onChange={(event) => updatePriorityValue(activeTab.key, step.key, event)}
                      aria-invalid={stepError ? "true" : undefined}
                      aria-describedby={describedBy}
                      className={`fpp-number-input fpp-step-input${stepError ? " is-invalid" : ""}`}
                    />
                  </div>
                  {stepError && (
                    <div id={stepErrorId} className="fpp-inline-error" role="alert">
                      {stepError}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="fpp-step-tile">
              <div className="fpp-step-head">
                <span className="fpp-step-badge is-muted" aria-hidden="true">4</span>
                <span className="fpp-step-label">PlanType 默认</span>
              </div>
              <div className="fpp-step-control">
                <div
                  className="fpp-fallback-block"
                  role="note"
                  aria-label="第 4 级 PlanType 默认：兜底 · 含导入日期"
                >
                  兜底 · 含导入日期
                </div>
              </div>
            </div>
          </div>

          <div className="fpp-footnote-row">
            <span id={footnoteId}>仅明确检测结论生效 · 留空跳过 · 0 有效</span>
            {allPriorityEmpty && (
              <span id={emptyWarnId} className="fpp-all-empty-hint" aria-live="polite">
                三项均留空，全部回退至 PlanType 默认
              </span>
            )}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
