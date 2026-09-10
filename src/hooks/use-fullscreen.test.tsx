import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  enabled: true,
  fullscreen: vi.fn(),
  onResized: vi.fn(),
  unlisten: vi.fn(),
  /** Set by the mocked `onResized` so a test can fire a resize itself. */
  resize: undefined as undefined | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.enabled }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: native.fullscreen,
    onResized: native.onResized,
  }),
}));
import { useFullscreen } from "./use-fullscreen";
function Host() {
  useFullscreen();
  return null;
}
beforeEach(() => {
  native.enabled = true;
  native.fullscreen.mockReset().mockResolvedValue(false);
  native.unlisten.mockReset();
  native.resize = undefined;
  native.onResized.mockReset().mockImplementation((handler: () => void) => {
    native.resize = handler;
    return Promise.resolve(native.unlisten);
  });
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.fullscreen;
});

it("seeds the attribute from the window and clears it on unmount", async () => {
  native.fullscreen.mockResolvedValue(true);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Host />);
  });
  expect(document.documentElement.dataset.fullscreen).toBe("true");
  view.unmount();
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
  expect(native.unlisten).toHaveBeenCalled();
});

it("leaves the attribute off while the window is not fullscreen", async () => {
  await act(async () => {
    render(<Host />);
  });
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
  expect(native.onResized).toHaveBeenCalled();
});

it("re-polls fullscreen on every resize, in both directions", async () => {
  await act(async () => {
    render(<Host />);
  });
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
  native.fullscreen.mockResolvedValue(true);
  await act(async () => native.resize?.());
  expect(document.documentElement.dataset.fullscreen).toBe("true");
  native.fullscreen.mockResolvedValue(false);
  await act(async () => native.resize?.());
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
});

it("treats a window that cannot answer as windowed", async () => {
  native.fullscreen.mockRejectedValue(new Error("Unsupported"));
  await act(async () => {
    render(<Host />);
  });
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
});

it("does not call native APIs from the browser preview", () => {
  native.enabled = false;
  render(<Host />);
  expect(native.fullscreen).not.toHaveBeenCalled();
  expect(native.onResized).not.toHaveBeenCalled();
});

it("stops a listener that resolves after unmount", async () => {
  let attach!: () => void;
  native.onResized.mockReturnValue(
    new Promise<() => void>((done) => {
      attach = () => done(native.unlisten);
    }),
  );
  const view = render(<Host />);
  view.unmount();
  await act(async () => attach());
  expect(native.unlisten).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.fullscreen).toBeUndefined();
});
