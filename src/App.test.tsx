/**
 * Behavioural tests for the shell's one instrumented interaction: **B4** in `docs/vision.md` §9,
 * "click a session → its last screenful painted, ≤ 100 ms p95".
 *
 * These do not measure anything and cannot — a number needs a real window, and `paint.ts`'s
 * double-`requestAnimationFrame` is stubbed out here along with the rest of the module. What they
 * pin is the part that is easy to get silently wrong and impossible to notice from a log file:
 * **which span settles against which rows**. A span that settles against the wrong session's
 * paint produces a plausible number that is a lie, and `paint.ndjson` has no column that would
 * show it.
 *
 *   - selecting a session opens exactly one span, under the label the budget is filed under;
 *   - a session with rows settles it;
 *   - a session with none reports nothing rather than timing an empty state;
 *   - selecting a second session before the first settles abandons the first and never reports
 *     it against the second's rows.
 *
 * Mechanics, matching `src/feedStore.test.ts` and `src/App.run.test.tsx`:
 * `globals: false`, `vi.resetModules()` plus a per-test `await import("./App")` because
 * `feedStore` is a module singleton whose sessions would otherwise leak between tests, and a
 * hand-called `cleanup()` because auto-cleanup needs a global `afterEach` that `globals: false`
 * denies it.
 *
 * `./paint` is mocked whole. The real module is covered by `src/paint.test.ts`; what is under
 * test here is the call site, and a real `beginInteraction` would only add jsdom's absent
 * `performance.mark` to the surface area.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memo } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { pasteComposer } from "./test/composer";
import userEvent from "@testing-library/user-event";

import type { PeerData } from "./peerApi";
import type { SidebarProps } from "./components/Sidebar";
import { ZERO_USAGE } from "./wire";
import type { FeedRowWire, SessionStatus, SessionView } from "./wire";

/* --------------------------------------------------------------- fixtures */

/** Shared with the hoisted `vi.mock` factories below; reset in `beforeEach`. */
/**
 * A render counter for the memoised `Sidebar` in **this** tree.
 *
 * `Sidebar.test.tsx` counts calls to `useSessionNavigation`, which is called once at the top of
 * `SidebarView`'s body and nowhere else in *its* tree. The shell's tree has two more callers —
 * `PromptInput` in the dock and `SessionMenu` inside each sidebar row — so that counter here would
 * only say "something in the shell rendered" and could never observe a memo skipping.
 *
 * So `counted` re-memoises the real `Sidebar` behind a component that increments on every render
 * React lets through. Both memos use `memo`'s default shallow prop comparison, so the outer one
 * admits exactly the renders the inner one would: identity-equal props bail out of both, and a
 * prop that moved re-renders both.
 *
 * What it therefore counts is **renders driven by props**. A re-render `SidebarView` causes from
 * inside itself — its own `useWorkbenchSnapshot`, `useSessionNavigation` or `useFeedSelector`
 * waking — happens under the outer memo and is *not* counted here; that claim is
 * `Sidebar.test.tsx`'s, whose probe sits inside the component body.
 */
const probe = vi.hoisted(() => ({ renders: 0 }));
function counted(
  Real: typeof import("./components/Sidebar").Sidebar,
): typeof import("./components/Sidebar").Sidebar {
  return memo(function CountedSidebar(props: SidebarProps) {
    probe.renders += 1;
    return <Real {...props} />;
  }) as typeof import("./components/Sidebar").Sidebar;
}

const h = vi.hoisted(() => ({
  peers: {origins:{},subagents:{},titles:{},closed:[],requests:[],messages:[],loaded:true} as PeerData,
  start: vi.fn(),
  responses: [] as unknown[][],
  projects: [] as Array<{
    id: string;
    name: string;
    root_path: string;
    created_at_ms: number;
    projectless?: boolean;
  }>,
  sessions: [] as unknown[],
  initialData: null as Promise<void> | null,
  /** What `feed_tail` answers with, per session id. */
  tailRows: {} as Record<string, unknown[]>,
  /** While true, `feed_tail` parks instead of answering, and the promise lands in `parked`. */
  hold: false,
  parked: [] as Array<{ id: string; answer: (rows: unknown[]) => void }>,
  /** Every span `beginInteraction` handed out, in order. */
  spans: [] as Array<{ label: string; painted: number; cancelled: number }>,
  /** Every `set_visible_projects` argument, in order. This is what decides whether Rust sends
   *  a project's rows at all, so it is the load-bearing half of the selection fix. */
  visible: [] as string[][],
  /** The most recent one. `Array.prototype.at` is ES2022 and `tsconfig.json`'s lib is older. */
  lastVisible(): string[] | undefined {
    return this.visible[this.visible.length - 1];
  },
  /**
   * `Bridge.isMock`, as a mutable flag rather than a constant, because it is what the shell gates
   * the native picker and the Finder reveals on: both plugins exist only in a Tauri window. The
   * default stays `true`, so every test written before this one sees exactly the app it saw then.
   */
  isMock: true,
  /** What `pickDirectory` answers. `null` is a **cancelled** picker, not a failure. */
  picked: null as string | null,
  /** Every path `add_project` was called with, in order. Empty is how "nothing was added" is
   *  asserted, and it is the whole point of the cancel test. */
  added: [] as string[],
  /**
   * Every props object `App` handed `Sidebar`, in render order.
   *
   * This is how the identity contract with `Sidebar`'s `memo` is asserted: a memo compares props
   * by identity, so "the sidebar did not have to re-render" is a statement about `Object.is` on
   * these objects and about nothing that is visible in the DOM.
   */
  sidebarProps: [] as Array<Record<string, unknown>>,
  /** The real `Sidebar`, re-imported per test; see the mock factory below. */
  realSidebar: null as typeof import("./components/Sidebar").Sidebar | null,
  /** Every `delete_session` / `delete_project` call, in order, with the `force` it carried. */
  deletes: [] as Array<{
    kind: "session" | "project";
    id: string;
    force: boolean;
  }>,
}));

vi.mock("./peerApi", async (importOriginal) => ({
  ...await importOriginal<typeof import('./peerApi')>(),
  usePeers: () => h.peers,
}));

