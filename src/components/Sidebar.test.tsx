import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "./ui/sidebar";
import { navigationApi, emptyNavigation } from "../navigationApi";
import { Sidebar, type SidebarProps } from "./Sidebar";
import type { SessionRuntime } from "../feedStore";
import {
  ZERO_USAGE,
  AppError,
  type ProjectView,
  type SessionId,
  type SessionStatus,
} from "../wire";
import { workbenchApi, defaultSettings } from "../workbenchApi";
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(workbenchApi, "load").mockResolvedValue({
    notes: [],
    projects: {},
    global: defaultSettings,
    displayName: "Stephen",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function project(
  id: string,
  name: string,
  root = `/repos/${name}`,
): ProjectView {
  return { id, name, root_path: root, created_at_ms: 1_700_000_000_000 };
}

function session(
  sessionId: SessionId,
  projectId: string,
  status: SessionStatus,
  extra: Partial<SessionRuntime> = {},
): SessionRuntime {
  return {
    sessionId,
    projectId,
    status,
    model: "claude-sonnet-4-5",
    cwd: "/repos/job-portal/.worktrees/one",
    providerSessionId: null,
    worktreePath: "/repos/job-portal/.worktrees/one",
    branch: "brigadier/a80e2411",
    worktreeRemoved: false,
    resumed: false,
    busy: false,
    lastTurnId: null,
    lastStop: null,
    costUsd: 0,
    usage: { ...ZERO_USAGE },
    rowsTotal: 0,
    rowsDropped: 0,
    startedAtMs: 1_700_000_000_000,
    endedAtMs: null,
    exitCode: null,
    lastMessage: null,
    lastEventSeq: 0,
    ...extra,
  };
}

function mount(over: Partial<SidebarProps> = {}) {
  const sessions = over.sessions ?? {};
  const props: SidebarProps = {
    projects: [],
    sessions,
    order: Object.keys(sessions),
    selectedProjectId: null,
    selectedSessionId: null,
    pendingTotal: 0,
    appInfo: null,
    claude: { binary: "/usr/local/bin/claude", version: "2.1.4" },
    claudeError: null,
    isMock: true,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onAddProject: vi.fn(),
    ...over,
  };
  render(
    <SidebarProvider>
      <Sidebar {...props} />
    </SidebarProvider>,
  );
  return props;
}

describe("sidebar navigation", () => {
  it("expands projects and caps their recent sessions at five", async () => {
    const user = userEvent.setup();
    const sessions = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        String(i),
        session(String(i), "p", "exited", { startedAtMs: i }),
      ]),
    );
    const props = mount({ projects: [project("p", "Example")], sessions });
    expect(
      screen.queryByRole("button", { name: "Session 6" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand Example" }));
    await user.click(screen.getByRole("button", { name: "Session 6" }));
    expect(props.onSelectSession).toHaveBeenCalledWith("6");
    expect(
      screen.queryByRole("button", { name: "Session 0" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more (2)" }));
    expect(screen.getByRole("button", { name: "Session 0" })).toBeVisible();
  });
  it("renames inline without changing the repository path", async () => {
    const user = userEvent.setup();
    const rename = vi
      .spyOn(navigationApi, "customize")
      .mockImplementation(async () => {
        vi.mocked(workbenchApi.load).mockResolvedValue({
          notes: [],
          projects: {},
          global: defaultSettings,
          projectNames: { p: "My project" },
        });
        return emptyNavigation;
      });
    mount({ projects: [project("p", "Example")] });
    await user.dblClick(screen.getByRole("button", { name: "Example" }));
    await user.clear(screen.getByLabelText("New name"));
    await user.type(screen.getByLabelText("New name"), "My project{Enter}");
    expect(rename).toHaveBeenCalledWith("name", "p", "My project");
    expect(
      await screen.findByRole("button", { name: "My project" }),
    ).toHaveAttribute("title", "/repos/Example");
  });
  it("pins a session across projects and assigns a project color", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p", "Example")],
      sessions: { s: session("s", "p", "exited") },
      selectedProjectId: "p",
    });
    await user.click(
      screen.getByRole("button", { name: "Session actions Session s" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Pin session" }));
    expect(await screen.findByText("Pinned")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Project actions Example" }),
    );
    await user.click(screen.getByRole("button", { name: "blue tag" }));
    await user.keyboard("{Escape}");
    expect(await screen.findByLabelText("blue project tag")).toBeVisible();
  });
  it("keeps failed stop visible in the confirmation instead of hiding the project", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigationApi, "preview").mockResolvedValue({
      entry: {
        kind: "project",
        id: "p",
        title: "Example",
        projectId: "p",
        sessionIds: ["s"],
        trashedAt: 0,
      },
      running: ["s"],
    });
    vi.spyOn(navigationApi, "move").mockRejectedValue(
      new Error("Agent did not stop"),
    );
    mount({ projects: [project("p", "Example")] });
    await user.click(
      screen.getByRole("button", { name: "Project actions Example" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    await user.click(
      await screen.findByRole("button", { name: "Stop and move to Trash" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent did not stop",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Example" })).toBeVisible();
  });
  it("opens Notes in a modal, preserves unsaved edits on cancel, and saves through the note API", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: 1 }));
    mount();
    expect(screen.queryByText("Stephen")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    const dialog = screen.getByRole("dialog", { name: "Notes" });
    await user.click(within(dialog).getByRole("button", { name: "New note" }));
    await user.type(screen.getByLabelText("Note content"), "Keep this");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Note content")).toHaveValue("Keep this");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Keep this", projectId: null }),
    );
  });
  it("searches project names without Home, Inbox, or Ask AI links", async () => {
    const user = userEvent.setup();
    const props = mount({ projects: [project("p", "Example")] });
    await user.click(screen.getByRole("button", { name: /Search/ }));
    await user.type(screen.getByRole("combobox"), "Example");
    await user.click(screen.getByRole("option", { name: "Example" }));
    expect(props.onSelectProject).toHaveBeenCalledWith("p");
    for (const name of ["Home", "Inbox", "Ask AI"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
  it("keeps a refused project path available to correct", async () => {
    const user = userEvent.setup();
    const add = vi
      .fn()
      .mockResolvedValue(new AppError("invalid_argument", "Missing folder"));
    mount({ onAddProject: add });
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.type(screen.getByLabelText("Project path"), "/repos/work");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(add).toHaveBeenCalledWith("/repos/work");
    expect(screen.getByLabelText("Project path")).toHaveValue("/repos/work");
  });
});
