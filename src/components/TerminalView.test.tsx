/**
 * What the terminal costs when nothing is happening, and what it does when something is.
 *
 * These render the real xterm — jsdom runs it once `matchMedia` grows the deprecated
 * `addListener` the setup file's stub omits — so "rendered correctly" means the escape sequence
 * was consumed by the emulator, not that this file re-implemented one.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import TerminalView, { terminalTimers } from "./TerminalView";
import type { Terminal } from "@xterm/xterm";
import { workspaceApi, type TerminalFrame } from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";

/**
 * What the next `fit()` should reflow to, or `null` for the no-op the real addon is in jsdom
 * (`proposeDimensions` needs a measured cell box and there is none). The real `FitAddon` is
 * replaced wholesale so a reflow is expressible at all; every test but the resize one leaves this
 * `null` and therefore sees exactly the no-op it saw before.
 */
let fitTo: { cols: number; rows: number } | null = null;
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private terminal: Terminal | undefined;
    activate(terminal: Terminal) {
      this.terminal = terminal;
    }
    dispose() {}
    fit() {
      if (fitTo) this.terminal?.resize(fitTo.cols, fitTo.rows);
    }
  },
}));

const tab = "terminal-test-tab";
const key = `brigadier:terminal:${tab}`;
let deliver: (frame: TerminalFrame) => void = () => {};
let seq = 0;
const teardown = vi.fn();
const saved = vi.fn();
const palette = ["canvas", "text", "text-secondary", "selected"];

