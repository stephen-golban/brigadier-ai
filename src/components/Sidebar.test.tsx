import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  render(<Sidebar {...props} />);
  return props;
}

describe("flat project navigation", () => {
  it("keeps projects flat and selects one without exposing session rows", async () => {
    const user = userEvent.setup();
    const props = mount({
      projects: [project("p", "Brigadier")],
      sessions: { s: session("s", "p", "running", { busy: true }) },
    });
    const nav = screen.getByRole("navigation", { name: "Projects" });
    const row = within(nav).getByRole("button", { name: /Brigadier.*Working/ });
    expect(row).not.toHaveAttribute("aria-expanded");
    await user.click(row);
    expect(props.onSelectProject).toHaveBeenCalledWith("p");
    expect(screen.queryByText("brigadier/a80e2411")).not.toBeInTheDocument();
  });
  it("shows both working and attention per project", () => {
    mount({
      projects: [project("p", "Brigadier")],
      sessions: { s: session("s", "p", "running", { busy: true }) },
      attention: { s: true },
    });
    expect(screen.getByRole("img", { name: "Working" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Needs attention" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Approvals/ }),
    ).not.toBeInTheDocument();
  });
  it("does not show an idle process as working", () => {
    mount({
      projects: [project("p", "Brigadier")],
      sessions: { s: session("s", "p", "running") },
    });
    expect(
      screen.queryByRole("img", { name: "Working" }),
    ).not.toBeInTheDocument();
  });
  it("renames the displayed project without changing its root", async () => {
    const save = vi
      .spyOn(workbenchApi, "saveDesktopSettings")
      .mockResolvedValue({ notes: [], projects: {}, global: defaultSettings });
    const user = userEvent.setup();
    mount({ projects: [project("p", "Brigadier")] });
    await user.click(screen.getByRole("button", { name: "Rename Brigadier" }));
    await user.clear(screen.getByLabelText("New name"));
    await user.type(screen.getByLabelText("New name"), "My project");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(save).toHaveBeenCalledWith("Stephen", { p: "My project" });
    expect(screen.getByRole("button", { name: "Brigadier" })).toHaveAttribute(
      "title",
      "/repos/Brigadier",
    );
  });
  it("reveals the actual root and confirms project removal", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue({ deletion: {}, error: null });
    const props = mount({
      projects: [project("p", "Brigadier")],
      onReveal: vi.fn(),
      onDeleteProject: remove,
    });
    await user.click(
      screen.getByRole("button", { name: "Project actions Brigadier" }),
    );
    await user.click(screen.getByText("Reveal in Finder"));
    expect(props.onReveal).toHaveBeenCalledWith("/repos/Brigadier");
    await user.click(
      screen.getByRole("button", { name: "Project actions Brigadier" }),
    );
    await user.click(screen.getByText("Remove project"));
    expect(remove).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove project",
      }),
    );
    expect(remove).toHaveBeenCalledWith("p", false);
  });
});
describe("project opening", () => {
  it("uses the native picker when available", async () => {
    const user = userEvent.setup();
    const pick = vi.fn().mockResolvedValue(null);
    mount({ onPickProject: pick });
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(pick).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Project path")).not.toBeInTheDocument();
  });
  it("opens a path fallback after picker refusal", async () => {
    const user = userEvent.setup();
    mount({
      onPickProject: vi
        .fn()
        .mockResolvedValue(new AppError("invalid_argument", "Missing folder")),
    });
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.getByLabelText("Project path")).toBeVisible();
  });
  it("keeps a refused typed path available to correct", async () => {
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
describe("notes and profile", () => {
  it("lists notes from every project and folds the accordion", async () => {
    vi.mocked(workbenchApi.load).mockResolvedValue({
      notes: [
        {
          id: "n",
          title: "Ideas",
          content: "text",
          projectId: "different",
          revision: 1,
          alwaysInclude: false,
          language: "markdown",
        },
      ],
      projects: {},
      global: defaultSettings,
      displayName: "Stephen",
    });
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText("Ideas")).toBeVisible();
    const open = vi.fn();
    window.addEventListener("workbench-open-note", open);
    await user.click(screen.getByRole("button", { name: "Ideas" }));
    expect(open).toHaveBeenCalled();
    window.removeEventListener("workbench-open-note", open);
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();
  });
  it("creates a note through the shared note API", async () => {
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: 1 }));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Untitled note",
        projectId: null,
        content: "",
      }),
    );
  });
  it("shows the local profile and opens Settings", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText("Stephen")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Notes folder")).toBeVisible();
  });
});
