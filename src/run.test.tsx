/**
 * The run, end to end through the shell: `src/App.tsx` + `src/components/Composer.tsx`'s
 * `RunControl` + `src/components/RunCard.tsx`, against a fake bridge.
 *
 * The one sentence this surface serves (`docs/vision.md` §9): the owner points the app at a real
 * project, **hands it a task in plain English, and walks away** — watching it plan, dispatch, gate
 * and commit without reading a terminal. What is pinned here is the seam between that sentence
 * and `docs/plans/ipc-contract.md` §"The run":
 *
 *   - a goal typed on the dock reaches `start_run` with the selected project and the goal, and the
 *     plan it answers with is painted;
 *   - a project with a live run is **not** offered a second one — `start_run` refuses it with
 *     `run_already_live` — so the control becomes Stop;
 *   - Stop reaches `stop_run` with the plan id;
 *   - the plan card is **pinned**: above the feed in the thread column and outside the feed's
 *     scroller, so nothing the owner steers with can scroll away;
 *   - settling an intent reaches `settle_intent` with one of the two values it takes.
 *
 * **What this cannot prove, stated rather than left to be assumed:** the Rust commands do not
 * exist. Every answer below comes from a fake in this file, and nothing here has been clicked in a
 * real window. This is a test of the front end against the written contract, not of the harness.
 *
 * Mechanics match `src/App.test.tsx`: `globals: false`, a hoisted fixture bag shared with the
 * `vi.mock` factory, `vi.resetModules()` plus a per-test `await import("./App")` because
 * `feedStore` is a module singleton, and a hand-called `cleanup()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { IntentSettlement, IntentView, PhaseView, RunView } from "./wire";

/* --------------------------------------------------------------- fixtures */

const h = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string; root_path: string; created_at_ms: number }>,
  /** What `current_run` answers, per project id. */
  runs: {} as Record<string, unknown>,
  intents: [] as unknown[],
  /** Every `start_run` call, in order, with the picks that ride with it. */
  started: [] as Array<{
    projectId: string;
    goal: string;
    model: string | null;
    permissionMode: string | null;
  }>,
  stopped: [] as string[],
  settled: [] as Array<{ intentId: string; state: string }>,
}));

