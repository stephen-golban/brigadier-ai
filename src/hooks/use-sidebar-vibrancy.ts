import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The native macOS material behind the sidebar, plus the focus state the sidebar paints against.
 *
 * Two facts from `docs/research/codex-sidebar.md` §1, both measured out of the shipping Codex
 * bundle, decide the two constants here:
 *
 *  - the material is **`menu`**, not `sidebar`, `under-window` or `fullscreen-ui`
 *    (`pretty/main.js:152620`), and
 *  - `visualEffectState` is never set, so Electron's default `followWindow` applies — the
 *    material stops sampling the desktop when the window loses focus. Tauri's spelling of that
 *    default is `EffectState.FollowsWindowActiveState`.
 *
 * macOS's own follow-the-window behaviour drops the blur but leaves the layer transparent, so
 * an unfocused window would show the desktop through the tint. Codex handles that natively —
 * on blur its main process calls `setVibrancy(null)` and swaps in an opaque `backgroundColor`
 * (`pretty/main.js:152301–152319`). There is no Tauri equivalent to `setVibrancy(null)` per
 * event, so the same result is produced in CSS: `data-window-focused="false"` on `<html>`, off
 * Tauri's `onFocusChanged`, and the sidebar rules paint `var(--sidebar)` flat.
 *
 * `data-sidebar-vibrancy` is still only set once the effect has actually installed, so a
 * runtime that refuses it keeps the opaque fallback rather than a transparent hole.
 */
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
          effects: [Effect.Menu],
          state: EffectState.FollowsWindowActiveState,
        });
        if (live && request === revision)
          document.documentElement.dataset.sidebarVibrancy = "true";
      } catch {
        // Unsupported native runtimes retain the opaque semantic fallback.
      }
    };
    void update();
    preference.addEventListener("change", update);
    // Focus is tracked whether or not the material installed: the opaque fallback wants the
    // same flat colour on blur, and a rejected `setEffects` must not leave the attribute stale.
    const focus = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!live) return;
      if (payload) delete document.documentElement.dataset.windowFocused;
      else document.documentElement.dataset.windowFocused = "false";
    });
    return () => {
      live = false;
      preference.removeEventListener("change", update);
      delete document.documentElement.dataset.sidebarVibrancy;
      delete document.documentElement.dataset.windowFocused;
      void focus.then((stop) => stop()).catch(() => {});
    };
  }, []);
}
