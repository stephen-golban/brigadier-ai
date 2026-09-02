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
 *   - `getSessionRows` / `getProjectRows` / `getState` return cached references. A session whose
 *     rows did not change this frame keeps the identical array, so its pane does not re-render.
 *   - No `flushSync`, and the feed is never read inside `startTransition`: a store mutated 60
 *     times a second restarts every transition it is read in.
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
} from "./wire";

/** Rows kept in memory per session, and per project. Older rows fall off the head. */
export const ROW_CAP = 2000;

/** Counters move every frame; folding them into the snapshot that often would re-render the
 *  sidebar 60 times a second for numbers nobody can read. Signals commit immediately. */
const COUNTER_FLUSH_MS = 500;

const EMPTY_ROWS: readonly FeedRowWire[] = Object.freeze([]);
const EMPTY_PROJECT_IDS: readonly ProjectId[] = Object.freeze([]);

/* ------------------------------------------------------------------ state */

export interface SessionRuntime {
  sessionId: SessionId;
  projectId: ProjectId | null;
  status: SessionStatus;
  model: string | null;
  cwd: string | null;
  /** The provider's own conversation id; non-null is what makes a settled session resumable. */
  providerSessionId: string | null;
  /** Git worktree the child runs in, and its branch. Both null when the project is not a repo. */
  worktreePath: string | null;
  branch: string | null;
  /** `cleanup_worktree` came back `removed: true`: the checkout is gone, so resume would fail. */
  worktreeRemoved: boolean;
  /** This session was continued by `resume_session` in this window; the CLI came back in
   *  `default` permission mode whatever it was running in before (contract §resume_session). */
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
}

let buffer: FeedBatch[] = [];
const sessionRows = new Map<SessionId, FeedRowWire[]>();
const projectRows = new Map<ProjectId, FeedRowWire[]>();
const sessions = new Map<SessionId, SessionRuntime>();
const approvals = new Map<string, ApprovalItem>();
const listeners = new Set<() => void>();

/** Projects the UI has actually listed, and the ones only the feed has ever mentioned. */
const knownProjects = new Set<ProjectId>();
const unknownProjects = new Set<ProjectId>();
let unknownList: readonly ProjectId[] = EMPTY_PROJECT_IDS;

let state: StoreState = {
  version: 0,
  sessions: {},
  order: [],
  approvals: [],
  unknownProjects: unknownList,
};
let stateDirty = false;
let countersDirty = false;
let lastCounterFlush = 0;

/** Ingestion counters, for the meter overlay. Not part of the React snapshot. */
const ingest = { rowsIn: 0, batches: 0, rowsInWindow: 0, batchesInWindow: 0, windowStart: 0 };

/* --------------------------------------------------------------- channel */

/**
 * The Channel `onmessage`. Push and return; anything else here runs on the main thread inside
 * the eval'd script that delivered the message.
 */
export function pushBatch(batch: FeedBatch): void {
  buffer.push(batch);
}

/* ----------------------------------------------------------------- rings */

