/**
 * Three-state theme (`auto` / `light` / `dark`), adapted from Jan.
 *
 * Upstream: `janhq/jan`, `web-app/src/providers/ThemeProvider.tsx` (79 lines).
 * Licensed under the Apache License, Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0
 * Copyright the Jan contributors. Structure, the `applyIfAuto` race fix and the Linux desktop-
 * portal fallback are theirs; the store, the `isTauri()` guards and the comments are ours.
 * No Jan product name, mark or branding is carried over.
 *
 * Telemetry check, required before any Jan file lands (`docs/research/jan.md` §6): the upstream
 * file imports exactly three things — `react`, `@/hooks/useTheme` and `@/lib/platform/utils` —
 * and its only side effects are `document.documentElement.classList`, `matchMedia` and two Tauri
 * `invoke`s. No PostHog, no Google Analytics injector, no network call. Nothing was stripped.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS IS NOT MOUNTED YET. `src/main.tsx` is untouched by the order that added this file; the
 * shell order (W4-C, `docs/plans/phase-4.md`) mounts it. It is not dead code, it is early code.
 *
 * AND IT CURRENTLY HAS NO VISIBLE EFFECT. brigadier is dark-only: `src/index.css` defines one
 * unconditional token set in `@theme static` and there is no light set and no `.dark { … }`
 * override, so the `.dark` class this toggles changes nothing on screen today. The mechanism is
 * carried because Linux is the declared second platform and it costs nothing to keep (owner
 * decision, 2026-09-02).
 * ---------------------------------------------------------------------------------------------
 *
 * Three adaptations away from upstream, each forced by something this repo does not have:
 *
 *   1. No zustand. Jan's `useTheme` is a zustand store; this is React context plus
 *      `localStorage`, keyed `brigadier.theme` to match `src/fps.ts`'s `brigadier.fps`.
 *      Jan reads `useTheme.getState()` inside the listener to dodge a commit race; the
 *      functional-updater equivalent here is a ref, and it is read for the same reason.
 *   2. No `IS_LINUX` build-time define. Jan's comes from a Vite `define`; adding one here would
 *      need an ambient type declaration in a file this order does not own, so Linux is sniffed
 *      from the user agent at runtime instead. Coarser, and only gates a best-effort call.
 *   3. Every Tauri API call sits behind `isTauri()` from `@tauri-apps/api/core`, matching
 *      `src/bridge.ts:153` — the app must run under a plain `npm run dev` in a browser.
 *
 * jsdom 30.0.1 has no `window.matchMedia` at all — `TypeError: window.matchMedia is not a
 * function` [measured] — so its absence is handled rather than assumed, and the tests install
 * their own controllable stub.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { isTauri } from "@tauri-apps/api/core";

export type Theme = "auto" | "light" | "dark";

/** Matches `src/fps.ts`'s `brigadier.fps`. */
export const THEME_STORAGE_KEY = "brigadier.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemeState = {
  /** What the user chose. `auto` defers to the OS. */
  theme: Theme;
  setTheme: (next: Theme) => void;
  /** What that resolves to right now. This is what drives the `.dark` class. */
  isDark: boolean;
};

const ThemeContext = createContext<ThemeState | null>(null);

function isTheme(v: unknown): v is Theme {
  return v === "auto" || v === "light" || v === "dark";
}

/** A stored value that is missing, corrupt, or from an older key shape falls back to `auto`. */
function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : "auto";
  } catch {
    // Safari private mode and some embedded webviews throw on `localStorage` access.
    return "auto";
  }
}

/** `false` when `matchMedia` is missing, which is the case under jsdom [measured]. */
function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(DARK_QUERY).matches;
}

function resolve(theme: Theme, systemDark: boolean): boolean {
  return theme === "auto" ? systemDark : theme === "dark";
}

export function ThemeProvider({ children }: { children?: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  const isDark = resolve(theme, systemDark);

  // Jan reads `useTheme.getState().activeTheme` inside its listeners rather than closing over
  // the value, because calling the theme switcher fires portal/media events that would race the
  // store commit and pin `isDark` back to the system value even under an explicit override.
  // Without zustand the same guard is a ref that the effect below keeps current.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Non-fatal: the preference simply does not survive a reload.
    }
  }, []);

  // Upstream `:9-13`. Toggling `.dark` on the root element. Inert today — see the header.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);

    // Upstream `:14-18`. WebKitGTK needs to be told, or GTK's own widgets stay light. The Rust
    // command `set_gtk_prefer_dark` does NOT exist in this repo's `src-tauri/`, so this rejects
    // and the `.catch` swallows it; it is here so the Linux path is one command away, not
    // because it works today.
    const linux = typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent);
    if (linux && isTauri()) {
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("set_gtk_prefer_dark", { dark: isDark }))
        .catch(() => {
          /* command not implemented yet */
        });
    }
  }, [isDark]);

  useEffect(() => {
    let cancelled = false;
    let unlistenTauri: (() => void) | undefined;

    // Only `auto` follows the system. An explicit light/dark choice ignores every event.
    const applyIfAuto = (next: boolean) => {
      if (themeRef.current === "auto") setSystemDark(next);
    };

    // Upstream `:33-35`.
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
    const onMediaChange = (e: MediaQueryListEvent) => applyIfAuto(e.matches);
    mq?.addEventListener("change", onMediaChange);

    if (isTauri()) {
      // Upstream `:37-52`. On Linux, WebKitGTK's `prefers-color-scheme` does not reliably track
      // the XDG Desktop Portal, so the source of truth is a Rust-side portal read plus its
      // SettingChanged signal, re-emitted as a `theme-changed` event.
      //
      // NEITHER HALF EXISTS HERE. No Rust code in `src-tauri/` emits `theme-changed` and there is
      // no `get_system_theme` command; building them was explicitly out of scope for the order
      // that added this file. So this whole branch is INERT under Tauri today: the listener
      // registers and never fires, and the `invoke` rejects into the `.catch`. Do not read a
      // passing test as evidence that the Linux path works — it has never been exercised.
      Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")])
        .then(async ([{ listen }, { invoke }]) => {
          const unlisten = await listen<string>("theme-changed", (event) => {
            applyIfAuto(event.payload === "dark");
          });
          if (cancelled) {
            unlisten();
            return;
          }
          unlistenTauri = unlisten;

          try {
            const initial = await invoke<string>("get_system_theme");
            if (!cancelled) applyIfAuto(initial === "dark");
          } catch {
            /* command not implemented yet */
          }
        })
        .catch(() => {
          /* no Tauri event API available */
        });
    } else if (mq) {
      // Upstream `:65-67`. In a browser the media query is the only source, so seed from it.
      applyIfAuto(mq.matches);
    }

    return () => {
      cancelled = true;
      mq?.removeEventListener("change", onMediaChange);
      unlistenTauri?.();
    };
    // Upstream `:74-76`: re-query on an explicit theme change. `matchMedia` stays pinned to the
    // prior theme after a programmatic switch, so `auto` needs a fresh read.
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, isDark }}>{children}</ThemeContext.Provider>
  );
}

/** Throws outside a `ThemeProvider` rather than handing back a silent default. */
export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error("useTheme must be used inside a <ThemeProvider>");
  return ctx;
}
