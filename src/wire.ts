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
  | {
      type: "tool-result";
      tool_call_id: string;
      /**
       * True for a failure, **and** for an interrupt, **and** for a rejected tool use. It is
       * never on its own evidence that a command failed, and never the source of an exit code.
       */
      is_error: boolean;
      /**
       * Parsed by Rust from the literal first line `Exit code N\n` of the tool result body —
       * the only carrier of a shell exit code anywhere on the wire. Absent when the body has no
       * such line, which is every successful command and every non-shell tool.
       *
       * **TypeScript never parses a tool body.** Optional so a build that predates the Rust
       * change still type-checks; until it lands the UI leaves the exit code undefined.
       */
      exit_code?: number | null;
      /** The operator stopped or rejected this tool use. Renders as *You stopped*, not a failure. */
      interrupted?: boolean;
    }
  | { type: "user-text" }
  | {
      type: "subagent";
      task_id: string;
      subagent_type: string | null;
      description: string | null;
    }
  | {
      /**
       * A lifecycle note the Rust store synthesises so the thread can show it inline. No adapter
       * emits one: `brigadier_store::chat::project` mints it from the matching event with a
       * deterministic id, so a replay cannot duplicate it.
       */
      type: "notice";
      level: NoticeLevel;
      /**
       * What happened: `compacted`, `compact-failed`, `runtime`, `exited`. Open — render an
       * unknown code as text.
       */
      code: string;
      /**
       * `CompactedNoticeDetail` on `compacted`, `CompactFailedNoticeDetail` on `compact-failed`,
       * `{exit_code}` on an exit, absent otherwise. `unknown` on purpose: narrow it by `code`.
       */
      detail?: unknown;
    };

/** How loud an `ItemKind` notice is. */
export type NoticeLevel = "info" | "warning" | "error" | "fatal";

/**
 * `detail` on a `code: "compacted"` notice — every number the provider's `compact_boundary`
 * reported, and only those: a key is **absent** when it reported none, never zero, and the whole
 * object is absent when it reported nothing at all. Measured values are the real capture's
 * (`crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`, CLI 2.1.268).
 *
 * Tokens and milliseconds. There is no cost field and none is ever added (`docs/vision.md` §6).
 */
export interface CompactedNoticeDetail {
  /** Tokens before. Measured: `70633`. */
  pre_tokens?: number;
  /** Tokens after — the summary alone. Measured: `1379`. */
  post_tokens?: number;
  /** Tokens every compaction in this session has dropped so far. Measured: `69254`. */
  cumulative_dropped_tokens?: number;
  /** Milliseconds the compaction took. Measured: `12262`. */
  duration_ms?: number;
}

/**
 * `detail` on a `code: "compact-failed"` notice. Absent when the provider named no reason, in
 * which case the notice body is the bare sentence and there is nothing further to show.
 */
export interface CompactFailedNoticeDetail {
  /** The provider's slug, e.g. `"too_few_groups"`. Open set — render it, do not switch on it. */
  error: string;
}

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
  | {
      /**
       * A compaction is under way and has not finished — the live phase, ~12 s on the one real
       * capture. Carries no feed row and no thread notice: it is a signal, like `usage-windows`.
       *
       * Emitted from `system/status: "compacting"` only. The `"requesting"` status that precedes
       * it is **not** compaction-specific — the same capture carries one in front of an ordinary
       * turn — so this never fires on a turn that does not compact.
       *
       * Exactly one of `session-compacted` or `session-compact-failed` follows it, on every path,
       * including a provider that dies mid-compaction.
       */
      type: "session-compacting";
    }
  | {
      /** A compaction that finished. Read from `system/compact_boundary`. */
      type: "session-compacted";
      trigger: CompactTrigger;
      /** Tokens before compaction. Measured: `70633`. */
      pre_tokens: number | null;
      /**
       * Tokens after compaction — the summary alone, not the whole context. Measured: `1379`.
       *
       * The three fields below are **absent**, not null, when the provider did not report them
       * (`skip_serializing_if` on the Rust side), and absent on every event persisted before
       * 2026-09-11. Optional so a build that predates the Rust change still type-checks.
       */
      post_tokens?: number;
      /** Tokens **every** compaction in this session has dropped so far. Measured: `69254`. */
      cumulative_dropped_tokens?: number;
      /** How long it took. Measured: `12262` — "Context compacted · 12.3 s" is this number. */
      duration_ms?: number;
    }
  | {
      /**
       * A compaction the provider abandoned. A **warning**, not an error: the session runs on and
       * the CLI retries on a later turn. It has no `compact_boundary` — the failing status frame
       * is the only carrier there is.
       */
      type: "session-compact-failed";
      /**
       * The provider's own reason slug, e.g. `"too_few_groups"` — the one value ever observed.
       * The set is **open**: render an unrecognised slug as text rather than switching on it.
       * `null` when the frame named no reason.
       */
      error: string | null;
    }
  | { type: "runtime-warning"; message: string }
  | { type: "runtime-error"; message: string; fatal: boolean }
  | {
      /**
       * Where the operator stands against their own usage windows, once per turn, early.
       *
       * **There is no cost field and none is ever added.** The user runs on their own
       * subscription and is never billed a dollar figure, so the gauge is the window, not the
       * money (`docs/vision.md` §6) — `total_cost_usd` exists on the provider's wire and stops
       * here.
       */
      type: "usage-windows";
      /** `"allowed"`, `"rejected"`, or a value a future CLI adds. Never switch on a closed set. */
      status: string;
      /** One per key present in `unifiedWindows`. The set is **open**; render what you are given. */
      windows: UsageWindow[];
    };

