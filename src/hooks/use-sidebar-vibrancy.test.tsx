import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  enabled: true,
  effects: vi.fn(),
  focus: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({
  Effect: { Menu: "menu", Sidebar: "sidebar" },
  EffectState: {
    Active: "active",
    FollowsWindowActiveState: "followsWindowActiveState",
  },
  getCurrentWindow: () => ({
    setEffects: native.effects,
    onFocusChanged: native.focus,
  }),
}));
import { useSidebarVibrancy } from "./use-sidebar-vibrancy";
function Host() {
  useSidebarVibrancy();
  return null;
}
beforeEach(() => {
  native.enabled = true;
  native.effects.mockReset().mockResolvedValue(undefined);
  native.unlisten.mockReset();
  native.focus.mockReset().mockResolvedValue(native.unlisten);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.windowFocused;
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
    effects: ["menu"],
    state: "followsWindowActiveState",
  });
  expect(document.documentElement.dataset.sidebarVibrancy).toBe("true");
  view.unmount();
  expect(document.documentElement.dataset.sidebarVibrancy).toBeUndefined();
});
it("marks the window unfocused so the sidebar can paint itself opaque", async () => {
  const view = render(<Host />);
  await act(async () => {});
  const notify = native.focus.mock.calls[0][0] as (event: {
    payload: boolean;
  }) => void;
  expect(document.documentElement.dataset.windowFocused).toBeUndefined();
  act(() => notify({ payload: false }));
  expect(document.documentElement.dataset.windowFocused).toBe("false");
  act(() => notify({ payload: true }));
  expect(document.documentElement.dataset.windowFocused).toBeUndefined();
  act(() => notify({ payload: false }));
  view.unmount();
  await act(async () => {});
  expect(document.documentElement.dataset.windowFocused).toBeUndefined();
  expect(native.unlisten).toHaveBeenCalled();
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
  expect(native.focus).not.toHaveBeenCalled();
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
