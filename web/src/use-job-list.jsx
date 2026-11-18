import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "./console-request.mjs";
import { jobFilterOptions } from "./job-list-filters.mjs";
import { reconcilePolledJobs, startJobListPoll } from "./job-list-poll.mjs";
import { shareSnapshot } from "./polling-snapshot.mjs";

export const JOB_LIST_POLL_INTERVAL_MS = 900;

const DEFAULT_FILTERS = {
  emails: [], search: "", lockedOnly: false, webSession: "", summary: "", accountType: "",
  status: "", planType: "", sub2apiPool: "", sub2apiEnabled: "", overload: "", fingerprint: "",
};
const EMPTY_SELECTION = new Set();
const EMPTY_ROWS = [];
const EMPTY_STATS = { active: 0, queued: 0, normal: 0, abnormal: 0, historicalSubscriptions: 0 };

function initialList(token) {
  return {
    token,
    request: { filters: DEFAULT_FILTERS, page: 1 },
    settledRequest: null,
    phase: "loading",
    jobs: EMPTY_ROWS,
    selectionIndex: EMPTY_ROWS,
    returnedPageIds: EMPTY_ROWS,
    selectedIds: EMPTY_SELECTION,
    pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
    stats: EMPTY_STATS,
    filterOptions: jobFilterOptions(),
    expandedJobId: null,
  };
}

function changeFilters(state, filters) {
  const next = shareSnapshot(state.request.filters, filters);
  if (next === state.request.filters) return state;
  return {
    ...state,
    request: { filters: next, page: 1 },
    expandedJobId: null,
    selectedIds: EMPTY_SELECTION,
  };
}

function dropUnavailableFilters(filters, options) {
  const next = { ...filters };
  if (filters.status && !options.statusOptions.includes(filters.status)) next.status = "";
  if (filters.planType && (filters.planType === "__unknown__"
    ? !options.planTypeUnknown
    : !options.planTypeOptions.includes(filters.planType))) next.planType = "";
  if (filters.sub2apiPool && !options.sub2apiPoolOptions.includes(filters.sub2apiPool)) next.sub2apiPool = "";
  if (filters.sub2apiEnabled && !options.sub2apiEnabledOptions.includes(filters.sub2apiEnabled)) next.sub2apiEnabled = "";
  return next;
}

function isReady(state) {
  return state.settledRequest === state.request && state.phase === "ready";
}

function keepValidIds(ids, index) {
  if (!ids.size) return EMPTY_SELECTION;
  const valid = new Set(index.map(job => job.id));
  const next = new Set([...ids].filter(id => valid.has(id)));
  return next.size === ids.size ? ids : next;
}

function updateValue(value, previous) {
  return typeof value === "function" ? value(previous) : value;
}

