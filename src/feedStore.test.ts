/**
 * Characterisation tests for `src/feedStore.ts`.
 *
 * These pin **behaviour**, never markup: the store is styling-agnostic and does not move in the
 * frontend rewrite (`docs/plans/phase-4.md` §W4-A), so nothing here should need an edit
 * afterwards. Every assertion is on a value returned by an exported function.
 *
 * Two mechanics make it testable without touching production code
 * (`docs/research/frontend-stack.md` §1.2, §1.6):
 *
 *   - jsdom implements `requestAnimationFrame` as `setInterval(…, 1000/60)` and Vitest's default
 *     fake timers already fake both that and `performance.now()`, so `vi.advanceTimersByTime(17)`
 *     is exactly one drain frame. No `toFake` list: the default already covers it.
 *   - every piece of the store's state is module-level and there is no `reset()` export, so each
 *     test takes a fresh module with `vi.resetModules()` + `await import("./feedStore")`. A
 *     test-only `reset()` on the module would edit production code and would drift silently as
 *     state is added; the module system cannot drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Envelope,
  Event,
  FeedBatch,
  FeedRowWire,
  SessionId,
  SessionView,
  Usage,
} from "./wire";

type Store = typeof import("./feedStore");

/** One drain frame. jsdom's rAF period is 1000/60 ms, so 17 ms is one and only one. */
const FRAME_MS = 17;

const PROJECT = "p1";

let seq = 0;

async function load(): Promise<Store> {
  vi.resetModules();
  seq = 0;
  return await import("./feedStore");
}

function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    context_window: null,
  };
}

function row(s: SessionId, q: number, l = `line ${q}`): FeedRowWire {
  return { s, q, t: 1_000 + q, l };
}

function rows(s: SessionId, qs: readonly number[]): FeedRowWire[] {
  return qs.map((q) => row(s, q));
}

function batch(parts: Partial<FeedBatch> = {}): FeedBatch {
  return { project_id: PROJECT, rows: [], signals: [], counters: [], ...parts };
}

function env(sessionId: SessionId, event: Event, at = 1_000): Envelope {
  seq += 1;
  return { seq, at, instance_id: "inst-1", session_id: sessionId, event };
}

function turnCompleted(turnId: string, costCumulative: number, usage = zeroUsage()): Event {
  return {
    type: "turn-completed",
    turn_id: turnId,
    stop_reason: "end-turn",
    usage,
    cost_usd_cumulative: costCumulative,
  };
}

function view(over: Partial<SessionView> & { session_id: SessionId }): SessionView {
  return {
    project_id: PROJECT,
    instance_id: null,
    provider_session_id: null,
    cwd: null,
    worktree_path: null,
    branch: null,
    model: null,
    status: "running",
    started_at_ms: null,
    ended_at_ms: null,
    exit_code: null,
    last_event_seq: 0,
    usage: zeroUsage(),
    cost_usd_cumulative: 0,
    ...over,
  };
}

/** Establish a session's live ring through the real ingest path, not through `seedRows`. */
function pushRows(store: Store, sessionId: SessionId, qs: readonly number[]): void {
  store.pushBatch(batch({ rows: rows(sessionId, qs) }));
  vi.advanceTimersByTime(FRAME_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drops the pending rAF interval of whatever module instance this test loaded.
  vi.useRealTimers();
});

describe("the rAF drain", () => {
  it("coalesces every batch buffered in one frame into a single notification", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    store.pushBatch(batch({ rows: rows("s1", [2]) }));
    expect(notifies).toBe(0); // nothing happens until the frame

    vi.advanceTimersByTime(FRAME_MS);

    expect(notifies).toBe(1);
    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 2]);
    expect(store.getIngest()).toEqual({ rowsIn: 2, batches: 2 });
    store.stop();
  });

  it("notifies once per frame that carries work, and not at all on an idle frame", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(notifies).toBe(1);

    vi.advanceTimersByTime(FRAME_MS * 5); // five frames, no input
    expect(notifies).toBe(1);

    store.pushBatch(batch({ rows: rows("s1", [2]) }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(notifies).toBe(2);
    store.stop();
  });

  it("stops draining after stop()", async () => {
    const store = await load();
    store.start();
    store.stop();

    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS * 10);

    expect(store.getSessionRows("s1")).toHaveLength(0);
  });
});

