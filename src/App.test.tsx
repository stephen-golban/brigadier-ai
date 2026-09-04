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
  projects: [] as Array<{ id: string; name: string; root_path: string; created_at_ms: number }>,
  sessions: [] as unknown[],
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
    isMock: true,
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
      return h.projects;
    },
    async addProject() {
      throw new Error("not used");
    },
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
    feedTail(sessionId: string) {
      if (h.hold) {
        return new Promise<unknown[]>((answer) => h.parked.push({ id: sessionId, answer }));
      }
      return Promise.resolve(h.tailRows[sessionId] ?? []);
    },
    async pendingApprovals() {
      return [];
    },
    async reportPaint() {},
    async recordFrameStats() {},
    async burn() {},
  };
  return { ...actual, bridge: () => fake };
});

function project(id: string, name: string) {
  return { id, name, root_path: `/repos/${name}`, created_at_ms: 1_700_000_000_000 };
}

function view(sessionId: string, projectId: string, status: SessionStatus = "running"): SessionView {
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
  return { s: sessionId, q, t: 1_700_000_000_000 + q, l: `line ${q}`, k: "sys" };
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
  h.tailRows = {};
  h.hold = false;
  h.parked = [];
  h.spans = [];
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ tests */

describe("the B4 paint span", () => {
  it("opens exactly one span, under the label the budget is filed under", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    await mountApp();

    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));

    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.label).toBe("b4-session-painted");
  });

  it("settles the span once the selected session's rows are in the store", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.tailRows = { aaaa1111: [row("aaaa1111", 1), row("aaaa1111", 2)] };
    await mountApp();

    await act(async () => {
      await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));
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
      await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));
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

    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));
    await user.click(await screen.findByRole("button", { name: /brigadier\/bbbb2222/ }));

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

    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));
    await user.click(screen.getByRole("button", { name: "New session" }));

    expect(h.spans).toHaveLength(1);
    expect(h.spans[0]!.cancelled).toBe(1);
    expect(h.spans[0]!.painted).toBe(0);
  });

  it("abandons a span in flight when the window goes away", async () => {
    const user = userEvent.setup();
    h.sessions = [view("aaaa1111", "p-live")];
    h.hold = true;
    await mountApp();

    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));
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
    expect(within(thread).getAllByText("brigadier-ai").length).toBeGreaterThan(0);

    await user.click(await screen.findByRole("button", { name: /brigadier\/bbbb2222/ }));

    // The thread column no longer names any project but the session's own.
    expect(within(thread).queryByText("brigadier-ai")).not.toBeInTheDocument();
    expect(within(thread).getAllByText("burn").length).toBeGreaterThan(0);
  });

  it("makes that project visible, so Rust actually sends its rows", async () => {
    const user = userEvent.setup();
    h.projects = [project("p-one", "brigadier-ai"), project("p-two", "burn")];
    h.sessions = [view("bbbb2222", "p-two")];
    await mountApp();

    expect(h.lastVisible()).toEqual(["p-one"]);

    await user.click(await screen.findByRole("button", { name: /brigadier\/bbbb2222/ }));

    // Without this the batcher drops every row for the session that was just opened.
    expect(h.lastVisible()).toEqual(["p-two"]);
  });

  it("leaves the project selection alone for a session the store cannot place", async () => {
    const user = userEvent.setup();
    h.projects = [project("p-one", "brigadier-ai")];
    h.sessions = [view("aaaa1111", "p-one")];
    await mountApp();

    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));

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
    await user.click(await screen.findByRole("button", { name: /brigadier\/aaaa1111/ }));

    expect(screen.getAllByRole("button", { name: /brigadier\// })).toHaveLength(1);
  });
});
