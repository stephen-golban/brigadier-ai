/**
 * Wire types: the TypeScript mirror of the serde shapes crossing the Tauri boundary.
 *
 * Sources of truth, none of which may be guessed at:
 *   - `docs/plans/ipc-contract.md`         — command list, view structs, feed batch shape
 *   - `crates/core/src/event.rs`           — Envelope, Event, ItemKind, RequestKind, Usage,
 *                                            ExitReason, AbortReason, StopReason, CompactTrigger
 *   - `crates/core/src/session.rs`         — Decision
 *   - `crates/core/src/driver.rs`          — PermissionMode (a bare string on the wire)
 *   - `crates/supervisor/src/worktree.rs`  — WorktreeCleanup, CleanupBlocked
 *
 * Conventions taken from the contract:
 *   - internally-tagged enums carry `type` with kebab-case values;
 *   - externally-tagged Rust enums with unit variants are bare strings, tuple variants are
 *     `{ "error": "..." }` / `{ "other": "..." }`;
 *   - struct field names stay snake_case (serde renames variants, not fields);
 *   - timestamps are milliseconds since the Unix epoch, suffix `_ms`, except `Envelope.at`
 *     which is already millis via `#[serde(with = "millis")]` and keeps its bare name.
 */

/* ------------------------------------------------------------------ ids */

export type SessionId = string;
export type ProjectId = string;
export type RequestId = string;
export type TurnId = string;
export type InstanceId = string;
export type ItemId = string;

/* --------------------------------------------------- externally tagged */

/** `ExitReason` — unit variants bare, `Error(String)` as `{ error }`. */
export type ExitReason = "graceful" | "killed" | "crashed" | { error: string };

/** `AbortReason` — unit variants bare, `Error(String)` as `{ error }`. */
export type AbortReason = "interrupted" | "killed" | { error: string };

/** `StopReason` — unit variants bare, tuple variants as `{ error }` / `{ other }`. */
export type StopReason =
  | "end-turn"
  | "max-tokens"
  | "max-turns"
  | "refusal"
  | { error: string }
  | { other: string };

export type CompactTrigger = "manual" | "auto";

/** Render any of the three reason enums as one short string. */
export function reasonText(r: ExitReason | AbortReason | StopReason): string {
  if (typeof r === "string") return r;
  if ("error" in r) return `error: ${r.error}`;
  return r.other;
}

/* --------------------------------------------------- internally tagged */

export type ItemKind =
  | { type: "assistant-text" }
  | { type: "thinking" }
  | { type: "tool-call"; name: string }
  | { type: "tool-result"; tool_call_id: string; is_error: boolean }
  | { type: "user-text" }
  | {
      type: "subagent";
      task_id: string;
      subagent_type: string | null;
      description: string | null;
    };

export type RequestKind =
  | {
      type: "tool-permission";
      tool_name: string;
      /** Tool input JSON, already bounded by the core (`INPUT_EXCERPT_LIMIT`). */
      input_excerpt: string;
      /** Opaque provider permission updates; echoed back verbatim in `updated_permissions`. */
      suggestions: unknown[];
      tool_call_id: string | null;
    }
  | { type: "user-input"; prompt: string; options: string[] };

/** `crates/core/src/session.rs::Decision`. There is deliberately no `allow-always`. */
export type Decision =
  | { type: "allow"; updated_input: unknown | null; updated_permissions: unknown[] }
  | { type: "deny"; reason: string; interrupt: boolean };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  context_window: number | null;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  context_window: null,
};