function reduceList(state, action) {
  switch (action.type) {
    case "token":
      return state.token === action.token ? state : initialList(action.token);
    case "filter":
      return changeFilters(state, { ...state.request.filters, [action.key]: action.value });
    case "clear-filters":
      return changeFilters(state, DEFAULT_FILTERS);
    case "page": {
      const page = updateValue(action.value, state.request.page);
      if (page === state.request.page) return state;
      return { ...state, request: { ...state.request, page }, expandedJobId: null };
    }
    case "refresh":
      return { ...state, request: { ...state.request } };
    case "error":
      if (state.request !== action.request || state.token !== action.token) return state;
      if (state.settledRequest === action.request && state.phase === "error") return state;
      return { ...state, settledRequest: action.request, phase: "error" };
    case "data": {
      if (state.request !== action.request || state.token !== action.token) return state;
      const { data } = action;
      const filterOptions = shareSnapshot(state.filterOptions, jobFilterOptions(data.filterOptions));
      const validFilters = dropUnavailableFilters(state.request.filters, filterOptions);
      const next = changeFilters(state, validFilters);
      // An automatically cleared filter requires a new result before enabling selection.
      if (next !== state) return { ...next, filterOptions };

      const pagination = shareSnapshot(state.pagination, data.pagination || {
        page: state.request.page, pageSize: 20, total: data.jobs.length, totalPages: 1,
      });
      // The server already returned the clamped page in this same response.
      const request = pagination.page === state.request.page
        ? state.request
        : { ...state.request, page: pagination.page };
      const jobs = reconcilePolledJobs(state.jobs, data.jobs);
      const selectionIndex = reconcilePolledJobs(state.selectionIndex, data.selection || data.jobs);
      const returnedPageIds = shareSnapshot(state.returnedPageIds, data.jobs.map(job => job.id));
      const selectedIds = selectionIndex === state.selectionIndex
        ? state.selectedIds
        : keepValidIds(state.selectedIds, selectionIndex);
      const stats = shareSnapshot(state.stats, data.stats || EMPTY_STATS);
      if (isReady(state) && request === state.request && jobs === state.jobs && selectionIndex === state.selectionIndex
        && returnedPageIds === state.returnedPageIds && filterOptions === state.filterOptions
        && pagination === state.pagination && stats === state.stats) return state;
      return {
        ...state, request, settledRequest: request, phase: "ready",
        jobs, selectionIndex, returnedPageIds, selectedIds, pagination, stats, filterOptions,
        expandedJobId: request === state.request ? state.expandedJobId : null,
      };
    }
    case "jobs": {
      const jobs = updateValue(action.value, state.jobs);
      return jobs === state.jobs ? state : { ...state, jobs };
    }
    case "selection-index": {
      const selectionIndex = updateValue(action.value, state.selectionIndex);
      return selectionIndex === state.selectionIndex ? state : {
        ...state, selectionIndex, selectedIds: keepValidIds(state.selectedIds, selectionIndex),
      };
    }
    case "expand": {
      const expandedJobId = updateValue(action.value, state.expandedJobId);
      return expandedJobId === state.expandedJobId ? state : { ...state, expandedJobId };
    }
    case "selection": {
      // Ignore results from an operation that began before the current filters.
      if (action.filters !== state.request.filters || action.token !== state.token) return state;
      const selectedIds = keepValidIds(updateValue(action.value, state.selectedIds), state.selectionIndex);
      return selectedIds === state.selectedIds ? state : { ...state, selectedIds };
    }
    case "toggle": {
      if (!isReady(state) || action.request !== state.request || action.token !== state.token) return state;
      const selectedIds = new Set(state.selectedIds);
      const clear = action.ids.every(id => selectedIds.has(id));
      for (const id of action.ids) {
        if (clear) selectedIds.delete(id);
        else selectedIds.add(id);
      }
      return { ...state, selectedIds: keepValidIds(selectedIds, state.selectionIndex) };
    }
    default:
      return state;
  }
}

