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
  SessionCounter,
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

/** `k` is carried through the store untouched — it is not read here, and nothing in `feedStore`
 *  branches on it. `"sys"` rather than `"unknown"` so the fixture is a real class. */
function row(s: SessionId, q: number, l = `line ${q}`): FeedRowWire {
  return { s, q, t: 1_000 + q, l, k: "sys" };
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
  it("drains while native animation frames are suspended and cancels the fallback on stop", async () => {
    const store = await load();
    const frames = vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(1);
    const notified = vi.fn();
    store.subscribe(notified);
    store.start();
    store.pushBatch(batch({ rows: rows("s1", [1]), signals: [env("s1", { type: "turn-started", turn_id: "t1" })] }));
    vi.advanceTimersByTime(250);
    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1]);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(store.getState().sessions.s1?.busy).toBe(true);
    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t1", 0))] }));
    vi.advanceTimersByTime(250);
    expect(store.getState().sessions.s1?.busy).toBe(false);
    store.stop();
    store.pushBatch(batch({ rows: rows("s1", [2]) }));
    vi.advanceTimersByTime(500);
    expect(notified).toHaveBeenCalledTimes(2);
    frames.mockRestore();
  });

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

/**
 * The rings are lazy: an append only pushes onto a mutable buffer and drops the cached snapshot,
 * and `getSessionRows` / `getProjectRows` materialise the trimmed array. These pin the identity
 * contract that makes that safe — it is the part a future edit breaks silently, because a pane
 * that re-renders every frame still *looks* right.
 */
