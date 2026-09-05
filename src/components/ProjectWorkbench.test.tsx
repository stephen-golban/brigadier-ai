import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { desktopApi } from "../desktopApi";
import { workbenchApi, defaultSettings } from "../workbenchApi";
import { workspaceApi } from "../workspaceApi";
import { ZERO_USAGE } from "../wire";
import type { SessionRuntime } from "../feedStore";
vi.mock("./CodeEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="File editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const project = {
  id: "p",
  name: "Brigadier",
  root_path: "/repo",
  created_at_ms: 1,
};
const parent: SessionRuntime = {
  sessionId: "parent",
  projectId: "p",
  status: "running",
  busy: false,
  model: null,
  cwd: "/repo/.brigadier/worktrees/parent",
  providerSessionId: null,
  worktreePath: "/repo/.brigadier/worktrees/parent",
  branch: "brigadier/parent",
  worktreeRemoved: false,
  resumed: false,
  lastTurnId: null,
  lastStop: null,
  costUsd: 0,
  usage: ZERO_USAGE,
  rowsTotal: 0,
  rowsDropped: 0,
  startedAtMs: 1,
  endedAtMs: null,
  exitCode: null,
  lastMessage: null,
  lastEventSeq: 0,
};
function Harness({ busy = false }: { busy?: boolean }) {
  const sessions = {
    parent: { ...parent, busy },
    child: { ...parent, sessionId: "child" },
  };
  const [selected, setSelected] = useState<string | null>("parent");
  const [panel, setPanel] = useState(false);
  return (
    <ProjectWorkbench
      project={project}
      session={selected ? sessions[selected as keyof typeof sessions] : null}
      sessions={sessions}
      selectedSessionId={selected}
      onSelectSession={setSelected}
      workspaceOpen={panel}
      setWorkspaceOpen={setPanel}
      models={[]}
      peers={{
        origins: { child: "parent" },
        titles: { parent: "Main task", child: "Research" },
        closed: [],
        messages: [],
        requests: [],
      }}
    >
      <div>Conversation {selected}</div>
    </ProjectWorkbench>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(workbenchApi, "load").mockResolvedValue({
    notes: [],
    projects: {},
    global: defaultSettings,
  });
  vi.spyOn(workspaceApi, "file").mockResolvedValue({
    path: "file.ts",
    content: "before",
    truncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
const key = (key: string, extra: Record<string, unknown> = {}) =>
  fireEvent.keyDown(window, { key, metaKey: true, ...extra });
describe("project tabs", () => {
  it("does not automatically open owned workhorses", async () => {
    render(<Harness />);
    expect(await screen.findByRole("tab", { name: "Main task" })).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Research/ }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });
  it("closes finished tabs into history and reopens them by keyboard", async () => {
    const discard = vi.spyOn(desktopApi, "discard");
    render(<Harness />);
    await screen.findByRole("tab");
    key("w");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search session history")).toBeVisible();
    expect(discard).not.toHaveBeenCalled();
    key("T", { shiftKey: true });
    expect(screen.getByRole("tab", { name: "Main task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("confirms working close and removes the tab before cleanup finishes", async () => {
    let finish!: () => void;
    const discard = vi
      .spyOn(desktopApi, "discard")
      .mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    render(<Harness busy />);
    await screen.findByRole("tab");
    key("w");
    expect(discard).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Stop and delete",
      }),
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(discard).toHaveBeenCalledWith(["parent"]);
    key("T", { shiftKey: true });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await act(async () => finish());
  });
  it("opens files in the main tab strip and cycles both directions", async () => {
    render(<Harness />);
    await screen.findByRole("tab");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      );
    });
    expect(await screen.findByLabelText("File editor")).toHaveValue("before");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Main task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("tab", { name: /file.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    key("1");
    expect(screen.getByRole("tab", { name: "Main task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("keeps a dirty file on Cancel and awaits Save before closing", async () => {
    let finish!: () => void;
    const save = vi
      .spyOn(workbenchApi, "save")
      .mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    render(<Harness />);
    await screen.findByRole("tab");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      );
    });
    const editor = await screen.findByLabelText("File editor");
    fireEvent.change(editor, { target: { value: "edited" } });
    key("w");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editor).toHaveValue("edited");
    key("w");
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
    );
    expect(screen.getByRole("tab", { name: /file.ts/ })).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      { projectId: "p", sessionId: "parent" },
      "file.ts",
      "edited",
      "before",
    );
    await act(async () => finish());
    expect(
      screen.queryByRole("tab", { name: /file.ts/ }),
    ).not.toBeInTheDocument();
  });
});
