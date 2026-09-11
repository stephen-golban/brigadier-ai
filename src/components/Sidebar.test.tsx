import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { SidebarProvider, useSidebar } from "./controls/sidebar";
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
import { useState } from "react";
/**
 * A render counter for `Sidebar` itself. `useSessionNavigation` is called once at the top of its
 * body and nowhere else in this tree, so wrapping it counts `Sidebar` renders without reaching
 * inside the component. `vi.hoisted` is what keeps the counter out of the mock factory's TDZ.
 */
const probe = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../sessionNavigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../sessionNavigation")>();
  return {
    ...actual,
    useSessionNavigation: () => {
      probe.renders++;
      return actual.useSessionNavigation();
    },
  };
});
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
  it("lists existing projectless sessions in a final Chats section and keeps their actions", async () => {
    const user = userEvent.setup();
    const props = mount({
      projects: [project("p", "Example"), { ...project("tasks", "Tasks"), projectless: true }],
      sessions: {
        old: session("old", "tasks", "exited", { startedAtMs: 1 }),
        recent: session("recent", "tasks", "running", { startedAtMs: 2 }),
        code: session("code", "p", "exited"),
      },
    });
    const chats = await screen.findByRole("navigation", { name: "Chats" });
    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(within(projects).queryByRole("button", { name: "Tasks" })).toBeNull();
    expect(within(chats).queryByRole("button", { name: "Session code" })).toBeNull();
    expect(within(chats).getAllByRole("button", { name: /^Session / }).map(button => button.textContent)).toEqual(["Session recent", "Session old"]);
    expect(projects.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(chats).getByRole("button", { name: "Session old" }));
    expect(props.onSelectSession).toHaveBeenCalledWith("old");
    expect(within(chats).getByRole("button", { name: "Archive Session old" })).toBeInTheDocument();
  });
  it.each([null, "s"])(
    "uses primary text for project and session titles with selected session %s",
    async (selectedSessionId) => {
      localStorage.setItem(
        "brigadier:project-expanded:v1",
        JSON.stringify({ p: true, q: true }),
      );
      localStorage.setItem(
        "brigadier:pinned-projects:v1",
        JSON.stringify(["q"]),
      );
      vi.spyOn(navigationApi, "load").mockResolvedValue({
        ...emptyNavigation,
        pinnedSessions: ["s"],
      });
      mount({
        projects: [project("p", "Example"), project("q", "Pinned project")],
        sessions: {
          s: session("s", "p", "exited"),
          t: session("t", "q", "exited"),
        },
        selectedProjectId: "p",
        selectedSessionId,
      });
      await screen.findByRole("button", { name: "Pinned" });
      for (const name of ["New chat", "Notepad"])
        expect(screen.getByRole("button", { name })).toHaveClass("text-text");
      const projects = screen.getByRole("navigation", { name: "Projects" });
      for (const name of [
        "Example",
        "Pinned project",
        "Session s",
        "Session t",
      ])
        expect(
          within(projects)
            .getByRole("button", { name })
            .querySelector(".project-label, .session-label"),
        ).toHaveClass("text-text");
      const pinned = document.getElementById("sidebar-pinned")!;
      expect(
        within(pinned)
          .getByRole("button", { name: "Session s" })
          .querySelector(".session-label"),
      ).toHaveClass("text-text");
    },
  );
  it.each([
    ["MacIntel", "⌘,", "Meta+,"],
    ["Win32", "Ctrl ,", "Control+,"],
    ["Linux x86_64", "Ctrl ,", "Control+,"],
  ])(
    "shows the Settings glass tooltip and shortcut on %s",
    async (platform, hint, shortcut) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const user = userEvent.setup();
      mount();
      const settings = screen.getByRole("button", { name: "Settings" });
      expect(settings).toHaveAttribute("aria-keyshortcuts", shortcut);
      expect(settings).not.toHaveAttribute("title");
      await user.hover(settings);
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveClass("glass-surface");
      expect(tooltip).toHaveTextContent(`Settings ${hint}`);
      expect(tooltip.querySelector("kbd")).toHaveTextContent(hint);
      expect(settings).toHaveAttribute("aria-describedby", tooltip.id);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      await user.click(settings);
      expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    },
  );
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
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Keep this", projectId: null }),
    );
  });
  it("opens a new unsaved note from the footer Notepad", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(workbenchApi, "saveNote")
      .mockImplementation(async (n) => ({ ...n, revision: 1 }));
    mount();
    await user.click(screen.getByRole("button", { name: "Notepad" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    const dialog = screen.getByRole("region", { name: "Notepad" });
    expect(within(dialog).getByLabelText("Note content")).toHaveValue("");
    expect(save).not.toHaveBeenCalled();
    await user.type(
      within(dialog).getByLabelText("Note content"),
      "Quick idea",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create note" }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Untitled note",
        content: "Quick idea",
        projectId: null,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Close note editor" }),
    );
    await user.click(screen.getByRole("button", { name: "Notepad" }));
    expect(
      screen.getByLabelText("Note content").closest("aside"),
    ).toHaveAttribute("aria-hidden", "true");
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
    // Base UI hands a pointer-opened menu its focus on a `requestAnimationFrame`, which jsdom
    // drives from a real timer, so the landing frame comes after `user.click` resolves. Same on
    // the way back out: the trigger regains focus a frame after the popup is dismissed.
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
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
  it("routes archiving through the workbench close confirmation", async () => {
    const user = userEvent.setup();
    const event = vi.fn();
    window.addEventListener("workbench-archive-session", event);
    const props = mount({ projects: [project("p", "Example")], sessions: { s: session("s", "p", "running") }, selectedProjectId: "p", selectedSessionId: "s" });
    await user.click(screen.getByRole("button", { name: "Archive Session s" }));
    expect(event).toHaveBeenCalledOnce();
    expect(event.mock.calls[0][0].detail).toEqual({ sessionId: "s" });
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Session s" })).toBeVisible();
    window.removeEventListener("workbench-archive-session", event);
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
  // Pin and PinFilled are two separate glyphs in the vendored set, not one path with a `fill`
  // toggle, so the state shows in `data-icon` rather than in an attribute on the path.
  expect(pin.querySelector('[data-icon="pin"]')).not.toBeNull();
  expect(pin.querySelector('[data-icon="pin-filled"]')).toBeNull();
  await user.click(pin);
  const unpin = (
    await screen.findAllByRole("button", { name: "Unpin Session s" })
  )[0];
  await user.hover(unpin);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Unpin session");
  expect(unpin.querySelector('[data-icon="pin-filled"]')).not.toBeNull();
  expect(unpin.querySelector('[data-icon="pin"]')).toBeNull();
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

describe("sidebar memoisation", () => {
  /**
   * `docs/performance/2026-09-11/cold-path-attribution.md` §3 Cluster A: a 29–31 ms frame over
   * `App / SidebarProvider / Sidebar / …`. The rows inside were memoised; the component was not,
   * so every `App` render re-ran the whole subtree.
   */
  it("does not re-render when the parent re-renders with identity-equal props", async () => {
    const sessions = { code: session("code", "p", "exited") };
    const props: SidebarProps = {
      projects: [project("p", "Example")],
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
    };
    let bump!: () => void;
    function Harness({ props }: { props: SidebarProps }) {
      const [n, setN] = useState(0);
      bump = () => setN((value) => value + 1);
      return (
        <>
          <span data-testid="bumps">{n}</span>
          <Sidebar {...props} />
        </>
      );
    }
    const view = render(
      <SidebarProvider>
        <Harness props={props} />
      </SidebarProvider>,
    );
    await screen.findByRole("navigation", { name: "Projects" });
    await waitFor(() => expect(workbenchApi.load).toHaveBeenCalled());
    await act(async () => {});
    const before = probe.renders;

    await act(async () => bump());
    expect(screen.getByTestId("bumps")).toHaveTextContent("1");
    expect(probe.renders).toBe(before);

    // Control: a prop that really changed still gets through.
    view.rerender(
      <SidebarProvider>
        <Harness props={{ ...props, pendingTotal: 3 }} />
      </SidebarProvider>,
    );
    expect(probe.renders).toBeGreaterThan(before);
  });
});

/**
 * The kit's own ⌘B listener (`src/components/ui/sidebar.tsx`), exercised through the provider that
 * wires it. It lives here rather than beside the kit file because `src/components/ui/` is a
 * vendored copy with no test of its own (`UPSTREAM.md`).
 */
describe("the kit's ⌘B", () => {
  function OpenState() {
    const { open } = useSidebar();
    return <span data-testid="sidebar-open">{String(open)}</span>;
  }

  it("leaves ⌘⌥B alone, which the shell binds to the workspace toggle", () => {
    render(
      <SidebarProvider>
        <OpenState />
      </SidebarProvider>,
    );
    const open = () => screen.getByTestId("sidebar-open").textContent;
    expect(open()).toBe("true");

    // `App.tsx`'s workspace toggle. Without the `!altKey` guard this collapsed the sidebar as a
    // side effect of opening the workbench.
    fireEvent.keyDown(window, { key: "b", metaKey: true, altKey: true });
    expect(open()).toBe("true");

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(open()).toBe("false");
  });
});
