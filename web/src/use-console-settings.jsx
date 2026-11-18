import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./console-request.mjs";
import { shareSnapshot } from "./polling-snapshot.mjs";

const PROXY_URL = "/api/account-proxy-settings";
const TASK_URL = "/api/task-settings";
const FINGERPRINT_URL = "/api/model-fingerprint/settings";
const mode = value => ["plan", "sub2api"].includes(value) ? value : "global";
const readProxy = value => ({
  proxyUrl: value.proxyUrl || "", allowDirectFallback: value.allowDirectFallback === true, mode: mode(value.mode),
});
const post = body => ({ method: "POST", body: JSON.stringify(body) });

export function useConsoleSettings({ token, onError }) {
  const [taskSettings, setTaskSettings] = useState(null);
  const taskRef = useRef(null);
  const [taskDialogSettings, setTaskDialogSettings] = useState(null);
  const [taskSettingsOpening, setTaskSettingsOpening] = useState(false);
  const [proxy, setProxy] = useState(() => ({ saved: readProxy({}), draft: {}, loaded: false }));
  const proxyRef = useRef(proxy);
  const [proxySettingsSaving, setProxySettingsSaving] = useState(false);
  const proxySaving = useRef(false);
  const [proxySettingsError, setProxySettingsError] = useState("");
  const [runtimeApply, setRuntimeApply] = useState(null);
  const [runtimeRetrying, setRuntimeRetrying] = useState(false);

  const revision = useRef({ task: 0, proxy: 0, runtime: 0 });
  const nextRead = useRef(0), taskRead = useRef(0), proxyRead = useRef(0), runtimeRead = useRef(0);
  const nextEdit = useRef(0);
  const writeTail = useRef(Promise.resolve());
  const stampRead = useCallback(() => ({ ...revision.current, sequence: ++nextRead.current }), []);
  const canAccept = useCallback((stamp, field, lastRead) => {
    if (!stamp) return true; // Bootstrap runs before token-dependent reads.
    if (stamp[field] !== revision.current[field] || stamp.sequence < lastRead.current) return false;
    lastRead.current = stamp.sequence;
    return true;
  }, []);
  const serializeWrite = useCallback(operation => {
    const result = writeTail.current.catch(() => {}).then(operation);
    writeTail.current = result;
    return result;
  }, []);

  const publishTask = useCallback(value => {
    if (!value) return;
    taskRef.current = shareSnapshot(taskRef.current, value);
    setTaskSettings(taskRef.current);
  }, []);
  const acceptTaskSettings = useCallback((value, stamp) => {
    if (value && canAccept(stamp, "task", taskRead)) publishTask(value);
  }, [canAccept, publishTask]);
  const acceptRuntime = useCallback((data, stamp) => {
    if (stamp && !canAccept(stamp, "runtime", runtimeRead)) return;
    if (!stamp) revision.current.runtime++;
    setRuntimeApply(current => shareSnapshot(current, data.runtimeApply || null));
  }, [canAccept]);

  const updateProxy = useCallback(update => {
    const current = proxyRef.current;
    proxyRef.current = shareSnapshot(current, update(current));
    setProxy(proxyRef.current);
  }, []);
  const editProxy = useCallback((key, value) => {
    // Each edit has its own identity, even when the user returns to the same value.
    const edit = { value, sequence: ++nextEdit.current };
    updateProxy(current => ({ ...current, draft: { ...current.draft, [key]: edit } }));
  }, [updateProxy]);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    const refresh = async () => {
      const stamp = stampRead();
      try {
        const data = await apiFetch(token, PROXY_URL, { signal: controller.signal });
        if (!controller.signal.aborted && canAccept(stamp, "proxy", proxyRead)) {
          updateProxy(current => ({ ...current, saved: readProxy(data.settings), loaded: true }));
          acceptRuntime(data, stamp);
        }
      } catch (error) {
        if (!controller.signal.aborted && canAccept(stamp, "proxy", proxyRead)) setProxySettingsError(error.message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 15_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [token, stampRead, canAccept, updateProxy, acceptRuntime]);

  const openTaskSettings = useCallback(async () => {
    setTaskSettingsOpening(true);
    const stamp = stampRead();
    try {
      const data = await apiFetch(token, TASK_URL);
      acceptTaskSettings(data.settings, stamp);
      acceptRuntime(data, stamp);
      setTaskDialogSettings(taskRef.current);
    } catch (error) { onError(error.message); }
    finally { setTaskSettingsOpening(false); }
  }, [token, onError, stampRead, acceptTaskSettings, acceptRuntime]);
  const closeTaskSettings = useCallback(() => setTaskDialogSettings(null), []);

  const publishTaskResponse = useCallback(data => {
    const { settings } = data;
    revision.current.task++;
    revision.current.proxy++;
    acceptRuntime(data);
    publishTask(settings);
    updateProxy(current => ({
      ...current, loaded: true, saved: readProxy({ ...settings, mode: settings.accountProxyMode }),
    }));
  }, [publishTask, updateProxy, acceptRuntime]);

  const saveTaskSettings = useCallback(patch => serializeWrite(async () => {
    const data = await apiFetch(token, TASK_URL, post(patch));
    publishTaskResponse(data);
    closeTaskSettings();
    return data;
  }), [token, serializeWrite, publishTaskResponse, closeTaskSettings]);

  const saveFingerprintSettings = useCallback(patch => serializeWrite(async () => {
    const data = await apiFetch(token, FINGERPRINT_URL, post({ patch }));
    revision.current.task++;
    acceptRuntime(data);
    if (taskRef.current) publishTask({ ...taskRef.current, modelFingerprint: data.settings });
  }), [token, serializeWrite, acceptRuntime, publishTask]);

  const retryRuntime = useCallback(async () => {
    setRuntimeRetrying(true);
    try {
      await serializeWrite(async () => publishTaskResponse(await apiFetch(token, TASK_URL + "/retry-runtime", { method: "POST" })));
    } catch (error) { onError(error.message); }
    finally { setRuntimeRetrying(false); }
  }, [token, serializeWrite, publishTaskResponse, onError]);

  const saveAccountProxySettings = useCallback(async () => {
    if (proxySaving.current) return;
    const submitted = proxyRef.current.draft;
    if (!Object.keys(submitted).length) return;
    proxySaving.current = true;
    setProxySettingsSaving(true);
    setProxySettingsError("");
    try {
      await serializeWrite(async () => {
        const base = proxyRef.current.saved;
        const body = {
          proxyUrl: (submitted.proxyUrl?.value ?? base.proxyUrl).trim(),
          allowDirectFallback: submitted.allowDirectFallback?.value ?? base.allowDirectFallback,
        };
        const data = await apiFetch(token, PROXY_URL, post(body));
        const { settings } = data;
        revision.current.task++;
        revision.current.proxy++;
        acceptRuntime(data);
        updateProxy(current => ({
          ...current, loaded: true, saved: readProxy(settings),
          draft: Object.fromEntries(Object.entries(current.draft).filter(([key, edit]) => submitted[key] !== edit)),
        }));
        if (taskRef.current) publishTask({
          ...taskRef.current, proxyUrl: settings.proxyUrl, allowDirectFallback: settings.allowDirectFallback,
          accountProxyMode: mode(settings.mode),
        });
      });
    } catch (error) { setProxySettingsError(error.message); }
    finally { proxySaving.current = false; setProxySettingsSaving(false); }
  }, [token, serializeWrite, updateProxy, publishTask, acceptRuntime]);

  return {
    taskSettings, taskDialogSettings, taskSettingsOpening, openTaskSettings, closeTaskSettings, saveTaskSettings,
    stampRead, acceptTaskSettings, saveFingerprintSettings, runtimeApply, runtimeRetrying, retryRuntime,
    accountProxyUrl: proxy.draft.proxyUrl?.value ?? proxy.saved.proxyUrl,
    accountProxyMode: proxy.saved.mode,
    allowDirectFallback: proxy.draft.allowDirectFallback?.value ?? proxy.saved.allowDirectFallback,
    proxySettingsLoaded: proxy.loaded, proxySettingsDirty: Object.keys(proxy.draft).length > 0,
    proxySettingsSaving, proxySettingsError, setProxySettingsError, editProxy, saveAccountProxySettings,
  };
}
