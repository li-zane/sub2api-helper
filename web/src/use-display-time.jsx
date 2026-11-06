import { useSyncExternalStore } from "react";
import { subscribeDisplayTimeZone, getDisplayTimeZone } from "./display-time.mjs";
export function useDisplayTimeZone() {
  return useSyncExternalStore(subscribeDisplayTimeZone, getDisplayTimeZone, getDisplayTimeZone);
}