export function useJobList({ token, onData, onError, getRequestContext }) {
  const [state, setState] = useState(() => initialList(token));
  // React can skip scheduling a render when a functional state update returns
  // the existing snapshot. Identical background polls take that path.
  const dispatch = useCallback(action => setState(current => reduceList(current, action)), []);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState("");
  const { request, jobs, selectionIndex, selectedIds, returnedPageIds, pagination, stats, filterOptions, expandedJobId } = state;
  const { filters, page } = request;
  const { search: searchQuery, summary: summaryFilter, webSession: webSessionFilter, lockedOnly, emails: emailFilter,
    accountType: accountTypeFilter, planType: planTypeFilter, sub2apiPool: sub2apiPoolFilter,
    sub2apiEnabled: sub2apiEnabledFilter, status: statusFilter, overload: overloadFilter, fingerprint: fingerprintFilter } = filters;
  const { planTypeOptions, statusOptions, sub2apiPoolOptions, sub2apiEnabledOptions, planTypeUnknown } = filterOptions;
  const currentRead = useRef(null);

  useLayoutEffect(() => {
    currentRead.current = { request, token };
    return () => { currentRead.current = null; };
  }, [request, token]);

  useEffect(() => {
    if (state.token !== token) {
      dispatch({ type: "token", token });
      return undefined;
    }
    if (!token) return undefined;
    const read = currentRead.current;
    return startJobListPoll({ ...filters, page }, {
      intervalMs: JOB_LIST_POLL_INTERVAL_MS,
      getRequestContext,
      request: (url, options) => apiFetch(token, url, options),
      onError(error) {
        if (currentRead.current !== read) return;
        dispatch({ type: "error", request, token });
        onError(error.message);
      },
      onData(data, context) {
        if (currentRead.current !== read) return;
        dispatch({ type: "data", request, token, data });
        onData(data, context);
        onError("");
      },
    });
  }, [token, state.token, request, filters, page, onData, onError, getRequestContext, dispatch]);

  const selectionReady = Boolean(token) && state.token === token && isReady(state);
  const listPhase = !token ? "idle" : state.token === token && state.settledRequest === request ? state.phase : "loading";
  const displaySelectedIds = state.token === token ? selectedIds : EMPTY_SELECTION;
  // Optimistic row updates can render new rows before the list confirms membership.
  const pageJobIds = useMemo(() => {
    if (!selectionReady) return EMPTY_SELECTION;
    const displayed = new Set(jobs.map(job => job.id));
    const indexed = new Set(selectionIndex.map(job => job.id));
    return new Set(returnedPageIds.filter(id => displayed.has(id) && indexed.has(id)));
  }, [jobs, selectionIndex, returnedPageIds, selectionReady]);
  const selectedJobIds = selectionReady ? displaySelectedIds : EMPTY_SELECTION;
  const selectedJobs = useMemo(
    () => selectedJobIds.size ? selectionIndex.filter(job => selectedJobIds.has(job.id)) : EMPTY_ROWS,
    [selectionIndex, selectedJobIds],
  );
  const allPageSelected = pageJobIds.size > 0 && [...pageJobIds].every(id => selectedJobIds.has(id));
  const hasJobFilters = Boolean(summaryFilter || searchQuery.trim() || lockedOnly || webSessionFilter || emailFilter.length || accountTypeFilter || statusFilter || planTypeFilter || sub2apiPoolFilter || sub2apiEnabledFilter || overloadFilter || fingerprintFilter);
  const availablePlanTypes = [...new Set([
    ...planTypeOptions,
    ...jobs.map(job => job.planType).filter(Boolean),
    ...(planTypeFilter && planTypeFilter !== "__unknown__" ? [planTypeFilter] : []),
  ])].sort();

  const setJobs = useCallback(value => dispatch({ type: "jobs", value }), [dispatch]);
  const setJobSelectionIndex = useCallback(value => dispatch({ type: "selection-index", value }), [dispatch]);
  const setExpandedJobId = useCallback(value => dispatch({ type: "expand", value }), [dispatch]);
  const setPage = useCallback(value => dispatch({ type: "page", value }), [dispatch]);
  const setSelectedJobIds = useCallback(value => dispatch({ type: "selection", value, filters, token }), [dispatch, filters, token]);
  const applyColumnFilter = useCallback((key, value) => dispatch({ type: "filter", key, value }), [dispatch]);

  function applyEmailFilter(event) {
    event.preventDefault();
    try {
      const emails = parseEmailFilter(filterText);
      applyColumnFilter("emails", emails);
      setFilterError("");
      setFilterOpen(false);
    } catch (filterParseError) {
      setFilterError(filterParseError.message);
    }
  }

  function clearEmailFilter() {
    dispatch({ type: "clear-filters" });
    setFilterText("");
    setFilterError("");
  }

  function toggleJobSelection(jobId) {
    if (pageJobIds.has(jobId)) dispatch({ type: "toggle", request, token, ids: [jobId] });
  }

  function toggleAllOnPage() {
    if (pageJobIds.size) dispatch({ type: "toggle", request, token, ids: [...pageJobIds] });
  }

  return {
    jobs, setJobs, page, setPage, stats, pagination, jobSelectionIndex: selectionIndex, setJobSelectionIndex,
    expandedJobId, setExpandedJobId, selectedJobIds, setSelectedJobIds, selectedJobs, displaySelectedIds,
    listPhase, selectionReady,
    searchQuery, summaryFilter, webSessionFilter, lockedOnly, emailFilter, hasJobFilters, applyColumnFilter,
    filterOpen, setFilterOpen, filterText, setFilterText, filterError, setFilterError,
    applyEmailFilter, clearEmailFilter, allPageSelected, pageJobIds, toggleAllOnPage, toggleJobSelection,
    availablePlanTypes, refreshJobs: () => dispatch({ type: "refresh" }),
    accountTypeFilter, planTypeFilter, planTypeUnknown, sub2apiPoolFilter, sub2apiPoolOptions, sub2apiEnabledFilter,
    sub2apiEnabledOptions, statusFilter, statusOptions, overloadFilter, fingerprintFilter,
  };
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