function appendRing<T>(prev: readonly T[] | undefined, add: readonly T[]): T[] {
  const next = prev === undefined || prev.length === 0 ? add.slice() : prev.concat(add);
  return next.length > ROW_CAP ? next.slice(next.length - ROW_CAP) : next;
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

function patch(sessionId: SessionId, projectId: ProjectId | null, delta: Partial<SessionRuntime>) {
  const prev = runtime(sessionId, projectId);
  sessions.set(sessionId, { ...prev, ...delta });
  stateDirty = true;
}

/* ---------------------------------------------------------------- signals */

function applySignal(env: Envelope, projectId: ProjectId | null): void {
  const id = env.session_id;
  const e = env.event;
  switch (e.type) {
    case "session-started":
      patch(id, projectId, {
        status: "running",
        model: e.model,
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
      patch(id, projectId, { busy: true, lastTurnId: e.turn_id, lastEventSeq: env.seq });
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
      patch(id, projectId, { busy: false, lastEventSeq: env.seq });
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
      patch(id, projectId, {
        lastMessage: `context compacted (${e.trigger})`,
        lastEventSeq: env.seq,
      });
      break;
    case "runtime-warning":
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

function applyBatch(batch: FeedBatch): void {
  const projectId = batch.project_id;

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
    projectRows.set(projectId, appendRing(projectRows.get(projectId), batch.rows));

    // Group by session so each touched session gets exactly one new array reference.
    let runStart = 0;
    for (let i = 1; i <= batch.rows.length; i++) {
      const boundary = i === batch.rows.length || batch.rows[i]!.s !== batch.rows[runStart]!.s;
      if (!boundary) continue;
      const id = batch.rows[runStart]!.s;
      const slice = batch.rows.slice(runStart, i);
      sessionRows.set(id, appendRing(sessionRows.get(id), slice));
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
  }
}

function rebuildState(): void {
  const record: Record<SessionId, SessionRuntime> = {};
  for (const [id, r] of sessions) record[id] = r;
  const order = [...sessions.values()]
    .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0))
    .map((r) => r.sessionId);
  state = {
    version: state.version + 1,
    sessions: record,
    order,
    approvals: [...approvals.values()].sort((a, b) => a.openedAtMs - b.openedAtMs),
    unknownProjects: unknownList,
  };
}

let rafId = 0;
let running = false;

/**
 * Rows changing does not change `state` (the rings live outside it), so the loop still has to
 * wake the panes that read a ring. Set by `applyBatch`.
 */
let rowsChanged = false;

function drain(): void {
  rafId = requestAnimationFrame(drain);

  if (buffer.length > 0) {
    const batches = buffer;
    buffer = [];
    ingest.batches += batches.length;
    ingest.batchesInWindow += batches.length;
    for (const b of batches) applyBatch(b);
  }

  const now = performance.now();
  if (ingest.windowStart === 0) ingest.windowStart = now;
  if (stateDirty || (countersDirty && now - lastCounterFlush >= COUNTER_FLUSH_MS)) {
    if (countersDirty) lastCounterFlush = now;
    stateDirty = false;
    countersDirty = false;
    rebuildState();
    notify();
  } else if (rowsChanged) {
    notify();
  }
  rowsChanged = false;

  if (now - ingest.windowStart >= 1000) {
    ingest.rowsInWindow = 0;
    ingest.batchesInWindow = 0;
    ingest.windowStart = now;
  }

  fps.sampleFrame();
}

function notify(): void {
  for (const cb of listeners) cb();
}

/** Start the single rAF loop. Idempotent. */
export function start(): void {
  if (running) return;
  running = true;
  rafId = requestAnimationFrame(drain);
}

/** Stop the loop (tests, teardown). */
export function stop(): void {
  running = false;
  cancelAnimationFrame(rafId);
}

/* ------------------------------------------------------------- snapshots */

/** Module-scope, as `useSyncExternalStore` requires: a new `subscribe` re-subscribes. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getState(): StoreState {
  return state;
}

export function getSessionRows(sessionId: SessionId | null): readonly FeedRowWire[] {
  if (sessionId === null) return EMPTY_ROWS;
  return sessionRows.get(sessionId) ?? EMPTY_ROWS;
}

export function getProjectRows(projectId: ProjectId | null): readonly FeedRowWire[] {
  if (projectId === null) return EMPTY_ROWS;
  return projectRows.get(projectId) ?? EMPTY_ROWS;
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
      cwd: v.cwd ?? prev.cwd,
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

/**
 * `resume_session` succeeded on this session. Only the window that pressed Resume knows — no
 * wire field records it — and it drives the "back in default permission mode" note.
 */
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
 * order per session" (§Feed channel), appended in arrival order by `appendRing` — so a two-pointer
 * merge reproduces the order the live path produces rather than inventing one. Ties keep the live
 * row: same `(session_id, seq)` is the same row, and keeping the live copy leaves the ring's
 * existing objects untouched.
 *
 * Consequences worth naming: re-seeding is now idempotent, so StrictMode's double-mounted effect
 * and the re-select after `resume_session` no longer duplicate anything; a seed that adds nothing
 * keeps the array reference and skips `notify`, so the pane does not re-render; and the union is
 * trimmed to the newest `ROW_CAP` from the head, exactly as `appendRing` trims.
 *
 * The project ring is deliberately **not** seeded: interleaving several sessions' tails by `t`
 * would produce an ordering the live path never produces.
 */
export function seedRows(sessionId: SessionId, rows: FeedRowWire[]): void {
  const existing = sessionRows.get(sessionId) ?? EMPTY_ROWS;

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

  sessionRows.set(
    sessionId,
    merged.length > ROW_CAP ? merged.slice(merged.length - ROW_CAP) : merged,
  );
  notify();
}
