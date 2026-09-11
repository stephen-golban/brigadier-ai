import { countDiagnostic, markRenderUpdate, profiling, traceEvent } from "./perfDiagnostics";
/**
 * Feed ingestion: Channel -> module buffer -> one rAF drain -> one commit per frame.
 *
 * The pattern is `docs/research/feed-rendering.md` §2 and `docs/research/tauri-runtime.md` §4:
 *
 *   - `pushBatch` is what the Channel's `onmessage` calls. It runs synchronously inside an
 *     eval'd script, so it does nothing but append to a module-level array.
 *   - Exactly one `requestAnimationFrame` loop for the whole window drains that array, applies
 *     rows to per-session and per-project rings, applies signals to session state, and notifies
 *     `useSyncExternalStore` subscribers **once**. Ten channel messages in one frame are ten
 *     tasks and would be ten renders without this; React's automatic batching only collapses
 *     updates *within* a task.
 *   - **That loop is armed only while it has something to do** (2026-09-11, plan review B3). A
 *     `pushBatch` on an idle store arms the frame and its 250 ms fallback; a drain that empties
 *     the buffer arms nothing again, except one timer at the `COUNTER_FLUSH_MS` deadline when a
 *     counter or cursor is still owed to the snapshot. An idle window therefore wakes zero times
 *     a second where it used to wake ~64, in every build — the one exception is an open
 *     `src/fps.ts` capture, which holds the loop at full rate for its own duration. See `armed`,
 *     `rearm` and `setFrameSampling`.
 *   - `getSessionRows` / `getProjectRows` / `getState` return cached references. A session whose
 *     rows did not change this frame keeps the identical array, so its pane does not re-render.
 *   - No `flushSync`, and the feed is never read inside `startTransition`: a store mutated 60
 *     times a second restarts every transition it is read in.
 *
 * **Ring snapshots are lazy** (2026-09-10). Each ring is a mutable `Ring.buf` in arrival order plus
 * a cached `Ring.snap`; an append pushes onto `buf` and sets `snap = null`, and only a *reader*
 * materialises the trimmed array. The array a reader gets is always a copy, so a later append never
 * mutates a snapshot a pane is still holding.
 *
 * Why: the old `appendRing` rebuilt every touched ring on every drain, `concat` then `slice`, two
 * full copies each. **[measured]** In the 60 Hz native benchmark (10 sessions x 200 rows/sec x 60 s)
 * that is 1,707 rows/sec, ~28 rows per frame, and all 11 rings (ten sessions + the project)
 * saturate `ROW_CAP` ~1.2 s in and stay saturated: ~44,000 element copies and ~344 KiB of
 * short-lived array **per frame**, ~21 MB/s. A 40 s main-thread sample of the WebContent renderer
 * at 10 ms found **360 ms of synchronous JSC GC** (`EdenGCActivityCallback::doCollection` /
 * `FullGCActivityCallback::doCollection` through `Heap::collectInMutatorThread` ->
 * `stopThePeriphery`), landing as isolated 26-33 ms frames. **[measured]** Nothing read those
 * arrays: `src/components/Feed.tsx` is the only real consumer and has no non-test importer, and the
 * one live reader was the `getSessionRows(id).length > 0` check in `src/App.tsx`'s paint-span
 * effect — which wanted a count, not an array, and now calls `getSessionRowCount` instead.
 *
 * The identity contract the panes rely on is unchanged: a read after the ring changed returns a new
 * array, a read with no intervening change returns the identical one, and the contents are the last
 * `ROW_CAP` rows in arrival order. `rowsChanged`/`notify()` are untouched — subscribers are still
 * woken on the frame their rows changed, whether or not anyone reads.
 *
 * **`getState` honours that same contract** (2026-09-10). It did not: every signal ran through
 * `patch`, every `patch` set `stateDirty`, so `rebuildState` ran once a frame and both
 * `useSyncExternalStore(subscribe, getState)` call sites re-rendered their whole subtree sixty
 * times a second. **[measured]** in the 60 Hz native benchmark (10 sessions x 200 rows/s x 60 s,
 * `docs/performance/2026-09-10/peer-noop-after.json`) `stateRebuild` fired **3,655 times in 63 s**
 * and `App` rendered **6,628 times** for 7.2 s of render. Two things changed:
 *
 *   - `patch` diffs. A delta that moves nothing replaces no object and dirties nothing.
 *   - `lastEventSeq` is a **cursor**, not a rendered field. A delta that moves only a cursor is
 *     folded into the snapshot on the `COUNTER_FLUSH_MS` tick that already carries the row
 *     counters, so the snapshot lags the event stream by at most 500 ms and no frame rebuilds for
 *     it. Everything that needs per-event resolution reads `getSessionCursor` off the live map.
 *
 * `session-started` was **not** changed and is still a rendered change on every turn: it re-stamps
 * `startedAtMs` with the envelope time, which moves `StoreState.order`. See that case.
 *
 * What did **not** change: `request-opened`/`request-resolved`, `status`, `busy`, `model`, `order`,
 * `unknownProjects`, `runtimeWarnings` and the approvals list all still reach React on the frame
 * they move. **[measured]** that leaves `turn-started`/`turn-completed` — 1,334 and 1,333 per
 * session per 60 s in `docs/performance/2026-09-10/peer-noop-after-raw-delivery.json`, i.e. ~44
 * genuine `busy` flips a second per session against 60 frames — as a per-frame rebuild driver this
 * change cannot remove without deferring `busy`, which `docs/vision.md` §9 forbids. **This change
 * is therefore expected to be neutral on that fixture.** Its win is a real workload, where a turn
 * lasts seconds, rows never dirty the snapshot, and counters fold twice a second.
 */
import * as fps from "./fps";
import { ZERO_USAGE } from "./wire";
import type {
  ApprovalView,
  Envelope,
  FeedBatch,
  FeedRowWire,
  ProjectId,
  RequestKind,
  SessionId,
  SessionStatus,
  SessionView,
  Usage,
  UsageWindow,
} from "./wire";

/** Rows kept in memory per session, and per project. Older rows fall off the head. */
export const ROW_CAP = 2000;

/**
 * How far a ring's buffer is allowed to run past `ROW_CAP` before one `splice` trims it back.
 *
 * What is bought is allocation **rate**, which is what drives the JSC eden collections this change
 * targets: at `ROW_CAP` the trim moves 2,000 element slots per 2,000 rows ingested — one slot per
 * row, amortised — against the old path's two full 2,000-element copies per ring per *frame*,
 * ~344 KiB/frame of short-lived array across the benchmark's 11 saturated rings **[measured]**,
 * against ~0 B/frame now **[asserted: arithmetic from the trim schedule, not re-profiled]**.
 *
 * What is paid is retention, and it is **objects**, not references. A saturated ring holds up to
 * `ROW_CAP + RING_SLACK` = 4,000 rows instead of `ROW_CAP` = 2,000, so the benchmark's 11 rings
 * keep up to ~22,000 extra `FeedRowWire` objects alive — each with its own `l` text, not an 8-byte
 * slot. The reference slots alone are ~352 KiB against ~176 KiB, but that is the small half of the
 * number and is not the cost that matters. Both figures here are **[asserted]**: arithmetic from
 * the constants. **No heap delta has been measured**, so the retained bytes are unknown.
 *
 * The tradeoff is taken on the allocation-rate side, where the 360 ms of GC in the header's sample
 * was measured. Halve `RING_SLACK` if a heap measurement ever contradicts that.
 */