describe("ROW_CAP", () => {
  it("is 2000 and trims a session ring from the head, keeping the newest rows", async () => {
    const store = await load();
    expect(store.ROW_CAP).toBe(2000);

    store.start();
    const qs = Array.from({ length: 2_300 }, (_, i) => i);
    store.pushBatch(batch({ rows: rows("s1", qs.slice(0, 1_500)) }));
    store.pushBatch(batch({ rows: rows("s1", qs.slice(1_500)) }));
    vi.advanceTimersByTime(FRAME_MS);

    const ring = store.getSessionRows("s1");
    expect(ring).toHaveLength(store.ROW_CAP);
    expect(ring[0]!.q).toBe(300); // 2300 - 2000
    expect(ring[ring.length - 1]!.q).toBe(2_299);
    store.stop();
  });

  it("trims the project ring from the head too", async () => {
    const store = await load();
    store.start();
    store.pushBatch(
      batch({ rows: rows("s1", Array.from({ length: 2_100 }, (_, i) => i)) }),
    );
    vi.advanceTimersByTime(FRAME_MS);

    const ring = store.getProjectRows(PROJECT);
    expect(ring).toHaveLength(store.ROW_CAP);
    expect(ring[0]!.q).toBe(100);
    store.stop();
  });
});

describe("seedRows — the two-pointer merge with the live ring", () => {
  it("fills an empty ring in seed order and notifies", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    store.seedRows("s1", rows("s1", [1, 2, 3]));

    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 2, 3]);
    expect(notifies).toBe(1);
  });

  it("puts a seed that is strictly older in front of the live rows", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [10, 11, 12]);

    store.seedRows("s1", rows("s1", [1, 2]));

    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 2, 10, 11, 12]);
    store.stop();
  });

  it("interleaves by q rather than appending", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [2, 4, 6]);

    store.seedRows("s1", rows("s1", [1, 3, 5, 7]));

    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    store.stop();
  });

  it("keeps the live row on a q collision — same (session, seq) is the same row", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: [row("s1", 5, "live")] }));
    vi.advanceTimersByTime(FRAME_MS);
    const liveRow = store.getSessionRows("s1")[0]!;

    store.seedRows("s1", [row("s1", 5, "seed"), row("s1", 6, "seed six")]);

    const ring = store.getSessionRows("s1");
    expect(ring.map((r) => r.l)).toEqual(["live", "seed six"]);
    expect(ring[0]).toBe(liveRow); // the existing object, untouched
    store.stop();
  });

  it("preserves the array reference and does not notify when the seed adds nothing", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1, 2, 3]);
    const before = store.getSessionRows("s1");

    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    store.seedRows("s1", rows("s1", [2]));
    expect(store.getSessionRows("s1")).toBe(before);
    expect(notifies).toBe(0);

    store.seedRows("s1", rows("s1", [1, 2, 3]));
    expect(store.getSessionRows("s1")).toBe(before);
    expect(notifies).toBe(0);

    store.seedRows("s1", []);
    expect(store.getSessionRows("s1")).toBe(before);
    expect(notifies).toBe(0);
    store.stop();
  });

  it("trims the merged union from the head at ROW_CAP", async () => {
    const store = await load();
    store.start();
    const odd = Array.from({ length: 1_500 }, (_, i) => i * 2 + 1); // 1,3,…,2999
    const even = Array.from({ length: 1_500 }, (_, i) => i * 2); // 0,2,…,2998
    pushRows(store, "s1", odd);

    store.seedRows("s1", rows("s1", even));

    const ring = store.getSessionRows("s1");
    expect(ring).toHaveLength(store.ROW_CAP);
    expect(ring[0]!.q).toBe(1_000); // 3000 merged, newest 2000 kept
    expect(ring[ring.length - 1]!.q).toBe(2_999);
    store.stop();
  });

  it("is idempotent: re-seeding the same tail twice changes nothing", async () => {
    const store = await load();
    const tail = rows("s1", [1, 2, 3]);

    store.seedRows("s1", tail);
    const first = store.getSessionRows("s1");
    store.seedRows("s1", tail);

    expect(store.getSessionRows("s1")).toBe(first);
    expect(first.map((r) => r.q)).toEqual([1, 2, 3]);
  });

  it("does not seed the project ring", async () => {
    const store = await load();
    store.seedRows("s1", rows("s1", [1, 2]));
    expect(store.getProjectRows(PROJECT)).toHaveLength(0);
  });
});

