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
import { ZERO_USAGE } from "../wire";
import type { ProjectView, SessionId, SessionStatus } from "../wire";

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
