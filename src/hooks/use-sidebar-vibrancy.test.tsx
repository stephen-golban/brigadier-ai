import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ enabled: true, effects: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({
  Effect: { Sidebar: "sidebar" },
  EffectState: { Active: "active" },
  getCurrentWindow: () => ({ setEffects: native.effects }),
}));
import { useSidebarVibrancy } from "./use-sidebar-vibrancy";
function Host() {
  useSidebarVibrancy();
  return null;
}
beforeEach(() => {
  native.enabled = true;
  native.effects.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("exposes native material only after it is successfully installed", async () => {
  let resolve!: () => void;
  native.effects.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const view = render(<Host />);
  expect(document.documentElement.dataset.sidebarVibrancy).toBeUndefined();
  await act(async () => resolve());
  expect(native.effects).toHaveBeenCalledWith({
    effects: ["sidebar"],
    state: "active",
  });
  expect(document.documentElement.dataset.sidebarVibrancy).toBe("true");
  view.unmount();
  expect(document.documentElement.dataset.sidebarVibrancy).toBeUndefined();
});
it("retains the opaque fallback when the native effect fails", async () => {
  native.effects.mockRejectedValue(new Error("Unsupported"));
  await act(async () => {
    render(<Host />);
  });
  expect(document.documentElement.dataset.sidebarVibrancy).toBeUndefined();
});
it("does not call native APIs from the browser preview", () => {
  native.enabled = false;
  render(<Host />);
  expect(native.effects).not.toHaveBeenCalled();
});
it("respects reduced transparency and ignores effects resolving after unmount", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const view = render(<Host />);
  expect(native.effects).not.toHaveBeenCalled();
  view.unmount();
  vi.restoreAllMocks();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  let resolve!: () => void;
  native.effects.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const pending = render(<Host />);
  pending.unmount();
  await act(async () => resolve());
  expect(document.documentElement.dataset.sidebarVibrancy).toBeUndefined();
});