describe("lazy ring snapshots", () => {
  it("hands out a new reference after an append and the identical one without", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1]);

    const first = store.getSessionRows("s1");
    expect(store.getSessionRows("s1")).toBe(first); // no append between the two reads
    expect(store.getSessionRows("s1")).toBe(first); // and still none

    pushRows(store, "s1", [2]);
    const second = store.getSessionRows("s1");
    expect(second).not.toBe(first);
    expect(second.map((r) => r.q)).toEqual([1, 2]);
    expect(store.getSessionRows("s1")).toBe(second);
    store.stop();
  });

  it("gives the project ring the same reference contract", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1]);
    const first = store.getProjectRows(PROJECT);
    expect(store.getProjectRows(PROJECT)).toBe(first);

    pushRows(store, "s2", [2]);
    expect(store.getProjectRows(PROJECT)).not.toBe(first);
    expect(store.getProjectRows(PROJECT).map((r) => r.q)).toEqual([1, 2]);
    store.stop();
  });

  it("keeps the newest ROW_CAP rows in order well past the buffer's slack margin", async () => {
    const store = await load();
    store.start();

    // 12,000 rows in 24 frames: six times `ROW_CAP`, so the amortised head trim runs repeatedly
    // rather than once. A buffer that never trimmed would still pass a single-overflow test.
    let q = 0;
    for (let frame = 0; frame < 24; frame++) {
      const qs = Array.from({ length: 500 }, () => q++);
      store.pushBatch(batch({ rows: rows("s1", qs) }));
      vi.advanceTimersByTime(FRAME_MS);
    }
    expect(q).toBe(12_000);

    const ring = store.getSessionRows("s1");
    expect(ring).toHaveLength(store.ROW_CAP);
    expect(ring[0]!.q).toBe(10_000); // 12000 - 2000
    expect(ring[ring.length - 1]!.q).toBe(11_999);
    expect(ring.map((r) => r.q)).toEqual(
      Array.from({ length: store.ROW_CAP }, (_, i) => 10_000 + i),
    );

    const project = store.getProjectRows(PROJECT);
    expect(project).toHaveLength(store.ROW_CAP);
    expect(project[0]!.q).toBe(10_000);
    store.stop();
  });

  it("never mutates a snapshot a reader is still holding", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1, 2, 3]);

    const held = store.getSessionRows("s1");
    const heldObjects = [...held];

    // Enough appends to cross `ROW_CAP` and force the buffer's head trim under the held snapshot.
    let q = 4;
    for (let frame = 0; frame < 12; frame++) {
      const qs = Array.from({ length: 400 }, () => q++);
      store.pushBatch(batch({ rows: rows("s1", qs) }));
      vi.advanceTimersByTime(FRAME_MS);
    }

    expect(held).toHaveLength(3);
    expect(held.map((r) => r.q)).toEqual([1, 2, 3]);
    expect([...held]).toEqual(heldObjects);
    expect(store.getSessionRows("s1")).toHaveLength(store.ROW_CAP);
    store.stop();
  });

  it("holds a seeded snapshot steady across later live appends", async () => {
    const store = await load();
    store.start();
    store.seedRows("s1", rows("s1", [1, 2]));
    const held = store.getSessionRows("s1");

    pushRows(store, "s1", [3]);
    pushRows(store, "s1", [4]);

    expect(held.map((r) => r.q)).toEqual([1, 2]);
    expect(store.getSessionRows("s1").map((r) => r.q)).toEqual([1, 2, 3, 4]);
    store.stop();
  });

  it("returns the shared empty array for a ring nothing ever wrote", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1]);

    const empty = store.getSessionRows("never-written");
    expect(empty).toHaveLength(0);
    expect(store.getSessionRows("never-written")).toBe(empty);
    expect(store.getProjectRows("no-such-project")).toBe(empty);
    expect(store.getSessionRows(null)).toBe(empty);
    store.stop();
  });

  it("drops a deleted session's ring and the project snapshot that still held its rows", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ rows: [row("s1", 1), row("s2", 2), row("s1", 3)] }));
    vi.advanceTimersByTime(FRAME_MS);

    const projectBefore = store.getProjectRows(PROJECT); // materialised, and now cached
    expect(projectBefore.map((r) => r.s)).toEqual(["s1", "s2", "s1"]);
    expect(store.getSessionRows("s1")).toHaveLength(2);

    store.dropSession("s1");

    expect(store.getSessionRows("s1")).toHaveLength(0);
    const projectAfter = store.getProjectRows(PROJECT);
    expect(projectAfter).not.toBe(projectBefore);
    expect(projectAfter.map((r) => r.s)).toEqual(["s2"]);
    expect(projectBefore.map((r) => r.s)).toEqual(["s1", "s2", "s1"]); // the held one is intact
    store.stop();
  });

  it("does not resurrect rows already evicted past ROW_CAP when a session is dropped", async () => {
    const store = await load();
    store.start();

    // 3,600 rows, two sessions interleaved. The project buffer runs into its slack, so 1,600 rows
    // have already fallen off the head before the drop; filtering `buf` in place would take the
    // length back under `ROW_CAP` and hand every one of them back out.
    let q = 0;
    for (let frame = 0; frame < 12; frame++) {
      const wire: FeedRowWire[] = [];
      for (let i = 0; i < 300; i++) {
        wire.push(row(q % 2 === 0 ? "s1" : "s2", q));
        q++;
      }
      store.pushBatch(batch({ rows: wire }));
      vi.advanceTimersByTime(FRAME_MS);
    }
    expect(q).toBe(3_600);

    const before = store.getProjectRows(PROJECT);
    expect(before).toHaveLength(store.ROW_CAP);
    expect(before[0]!.q).toBe(1_600);
    const survivors = before.filter((r) => r.s !== "s2").map((r) => r.q);

    store.dropSession("s2");

    const after = store.getProjectRows(PROJECT);
    // The surviving rows are a suffix of what was logically visible: nothing older comes back.
    expect(after[0]!.q).toBeGreaterThanOrEqual(before[0]!.q);
    expect(after.map((r) => r.q)).toEqual(survivors);
    expect(after).toHaveLength(1_000);
    store.stop();
  });

  it("drops a deleted project's ring and its cached snapshot", async () => {
    const store = await load();
    store.start();
    pushRows(store, "s1", [1, 2]);
    const before = store.getProjectRows(PROJECT);
    expect(before).toHaveLength(2);

    store.dropProject(PROJECT);

    expect(store.getProjectRows(PROJECT)).toHaveLength(0);
    expect(store.getProjectRows(PROJECT)).toBe(store.getSessionRows(null));
    expect(store.getSessionRows("s1")).toHaveLength(0);
    expect(before).toHaveLength(2); // the reader's copy, untouched
    store.stop();
  });

  it("counts a session's visible rows without building the snapshot", async () => {
    const store = await load();
    store.start();
    expect(store.getSessionRowCount(null)).toBe(0);
    expect(store.getSessionRowCount("never-written")).toBe(0);

    pushRows(store, "s1", [1, 2, 3]);
    expect(store.getSessionRowCount("s1")).toBe(3);
    expect(store.getSessionRowCount("s1")).toBe(store.getSessionRows("s1").length);

    // Past `ROW_CAP` and into the buffer's slack: the count is the logically visible one.
    let q = 4;
    for (let frame = 0; frame < 8; frame++) {
      const qs = Array.from({ length: 400 }, () => q++);
      store.pushBatch(batch({ rows: rows("s1", qs) }));
      vi.advanceTimersByTime(FRAME_MS);
    }
    expect(q).toBe(3_204); // buffer carrying slack: 3,203 rows held, 2,000 of them visible
    expect(store.getSessionRowCount("s1")).toBe(store.ROW_CAP);
    expect(store.getSessionRowCount("s1")).toBe(store.getSessionRows("s1").length);

    store.dropSession("s1");
    expect(store.getSessionRowCount("s1")).toBe(0);
    expect(store.getSessionRowCount("s1")).toBe(store.getSessionRows("s1").length);
    store.stop();
  });

  it("still counts every ingested row, whether or not anyone reads a ring", async () => {
    const store = await load();
    store.start();
    for (let frame = 0; frame < 10; frame++) {
      store.pushBatch(batch({ rows: rows("s1", [frame * 2, frame * 2 + 1]) }));
      vi.advanceTimersByTime(FRAME_MS);
    }
    expect(store.getIngest()).toEqual({ rowsIn: 20, batches: 10 });
    store.stop();
  });

  it("notifies on the frame rows changed even when nothing reads the ring", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    store.start();

    store.pushBatch(batch({ rows: rows("s1", [1]) }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(notifies).toBe(1);

    store.pushBatch(batch({ rows: rows("s1", [2]) }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(notifies).toBe(2);

    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(notifies).toBe(2);
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


describe("deleted history stays deleted", () => {
  it("discards late signals, counters, rows and session fetches", async () => {
    const store = await load();
    store.start();
    const session = view({ session_id: "deleted" });
    store.seedSessions([session]);
    store.pushBatch(batch({ rows: [row("deleted", 1), row("kept", 1)] }));
    vi.advanceTimersByTime(FRAME_MS);
    store.dropSession("deleted");
    store.pushBatch(batch({ rows: [row("deleted", 2)], signals: [env("deleted", { type: "session-exited", reason: "killed", exit_code: null })], counters: [{ session_id: "deleted", rows_total: 2, rows_dropped: 0 }] }));
    store.seedSessions([session]);
    store.seedRows("deleted", [row("deleted", 3)]);
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState().sessions.deleted).toBeUndefined();
    expect(store.getSessionRows("deleted")).toEqual([]);
    expect(store.getProjectRows(PROJECT).map(row => row.s)).toEqual(["kept"]);
    store.dropProject(PROJECT);
    store.pushBatch(batch({ rows: [row("kept", 2)] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState().order).toEqual([]);
    expect(store.getProjectRows(PROJECT)).toEqual([]);
  });
});

it("removes stopped Codex MCP and Edit approvals from the live attention state", async () => {
  const store = await load(); store.start();
  const opened = (id:string,name:string): Event => ({type:'request-opened',request_id:id,turn_id:'turn',kind:{type:'tool-permission',tool_name:name,input_excerpt:'Native approval',suggestions:[],tool_call_id:null}});
  store.pushBatch(batch({signals:[env('s1',opened('mcp','MCP · brigadier')),env('s1',opened('edit','Edit'))]}));
  vi.advanceTimersByTime(FRAME_MS);
  expect(store.getState().approvals).toHaveLength(2);
  store.pushBatch(batch({signals:[
    env('s1',{type:'request-resolved',request_id:'mcp',decision:{type:'deny',reason:'Codex session ended',interrupt:true}}),
    env('s1',{type:'request-resolved',request_id:'edit',decision:{type:'deny',reason:'Codex session ended',interrupt:true}}),
    env('s1',{type:'session-exited',reason:'killed',exit_code:null}),
  ]}));
  vi.advanceTimersByTime(FRAME_MS);
  expect(store.getState().approvals).toEqual([]);
  expect(store.getState().sessions.s1?.status).toBe('exited');
  store.stop();
});

/**
 * The snapshot identity contract, added 2026-09-10 with the `patch` diff / cursor split in
 * `src/feedStore.ts`. Everything here is about *which frames rebuild `state`*, never about what a
 * value ends up being — the value assertions live in the describes above and are unchanged.
 */
describe("snapshot identity", () => {
  /** A `session-started` whose every field repeats: the per-turn `system/init` announcement. */
  function started(): Event {
    return {
      type: "session-started",
      provider_session_id: "prov-1",
      model: "model-a",
      cwd: "/repo",
      capabilities: [],
      resume_token: null,
    };
  }

  it("holds `getState()` identical across a burst that moves only `lastEventSeq`", async () => {
    const store = await load();
    store.start();
    // First announcement: a new session, a new status, a start stamp — a rendered change.
    store.pushBatch(batch({ signals: [env("s1", started())] }));
    vi.advanceTimersByTime(FRAME_MS);
    const settled = store.getState();
    expect(settled.sessions["s1"]!.status).toBe("running");
    const seqAtSettle = settled.sessions["s1"]!.lastEventSeq;

    // `system/init` arrives once per turn (`docs/STATUS.md` §7): 20 more announcements, one per
    // frame, each carrying the same model/cwd/status and a new `seq`. None may rebuild. The
    // envelope time is held at the first announcement's on purpose — `session-started` still
    // re-stamps `startedAtMs` from it and that is a rendered change, left alone deliberately
    // (see the `session-started` case in `src/feedStore.ts`).
    for (let i = 0; i < 20; i++) {
      store.pushBatch(batch({ signals: [env("s1", started())] }));
      vi.advanceTimersByTime(FRAME_MS);
      expect(store.getState()).toBe(settled);
    }
    // 20 frames is 340 ms, inside COUNTER_FLUSH_MS, so the snapshot still carries the old cursor
    // while the live one has moved 20 times.
    expect(store.getState().sessions["s1"]!.lastEventSeq).toBe(seqAtSettle);
    // `rowsTotal:lastEventSeq:busy|deltas` since §4.2.2: a session with no streamed content
    // reports `0` for the delta cursor, and the delta rides after a `|` so `src/attention.ts`'s
    // positional read of `lastEventSeq` still works (see `getSessionCursor`).
    expect(store.getSessionCursor("s1")).toBe(`0:${seqAtSettle + 20}:false|0`);
    store.stop();
  });

  it("rebuilds on the frame a status, busy, model or order change arrives", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", started())] }));
    vi.advanceTimersByTime(FRAME_MS);

    const beforeBusy = store.getState();
    store.pushBatch(batch({ signals: [env("s1", { type: "turn-started", turn_id: "t1" })] }));
    vi.advanceTimersByTime(FRAME_MS);
    const busy = store.getState();
    expect(busy).not.toBe(beforeBusy);
    expect(busy.sessions["s1"]!.busy).toBe(true);

    store.pushBatch(batch({ signals: [env("s1", turnCompleted("t1", 0.01))] }));
    vi.advanceTimersByTime(FRAME_MS);
    const idle = store.getState();
    expect(idle).not.toBe(busy);
    expect(idle.sessions["s1"]!.busy).toBe(false);

    // A different model on the same session is a rendered change even though nothing else moved.
    store.pushBatch(batch({ signals: [env("s1", { ...started(), model: "model-b" } as Event)] }));
    vi.advanceTimersByTime(FRAME_MS);
    const remodelled = store.getState();
    expect(remodelled).not.toBe(idle);
    expect(remodelled.sessions["s1"]!.model).toBe("model-b");

    // A second session starting is a new `order`, so it is a rendered change too.
    store.pushBatch(batch({ signals: [env("s2", started(), 9_000)] }));
    vi.advanceTimersByTime(FRAME_MS);
    const two = store.getState();
    expect(two).not.toBe(remodelled);
    expect(two.order).toEqual(["s2", "s1"]);

    // A fatal `runtime-error` is a status change; a second identical warning is an edge on
    // `runtimeWarnings`, which lives outside the runtimes and must still reach React.
    store.pushBatch(batch({ signals: [env("s1", { type: "runtime-warning", message: "same" })] }));
    vi.advanceTimersByTime(FRAME_MS);
    const warned = store.getState();
    store.pushBatch(batch({ signals: [env("s1", { type: "runtime-warning", message: "same" })] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState()).not.toBe(warned);
    expect(store.getState().runtimeWarnings).toBe(warned.runtimeWarnings + 1);
    store.stop();
  });

  it("commits `request-opened` and `request-resolved` on the frame they arrive", async () => {
    const store = await load();
    store.start();
    const opened: Event = {
      type: "request-opened",
      request_id: "r1",
      turn_id: "t1",
      kind: { type: "tool-permission", tool_name: "Edit", input_excerpt: "x", suggestions: [], tool_call_id: null },
    };
    store.pushBatch(batch({ signals: [env("s1", started())] }));
    vi.advanceTimersByTime(FRAME_MS);
    const quiet = store.getState();

    // Approvals are never optimistic (`docs/vision.md` §9): the card may not wait for a flush.
    store.pushBatch(batch({ signals: [env("s1", opened)] }));
    vi.advanceTimersByTime(FRAME_MS);
    const withCard = store.getState();
    expect(withCard).not.toBe(quiet);
    expect(withCard.approvals.map((a) => a.requestId)).toEqual(["r1"]);

    store.pushBatch(batch({ signals: [env("s1", { type: "request-resolved", request_id: "r1", decision: { type: "allow", updated_input: null, updated_permissions: [] } })] }));
    vi.advanceTimersByTime(FRAME_MS);
    const cleared = store.getState();
    expect(cleared).not.toBe(withCard);
    expect(cleared.approvals).toEqual([]);
    store.stop();
  });

  it("moves the live cursor once per signal while the snapshot holds still", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", started())] }));
    vi.advanceTimersByTime(FRAME_MS);

    // One cursor-only signal per frame for 24 frames (408 ms, inside COUNTER_FLUSH_MS). The
    // conversation-history token is this string: it must move on every one of them.
    let cursor = store.getSessionCursor("s1");
    let cursorChanges = 0;
    let snapshot = store.getState();
    let rebuilds = 0;
    for (let i = 0; i < 24; i++) {
      store.pushBatch(batch({ signals: [env("s1", started())] }));
      vi.advanceTimersByTime(FRAME_MS);
      const nextCursor = store.getSessionCursor("s1");
      if (nextCursor !== cursor) { cursor = nextCursor; cursorChanges += 1; }
      if (store.getState() !== snapshot) { snapshot = store.getState(); rebuilds += 1; }
    }
    expect(cursorChanges).toBe(24);
    expect(rebuilds).toBe(0);
    store.stop();
  });

  it("folds a cursor-only advance into the snapshot within COUNTER_FLUSH_MS", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", started()), env("s1", { type: "turn-started", turn_id: "t1" }), env("s1", turnCompleted("t1", 0))] }));
    vi.advanceTimersByTime(FRAME_MS);
    const settled = store.getState();
    const seqAtSettle = settled.sessions["s1"]!.lastEventSeq;

    store.pushBatch(batch({ signals: [env("s1", started())] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getState()).toBe(settled);

    // This is the bound `useAttention`'s badge inherits: `(reads[id] ?? -1) < lastEventSeq` reads
    // the snapshot, so a background session's new activity shows up a flush late, never never.
    vi.advanceTimersByTime(600);
    const folded = store.getState();
    expect(folded).not.toBe(settled);
    expect(folded.sessions["s1"]!.lastEventSeq).toBe(seqAtSettle + 1);
    store.stop();
  });
});

describe("content deltas (§4.2.1)", () => {
  /** `deltas` is optional on the wire mirror, so "no delta field at all" is expressible here. */
  const counter = (
    sessionId: SessionId,
    rowsTotal: number,
    deltas?: number,
  ): SessionCounter => ({
    session_id: sessionId,
    rows_total: rowsTotal,
    rows_dropped: 0,
    ...(deltas === undefined ? {} : { deltas }),
  });

  it("moves the live cursor on the frame a delta lands, without rebuilding the snapshot", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    store.start();
    // A signal in the same batch as a counter commits and anchors the throttle clock, exactly as
    // the "are throttled to COUNTER_FLUSH_MS" test above does: what follows is inside the window.
    store.pushBatch(
      batch({
        signals: [env("s1", { type: "turn-started", turn_id: "t1" })],
        counters: [counter("s1", 0, 0)],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);

    const settled = store.getState();
    const before = store.getSessionCursor("s1");
    const notifiesAtRest = notifies;

    // A counters-only batch whose *only* movement is `deltas`: no row, no signal, nothing drawn.
    store.pushBatch(batch({ counters: [counter("s1", 0, 12)] }));
    vi.advanceTimersByTime(FRAME_MS);

    expect(store.getSessionCursor("s1")).not.toBe(before);
    expect(store.getSessionCursor("s1")).toBe("0:1:true|12");
    // The transcript is woken on this frame — the whole point — but the React snapshot is not
    // rebuilt for it, so nothing else in the window re-renders.
    expect(notifies).toBe(notifiesAtRest + 1);
    expect(store.getState()).toBe(settled);

    // And it never reaches the snapshot at all: a whole streaming answer's worth of deltas
    // rebuilds `getState()` zero times, while the live cursor tracks every frame.
    const rebuilt = store.getState();
    let cursor = store.getSessionCursor("s1");
    for (let i = 13; i < 73; i++) {
      store.pushBatch(batch({ counters: [counter("s1", 0, i)] }));
      vi.advanceTimersByTime(FRAME_MS);
      expect(store.getSessionCursor("s1")).not.toBe(cursor);
      cursor = store.getSessionCursor("s1");
    }
    vi.advanceTimersByTime(600);
    expect(store.getState()).toBe(rebuilt);
    expect(JSON.stringify(store.getState())).not.toMatch(/deltas/);
    store.stop();
  });

  it("refuses a non-finite delta instead of notifying on every frame for ever", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    store.start();
    store.pushBatch(
      batch({
        signals: [env("s1", { type: "turn-started", turn_id: "t1" })],
        counters: [counter("s1", 0, 0)],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);
    const before = notifies;
    // `NaN !== NaN`, so an unguarded counter would mark the store dirty on every frame.
    for (let i = 0; i < 5; i++) {
      store.pushBatch(batch({ counters: [counter("s1", 0, Number.NaN)] }));
      vi.advanceTimersByTime(FRAME_MS);
    }
    expect(notifies).toBe(before);
    expect(store.getSessionCursor("s1")).toBe("0:1:true|0");
    store.stop();
  });

  it("holds still for a counter batch that carries no delta field at all", async () => {
    const store = await load();
    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });
    store.start();
    store.pushBatch(
      batch({
        signals: [env("s1", { type: "turn-started", turn_id: "t1" })],
        counters: [counter("s1", 0, 0)],
      }),
    );
    vi.advanceTimersByTime(FRAME_MS);
    const before = notifies;
    const cursor = store.getSessionCursor("s1");

    // A pre-phase-2 counter (no `deltas`) must stay throttled exactly as it was.
    store.pushBatch(batch({ counters: [counter("s1", 40)] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(notifies).toBe(before);
    expect(store.getSessionCursor("s1")).not.toBe(cursor); // `rows_total` moved, `deltas` did not
    expect(store.getSessionCursor("s1")).toBe("40:1:true|0");
    store.stop();
  });
});

describe("usage windows (§4.3)", () => {
  const usage = (utilization: number): Event => ({
    type: "usage-windows",
    status: "allowed",
    windows: [
      { name: "five_hour", utilization, resets_at: 1_789_068_000 },
      { name: "seven_day", utilization: 0.16, resets_at: 1_789_556_400 },
    ],
  });

  it("keeps the windows off the snapshot and hands back a cached reference", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", usage(0.25))] }));
    vi.advanceTimersByTime(FRAME_MS);

    const first = store.getUsageWindows("s1");
    expect(first).toEqual([
      { name: "five_hour", utilization: 0.25, resets_at: 1_789_068_000 },
      { name: "seven_day", utilization: 0.16, resets_at: 1_789_556_400 },
    ]);
    // Windows, never dollars: the value carries a fraction and a reset time and nothing else.
    expect(Object.keys(first[0]!)).toEqual(["name", "utilization", "resets_at"]);
    expect(JSON.stringify(first)).not.toMatch(/cost|usd|dollar/i);
    // Not on the React snapshot, in either direction.
    expect(store.getState().sessions["s1"]).not.toHaveProperty("windows");
    expect(JSON.stringify(store.getState())).not.toMatch(/five_hour/);

    // The same values re-announced: a notify, and the identical array, so the gauge does not
    // re-render and nothing else sees a change at all.
    const snapshot = store.getState();
    store.pushBatch(batch({ signals: [env("s1", usage(0.25))] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getUsageWindows("s1")).toBe(first);
    expect(store.getState()).toBe(snapshot);

    // A moved utilization replaces the reference.
    store.pushBatch(batch({ signals: [env("s1", usage(0.5))] }));
    vi.advanceTimersByTime(FRAME_MS);
    const moved = store.getUsageWindows("s1");
    expect(moved).not.toBe(first);
    expect(moved[0]!.utilization).toBe(0.5);

    // An unknown session, and a dropped one, share one frozen empty array.
    expect(store.getUsageWindows("never-seen")).toBe(store.getUsageWindows(null));
    store.dropSession("s1");
    expect(store.getUsageWindows("s1")).toBe(store.getUsageWindows(null));
    store.stop();
  });

  it("advances the live cursor like any other signal", async () => {
    const store = await load();
    store.start();
    store.pushBatch(batch({ signals: [env("s1", { type: "turn-started", turn_id: "t1" })] }));
    vi.advanceTimersByTime(FRAME_MS);
    vi.advanceTimersByTime(600);
    const before = store.getSessionCursor("s1");
    store.pushBatch(batch({ signals: [env("s1", usage(0.25))] }));
    vi.advanceTimersByTime(FRAME_MS);
    expect(store.getSessionCursor("s1")).not.toBe(before);
    store.stop();
  });
});
