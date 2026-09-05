import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { ProjectWorkbench } from "./ProjectWorkbench";
import { SourceControl } from "./SourceControl";
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
    workspaceOpen: false,
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
  it("restores unsaved buffers and their language after unmount", async () => {
    const user = userEvent.setup();
    let view = mount();
    await user.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "New Session",
      "Terminal",
      "New File",
      "Open File",
      "New Note",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "New File" }));
    await user.type(
      await screen.findByRole("textbox", { name: "File editor" }),
      "temporary scratch",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language mode" }),
      "typescript",
    );
    view.unmount();
    view = mount();
    expect(
      await screen.findByRole("textbox", { name: "File editor" }),
    ).toHaveValue("temporary scratch");
    expect(screen.getByRole("combobox", { name: "Language mode" })).toHaveValue(
      "typescript",
    );
  });
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
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(screen.getByRole("menuitem", { name: "New Note" }));
    expect(
      await screen.findByRole("checkbox", { name: "Always include" }),
    ).not.toBeChecked();
    fireEvent.change(
      await screen.findByRole("textbox", { name: "File editor" }),
      { target: { value: "Final edit before switching" } },
    );
    await user.click(screen.getByRole("button", { name: "New tab" }));
    await user.click(screen.getByRole("menuitem", { name: "New File" }));
    await waitFor(() =>
      expect(
        save.mock.calls.some(
          ([n]) => n.content === "Final edit before switching",
        ),
      ).toBe(true),
    );
  });
});
it("cancelling smart commit does not enable its Always preference", async () => {
  const user = userEvent.setup();
  const settings = vi.spyOn(workbenchApi, "saveSettings");
  const action = vi.spyOn(workbenchApi, "gitAction").mockResolvedValue("");
  render(
    <SourceControl
      context={{ projectId: project.id, sessionId: null }}
      status={{
        branch: "main",
        changes: [{ path: "file", index: " ", worktree: "M" }],
      }}
      refresh={() => {}}
      onOpen={() => {}}
      data={data}
      onData={() => {}}
      models={[]}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Commit message" }),
    "Test commit",
  );
  await user.click(screen.getByRole("button", { name: "Commit" }));
  await user.click(
    await screen.findByRole("checkbox", {
      name: "Always stage changes when nothing is staged",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(settings).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});