beforeEach(() => {
  vi.useFakeTimers();
  fitTo = null;
  seq = 0;
  deliver = () => {};
  teardown.mockClear();
  saved.mockClear();
  // xterm asks for the deprecated MediaQueryList listener; the shared stub has only the modern
  // one, and `CoreBrowserService` throws without it.
  const stub = window.matchMedia("(min-resolution: 2dppx)") as MediaQueryList & {
    addListener?: () => void;
    removeListener?: () => void;
  };
  stub.addListener = () => {};
  stub.removeListener = () => {};
  window.matchMedia = () => stub;
  // `themeColor` throws on a missing token and jsdom loads no stylesheet; the palette itself is
  // `src/lib/theme.test.ts`'s subject, not this file's.
  for (const token of palette)
    document.documentElement.style.setProperty(`--color-${token}`, "#101010");
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    name: string,
    value: string,
  ) {
    if (name === key) saved(value);
    setItem.call(this, name, value);
  });
  vi.spyOn(workspaceApi, "openTerminal").mockResolvedValue("terminal-1");
  vi.spyOn(workspaceApi, "closeTerminal").mockResolvedValue();
  vi.spyOn(workspaceApi, "writeTerminal").mockResolvedValue();
  vi.spyOn(workspaceApi, "resizeTerminal").mockResolvedValue();
  vi.spyOn(workspaceApi, "readTerminal").mockRejectedValue(
    new Error("the polled fallback must not be used"),
  );
  vi.spyOn(workspaceApi, "subscribeTerminal").mockImplementation(
    async (_id, onFrame) => {
      deliver = onFrame;
      return teardown;
    },
  );
  vi.spyOn(workbenchApi, "terminalInfo").mockResolvedValue({
    cwd: "/repo/nested",
    busy: false,
  });
});
afterEach(() => {
  cleanup();
  for (const token of palette)
    document.documentElement.style.removeProperty(`--color-${token}`);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(props: { visible?: boolean; focused?: boolean; focusRequest?: number } = {}) {
  const view = render(
    <TerminalView
      context={{ projectId: "p", sessionId: "s" }}
      visible={props.visible ?? true}
      tabId={tab}
      focused={props.focused ?? false}
      focusRequest={props.focusRequest ?? 0}
    />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return view;
}
async function frame(partial: Partial<TerminalFrame> = {}) {
  seq += 1;
  await act(async () => {
    deliver({
      seq,
      bytes: "",
      dropped_before: 0,
      exited: false,
      drained: false,
      ...partial,
    });
    await vi.advanceTimersByTimeAsync(1);
  });
}
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function snapshotText() {
  return JSON.parse(localStorage.getItem(key) ?? "{}").output ?? "";
}
/** The visible characters, with the SGR/CSI codes the emulator emitted around them removed. */
function plain(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
}

it("subscribes instead of polling, and an idle PTY arms no timer", async () => {
  await mount();
  expect(workspaceApi.subscribeTerminal).toHaveBeenCalledWith(
    "terminal-1",
    expect.any(Function),
  );
  expect(workspaceApi.readTerminal).not.toHaveBeenCalled();
  expect(terminalTimers()).toBe(0);
  await wait(60_000);
  expect(terminalTimers()).toBe(0);
  expect(saved).not.toHaveBeenCalled();
  expect(workbenchApi.terminalInfo).not.toHaveBeenCalled();
});

it("arms one snapshot deadline per burst of output and disarms itself", async () => {
  // Hidden: a background tab still streams and still snapshots, and no CWD check runs to arm a
  // deadline of its own (that is the next test's subject).
  await mount({ visible: false });
  await frame({ bytes: btoa("one") });
  expect(terminalTimers()).toBe(1);
  await frame({ bytes: btoa(" two") });
  expect(terminalTimers()).toBe(1);
  await wait(3000);
  expect(terminalTimers()).toBe(0);
  expect(saved).toHaveBeenCalledTimes(1);
  // Nothing new: no second serialization, ever, until the next byte arrives.
  await wait(30_000);
  expect(saved).toHaveBeenCalledTimes(1);
  await frame({ bytes: btoa(" three") });
  await wait(3000);
  expect(saved).toHaveBeenCalledTimes(2);
  expect(plain(snapshotText())).toContain("one two three");
});

it("renders an escape sequence split across two frames", async () => {
  await mount();
  await frame({ bytes: btoa("hello \x1b[3") });
  await frame({ bytes: btoa("1mred\x1b[0m done") });
  await wait(3000);
  const output = snapshotText();
  expect(plain(output)).toBe("hello red done");
  // A half-sequence written as text would have left "1mred" on screen.
  expect(plain(output)).not.toContain("1mred");
  expect(output).toContain("\x1b[31m");
});

it("shows the overflow notice before the bytes that survived", async () => {
  await mount();
  await frame({ bytes: btoa("kept"), dropped_before: 4096 });
  await wait(3000);
  expect(plain(snapshotText())).toContain(
    "[4096 bytes skipped while output exceeded the buffer] kept",
  );
});

it("prints the exit notice after the final bytes", async () => {
  await mount();
  await frame({ bytes: btoa("last line") });
  await frame({ bytes: "", exited: true, drained: true });
  await wait(3000);
  expect(plain(snapshotText())).toBe("last line [Process exited]");
});

it("checks the CWD only when it can have changed", async () => {
  const view = await mount({ visible: false });
  await frame({ bytes: btoa("background output") });
  await wait(3000);
  expect(workbenchApi.terminalInfo).not.toHaveBeenCalled();
  view.rerender(
    <TerminalView
      context={{ projectId: "p", sessionId: "s" }}
      visible
      tabId={tab}
      focused={false}
      focusRequest={0}
    />,
  );
  await frame({ bytes: btoa("foreground output") });
  await wait(3000);
  expect(workbenchApi.terminalInfo).toHaveBeenCalledTimes(1);
  // The check consumed its reason; a second deadline without new output does not repeat it.
  await wait(30_000);
  expect(workbenchApi.terminalInfo).toHaveBeenCalledTimes(1);
  // A new CWD is worth one more snapshot, and the reopened shell starts there.
  expect(JSON.parse(localStorage.getItem(key) ?? "{}").cwd).toBe("/repo/nested");
});

it("checks the CWD when the tab takes focus", async () => {
  const view = await mount({ focused: true });
  expect(workbenchApi.terminalInfo).not.toHaveBeenCalled();
  view.rerender(
    <TerminalView
      context={{ projectId: "p", sessionId: "s" }}
      visible
      tabId={tab}
      focused
      focusRequest={1}
    />,
  );
  await wait(1);
  expect(workbenchApi.terminalInfo).toHaveBeenCalledTimes(1);
});

it("tears the subscription down on unmount and persists only what changed", async () => {
  const view = await mount();
  view.unmount();
  await wait(1);
  expect(teardown).toHaveBeenCalledTimes(1);
  expect(workspaceApi.closeTerminal).toHaveBeenCalledWith("terminal-1");
  expect(saved).not.toHaveBeenCalled();
  expect(terminalTimers()).toBe(0);
});

it("flushes a dirty snapshot on unmount and on pagehide", async () => {
  const view = await mount();
  await frame({ bytes: btoa("unsaved") });
  view.unmount();
  await wait(1);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(plain(snapshotText())).toContain("unsaved");

  saved.mockClear();
  await mount();
  await frame({ bytes: btoa("more") });
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(saved).toHaveBeenCalledTimes(1);
  // The deadline is still armed but has nothing left to write.
  await wait(3000);
  expect(saved).toHaveBeenCalledTimes(1);
});

it("persists a snapshot after a resize that no output followed", async () => {
  const view = await mount({ visible: false });
  expect(saved).not.toHaveBeenCalled();

  // `resize()` bails on a zero-width host, so the mount's own calls did nothing. From here the
  // host has a width and `fit()` really reflows.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
  fitTo = { cols: 40, rows: 12 };
  view.rerender(
    <TerminalView
      context={{ projectId: "p", sessionId: "s" }}
      visible
      tabId={tab}
      focused={false}
      focusRequest={0}
    />,
  );
  await wait(1);
  expect(workspaceApi.resizeTerminal).toHaveBeenCalledWith("terminal-1", 40, 12);
  // The reflow rewrapped the scrollback and nothing else will: no byte arrives after it.
  expect(terminalTimers()).toBe(0);
  view.unmount();
  await wait(1);
  expect(saved).toHaveBeenCalledTimes(1);
});