describe("cost", () => {
  it("takes the latest turn's cumulative figure and never sums turns", async () => {
    const store = await load();
    store.start();

    // Two `turn-completed` events for one session, as the Rust side may emit several per user
    // message. Cumulative already, so summing would double-count.
    store.pushBatch(
      batch({
        signals: [
          env("s1", turnCompleted("t1", 0.05)),
          env("s1", turnCompleted("t2", 0.11)),
        ],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);

    expect(store.getState().sessions["s1"]!.costUsd).toBe(0.11);
    expect(store.getState().sessions["s1"]!.costUsd).not.toBe(0.16);
    store.stop();
  });

  it("carries the latest turn's usage with the latest cost, across frames", async () => {
    const store = await load();
    store.start();

    const first = { ...zeroUsage(), input_tokens: 10, output_tokens: 1 };
    const second = { ...zeroUsage(), input_tokens: 40, output_tokens: 7 };

    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t1", 0.05, first))] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState().sessions["s1"]!.usage).toEqual(first);

    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t2", 0.11, second))] }));
    vi.advanceTimersByTime(FRAME_MS);

    const s = store.getState().sessions["s1"]!;
    expect(s.costUsd).toBe(0.11);
    expect(s.usage).toEqual(second);
    expect(s.lastTurnId).toBe("t2");
    expect(s.busy).toBe(false);
    store.stop();
  });

  it("overwrites rather than maximises — the last turn wins outright", async () => {
    const store = await load();
    store.start();

    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t1", 0.11))] }));
    vi.advanceTimersByTime(FRAME_MS);
    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t2", 0.07))] }));
    vi.advanceTimersByTime(FRAME_MS);

    expect(store.getState().sessions["s1"]!.costUsd).toBe(0.07);
    store.stop();
  });
});

describe("seedSessions", () => {
  it("clears a stale end when the view says the session is live", async () => {
    const store = await load();
    store.start();
    store.pushBatch(
      batch({
        signals: [
          env("s1", { type: "session-exited", reason: "graceful", exit_code: 0 }, 5_000),
        ],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);
    const exited = store.getState().sessions["s1"]!;
    expect(exited.status).toBe("exited");
    expect(exited.endedAtMs).toBe(5_000);
    expect(exited.exitCode).toBe(0);

    // What `resume_session` returns for a session this store still holds an end time for.
    store.seedSessions([
      view({ session_id: "s1", status: "running", ended_at_ms: null, exit_code: null }),
    ]);

    const live = store.getState().sessions["s1"]!;
    expect(live.status).toBe("running");
    expect(live.endedAtMs).toBeNull();
    expect(live.exitCode).toBeNull();
    store.stop();
  });

  it("keeps a known end when the view is not live and carries none", async () => {
    const store = await load();
    store.start();
    store.pushBatch(
      batch({
        signals: [
          env("s1", { type: "session-exited", reason: "graceful", exit_code: 3 }, 5_000),
        ],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);

    store.seedSessions([
      view({ session_id: "s1", status: "exited", ended_at_ms: null, exit_code: null }),
    ]);

    const s = store.getState().sessions["s1"]!;
    expect(s.status).toBe("exited");
    expect(s.endedAtMs).toBe(5_000);
    expect(s.exitCode).toBe(3);
    store.stop();
  });

  it("takes the higher of the known and seeded cumulative cost", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t1", 0.42))] }));
    vi.advanceTimersByTime(FRAME_MS);

    store.seedSessions([view({ session_id: "s1", cost_usd_cumulative: 0.1 })]);

    expect(store.getState().sessions["s1"]!.costUsd).toBe(0.42);
    store.stop();
  });
});

describe("counters", () => {
  it("are throttled to COUNTER_FLUSH_MS while signals commit on the frame they arrive", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    store.start();

    // Establish the session and the project so later counter-only batches dirty nothing else.
    store.pushBatch(batch({ signals: [env("s1", { type: "turn-started", turn_id: "t1" })] }));
    vi.advanceTimersByTime(FRAME_MS);
    vi.advanceTimersByTime(600); // let any pending throttle window drain

    // A signal in the same batch as counters commits immediately, and anchors the throttle clock.
    store.pushBatch(
      batch({
        signals: [env("s1", { type: "runtime-warning", message: "hi" })],
        counters: [{ session_id: "s1", rows_total: 10, rows_dropped: 0 }],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);
    const anchored = store.getState();
    expect(anchored.sessions["s1"]!.rowsTotal).toBe(10);
    expect(anchored.sessions["s1"]!.lastMessage).toBe("warning: hi");
    const notifiesAtAnchor = notifies;

    // A counters-only update inside the window is held: no rebuild, no notify, stale snapshot.
    store.pushBatch(batch({ counters: [{ session_id: "s1", rows_total: 20, rows_dropped: 2 }] }));
    vi.advanceTimersByTime(100);
    expect(store.getState()).toBe(anchored);
    expect(store.getState().sessions["s1"]!.rowsTotal).toBe(10);
    expect(notifies).toBe(notifiesAtAnchor);

    // Past 500 ms from the anchor it flushes, once.
    vi.advanceTimersByTime(450);
    const flushed = store.getState();
    expect(flushed).not.toBe(anchored);
    expect(flushed.version).toBe(anchored.version + 1);
    expect(flushed.sessions["s1"]!.rowsTotal).toBe(20);
    expect(flushed.sessions["s1"]!.rowsDropped).toBe(2);
    expect(notifies).toBe(notifiesAtAnchor + 1);
    store.stop();
  });

  it("does not rebuild the snapshot for a counter value that did not change", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ counters: [{ session_id: "s1", rows_total: 5, rows_dropped: 0 }] }));
    vi.advanceTimersByTime(600);
    const settled = store.getState();
    expect(settled.sessions["s1"]!.rowsTotal).toBe(5);

    store.pushBatch(batch({ counters: [{ session_id: "s1", rows_total: 5, rows_dropped: 0 }] }));
    vi.advanceTimersByTime(600);

    expect(store.getState()).toBe(settled);
    store.stop();
  });
});

describe("reference stability", () => {
  it("keeps the identical array for a session ring that saw no rows this frame", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: [...rows("s1", [1]), ...rows("s2", [2])] }));
    vi.advanceTimersByTime(FRAME_MS);

    const s1Before = store.getSessionRows("s1");
    const s2Before = store.getSessionRows("s2");
    expect(s1Before).toHaveLength(1);
    expect(s2Before).toHaveLength(1);

    store.pushBatch(batch({ rows: rows("s1", [3]) }));
    vi.advanceTimersByTime(FRAME_MS);

    expect(store.getSessionRows("s2")).toBe(s2Before);
    expect(store.getSessionRows("s1")).not.toBe(s1Before);
    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 3]);
    store.stop();
  });

  it("returns one shared empty array for an unknown or null id", async () => {
    const store = await load();
    expect(store.getSessionRows("nope")).toBe(store.getSessionRows("other"));
    expect(store.getSessionRows(null)).toBe(store.getSessionRows("nope"));
    expect(store.getProjectRows(null)).toBe(store.getSessionRows(null));
    expect(store.getSessionRows(null)).toHaveLength(0);
  });

  it("gives each touched session exactly one new array per frame", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    store.pushBatch(batch({ rows: rows("s1", [2]) }));
    vi.advanceTimersByTime(FRAME_MS);
    const after = store.getSessionRows("s1");

    expect(after.map((r) => r.q)).toEqual([1, 2]);
    expect(store.getSessionRows("s1")).toBe(after);
    store.stop();
  });
});