vi.mock("./paint", () => ({
  startPaintInstrumentation: () => {},
  INTERACTION_TIMEOUT_MS: 5000,
  beginInteraction: (label: string) => {
    const span = { label, painted: 0, cancelled: 0 };
    h.spans.push(span);
    return {
      painted: () => {
        span.painted += 1;
      },
      cancel: () => {
        span.cancelled += 1;
      },
    };
  },
}));

/**
 * The real `Sidebar`, wrapped so every props object it is handed is recorded.
 *
 * A wrapper rather than a stub: every other test in this file drives the real sidebar, and a fake
 * one would quietly turn them into tests of the fake. The wrapper adds one component to the tree
 * and forwards the props untouched, `ref` included (React 19 passes it as an ordinary prop).
 */
vi.mock("./components/Sidebar", async () => {
  // **Neither `importOriginal` nor a captured reference.** Vitest re-instantiates a module's whole
  // dependency subtree for `importActual`, and a `vi.mock` factory's result is cached *across*
  // `vi.resetModules()` — either way the sidebar this wrapper renders ends up carrying a second
  // `controls/sidebar` module, a second React context that the provider `App` rendered never
  // filled, and every test in this file dies on "Sidebar provider is missing".
  //
  // So the real component is re-imported per test in `beforeEach`, from a query-suffixed id that
  // is a distinct module to Vite (and so escapes this mock) while its own relative imports still
  // resolve into the one shared graph. The factory's own copy is only the fallback.
  // The id is declared in `src/test/vite-query.d.ts`, so this needs no error suppression.
  const fallback: typeof import("./components/Sidebar") = await import("./components/Sidebar.tsx?unmocked");
  return {
    ...fallback,
    Sidebar: (props: Record<string, unknown>) => {
      h.sidebarProps.push(props);
      const Real = h.realSidebar ?? fallback.Sidebar;
      return <Real {...(props as unknown as Parameters<typeof Real>[0])} />;
    },
  };
});

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  const fake = {
    get isMock() {
      return h.isMock;
    },
    async subscribeFeed() {},
    async setVisibleProjects(ids: string[]) {
      h.visible.push(ids);
    },
    async appInfo() {
      return { run_id: "test", data_dir: "/tmp", version: "0.1.0" };
    },
    async probeClaude() {
      return { binary: "/usr/local/bin/claude", version: "2.1.4" };
    },
    async listModels() {
      return [];
    },
    async listProjects() {
      if (h.initialData) await h.initialData;
      return h.projects;
    },
    async addProject(path: string) {
      h.added.push(path);
      const existing = h.projects.find(p => p.root_path === path);
      const p = existing ?? project(
        `p-${h.added.length}`,
        path.split("/").filter(Boolean).pop() ?? path,
      );
      if (!existing) h.projects = [...h.projects, p];
      const nav = JSON.parse(localStorage.getItem("brigadier:navigation:v1") ?? "null");
      if (nav) {
        nav.trash = nav.trash.filter((t: {kind: string; id: string}) => !(t.kind === "project" && t.id === p.id));
        localStorage.setItem("brigadier:navigation:v1", JSON.stringify(nav));
      }
      return p;
    },
    async pickDirectory() {
      return h.picked;
    },
    async revealPath() {},
    async listSessions() {
      return h.sessions;
    },
    async projectlessWorkspace() {
      const existing = h.projects.find(project => project.projectless);
      if (existing) return existing;
      const scratch = { id: "tasks", name: "Tasks", root_path: "/tmp/chats", created_at_ms: 1, projectless: true };
      h.projects.push(scratch);
      return scratch;
    },
    startSession: (...args: unknown[]) => h.start(...args),
    async resumeSession() {
      throw new Error("not used");
    },
    async sendTurn() {
      return { turn_id: "t" };
    },
    async respond(...args: unknown[]) { h.responses.push(args); },
    async interrupt() {},
    async endSession() {},
    async kill() {},
    async cleanupWorktree() {
      throw new Error("not used");
    },
    /**
     * A clean delete: nothing in the worktree refuses, so the rows go and the row goes with them.
     * The refusal shapes are `src/components/Sidebar.test.tsx`'s, where the sentences live; what
     * is under test here is the half only the shell can do — the session leaving the sidebar.
     */
    async deleteSession(sessionId: string, force: boolean) {
      h.deletes.push({ kind: "session", id: sessionId, force });
      const gone = h.sessions.find(
        (s) => (s as SessionView).session_id === sessionId,
      ) as SessionView | undefined;
      h.sessions = h.sessions.filter(
        (s) => (s as SessionView).session_id !== sessionId,
      );
      return {
        session_id: sessionId,
        removed: true,
        rows: { ...NO_ROWS, sessions: 1, feed: 12 },
        worktree: null,
        logs_removed: 1,
        branch: gone?.branch ?? null,
      };
    },
    async deleteProject(projectId: string, force: boolean) {
      h.deletes.push({ kind: "project", id: projectId, force });
      const own = h.sessions.filter(
        (s) => (s as SessionView).project_id === projectId,
      );
      h.sessions = h.sessions.filter(
        (s) => (s as SessionView).project_id !== projectId,
      );
      h.projects = h.projects.filter((p) => p.id !== projectId);
      return {
        project_id: projectId,
        removed: true,
        rows: { ...NO_ROWS, projects: 1, sessions: own.length, feed: 40 },
        worktrees: [],
        logs_removed: own.length,
        gate_logs_removed: 0,
        brigadier_dir_removed: true,
      };
    },
    feedTail(sessionId: string) {
      if (h.hold) {
        return new Promise<unknown[]>((answer) =>
          h.parked.push({ id: sessionId, answer }),
        );
      }
      return Promise.resolve(h.tailRows[sessionId] ?? []);
    },
    async pendingApprovals() {
      return [];
    },
    // The run surface. These tests are about the B4 span and the project selection, so the five
    // commands answer "there has never been a run here": `src/App.run.test.tsx` is what exercises
    // them. They are present rather than absent because the shell calls two of them on mount.
    async startRun() {
      throw new Error("not used");
    },
    async currentRun() {
      return null;
    },
    async stopRun() {},
    async unsettledIntents() {
      return [];
    },
    async settleIntent() {},
    async reportPaint() {},
    async recordFrameStats() {},
    async burn() {},
  };
  return { ...actual, bridge: () => fake };
});

