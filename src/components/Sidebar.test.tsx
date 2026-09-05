/**
 * Behavioural tests for `src/components/Sidebar.tsx`.
 *
 * These pin what `docs/vision.md` §9 says the sidebar must *do*, never how it draws it. W4-D and
 * W4-E come after this order and will move markup around; `docs/plans/phase-4.md` states the rule
 * and the reason — *a test that survives the migration proves the migration; a test that dies
 * with the component proves only that the old component existed* — so every assertion below is on
 * text, roles or accessible names, and not one of them names a class or a tag.
 *
 * What is pinned, and why each one is load-bearing rather than decorative:
 *
 *   - **A collapsed project still carries a run marker.** §9: "work in a project you are not
 *     looking at is never invisible". This is the single behaviour the redesign exists to add.
 *   - **Collapsing hides the sessions and shows a count.** §9's "finished projects collapse to
 *     one line with a count".
 *   - **A session is rendered by its branch, not its path.** `docs/plans/ipc-contract.md`:
 *     "`brigadier/<8 hex>`, or null with no worktree. Rendered instead of the path."
 *   - **A project with something live in it opens by itself**, and a quiet one does not — the
 *     derived default that makes the two above reachable without the user hunting for them.
 *
 * Mechanics match `src/feedStore.test.ts` and `src/providers/ThemeProvider.test.tsx`:
 * `globals: false`, so every helper is imported from "vitest"; `@testing-library/react`'s
 * auto-cleanup only registers itself when a global `afterEach` exists, which `globals: false`
 * denies it, so `cleanup()` is called by hand.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "./Sidebar";
import type { SidebarProps } from "./Sidebar";
import type { SessionRuntime } from "../feedStore";
import { AppError, ZERO_USAGE } from "../wire";
import type { ProjectView, SessionId, SessionStatus, WorktreeCleanup } from "../wire";

afterEach(() => {
  cleanup();
});

function project(id: string, name: string, root = `/repos/${name}`): ProjectView {
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

describe("the sidebar's projects", () => {
  it("opens a project that has a live session, and leaves a quiet one closed", () => {
    mount({
      projects: [project("p-live", "job-portal"), project("p-quiet", "dotfiles")],
      sessions: {
        live: session("live", "p-live", "running"),
        done: session("done", "p-quiet", "exited"),
      },
      order: ["live", "done"],
    });

    // The live project's session row is on screen; the quiet one's is not.
    expect(screen.getByRole("button", { name: /collapse job-portal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand dotfiles/i })).toBeInTheDocument();
  });

  it("keeps a run marker on a project the user has collapsed", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-live", "job-portal")],
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    await user.click(screen.getByRole("button", { name: /collapse job-portal/i }));

    // The sessions are gone…
    expect(screen.queryByRole("button", { name: /brigadier\/a80e2411/ })).not.toBeInTheDocument();
    // …and the fact that something is running inside is still on screen. §9's load-bearing rule.
    expect(screen.getByRole("img", { name: "1 running" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand job-portal/i })).toBeInTheDocument();
  });

  it("shows a session count in place of the sessions once collapsed", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-old", "old-crm")],
      selectedProjectId: "p-old",
      sessions: {
        a: session("a", "p-old", "exited", { branch: "brigadier/00000001" }),
        b: session("b", "p-old", "exited", { branch: "brigadier/00000002" }),
        c: session("c", "p-old", "exited", { branch: "brigadier/00000003" }),
      },
      order: ["a", "b", "c"],
    });

    // Selected, so it starts open: three rows, no count.
    expect(screen.getAllByRole("button", { name: /brigadier\/0000000/ })).toHaveLength(3);
    expect(screen.queryByText("3")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /collapse old-crm/i }));

    expect(screen.queryByRole("button", { name: /brigadier\/0000000/ })).not.toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not let the caret change the selection", async () => {
    const user = userEvent.setup();
    const props = mount({
      projects: [project("p-live", "job-portal")],
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    await user.click(screen.getByRole("button", { name: /collapse job-portal/i }));

    expect(props.onSelectProject).not.toHaveBeenCalled();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });
});

describe("a collapsed project that holds the open session", () => {
  /**
   * Observed on 2026-09-03: collapsing `brigadier-ai` while its session filled the main panel
   * left the sidebar with nothing acknowledging the thread on screen. Same principle as the run
   * marker — a sidebar that disowns what is on screen is disorienting — but a different fact,
   * so a different indicator.
   */
  it("says so, and says it distinctly from the run marker", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      selectedSessionId: "live",
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    await user.click(screen.getByRole("button", { name: /collapse job-portal/i }));

    expect(screen.queryByRole("button", { name: /brigadier\/a80e2411/ })).not.toBeInTheDocument();
    const holds = screen.getByRole("img", { name: "holds the open session" });
    const running = screen.getByRole("img", { name: "1 running" });
    // Two facts, two indicators. They must not have collapsed into one.
    expect(holds).toBeInTheDocument();
    expect(running).toBeInTheDocument();
    expect(holds).not.toBe(running);
  });

  /**
   * W4-C2 drew this one fact twice: this element, plus an accent rail painted onto the row by a
   * CSS `box-shadow` 230px to its left. **A DOM test can only pin the half that is a DOM
   * element** — the rail existed nowhere in the tree and was found by a pixel scan of a real
   * screenshot. This pins the half that is pinnable; the CSS half is held by there being no rule
   * left that targets the row.
   */
  it("draws the fact with exactly one element", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      selectedSessionId: "live",
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    await user.click(screen.getByRole("button", { name: /collapse job-portal/i }));

    expect(screen.getAllByRole("img", { name: "holds the open session" })).toHaveLength(1);
  });

  it("carries the marker for a project whose held session is not running", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-old", "old-crm")],
      selectedProjectId: "p-old",
      selectedSessionId: "done",
      sessions: { done: session("done", "p-old", "exited") },
      order: ["done"],
    });

    await user.click(screen.getByRole("button", { name: /collapse old-crm/i }));

    expect(screen.getByRole("img", { name: "holds the open session" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /running/ })).not.toBeInTheDocument();
  });

  it("drops the marker once the group is open again, where the row itself says it", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-old", "old-crm")],
      selectedProjectId: "p-old",
      selectedSessionId: "done",
      sessions: { done: session("done", "p-old", "exited") },
      order: ["done"],
    });

    await user.click(screen.getByRole("button", { name: /collapse old-crm/i }));
    expect(screen.getByRole("img", { name: "holds the open session" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand old-crm/i }));
    expect(screen.queryByRole("img", { name: "holds the open session" })).not.toBeInTheDocument();
  });

  it("does not mark a collapsed project that holds no open session", async () => {
    const user = userEvent.setup();
    mount({
      projects: [project("p-a", "job-portal"), project("p-b", "dotfiles")],
      selectedProjectId: "p-a",
      selectedSessionId: "mine",
      sessions: {
        mine: session("mine", "p-a", "exited"),
        theirs: session("theirs", "p-b", "exited", { branch: "brigadier/99999999" }),
      },
      order: ["mine", "theirs"],
    });

    await user.click(screen.getByRole("button", { name: /collapse job-portal/i }));
    expect(screen.getAllByRole("img", { name: "holds the open session" })).toHaveLength(1);
  });
});