const RING_SLACK = ROW_CAP;

/** Counters move every frame; folding them into the snapshot that often would re-render the
 *  sidebar 60 times a second for numbers nobody can read. Signals commit immediately. */
const COUNTER_FLUSH_MS = 500;

/**
 * Fields that record **where the event stream got to**, not anything a React consumer draws.
 *
 * A delta that moves only these is applied to the live map at once and folded into the React
 * snapshot on the next `COUNTER_FLUSH_MS` tick, so it costs no rebuild and no render. Nothing in
 * `src/` renders `lastEventSeq`: grep gives `src/attention.ts:224` (a badge predicate),
 * `src/hooks/useConversationHistory.ts` (a change token), `src/components/SubagentsPanel.tsx:34`
 * (an acknowledgement) and `src/components/Burn.tsx:67` (the delivery audit) — four readers, no
 * pixels. The two that need per-event resolution get it from `getSessionCursor`.
 *
 * `rowsTotal`/`rowsDropped` are cursors too and have been throttled since before this change; they
 * arrive on the counters path rather than through `patch`, so they are not listed here.
 */
const CURSOR_FIELDS: ReadonlySet<string> = new Set(["lastEventSeq"]);

const EMPTY_ROWS: readonly FeedRowWire[] = Object.freeze([]);
const EMPTY_PROJECT_IDS: readonly ProjectId[] = Object.freeze([]);

/**
 * Content deltas counted per session, ever (§4.2.1) — **outside** the React snapshot, beside the
 * usage windows and for the same reason in reverse.
 *
 * It is a cursor nothing draws, so it must not be on `SessionRuntime`: a field there arrives on
 * the counters path, and the `COUNTER_FLUSH_MS` fold would then call `rebuildState()` twice a
 * second for the whole of a streaming answer — on a pure-prose turn, where no row, no signal and
 * no `busy` flip would otherwise have rebuilt anything — re-rendering every `getState()` consumer
 * in the window for a number that is only ever compared with itself inside `getSessionCursor`.
 */
const sessionDeltas = new Map<SessionId, number>();

const EMPTY_WINDOWS: readonly UsageWindow[] = Object.freeze([]);

/**
 * Latest usage windows per session — **outside** the React snapshot, on purpose.
 *
 * `windows` is a fresh array on every turn, so putting it on `SessionRuntime` would replace the
 * runtime object (and the whole `sessions` record) once a turn for a number one small gauge
 * draws, re-rendering every `getState()` consumer. `CURSOR_FIELDS` is equally wrong in the other
 * direction: the gauge *is* drawn, so it must not wait for the 500 ms counter fold. The row rings
 * already solve this shape — a module map plus a reader that hands back the same reference until
 * the values actually change (`docs/vision.md` §6, §4.3 of the plan).
 */
const usageWindows = new Map<SessionId, readonly UsageWindow[]>();

/** Field-wise, because each event carries freshly deserialised objects. */
function sameWindows(a: readonly UsageWindow[], b: readonly UsageWindow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.name !== y.name || x.utilization !== y.utilization || x.resets_at !== y.resets_at)
      return false;
  }
  return true;
}

function recordUsageWindows(sessionId: SessionId, windows: readonly UsageWindow[]): void {
  const prev = usageWindows.get(sessionId) ?? EMPTY_WINDOWS;
  // Identical values keep the identical array, so a re-announced window costs no render.
  if (sameWindows(prev, windows)) return;
  usageWindows.set(sessionId, windows.length === 0 ? EMPTY_WINDOWS : [...windows]);
}

/**
 * The usage windows the provider last reported for one session, newest first as the provider
 * ordered them. **Cached reference**: the same array comes back until a value actually moves, so
 * `useSyncExternalStore(subscribe, () => getUsageWindows(id))` schedules nothing on the frames in
 * between. Never call it during a render for a different session's id.
 *
 * Windows, never dollars (`docs/vision.md` §6): this carries a utilization fraction and a reset
 * time, and no cost field is ever added to it.
 */
export function getUsageWindows(sessionId: SessionId | null): readonly UsageWindow[] {
  if (sessionId === null) return EMPTY_WINDOWS;
  return usageWindows.get(sessionId) ?? EMPTY_WINDOWS;
}

/* ------------------------------------------------------------------ state */

export interface SessionRuntime {
  sessionId: SessionId;
  projectId: ProjectId | null;
  status: SessionStatus;
  model: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  instanceId?: string | null;
  cwd: string | null;
  /** The provider's own conversation id; non-null is what makes a settled session resumable. */
  providerSessionId: string | null;
  /** Git worktree the child runs in, and its branch. Both null when the project is not a repo. */
  worktreePath: string | null;
  branch: string | null;
  /** `cleanup_worktree` came back `removed: true`: the checkout is gone, so resume would fail. */
  worktreeRemoved: boolean;
  /** This session was continued in this window; effective settings are restored by the backend. */
  resumed: boolean;
  /** A turn is open (started, not yet completed or aborted). */
  busy: boolean;
  lastTurnId: string | null;
  lastStop: string | null;
  costUsd: number;
  usage: Usage;
  rowsTotal: number;
  rowsDropped: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  exitCode: number | null;
  /** Most recent runtime warning or error text, for the sidebar. */
  lastMessage: string | null;
  lastEventSeq: number;
}

export interface ApprovalItem {
  requestId: string;
  sessionId: SessionId;
  openedAtMs: number;
  /** Null when the row came back from `pending_approvals` with an undecodable kind. */
  kind: RequestKind | null;
  /** Opened under a previous `run_id`: it can be read and dismissed, never answered. */
  expired: boolean;
}

export interface StoreState {
  version: number;
  sessions: Record<SessionId, SessionRuntime>;
  /** Session ids, newest start first. */
  order: SessionId[];
  approvals: ApprovalItem[];
  /**
   * Project ids the feed has delivered a batch for that `list_projects` never mentioned — a
   * project created behind the UI's back (the dev `burn` command makes one). The reference is
   * stable until the set actually changes, so an effect keyed on it does not refire every frame.
   */
  unknownProjects: readonly ProjectId[];
  /**
   * How many `runtime-warning` signals this window has seen, ever.
   *
   * A counter rather than a message, because it is used as an **edge**, not as content: the
   * reconciler emits a `runtime-warning` for an intent it could not settle, and the plan card
   * refetches `current_run` when it fires (`docs/plans/ipc-contract.md` §"The run" → Signals).
   * The run needs no channel of its own, and this is why.
   *
   * The text of each warning is already on the session it belongs to, as `lastMessage`.
   */
  runtimeWarnings: number;
}