function project(id: string, name: string) {
  return {
    id,
    name,
    root_path: `/repos/${name}`,
    created_at_ms: 1_700_000_000_000,
  };
}

/** `DeletedRows` with every count zero — what a refusal carries and what a success builds on. */
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

function view(
  sessionId: string,
  projectId: string,
  status: SessionStatus = "running",
): SessionView {
  return {
    session_id: sessionId,
    project_id: projectId,
    instance_id: null,
    provider_session_id: null,
    cwd: `/repos/job-portal/.worktrees/${sessionId}`,
    worktree_path: `/repos/job-portal/.worktrees/${sessionId}`,
    branch: `brigadier/${sessionId}`,
    model: "claude-sonnet-4-5",
    status,
    started_at_ms: 1_700_000_000_000,
    ended_at_ms: null,
    exit_code: null,
    last_event_seq: 0,
    usage: { ...ZERO_USAGE },
    cost_usd_cumulative: 0,
  };
}

/** `k: "sys"` because these rows stand in for the prefill, and nothing here is about kinds; a
 *  real class rather than `"unknown"`, so the fixture is not silently the special case that no
 *  filter may touch. `src/components/Feed.test.tsx` is where `k` is actually exercised. */
function row(sessionId: string, q: number): FeedRowWire {
  return {
    s: sessionId,
    q,
    t: 1_700_000_000_000 + q,
    l: `line ${q}`,
    k: "sys",
  };
}

/** Mount the app and wait for the mount effect's `Promise.all` to have landed. */
async function mountApp() {
  const { App } = await import("./App");
  render(<App />);
  // The project list is what the mount effect resolves last into the tree. `findAll`, because
  // the name lands in the sidebar, the thread header and the start-a-session form at once.
  await screen.findAllByText(h.projects[0]!.name);
}

beforeEach(async () => {
  vi.resetModules();
  const unmocked: typeof import("./components/Sidebar") = await import("./components/Sidebar.tsx?unmocked");
  h.realSidebar = counted(unmocked.Sidebar);
  h.start.mockReset();
  h.projects = [project("p-live", "job-portal")];
  h.visible = [];
  h.sessions = [];
  h.responses = [];
  h.peers = {origins:{},subagents:{},titles:{},closed:[],requests:[],messages:[],loaded:true};
  h.initialData = null;
  h.tailRows = {};
  h.hold = false;
  h.parked = [];
  h.spans = [];
  h.isMock = true;
  h.picked = null;
  h.added = [];
  h.deletes = [];
  h.sidebarProps = [];
  probe.renders = 0;
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ tests */

it("reports workspace readiness only after initial data is rendered", async () => {
  let release!: () => void;
  h.initialData = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { App } = await import("./App");
  const onReady = vi.fn(() => {
    expect(screen.getAllByText("job-portal").length).toBeGreaterThan(0);
  });
  await act(async () => {
    render(<App onReady={onReady} />);
  });
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => {
    release();
  });
  expect(onReady).toHaveBeenCalledOnce();
});

async function selectHistory(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
) {
  const session = (h.sessions as SessionView[]).find(
    (s) => s.session_id === id,
  )!;
  const project = h.projects.find((p) => p.id === session.project_id)!;
  const row = within(
    screen.getByRole("navigation", { name: "Projects" }),
  ).getByRole("button", { name: project.name });
  if (row.getAttribute("aria-current") !== "page") await user.click(row);
  await user.click(
    await within(
      screen.getByRole("navigation", { name: "Projects" }),
    ).findByRole("button", { name: `Session ${id.slice(-6)}` }),
  );
}

describe("the B4 paint span", () => {
  it("opens exactly one span, under the label the budget is filed under", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();

    await selectHistory(user, "aaaa1111");

    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.label).toBe("b4-session-painted");
  });

  it("settles the span once the selected session's rows are in the store", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.tailRows = { aaaa1111: [row("aaaa1111", 1), row("aaaa1111", 2)] };
    await mountApp();

    await act(async () => {
      await selectHistory(user, "aaaa1111");
    });

    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.painted).toBe(1);
    expect(h.spans[0]!.cancelled).toBe(0);
  });

  it("reports nothing for a session whose tail is empty", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();

    await act(async () => {
      await selectHistory(user, "aaaa1111");
    });

    // An empty session has no "last screenful"; timing its empty state would flatter the p95.
    expect(h.spans[0]!.painted).toBe(0);
    expect(h.spans[0]!.cancelled).toBe(1);
  });

  it("abandons the first span when a second session is selected before it settles", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live"), view("bbbb2222", "p-live")];
    h.hold = true;
    await mountApp();

    await selectHistory(user, "aaaa1111");
    await selectHistory(user, "bbbb2222");

    expect(h.spans).toHaveLength(2);
    expect(h.spans[0]!.cancelled).toBe(1);
    expect(h.spans[0]!.painted).toBe(0);

    // The first session's rows land *after* the selection moved on. Nothing may settle on them.
    const first = h.parked.find((p) => p.id === "aaaa1111");
    expect(first).toBeDefined();
    await act(async () => {
      first!.answer([row("aaaa1111", 1), row("aaaa1111", 2)]);
    });

    expect(h.spans[0]!.painted).toBe(0);
    expect(h.spans[1]!.painted).toBe(0);
    expect(h.spans[1]!.cancelled).toBe(0);

    // …and the second session's own rows still settle its own span.
    const second = h.parked.find((p) => p.id === "bbbb2222");
    expect(second).toBeDefined();
    await act(async () => {
      second!.answer([row("bbbb2222", 7)]);
    });

    expect(h.spans[1]!.painted).toBe(1);
    expect(h.spans[0]!.painted).toBe(0);
  });

  it("opens no span when the selection is cleared rather than moved", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.hold = true;
    await mountApp();

    await selectHistory(user, "aaaa1111");
    await user.click(
      screen.getByRole("button", { name: "New session in job-portal" }),
    );

    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.cancelled).toBe(1);
    expect(h.spans[0]!.painted).toBe(0);
  });

  it("abandons a span in flight when the window goes away", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.hold = true;
    await mountApp();

    await selectHistory(user, "aaaa1111");
    expect(h.spans[0]!.cancelled).toBe(0);

    cleanup();

    expect(h.spans[0]!.cancelled).toBe(1);
    expect(h.spans[0]!.painted).toBe(0);
  });
});