describe("the sidebar's sessions", () => {
  it("labels a session by its branch and keeps the path out of the label", () => {
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      sessions: {
        live: session("live", "p-live", "running", {
          worktreePath: "/repos/job-portal/.worktrees/a80e2411",
        }),
      },
      order: ["live"],
    });

    const row = screen.getByRole("button", { name: /brigadier\/a80e2411/ });
    expect(row).toBeInTheDocument();
    expect(row.textContent).not.toContain("/repos/job-portal");
    // The uuid tail the old sidebar showed instead of a branch is not the label either.
    expect(row.textContent).not.toContain("live");
  });

  it("falls back to the session id when the project is not a git repo", () => {
    mount({
      projects: [project("p-plain", "scratch")],
      selectedProjectId: "p-plain",
      sessions: {
        "0f1e2d3c4b5a": session("0f1e2d3c4b5a", "p-plain", "running", {
          branch: null,
          worktreePath: null,
        }),
      },
      order: ["0f1e2d3c4b5a"],
    });

    expect(screen.getByRole("button", { name: /4b5a/ })).toBeInTheDocument();
  });

  it("reports a session's status to assistive technology, not only as a colour", () => {
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      sessions: { live: session("live", "p-live", "failed") },
      order: ["live"],
    });

    expect(screen.getByRole("button", { name: /failed/ })).toBeInTheDocument();
  });

  /**
   * The busy dot's pulse is a CSS animation: invisible to a screen reader, switched off under
   * `prefers-reduced-motion`, and not observable from a test at all. The fact it carries is, so
   * the row says it in words too, and this is the only assertable half of that behaviour.
   */
  it("announces an open turn as working, not merely running", () => {
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      sessions: { live: session("live", "p-live", "running", { busy: true }) },
      order: ["live"],
    });

    // Scoped to the session row: the project row above it also announces "1 running", from the
    // run marker nested inside it, and that is a different statement about a different subject.
    const row = screen.getByRole("button", { name: /brigadier\/a80e2411/ });
    expect(row).toHaveAccessibleName(/working/);
    expect(row).not.toHaveAccessibleName(/running/);
  });

  it("announces a running session with no open turn as running", () => {
    mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    const row = screen.getByRole("button", { name: /brigadier\/a80e2411/ });
    expect(row).toHaveAccessibleName(/running/);
    expect(row).not.toHaveAccessibleName(/working/);
  });

  it("hands the session id to onSelectSession when a row is clicked", async () => {
    const user = userEvent.setup();
    const props = mount({
      projects: [project("p-live", "job-portal")],
      selectedProjectId: "p-live",
      sessions: { live: session("live", "p-live", "running") },
      order: ["live"],
    });

    await user.click(screen.getByRole("button", { name: /brigadier\/a80e2411/ }));

    expect(props.onSelectSession).toHaveBeenCalledTimes(1);
    expect(props.onSelectSession).toHaveBeenCalledWith("live");
  });
});