describe("unknown projects", () => {
  it("records an unlisted project once and keeps the list reference stable", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS);

    const unknown = store.getState().unknownProjects;
    expect([...unknown]).toEqual([PROJECT]);

    // A second batch for the same project that *does* force a rebuild: the list must survive it
    // as the identical array, or an effect keyed on it refires every frame.
    store.pushBatch(
      batch({
        rows: rows("s1", [2]),
        signals: [env("s1", { type: "turn-started", turn_id: "t1" })],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);

    const next = store.getState();
    expect(next.version).toBeGreaterThan(0);
    expect(next.unknownProjects).toBe(unknown);
    expect(next.unknownProjects).toHaveLength(1);
    store.stop();
  });

  it("never records a project the UI already listed", async () => {
    const store = await load();
    store.noteProjects([PROJECT]);
    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS);

    expect(store.getState().unknownProjects).toHaveLength(0);
    store.stop();
  });

  it("drops a project from the unknown list once list_projects names it", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState().unknownProjects).toHaveLength(1);

    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    store.noteProjects([PROJECT]);
    expect(store.getState().unknownProjects).toHaveLength(0);
    expect(notifies).toBe(1);

    // Nothing changed the second time: no rebuild, no notify.
    const settled = store.getState();
    store.noteProjects([PROJECT]);
    expect(store.getState()).toBe(settled);
    expect(notifies).toBe(1);
    store.stop();
  });
});