/**
 * One ring. `buf` is every row still held, in arrival order, up to `ROW_CAP + RING_SLACK`; `snap`
 * is the trimmed array the last reader was handed, or `null` when `buf` changed since. `snap` is
 * never an alias of `buf`, so an append cannot mutate an array a pane is still holding.
 */
interface Ring {
  buf: FeedRowWire[];
  snap: readonly FeedRowWire[] | null;
}

let buffer: FeedBatch[] = [];
const sessionRows = new Map<SessionId, Ring>();
const projectRows = new Map<ProjectId, Ring>();
const sessions = new Map<SessionId, SessionRuntime>();
const approvals = new Map<string, ApprovalItem>();
const listeners = new Set<() => void>();

/** Projects the UI has actually listed, and the ones only the feed has ever mentioned. */
const knownProjects = new Set<ProjectId>();
const unknownProjects = new Set<ProjectId>();
let unknownList: readonly ProjectId[] = EMPTY_PROJECT_IDS;

/** See `StoreState.runtimeWarnings`. Monotonic for the life of the window. */
let runtimeWarnings = 0;

let state: StoreState = {
  version: 0,
  sessions: {},
  order: [],
  approvals: [],
  unknownProjects: unknownList,
  runtimeWarnings: 0,
};
/** A field a React consumer renders moved: rebuild the snapshot on this frame. */
let stateDirty = false;
/** Only `rowsTotal`/`rowsDropped` moved: fold in on the `COUNTER_FLUSH_MS` tick. */
let countersDirty = false;
/** Only a `CURSOR_FIELDS` value moved: same tick, same reason. */
let cursorsDirty = false;
/** A signal was applied this frame. Wakes `subscribe` callbacks that read the live map
 *  (`getSessionCursor`) without claiming the snapshot moved. Counters deliberately do **not** set
 *  it — `src/feedStore.test.ts` "are throttled to COUNTER_FLUSH_MS" pins a held counter as silent. */
let signalsDirty = false;
/** A session's `deltas` counter moved this frame: a body grew. Wakes `subscribe` callbacks that
 *  read `getSessionCursor`, without rebuilding the snapshot and without the counters' throttle. */
let deltasDirty = false;
let lastCounterFlush = 0;

/** Ingestion counters, for the meter overlay. Not part of the React snapshot. */
const ingest = { rowsIn: 0, batches: 0, rowsInWindow: 0, batchesInWindow: 0, windowStart: 0 };

/* --------------------------------------------------------------- channel */

/**
 * The Channel `onmessage`. Push and return; anything else here runs on the main thread inside
 * the eval'd script that delivered the message.
 *
 * The push is also what wakes the loop: the drain is armed only while there is work to do
 * (`armWork`), so an idle window arms nothing at all. `armWork` is a boolean check and two
 * scheduler calls at most once per idle->busy edge, not once per batch.
 */
export function pushBatch(batch: FeedBatch): void {
  buffer.push(batch);
  if (running && armed !== "work") armWork();
}

/* ----------------------------------------------------------------- rings */

function ringFor<K>(map: Map<K, Ring>, key: K): Ring {
  let ring = map.get(key);
  if (ring === undefined) {
    ring = { buf: [], snap: null };
    map.set(key, ring);
  }
  return ring;
}

/**
 * Append `add[from, to)` to a ring. No array is built here: the rows go straight onto `buf`, the
 * cached snapshot is dropped, and the head is trimmed only once `buf` has run `RING_SLACK` past
 * `ROW_CAP`. `splice` moves the survivors in place rather than allocating a replacement.
 */
function appendRows(ring: Ring, add: readonly FeedRowWire[], from: number, to: number): void {
  const buf = ring.buf;
  for (let i = from; i < to; i++) buf.push(add[i]!);
  ring.snap = null;
  if (buf.length > ROW_CAP + RING_SLACK) buf.splice(0, buf.length - ROW_CAP);
}

/**
 * The only place a ring array is built. Returns the identical reference until the next append,
 * a new one on the first read after it, and `EMPTY_ROWS` for a ring that holds nothing.
 */
function readRing(ring: Ring | undefined): readonly FeedRowWire[] {
  if (ring === undefined) return EMPTY_ROWS;
  if (ring.snap !== null) return ring.snap;
  const buf = ring.buf;
  const snap =
    buf.length === 0
      ? EMPTY_ROWS
      : buf.length > ROW_CAP
        ? buf.slice(buf.length - ROW_CAP)
        : buf.slice();
  ring.snap = snap;
  return snap;
}

/* ------------------------------------------------------------- runtimes */

function blank(sessionId: SessionId, projectId: ProjectId | null): SessionRuntime {
  return {
    sessionId,
    projectId,
    status: "starting",
    model: null,
    cwd: null,
    providerSessionId: null,
    worktreePath: null,
    branch: null,
    worktreeRemoved: false,
    resumed: false,
    busy: false,
    lastTurnId: null,
    lastStop: null,
    costUsd: 0,
    usage: { ...ZERO_USAGE },
    rowsTotal: 0,
    rowsDropped: 0,
    startedAtMs: null,
    endedAtMs: null,
    exitCode: null,
    lastMessage: null,
    lastEventSeq: 0,
  };
}

function runtime(sessionId: SessionId, projectId: ProjectId | null): SessionRuntime {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) {
    if (existing.projectId === null && projectId !== null) {
      const next = { ...existing, projectId };
      sessions.set(sessionId, next);
      stateDirty = true;
      return next;
    }
    return existing;
  }
  const created = blank(sessionId, projectId);
  sessions.set(sessionId, created);
  stateDirty = true;
  return created;
}

/**
 * Apply a delta to one session's runtime, and classify what it moved.
 *
 * Three outcomes, in order of how often they fire under the benchmark: nothing moved (the object
 * and the snapshot both keep their identity), only a cursor moved (`cursorsDirty`), a rendered
 * field moved (`stateDirty`, and the snapshot is rebuilt on this frame). `Object.is` is the
 * comparison, so `usage` — a fresh object on every `turn-completed` — always counts as moved; it
 * rides with a `busy` flip that already counts, so nothing is gained by comparing it deeper.
 */