describe("the sidebar's own rows", () => {
  it("says how many approvals are waiting, and says nothing when none are", () => {
    const { rerender } = renderCounts(0);
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
    rerender(2);
    expect(screen.getByText("2 waiting")).toBeInTheDocument();
  });

  it("clears the session selection from the New session row", async () => {
    const user = userEvent.setup();
    const props = mount({ projects: [project("p", "one")] });
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(props.onSelectSession).toHaveBeenCalledWith(null);
  });

  it("shows no window gauge, because no reading exists to draw one from", () => {
    mount({ projects: [project("p", "one")] });
    // W2-C carries `rate_limit_event.unifiedWindows` to the webview; until it does, a bar, a
    // zero or a dash here would be a number nobody measured.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

/** Mount the sidebar with `n` pending approvals, and hand back a way to change `n`. */
function renderCounts(n: number) {
  const props: SidebarProps = {
    projects: [project("p", "one")],
    sessions: {},
    order: [],
    selectedProjectId: null,
    selectedSessionId: null,
    pendingTotal: n,
    appInfo: null,
    claude: null,
    claudeError: null,
    isMock: true,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onAddProject: vi.fn(),
  };
  const view = render(<Sidebar {...props} />);
  return {
    rerender(next: number) {
      view.rerender(<Sidebar {...props} pendingTotal={next} />);
    },
  };
}

describe("the sidebar's project list", () => {
  it("names each project once, whatever its state", () => {
    mount({
      projects: [project("a", "job-portal"), project("b", "brigadier-ai"), project("c", "old-crm")],
    });
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("job-portal")).toBeInTheDocument();
    expect(within(nav).getByText("brigadier-ai")).toBeInTheDocument();
    expect(within(nav).getByText("old-crm")).toBeInTheDocument();
  });
});

/*
 * ------------------------------------------------------------------ the project-open flow
 *
 * The owner's sentence for this order: *launch the app, click **Add project**, and pick a folder
 * in a native macOS directory picker — not paste an absolute path into a text field.*
 *
 * What can be pinned here and what cannot is worth stating, because the gap is the whole risk.
 * These tests exercise the **call**: that clicking the control invokes the picker rather than
 * revealing a text field, that a cancel is silent, that a refusal is drawn where the owner is
 * looking, and that the typed path still works when there is no picker. They do **not** open a
 * macOS dialog, and nothing in this suite can — `@tauri-apps/plugin-dialog` needs a Tauri window,
 * and jsdom is not one. The picker itself is proven only by
 * `docs/research/tauri-dialog.md`'s reading of the plugin's own types and permission files.
 *
 * The seam that makes that testable is `onPickProject`'s *absence*: undefined means "no picker in
 * this runtime", which is a browser, and the "+" falls back to the field. So the same prop
 * expresses the degradation and gates the test.
 */
describe("adding a project", () => {
  it("opens the native picker rather than a text field", async () => {
    const user = userEvent.setup();
    const onPickProject = vi.fn(async () => null);
    mount({ onPickProject });

    await user.click(screen.getByRole("button", { name: "add a project" }));

    expect(onPickProject).toHaveBeenCalledTimes(1);
    // The point of the order: no path is typed. The fallback field stays closed on the happy path.
    expect(screen.queryByLabelText("project path")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says nothing and opens nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    // A cancelled `open({ directory: true })` resolves `null`, which `App.pickProject` turns into
    // `null` — the same value success returns (`docs/research/tauri-dialog.md` §2). A cancel is
    // not an error and must not be drawn as one.
    const onPickProject = vi.fn(async () => null);
    const onAddProject = vi.fn();
    mount({ onPickProject, onAddProject });

    await user.click(screen.getByRole("button", { name: "add a project" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("project path")).not.toBeInTheDocument();
    // Nothing was added by the typed route either; that `add_project` was not called at all is
    // pinned in `src/App.test.tsx`, which owns the bridge.
    expect(onAddProject).not.toHaveBeenCalled();
  });

  it("draws a refused folder beside the control, and opens the typed field as the way out", async () => {
    const user = userEvent.setup();
    const onPickProject = vi.fn(async () => new AppError("invalid_argument", "not a repository root"));
    mount({ onPickProject });

    await user.click(screen.getByRole("button", { name: "add a project" }));

    expect(screen.getByRole("alert")).toHaveTextContent("not a repository root");
    // The escape hatch: a picker that fails must never leave the owner with no route in.
    expect(screen.getByLabelText("project path")).toBeInTheDocument();
  });

  it("still adds a typed path when there is no picker", async () => {
    const user = userEvent.setup();
    const onAddProject = vi.fn(async () => null);
    // No `onPickProject`: a browser, where the mock bridge is selected and no dialog plugin exists.
    mount({ onAddProject });

    await user.click(screen.getByRole("button", { name: "add a project by path" }));
    await user.type(screen.getByLabelText("project path"), "  /repos/job-portal  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onAddProject).toHaveBeenCalledTimes(1);
    expect(onAddProject).toHaveBeenCalledWith("/repos/job-portal");
    // Accepted, so the field closes behind it.
    expect(screen.queryByLabelText("project path")).not.toBeInTheDocument();
  });

  it("keeps a refused typed path in the field instead of making it be retyped", async () => {
    const user = userEvent.setup();
    const onAddProject = vi.fn(async () => new AppError("invalid_argument", "not a directory"));
    mount({ onAddProject });

    await user.click(screen.getByRole("button", { name: "add a project by path" }));
    const field = screen.getByLabelText("project path");
    await user.type(field, "/repos/not-a-repo");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByRole("alert")).toHaveTextContent("not a directory");
    expect(field).toHaveValue("/repos/not-a-repo");
  });
});

/*
 * `tauri-plugin-opener` was a dead dependency until this order: registered in `lib.rs`, called by
 * nothing. Its job here is two reveals, and the load-bearing case is the one where there is
 * nothing to reveal.
 */
describe("revealing in Finder", () => {
  it("reveals a project by its root path", async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn();
    mount({ projects: [project("p", "job-portal")], onReveal });

    await user.click(screen.getByRole("button", { name: "reveal job-portal in Finder" }));

    expect(onReveal).toHaveBeenCalledWith("/repos/job-portal");
  });

  it("offers no reveal for a session with no worktree", () => {
    // `worktree_path` is null whenever the project is not a git repository (contract §Worktrees).
    // The control is **absent**, not disabled: a disabled button claims a folder exists.
    const sessions = {
      withTree: session("withTree", "p", "running"),
      noTree: session("noTree", "p", "running", { worktreePath: null, branch: null }),
    };
    mount({ projects: [project("p", "job-portal")], sessions, onReveal: vi.fn() });

    expect(screen.getByRole("button", { name: /reveal .* worktree in Finder/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /worktree in Finder/ })).toHaveLength(1);
  });

  it("offers no reveal at all outside a Tauri window", () => {
    // `onReveal` undefined is the browser: the opener plugin does not exist there, so neither
    // does the control.
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "running") },
    });

    expect(screen.queryByRole("button", { name: /in Finder/ })).not.toBeInTheDocument();
  });
});

/*
 * Deleting — R4.2, 2026-09-05.
 *
 * `docs/plans/ipc-contract.md` §Deleting. The owner had 44 sessions in his sidebar, 40 of them
 * synthetic burn rows with no way to remove them, and `cleanup_worktree` is the wrong verb: it
 * takes the checkout and leaves the row.
 *
 * Every assertion below is about **not lying to him**, which is what the four contract rules are
 * for. A refusal resolves rather than rejecting, so the one defect this surface can produce is
 * drawing a delete that did not happen as one that did — the same defect class as an approvals
 * dock showing a decision that never landed, which was a real bug in this repo two days before
 * this was written.
 */

/** `DeletedRows` with every count zero: what every refusal carries. */
const NO_ROWS = {
  projects: 0,
  sessions: 0,
  feed: 0,
  approvals: 0,
  intents: 0,
  plans: 0,
  phases: 0,
  plan_revisions: 0,
  unknowns: 0,
  work_orders: 0,
  work_orders_orphaned: 0,
};

function cleanup_(over: Partial<WorktreeCleanup> = {}): WorktreeCleanup {
  return {
    removed: false,
    dirty_files: 0,
    commits: 0,
    branch: "brigadier/a80e2411",
    live_branch: "brigadier/a80e2411",
    blocked: null,
    ...over,
  };
}

describe("deleting a session", () => {
  it("asks before it deletes, and the first click reaches no command", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn();
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "exited") },
      order: ["one"],
      // Selected, so the group is open and the row is on screen: a collapsed project draws a
      // count, not its sessions.
      selectedProjectId: "p",
      onDeleteSession,
    });

    await user.click(screen.getByRole("button", { name: "delete session a80e2411" }));

    expect(onDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete this session from the machine\?/)).toBeInTheDocument();
    // The branch is named *before* the row that records it goes: it is the only thing left that
    // says where the work went, and no path in the harness deletes one.
    expect(screen.getByText(/branch brigadier\/a80e2411 is kept/)).toBeInTheDocument();
  });

  it("sends force: false on the confirmation, never on the first click", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn(async () => ({
      deletion: {
        session_id: "one",
        removed: true,
        rows: { ...NO_ROWS, sessions: 1 },
        worktree: null,
        logs_removed: 1,
        branch: "brigadier/a80e2411",
      },
      error: null as null,
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "exited") },
      order: ["one"],
      // Selected, so the group is open and the row is on screen: a collapsed project draws a
      // count, not its sessions.
      selectedProjectId: "p",
      onDeleteSession,
    });

    await user.click(screen.getByRole("button", { name: "delete session a80e2411" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));

    expect(onDeleteSession).toHaveBeenCalledWith("one", false);
  });

  /**
   * Rule 2. `session_running` is the one refusal that **rejects** rather than resolving, and it
   * has a remedy the operator can act on in this window — so it gets a sentence rather than a
   * code. `force` does not answer it and no force button is drawn.
   */
  it("renders a session_running rejection as a refusal with its remedy, not as a success", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn(async () => ({
      deletion: null,
      error: new AppError("session_running", "session one is still live; end it or kill it first"),
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "running") },
      order: ["one"],
      selectedProjectId: "p",
      onDeleteSession,
    });

    await user.click(screen.getByRole("button", { name: "delete session a80e2411" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("This session is still running. End it or kill it first");
    expect(note).toHaveTextContent("nothing was deleted");
    // The row is still there — the refusal did not take it off screen.
    expect(screen.getByRole("button", { name: /brigadier\/a80e2411/ })).toBeInTheDocument();
    // Nothing offers to force past a live child; that check is what stands between a mis-click
    // and an agent writing into a deleted inode.
    expect(within(note).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  /**
   * Rule 3. Unmerged commits refuse and the branch is kept, so the refusal's job is to put the
   * branch name in front of the operator before the row that records it goes.
   */
  it("names the branch on an unmerged-commits refusal, and offers force as a second action", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn(async () => ({
      deletion: {
        session_id: "one",
        removed: false,
        rows: NO_ROWS,
        worktree: cleanup_({ commits: 3, blocked: "commits" as const }),
        logs_removed: 0,
        branch: "brigadier/a80e2411",
      },
      error: null as null,
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "exited") },
      order: ["one"],
      // Selected, so the group is open and the row is on screen: a collapsed project draws a
      // count, not its sessions.
      selectedProjectId: "p",
      onDeleteSession,
    });

    await user.click(screen.getByRole("button", { name: "delete session a80e2411" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("Nothing was deleted");
    expect(note).toHaveTextContent("3 commits that no other branch, tag or remote keeps");
    expect(note).toHaveTextContent("branch brigadier/a80e2411 is kept");

    // The force is the *second* action, drawn by the refusal itself.
    await user.click(within(note).getByRole("button", { name: /Delete anyway, keep the branch/ }));
    expect(onDeleteSession).toHaveBeenNthCalledWith(2, "one", true);
  });

  /**
   * `unregistered`, `locked` and `left_on_disk` return **before** the force check
   * (`crates/supervisor/src/worktree.rs:468, :472, :549`), so a force button on one of them is a
   * button guaranteed to refuse again. The sentence ends in what to do outside brigadier instead.
   */
  it("offers no force for a refusal force cannot reach", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn(async () => ({
      deletion: {
        session_id: "one",
        removed: false,
        rows: NO_ROWS,
        worktree: cleanup_({ blocked: "locked" as const }),
        logs_removed: 0,
        branch: "brigadier/a80e2411",
      },
      error: null as null,
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "exited") },
      order: ["one"],
      // Selected, so the group is open and the row is on screen: a collapsed project draws a
      // count, not its sessions.
      selectedProjectId: "p",
      onDeleteSession,
    });

    await user.click(screen.getByRole("button", { name: "delete session a80e2411" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("git worktree unlock");
    expect(within(note).queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(within(note).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("draws no delete control at all when the host offers none", () => {
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "exited") },
      order: ["one"],
      selectedProjectId: "p",
    });

    expect(screen.queryByRole("button", { name: /^delete session/ })).not.toBeInTheDocument();
  });
});

describe("deleting a project", () => {
  it("says what goes with it before it goes", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn();
    mount({
      projects: [project("p", "job-portal")],
      sessions: {
        one: session("one", "p", "exited"),
        two: session("two", "p", "exited", { branch: "brigadier/bbbb2222" }),
      },
      order: ["one", "two"],
      selectedProjectId: "p",
      onDeleteProject,
    });

    await user.click(screen.getByRole("button", { name: "delete project job-portal" }));

    expect(onDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete job-portal from brigadier\?/)).toBeInTheDocument();
    expect(screen.getByText(/2 sessions go with it/)).toBeInTheDocument();
    expect(screen.getByText(/Every branch is kept/)).toBeInTheDocument();
  });

  /**
   * Rule 4, and the one this whole surface exists for. The database half is all-or-nothing; the
   * **worktree half is not**. Checkouts go one session at a time before any row is touched and
   * the first refusal ends the pass, so the ones removed before it stay removed. A project that
   * half-deleted and reported one line is exactly what this renders instead.
   */
  it("lists every session a partial delete attempted, including the one that refused", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn(async () => ({
      deletion: {
        project_id: "p",
        removed: false,
        rows: NO_ROWS,
        worktrees: [
          {
            session_id: "one",
            cleanup: cleanup_({ removed: true, branch: "brigadier/aaaa1111", live_branch: "brigadier/aaaa1111" }),
          },
          {
            session_id: "two",
            cleanup: cleanup_({
              dirty_files: 7,
              blocked: "dirty" as const,
              branch: "brigadier/bbbb2222",
              live_branch: "brigadier/bbbb2222",
            }),
          },
        ],
        logs_removed: 0,
        gate_logs_removed: 0,
        brigadier_dir_removed: false,
      },
      error: null as null,
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: {
        one: session("one", "p", "exited", { branch: "brigadier/aaaa1111" }),
        two: session("two", "p", "exited", { branch: "brigadier/bbbb2222" }),
      },
      order: ["one", "two"],
      selectedProjectId: "p",
      onDeleteProject,
    });

    await user.click(screen.getByRole("button", { name: "delete project job-portal" }));
    await user.click(screen.getByRole("button", { name: "Delete project" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("Nothing was deleted from the database");
    // Both entries, and the one that already went says so rather than being folded away.
    const entries = within(note).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("brigadier/aaaa1111");
    expect(entries[0]).toHaveTextContent("checkout removed");
    expect(entries[1]).toHaveTextContent("brigadier/bbbb2222");
    expect(entries[1]).toHaveTextContent("7 files would be deleted");
    // …and the survivors are named as survivors, not as losses.
    expect(note).toHaveTextContent("every branch survives");

    await user.click(within(note).getByRole("button", { name: /Delete 7 files and the session/ }));
    expect(onDeleteProject).toHaveBeenNthCalledWith(2, "p", true);
  });

  it("renders a session_running rejection as a refusal naming the remedy", async () => {
    const user = userEvent.setup();
    const onDeleteProject = vi.fn(async () => ({
      deletion: null,
      error: new AppError("session_running", "project p has 1 live session(s) (one)"),
    }));
    mount({
      projects: [project("p", "job-portal")],
      sessions: { one: session("one", "p", "running") },
      order: ["one"],
      selectedProjectId: "p",
      onDeleteProject,
    });

    await user.click(screen.getByRole("button", { name: "delete project job-portal" }));
    await user.click(screen.getByRole("button", { name: "Delete project" }));

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent("End or kill it first");
    expect(note).toHaveTextContent("nothing was deleted, not even the other sessions");
    // The project is still in the sidebar; a refusal takes nothing off screen.
    expect(screen.getByText("job-portal")).toBeInTheDocument();
  });
});
