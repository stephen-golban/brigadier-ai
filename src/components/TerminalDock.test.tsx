import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import userEvent from "@testing-library/user-event";
import { TerminalDock } from "./TerminalDock";
import { workspaceApi } from "../workspaceApi";
import { workbenchApi } from "../workbenchApi";
import type { ProjectLayout } from "../workbenchState";
const lifecycle = vi.hoisted(() => ({ starts: vi.fn(), stops: vi.fn() }));
vi.mock("./TerminalView", () => ({
  default: ({
    tabId,
    shell,
    cwd,
    onReady,
  }: {
    tabId: string;
    shell: string;
    cwd: string;
    onReady: (id: string | null) => void;
  }) => {
    useEffect(() => {
      lifecycle.starts(tabId, shell, cwd);
      onReady(tabId);
      return () => {
        lifecycle.stops(tabId);
        onReady(null);
      };
    }, []);
    return <textarea aria-label={`Shell ${tabId}`} />;
  },
}));
let latest: ProjectLayout;
function Harness({
  active = true,
  suspended = false,
  initial = { tabs: [], active: null },
}: {
  active?: boolean;
  suspended?: boolean;
  initial?: ProjectLayout;
}) {
  const [layout, setLayout] = useState(initial);
  latest = layout;
  return (
    <TerminalDock
      active={active}
      suspended={suspended}
      context={{ projectId: "p", sessionId: "s" }}
      layout={layout}
      onChange={setLayout}
      onReady={() => {}}
    />
  );
}
beforeEach(() => {
  lifecycle.starts.mockClear();
  lifecycle.stops.mockClear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(workspaceApi, "terminalProfiles").mockResolvedValue([
    { path: "/bin/zsh", name: "zsh", default: true },
    { path: "/bin/bash", name: "bash", default: false },
  ]);
  vi.spyOn(workbenchApi, "terminalInfo").mockResolvedValue({
    cwd: "/repo/subdir",
    busy: false,
  });
  vi.spyOn(workspaceApi, "closeTerminal").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const toggle = () =>
  act(() => window.dispatchEvent(new Event("workbench-terminal-toggle")));
it("uses the default shell, chooses another profile, and starts split shells in the parent's cwd", async () => {
  render(<Harness />);
  await act(async () => {});
  toggle();
  await screen.findByRole("textbox");
  expect(lifecycle.starts.mock.calls[0][1]).toBe("/bin/zsh");
  await userEvent.click(
    screen.getByRole("button", { name: "Terminal profiles" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "bash" }));
  await waitFor(() => expect(lifecycle.starts).toHaveBeenCalledTimes(2));
  const bash = latest.activeTerminal!;
  await userEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  await waitFor(() => expect(lifecycle.starts).toHaveBeenCalledTimes(3));
  expect(workbenchApi.terminalInfo).toHaveBeenCalledWith(bash);
  expect(lifecycle.starts.mock.calls[2].slice(1)).toEqual([
    "/bin/bash",
    "/repo/subdir",
  ]);
  expect(latest.tabs[2].terminalGroup).toBe(latest.tabs[1].terminalGroup);
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
});
it("preserves shell processes when hidden or inactive and remounts fresh shells after archive", async () => {
  const view = render(<Harness />);
  toggle();
  await screen.findByRole("textbox");
  toggle();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(lifecycle.stops).not.toHaveBeenCalled();
  view.rerender(<Harness active={false} />);
  expect(lifecycle.stops).not.toHaveBeenCalled();
  view.rerender(<Harness suspended />);
  expect(lifecycle.stops).toHaveBeenCalledOnce();
  view.rerender(<Harness />);
  toggle();
  await screen.findByRole("textbox");
  expect(lifecycle.starts).toHaveBeenCalledTimes(2);
});
it("handles VS Code create, split, pane/group focus, clear-independent shortcuts, and list deletion", async () => {
  render(<Harness />);
  fireEvent.keyDown(window, { ctrlKey: true, code: "Backquote", key: "`" });
  let input = await screen.findByRole("textbox");
  fireEvent.keyDown(input, { metaKey: true, code: "Backslash", key: "\\" });
  await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
  const [first, second] = latest.tabs;
  fireEvent.keyDown(screen.getAllByRole("textbox")[1], {
    metaKey: true,
    altKey: true,
    code: "ArrowLeft",
    key: "ArrowLeft",
  });
  expect(latest.activeTerminal).toBe(first.id);
  fireEvent.keyDown(window, {
    ctrlKey: true,
    shiftKey: true,
    code: "Backquote",
    key: "~",
  });
  await waitFor(() => expect(lifecycle.starts).toHaveBeenCalledTimes(3));
  fireEvent.keyDown(screen.getByRole("textbox"), {
    metaKey: true,
    shiftKey: true,
    code: "BracketLeft",
    key: "{",
  });
  expect(latest.activeTerminal).toBe(first.id);
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  const options = within(
    screen.getByRole("listbox", { name: "Terminals" }),
  ).getAllByRole("option");
  await userEvent.click(options[1]);
  expect(latest.activeTerminal).toBe(second.id);
  fireEvent.keyDown(options[1], { key: "Delete" });
  await waitFor(() =>
    expect(workspaceApi.closeTerminal).toHaveBeenCalledWith(second.id),
  );
  expect(latest.tabs).toHaveLength(2);
});
it("restores group layout without serializing commands and retains document state when terminals change", async () => {
  const initial: ProjectLayout = {
    active: "file",
    tabs: [
      {
        id: "file",
        kind: "file",
        root: "/repo",
        path: "a.ts",
        context: { projectId: "p", sessionId: "s" },
      },
    ],
  };
  let view = render(<Harness initial={initial} />);
  toggle();
  await screen.findByRole("textbox");
  await userEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  await waitFor(() => expect(lifecycle.starts).toHaveBeenCalledTimes(2));
  const saved = structuredClone(latest);
  view.unmount();
  view = render(<Harness initial={saved} />);
  await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
  expect(latest.active).toBe("file");
  expect(latest.tabs[0]).toEqual(initial.tabs[0]);
  expect(latest.activeTerminal).toBe(saved.activeTerminal);
});

it("can unsplit the original pane and resize split panes without losing the group", async () => {
  render(<Harness />);
  toggle();
  await screen.findByRole("textbox");
  await userEvent.click(screen.getByRole("button", { name: "Split terminal" }));
  await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(2));
  const original = latest.tabs[0];
  fireEvent.keyDown(
    screen.getByRole("separator", { name: "Resize terminal split" }),
    { key: "ArrowRight" },
  );
  expect(latest.tabs[0].terminalWeight).toBeGreaterThan(1);
  const actions = screen.getAllByRole("button", { name: /Actions for/ });
  await userEvent.click(actions[0]);
  await userEvent.click(screen.getByRole("menuitem", { name: "Unsplit" }));
  expect(latest.tabs[0].terminalGroup).not.toBe(latest.tabs[1].terminalGroup);
  expect(latest.activeTerminal).toBe(original.id);
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
});
