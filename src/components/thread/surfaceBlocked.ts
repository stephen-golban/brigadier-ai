// Vendored from the Codex UI Kit (MIT); see src/components/thread/UPSTREAM.md.
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
} from "react";

export const SurfaceBlockedContext = createContext(false);

export function useSurfaceBlockState() {
  const blocked = useContext(SurfaceBlockedContext);
  const [portalsBlocked, setPortalsBlocked] = useState(blocked);

  useLayoutEffect(() => {
    setPortalsBlocked(blocked);
  }, [blocked]);

  return { blocked, portalsBlocked };
}

export const surfaceBlockedEventName = "thread:surface-blocked";

export function getBlockedSurface(event: Event) {
  const detail = (event as CustomEvent<unknown>).detail;
  return detail instanceof HTMLElement ? detail : null;
}

export function notifySurfaceBlocked(surface: HTMLElement | null) {
  if (!surface || typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent<HTMLElement>(surfaceBlockedEventName, {
      detail: surface,
    }),
  );
}