/** One usage window: how much of it is spent, and when it refills. */
export interface UsageWindow {
  /** `"five_hour"`, `"seven_day"`, or a future key, verbatim. */
  name: string;
  /** Fraction of the window consumed, 0–1 at two-decimal resolution. **Not a percentage.** */
  utilization: number;
  /** **Unix seconds**, not the milliseconds the rest of this file uses. */
  resets_at: number;
}

/** The event types the Rust side forwards as signals regardless of project visibility. */
export type SignalEventType =
  | "session-started"
  | "session-exited"
  | "turn-started"
  | "turn-completed"
  | "turn-aborted"
  | "request-opened"
  | "request-resolved"
  | "session-compacting"
  | "session-compacted"
  | "session-compact-failed"
  | "runtime-error"
  | "runtime-warning"
  | "usage-windows";

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

/**
 * What a row is, independent of its text.
 *
 * The set is **closed** and mirrors `brigadier_store::FeedKind` (`crates/store/src/feed.rs`),
 * pinned on the Rust side by `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant` and
 * tabulated in `docs/plans/ipc-contract.md` §"`FeedRowWire.k` — the kind discriminator". Both were
 * read, value by value, when this union was written; neither may be changed without the other.
 *
 * `unknown` is **not a class, it is the absence of one** — a row written before migration 1
 * (2026-09-03), or one whose stored slug came from a build that knows a class this one does not.
 * `feed::kind` never produces it; only the store does. Anything that filters or styles by `k`
 * must leave `unknown` rows alone: show them under every setting, or under none, but never file
 * them under a real class. The owner has **10,037** pre-migration rows, and folding them into
 * `sys` — which was the first cut of this field — would have claimed every one of them was
 * session housekeeping.
 */
export type FeedKind =
  | "turn"
  | "tool"
  | "text"
  | "think"
  | "user"
  | "sub"
  | "appr"
  | "warn"
  | "err"
  | "sys"
  | "unknown";

/** Short-keyed terse row: `s`ession, se`q`, `t`ime (ms), `l`ine, `k`ind. */
export interface FeedRowWire {
  s: SessionId;
  q: number;
  t: number;
  l: string;
  /** Added 2026-09-03, additive; the Rust side has sent it since `959bd0c`. See `FeedKind`. */
  k: FeedKind;
}