export type Event =
  | {
      type: "session-started";
      provider_session_id: string;
      model: string;
      cwd: string;
      capabilities: string[];
      resume_token: string | null;
    }
  | { type: "session-exited"; reason: ExitReason; exit_code: number | null }
  | { type: "turn-started"; turn_id: TurnId }
  | {
      type: "turn-completed";
      turn_id: TurnId;
      stop_reason: StopReason;
      usage: Usage;
      cost_usd_cumulative: number;
    }
  | { type: "turn-aborted"; turn_id: TurnId; reason: AbortReason }
  | {
      type: "item-started";
      item_id: ItemId;
      kind: ItemKind;
      summary: string;
      parent_item_id: ItemId | null;
    }
  | {
      type: "item-updated";
      item_id: ItemId;
      kind: ItemKind;
      summary: string;
      parent_item_id: ItemId | null;
    }
  | {
      type: "item-completed";
      item_id: ItemId;
      kind: ItemKind;
      summary: string;
      parent_item_id: ItemId | null;
    }
  | { type: "content-delta"; item_id: ItemId; text: string }
  | { type: "request-opened"; request_id: RequestId; kind: RequestKind; turn_id: TurnId | null }
  | { type: "request-resolved"; request_id: RequestId; decision: Decision }
  | { type: "session-compacted"; trigger: CompactTrigger; pre_tokens: number | null }
  | { type: "runtime-warning"; message: string }
  | { type: "runtime-error"; message: string; fatal: boolean };

/** The event types the Rust side forwards as signals regardless of project visibility. */
export type SignalEventType =
  | "session-started"
  | "session-exited"
  | "turn-started"
  | "turn-completed"
  | "turn-aborted"
  | "request-opened"
  | "request-resolved"
  | "session-compacted"
  | "runtime-error"
  | "runtime-warning";

export interface Envelope {
  seq: number;
  /** Already milliseconds since the epoch (`#[serde(with = "millis")]`). */
  at: number;
  instance_id: InstanceId;
  session_id: SessionId;
  event: Event;
  /** Stripped on the signal path; never present in a `FeedBatch`. */
  raw?: string | null;
}

/* -------------------------------------------------------------- the feed */

/** Short-keyed terse row: `s`ession, se`q`, `t`ime (ms), `l`ine. */
export interface FeedRowWire {
  s: SessionId;
  q: number;
  t: number;
  l: string;
}

export interface SessionCounter {
  session_id: SessionId;
  rows_total: number;
  rows_dropped: number;
}

export interface FeedBatch {
  project_id: ProjectId;
  rows: FeedRowWire[];
  signals: Envelope[];
  counters: SessionCounter[];
}

/** The Rust batcher's own ceiling; the mock obeys it so both paths look the same. */
export const MAX_ROWS_PER_BATCH = 24;

/* ------------------------------------------------------------ view types */

export interface AppInfo {
  run_id: string;
  data_dir: string;
  version: string;
}

export interface ClaudeStatus {
  binary: string;
  version: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  default: boolean;
}

export interface ProjectView {
  id: ProjectId;
  name: string;
  root_path: string;
  created_at_ms: number;
}

export type SessionStatus = "starting" | "running" | "exited" | "failed";

export interface SessionView {
  session_id: SessionId;
  project_id: ProjectId | null;
  instance_id: InstanceId | null;
  provider_session_id: string | null;
  cwd: string | null;
  /** The session's git worktree, or null when the project is not a git repo (contract §Worktrees).
   *  `cwd === worktree_path` whenever a worktree exists. */
  worktree_path: string | null;
  /** `brigadier/<8 hex>`, or null with no worktree. Rendered instead of the path. */
  branch: string | null;
  model: string | null;
  status: SessionStatus;
  started_at_ms: number | null;
  ended_at_ms: number | null;
  exit_code: number | null;
  last_event_seq: number;
  usage: Usage;
  cost_usd_cumulative: number;
}

/**
 * `CleanupBlocked` — why a cleanup refused. A unit-variant Rust enum with
 * `#[serde(rename_all = "snake_case")]`, so it crosses the wire as a bare string
 * (`crates/supervisor/src/worktree.rs:66`). Every variant is a refusal, never an authorization.
 *
 * The union is deliberately closed: an unmodelled reason must be a type error at the one place
 * that renders these, not a blank sentence in the dock.
 */
export type CleanupBlocked =
  /** Modified, untracked or ignored entries would be discarded. **`force` answers it.** */
  | "dirty"
  /** Commits reachable from this `HEAD` and from no other branch, tag or remote.
   *  **`force` answers it**, and the branch still survives. */
  | "commits"
  /** `git worktree list` reports a different branch, or a detached `HEAD`, than the session row.
   *  **`force` answers it**, and then removes whatever is actually checked out. */
  | "branch_moved"
  /** The directory is not a registered worktree of this repository. **`force` does not reach
   *  this**: git will refuse too, and brigadier does not `rm -rf` what git cannot describe. */
  | "unregistered"
  /** A `git worktree lock` is held on it. **`force` does not reach this**: only `remove -f -f`
   *  clears a lock, and a lock is another process's claim. */
  | "locked"
  /** `git worktree remove` exited 0 and the directory is still there. **`force` does not reach
   *  this**: the remove already ran. */
  | "left_on_disk";

