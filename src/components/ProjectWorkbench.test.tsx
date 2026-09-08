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
import { workspaceApi, type GitStatus } from "../workspaceApi";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});
const key = (key: string, extra: Record<string, unknown> = {}) =>
  fireEvent.keyDown(window, { key, metaKey: true, ...extra });
describe("Git status refresh", () => {
  const status = (path: string): GitStatus => ({
    branch: "feature",
    changes: [{ path, index: " ", worktree: "M" }],
  });
  const workbench = (currentProject = project, currentSession = parent) => (
    <ProjectWorkbench
      project={currentProject}
      session={currentSession}
      sessions={{}}
      selectedSessionId={null}
      onSelectSession={vi.fn()}
      workspaceOpen
      setWorkspaceOpen={vi.fn()}
      models={[]}
      peers={{
        origins: {},
        titles: {},
        closed: [],
        messages: [],
        requests: [],
      }}
    >
      Conversation
    </ProjectWorkbench>
  );
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("brigadier:workspace-mode", JSON.stringify("changes"));
    vi.spyOn(workspaceApi, "entries").mockResolvedValue([]);
  });
  it.each(["poll", "manual", "restored"])(
    "keeps existing rows mounted during a %s refresh and updates them in place",
    async (trigger) => {
      const git = vi
        .spyOn(workspaceApi, "git")
        .mockResolvedValue(status("one.ts"));
      await act(async () => {
        render(workbench());
      });
      const row = screen.getByTitle("one.ts");
      row.focus();
      const message = screen.getByLabelText("Commit message");
      fireEvent.change(message, { target: { value: "Work in progress" } });
      row.focus();
      let finish!: (value: GitStatus) => void;
      git.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await act(async () => {
        if (trigger === "poll") await vi.advanceTimersByTimeAsync(5000);
        else if (trigger === "manual")
          fireEvent.click(screen.getByTitle("Refresh"));
        else window.dispatchEvent(new Event("workbench-files-restored"));
      });
      expect(git).toHaveBeenCalledTimes(2);
      expect(screen.getByTitle("one.ts")).toBe(row);
      expect(row).toHaveFocus();
      expect(screen.queryByText("Repository")).not.toBeInTheDocument();
      await act(async () =>
        finish({
          ...status("one.ts"),
          changes: [...status("one.ts").changes, ...status("two.ts").changes],
        }),
      );
      expect(screen.getByTitle("one.ts")).toBe(row);
      expect(screen.getByTitle("two.ts")).toBeVisible();
      expect(message).toHaveValue("Work in progress");

      git.mockRejectedValue(new Error("Git temporarily unavailable"));
      await act(async () => {
        fireEvent.click(screen.getByTitle("Refresh"));
      });
      expect(screen.getByTitle("one.ts")).toBe(row);
      expect(screen.getByTitle("two.ts")).toBeVisible();
    },
  );
  it.each(["project", "session"])(
    "clears the old workspace on a %s switch and ignores its pending refresh",
    async (target) => {
      const git = vi
        .spyOn(workspaceApi, "git")
        .mockResolvedValue(status("old.ts"));
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(workbench());
      });
      expect(screen.getByTitle("old.ts")).toBeVisible();
      let finishOld!: (value: GitStatus) => void;
      let finishNew!: (value: GitStatus) => void;
      git.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      fireEvent.click(screen.getByTitle("Refresh"));
      git.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
      view.rerender(
        target === "project"
          ? workbench({ ...project, id: "other-project" })
          : workbench(project, { ...parent, sessionId: "other-session" }),
      );
      expect(screen.queryByTitle("old.ts")).not.toBeInTheDocument();
      await act(async () => finishNew(status("new.ts")));
      await act(async () => finishOld(status("stale.ts")));
      expect(screen.getByTitle("new.ts")).toBeVisible();
      expect(screen.queryByTitle("stale.ts")).not.toBeInTheDocument();
    },
  );
});
describe("project tabs", () => {
  it("does not automatically open owned workhorses", async () => {
    render(<Harness />);
    expect(await screen.findByText("Conversation parent")).toBeVisible();
    expect(
      screen.queryByRole("tab", { name: "Main task" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Environment and agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Research/ }));
    expect(await screen.findByText("Conversation child")).toBeVisible();
  });
  it("closes finished tabs into history and reopens them by keyboard", async () => {
    const discard = vi.spyOn(desktopApi, "discard");
    render(<Harness />);
    await screen.findByText("Conversation parent");
    key("w");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search session history")).toBeVisible();
    expect(discard).not.toHaveBeenCalled();
    key("T", { shiftKey: true });
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("closes a working tab without stopping or deleting its session", async () => {
    const discard = vi.spyOn(desktopApi, "discard");
    render(<Harness busy />);
    await screen.findByText("Conversation parent");
    key("w");
    expect(discard).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    key("T", { shiftKey: true });
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("keeps the conversation visible while opening and cycling workspace tabs", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      );
    });
    expect(await screen.findByLabelText("File editor")).toHaveValue("before");
    expect(screen.getByText("Conversation parent")).toBeVisible();
    expect(screen.getByRole("tab", { name: /file.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("tab", { name: /file.ts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("keeps a dirty file on Cancel and awaits Save before closing", async () => {
    let finish!: () => void;
    const save = vi
      .spyOn(workbenchApi, "save")
      .mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
    render(<Harness />);
    await screen.findByText("Conversation parent");
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
    expect(
      screen.getByRole("tab", { name: /file.ts/, hidden: true }),
    ).toBeInTheDocument();
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
