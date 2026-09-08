import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "./controls/sidebar";
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
  it("renames only through the Edit modal without changing the repository path", async () => {
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
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Project actions Example" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit project" })).toBeVisible();
    await user.clear(screen.getByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "My project{Enter}");
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
    await user.click(screen.getByRole("button", { name: "Pin Session s" }));
    expect(await screen.findByText("Pinned")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Project actions Example" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Project tag" }));
    await user.click(screen.getByRole("menuitem", { name: "blue tag" }));
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
    await user.click(screen.getByRole("menuitem", { name: "Remove project" }));
    await user.click(
      await screen.findByRole("button", { name: "Stop and move to Trash" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent did not stop",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Example" })).toBeVisible();
  });
  it("opens Notepad as a page, guards sidebar navigation, and saves through the note API", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: 1 }));
    const props = mount({ projects: [project("p", "Example")] });
    expect(screen.queryByText("Stephen")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notepad" }));
    const dialog = screen.getByRole("region", { name: "Notepad" });
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await user.type(screen.getByLabelText("Note content"), "Keep this");
    await user.click(screen.getByRole("button", { name: "Example" }));
    expect(props.onSelectProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Note content")).toHaveValue("Keep this");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Keep this", projectId: null }),
    );
  });
  it("opens a new unsaved note directly from the Notepad plus button", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: 1 }));
    mount();
    await user.click(screen.getByRole("button", { name: "New note" }));
    const dialog = screen.getByRole("region", { name: "Notepad" });
    expect(within(dialog).getByLabelText("Note content")).toHaveValue("");
    expect(save).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByLabelText("Note content"),
      "Quick idea",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Untitled note",
        content: "Quick idea",
        projectId: null,
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "All notes" }));
    await user.click(screen.getByRole("button", { name: "Notepad" }));
    expect(screen.queryByLabelText("Note content")).not.toBeInTheDocument();
  });
  it("searches project names without Home, Inbox, or Ask AI links", async () => {
    const user = userEvent.setup();
    const props = mount({ projects: [project("p", "Example")] });
    await user.click(screen.getByRole("button", { name: /Search/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Search" }),
      "Example",
    );
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
  it("opens project actions only on activation, then restores focus on Escape", async () => {
    const user = userEvent.setup();
    mount({ projects: [project("p", "Example")] });
    const trigger = screen.getByRole("button", {
      name: "Project actions Example",
    });
    await user.hover(screen.getByRole("button", { name: "Example" }));
    await user.hover(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("uses folder states and preserves session DOM while collapsing", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p", "Example")],
      sessions: { s: session("s", "p", "exited") },
      selectedProjectId: "p",
    });
    const chat = screen.getByRole("button", { name: "Session s" });
    const collapse = screen.getByRole("button", { name: "Collapse Example" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    await user.click(collapse);
    expect(chat).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Session s" }),
    ).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand Example" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    await user.click(expand);
    expect(screen.getByRole("button", { name: "Session s" })).toBe(chat);
  });
  it("archives and restores chats without trashing or stopping the session", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(navigationApi, "move");
    const props = mount({
      projects: [project("p", "Example")],
      sessions: { s: session("s", "p", "running") },
      selectedProjectId: "p",
      selectedSessionId: "s",
    });
    await user.click(screen.getByRole("button", { name: "Archive Session s" }));
    expect(props.onSelectSession).toHaveBeenCalledWith(null);
    expect(
      screen.queryByRole("button", { name: "Session s" }),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem("brigadier:archived-sessions:v1")!),
    ).toEqual(["s"]);
    await user.click(
      await screen.findByRole("button", { name: "Account: Stephen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Archived chats" }));
    await user.click(screen.getByRole("button", { name: "Restore Session s" }));
    expect(
      JSON.parse(localStorage.getItem("brigadier:archived-sessions:v1")!),
    ).toEqual([]);
    expect(move).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", { name: "Session s" }),
    ).toBeInTheDocument();
  });
  it("starts a chat from the pencil action without toggling the project closed", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    window.addEventListener("brigadier-new-project-session", handler);
    const props = mount({ projects: [project("p", "Example")] });
    await user.click(
      screen.getByRole("button", { name: "New session in Example" }),
    );
    expect(props.onSelectProject).toHaveBeenCalledWith("p");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "p" }),
    );
    expect(
      screen.getByRole("button", { name: "Collapse Example" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    window.removeEventListener("brigadier-new-project-session", handler);
  });
  it.each([
    ["MacIntel", "{Meta>}n{/Meta}", "⌘N"],
    ["Win32", "{Control>}n{/Control}", "Ctrl N"],
  ])(
    "starts a chat with the displayed shortcut on %s, including while collapsed",
    async (platform, keys, hint) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const user = userEvent.setup();
      const handler = vi.fn();
      window.addEventListener("brigadier-new-project-session", handler);
      mount({ projects: [project("p", "Example")] });
      await user.hover(screen.getByRole("button", { name: "New chat" }));
      expect(screen.getByRole("tooltip")).toHaveTextContent(`New chat ${hint}`);
      await user.keyboard(keys);
      expect(handler).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
      await user.keyboard(keys);
      expect(handler).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
      await user.click(screen.getByRole("button", { name: "Notepad" }));
      await user.keyboard(keys);
      expect(handler).toHaveBeenCalledTimes(3);
      expect(
        screen.queryByRole("region", { name: "Notepad" }),
      ).not.toBeInTheDocument();
      window.removeEventListener("brigadier-new-project-session", handler);
    },
  );
  it("keeps the sidebar mounted but inert while closed", async () => {
    const user = userEvent.setup();
    mount({ projects: [project("p", "Example")] });
    const sidebar = screen.getByLabelText("Main navigation");
    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.parentElement).toHaveAttribute("inert");
    expect(
      screen.queryByRole("button", { name: "Search" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
});

it("pins projects ahead of other projects and persists the choice across remounts", async () => {
  const user = userEvent.setup();
  const projects = [project("a", "Alpha"), project("b", "Beta")];
  mount({ projects });
  await user.click(
    screen.getByRole("button", { name: "Project actions Beta" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Pin" }));
  const order = () =>
    screen
      .getAllByRole("button", { name: /Project actions / })
      .map((el) => el.getAttribute("aria-label"));
  expect(order()).toEqual(["Project actions Beta", "Project actions Alpha"]);
  cleanup();
  mount({ projects });
  expect(order()).toEqual(["Project actions Beta", "Project actions Alpha"]);
  await user.click(
    screen.getByRole("button", { name: "Project actions Beta" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
  expect(order()).toEqual(["Project actions Alpha", "Project actions Beta"]);
  await user.click(
    screen.getByRole("button", { name: "Project actions Beta" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
    "Beta",
  );
});

it("collapses Projects without discarding folder state and remembers the section state", async () => {
  const user = userEvent.setup();
  const props = {
    projects: [project("p", "Example")],
    sessions: { s: session("s", "p", "exited") },
    selectedProjectId: "p",
  };
  mount(props);
  const row = screen.getByRole("button", { name: "Session s" });
  const toggle = screen.getByRole("button", { name: "Projects" });
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(row).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Session s" }),
  ).not.toBeInTheDocument();
  expect(
    document.getElementById(toggle.getAttribute("aria-controls")!),
  ).toHaveAttribute("inert");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Session s" })).toBe(row);
  await user.click(toggle);
  cleanup();
  mount(props);
  expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await user.click(screen.getByRole("button", { name: "Projects" }));
  expect(screen.getByRole("button", { name: "Session s" })).toBeVisible();
});

it("shows Pin, Unpin, and Archive tooltips and fills only the pinned icon", async () => {
  const user = userEvent.setup();
  mount({
    projects: [project("p", "Example")],
    sessions: { s: session("s", "p", "exited") },
    selectedProjectId: "p",
  });
  const pin = screen.getByRole("button", { name: "Pin Session s" });
  await user.hover(pin);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Pin session");
  expect(pin.querySelector("path")).toHaveAttribute("fill", "none");
  await user.click(pin);
  const unpin = (
    await screen.findAllByRole("button", { name: "Unpin Session s" })
  )[0];
  await user.hover(unpin);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Unpin session");
  expect(unpin.querySelector("path")).toHaveAttribute("fill", "currentColor");
  await user.click(unpin);
  const archive = screen.getByRole("button", { name: "Archive Session s" });
  await user.hover(archive);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Archive session");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("collapses Pinned independently, preserves its rows, and remembers the choice", async () => {
  vi.spyOn(navigationApi, "load").mockResolvedValue({
    ...emptyNavigation,
    pinnedSessions: ["s"],
  });
  const user = userEvent.setup();
  const props = {
    projects: [project("p", "Example")],
    sessions: { s: session("s", "p", "exited") },
    selectedProjectId: "p",
  };
  mount(props);
  const toggle = await screen.findByRole("button", { name: "Pinned" });
  const pinnedRow = screen.getAllByRole("button", { name: "Session s" })[0];
  expect(
    pinnedRow.querySelector('svg[aria-label="Pinned session"]'),
  ).toBeNull();
  await user.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(pinnedRow).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Session s" })).toHaveLength(1);
  await user.keyboard("{Enter}");
  expect(screen.getAllByRole("button", { name: "Session s" })[0]).toBe(
    pinnedRow,
  );
  await user.click(toggle);
  cleanup();
  mount(props);
  expect(await screen.findByRole("button", { name: "Pinned" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("keeps failed edits in the modal and Cancel discards the unsaved name", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigationApi, "customize").mockRejectedValue(
    new Error("Could not save name"),
  );
  mount({ projects: [project("p", "Example")] });
  await user.click(
    screen.getByRole("button", { name: "Project actions Example" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await user.clear(screen.getByRole("textbox", { name: "Project name" }));
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: "Project name" }),
    "Changed",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save name",
  );
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
    "Changed",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Example" })).toBeVisible();
});
