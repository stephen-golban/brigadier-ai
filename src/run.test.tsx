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
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { IntentSettlement, IntentView, PhaseView, RunView } from "./wire";

/* --------------------------------------------------------------- fixtures */

const h = vi.hoisted(() => ({
  projects: [] as Array<{
    id: string;
    name: string;
    root_path: string;
    created_at_ms: number;
  }>,
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
        if (view.plan_id === planId)
          h.runs[id] = { ...view, status: "abandoned" };
      }
    },
    async unsettledIntents() {
      return h.intents;
    },
    async settleIntent(intentId: string, state: IntentSettlement) {
      h.settled.push({ intentId, state });
      h.intents = h.intents.filter(
        (i) => (i as IntentView).intent_id !== intentId,
      );
    },
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

describe("automation history stays out of chat", () => {
  it("keeps pending phases collapsed until the user opens history", async () => {
    h.runs["p-live"] = run({ status: "abandoned" });
    await mountApp();
    const history = await screen.findByText("Automation history");
    expect(history.closest("button")).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "the run" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Stop automation")).not.toBeInTheDocument();
    await userEvent.click(history);
    expect(screen.getByRole("region", { name: "the run" })).toBeVisible();
    expect(h.started).toEqual([]);
  });
  it("keeps a stop action for a real live automation without replacing chat", async () => {
    h.runs["p-live"] = run();
    await mountApp();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop automation" }),
    );
    expect(h.stopped).toEqual(["pl-1"]);
    await userEvent.click(
      screen.getAllByRole("button", { name: "New session" })[0]!,
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });
  it("shows no automation history for a new project", async () => {
    await mountApp();
    expect(screen.queryByText("Automation history")).not.toBeInTheDocument();
  });
  it("does not display another project's unsettled intents", async () => {
    h.intents = [intent({ project_id: "other" })];
    await mountApp();
    expect(screen.queryByText("Automation history")).not.toBeInTheDocument();
  });
});