describe("the project a session belongs to", () => {
  /**
   * Observed on 2026-09-03: selecting a `burn` session while `brigadier-ai` was the selected
   * project rendered a header reading "brigadier-ai" over it. The sidebar drew the session
   * nested under `burn` at the same time, so the window contradicted itself about which project
   * a session belonged to.
   */
  it("moves the project selection to the session's own project", async () => {
    const user = userEvent.setup();
    h.projects = [project("p-one", "brigadier-ai"), project("p-two", "burn")];
    h.sessions = [view("bbbb2222", "p-two")];
    await mountApp();

    // The mount effect selects the first project, and the session belongs to the second.
    const thread = screen.getByRole("main");
    expect(within(thread).getByRole("heading", { name: "What should we build in brigadier-ai?" })).toBeVisible();

    await selectHistory(user, "bbbb2222");

    // The thread column no longer names any project but the session's own.
    expect(within(thread).queryByText("brigadier-ai")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).getByRole(
        "button",
        { name: "burn" },
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it("makes that project visible, so Rust actually sends its rows", async () => {
    const user = userEvent.setup();
    h.projects = [project("p-one", "brigadier-ai"), project("p-two", "burn")];
    h.sessions = [view("bbbb2222", "p-two")];
    await mountApp();

    expect(h.lastVisible()).toEqual(["p-one"]);

    await selectHistory(user, "bbbb2222");

    // Without this the batcher drops every row for the session that was just opened.
    expect(h.lastVisible()).toEqual(["p-two"]);
  });

  it("leaves the project selection alone for a session the store cannot place", async () => {
    const user = userEvent.setup();
    h.projects = [project("p-one", "brigadier-ai")];
    h.sessions = [view("aaaa1111", "p-one")];
    await mountApp();

    await selectHistory(user, "aaaa1111");

    expect(h.lastVisible()).toEqual(["p-one"]);
    expect(h.spans).toHaveLength(1);
  });
});

describe("the shell's handlers", () => {
  it("keeps every transition awaited: nothing paints before Rust confirms", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.hold = true;
    await mountApp();

    // Clicking a session with its tail parked must not invent rows, a status change, or a
    // second session row. `docs/vision.md` §9's optimistic transitions are W4-D's, and an
    // optimistic entry has to be retired by a matched echo that does not exist yet.
    await selectHistory(user, "aaaa1111");

    expect(
      screen.getAllByRole("button", { name: "Session aa1111" }),
    ).toHaveLength(1);
  });
});

/*
 * The project-open flow, at the one seam the sidebar cannot see: **whether `add_project` was
 * called at all.**
 *
 * `src/components/Sidebar.test.tsx` pins that clicking "Add project" invokes the picker rather
 * than revealing a text field. It cannot pin the cancel, because from inside the sidebar a
 * cancelled picker and a successful one look identical — both resolve `null`. The difference is
 * one command that did or did not go to Rust, and this file is the one that owns the bridge.
 *
 * `h.isMock = false` is not decoration: the picker and the Finder reveals are drawn only outside
 * the mock bridge, because `tauri-plugin-dialog` and `tauri-plugin-opener` exist only in a Tauri
 * window (`docs/research/tauri-dialog.md`).
 *
 * **Nothing here opens a macOS dialog.** `pickDirectory` is a fake that answers `h.picked`. What
 * is proven is the shell's handling of the two answers the real plugin gives; that the real
 * plugin gives them is read out of its own types, not observed.
 */
describe("opening a project", () => {
  it("selects an existing folder repeatedly without duplicating its sidebar entry", async () => {
    const user = userEvent.setup();
    h.isMock = false;
    h.picked = "/repos/job-portal";
    await mountApp();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Add project" }));
    const sidebar = screen.getByRole("navigation", { name: "Projects" });
    expect(within(sidebar).getAllByText("job-portal")).toHaveLength(1);
    expect(h.projects).toHaveLength(1);
    expect(h.lastVisible()).toEqual(["p-live"]);
  });

  it("reopens a trashed project with its saved sessions and selects it after navigation reload", async () => {
    const user = userEvent.setup();
    h.isMock = false;
    h.picked = "/repos/job-portal";
    h.sessions = [view("aaaa1111", "p-live", "exited")];
    localStorage.setItem("brigadier:navigation:v1", JSON.stringify({ projectColors: {}, pinnedSessions: [], trash: [
      {kind: "project", id: "p-live", title: "job-portal", projectId: "p-live", sessionIds: ["aaaa1111"], trashedAt: 1},
    ] }));
    const { App } = await import("./App");
    render(<App />);
    expect(await screen.findByText("No projects imported.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("button", { name: "Project actions job-portal" })).toBeVisible();
    expect(h.lastVisible()).toEqual(["tasks", "p-live"]);
    expect(screen.getAllByRole("button", { name: /^Session aa1111/ }).length).toBeGreaterThan(0);
    expect(h.projects.filter(project => !project.projectless)).toHaveLength(1);
    cleanup();
    await mountApp();
    expect(screen.getByRole("button", { name: "Project actions job-portal" })).toBeVisible();
  });

  it("adds the folder the picker returned", async () => {
    const user = userEvent.setup();
    h.isMock = false;
    h.picked = "/repos/brigadier-ai";
    await mountApp();

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(h.added).toEqual(["/repos/brigadier-ai"]);
    // And it landed in the list under the name the Rust side gave it.
    expect(await screen.findAllByText("brigadier-ai")).not.toHaveLength(0);
  });

  it("adds nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    h.isMock = false;
    // `open({ directory: true, multiple: false })` resolves `null` on cancel, and the plugin's own
    // doc comment says so: "user cancelled the selection". It is not an error, and it must not
    // reach `add_project`.
    h.picked = null;
    await mountApp();

    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(h.added).toEqual([]);
    // No banner, no inline message: a cancel is silent.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("draws no picker and no Finder reveals in a browser", async () => {
    // The mock bridge, which is what `npm run dev` selects: neither plugin is present, so the
    // "+" falls back to the typed field and no reveal control is drawn at all.
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();

    await userEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(screen.getByLabelText("Project path")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /in Finder/ }),
    ).not.toBeInTheDocument();
  });
});

/*
 * R4.2, 2026-09-05. The owner had 44 sessions in his sidebar, 40 of them synthetic burn rows he
 * had no way to remove: `cleanup_worktree` takes a checkout away and leaves the row behind, and
 * there was no second verb. These pin the half only the shell can do — the row leaving the
 * sidebar, and the selection not being left pointing at something that is gone. The sentences a
 * refusal draws are `src/components/Sidebar.test.tsx`'s.
 */
describe("deleting", () => {
  it("unarchives in Settings and opens the chat only through the toast View action", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live", "exited")];
    await mountApp();
    await user.click(screen.getByRole("button", { name: "Archive Session aa1111" }));
    expect(screen.queryByRole("button", { name: "History" })).not.toBeInTheDocument();
    // The archive toast opens Settings and locates this chat.
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "View" }));
    await user.click(await screen.findByRole("button", { name: "Unarchive Session aa1111" }));
    expect(screen.getByRole("main", { name: "Archived chats" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).not.toBeInTheDocument();
    const sidebarBefore = localStorage.getItem("brigadier:sidebar-open");
    await user.keyboard("{Meta>}b{/Meta}");
    expect(localStorage.getItem("brigadier:sidebar-open")).toBe(sidebarBefore);
    expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem("brigadier:session-archive:v1")!).entries.aaaa1111).toBeUndefined();
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "View" }));
    expect(screen.queryByRole("main", { name: "Archived chats" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Archive Session aa1111" })).toBeVisible();
  });
  it("deletes a single archived chat immediately and preserves other chats", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live", "exited"), view("bbbb2222", "p-live", "exited")];
    await mountApp();
    await user.click(screen.getByRole("button", { name: "Archive Session aa1111" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Archived chats" }));
    await user.click(screen.getByRole("button", { name: "Delete Session aa1111" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("brigadier:session-archive:v1")!).deleted).toContain("aaaa1111");
    expect(screen.queryByText("Session aa1111")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.getAllByRole("button", { name: /^Session bb2222/ })[0]).toBeVisible();
  });
  it("canceling Delete all leaves archived chats available", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live", "exited")];
    await mountApp();
    await user.click(screen.getByRole("button", { name: "Archive Session aa1111" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Archived chats" }));
    await user.click(screen.getByRole("button", { name: "Delete all" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Unarchive Session aa1111" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem("brigadier:session-archive:v1")!).deleted).toEqual([]);
  });
  it("removes a project after confirmation, preserving on-disk files", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live", "exited")];
    await mountApp();
    await user.click(
      screen.getByRole("button", { name: "Project actions job-portal" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove project" }));
    expect(h.deletes).toHaveLength(0);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Move to Trash",
      }),
    );
    expect(h.deletes).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem("brigadier:navigation:v1")!).trash[0].id,
    ).toBe("p-live");
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).queryByText(
        "job-portal",
      ),
    ).not.toBeInTheDocument();
  });
});


it("keeps workers out of chat navigation and routes nested cross-project approval to the root", async () => {
  const user = userEvent.setup();
  h.projects = [project("p-live", "job-portal"), project("p-worker", "worker-project")];
  h.sessions = [view("root1111", "p-live"),view("child2222", "p-worker"),view("nested3333", "p-worker"),view("chat4444", "p-live")];
  h.peers.origins = {child2222:"root1111",nested3333:"child2222",chat4444:"root1111"};
  h.peers.subagents = {child2222:"root1111",nested3333:"child2222"};
  await mountApp();
  await selectHistory(user,"root1111");
  const navigation = within(screen.getByRole("navigation",{name:"Projects"}));
  expect(navigation.queryByRole("button",{name:"Session ld2222"})).toBeNull();
  expect(navigation.queryByRole("button",{name:"Session ed3333"})).toBeNull();
  expect(navigation.getByRole("button",{name:"Session at4444"})).toBeVisible();
  const store=await import('./feedStore');
  await act(async()=>store.seedApprovals([{session_id:'nested3333',request_id:'permission',opened_at_ms:1,resolved:false,expired:false,kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'deploy preview',suggestions:[],tool_call_id:null}}]));
  expect(await screen.findByText('Subagent request · Subagent')).toBeVisible();
  expect(h.lastVisible()).toEqual(['p-live','p-worker']);
  await user.click(screen.getByRole('button',{name:'Allow'}));
  expect(h.responses).toEqual([['nested3333','permission',{type:'allow',updated_input:null,updated_permissions:[]},'root1111']]);
});

async function sendInitialPrompt(prompt = "Instant setup check") {
  const { composerWorkspaceApi } = await import("./composerWorkspaceApi");
  vi.spyOn(composerWorkspaceApi, "options").mockResolvedValue({isGit:true,currentBranch:"main",branches:[{name:"main",remote:false}],worktrees:[]});
  const catalog = await import("./providerCatalog");
  vi.spyOn(catalog, "useProviderCatalog").mockReturnValue({providers:[{id:"codex",instanceId:"codex:test",label:"Codex",version:null,models:[],modelCatalogKnown:false,efforts:[]}], error: "", loaded: true});
  await mountApp();
  const { pasteComposer } = await import("./test/composer");
  await pasteComposer(await screen.findByRole("textbox", {name:"Message"}), prompt);
  await userEvent.click(screen.getByRole("button", {name:"Send"}));
}
it("opens the task and authored message before startup resolves, then replaces the pending task", async () => {
  let resolve!: (result:SessionView) => void;
  h.start.mockImplementation(() => new Promise(done => {resolve=done;}));
  await sendInitialPrompt();
  expect(h.start).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", {name:"Show conversation"})).toHaveTextContent("Instant setup check");
  expect(document.querySelector(".startup-message")).toHaveTextContent("Instant setup check");
  expect(screen.getByText("Setting up your task…")).toBeVisible();
  expect(screen.getByRole("textbox", {name:"Message"})).toHaveAttribute("contenteditable", "false");
  await act(async () => h.start.mock.calls[0]![1]({step:"workspace",complete:true,detail:"Using workspace: /repo/worktree"}));
  await userEvent.click(screen.getByText("Setting up your task…"));
  expect(screen.getByText(/Using workspace: \/repo\/worktree/)).toBeVisible();
  await act(async () => resolve(view("created", "p-live")));
  expect(screen.getByRole("button", {name:"Show conversation"})).toHaveTextContent("Instant setup check");
  expect(screen.queryByText("Setting up your task…")).toBeNull();
  await act(async () => h.start.mock.calls[0]![1]({step:"workspace",complete:false,detail:"Late progress"}));
  expect(screen.queryByText("Setting up your task…")).toBeNull();
  expect(screen.queryByText("Late progress")).toBeNull();
  expect(localStorage.getItem("brigadier:startup:created")).toContain("Using workspace: /repo/worktree");
});
it("keeps a failed initial prompt and retries the same request identity", async () => {
  h.start.mockRejectedValueOnce(new Error("Provider failed to start"));
  await sendInitialPrompt("Retry startup check");
  expect(await screen.findByRole("alert")).toHaveTextContent("Provider failed to start");
  expect(document.querySelector(".startup-message")).toHaveTextContent("Retry startup check");
  h.start.mockImplementation(() => new Promise(() => {}));
  await userEvent.click(screen.getByRole("button", {name:"Retry setup"}));
  expect(h.start).toHaveBeenCalledTimes(2);
  expect(h.start.mock.calls[1]![0]).toEqual(h.start.mock.calls[0]![0]);
  expect(screen.queryByRole("button", {name:"Retry setup"})).toBeNull();
});
it("does not navigate back when startup completes after the user selected another task", async () => {
  h.sessions = [view("existing", "p-live")];
  let resolve!: (result:SessionView) => void;
  h.start.mockImplementation(() => new Promise(done => {resolve=done;}));
  await sendInitialPrompt("Background startup check");
  await userEvent.click(screen.getByRole("button", {name:"Session isting"}));
  await act(async () => resolve(view("created", "p-live")));
  expect(screen.getByRole("button", {name:"Show conversation"})).toHaveTextContent("Session isting");
});

/*
 * The sidebar's own splitter — `LayoutResizer` mounted from `App.tsx` as a sibling of the
 * sidebar, because the shell element belongs to `components/controls/sidebar.tsx`.
 * `src/components/LayoutResizer.test.tsx` pins the gesture; what only the shell can pin is
 * where the width lands and what a drag past the minimum does. `localStorage` is not cleared
 * between tests in this file, so both keys are set explicitly.
 */
describe("resizing the sidebar", () => {
  const shellWidth = () =>
    document
      .querySelector<HTMLElement>(".app-shell")
      ?.style.getPropertyValue("--sidebar-width");
  beforeEach(() => {
    localStorage.removeItem("brigadier:sidebar-width");
    localStorage.setItem("brigadier:sidebar-open", "true");
  });

  it("publishes the width on the shell and stores a nudge", async () => {
    await mountApp();
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuemin", "240");
    expect(handle).toHaveAttribute("aria-valuenow", "275");
    expect(shellWidth()).toBe("275px");
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowRight" });
    });
    expect(localStorage.getItem("brigadier:sidebar-width")).toBe("299");
    expect(shellWidth()).toBe("299px");
  });

  it("collapses rather than clamping when a nudge crosses the minimum", async () => {
    localStorage.setItem("brigadier:sidebar-width", "245");
    await mountApp();
    await act(async () => {
      fireEvent.keyDown(
        screen.getByRole("separator", { name: "Resize sidebar" }),
        { key: "ArrowLeft" },
      );
    });
    expect(localStorage.getItem("brigadier:sidebar-open")).toBe("false");
    // The stored width goes back to the default, so reopening is not a 1px sliver.
    expect(localStorage.getItem("brigadier:sidebar-width")).toBe("275");
  });
});