function patch(sessionId: SessionId, projectId: ProjectId | null, delta: Partial<SessionRuntime>) {
  const prev = runtime(sessionId, projectId);
  let moved = false;
  let rendered = false;
  for (const key of Object.keys(delta) as (keyof SessionRuntime)[]) {
    if (Object.is(delta[key], prev[key])) continue;
    moved = true;
    if (!CURSOR_FIELDS.has(key)) { rendered = true; break; }
  }
  if (!moved) return;
  sessions.set(sessionId, { ...prev, ...delta });
  if (rendered) stateDirty = true;
  else cursorsDirty = true;
}

/* ---------------------------------------------------------------- signals */

function applySignal(env: Envelope, projectId: ProjectId | null): void {
  const id = env.session_id;
  const e = env.event;
  // Every envelope in `batch.signals` is a signal, and every signal advances `lastEventSeq`, so
  // this is the frame's "the event stream moved" edge — what wakes a `subscribe` callback reading
  // `getSessionCursor`. It is not a claim that the snapshot moved; `notify` on it is a no-op for a
  // `useSyncExternalStore` consumer whose snapshot came back `Object.is`-equal.
  signalsDirty = true;
  switch (e.type) {
    case "usage-windows":
      // Off the snapshot (see `usageWindows`), but still a signal: `lastEventSeq` advances like
      // every other signal's, and `signalsDirty` above is what wakes the gauge's subscriber.
      patch(id, projectId, { lastEventSeq: env.seq });
      recordUsageWindows(id, e.windows);
      break;
    case "session-started":
      // Open, deliberately left alone (2026-09-10): `system/init` arrives **once per turn**
      // (`docs/STATUS.md` §7), so `startedAtMs` is re-stamped every turn and `StoreState.order`
      // therefore means "whoever spoke last", not the "newest start first" it documents — a
      // user-visible sidebar ordering question, not a performance one, so it is not changed here.
      patch(id, projectId, {
        status: "running",
        model: e.model,
        instanceId: env.instance_id,
        cwd: e.cwd,
        providerSessionId: e.provider_session_id,
        // A resumed child announcing itself is live again: the previous end is history.
        endedAtMs: null,
        exitCode: null,
        startedAtMs: env.at,
        lastEventSeq: env.seq,
      });
      break;
    case "session-exited":
      patch(id, projectId, {
        status:
          e.reason === "graceful" ? "exited" : e.reason === "killed" ? "exited" : "failed",
        busy: false,
        endedAtMs: env.at,
        exitCode: e.exit_code,
        lastEventSeq: env.seq,
      });
      break;
    case "turn-started":
      patch(id, projectId, { busy: true, lastTurnId: e.turn_id, lastStop: null, lastEventSeq: env.seq });
      break;
    case "turn-completed":
      patch(id, projectId, {
        busy: false,
        lastTurnId: e.turn_id,
        lastStop: typeof e.stop_reason === "string" ? e.stop_reason : JSON.stringify(e.stop_reason),
        // Cumulative across the session, read from the latest turn, never summed.
        costUsd: e.cost_usd_cumulative,
        usage: e.usage,
        lastEventSeq: env.seq,
      });
      break;
    case "turn-aborted":
      // `AbortReason` uses the same bare-string/`{error}` encoding as `StopReason` above, and
      // its two abort-only bare values ("interrupted", "killed") never collide with a
      // `StopReason` variant — so `lastStop` can carry either terminal reason through the same
      // field, and the interruption is a live signal (`threadProjection.ts`) before the
      // persisted turn record lands.
      patch(id, projectId, {
        busy: false,
        lastStop: typeof e.reason === "string" ? e.reason : JSON.stringify(e.reason),
        lastEventSeq: env.seq,
      });
      break;
    case "request-opened":
      approvals.set(e.request_id, {
        requestId: e.request_id,
        sessionId: id,
        openedAtMs: env.at,
        kind: e.kind,
        expired: false,
      });
      runtime(id, projectId);
      stateDirty = true;
      break;
    case "request-resolved":
      if (approvals.delete(e.request_id)) stateDirty = true;
      break;
    case "session-compacted":
      // Unprefixed, unlike the `warning:` and `error:` lines below: a compaction is ordinary
      // housekeeping. Phrased about the response rather than the session, because only one
      // response's own tool output can reach a compaction here — every user message spawns a
      // fresh child (`docs/research/does-a-session-accumulate-2026-09-11.md` §0).
      patch(id, projectId, {
        lastMessage: `response context compacted (${e.trigger})`,
        lastEventSeq: env.seq,
      });
      break;
    case "runtime-warning":
      // The edge the plan card refetches `current_run` on; see `StoreState.runtimeWarnings`.
      // `runtimeWarnings` lives outside the session runtimes, so `patch` cannot see it move: a
      // second warning with the identical text would otherwise be classed cursor-only and the
      // plan card would miss its edge until the next flush.
      runtimeWarnings += 1;
      stateDirty = true;
      patch(id, projectId, { lastMessage: `warning: ${e.message}`, lastEventSeq: env.seq });
      break;
    case "runtime-error": {
      const delta: Partial<SessionRuntime> = {
        lastMessage: `error: ${e.message}`,
        lastEventSeq: env.seq,
      };
      // Only a fatal error is a status change; a non-fatal one leaves the session running.
      if (e.fatal) delta.status = "failed";
      patch(id, projectId, delta);
      break;
    }
    default:
      // Non-signal events never reach the signals array; if one does it is simply a row.
      break;
  }
}

/* ----------------------------------------------------------------- drain */

// Final buffered batches and in-flight fetches must not resurrect a deleted sidebar row.
const deletedSessions = new Set<SessionId>();
const deletedProjects = new Set<ProjectId>();