vi.mock("./paint", () => ({
  startPaintInstrumentation: () => {},
  INTERACTION_TIMEOUT_MS: 5000,
  beginInteraction: () => ({ painted: () => {}, cancel: () => {} }),
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  const fake = {
    isMock: true,
    async subscribeFeed() {},
    async setVisibleProjects() {},
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
    async pickDirectory() {
      return null;
    },
    async revealPath() {},
    async listSessions() {
      return [];
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
    async feedTail() {
      return [];
    },
    async pendingApprovals() {
      return [];
    },
    async startRun(
      projectId: string,
      goal: string,
      model: string | null = null,
      permissionMode: string | null = null,
    ) {
      h.started.push({ projectId, goal, model, permissionMode });
      const view = run({ project_id: projectId, goal });
      h.runs[projectId] = view;
      return view;
    },
    async currentRun(projectId: string) {
      return h.runs[projectId] ?? null;
    },
    async stopRun(planId: string) {
      h.stopped.push(planId);
      for (const [id, r] of Object.entries(h.runs)) {
        const view = r as RunView;
        if (view.plan_id === planId) h.runs[id] = { ...view, status: "abandoned" };
      }
    },
    async unsettledIntents() {
      return h.intents;
    },
    async settleIntent(intentId: string, state: IntentSettlement) {
      h.settled.push({ intentId, state });
      h.intents = h.intents.filter((i) => (i as IntentView).intent_id !== intentId);
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

function phase(over: Partial<PhaseView> = {}): PhaseView {
  return {
    phase_id: "ph-1",
    ordinal: 1,
    title: "Pin the intent tables",
    definition_of_done: "The tables exist.",
    verify_command: "cargo test",
    state: "running",
    attempts: 1,
    base_sha: null,
    commit_sha: null,
    last_exit_code: null,
    last_evidence: null,
    orders: [],
    ...over,
  };
}

function run(over: Partial<RunView> = {}): RunView {
  return {
    plan_id: "pl-1",
    project_id: "p-live",
    goal: "Make the store durable across a crash",
    status: "approved",
    revision: 2,
    created_at_ms: 1_700_000_000_000,
    approved_at_ms: 1_700_000_001_200,
    phases: [phase()],
    unknowns: [],
    ...over,
  };
}

function intent(over: Partial<IntentView> = {}): IntentView {
  return {
    intent_id: "in-1",
    kind: "work_order",
    state: "unknown",
    session_id: "s-1",
    project_id: "p-live",
    opened_at_ms: 1_700_000_005_600,
    subject: "/repos/job-portal/.brigadier/worktrees/bbbb2222",
    evidence: "1 commit and 3 dirty files above the dispatch baseline",
    ...over,
  };
}

/** Mount the app and wait for the mount effect's `Promise.all` to have landed. */
async function mountApp() {
  const { App } = await import("./App");
  const utils = render(<App />);
  await screen.findAllByText(h.projects[0]!.name);
  return utils;
}

beforeEach(() => {
  vi.resetModules();
  h.projects = [project("p-live", "job-portal")];
  h.runs = {};
  h.intents = [];
  h.started = [];
  h.stopped = [];
  h.settled = [];
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ tests */

describe("starting a run", () => {
  it("hands the selected project the goal the owner typed", async () => {
    const user = userEvent.setup();
    await mountApp();

    const field = screen.getByRole("textbox", { name: "the goal, in plain English" });
    await user.type(field, "Make the store durable across a crash");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Start run" }));
    });

    // The picks ride with the goal since R4.1. `model: null` is the untouched picker and is a
    // real choice: the harness's role-based routing stays in charge, so judgement takes the
    // provider's strong default and a work order takes its per-order tier. It must be `null` and
    // not a sentinel — `start_run`'s `model` is an `Option<String>` and a placeholder would be
    // handed straight to the CLI's `--model`, which refuses it.
    expect(h.started).toEqual([
      {
        projectId: "p-live",
        goal: "Make the store durable across a crash",
        model: null,
        permissionMode: "default",
      },
    ]);
    // …and the plan it answered with is painted without waiting for a poll.
    const card = await screen.findByRole("region", { name: "the run" });
    expect(within(card).getByText("Make the store durable across a crash")).toBeInTheDocument();
    expect(within(card).getByText("Pin the intent tables")).toBeInTheDocument();
  });

  /**
   * R4.1, end to end through the shell. `list_models` answers `[]` in this file's fake, so the
   * model picker has only its no-pick entry — which is the case worth pinning here anyway: what
   * `start_run` must never receive is a sentinel standing in for "no pick".
   */
  it("carries the permission mode the dock is showing", async () => {
    const user = userEvent.setup();
    await mountApp();

    await user.click(screen.getByRole("button", { name: /permissions/i }));
    await user.click(screen.getByRole("option", { name: /bypass/i }));
    await user.type(
      screen.getByRole("textbox", { name: "the goal, in plain English" }),
      "ship it",
    );
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Start run" }));
    });

    expect(h.started).toEqual([
      { projectId: "p-live", goal: "ship it", model: null, permissionMode: "bypass-permissions" },
    ]);
  });

  it("will not send an empty goal", async () => {
    const user = userEvent.setup();
    await mountApp();

    const start = screen.getByRole("button", { name: "Start run" });
    expect(start).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "the goal, in plain English" }), "   ");
    expect(start).toBeDisabled();
    expect(h.started).toEqual([]);
  });

  it("offers Stop instead of the goal field once a run is live", async () => {
    const user = userEvent.setup();
    h.runs = { "p-live": run() };
    await mountApp();

    // `start_run` refuses a second run with `run_already_live`, so offering the field again would
    // be offering a control whose only outcome is an error.
    await screen.findByRole("button", { name: "Stop run" });
    expect(
      screen.queryByRole("textbox", { name: "the goal, in plain English" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Stop run" }));
    });
    expect(h.stopped).toEqual(["pl-1"]);

    // A stopped run is not live, so the field comes back.
    expect(
      await screen.findByRole("textbox", { name: "the goal, in plain English" }),
    ).toBeInTheDocument();
  });

  it("offers no run control at all with no project selected", async () => {
    h.projects = [];
    const { App } = await import("./App");
    render(<App />);
    const field = await screen.findByRole("textbox", { name: "the goal, in plain English" });
    expect(field).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
  });
});

describe("the plan card is pinned", () => {
  /**
   * `docs/vision.md` §9: *"Nothing the owner steers with ever scrolls away."* That is geometry,
   * and in jsdom — which has no layout at all — the only honest way to state it is structural:
   * the card is inside the thread column, it comes **before** the feed, and it is **not inside the
   * feed's scrolling element**. A card inside that element would scroll with the rows however it
   * were styled.
   *
   * `.feed-scroller` is used here as a locator for another component, not as an assertion about
   * this one's styling — which is the line `Feed.test.tsx` draws. That the CSS then holds it in
   * place is **not** checked here and has not been seen in a real window.
   */
  it("sits in the thread column, above the feed and outside its scroller", async () => {
    h.runs = { "p-live": run() };
    const { container } = await mountApp();

    const card = await screen.findByRole("region", { name: "the run" });
    const main = screen.getByRole("main");
    const scroller = container.querySelector(".feed-scroller");

    expect(main.contains(card)).toBe(true);
    expect(scroller).not.toBeNull();
    expect(scroller!.contains(card)).toBe(false);
    // DOCUMENT_POSITION_FOLLOWING: the feed comes after the card.
    expect(card.compareDocumentPosition(scroller!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no card for a project that has never had a run", async () => {
    await mountApp();
    expect(screen.queryByRole("region", { name: "the run" })).not.toBeInTheDocument();
  });
});

describe("settling an intent from the card", () => {
  it("sends one of the two values settle_intent takes, and re-reads the list", async () => {
    const user = userEvent.setup();
    h.runs = { "p-live": run() };
    h.intents = [intent({ intent_id: "in-7" })];
    await mountApp();

    await act(async () => {
      await user.click(await screen.findByRole("button", { name: "Mark not done" }));
    });

    expect(h.settled).toEqual([{ intentId: "in-7", state: "not_done" }]);
    // The refetch after the settle is what takes the row off the card.
    await screen.findByRole("region", { name: "the run" });
    expect(screen.queryByRole("button", { name: "Mark not done" })).not.toBeInTheDocument();
  });

  it("shows an intent whose kind this build does not know", async () => {
    h.runs = { "p-live": run() };
    h.intents = [intent({ intent_id: "in-9", kind: "db_migrate" })];
    await mountApp();

    // A pass-through slug: rendered as itself rather than hidden or collapsed into a known one.
    expect(await screen.findByText("db_migrate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument();
  });
});