/*
 * A **global** new chat — the sidebar button or ⌘N, both of which
 * arrive as `brigadier-new-chat` — starts with no project picked. Only the shell can pin this:
 * the state is `App`'s, and what makes it hard to hold is the missing-project effect, which
 * exists precisely to force `selectedProjectId` back to `projects[0]`.
 */
describe("a global new chat", () => {
  const navigation = () =>
    within(screen.getByRole("navigation", { name: "Projects" }));
  const welcomeHeading = () =>
    screen.findByRole("heading", {
      name: "Chat with Brigadier",
    });

  beforeEach(() => {
    h.projects = [
      project("p-live", "job-portal"),
      project("p-two", "design-system"),
    ];
  });

  it("picks no project, and the first pick leaves the state", async () => {
    const user = userEvent.setup();
    await mountApp();
    expect(navigation().getByRole("button", { name: "job-portal" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await act(async () => {
      window.dispatchEvent(new Event("brigadier-new-chat"));
    });

    // The welcome screen, not the project greeting; and `projects[0]` was NOT re-selected.
    expect(await welcomeHeading()).toBeVisible();
    expect(
      navigation().getByRole("button", { name: "job-portal" }),
    ).not.toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Project" })).toHaveTextContent(
      "Choose project",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "design-system" }));

    expect(
      screen.queryByText("Chat with Brigadier"),
    ).toBeNull();
    expect(
      navigation().getByRole("button", { name: "design-system" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("focuses the composer when asked twice", async () => {
    const user = userEvent.setup();
    await mountApp();
    await act(async () => {
      window.dispatchEvent(new Event("brigadier-new-chat"));
    });
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
    expect(screen.queryByRole("listbox", { name: "Project" })).toBeNull();
  });

  it("keeps the project-scoped new chat on its own project", async () => {
    const user = userEvent.setup();
    await mountApp();
    await act(async () => {
      window.dispatchEvent(new Event("brigadier-new-chat"));
    });
    expect(await welcomeHeading()).toBeVisible();
    await user.click(
      navigation().getByRole("button", { name: "New session in design-system" }),
    );
    expect(
      screen.queryByText("Chat with Brigadier"),
    ).toBeNull();
    expect(
      navigation().getByRole("button", { name: "design-system" }),
    ).toHaveAttribute("aria-current", "page");
  });
});


describe("projectless chat creation", () => {
  it("starts a chat with no imported projects and lists it under Chats without a setup rail", async () => {
    h.projects = [];
    h.start.mockResolvedValue({ ...view("chat-one", "tasks"), cwd: "/tmp/chats/chat-one", worktree_path: null, branch: null });
    const { App } = await import("./App");
    render(<App />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute("contenteditable", "true"));
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(screen.getByRole("button", { name: "Project" })).toHaveTextContent("Choose project");
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    await pasteComposer(input, "Help me think through an idea");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "tasks", prompt: "Help me think through an idea", isolated: false }), expect.any(Function)));
    const args = h.start.mock.calls[0][0];
    expect(args.baseBranch).toBeUndefined();
    expect(args.newBranch).toBeUndefined();
    expect(args.workspacePath).toBeUndefined();
    const chats = await screen.findByRole("navigation", { name: "Chats" });
    expect(within(chats).getByRole("button", { name: "Help me think through an idea" })).toBeVisible();
    expect(within(screen.getByRole("navigation", { name: "Projects" })).queryByRole("button", { name: "Tasks" })).toBeNull();
    expect(screen.queryByLabelText("Task workspace")).toBeNull();
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
  });
});

/* ------------------------------------------------- P4b: the shell's subscriptions */

/**
 * The shell subscribes to five projections of the feed snapshot rather than to the snapshot
 * (`docs/plans/efficiency-plan-review-2026-09-11.md`, "Three whole-snapshot subscribers"), and
 * builds `Sidebar`'s `titles`/`sessions`/`order` in memos rather than as JSX literals.
 *
 * What is asserted here is identity, not pixels. `Sidebar` is memoised by its own owner; a memo is
 * worth nothing unless the props it compares are stable, and nothing in the rendered output would
 * show that they are not.
 */
describe("the shell's store subscriptions", () => {
  /** One drain frame with jsdom's real `requestAnimationFrame`, plus margin. */
  const frame = () => new Promise<void>((done) => setTimeout(done, 40));

  let seq = 0;
  function envelope(sessionId: string, event: unknown, at = 1_700_000_000_000) {
    seq += 1;
    return { seq, at, instance_id: "inst-1", session_id: sessionId, event };
  }
  const feedBatch = (parts: Record<string, unknown>) => ({
    project_id: "p-live",
    rows: [],
    signals: [],
    counters: [],
    ...parts,
  });
  const started = (model = "claude-sonnet-4-5") => ({
    type: "session-started",
    provider_session_id: "prov-1",
    model,
    cwd: "/repos/job-portal",
    capabilities: [],
    resume_token: null,
  });
  const opened = (requestId: string) => ({
    type: "request-opened",
    request_id: requestId,
    turn_id: "t1",
    kind: { type: "tool-permission", tool_name: "Edit", input_excerpt: "{}", suggestions: [], tool_call_id: null },
  });

  const lastProps = () => h.sidebarProps[h.sidebarProps.length - 1]!;

  it("leaves every derived sidebar prop identical when an unrelated session's rows arrive", async () => {
    h.sessions = [view("aaaa1111", "p-live"), view("bbbb2222", "p-live")];
    await mountApp();
    const store = await import("./feedStore");
    const before = lastProps();

    // Rows are not in the snapshot at all, so this frame must not reach the shell.
    await act(async () => {
      store.pushBatch(feedBatch({ rows: [row("bbbb2222", 1), row("bbbb2222", 2)] }) as never);
      await frame();
    });

    const after = lastProps();
    expect(after.titles).toBe(before.titles);
    expect(after.sessions).toBe(before.sessions);
    expect(after.order).toBe(before.order);
    expect(after.pendingApprovals).toBe(before.pendingApprovals);
    // The three that used to be rebuilt in the JSX on every render: an inline arrow, a fresh
    // `<Burn/>` element (which made the memo inert in every dev and `VITE_BURN` build, i.e. every
    // build a burn is captured on), and `peers.subagents ?? {}`.
    expect(after.onSelectProject).toBe(before.onSelectProject);
    expect(after.dev).toBe(before.dev);
    expect(after.origins).toBe(before.origins);
  });

  it("does not re-render the memoised sidebar at all when an unrelated session's rows arrive", async () => {
    h.sessions = [view("aaaa1111", "p-live"), view("bbbb2222", "p-live")];
    await mountApp();
    await act(async () => {});
    const renders = probe.renders;
    const wrapperRenders = h.sidebarProps.length;
    // The probe is alive: a dead one would make the assertion below vacuous.
    expect(renders).toBeGreaterThan(0);

    await act(async () => {
      const store = await import("./feedStore");
      store.pushBatch(feedBatch({ rows: [row("bbbb2222", 1), row("bbbb2222", 2)] }) as never);
      await frame();
    });

    // Neither the memo nor the wrapper outside it: the shell is not woken by a rows-only frame at
    // all now that it selects `sessions`/`order`/`approvals` instead of the whole snapshot.
    expect(probe.renders).toBe(renders);
    expect(h.sidebarProps.length).toBe(wrapperRenders);
  });

  it("still re-renders the sidebar when one of its props really moves", async () => {
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();
    const store = await import("./feedStore");
    await act(async () => {});
    const renders = probe.renders;

    await act(async () => {
      store.pushBatch(feedBatch({ signals: [envelope("cccc3333", started(), 1_700_000_009_000)] }) as never);
      await frame();
    });

    expect(probe.renders).toBeGreaterThan(renders);
  });

  it("keeps titles and order identical when an unrelated session's `busy` flips", async () => {
    h.sessions = [view("aaaa1111", "p-live"), view("bbbb2222", "p-live")];
    await mountApp();
    const store = await import("./feedStore");
    const before = lastProps();

    await act(async () => {
      store.pushBatch(feedBatch({ signals: [envelope("bbbb2222", { type: "turn-started", turn_id: "t1" })] }) as never);
      await frame();
    });

    const after = lastProps();
    // The shell did re-render — so the identity assertions below are about the memos holding, not
    // about the sidebar never being asked.
    expect(after).not.toBe(before);
    // The one prop that genuinely moved moves; nothing else does.
    expect(after.sessions).not.toBe(before.sessions);
    expect((after.sessions as Record<string, { busy: boolean }>)["bbbb2222"]!.busy).toBe(true);
    expect((after.sessions as Record<string, unknown>)["aaaa1111"]).toBe(
      (before.sessions as Record<string, unknown>)["aaaa1111"],
    );
    expect(after.titles).toBe(before.titles);
    expect(after.order).toBe(before.order);
    expect(after.onSelectProject).toBe(before.onSelectProject);
    expect(after.dev).toBe(before.dev);
    expect(after.origins).toBe(before.origins);
  });

  it("hands the sidebar one frozen `origins` object while the peer snapshot has no subagents", async () => {
    // `peers.subagents` is undefined until `peer_snapshot` answers — the first seconds after
    // launch, which is the window `Sidebar`'s memo exists for. `?? {}` made that a fresh object
    // every render and the memo could never skip through it.
    h.peers = { ...h.peers, subagents: undefined };
    h.sessions = [view("aaaa1111", "p-live"), view("bbbb2222", "p-live")];
    await mountApp();
    const store = await import("./feedStore");
    const before = lastProps();
    expect(before.origins).toEqual({});
    expect(Object.isFrozen(before.origins)).toBe(true);

    await act(async () => {
      store.pushBatch(feedBatch({ signals: [envelope("bbbb2222", { type: "turn-started", turn_id: "t1" })] }) as never);
      await frame();
    });

    const after = lastProps();
    expect(after).not.toBe(before);
    expect(after.origins).toBe(before.origins);
  });

  it("passes a real order change through to the sidebar", async () => {
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();
    const store = await import("./feedStore");
    const before = lastProps();

    await act(async () => {
      store.pushBatch(feedBatch({ signals: [envelope("cccc3333", started(), 1_700_000_009_000)] }) as never);
      await frame();
    });

    const after = lastProps();
    expect(after.order).not.toBe(before.order);
    expect(after.order).toEqual(["cccc3333", "aaaa1111"]);
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", {
        name: "Session cc3333",
      }),
    ).toBeVisible();
  });

  it("delivers a new approval on the frame it opens, clears it on request-resolved, and keeps a resolved-without-decision row as Expired", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();
    await selectHistory(user, "aaaa1111");
    const store = await import("./feedStore");
    const pendingTotal = () => lastProps().pendingTotal as number;
    expect(pendingTotal()).toBe(0);

    // Approvals are never optimistic (`docs/vision.md` §9): the card is on screen because the
    // store said so, on the frame the signal landed.
    await act(async () => {
      store.pushBatch(feedBatch({ signals: [envelope("aaaa1111", opened("r1"))] }) as never);
      await frame();
    });
    expect(pendingTotal()).toBe(1);
    expect(await screen.findByRole("button", { name: "Allow" })).toBeVisible();

    // And it clears only on `request-resolved`.
    await act(async () => {
      store.pushBatch(feedBatch({
        signals: [envelope("aaaa1111", {
          type: "request-resolved",
          request_id: "r1",
          decision: { type: "allow", updated_input: null, updated_permissions: [] },
        })],
      }) as never);
      await frame();
    });
    await waitFor(() => expect(pendingTotal()).toBe(0));
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();

    // The third state: resolved with no decision comes back from `pending_approvals` as
    // `expired: true`. The shell still counts and draws it; it is read-only, not absent.
    await act(async () => {
      store.seedApprovals([{
        session_id: "aaaa1111",
        request_id: "r2",
        opened_at_ms: 1_700_000_000_000,
        resolved: false,
        expired: true,
        kind: { type: "tool-permission", tool_name: "Edit", input_excerpt: "{}", suggestions: [], tool_call_id: null },
      }]);
    });
    await waitFor(() => expect(pendingTotal()).toBe(1));
    expect(await screen.findByText(/no longer answerable/)).toBeVisible();
  });
});

