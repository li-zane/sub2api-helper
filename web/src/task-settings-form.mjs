// Task settings are shared across browsers. Submit only edited values so an
// unchanged field cannot overwrite a newer server value from another editor.
function settingsPatch(next, previous, nested) {
  const patch = {};
  for (const [key, value] of Object.entries(next)) {
    if (nested.includes(key)) {
      const changed = Object.fromEntries(Object.entries(value).filter(([field, entry]) => JSON.stringify(entry) !== JSON.stringify(previous[key]?.[field])));
      if (Object.keys(changed).length) patch[key] = changed;
    } else if (JSON.stringify(value) !== JSON.stringify(previous[key])) patch[key] = value;
  }
  return patch;
}

export function taskSettingsPatch(next, previous) {
  return settingsPatch(next, previous, ["monitoring", "webSessionMonitor", "overloadAutoCooldown"]);
}

export function fingerprintSettingsPatch(next, previous) {
  return settingsPatch(next, previous, ["matchedConcurrency", "matchedPriority", "testSequence"]);
}
