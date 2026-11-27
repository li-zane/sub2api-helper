export const DEFAULT_REGEX_PRECHECK = Object.freeze({
  enabled: false, model: "", prompt: "", pattern: "", flags: "",
  degradedWhen: "match", skipFallbackOnPass: true,
});

export function normalizeRegexPrecheck(raw = DEFAULT_REGEX_PRECHECK) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("前置正则检测设置必须是对象");
  const value = { ...DEFAULT_REGEX_PRECHECK, ...raw };
  for (const key of ["enabled", "skipFallbackOnPass"]) {
    if (typeof value[key] !== "boolean") throw invalid("前置检测开关必须为布尔值");
  }
  for (const [key, max] of [["model", 160], ["prompt", 16000], ["pattern", 2000], ["flags", 4]]) {
    if (typeof value[key] !== "string" || value[key].length > max || value[key].includes("\0")) throw invalid(`前置检测 ${key} 必须是最多 ${max} 个字符的文本`);
  }
  value.model = value.model.trim();
  if (/[\r\n]/.test(value.model)) throw invalid("前置检测模型名称不能包含换行");
  if (!["match", "no_match"].includes(value.degradedWhen)) throw invalid("请选择正则命中或未命中时判为降智");
  if (!/^[imsu]*$/.test(value.flags) || new Set(value.flags).size !== value.flags.length) throw invalid("正则标志仅支持不重复的 i、m、s、u");
  if (value.enabled && (!value.model || !value.prompt.trim() || !value.pattern.trim())) throw invalid("启用前置检测需填写模型、提示词和正则表达式");
  try { new RegExp(value.pattern, value.flags); } catch { throw invalid("前置检测正则表达式语法无效"); }
  return Object.fromEntries(Object.keys(DEFAULT_REGEX_PRECHECK).map(key => [key, value[key]]));
}
