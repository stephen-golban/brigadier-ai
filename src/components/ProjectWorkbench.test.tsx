import { archiveSession, readArchive } from "../sessionArchive";
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
vi.mock("./VscodePanels", () => ({
  VscodePanels: vi.fn(() => <div data-testid="vscode-panel" />),
}));
vi.mock("./SourceControl", () => ({
  SourceControl: vi.fn(() => <div data-testid="changes-panel" />),
}));
import { SourceControl } from "./SourceControl";
import { VscodePanels } from "./VscodePanels";
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
    ).toEqual(["Files", "Search", "Changes"]);
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
describe("project tabs", () => {
  it("does not automatically open owned workhorses", async () => {
    render(<Harness />);
    expect(await screen.findByText("Conversation parent")).toBeVisible();
    expect(
      screen.queryByRole("tab", { name: "Research" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Environment and agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Research/ }));
    expect(await screen.findByText("Conversation child")).toBeVisible();
  });
  it("opens the hovered session tab menu without switching away from the active tab", async () => {
    render(<Harness />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Environment and agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Research/ }));
    const firstTab = screen.getByRole("tab", { name: "Main task" });
    await userEvent.hover(firstTab);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(
      within(firstTab).getByRole("button", { name: "Session actions" }),
    );
    expect(screen.getByRole("tab", { name: "Research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveValue(
      "Main task",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Conversation child")).toBeVisible();
  });
  it("closes finished tabs into history and reopens them by keyboard", async () => {
    const discard = vi.spyOn(desktopApi, "discard");
    render(<Harness />);
    await screen.findByText("Conversation parent");
    key("w");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("tab")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "History" })).toBeVisible();
    expect(readArchive().entries.parent).toBeDefined();
    expect(discard).not.toHaveBeenCalled();
    key("T", { shiftKey: true });
    await waitFor(() =>
      expect(screen.getByText("Conversation parent")).toBeVisible(),
    );
    expect(readArchive().entries.parent).toBeUndefined();
  });
  it("confirms a working session close and keeps the tab on cancel", async () => {
    render(<Harness busy />);
    await screen.findByText("Conversation parent");
    key("w");
    expect(
      screen.getByRole("dialog", { name: "Stop and archive session?" }),
    ).toBeVisible();
    expect(readArchive().entries.parent).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Main task" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close Main task" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Stop and close" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("tab")).not.toBeInTheDocument(),
    );
    expect(readArchive().entries.parent).toBeDefined();
  });
  it("native close only closes the tab and keeps the welcome page after the last tab", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    expect(
      screen.queryByRole("button", { name: "History" }),
    ).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("workbench-close-tab")));
    await waitFor(() =>
      expect(screen.queryByRole("tab")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Conversation")).toBeVisible();
    act(() => window.dispatchEvent(new Event("workbench-close-tab")));
    expect(screen.getByRole("button", { name: "New tab" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByLabelText("Search session history")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Main task" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Main task" })).toBeVisible(),
    );
    expect(
      screen.queryByRole("button", { name: "History" }),
    ).not.toBeInTheDocument();
  });
  it("confirms a busy terminal for native shortcuts and stops it only after confirmation", async () => {
    const info = vi
      .spyOn(workbenchApi, "terminalInfo")
      .mockResolvedValue({ busy: true, cwd: "/repo" });
    const stop = vi
      .spyOn(workspaceApi, "closeTerminal")
      .mockResolvedValue(undefined);
    render(<Harness />);
    await screen.findByText("Conversation parent");
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await screen.findByText("Test terminal");
    act(() => window.dispatchEvent(new Event("workbench-close-tab")));
    await screen.findByRole("dialog", { name: "Close running terminal?" });
    expect(info).toHaveBeenCalledWith("test-terminal");
    expect(stop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close Terminal 1" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop and close" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Terminal 1" }),
      ).not.toBeInTheDocument(),
    );
    expect(stop).toHaveBeenCalledWith("test-terminal");
    expect(readArchive().entries).toEqual({});
  });
  it("opens files as main tabs and cycles back to the preserved conversation", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      );
    });
    expect(await screen.findByLabelText("File editor")).toHaveValue("before");
    expect(screen.getByText("Conversation parent")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.change(screen.getByLabelText("File editor"), {
      target: { value: "draft change" },
    });
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(screen.getByRole("tab", { name: "Main task" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("tab", { name: "file.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByLabelText("File editor")).toHaveValue(
      "draft change",
    );
  });
  it("offers only Session, Terminal, and Files and opens an empty file tab", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(
      screen
        .getAllByRole("menuitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Session", "Terminal", "Files"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    expect(screen.getByRole("tab", { name: "Open file" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText("Select a file from the workspace tree"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Close Open file" }),
    );
    expect(screen.getByText("Conversation parent")).toBeVisible();
  });
  it("opens Files from the toolbar without a tab, then creates a tab on file selection", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    const tabs = () => screen.getAllByRole("tab");
    const files = screen.getByRole("button", { name: "Files" });
    expect(files.closest("header")).toContainElement(
      screen.getByRole("tablist"),
    );
    await userEvent.click(files);
    expect(tabs()).toHaveLength(1);
    expect(screen.getByText("Conversation parent")).toBeVisible();
    expect(files).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      await screen.findByRole("button", { name: "README.md" }),
    );
    expect(await screen.findByLabelText("File editor")).toBeVisible();
    expect(tabs()).toHaveLength(2);
    expect(
      screen.queryByRole("tab", { name: "Open file" }),
    ).not.toBeInTheDocument();
    await userEvent.click(files);
    expect(screen.getByLabelText("File editor")).toBeVisible();
    expect(files).toHaveAttribute("aria-pressed", "false");
    // Switching away and back must not reopen a hidden tree.
    key("1");
    key("2");
    expect(files).toHaveAttribute("aria-pressed", "false");
  });
  it("fills the Files menu tab in place and reuses an existing file instead of duplicating it", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    const openFiles = async () => {
      await userEvent.click(screen.getByRole("button", { name: "New tab" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Files" }));
    };
    await openFiles();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    await userEvent.click(
      await screen.findByRole("button", { name: "README.md" }),
    );
    expect(await screen.findByLabelText("File editor")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.queryByRole("tab", { name: "Open file" }),
    ).not.toBeInTheDocument();
    await openFiles();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "README.md" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "README.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("toggles each right panel on both conversation and document tabs without changing tabs", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    for (const resource of [false, true]) {
      if (resource)
        act(() =>
          window.dispatchEvent(
            new CustomEvent("workbench-open-file", {
              detail: { path: "file.ts" },
            }),
          ),
        );
      const active = screen.getByRole("tab", { selected: true });
      const panel = document.getElementById("workspace-panel")!;
      for (const name of ["Files", "Search", "Changes"]) {
        const button = within(
          screen.getByRole("group", { name: "Workspace panels" }),
        ).getByRole("button", { name });
        await userEvent.click(button);
        expect(button).toHaveAttribute("aria-pressed", "true");
        expect(panel).toHaveAttribute("data-open", "true");
        expect(active).toHaveAttribute("aria-selected", "true");
        await userEvent.click(button);
        expect(button).toHaveAttribute("aria-pressed", "false");
        expect(panel).toHaveAttribute("inert");
        expect(panel).toHaveAttribute("data-open", "false");
        expect(active).toHaveAttribute("aria-selected", "true");
      }
    }
  });
  it("switches panel content in the same pane and keeps Search open after selecting a result", async () => {
    vi.spyOn(workbenchApi, "search").mockResolvedValue({
      hits: [{ path: "file.ts", line: 2, column: 1, text: "example" }],
      files: 1,
      truncated: false,
      replacements: [],
    });
    render(<Harness />);
    await screen.findByText("Conversation parent");
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    const panel = screen.getByRole("complementary", { name: "Workspace" });
    await userEvent.click(
      within(screen.getByRole("group", { name: "Workspace panels" })).getByRole(
        "button",
        { name: "Search" },
      ),
    );
    expect(screen.getByRole("complementary", { name: "Workspace" })).toBe(
      panel,
    );
    expect(vi.mocked(VscodePanels).mock.lastCall![0].mode).toBe("search");
    act(() => vi.mocked(VscodePanels).mock.lastCall![0].onOpen("file.ts", "file", false, 2));
    expect(await screen.findByLabelText("File editor")).toBeVisible();
    expect(vi.mocked(VscodePanels).mock.lastCall![0].mode).toBe("search");
    expect(vi.mocked(VscodePanels).mock.lastCall![0].active).toBe(true);
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  it("navigates tabs by arrows, Home/End, numbered shortcuts, and bracket/page cycling", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    act(() =>
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      ),
    );
    await screen.findByLabelText("File editor");
    const task = screen.getByRole("tab", { name: "Main task" });
    const file = screen.getByRole("tab", { name: "file.ts" });
    await userEvent.click(file);
    act(() => file.focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(task).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(file).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(task).toHaveFocus();
    key("9");
    expect(file).toHaveAttribute("aria-selected", "true");
    key("{", { shiftKey: true, code: "BracketLeft" });
    expect(task).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageUp" });
    expect(file).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { ctrlKey: true, key: "PageDown" });
    expect(task).toHaveAttribute("aria-selected", "true");
    key("}", { shiftKey: true, code: "BracketRight" });
    expect(file).toHaveAttribute("aria-selected", "true");
  });
  it("creates and closes tabs from an editor even if the editor stops keyboard bubbling", async () => {
    render(<Harness />);
    await screen.findByText("Conversation parent");
    act(() =>
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      ),
    );
    const editor = await screen.findByLabelText("File editor");
    editor.addEventListener("keydown", (event) => event.stopPropagation());
    fireEvent.keyDown(editor, { key: "t", metaKey: true });
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    key("w");
    expect(
      screen.queryByRole("tab", { name: "New session" }),
    ).not.toBeInTheDocument();
    const restoredEditor = await screen.findByLabelText("File editor");
    restoredEditor.addEventListener("keydown", (event) =>
      event.stopPropagation(),
    );
    fireEvent.keyDown(restoredEditor, { key: "w", ctrlKey: true });
    expect(
      screen.queryByRole("tab", { name: "file.ts" }),
    ).not.toBeInTheDocument();
  });
  it("opens session history from an inactive session menu while a file is selected", async () => {
    await archiveSession("child", true);
    render(<Harness />);
    await screen.findByText("Conversation parent");
    act(() =>
      window.dispatchEvent(
        new CustomEvent("workbench-open-file", { detail: { path: "file.ts" } }),
      ),
    );
    await screen.findByLabelText("File editor");
    await userEvent.click(
      within(screen.getByRole("tab", { name: "Main task" })).getByRole(
        "button",
        { name: "Session actions" },
      ),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Session history" }),
    );
    expect(screen.getByLabelText("Search session history")).toBeVisible();
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

it.each(["MacIntel", "Win32"])(
  "creates each tab type by shortcut on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<Harness />);
    await screen.findByText("Conversation parent");
    const modifiers =
      platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(window, { key: "t", code: "KeyT", ...modifiers });
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(window, { key: "j", code: "KeyJ", ...modifiers });
    expect(
      await screen.findByRole("tab", { name: "Terminal 1" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, {
      key: platform === "MacIntel" ? "ƒ" : "f",
      code: "KeyF",
      altKey: true,
      ...modifiers,
    });
    expect(
      await screen.findByRole("tab", { name: "Open file" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
);
it("routes native new-tab actions and ignores them while a close dialog is open", async () => {
  render(<Harness busy />);
  await screen.findByText("Conversation parent");
  key("w");
  act(() => window.dispatchEvent(new Event("workbench-new-terminal")));
  expect(
    screen.queryByRole("tab", { name: "Terminal 1" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => window.dispatchEvent(new Event("workbench-new-terminal")));
  expect(
    await screen.findByRole("tab", { name: "Terminal 1" }),
  ).toHaveAttribute("aria-selected", "true");
  act(() => window.dispatchEvent(new Event("workbench-new-files")));
  expect(await screen.findByRole("tab", { name: "Open file" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
it.each(["MacIntel", "Win32"])(
  "shows icons and platform shortcuts in the new-tab menu on %s",
  async (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<Harness />);
    await screen.findByText("Conversation parent");
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));
    for (const [name, mac, other] of [
      ["Session", "⌘T", "Ctrl T"],
      ["Terminal", "⌘J", "Ctrl J"],
      ["Files", "⌥⌘F", "Ctrl Alt F"],
    ]) {
      const item = await screen.findByRole("menuitem", { name });
      expect(item.querySelector("svg")).not.toBeNull();
      expect(
        within(item).getByText(platform === "MacIntel" ? mac : other).tagName,
      ).toBe("KBD");
    }
  },
);
