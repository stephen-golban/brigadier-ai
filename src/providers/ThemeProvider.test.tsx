/**
 * Behavioural tests for `src/providers/ThemeProvider.tsx`.
 *
 * These pin the provider's contract — what `useTheme()` reports and what gets persisted — never
 * markup. The provider renders nothing of its own but its children, so there is no markup to pin,
 * and the shell that will mount it (W4-C) must be free to change without touching this file.
 *
 * Mechanics, matching `src/feedStore.test.ts` and `docs/research/frontend-stack.md` §1.6:
 *
 *   - `globals: false`, so every helper is imported from "vitest" explicitly.
 *   - `vi.resetModules()` in `afterEach` plus a per-test `await import(…)`. The module reads
 *     `localStorage` at first render, so each test needs a module that has not read it yet.
 *   - `@testing-library/react`'s auto-cleanup only registers itself when a global `afterEach`
 *     exists, which `globals: false` denies it, so `cleanup()` is called by hand.
 *
 * jsdom 30.0.1 does not implement `window.matchMedia` at all — `TypeError: window.matchMedia is
 * not a function` [measured] — so these tests install a controllable stub. That is not a
 * convenience: the absence is the reason the provider guards the call, and `noMatchMedia` below
 * pins the un-stubbed case too.
 *
 * NOT COVERED, and deliberately: the Tauri branch. `isTauri()` is false under jsdom (it tests
 * `window.__TAURI_INTERNALS__`), and the `theme-changed` event it listens for has no emitter
 * anywhere in this repo. There is nothing real to assert against, and a mock would only pin the
 * mock. The Linux desktop-portal path is untested here and untested anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type Mod = typeof import("./ThemeProvider");

const STORAGE_KEY = "brigadier.theme";

/** A `matchMedia` whose `matches` this test can flip, firing `change` like a real one does. */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = initialDark;

  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) =>
      void listeners.delete(fn),
  };

  window.matchMedia = (() => mql) as unknown as typeof window.matchMedia;

  return {
    /** What the OS switching appearance looks like to the page. */
    set(next: boolean) {
      matches = next;
      act(() => {
        for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
      });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function noMatchMedia() {
  delete (window as { matchMedia?: unknown }).matchMedia;
}

/** Renders the provider and hands back a live view of what `useTheme()` reports. */
function mount(mod: Mod) {
  const seen = { theme: "" as string, isDark: false, setTheme: (_: string) => {} };

  function Probe() {
    const s = mod.useTheme();
    seen.theme = s.theme;
    seen.isDark = s.isDark;
    seen.setTheme = s.setTheme as (t: string) => void;
    return null;
  }

  const r = render(
    <mod.ThemeProvider>
      <Probe />
    </mod.ThemeProvider>,
  );
  return { seen, unmount: r.unmount };
}

async function load(): Promise<Mod> {
  vi.resetModules();
  return await import("./ThemeProvider");
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  noMatchMedia();
  vi.resetModules();
});

describe("stored preference", () => {
  it("honours a stored 'dark' even when the system prefers light", async () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    installMatchMedia(false);

    const { seen } = mount(await load());

    expect(seen.theme).toBe("dark");
    expect(seen.isDark).toBe(true);
  });

  it("honours a stored 'light' even when the system prefers dark", async () => {
    localStorage.setItem(STORAGE_KEY, "light");
    installMatchMedia(true);

    const { seen } = mount(await load());

    expect(seen.theme).toBe("light");
    expect(seen.isDark).toBe(false);
  });

  it("falls back to 'auto' when nothing is stored", async () => {
    installMatchMedia(false);

    const { seen } = mount(await load());

    expect(seen.theme).toBe("auto");
  });

  it("falls back to 'auto' when the stored value is not a theme", async () => {
    localStorage.setItem(STORAGE_KEY, "solarized");
    installMatchMedia(true);

    const { seen } = mount(await load());

    expect(seen.theme).toBe("auto");
    expect(seen.isDark).toBe(true);
  });

  it("persists a choice so the next mount reads it back", async () => {
    installMatchMedia(false);

    const first = mount(await load());
    act(() => first.seen.setTheme("dark"));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    first.unmount();
    cleanup();

    const { seen } = mount(await load());
    expect(seen.theme).toBe("dark");
    expect(seen.isDark).toBe(true);
  });
});

describe("auto follows prefers-color-scheme", () => {
  it("resolves dark when the system prefers dark", async () => {
    installMatchMedia(true);

    const { seen } = mount(await load());

    expect(seen.theme).toBe("auto");
    expect(seen.isDark).toBe(true);
  });

  it("resolves light when the system prefers light", async () => {
    installMatchMedia(false);

    const { seen } = mount(await load());

    expect(seen.isDark).toBe(false);
  });

  it("reflects a media-query change while on auto", async () => {
    const mm = installMatchMedia(false);

    const { seen } = mount(await load());
    expect(seen.isDark).toBe(false);

    mm.set(true);
    expect(seen.isDark).toBe(true);

    mm.set(false);
    expect(seen.isDark).toBe(false);
  });

  it("ignores a media-query change once a theme is chosen explicitly", async () => {
    const mm = installMatchMedia(false);

    const { seen } = mount(await load());
    act(() => seen.setTheme("light"));

    mm.set(true);

    expect(seen.theme).toBe("light");
    expect(seen.isDark).toBe(false);
  });

  it("picks the system value back up when the choice returns to auto", async () => {
    localStorage.setItem(STORAGE_KEY, "light");
    const mm = installMatchMedia(true);

    const { seen } = mount(await load());
    expect(seen.isDark).toBe(false);

    act(() => seen.setTheme("auto"));

    expect(seen.isDark).toBe(true);
    mm.set(false);
    expect(seen.isDark).toBe(false);
  });

  it("removes its media listener on unmount", async () => {
    const mm = installMatchMedia(false);

    const { unmount } = mount(await load());
    expect(mm.listenerCount).toBe(1);

    unmount();
    expect(mm.listenerCount).toBe(0);
  });
});

describe("no matchMedia", () => {
  it("mounts and resolves auto to light when the environment has none", async () => {
    noMatchMedia();

    const { seen } = mount(await load());

    expect(seen.theme).toBe("auto");
    expect(seen.isDark).toBe(false);
  });

  it("still honours an explicit stored theme with none", async () => {
    noMatchMedia();
    localStorage.setItem(STORAGE_KEY, "dark");

    const { seen } = mount(await load());

    expect(seen.isDark).toBe(true);
  });
});

describe("the .dark class", () => {
  // This class has no visual effect today: brigadier is dark-only and `src/index.css` has no
  // light token set for it to switch to. It is asserted because it is the provider's own output
  // contract, and it is the seam a light scheme would attach to.
  it("tracks isDark on the root element", async () => {
    const mm = installMatchMedia(false);

    const { seen } = mount(await load());
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    mm.set(true);
    expect(seen.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("useTheme outside a provider", () => {
  it("throws rather than returning a silent default", async () => {
    const mod = await load();

    function Bare() {
      mod.useTheme();
      return null;
    }

    // React logs the error boundary trace on the way out; that noise is not the assertion.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/useTheme must be used inside/);
    err.mockRestore();
  });
});