function applyBatch(batch: FeedBatch): void {
  const projectId = batch.project_id;
  if (deletedProjects.has(projectId)) return;
  if (deletedSessions.size > 0) batch = {
    ...batch,
    rows: batch.rows.filter(row => !deletedSessions.has(row.s)),
    signals: batch.signals.filter(signal => !deletedSessions.has(signal.session_id)),
    counters: batch.counters.filter(counter => !deletedSessions.has(counter.session_id)),
  };

  // A batch for a project the sidebar has never listed. Record it once; `App` re-fetches
  // `list_projects` so the project (and its sessions) become selectable. Rows for it are
  // otherwise invisible — the Rust batcher only sends counters and signals for a project that
  // is not in `set_visible_projects`, which is exactly what `burn` produced.
  if (!knownProjects.has(projectId) && !unknownProjects.has(projectId)) {
    unknownProjects.add(projectId);
    unknownList = [...unknownProjects];
    stateDirty = true;
  }

  if (batch.rows.length > 0) {
    rowsChanged = true;
    ingest.rowsIn += batch.rows.length;
    ingest.rowsInWindow += batch.rows.length;
    appendRows(ringFor(projectRows, projectId), batch.rows, 0, batch.rows.length);

    // Group by session so each touched session's snapshot is invalidated exactly once. The run is
    // copied into the ring by index; the `batch.rows.slice(runStart, i)` this used to build was
    // one more short-lived array per run per frame.
    let runStart = 0;
    for (let i = 1; i <= batch.rows.length; i++) {
      const boundary = i === batch.rows.length || batch.rows[i]!.s !== batch.rows[runStart]!.s;
      if (!boundary) continue;
      const id = batch.rows[runStart]!.s;
      appendRows(ringFor(sessionRows, id), batch.rows, runStart, i);
      runtime(id, projectId);
      runStart = i;
    }
  }

  for (const env of batch.signals) applySignal(env, projectId);

  for (const c of batch.counters) {
    const prev = runtime(c.session_id, projectId);
    if (prev.rowsTotal !== c.rows_total || prev.rowsDropped !== c.rows_dropped) {
      sessions.set(c.session_id, {
        ...prev,
        rowsTotal: c.rows_total,
        rowsDropped: c.rows_dropped,
      });
      countersDirty = true;
    }
    // `deltas` is optional on the mirror so counter literals that predate the Rust field still
    // type-check, and a non-finite value is refused outright: `NaN !== NaN` would mark the store
    // dirty and notify on every frame, for ever.
    const deltas =
      typeof c.deltas === "number" && Number.isFinite(c.deltas) ? c.deltas : 0;
    if ((sessionDeltas.get(c.session_id) ?? 0) !== deltas) {
      sessionDeltas.set(c.session_id, deltas);
      // A grown body must reach the transcript at frame resolution, not at the counters' 500 ms
      // fold: this wakes `subscribe` (and so `useConversationHistory`'s cursor read) without
      // rebuilding the snapshot at all. `countersDirty` deliberately stays silent —
      // `src/feedStore.test.ts` "are throttled to COUNTER_FLUSH_MS" pins a held counter as such.
      deltasDirty = true;
    }
  }
}

/** Element-wise identity compare. Both arrays are short: sessions in a window, open approvals. */
function same<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Rebuild the React snapshot from the live map.
 *
 * `order` and `approvals` keep the previous array when the rebuild produced the same elements in
 * the same sequence — the same rule `getSessionRows`/`getProjectRows` already follow, so a
 * consumer that memoises on `state.order` is not invalidated by a rebuild that was about one
 * session's `busy`. `sessions` is a fresh record every time: a rebuild only happens because some
 * runtime in it was replaced.
 */
function rebuildState(): void {
  countDiagnostic("stateRebuild");
  const record: Record<SessionId, SessionRuntime> = {};
  for (const [id, r] of sessions) record[id] = r;
  const order = [...sessions.values()]
    .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))
    .map((r) => r.sessionId);
  const open = [...approvals.values()].sort((a, b) => a.openedAtMs - b.openedAtMs);
  state = {
    version: state.version + 1,
    sessions: record,
    order: same(order, state.order) ? state.order : order,
    approvals: same(open, state.approvals) ? state.approvals : open,
    unknownProjects: unknownList,
    runtimeWarnings,
  };
}

let rafId = 0;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;
/**
 * What the loop currently has armed, and the whole idle rule (2026-09-11, plan review B3).
 *
 *   - `"work"` — a `requestAnimationFrame` **and** the `DRAIN_FALLBACK_MS` timer, exactly as the
 *     loop used to arm unconditionally. Armed by `pushBatch` on the idle->busy edge and by
 *     `rearm()` while anything is still pending.
 *   - `"fold"` — one `setTimeout` for the remainder of the `COUNTER_FLUSH_MS` window, and nothing
 *     else. The only work it can have to do is folding cursors and counters into the snapshot.
 *   - `"none"` — nothing is armed. This is what an idle window now costs: zero wakeups, where the
 *     old `scheduleDrain()`/`drain()` pair re-armed both timers on every drain and woke the store
 *     ~64 times a second for the life of the app with an empty buffer.
 */
let armed: "none" | "work" | "fold" = "none";
/** See `setFrameSampling`. Off except while a frame-meter capture is open. */
let frameSampling = false;
/** WKWebView pauses animation frames when occluded; see `armWork`. */
const DRAIN_FALLBACK_MS = 250;
const PROFILE_DRAIN = new URLSearchParams(location.search).has("profile");

/**
 * Rows changing does not change `state` (the rings live outside it), so the loop still has to
 * wake the panes that read a ring. Set by `applyBatch`.
 */
let rowsChanged = false;

function drain(timestamp?: number): void {
  if (!running) return;
  const workStarted = PROFILE_DRAIN ? performance.now() : 0;
  // Whichever of the two fired, its twin is cancelled. `rearm()` in the `finally` decides whether
  // anything goes back on, so an exception in `applyBatch` cannot leave the loop unarmed — which
  // is the property the old "re-arm before the work" line bought.
  disarm();
  try {
    drainOnce(timestamp);
  } finally {
    rearm();
  }
  // `drain_worst_ms` now includes the re-arm — two scheduler calls at most — because that is part
  // of what a wakeup costs. It is a diagnostic, not a gate.
  if (PROFILE_DRAIN) fps.recordDrain(performance.now() - workStarted);
}

function drainOnce(timestamp?: number): void {
  if (buffer.length > 0) {
    const batches = buffer;
    buffer = [];
    ingest.batches += batches.length;
    ingest.batchesInWindow += batches.length;
    // Traced before the work, so this entry's `t` is where the drain starts and the next entry
    // bounds it. `d` is rows delivered; `applyBatch` still drops rows for a deleted session.
    if (profiling) traceEvent("drain", batches.reduce((n, b) => n + b.rows.length, 0));
    for (const b of batches) applyBatch(b);
  } else if (profiling) traceEvent("drain", 0);

  const now = performance.now();
  if (ingest.windowStart === 0) ingest.windowStart = now;
  // Cursors ride the counters' clock: both are per-event numbers, neither is drawn, and folding
  // them on the same tick bounds how far `state.sessions[id].lastEventSeq` may trail the stream at
  // `COUNTER_FLUSH_MS`. That bound is what `useAttention`'s badge and `SubagentsPanel`'s
  // acknowledgement inherit; `scripts/measure-native-burn.py:104` reads the terminal sequence off
  // the snapshot too, and `session-exited` is a status change, so it rebuilds on its own frame.
  const foldCursors = (countersDirty || cursorsDirty) && now - lastCounterFlush >= COUNTER_FLUSH_MS;
  if (stateDirty || foldCursors) {
    if (countersDirty || cursorsDirty) lastCounterFlush = now;
    stateDirty = false;
    countersDirty = false;
    cursorsDirty = false;
    rebuildState();
    if (profiling) traceEvent("notify", listeners.size);
    notify();
  } else if (signalsDirty || rowsChanged || deltasDirty) {
    if (profiling) traceEvent("notify", listeners.size);
    notify();
  }
  signalsDirty = false;
  deltasDirty = false;
  rowsChanged = false;

  if (now - ingest.windowStart >= 1000) {
    ingest.rowsInWindow = 0;
    ingest.batchesInWindow = 0;
    ingest.windowStart = now;
  }

  if (timestamp !== undefined) {
    fps.sampleFrame(timestamp);
    // rAF only: the 250 ms fallback is an ordinary timer, so its reply would not straddle a
    // rendering update. Posted last, so the delta covers everything after this callback returns.
    if (profiling) markRenderUpdate();
  }
}

