// Task settings are shared across browsers. Submit only edited values so an
// unchanged field cannot overwrite a newer server value from another editor.
export function taskSettingsPatch(next, previous) {
  const patch = {};
  const nested = new Set(['monitoring', 'webSessionMonitor', 'overloadAutoCooldown']);
  for (const [key, value] of Object.entries(next)) {
    if (nested.has(key)) {
      const changed = Object.fromEntries(Object.entries(value).filter(([field, entry]) => JSON.stringify(entry) !== JSON.stringify(previous[key]?.[field])));
      if (Object.keys(changed).length) patch[key] = changed;
    } else if (JSON.stringify(value) !== JSON.stringify(previous[key])) patch[key] = value;
  }
  return patch;
}
