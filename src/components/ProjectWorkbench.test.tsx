import { readArchive } from "../sessionArchive";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { sessionLayoutsKey, workspaceKey } from "../workbenchState";
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
vi.mock("./VscodePanels", () => ({
  VscodePanels: vi.fn(() => <div data-testid="vscode-panel" />),
}));
vi.mock("./SourceControl", () => ({
  SourceControl: vi.fn(() => <div data-testid="changes-panel" />),
}));
import { SourceControl } from "./SourceControl";
const panelBinding = () => {
  const calls = vi.mocked(SourceControl).mock.calls;
  return calls[calls.length - 1][0];
};
vi.mock("./TerminalView", () => ({
  default: ({ onReady }: { onReady?: (id: string | null) => void }) => {
    useEffect(() => {
      onReady?.("test-terminal");
      return () => onReady?.(null);
    }, []);
    return <div>Test terminal</div>;
  },
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
    <>
      <button onClick={() => setSelected("parent")}>Select parent</button>
      <button onClick={() => setSelected("child")}>Select child</button>
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
    </>
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
  const workbench = (
    currentProject = project,
    currentSession = parent,
    workspaceOpen = true,
  ) => (
    <ProjectWorkbench
      project={currentProject}
      session={currentSession}
      sessions={{}}
      selectedSessionId={null}
      onSelectSession={vi.fn()}
      workspaceOpen={workspaceOpen}
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
  it("orders Files, Search, Changes and refreshes the count with the panel hidden", async () => {
    const git = vi.spyOn(workspaceApi, "git").mockResolvedValue({
      branch: "main",
      changes: [
        { path: "staged.ts", index: "M", worktree: " " },
        { path: "both.ts", index: "M", worktree: "M" },
        { path: "untracked.ts", index: "?", worktree: "?" },
      ],
    });
    await act(async () => {
      render(workbench(project, parent, false));
    });
    const actions = within(
      screen.getByRole("group", { name: "Workspace panels" }),
    );
    expect(
      actions
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Files", "Search", "Changes", "Terminal"]);
    const changes = actions.getByRole("button", { name: "Changes" });
    expect(changes).toHaveTextContent("3");
    expect(changes).toHaveAttribute("title", "Changes (3)");
    expect(changes).toHaveAttribute("aria-description", "3 changed files");
    expect(changes).toHaveAttribute("aria-pressed", "false");
    git.mockResolvedValue(status("one.ts"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(changes).toHaveTextContent("1");
    expect(changes).toHaveAttribute("aria-description", "1 changed file");
    git.mockResolvedValue({ branch: "main", changes: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(changes.querySelector(".workbench-change-count")).toBeNull();
    expect(changes).toHaveAttribute("title", "Changes");
  });
  it.each(["poll", "manual", "restored"])(
    "retains the panel binding during a %s refresh and updates status in place",
    async (trigger) => {
      const git = vi
        .spyOn(workspaceApi, "git")
        .mockResolvedValue(status("one.ts"));
      await act(async () => {
        render(workbench());
      });
      const panel = screen.getByTestId("changes-panel");
      expect(panelBinding().status?.changes[0].path).toBe("one.ts");
      let finish!: (value: GitStatus) => void;
      git.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await act(async () => {
        if (trigger === "poll") await vi.advanceTimersByTimeAsync(5000);
        else if (trigger === "manual") panelBinding().refresh();
        else window.dispatchEvent(new Event("workbench-files-restored"));
      });
      expect(git).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("changes-panel")).toBe(panel);
      expect(panelBinding().status?.changes[0].path).toBe("one.ts");
      await act(async () =>
        finish({
          ...status("one.ts"),
          changes: [...status("one.ts").changes, ...status("two.ts").changes],
        }),
      );
      expect(screen.getByTestId("changes-panel")).toBe(panel);
      expect(panelBinding().status?.changes.map((c) => c.path)).toEqual([
        "one.ts",
        "two.ts",
      ]);
      git.mockRejectedValue(new Error("Git temporarily unavailable"));
      await act(async () => panelBinding().refresh());
      expect(panelBinding().status?.changes.map((c) => c.path)).toEqual([
        "one.ts",
        "two.ts",
      ]);
    },
  );
  it.each(["project", "session"])(
    "clears the old panel workspace on a %s switch and ignores its pending refresh",
    async (target) => {
      const git = vi
        .spyOn(workspaceApi, "git")
        .mockResolvedValue(status("old.ts"));
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(workbench());
      });
      expect(panelBinding().status?.changes[0].path).toBe("old.ts");
      let finishOld!: (value: GitStatus) => void,
        finishNew!: (value: GitStatus) => void;
      git.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      act(() => panelBinding().refresh());
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
      expect(panelBinding().status).toBeNull();
      await act(async () => finishNew(status("new.ts")));
      await act(async () => finishOld(status("stale.ts")));
      expect(panelBinding().status?.changes.map((c) => c.path)).toEqual([
        "new.ts",
      ]);
    },
  );
});
const openFile = (path = "file.ts") =>
  act(() =>
    window.dispatchEvent(
      new CustomEvent("workbench-open-file", { detail: { path } }),
    ),
  );
const savedWorkspace = (id = "parent") =>
  JSON.parse(localStorage.getItem(sessionLayoutsKey) ?? "{}")[
    workspaceKey("p", id)
  ];
const archiveCurrent = async () => {
  await userEvent.click(
    screen.getByRole("button", { name: "Session actions" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
};
describe("session workspaces", () => {
  it("renders a title and one session menu without session tabs or a plus button", async () => {
    render(<Harness />);
    expect(await screen.findByText("Conversation parent")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show conversation" }),
    ).toHaveTextContent("Main task");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New tab" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Main task" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Session actions" }),
    ).toHaveLength(1);
    expect(document.querySelector(".session-tab-divider")).toBeNull();
  });
  it("keeps the session menu attached to the title while viewing a file", async () => {
    render(<Harness />);
    openFile();
    await screen.findByLabelText("File editor");
    expect(document.querySelector(".session-tab-divider")).not.toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Session actions" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByLabelText("Session name")).toHaveValue("Main task");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show conversation" }),
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("restores each sidebar session's documents, selected view, and unsaved buffer", async () => {
    render(<Harness />);
    openFile();
    fireEvent.change(await screen.findByLabelText("File editor"), {
      target: { value: "parent draft" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Select child" }));
    expect(
      screen.queryByRole("tab", { name: "file.ts" }),
    ).not.toBeInTheDocument();
    openFile("child.ts");
    await screen.findByLabelText("File editor");
    await userEvent.click(
      screen.getByRole("button", { name: "Select parent" }),
    );
    expect(await screen.findByLabelText("File editor")).toHaveValue(
      "parent draft",
    );
    expect(
      screen.queryByRole("tab", { name: "child.ts" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Show conversation" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Select child" }));
    expect(screen.getByRole("tab", { name: "child.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Select parent" }),
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("does not archive or navigate away when Cmd+W or native close targets the conversation", async () => {
    render(<Harness busy />);
    await screen.findByText("Conversation parent");
    key("w");
    act(() => window.dispatchEvent(new Event("workbench-close-tab")));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readArchive().entries).toEqual({});
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("archives explicitly and restores the saved document and draft from History", async () => {
    render(<Harness />);
    openFile();
    fireEvent.change(await screen.findByLabelText("File editor"), {
      target: { value: "kept draft" },
    });
    await archiveCurrent();
    await waitFor(() => expect(readArchive().entries.parent).toBeDefined());
    expect(
      savedWorkspace().tabs.some((t: { path: string }) => t.path === "file.ts"),
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    await userEvent.click(screen.getByRole("button", { name: "Main task" }));
    expect(await screen.findByLabelText("File editor")).toHaveValue(
      "kept draft",
    );
    expect(readArchive().entries.parent).toBeUndefined();
  });
  it("asks once before stopping active AI work and preserves the workspace on cancel", async () => {
    render(<Harness busy />);
    await archiveCurrent();
    expect(
      await screen.findByRole("dialog", { name: "Stop and archive session?" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(readArchive().entries.parent).toBeUndefined();
    await archiveCurrent();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop and archive" }),
    );
    await waitFor(() => expect(readArchive().entries.parent).toBeDefined());
  });
  it("opens Files without a placeholder, reuses files, and keeps panel toggles independent", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    openFile();
    await screen.findByLabelText("File editor");
    openFile();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    for (const name of ["Files", "Search", "Changes"]) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
  });
  it("cycles between conversation and files and reopens a closed document", async () => {
    render(<Harness />);
    openFile();
    await screen.findByLabelText("File editor");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByText("Conversation parent")).toBeVisible();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    key("w");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    key("T", { shiftKey: true });
    expect(await screen.findByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("creates a new sidebar conversation from Cmd+T without a session tab", async () => {
    render(<Harness />);
    openFile();
    const editor = await screen.findByLabelText("File editor");
    editor.addEventListener("keydown", (event) => event.stopPropagation());
    fireEvent.keyDown(editor, { key: "t", metaKey: true });
    expect(
      screen.getByRole("button", { name: "Show conversation" }),
    ).toHaveTextContent("New session");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Select parent" }),
    );
    expect(await screen.findByLabelText("File editor")).toBeVisible();
  });
  it("keeps terminals below documents and alive across session switching", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Terminal" }));
    const terminal = await screen.findByText("Test terminal");
    expect(terminal).toBeVisible();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    openFile();
    await screen.findByLabelText("File editor");
    expect(terminal).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Select child" }));
    expect(terminal).not.toBeVisible();
    expect(terminal).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Select parent" }),
    );
    expect(terminal).toBeVisible();
    expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hide terminal" }),
    );
    // The dock now closes through CSS animation; jsdom does not load that CSS.
    // Assert its closed accessibility/layout state while preserving the PTY view.
    const dock = terminal.closest(".terminal-dock");
    expect(dock).toHaveAttribute("data-open", "false");
    expect(dock).toHaveAttribute("aria-hidden", "true");
    expect(dock).toHaveAttribute("inert");
    expect(dock).toHaveStyle({ height: "0px" });
    expect(terminal).toBeInTheDocument();
  });
  it("confirms killing a busy terminal and does not archive the session", async () => {
    vi.spyOn(workbenchApi, "terminalInfo").mockResolvedValue({
      busy: true,
      cwd: "/repo",
    });
    const close = vi.spyOn(workspaceApi, "closeTerminal").mockResolvedValue();
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByText("Test terminal");
    await userEvent.click(
      screen.getByRole("button", { name: "Kill terminal" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Kill running terminal?" }),
    ).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Kill terminal",
      }),
    );
    await waitFor(() => expect(close).toHaveBeenCalledWith("test-terminal"));
    expect(readArchive().entries).toEqual({});
  });
  it("includes busy terminals in the archive confirmation and retains their layout", async () => {
    vi.spyOn(workbenchApi, "terminalInfo").mockResolvedValue({
      busy: true,
      cwd: "/repo",
    });
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByText("Test terminal");
    await archiveCurrent();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop and archive" }),
    );
    await waitFor(() => expect(readArchive().entries.parent).toBeDefined());
    expect(
      savedWorkspace().tabs.some(
        (t: { kind: string }) => t.kind === "terminal",
      ),
    ).toBe(true);
    expect(screen.queryByText("Test terminal")).not.toBeInTheDocument();
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