/**
 * Full-rate arm: one animation frame **and** the fallback timer, both live at once.
 *
 * The fallback is not redundant. WKWebView pauses animation frames when the window is occluded,
 * and an approval or turn signal must still land — `docs/vision.md` §9 forbids an optimistic
 * card, so the card's arrival is the signal's arrival. Both stay armed for as long as there is
 * pending work, which is what the loop did unconditionally before this change.
 *
 * **What this cost an occluded approval.** The old loop re-armed the fallback every drain, so a
 * batch arriving into an occluded window landed on a timer that was already part-way through its
 * `DRAIN_FALLBACK_MS` — a uniform 0-250 ms wait, ~125 ms on average. The timer is now started by
 * the arrival itself, so that wait is a fixed ~250 ms: the worst case is unchanged and the average
 * roughly doubles. Still inside the documented bound, and it buys an idle window that wakes
 * nothing at all. **[not measured]** — arithmetic off the arming rule, not a timed occluded run.
 */
function armWork(): void {
  if (armed === "work") return;
  if (armed === "fold") { clearTimeout(drainTimer); drainTimer = undefined; }
  rafId = requestAnimationFrame(timestamp => drain(timestamp));
  drainTimer = setTimeout(() => drain(), DRAIN_FALLBACK_MS);
  armed = "work";
}

/**
 * Fold-only arm: one timer for the rest of the `COUNTER_FLUSH_MS` window, no animation frame.
 *
 * This is the tick the 500 ms fold needs and the only one it needs. A counters-only or
 * cursor-only delta is applied to the live map at once and owes React a snapshot no later than
 * `COUNTER_FLUSH_MS` after the last flush; the deadline is known, so it is a deadline, not a
 * poll. It is armed only when such a delta is actually outstanding — no live-session tick, no
 * pending-counter heartbeat — and the drain that services it clears both flags, so it never
 * re-arms itself. A push arriving first upgrades it to `armWork` and the fold rides that frame.
 */
function armFold(delayMs: number): void {
  if (armed !== "none") return;
  drainTimer = setTimeout(() => drain(), delayMs);
  armed = "fold";
}

function disarm(): void {
  if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; }
  if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined; }
  armed = "none";
}

/** Anything the loop still owes a consumer. Checked at `start()` and after every drain. */
function pending(): boolean {
  return buffer.length > 0 || stateDirty || countersDirty || cursorsDirty || signalsDirty || rowsChanged
    || deltasDirty;
}

/**
 * Decide what the loop is allowed to hold after a drain (or at `start()`).
 *
 * Work pending -> full rate. Only a cursor or counter pending -> one timer at its deadline.
 * Nothing pending -> nothing armed, and the next `pushBatch` is what wakes the store again.
 */
function rearm(): void {
  if (!running) return;
  if (frameSampling) { armWork(); return; }
  // `deltasDirty` is normally false here — it is set and cleared inside the same `drainOnce` —
  // but it is enumerated with the others so a throw out of `applyBatch` cannot strand a grown
  // body with nothing armed to notify it (2026-09-11 merge: the flag postdates `rearm`).
  if (buffer.length > 0 || stateDirty || signalsDirty || rowsChanged || deltasDirty) { armWork(); return; }
  if (countersDirty || cursorsDirty) {
    const due = lastCounterFlush + COUNTER_FLUSH_MS - performance.now();
    armFold(due > 0 ? due : 0);
  }
}

/**
 * Keep an animation frame armed every frame even with nothing to drain, for exactly as long as a
 * frame-meter capture is open.
 *
 * `src/fps.ts` derives the frame meter — and with it the burn's dropped-vsync gate — from the rAF
 * timestamps this loop hands it, so a window that stops asking for frames reads as a window that
 * missed them: one idle second becomes ~60 dropped vsyncs in the next report. The burn brackets
 * its capture with idle time at both ends (`src/components/Burn.tsx`: `startCapture()` before the
 * sessions exist, and a 1.2 s tail after the run), and that idle time is part of what it measures.
 *
 * The window is the **capture**, not the build. `fps.startCapture()` calls this with `true` and
 * `fps.stopCapture()` with `false`, through the registration on the line below; no build-time flag
 * reaches it any more. Dev, burn and release builds are therefore all idle-silent whenever no
 * capture is open, which is what lets a burn measure the idle change instead of being the reason
 * it is switched off. The meter still reads this loop's own frame timestamps, so the quantity it
 * reports is the one it always reported. **[not measured]** no burn has been run against this.
 */
export function setFrameSampling(on: boolean): void {
  if (frameSampling === on) return;
  frameSampling = on;
  if (!running) return;
  if (on) armWork();
  else if (!pending()) disarm();
}

fps.setFrameSource(setFrameSampling);

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * Start the loop. Idempotent, so React StrictMode's double-invoked mount effect arms nothing
 * twice; the second `start()` returns on the `running` guard and the pair `start`/`stop`/`start`
 * leaves exactly one arming behind.
 *
 * Nothing is armed unless something is already pending: batches that arrived before the start
 * (the Channel is opened on the same line in `src/App.tsx`) are drained on the frame after this,
 * and a start with an empty buffer costs one boolean.
 */
export function start(): void {
  if (running) return;
  running = true;
  rearm();
}

/** Stop the loop (tests, teardown). */
export function stop(): void {
  running = false;
  disarm();
}

/* ------------------------------------------------------------- snapshots */

/** Module-scope, as `useSyncExternalStore` requires: a new `subscribe` re-subscribes. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * The React snapshot. Identity-stable across a frame in which nothing a consumer renders moved —
 * see the header — so `useSyncExternalStore(subscribe, getState)` schedules nothing on such a
 * frame even though `subscribe` was notified. A `CURSOR_FIELDS` value inside it may trail the
 * live event stream by up to `COUNTER_FLUSH_MS`; read `getSessionCursor` when that matters.
 */
export function getState(): StoreState {
  return state;
}