/**
 * `cleanup_worktree`'s answer (`crates/supervisor/src/worktree.rs:106`).
 *
 * `removed: false` with a non-null `blocked` means **nothing was touched**; `blocked` says why,
 * and only `dirty`, `commits` and `branch_moved` are answered by calling again
 * with `force: true` (`crates/supervisor/src/worktree.rs:483-513` is the `!force` guard that
 * decides it). The branch always survives — no cleanup path deletes one.
 */
export interface WorktreeCleanup {
  /** Only true once the path is confirmed gone from disk; git's exit code alone is not proof. */
  removed: boolean;
  /** `git status --porcelain --ignored=matching -uall` lines. Counts ignored files too. */
  dirty_files: number;
  /** Commits reachable from this worktree's `HEAD` and from no other branch, tag or remote. */
  commits: number;
  /** The session's branch. Survives every cleanup path. */
  branch: string;
  /** What git says is checked out there now; `null` for a detached `HEAD`. Where this disagrees
   *  with `branch`, this is the trustworthy answer. */
  live_branch: string | null;
  /** Why nothing was removed, or `null`. */
  blocked: CleanupBlocked | null;
}

export interface ApprovalView {
  request_id: RequestId;
  session_id: SessionId;
  opened_at_ms: number;
  /** Null when the store could not decode the persisted kind — an oversized kind JSON is
   *  replaced by a placeholder. Such a row is read-only apart from Deny. */
  kind: RequestKind | null;
  /** True when the row was opened under a previous `run_id`; it can only be dismissed. */
  expired: boolean;
  resolved: boolean;
}

export interface FrameStats {
  window_start_ms: number;
  hz: number;
  frames: number;
  dropped: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  worst_ms: number;
  longest_drop_run: number;
  dom_nodes: number;
}

/**
 * One paint the page timed, for `report_paint`. Mirrors the Rust enum in
 * `src-tauri/src/views.rs`: internally tagged on `"kind"`, snake_case, every number an `f64`.
 *
 * `fcp` is `performance.timeOrigin + entry.startTime` of the `first-contentful-paint` entry —
 * there is no `first-paint` entry in this WebKit. `interaction` is one mark → double-rAF →
 * measure span, whose `label` names the budget it belongs to.
 */
export type PaintReport =
  | { kind: "fcp"; epoch_ms: number }
  | { kind: "interaction"; label: string; start_epoch_ms: number; duration_ms: number };

/* ------------------------------------------------------- permission mode */

/**
 * `PermissionMode` is a bare string on the wire, and an unmodelled value passes through
 * verbatim, so the union stays open.
 */
export type KnownPermissionMode = "default" | "accept-edits" | "plan" | "bypass-permissions";
export type PermissionMode = KnownPermissionMode | (string & {});

/**
 * What the UI offers. `bypass-permissions` is deliberately absent: it silently disables the
 * approval path (`crates/core/src/driver.rs:92`), so it is not a menu item.
 */
export const OFFERED_PERMISSION_MODES: KnownPermissionMode[] = ["default", "accept-edits", "plan"];

/* ------------------------------------------------------------- app error */

/** `AppError` serializes as `{ code, message }`. */
export interface AppErrorShape {
  code: string;
  message: string;
}

export const CLAUDE_MISSING_CODES = ["claude_not_installed", "claude_too_old"];

/** Every command rejects with one of these; `code` is the contract's error code. */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

function isAppErrorShape(v: unknown): v is AppErrorShape {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { code?: unknown }).code === "string" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}

/** Normalise whatever a rejected `invoke` produced into an `AppError`. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isAppErrorShape(e)) return new AppError(e.code, e.message);
  if (e instanceof Error) return new AppError("io", e.message);
  return new AppError("io", String(e));
}
