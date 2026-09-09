import { retireSession } from "../desktopApi";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { workspaceApi } from "../workspaceApi";
import {
  workbenchApi,
  defaultSettings,
  type WorkbenchData,
} from "../workbenchApi";
import { sessionLayoutsKey, workspaceKey } from "../workbenchState";
beforeEach(() => localStorage.clear());
const terminal = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock("./CodeEditor", () => ({
  default: ({
    value,
    onChange,
    language,
  }: {
    value: string;
    onChange: (s: string) => void;
    language: string;
  }) => (
    <textarea
      aria-label="File editor"
      data-language={language}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("./TerminalView", () => ({
  default: ({ onReady }: { onReady: (id: string) => void }) => {
    useEffect(() => {
      terminal.mounts++;
      onReady("pty-test");
      return () => {
        terminal.unmounts++;
      };
    }, []);
    return <div>Terminal fixture</div>;
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  terminal.mounts = 0;
  terminal.unmounts = 0;
});
const project = {
  id: "workbench-project",
  name: "Test",
  root_path: "/test",
  created_at_ms: 0,
};
const data: WorkbenchData = {
  notes: [],
  global: { ...defaultSettings },
  projects: {},
};
function mount() {
  vi.spyOn(workbenchApi, "load").mockResolvedValue(structuredClone(data));
  vi.spyOn(workspaceApi, "entries").mockResolvedValue([]);
  vi.spyOn(workspaceApi, "git").mockResolvedValue({
    branch: "main",
    changes: [],
  });
  const props = {
    project,
    session: null,
    sessions: {},
    selectedSessionId: null,
    onSelectSession: vi.fn(),
    workspaceOpen: true,
    setWorkspaceOpen: vi.fn(),
    models: [],
    peers: { origins: {}, titles: {}, closed: [], messages: [], requests: [] },
  };
  return {
    props,
    ...render(
      <ProjectWorkbench {...props}>
        <p>Conversation fixture</p>
      </ProjectWorkbench>,
    ),
  };
}
describe("project workbench persistence", () => {
  it("purges deleted chat workspaces and scratch buffers while retaining saved notes", async () => {
    const context = { projectId: project.id, sessionId: "deleted-session" };
    const tabs = [
      {
        id: "session:deleted-session",
        kind: "session",
        path: "deleted-session",
        context,
        root: "/test",
      },
      {
        id: "file:deleted",
        kind: "file",
        path: "README.md",
        context,
        root: "/test",
      },
      {
        id: "note:saved",
        kind: "note",
        path: "Saved note",
        context,
        root: "/test",
      },
      {
        id: "scratch:saved",
        kind: "untitled",
        path: "Draft",
        context,
        root: "/test",
      },
    ];
    localStorage.setItem(
      "brigadier:project-tabs:v1",
      JSON.stringify({
        [project.id]: { tabs, active: null },
      }),
    );
    localStorage.setItem("brigadier:buffer:note:saved", "saved note");
    localStorage.setItem("brigadier:buffer:scratch:saved", "scratch draft");
    mount();
    act(() => retireSession("deleted-session"));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(sessionLayoutsKey)!);
      expect(saved[workspaceKey(project.id, "deleted-session")]).toBeUndefined();
      expect(localStorage.getItem("brigadier:buffer:scratch:saved")).toBeNull();
      expect(localStorage.getItem("brigadier:buffer:note:saved")).toBe("saved note");
    });
  });
  it("removes a deleted project's saved layout and unmounts its terminals", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByText("Terminal fixture");
    fireEvent(
      window,
      new CustomEvent("workbench-history-deleted", {
        detail: { projectId: project.id },
      }),
    );
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(sessionLayoutsKey)!);
      expect(saved[workspaceKey(project.id, null)]).toBeUndefined();
      expect(terminal.unmounts).toBe(1);
    });
  });
  it("restores unsaved buffers and their language after unmount", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      sessionLayoutsKey,
      JSON.stringify({
        [workspaceKey(project.id, null)]: {
          tabs: [
            {
              id: "scratch",
              kind: "untitled",
              path: "Untitled",
              root: "/test",
              context: { projectId: project.id, sessionId: null },
            },
          ],
          active: "scratch",
        },
      }),
    );
    let view = mount();
    await user.type(
      await screen.findByRole("textbox", { name: "File editor" }),
      "temporary scratch",
    );
    await user.click(screen.getByRole("button", { name: /Language mode$/ }));
    await user.click(screen.getByRole("option", { name: "typescript" }));
    view.unmount();
    view = mount();
    expect(
      await screen.findByRole("textbox", { name: "File editor" }),
    ).toHaveValue("temporary scratch");
    expect(
      screen.getByRole("button", { name: /Language mode$/ }),
    ).toHaveTextContent("typescript");
  });
  it.each([false, true])(
    "reveals a conversation for file attachments when an existing draft is %s",
    async (existingDraft) => {
      const user = userEvent.setup();
      mount();
      if (existingDraft) fireEvent.keyDown(window, { key: "t", metaKey: true });
      fireEvent(
        window,
        new CustomEvent("workbench-open-file", {
          detail: { path: "README.md" },
        }),
      );
      await screen.findByLabelText("File editor");
      const attached = vi.fn();
      window.addEventListener("brigadier-attach", attached, { once: true });
      await user.click(screen.getByRole("button", { name: "Add to chat" }));
      expect(screen.getByText("Conversation fixture")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Show conversation" }),
      ).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(attached).toHaveBeenCalledOnce());
    },
  );
  it("preserves terminals across project changes and confirms busy close", async () => {
    const user = userEvent.setup();
    const view = mount();
    vi.spyOn(workbenchApi, "terminalInfo").mockResolvedValue({
      busy: true,
      cwd: "/test",
    });
    const close = vi
      .spyOn(workspaceApi, "closeTerminal")
      .mockResolvedValue(undefined);
    expect(
      screen.queryByRole("button", { name: "New terminal" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByText("Terminal fixture");
    expect(terminal.mounts).toBe(1);
    view.rerender(
      <ProjectWorkbench {...view.props} project={{ ...project, id: "other" }}>
        <p>Conversation fixture</p>
      </ProjectWorkbench>,
    );
    expect(terminal.unmounts).toBe(0);
    view.rerender(
      <ProjectWorkbench {...view.props}>
        <p>Conversation fixture</p>
      </ProjectWorkbench>,
    );
    await user.click(screen.getByRole("button", { name: "Kill terminal" }));
    await screen.findByRole("dialog", { name: "Kill running terminal?" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(terminal.unmounts).toBe(0);
    await user.click(screen.getByRole("button", { name: "Kill terminal" }));
    await user.click(
      await screen
        .findByRole("dialog")
        .then((dialog) =>
          within(dialog).getByRole("button", { name: "Kill terminal" }),
        ),
    );
    await waitFor(() => expect(close).toHaveBeenCalledWith("pty-test"));
    await waitFor(() => expect(terminal.unmounts).toBe(1));
  });
  it("flushes a note when switching tabs before its autosave delay", async () => {
    const user = userEvent.setup();
    mount();
    let revision = 0;
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: ++revision }));
    await act(async () => {});
    fireEvent(
      window,
      new CustomEvent("workbench-open-note", {
        detail: {
          id: "test-note",
          title: "Test note",
          content: "",
          language: "markdown",
          projectId: null,
          alwaysInclude: false,
          revision: 0,
        },
      }),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Always include" }),
    ).not.toBeChecked();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "File editor" }),
      { target: { value: "Final edit before switching" } },
    );
    await user.click(screen.getByRole("button", { name: "Show conversation" }));
    await waitFor(() =>
      expect(
        save.mock.calls.some(
          ([n]) => n.content === "Final edit before switching",
        ),
      ).toBe(true),
    );
  });
});