export interface SessionCounter {
  session_id: SessionId;
  rows_total: number;
  rows_dropped: number;
  /**
   * Content deltas seen for this session, ever. **A cursor, nothing may draw it.**
   *
   * A streamed fragment produces no terse row and is not a signal, so without this nothing
   * downstream moved when prose arrived and no refetch was scheduled. One counter per touched
   * session per frame already, so a frame carrying 40 deltas carries one counter advanced by 40
   * — against the rejected alternative of ~600 envelopes a turn at an 8 KB per-message cliff.
   *
   * Optional here although Rust always writes it, so counter literals written before this field
   * still type-check.
   */
  deltas?: number;
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
  projectless?: boolean;
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
  effort?: string | null;
  permission_mode?: string | null;
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

/**
 * Whether calling again with `force: true` can answer this refusal.
 *
 * Three of the six can (`crates/supervisor/src/worktree.rs:483-513` is the `!force` guard that
 * decides it); the other three return **before** the force check and the operator has to act
 * outside brigadier. A UI that offers "force" on one of those builds a button that is guaranteed
 * to refuse again, which is why this predicate is shared rather than re-derived per call site.
 */
export function canForce(blocked: CleanupBlocked | null): boolean {
  return blocked === "dirty" || blocked === "commits" || blocked === "branch_moved";
}

/* --------------------------------------------------------------- deleting
 *
 * `docs/plans/ipc-contract.md` §"Deleting". `cleanup_worktree` removes a checkout and leaves the
 * session in the sidebar; **`delete_session` removes the session**. Different verbs, both needed.
 *
 * Two rules are encoded here rather than only written down, because a renderer gets each of them
 * silently wrong:
 *
 *   - **A refusal is a return value, not an error.** `removed: false` comes back as a *success*
 *     from `invoke`, carrying the `WorktreeCleanup` that said no. Drawing it as a completed
 *     delete is the same defect class as an approvals dock showing a decision that never landed.
 *   - **`branch` is on the refusal *and* on the success**, and it is the only thing that names
 *     where the work went once the row is gone. Nothing in the Rust side deletes a branch.
 */

/** `brigadier_store::Deleted` — rows one delete removed, by table. All zero on a refusal. */
export interface DeletedRows {
  projects: number;
  sessions: number;
  feed: number;
  approvals: number;
  intents: number;
  plans: number;
  phases: number;
  plan_revisions: number;
  unknowns: number;
  /** Orders deleted through their phase. */
  work_orders: number;
  /**
   * Orders **kept**, with `session_id` set to null — the one deliberate exception in the cascade
   * map, because the plan outlives the session that ran it (`docs/vision.md` §8). Not a leak: a
   * work order that shows no session is a session that was deleted.
   */
  work_orders_orphaned: number;
}

/** `delete_session`'s answer (`crates/supervisor/src/removal.rs:41`). */
export interface SessionDeletion {
  session_id: SessionId;
  /** `false` means **nothing at all** was touched: no rows, no log, no checkout. */
  removed: boolean;
  rows: DeletedRows;
  /** The worktree half verbatim, or null when the session ran in the project root. */
  worktree: WorktreeCleanup | null;
  /** Raw NDJSON files removed from `<data_dir>/raw/`, rotations counted too. */
  logs_removed: number;
  /** The branch that still holds this session's commits. Survives every path. */
  branch: string | null;
}

/** One session's worktree outcome inside a project delete. */
export interface SessionWorktree {
  session_id: SessionId;
  cleanup: WorktreeCleanup;
}

/**
 * `delete_project`'s answer (`crates/supervisor/src/removal.rs:78`).
 *
 * **The database half is all-or-nothing; the worktree half is not.** Worktrees go one session at
 * a time *before* any row is deleted and the first refusal ends the pass, so `worktrees` lists
 * every session attempted — including the one that said no — and checkouts removed before that
 * point stay removed. Their branches survive, so nothing is lost, but the list is the truth a
 * partial failure has to show instead of one line that would be false.
 */
export interface ProjectDeletion {
  project_id: ProjectId;
  removed: boolean;
  rows: DeletedRows;
  worktrees: SessionWorktree[];
  logs_removed: number;
  gate_logs_removed: number;
  /** `<project root>/.brigadier/` went — **only** if it was empty. */
  brigadier_dir_removed: boolean;
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

/* ------------------------------------------------------------------ the run
 *
 * `docs/plans/ipc-contract.md` §"The run", added 2026-09-04. One approved goal, one plan, and a
 * loop that dispatches, gates and commits without a human. Every shape below is transcribed from
 * that section field by field; none of it may be widened here without the contract changing
 * first, because the Rust side is written against the same paragraph.
 *
 * Four of the contract's rules are encoded in the types themselves rather than only in prose,
 * because each one is a decision a renderer can silently get wrong:
 *
 *   - `PhaseView.verify_command` is `string | null` and **the null is the information**. A phase
 *     with no verify command cannot go green through a gate; a UI that substitutes a placeholder
 *     command is claiming a gate that does not exist.
 *   - `last_exit_code` is the gate's answer and `last_evidence` is bounded. **Neither is a log
 *     tail and no log tail is on this wire**: the verify command's output goes to a file and to a
 *     worker's window (`docs/vision.md` §4 step 7.5).
 *   - `WorkOrderState`'s `"unknown"` is not a spinner. It means something moved in that worktree
 *     and the harness cannot tell what, so the phase is blocked and will not be repeated
 *     (`docs/research/intent-records.md` §5.1).
 *   - **No dollar figure appears in any of these shapes, and none may be added.** The owner runs
 *     on his own subscription and is never billed per token (`docs/vision.md` §6).
 */

export type PlanId = string;
export type PhaseId = string;
export type OrderId = string;
export type UnknownId = string;
export type IntentId = string;

/** `RunView.status`. A closed set on the wire; the contract lists exactly these four. */
export type RunStatus = "draft" | "approved" | "done" | "abandoned";

/**
 * A run the loop is still working on, as opposed to one it has finished with. `start_run` refuses
 * a second one for the same project with `run_already_live`, so this is also the predicate that
 * decides whether the composer offers Start or Stop.
 *
 * **`draft` counts as live and that is a choice, not a reading.** The contract does not say which
 * statuses `run_already_live` covers. A draft plan is one whose unknowns are still being settled,
 * and offering "start a run" over it would invite exactly the second run the error code exists to
 * refuse — so the front end treats both open statuses the same way and lets Rust be the authority
 * when it disagrees.
 */
export function runIsLive(run: RunView | null): boolean {
  return run !== null && (run.status === "draft" || run.status === "approved");
}

export type PhaseState = "pending" | "running" | "green" | "blocked";

export type WorkOrderState = "pending" | "dispatched" | "reported" | "failed" | "unknown";

export type UnknownBin = "owner" | "research";
export type UnknownState = "open" | "answered" | "skipped";

export interface WorkOrderView {
  order_id: OrderId;
  title: string;
  owned_paths: string[];
  state: WorkOrderState;
  session_id: SessionId | null;
  branch: string | null;
  worktree_path: string | null;
  report: string | null;
}

export interface PhaseView {
  phase_id: PhaseId;
  ordinal: number;
  title: string;
  definition_of_done: string;
  /** Null means **no gate**. See the header: never render a placeholder in its place. */
  verify_command: string | null;
  state: PhaseState;
  attempts: number;
  base_sha: string | null;
  commit_sha: string | null;
  /** The gate's answer. 0 is a pass; anything else is the failure the card reports. */
  last_exit_code: number | null;
  /** Bounded by the Rust side. **Not a log tail** — see the header. */
  last_evidence: string | null;
  orders: WorkOrderView[];
}

export interface UnknownView {
  unknown_id: UnknownId;
  bin: UnknownBin;
  question: string;
  state: UnknownState;
  skipped_for_just_go: boolean;
}

export interface RunView {
  plan_id: PlanId;
  project_id: ProjectId;
  goal: string;
  status: RunStatus;
  revision: number;
  created_at_ms: number;
  approved_at_ms: number | null;
  phases: PhaseView[];
  unknowns: UnknownView[];
}

/**
 * What `settle_intent` takes. Two answers, and neither is "allow" or "deny": an unsettled intent
 * is not a permission question, it is the harness asking whether something it cannot observe
 * actually happened.
 */
export type IntentSettlement = "done" | "not_done";

/**
 * `IntentView.state` as the contract writes it: the literal `"unknown"`, because
 * `unsettled_intents` returns only unsettled rows and an unsettled row is by definition the one
 * the reconciler could not resolve. Anything else would not be on this list.
 */
export type IntentState = "unknown";

/**
 * One intent the reconciler could not settle.
 *
 * **`kind` is a pass-through slug, not a closed union** — the same treatment `PermissionMode`
 * gets, and for the same reason: a build that adds a kind must not break an older webview. The
 * renderer prints an unrecognised kind as itself.
 */
export interface IntentView {
  intent_id: IntentId;
  kind: string;
  state: IntentState;
  session_id: SessionId | null;
  project_id: ProjectId | null;
  opened_at_ms: number;
  subject: string | null;
  evidence: string | null;
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
 *
 * All **seven** values Claude Code accepts are modelled, in this crate's kebab-case wire spelling
 * (`crates/core/src/driver.rs::PermissionMode::as_wire_str`); `as_cli_flag` is the camelCase the
 * binary's own flag takes, and nothing on this side of the wire ever writes that spelling.
 * `claude --help` lists six and omits `default`, whose documented alias is `manual`; both are
 * accepted, so both are kept (`docs/research/permission-modes.md` §2, re-measured on 2.1.261).
 */
export type KnownPermissionMode =
  | "default"
  | "manual"
  | "accept-edits"
  | "plan"
  | "auto"
  | "dont-ask"
  | "bypass-permissions";
export type PermissionMode = KnownPermissionMode | (string & {});

/** One entry in the Permissions menu: the wire value, what to call it, and what it now does. */
export interface PermissionModeOption {
  mode: KnownPermissionMode;
  /** The option's text. Says the effect, not the slug — the slug is the `value`. */
  label: string;
  /** The longer sentence, for the control's `title`. */
  note: string;
}

/**
 * What the Permissions menu offers: **the whole set the CLI accepts.**
 *
 * `bypass-permissions` used to be left out with the note that it "silently disables the approval
 * path". That was true of the mode as a bare CLI flag and it is no longer true of what brigadier
 * does with it. The mode alone never could stop a prompt — brigadier's `PreToolUse` hook answers
 * `"ask"` for every writing tool and hooks run **before** the CLI consults the mode
 * (`docs/research/permission-modes.md` §3) — so the old menu was gating on a value that changed
 * nothing, while the owner watched a planner prompt him for twenty consecutive `Bash` calls.
 *
 * A mode now selects a **hook policy**, and the policy depends on a second axis the mode knows
 * nothing about: **where the child is standing** (`permission-modes.md` §4–§5).
 *
 *   - a **worker**, in the throwaway worktree brigadier cut for it, gets `WorkerWall` in *every*
 *     mode — the mode does not reach it, and the wall is about leaving the checkout;
 *   - a **judgement call** — planner, lead, review — runs in the owner's **own** checkout, and
 *     there anything but `default`/`manual` buys `ReadOnlyWall`: reads flow, every write still
 *     asks. No mode on this menu removes that gate.
 *
 * So the dangerous-sounding entries relax **reads in your repository** and **all gating inside a
 * throwaway worktree**, and never writes in your own tree. The labels say that, because a menu
 * that reads "ask for nothing" over a control that still asks is the same lie in the other
 * direction.
 */
export const OFFERED_PERMISSION_MODES: readonly PermissionModeOption[] = [
  {
    mode: "default",
    label: "Default — every write asks",
    note: "Today's behaviour: the harness gates Bash, Write, Edit, MultiEdit and NotebookEdit in every scope.",
  },
  {
    mode: "manual",
    label: "Manual — the CLI's own alias for default",
    note: "Accepted by the binary and kept distinct because it is what the operator picked; the CLI resolves the alias itself.",
  },
  {
    mode: "accept-edits",
    label: "Accept edits — edits inside the session's checkout; Bash still asks",
    note: "Interactive sessions only. A judgement call in your own repository still asks before every write.",
  },
  {
    mode: "plan",
    label: "Plan — reads and plans, writes nothing",
    note: "The harness takes no opinion; the CLI's own plan mode is what refuses the writes.",
  },
  {
    mode: "auto",
    label: "Auto — the CLI classifies each command",
    note: "Billable on API accounts: the classifier is a separate model call, and it is the only mode that runs one.",
  },
  {
    mode: "dont-ask",
    label: "Don't ask — no gate inside a worktree; your own tree still asks",
    note: "A worker in its own throwaway checkout is ungated; a judgement call in the project root keeps ReadOnlyWall.",
  },
  {
    mode: "bypass-permissions",
    label: "Bypass — no gate inside a throwaway worktree; your own tree still asks",
    note: "The strongest thing this menu offers, and it still never pre-authorizes a write in your own checkout.",
  },
];

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
