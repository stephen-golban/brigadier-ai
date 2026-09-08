import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";

/** The native material is exposed only through transparent sidebar pixels. */
export function useSidebarVibrancy() {
  useEffect(() => {
    if (!isTauri() || !navigator.platform.startsWith("Mac")) return;
    const preference = window.matchMedia(
      "(prefers-reduced-transparency: reduce)",
    );
    let live = true;
    let revision = 0;
    const update = async () => {
      const request = ++revision;
      delete document.documentElement.dataset.sidebarVibrancy;
      if (preference.matches) return;
      try {
        await getCurrentWindow().setEffects({
          effects: [Effect.Sidebar],
          state: EffectState.Active,
        });
        if (live && request === revision)
          document.documentElement.dataset.sidebarVibrancy = "true";
      } catch {
        // Unsupported native runtimes retain the opaque semantic fallback.
      }
    };
    void update();
    preference.addEventListener("change", update);
    return () => {
      live = false;
      preference.removeEventListener("change", update);
      delete document.documentElement.dataset.sidebarVibrancy;
    };
  }, []);
}
