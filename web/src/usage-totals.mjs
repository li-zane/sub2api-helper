const significant = new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 3 });

export function formatUsageTotal(value, { tokens = false } = {}) {
  if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—";
  if (!tokens) return significant.format(number);
  const units = ["", "K", "M", "B"];
  let unit = Math.min(3, number >= 1 ? Math.floor(Math.log10(number) / 3) : 0);
  // Rounding 999.5K must become 1M rather than displaying 1000K.
  if (Number((number / 1000 ** unit).toPrecision(3)) >= 1000 && unit < 3) unit++;
  return significant.format(number / 1000 ** unit) + units[unit];
}
