export const DEFAULT_COUNT_WINDOW_MINUTES = 15;
export const COUNT_HISTORY_MINUTES = 90;

export function overloadGrid(windowMinutes = DEFAULT_COUNT_WINDOW_MINUTES) {
  const bucketMinutes = Number.isInteger(windowMinutes) && windowMinutes >= 1 && windowMinutes <= 1440
    ? windowMinutes : DEFAULT_COUNT_WINDOW_MINUTES;
  const pointCount = Math.ceil(COUNT_HISTORY_MINUTES / bucketMinutes);
  return { bucketMinutes, bucketMs: bucketMinutes * 60_000, pointCount, historyMinutes: pointCount * bucketMinutes };
}
