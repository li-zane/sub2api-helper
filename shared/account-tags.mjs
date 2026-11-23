export const TAG_OPTION_KEYS = { merchant: "merchants", trip: "trips", validity: "validities" };
export const DEFAULT_TAG_OPTIONS = { merchants: ["康神", "豆姐"], trips: ["头车", "二车"], validities: ["长效", "轮转"] };
const fields = { merchant: "商家", trip: "车次", validity: "时效", stopAt: "停止时间" };
const emptyTags = () => ({ merchant: "", trip: "", validity: "", stopAt: "" });
const valuePattern = /[\[\],，。\x00-\x1f\x7f\u2028\u2029]/u;
const fieldPattern = /\[(商家|车次|时效|停止时间)\] ([^\[\],，。\x00-\x1f\x7f\u2028\u2029]{1,64})/gu;
const blockPattern = new RegExp(fieldPattern.source + "(?:, " + fieldPattern.source + ")*。", "gu");

function validatedValue(key, raw) {
  if (typeof raw !== "string") throw new Error(fields[key] + "必须是文本");
  const value = raw.trim();
  if (!value) return "";
  if (key === "validity") {
    if (value === "长效" || value === "非轮") return "长效";
    if (value === "轮转") return value;
    throw new Error("时效请选择长效或轮转");
  }
  if (key === "stopAt") {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      const time = new Date(value + ":00Z");
      if (Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 16) === value) return value;
    }
    throw new Error("请选择有效的停止日期和时间");
  }
  if (value.length > 64 || valuePattern.test(value)) throw new Error(fields[key] + "最多 64 字，请避开方括号、逗号、句号和换行");
  return value;
}

// Only a complete, round-trippable sentence belongs to the tag editor. Free
// text, including similar-looking but incomplete labels, stays byte-for-byte.
function readBlock(remark) {
  for (const match of remark.matchAll(blockPattern)) {
    const tags = emptyTags();
    try {
      for (const [, label, value] of match[0].matchAll(fieldPattern)) {
        const key = Object.keys(fields).find(key => fields[key] === label);
        tags[key] = validatedValue(key, key === "stopAt" ? value.replace(" ", "T") : value);
      }
    } catch { continue; }
    const normalized = match[0].replace(/\[时效\] 非轮(?=, |。)/u, "[时效] 长效");
    if (formatTags(tags) === normalized) return { tags, index: match.index, length: match[0].length };
  }
  return null;
}

function formatTags(tags) {
  const parts = Object.entries(fields).filter(([key]) => tags[key]).map(([key, label]) =>
    "[" + label + "] " + (key === "stopAt" ? tags[key].replace("T", " ") : tags[key]));
  return parts.length ? parts.join(", ") + "。" : "";
}

export function readAccountTags(remark = "", cleared = false) {
  const block = readBlock(remark);
  if (block) return block.tags;
  const tags = emptyTags();
  if (cleared) return tags;
  function unique(values) { return values.length === 1 ? values[0] : ""; }
  tags.merchant = unique(DEFAULT_TAG_OPTIONS.merchants.filter(word => remark.includes(word)));
  tags.trip = unique(DEFAULT_TAG_OPTIONS.trips.filter(word => remark.includes(word)));
  tags.validity = unique([
    ...(/非轮|长效/u.test(remark) ? ["长效"] : []),
    ...(/(?<!非)轮转/u.test(remark) ? ["轮转"] : []),
  ]);
  return tags;
}

export function patchAccountTags(tags, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) throw new Error("请提供要修改的标签");
  const next = { ...tags };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(fields, key)) throw new Error("未知的账号标签");
    next[key] = validatedValue(key, value);
  }
  if (next.validity !== "轮转") {
    if (patch.stopAt && next.stopAt) throw new Error("只有轮转可以设置停止时间");
    next.stopAt = "";
  }
  return next;
}

export function writeAccountTags(remark, tags) {
  const sentence = formatTags(tags);
  const block = readBlock(remark);
  if (block) {
    let start = block.index;
    // The writer inserts exactly one separator before its sentence.
    if (!sentence && start && remark[start - 1] === " ") start--;
    return remark.slice(0, start) + sentence + remark.slice(block.index + block.length);
  }
  return remark && sentence ? remark + " " + sentence : remark + sentence;
}
