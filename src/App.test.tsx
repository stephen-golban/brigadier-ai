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
 * Mechanics, matching `src/feedStore.test.ts` and `src/providers/ThemeProvider.test.tsx`:
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
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ZERO_USAGE } from "./wire";
import type { FeedRowWire, SessionStatus, SessionView } from "./wire";

/* --------------------------------------------------------------- fixtures */

/** Shared with the hoisted `vi.mock` factories below; reset in `beforeEach`. */
const h = vi.hoisted(() => ({
  projects: [] as Array<{
    id: string;
    name: string;
    root_path: string;
    created_at_ms: number;
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
  /** Every `delete_session` / `delete_project` call, in order, with the `force` it carried. */
  deletes: [] as Array<{
    kind: "session" | "project";
    id: string;
    force: boolean;
  }>,
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
    async startSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async sendTurn() {
      return { turn_id: "t" };
    },
    async respond() {},
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
    // commands answer "there has never been a run here": `src/run.test.tsx` is what exercises
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

beforeEach(() => {
  vi.resetModules();
  h.projects = [project("p-live", "job-portal")];
  h.visible = [];
  h.sessions = [];
  h.initialData = null;
  h.tailRows = {};
  h.hold = false;
  h.parked = [];
  h.spans = [];
  h.isMock = true;
  h.picked = null;
  h.added = [];
  h.deletes = [];
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
    expect(within(thread).getAllByText("brigadier-ai").length).toBeGreaterThan(
      0,
    );

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
    expect(await screen.findByText("Add a project to get started.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("button", { name: "Project actions job-portal" })).toBeVisible();
    expect(h.lastVisible()).toEqual(["p-live"]);
    expect(screen.getAllByRole("button", { name: /^Session aa1111/ }).length).toBeGreaterThan(0);
    expect(h.projects).toHaveLength(1);
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
  it("requires confirmation and removes only the chosen history", async () => {
    const user = userEvent.setup();
    h.sessions = [
      view("aaaa1111", "p-live", "exited"),
      view("bbbb2222", "p-live", "exited"),
    ];
    await mountApp();
    await user.click(
      screen.getByRole("button", { name: "Archive Session aa1111" }),
    );
    await user.click(await screen.findByRole("button", { name: "History" }));
    await user.click(
      screen.getByRole("button", { name: "Delete, keep files" }),
    );
    expect(h.deletes).toHaveLength(0);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(h.deletes).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem("brigadier:session-archive:v1")!).deleted,
    ).toContain("aaaa1111");
    expect(
      screen.queryByRole("button", { name: /Session aa1111/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Session bb2222/ })[0],
    ).toBeVisible();
  });
  it("cancel leaves the history available", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live", "exited")];
    await mountApp();
    await user.click(
      screen.getByRole("button", { name: "Archive Session aa1111" }),
    );
    await user.click(await screen.findByRole("button", { name: "History" }));
    await user.click(
      screen.getByRole("button", { name: "Delete, keep files" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.deletes).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Session aa1111" }),
    ).toBeVisible();
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