/**
 * A change token for one session at the resolution of the **event stream**, not of the snapshot:
 * `${rowsTotal}:${lastEventSeq}:${busy}|${deltas}` read straight off the live map the drain
 * writes, so it moves on the frame an event lands whether or not that event rebuilt `state`.
 *
 * `deltas` is why a streaming body reaches the transcript at all: a content delta produces no
 * feed row and no signal (`crates/store/src/feed.rs`, `crates/supervisor/src/batcher.rs`), so
 * without it the first three fields hold still for the whole of a long answer and no refetch is
 * ever scheduled (§4.2 of `docs/plans/codex-thread-rebuild-2026-09-11.md`).
 *
 * **Why `|` and not a fourth `:` field**, which is what §4.2.2 writes: `src/attention.ts`'s
 * `liveEventSeq` reads `lastEventSeq` positionally, as the text between the *first* and the
 * *last* colon. A fourth colon-separated field makes that `Number("21:0")` → `NaN` → `-1`, and a
 * read marker that lands on `-1` turns the unread dot back on for a conversation the operator just
 * read (`src/attention.test.ts`, `src/components/SubagentsPanel.test.tsx` both catch it). That
 * file is not this phase's to edit. Give `liveEventSeq` a real parse and this can become the
 * plain fourth field the plan describes.
 *
 * `src/hooks/useConversationHistory.ts` is the caller, from inside its `store.subscribe` callback.
 * **[measured]** the 60 Hz native benchmark records 534-544 history responses in 63 s
 * (`docs/performance/2026-09-10/live-history-release-burn-1.json`) and
 * `scripts/measure-native-burn.py:119` fails a run under 60; that count is a property of this
 * token's resolution, which is why it is read live. It is strictly finer than the snapshot it
 * replaced — `rowsTotal` reaches the live map on the frame the counter arrives and the snapshot
 * only every `COUNTER_FLUSH_MS`.
 *
 * **Never call this during a render.** It returns a string, so it carries no identity React can
 * render on, and the map it reads is mutated by the drain outside React's knowledge.
 */
export function getSessionCursor(sessionId: SessionId): string {
  const s = sessions.get(sessionId);
  return s === undefined
    ? ""
    : `${s.rowsTotal}:${s.lastEventSeq}:${s.busy}|${sessionDeltas.get(sessionId) ?? 0}`;
}

export function getSessionRows(sessionId: SessionId | null): readonly FeedRowWire[] {
  if (sessionId === null) return EMPTY_ROWS;
  return readRing(sessionRows.get(sessionId));
}

export function getProjectRows(projectId: ProjectId | null): readonly FeedRowWire[] {
  if (projectId === null) return EMPTY_ROWS;
  return readRing(projectRows.get(projectId));
}

/**
 * How many rows a session's ring would hand out, without handing them out. `buf` is clamped to
 * `ROW_CAP` because it may be carrying up to `RING_SLACK` rows that have already fallen off the
 * head, so this is the *logically visible* count and always equals `getSessionRows(id).length`.
 *
 * It exists for `src/App.tsx`'s paint-span check, which asks a yes/no question and would otherwise
 * materialise a 2,000-element snapshot to answer it. Not a substitute for `getSessionRows` in a
 * React read: it returns a number, so it cannot carry the identity the panes re-render on.
 */
export function getSessionRowCount(sessionId: SessionId | null): number {
  if (sessionId === null) return 0;
  const ring = sessionRows.get(sessionId);
  if (ring === undefined) return 0;
  return ring.buf.length > ROW_CAP ? ROW_CAP : ring.buf.length;
}

export function getIngest(): { rowsIn: number; batches: number } {
  return { rowsIn: ingest.rowsIn, batches: ingest.batches };
}

/* ------------------------------------------------------------------ seeds */

/**
 * Tell the store which projects `list_projects` returned. Ids named here stop being "unknown",
 * so the re-fetch that resolved them is not asked for again.
 */
export function noteProjects(ids: readonly ProjectId[]): void {
  let changed = false;
  for (const id of ids) {
    knownProjects.add(id);
    if (unknownProjects.delete(id)) changed = true;
  }
  if (!changed) return;
  unknownList = unknownProjects.size === 0 ? EMPTY_PROJECT_IDS : [...unknownProjects];
  rebuildState();
  notify();
}

/** Fold `list_sessions` into the store without disturbing anything the feed already knows. */
export function seedSessions(views: SessionView[]): void {
  for (const v of views) {
    if (deletedSessions.has(v.session_id) || (v.project_id !== null && deletedProjects.has(v.project_id))) continue;
    const prev = sessions.get(v.session_id) ?? blank(v.session_id, v.project_id);
    // A view that says the session is live carries `ended_at_ms: null` / `exit_code: null` and
    // means it — that is exactly what `resume_session` returns for a session this store still
    // has an end time for. `??` would have kept the stale end and shown a live session as ended.
    const live = v.status === "starting" || v.status === "running";
    sessions.set(v.session_id, {
      ...prev,
      projectId: v.project_id ?? prev.projectId,
      status: v.status,
      model: v.model ?? prev.model,
      effort: v.effort ?? prev.effort,
      permissionMode: v.permission_mode ?? prev.permissionMode,
      cwd: v.cwd ?? prev.cwd,
      instanceId: v.instance_id ?? prev.instanceId,
      providerSessionId: v.provider_session_id ?? prev.providerSessionId,
      worktreePath: v.worktree_path ?? prev.worktreePath,
      branch: v.branch ?? prev.branch,
      costUsd: Math.max(prev.costUsd, v.cost_usd_cumulative),
      usage: v.usage,
      startedAtMs: v.started_at_ms ?? prev.startedAtMs,
      endedAtMs: live ? v.ended_at_ms : v.ended_at_ms ?? prev.endedAtMs,
      exitCode: live ? v.exit_code : v.exit_code ?? prev.exitCode,
      lastEventSeq: Math.max(prev.lastEventSeq, v.last_event_seq),
    });
  }
  rebuildState();
  notify();
}

/** A local presentation flag; effective permissions are restored by the backend. */
export function noteResumed(sessionId: SessionId): void {
  const prev = sessions.get(sessionId);
  if (prev === undefined || prev.resumed) return;
  sessions.set(sessionId, { ...prev, resumed: true });
  rebuildState();
  notify();
}

/**
 * `cleanup_worktree` came back `removed: true`. The checkout is gone, so the session's `cwd` no
 * longer exists and Resume must be taken away; the branch is untouched and stays on the row.
 */
export function noteWorktreeRemoved(sessionId: SessionId): void {
  const prev = sessions.get(sessionId);
  if (prev === undefined || prev.worktreeRemoved) return;
  sessions.set(sessionId, { ...prev, worktreeRemoved: true });
  rebuildState();
  notify();
}

/**
 * `delete_session` came back `removed: true`: the row is gone from the database, so it goes from
 * here too — the runtime, its ring of feed rows, and any approval that belonged to it.
 *
 * The approvals go with it because their rows were cascade-deleted on the Rust side
 * (`docs/plans/ipc-contract.md` §Deleting: `feed`, `approvals` and `intents` cascade from
 * `sessions`), so a card left on screen would be answerable against a request that no longer
 * exists. Project feed rows belonging to the deleted session are removed too.
 *
 * Idempotent, and returns whether anything went, so a caller can skip a re-render.
 */
