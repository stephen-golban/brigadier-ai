import { useSyncExternalStore } from "react";
const query = "(max-width: 767px)";
function subscribe(changed: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}
export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
