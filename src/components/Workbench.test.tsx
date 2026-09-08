import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
describe("project workbench", () => {
  it("retires a deleted session's saved tabs without dropping notes or scratch buffers", async () => {
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
    mount();
    fireEvent(
      window,
      new CustomEvent("workbench-history-deleted", {
        detail: { sessionId: "deleted-session" },
      }),
    );
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("brigadier:project-tabs:v1")!,
      );
      expect(
        saved[project.id].tabs.map((tab: { id: string }) => tab.id),
      ).toEqual(["note:saved", "scratch:saved"]);
      expect(saved[project.id].active).toBe("scratch:saved");
    });
  });
  it("removes a deleted project's saved layout and unmounts its terminals", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await screen.findByText("Terminal fixture");
    fireEvent(
      window,
      new CustomEvent("workbench-history-deleted", {
        detail: { projectId: project.id },
      }),
    );
    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("brigadier:project-tabs:v1")!,
      );
      expect(saved[project.id]).toBeUndefined();
      expect(terminal.unmounts).toBe(1);
    });
  });
  it("restores unsaved buffers and their language after unmount", async () => {
    const user = userEvent.setup();
    let view = mount();
    await user.click(screen.getByRole("button", { name: "New tab" }));
    expect(
      screen.getAllByRole("menuitem").map((e) => e.getAttribute("aria-label")),
    ).toEqual(["Session", "Terminal", "Files"]);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await user.click(
      screen.getByRole("button", { name: "Tab actions Open file" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "New file" }));
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
      expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
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
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
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
    await user.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await screen.findByRole("dialog", { name: "Close running terminal?" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(terminal.unmounts).toBe(0);
    await user.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await user.click(
      await screen.findByRole("button", { name: "Stop and close" }),
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
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await user.click(
      screen.getByRole("button", { name: "Tab actions Open file" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "New file" }));
    await waitFor(() =>
      expect(
        save.mock.calls.some(
          ([n]) => n.content === "Final edit before switching",
        ),
      ).toBe(true),
    );
  });
});
