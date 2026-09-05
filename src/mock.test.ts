/**
 * The mock bridge's run engine: `src/mock.ts` §runs.
 *
 * **Why this file exists.** The Rust commands behind `docs/plans/ipc-contract.md` §"The run" do
 * not exist yet, so the mock is the only thing the front end can be exercised against — and a
 * mock that answered a static object would prove nothing about a card whose whole job is to
 * update in place as phases complete. What is pinned here is that it *moves*, and that it moves
 * through every state the card has to draw:
 *
 *   - `pending → running → green` on a passing gate;
 *   - a gate that **fails** (`last_exit_code: 1`) and a phase that then **blocks**;
 *   - a phase whose `verify_command` is **null**, which never moves at all;
 *   - a work order left at **`state: "unknown"`**, and the two `unsettled_intents` rows that
 *     follow from it — one of which carries a `kind` slug this build does not know.
 *
 * The engine is a pure function of elapsed wall-clock time, which is exactly why it can be tested
 * this way: `vi.setSystemTime` is the whole of the fixture.
 *
 * **Nothing here spawns a `claude` process, calls a model or spends anything.** The mock has no
 * subprocess of any kind; every string below is synthetic.
 *
 * `globals: false`, so every helper is imported; `vi.resetModules()` before each test because the
 * mock's `runs` map is a module singleton.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bridge } from "./bridge";
import type { PhaseView, RunView } from "./wire";

const T0 = 1_700_000_000_000;
const PROJECT = "p-brigadier";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

async function fresh(): Promise<Bridge> {
  return (await import("./mock")).mockBridge;
}

/** Move the run's clock. The engine reads `Date.now()` and nothing else. */
function at(ms: number): void {
  vi.setSystemTime(T0 + ms);
}

function states(run: RunView): string[] {
  return run.phases.map((p) => p.state);
}

function phase(run: RunView, ordinal: number): PhaseView {
  const p = run.phases.find((x) => x.ordinal === ordinal);
  if (p === undefined) throw new Error(`no phase ${ordinal}`);
  return p;
}

async function live(b: Bridge): Promise<RunView> {
  const run = await b.currentRun(PROJECT);
  if (run === null) throw new Error("no current run");
  return run;
}

/* ------------------------------------------------------------------ tests */

describe("start_run", () => {
  it("answers a draft plan whose phases have not started", async () => {
    const b = await fresh();
    const run = await b.startRun(PROJECT, "Make the store durable across a crash");

    expect(run.goal).toBe("Make the store durable across a crash");
    expect(run.status).toBe("draft");
    expect(run.approved_at_ms).toBeNull();
    expect(run.phases.length).toBeGreaterThan(3);
    expect(states(run).every((s) => s === "pending")).toBe(true);
  });

  it("refuses an empty goal and a project that does not exist", async () => {
    const b = await fresh();
    await expect(b.startRun(PROJECT, "   ")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(b.startRun("p-nope", "anything")).rejects.toMatchObject({
      code: "no_such_project",
    });
  });

  it("refuses a second run while one is live", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "first");
    at(3000);
    await expect(b.startRun(PROJECT, "second")).rejects.toMatchObject({
      code: "run_already_live",
    });
  });

  it("has no current run before one is started", async () => {
    const b = await fresh();
    expect(await b.currentRun(PROJECT)).toBeNull();
  });
});

describe("the plan moves", () => {
  it("advances a phase through pending, running and green", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");

    expect(phase(await live(b), 1).state).toBe("pending");

    at(1500);
    const approved = await live(b);
    expect(approved.status).toBe("approved");
    expect(approved.approved_at_ms).not.toBeNull();
    expect(phase(approved, 1).state).toBe("running");
    expect(phase(approved, 1).last_exit_code).toBeNull();

    at(2500);
    const green = phase(await live(b), 1);
    expect(green.state).toBe("green");
    expect(green.last_exit_code).toBe(0);
    expect(green.commit_sha).not.toBeNull();

    at(3700);
    expect(phase(await live(b), 2).state).toBe("green");
  });

  it("fails one phase's gate and then blocks it", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");

    at(4300);
    const red = phase(await live(b), 3);
    // Still running, and already red: the gate ran and answered non-zero.
    expect(red.state).toBe("running");
    expect(red.last_exit_code).toBe(1);
    expect(red.attempts).toBe(1);

    at(5000);
    const blocked = phase(await live(b), 3);
    expect(blocked.state).toBe("blocked");
    expect(blocked.last_exit_code).toBe(1);
    expect(blocked.attempts).toBe(2);
    expect(blocked.commit_sha).toBeNull();
  });

  it("leaves the phase with no verify command ungated, and it never moves", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");

    for (const ms of [0, 2500, 5000, 60_000]) {
      at(ms);
      const p = phase(await live(b), 4);
      expect(p.verify_command).toBeNull();
      // It cannot go green through a gate, so it does not go green.
      expect(p.state).toBe("pending");
      expect(p.last_exit_code).toBeNull();
    }
  });

  it("ends one work order at unknown, which blocks its phase", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");

    at(5000);
    const before = phase(await live(b), 5);
    expect(before.state).toBe("running");
    expect(before.orders.map((o) => o.state)).not.toContain("unknown");

    at(6000);
    const after = phase(await live(b), 5);
    expect(after.state).toBe("blocked");
    expect(after.orders.map((o) => o.state)).toContain("unknown");
  });
});