/**
 * `useFeedSelector`'s two caches — the `getSnapshot` one `useSyncExternalStore` requires, and the
 * `subscribeTo` registration that keeps React out of the loop entirely on a frame the selection
 * held still.
 */
describe("useFeedSelector", () => {
  /** Derived on purpose: a pass-through selector would satisfy the caching rule by accident. */
  const selectIds = (s: import("./feedStore").StoreState) => Object.keys(s.sessions);
  const selectApprovals = (s: import("./feedStore").StoreState) => s.approvals;

  const approval = (requestId: string) => ({
    session_id: "aaaa1111",
    request_id: requestId,
    opened_at_ms: 1_700_000_000_000,
    resolved: false,
    expired: false,
    kind: { type: "tool-permission" as const, tool_name: "Edit", input_excerpt: "{}", suggestions: [], tool_call_id: null },
  });

  it("returns the identical value across reads with no store change", async () => {
    const store = await import("./feedStore");
    store.seedSessions([view("aaaa1111", "p-live")]);
    const { result, rerender } = renderHook(() => store.useFeedSelector(selectIds));
    const first = result.current;
    expect(first).toEqual(["aaaa1111"]);
    // A second render with nothing moved: `getSnapshot` must hand back the identical array, which
    // is also why React did not throw its "result of getSnapshot should be cached" loop guard.
    rerender();
    expect(result.current).toBe(first);
  });

  it("does not render on a frame its selection held still, and disposes its listener on unmount", async () => {
    const store = await import("./feedStore");
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders += 1;
      return store.useFeedSelector(selectApprovals);
    });
    const baseline = renders;

    // A session arriving rebuilds the snapshot and notifies; the approvals selection does not move.
    await act(async () => {
      store.seedSessions([view("aaaa1111", "p-live")]);
    });
    expect(renders).toBe(baseline);

    await act(async () => {
      store.seedApprovals([approval("r1")]);
    });
    expect(renders).toBe(baseline + 1);
    expect(result.current.map((a) => a.requestId)).toEqual(["r1"]);

    unmount();
    await act(async () => {
      store.seedApprovals([approval("r2")]);
    });
    expect(renders).toBe(baseline + 1);
  });
});
