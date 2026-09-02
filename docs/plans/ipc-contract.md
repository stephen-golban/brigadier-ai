# IPC contract: webview ↔ Rust (phase 2)

Date: 2026-09-02. Status: contract for the phase-2 work orders. The Rust side (`src-tauri`) and the
TypeScript side (`src/`) are built by different workers against this file; neither may change a name
or a shape here without the lead re-issuing both orders.

Research this rests on: `docs/research/tauri-runtime.md` §3–§4 (Channel, 8192-byte cliff, ordering,
drop semantics), `docs/research/feed-rendering.md` (row cost, batch cap, rAF ingestion, FPS meter),
`docs/research/orphan-sweep.md` (pid files, sweep), `docs/research/persistence.md` §5–§6 (data dir,
`run_id`, expired approvals), `docs/research/tauri-commands.md` (command signatures; pending).

## Conventions

- Commands are `#[tauri::command]` functions with snake_case names and snake_case Rust argument
  names. The TypeScript side passes arguments in **camelCase** (Tauri's default mapping); the
  `bridge.ts` module is the only place that spells command names and argument keys.
- Every command returns `Result<T, AppError>`. `AppError` serializes as
  `{ "code": string, "message": string }`. Codes used: `claude_not_installed`, `claude_too_old`,
  `no_such_session`, `no_such_project`, `no_such_request`, `session_not_running`,
  `session_running`, `not_resumable`, `worktree`,
  `worktree_unborn_head`, `worktree_branch_exists`, `store`, `driver`, `io`, `invalid_argument`.
- **Reserved, not yet emitted:** `session_not_found_upstream`. Nothing on the Rust side produces
  it today; see `### resume_session` for why, and for what arrives instead.
- Timestamps cross the wire as **milliseconds since the Unix epoch** (`number`), field suffix `_ms`.
- Ids are strings: `session_id`, `project_id`, `request_id`, `turn_id`, `instance_id`.
- Canonical events use the serde shapes from `crates/core/src/event.rs` verbatim: `Envelope` is a
  plain struct `{ seq, at, instance_id, session_id, event, raw? }` where `at` is already
  milliseconds (`#[serde(with = "millis")]`); `Event`, `ItemKind`, `RequestKind`, `Decision` are
  internally tagged with `"type"` in kebab-case (`"turn-completed"`, `"tool-permission"`,
  `"allow"`, `"deny"`); `ExitReason`/`AbortReason`/`StopReason` are bare strings for unit
  variants and `{ "error": "..." }` / `{ "other": "..." }` for tuple variants;
  `PermissionMode` is a bare string (`"default"`, `"accept-edits"`, `"plan"`,
  `"bypass-permissions"`, or a pass-through).

## Feed channel

`subscribe_feed(on_batch: Channel<FeedBatch>) -> ()` — called once on mount (and again after a
webview reload; the Rust side replaces the stored channel). Batches flow only after this call.

```
FeedBatch {
  project_id: string,
  rows:     FeedRowWire[],       // terse rows, in seq order per session; [] when the project is not visible
  signals:  Envelope[],          // always delivered regardless of visibility (see list below)
  counters: SessionCounter[],    // one per session touched in this frame
}
FeedRowWire   { s: string /*session_id*/, q: number /*seq*/, t: number /*at_ms*/, l: string /*line*/ }
SessionCounter{ session_id: string, rows_total: number, rows_dropped: number }
```

- One batch per animation frame (16 ms tick in Rust) per project; an empty frame sends nothing.
- Serialized size of every message is asserted `< 8000` bytes before `send`; a frame that does not
  fit is split into several messages, at most 24 rows each (`feed-rendering.md` §4).
- Signal envelopes are sent with `raw` stripped (`raw: None`): one envelope with a raw excerpt
  measured 4 279 bytes, two alone cross the 8192-byte cliff (`tauri-commands.md` §9).
- Signal events are the envelopes whose `event.type` is one of: `session-started`,
  `session-exited`, `turn-started`, `turn-completed`, `turn-aborted`, `request-opened`,
  `request-resolved`, `session-compacted`, `runtime-error`, `runtime-warning`. Everything else is
  represented only by its terse row (`feed::terse_line`) or not at all.
- `set_visible_projects(project_ids: string[]) -> ()` — rows for projects not in the list are
  dropped in Rust and counted in `rows_dropped`; signals still flow.

## Commands

| command | args | returns |
|---|---|---|
| `app_info` | — | `AppInfo { run_id, data_dir, version }` |
| `probe_claude` | — | `ClaudeStatus { binary, version }`; error `claude_not_installed` / `claude_too_old` |
| `list_models` | — | `ModelInfo[]` `{ id, label, default: boolean }` (fixed list, from research) |
| `list_projects` | — | `ProjectView[]` |
| `add_project` | `path: string` | `ProjectView` (path must be an existing directory; `invalid_argument` otherwise) |
| `list_sessions` | — | `SessionView[]` newest first |
| `start_session` | `project_id, prompt: string, model: string \| null, permission_mode: string` | `SessionView` |
| `resume_session` | `session_id` | `SessionView`; error `not_resumable` / `no_such_session` |
| `send_turn` | `session_id, text: string` | `{ turn_id: string }` |
| `respond` | `session_id, request_id, decision: Decision` | `()` |
| `interrupt` | `session_id` | `()` |
| `end_session` | `session_id` | `()` |
| `kill` | `session_id` | `()` |
| `cleanup_worktree` | `session_id, force: boolean` | `WorktreeCleanup`; errors `session_running` / `no_such_session` / `invalid_argument` / `worktree` |
| `feed_tail` | `session_id, n: number` | `FeedRowWire[]` oldest first |
| `pending_approvals` | — | `ApprovalView[]` oldest first |
| `record_frame_stats` | `stats: FrameStats` | `()` (appends one NDJSON line to `<data_dir>/frame-stats.ndjson`) |
| `burn` | `sessions: number, rows_per_sec: number, duration_s: number, fixture: string` | `()` (dev builds only; replays fixtures through the feed channel) |

### `resume_session`

Continues an ended session in place: the **same** `session_id`, the same feed, a new child
process. `SessionView` gains **no field** for it — `provider_session_id` already carries the value
the resume token is derived from, so there is nothing new to keep in sync — and the success path
is exactly `start_session`'s: `store.seedSessions([view])` and select it, which re-triggers the
existing `feed_tail` prefill and re-renders the old history.

- Resumable iff the row carries a stored resume token, no child is live on it, and its `status` is
  `exited` **or** `failed`. `failed` is included on purpose: a session that outlived a crash or a
  force-quit is settled as `failed` at the next app open, which is the most common reason an
  operator reaches for Resume.
- Enable a Resume button on
  `provider_session_id !== null && (status === "exited" || status === "failed")`, and disable it
  while `starting`/`running`. `provider_session_id` is the front end's view of the same value the
  token is derived from, so that predicate matches the server's own on every case it can see. The
  server checks more than the UI can (the working directory still exists, a driver is registered,
  no resume of the same session is already in flight), so a `not_resumable` can still come back:
  render its message, which names the condition that failed.
- The returned view's `status` is `starting`, `ended_at_ms` and `exit_code` are `null` again, and
  `last_event_seq` keeps climbing from where it was — new feed rows have `q > ` the old maximum,
  and no existing row is rewritten.
- `cost_usd_cumulative` and every field of `usage` are cumulative **across resumes**, not just
  within the current child. The CLI restarts its own `total_cost_usd` at zero in each child, so
  the Rust side adds the row's totals as of the resume to everything the new child reports. A
  resumed session's cost therefore only ever goes up, and the number in `SessionView` is the true
  total spent on that conversation. (The per-session raw NDJSON log keeps the CLI's own
  un-rebased numbers.)
- `started_at_ms` moves to the moment of the resume once the resumed child announces itself:
  `session-started` carries the new child's clock and the session upsert takes it. The
  conversation's original start time is not kept anywhere. `list_sessions` is ordered by it, so a
  resumed session sorts to the top.
- **The status stays `starting` until the operator sends the first turn.** Claude Code emits its
  `system/init` frame once per *turn*, not once per process, and `session-started` (which is what
  moves the row to `running`) is derived from that frame. A resumed session therefore sits in
  `starting` with a live composer until something is sent; treat `starting` as "ready for input"
  on a resumed session rather than as "still coming up".
- **The permission mode is not restored.** Neither the CLI nor the harness stores the mode a
  session was running in, so a resumed child comes back in `default` whatever it was before. Say
  so in the UI rather than implying continuity that does not exist.

Error codes:

- `not_resumable` — one of the three conditions above failed; the message names which (no token /
  still live / wrong status).
- `session_not_found_upstream` — reserved for the CLI's `No conversation found with session ID`,
  which is what a swept transcript (default retention 30 days) produces. **The Rust side does not
  emit it today.** The CLI writes that text to stderr and exits 1; `crates/core/src/claude/
  process.rs` drains stderr to `tracing::warn` and never hands it to the driver, so the failure
  reaches the front end as `driver` with the message `protocol error: child stdout closed before
  the initialize response`. The code is listed here so both sides can branch on it once the
  stderr tail is plumbed through; until then a `driver` error on `resume_session` should be read
  as "the child would not come up", and the likeliest cause is a swept conversation.

### Worktrees

Every session runs in its own git worktree on its own branch. The scheme is fixed and the front
end never computes any part of it — it only renders what `SessionView` carries.

- **Short id**: eight lowercase hex characters, minted per session (`[0-9a-f]{8}`).
- **Branch**: `brigadier/<id>`, created at `HEAD` of the project's main worktree.
- **Path**: `<project root>/.brigadier/worktrees/<id>`, and this is the child's `cwd` — so
  `SessionView.cwd === SessionView.worktree_path` whenever a worktree exists. Render the branch,
  not the path, in the sidebar; the path is for a tooltip or a "reveal in Finder".
- **A project that is not a git repository is not an error.** `add_project` succeeds, and its
  sessions run in the project root with `worktree_path: null` and `branch: null`. The same is
  true when there is no `git` on `PATH`. Anything else git refuses **fails the start**: the
  session never falls back to running in the operator's own checkout.
- **A project root that is a subdirectory of a repository is refused**, with code `worktree`. A
  worktree of `<repo>/apps/web` is a checkout of the *whole* repository whose top level is the new
  path, so the child would run two levels from where the operator pointed (measured). The message
  names the remedy: add the repository root as the project, or a directory that is not inside a
  repository. `add_project` still succeeds for such a directory — only `start_session` refuses —
  so surface this on the New Session path, not on project add.
- **The worktree starts from `HEAD`.** Uncommitted work in the main tree — including an edited
  `CLAUDE.md`, `.env`, `node_modules/` and `.claude/settings.local.json` — is *not* carried over.
  New Session should say so.
- **`.brigadier/` is excluded at project-add time**, written once and idempotently to
  `$GIT_COMMON_DIR/info/exclude`. The harness never touches `.gitignore`: that file is under the
  operator's version control. Without the rule, one `git add -A` by an agent stages the nested
  worktree as a `160000` gitlink (measured).

Errors that refuse `start_session`:

- `worktree_unborn_head` — the project has no commits, so there is nothing to branch from. The
  remedy is in the message: commit something first.
- `worktree_branch_exists` — `brigadier/<id>` is already taken. The start is refused rather than a
  second id minted silently; retrying gets a fresh id.
- `worktree` — any other git failure, carrying git's own message.

**Cleanup is explicit and never automatic.** Neither `end_session` nor `kill` removes anything: a
resumed session needs its worktree as `cwd`, and `resume_session` reuses the stored path. Only
`cleanup_worktree` removes a checkout.

- Refused with `session_running` while a child is live on the session; end or kill it first.
- Refused with `invalid_argument` when the session has no worktree.
- `force: false` is the question. A worktree with uncommitted work returns
  `{ removed: false, dirty_files: N, branch }` with **nothing touched** — show the count and offer
  "discard N uncommitted changes and remove", which is the same call with `force: true`.
- **`dirty_files` counts ignored files too** — `node_modules/`, `.env`, a venv, build output. Not
  a quirk: `git worktree remove` without `--force` deletes ignored content silently (measured), so
  a count that skipped them would present "clean, safe to remove" over the operator's secrets.
  Word the prompt as "N files will be deleted", not "N uncommitted changes".
- The count also survives an operator whose global config sets `status.showUntrackedFiles=no`,
  which otherwise makes git report a worktree full of new work as empty (measured).
- **The branch always survives.** No cleanup path deletes one, and there is no command that does.
  The checkout is reconstructible; the branch is the only copy of what the agent committed, and
  `git worktree remove` on a clean tree with unmerged commits exits 0 in silence.
- A checkout already gone from disk is pruned out of git's registry and reported `removed: true`.
- **`worktree_path` and `branch` stay on the row after a successful cleanup.** `upsert_session`
  COALESCEs every column it names, so there is no op that can clear them, and the branch name is
  the only record of where the work went. The consequence the UI needs: `cleanup_worktree` is
  idempotent — calling it again on the same session returns `removed: true` with
  `dirty_files: 0`, not an error — and a `worktree_path` on the row does **not** prove the
  checkout still exists.
- After a removal the session's `cwd` no longer exists, so resuming it will fail. Offer cleanup
  only for a session the operator is finished with.
- `session_running` covers a resume that has been requested but whose child has not spawned yet,
  not only a session with a live child.

At app start the Rust side runs `git worktree prune` for every project. It never touches a branch,
its failures are `tracing::warn` lines, and the front end sees nothing of it.

```
AppInfo      { run_id: string, data_dir: string, version: string }
ClaudeStatus { binary: string, version: string }
ModelInfo    { id: string, label: string, default: boolean }
ProjectView  { id: string, name: string, root_path: string, created_at_ms: number }
SessionView  { session_id, project_id: string|null, instance_id: string|null, provider_session_id: string|null,
               cwd: string|null, worktree_path: string|null, branch: string|null,
               model: string|null, status: "starting"|"running"|"exited"|"failed",
               started_at_ms: number|null, ended_at_ms: number|null, exit_code: number|null,
               last_event_seq: number, usage: Usage, cost_usd_cumulative: number }
WorktreeCleanup { removed: boolean, dirty_files: number, branch: string }
Usage        { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens: number, context_window: number|null }
ApprovalView { request_id, session_id: string, opened_at_ms: number,
               kind: RequestKind | null /* null when the store replaced an oversized kind_json */,
               expired: boolean /* no longer answerable: run_id != current OR the session is no longer live */,
               resolved: boolean /* always false today: `pending_approvals` filters
                                   `resolved_at IS NULL` (crates/supervisor/src/lib.rs:461-472);
                                   kept for shape stability, not read by the UI */ }
Decision     { type: "allow", updated_input: unknown|null, updated_permissions: unknown[] }
           | { type: "deny", reason: string, interrupt: boolean }
FrameStats   { window_start_ms: number, hz: number, frames: number, dropped: number,
               p50_ms: number, p95_ms: number, p99_ms: number, worst_ms: number,
               longest_drop_run: number, dom_nodes: number }
```

## Browser fallback

`src/bridge.ts` detects Tauri via `isTauri()` from `@tauri-apps/api/core`. Outside Tauri (plain
`npm run dev` in a browser) it serves an in-memory mock: two projects, one running session, a
synthetic batch generator at a configurable rows/sec, and approvals that resolve locally. The mock
exists so the front end can be developed and its FPS meter exercised without the Rust side, and it
must implement this same contract.