describe("unsettled_intents", () => {
  it("is empty until something cannot be accounted for", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(5000);
    expect(await b.unsettledIntents()).toEqual([]);
  });

  it("lists the unknown work order and a kind this build does not know", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(6000);

    const list = await b.unsettledIntents();
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.kind)).toEqual(["work_order", "db_migrate"]);
    // Oldest first, as the contract says.
    expect(list[0]!.opened_at_ms).toBeLessThanOrEqual(list[1]!.opened_at_ms);
    // Every row is unsettled by definition; that is what the list is.
    expect(list.every((i) => i.state === "unknown")).toBe(true);
  });

  it("drops the one the owner settled and leaves the other", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(6000);

    await b.settleIntent("in-work-order", "not_done");
    const left = await b.unsettledIntents();
    expect(left.map((i) => i.intent_id)).toEqual(["in-db-migrate"]);

    await b.settleIntent("in-db-migrate", "done");
    expect(await b.unsettledIntents()).toEqual([]);
  });

  it("refuses an intent it has never heard of", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(6000);
    await expect(b.settleIntent("in-nope", "done")).rejects.toMatchObject({
      code: "no_such_intent",
    });
  });
});

describe("stop_run", () => {
  it("stops the plan advancing and leaves every phase where it was", async () => {
    const b = await fresh();
    const started = await b.startRun(PROJECT, "goal");

    at(2500);
    const before = states(await live(b));

    await b.stopRun(started.plan_id);
    at(60_000);

    const after = await live(b);
    // Not one phase moved after the stop: that is what "stops dispatching" means here.
    expect(states(after)).toEqual(before);
    expect(after.status).toBe("abandoned");
  });

  it("refuses a plan id it does not have", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    await expect(b.stopRun("pl-nope")).rejects.toMatchObject({ code: "no_such_plan" });
  });

  it("lets a new run start once the last one is stopped", async () => {
    const b = await fresh();
    const first = await b.startRun(PROJECT, "first");
    await b.stopRun(first.plan_id);
    const second = await b.startRun(PROJECT, "second");
    expect(second.goal).toBe("second");
    expect(second.plan_id).not.toBe(first.plan_id);
  });
});

describe("what the wire never carries", () => {
  it("has no dollar figure in any run shape", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(6000);

    const json = JSON.stringify([await b.currentRun(PROJECT), await b.unsettledIntents()]);
    // `docs/vision.md` §6: the owner is never billed per token, so a dollar figure would be a lie
    // in his own favour. No field above may carry one.
    expect(json).not.toMatch(/usd|dollar|\$/i);
  });

  it("has no log tail: last_evidence is one short line", async () => {
    const b = await fresh();
    await b.startRun(PROJECT, "goal");
    at(6000);

    for (const p of (await live(b)).phases) {
      if (p.last_evidence === null) continue;
      expect(p.last_evidence).not.toContain("\n");
      expect(p.last_evidence.length).toBeLessThan(120);
    }
  });
});

/*
 * `delete_session` and `delete_project` on the mock bridge — R4.2.
 *
 * The mock is where the **refusal** path is exercised, because it is the branch a happy-path fake
 * never reaches and the one the front end can get silently wrong: `removed: false` resolves as a
 * success from `invoke`, so a UI that only ever saw a clean delete would look correct in every
 * test and be wrong in the window. The mock therefore refuses every un-forced delete of a live
 * checkout, which makes that branch the default one `npm run dev` walks into.
 *
 * Nothing here touches a disk, spawns a process or spends anything.
 */
describe("deleting, on the mock bridge", () => {
  /** The mock seeds one running session under `p-brigadier` on the first `subscribeFeed`. */
  async function seeded(): Promise<{ b: Bridge; sessionId: string }> {
    const b = await fresh();
    await b.subscribeFeed(() => {});
    const sessions = await b.listSessions();
    const first = sessions[0];
    if (first === undefined) throw new Error("the mock seeded no sessions");
    return { b, sessionId: first.session_id };
  }

  it("deletes a live session on the first call, keeping its worktree", async () => {
    const { b, sessionId } = await seeded();
    const done = await b.deleteSession(sessionId, false);
    expect(done.removed).toBe(true);
    expect(done.worktree).toBeNull();
    expect(done.branch).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await b.listSessions()).map(s => s.session_id)).not.toContain(sessionId);
  });
  it("removes a project with live sessions and its saved run", async () => {
    const { b, sessionId } = await seeded();
    await b.startRun(PROJECT, "saved automation");
    const done = await b.deleteProject(PROJECT, false);
    expect(done.removed).toBe(true);
    expect(done.worktrees).toEqual([]);
    expect(done.brigadier_dir_removed).toBe(false);
    expect((await b.listProjects()).map(p => p.id)).not.toContain(PROJECT);
    expect((await b.listSessions()).map(s => s.session_id)).not.toContain(sessionId);
    expect(await b.currentRun(PROJECT)).toBeNull();
  });

  it("refuses an unknown id rather than answering for nothing", async () => {
    const b = await fresh();
    await expect(b.deleteSession("s-nope", false)).rejects.toMatchObject({
      code: "no_such_session",
    });
    await expect(b.deleteProject("p-nope", false)).rejects.toMatchObject({
      code: "no_such_project",
    });
  });
});