export function dropSession(sessionId: SessionId): boolean {
  deletedSessions.add(sessionId);
  for (const ring of projectRows.values()) {
    // Filter the ring's **logical** rows, never `buf`: `buf` may be carrying up to `RING_SLACK`
    // rows that already fell off the head, and a filter that took `buf.length` back under
    // `ROW_CAP` would hand every one of them back to the next reader — the project feed jumping
    // backwards in time on a delete.
    const visible = ring.buf.length > ROW_CAP ? ring.buf.slice(ring.buf.length - ROW_CAP) : ring.buf;
    const kept = visible.filter(row => row.s !== sessionId);
    if (kept.length === visible.length) continue;
    // The cached snapshot still holds the deleted session's rows; it goes with the buffer.
    ring.buf = kept;
    ring.snap = null;
  }
  const had = sessions.delete(sessionId);
  sessionRows.delete(sessionId);
  usageWindows.delete(sessionId);
  sessionDeltas.delete(sessionId);
  let dropped = had;
  for (const [id, a] of approvals) {
    if (a.sessionId === sessionId && approvals.delete(id)) dropped = true;
  }
  if (!dropped) return false;
  rebuildState();
  notify();
  return true;
}

/**
 * `delete_project` came back `removed: true`: every session under it went with it, so every
 * runtime this store holds for that project goes too, plus the project's own row ring.
 *
 * The sessions are found by `projectId` on the runtime rather than from a list the caller passes,
 * because the store is the only place that knows which sessions the feed has mentioned — a
 * session created behind the UI's back is in here and not in `list_sessions`'s last answer.
 */
export function dropProject(projectId: ProjectId): boolean {
  deletedProjects.add(projectId);
  const own = [...sessions.values()].filter((s) => s.projectId === projectId);
  let dropped = false;
  for (const s of own) {
    deletedSessions.add(s.sessionId);
    sessions.delete(s.sessionId);
    sessionRows.delete(s.sessionId);
    usageWindows.delete(s.sessionId);
    sessionDeltas.delete(s.sessionId);
    dropped = true;
    for (const [id, a] of approvals) {
      if (a.sessionId === s.sessionId) approvals.delete(id);
    }
  }
  projectRows.delete(projectId);
  if (knownProjects.delete(projectId)) dropped = true;
  if (unknownProjects.delete(projectId)) {
    unknownList = unknownProjects.size === 0 ? EMPTY_PROJECT_IDS : [...unknownProjects];
    dropped = true;
  }
  if (!dropped) return false;
  rebuildState();
  notify();
  return true;
}

/**
 * Fold `pending_approvals` in; `expired` rows are read-only survivors of a previous run.
 *
 * `ApprovalView.resolved` is **not** read: the Rust query behind `pending_approvals` filters
 * `resolved_at IS NULL` (`crates/supervisor/src/lib.rs:461-472`,
 * `crates/store/src/writer.rs:238-247`), so the field is structurally always `false` and the
 * guard that used to stand here could never fire (`docs/research/approvals.md` §7 gap 6). The
 * field stays on the wire type for shape stability.
 *
 * Keyed by `request_id`, so a second call — React StrictMode double-mounts the effect that
 * fetches, and a live `request-opened` may have landed first — overwrites rather than
 * duplicates.
 */
export function seedApprovals(views: ApprovalView[]): void {
  for (const v of views) {
    if (deletedSessions.has(v.session_id)) continue;
    approvals.set(v.request_id, {
      requestId: v.request_id,
      sessionId: v.session_id,
      openedAtMs: v.opened_at_ms,
      kind: v.kind,
      expired: v.expired,
    });
  }
  rebuildState();
  notify();
}

/** Drop one approval locally, for an expired row the operator dismissed. */
export function dismissApproval(requestId: string): void {
  if (approvals.delete(requestId)) {
    rebuildState();
    notify();
  }
}

/**
 * Prefill a session's ring from `feed_tail`, **merging** with whatever the live feed already put
 * there. The fetch and the subscription race on every session open: guarding on "only fill an
 * empty ring" threw the whole backlog away whenever the first live batch won, and the operator
 * saw only what arrived after they clicked, with nothing on screen saying so.
 *
 * The merge key is `q` (the envelope `seq`). It is a total order per session and it is unique:
 * `crates/store/src/schema.rs:88-94` declares `feed` as `PRIMARY KEY (session_id, seq)`, one
 * envelope yields at most one row (`crates/store/src/feed.rs:36,200`), and `seq` keeps climbing
 * across a resume (`docs/plans/ipc-contract.md` §resume_session). `Feed.tsx:70` already keys React
 * rows on `${s}#${q}` and so already assumes exactly this. Both inputs are ascending in `q` —
 * `feed_tail` returns oldest first (ipc-contract §Commands) and the batcher delivers rows "in seq
 * order per session" (§Feed channel), appended in arrival order by `appendRows` — so a two-pointer
 * merge reproduces the order the live path produces rather than inventing one. Ties keep the live
 * row: same `(session_id, seq)` is the same row, and keeping the live copy leaves the ring's
 * existing objects untouched.
 *
 * Consequences worth naming: re-seeding is now idempotent, so StrictMode's double-mounted effect
 * and the re-select after `resume_session` no longer duplicate anything; a seed that adds nothing
 * keeps the array reference and skips `notify`, so the pane does not re-render; and the union is
 * trimmed to the newest `ROW_CAP` from the head, exactly as `readRing` trims.
 *
 * The project ring is deliberately **not** seeded: interleaving several sessions' tails by `t`
 * would produce an ordering the live path never produces.
 */
export function seedRows(sessionId: SessionId, rows: FeedRowWire[]): void {
  if (deletedSessions.has(sessionId)) return;
  // The merge is against the ring's *logical* rows, so it reads the trimmed snapshot rather than
  // `buf`, which may still be carrying up to `RING_SLACK` rows that have already fallen off.
  const existing = readRing(sessionRows.get(sessionId));

  const merged: FeedRowWire[] = [];
  let seed = 0;
  let live = 0;
  let inserted = 0;
  while (seed < rows.length && live < existing.length) {
    const a = rows[seed]!;
    const b = existing[live]!;
    if (a.q < b.q) {
      merged.push(a);
      seed++;
      inserted++;
    } else if (a.q > b.q) {
      merged.push(b);
      live++;
    } else {
      merged.push(b);
      seed++;
      live++;
    }
  }
  for (; seed < rows.length; seed++) {
    merged.push(rows[seed]!);
    inserted++;
  }
  for (; live < existing.length; live++) merged.push(existing[live]!);

  // Nothing the ring did not already hold: keep its identity so the pane does not re-render.
  if (inserted === 0) return;

  const ring = ringFor(sessionRows, sessionId);
  ring.buf = merged.length > ROW_CAP ? merged.slice(merged.length - ROW_CAP) : merged;
  ring.snap = null;
  notify();
}
