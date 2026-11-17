export const DEFAULT_PLAN_TYPE_MAPPING = {
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

export function normalizePlanTypeMapping(value) {
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


export function formatPlanTypeLabel(value, mapping = DEFAULT_PLAN_TYPE_MAPPING) {
  const raw = String(value || "").trim();
  if (!raw) return "未知";
  return normalizePlanTypeMapping(mapping)[raw] || raw;
}
