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
  `worktree_unborn_head`, `worktree_branch_exists`, `store`, `data_dir_locked`, `driver`, `io`,
  `invalid_argument`. `data_dir_locked` is a startup failure, returned by **every** command:
  another app instance already holds this data directory (`<data_dir>/brigadier.lock`), and the
  remedy is to quit that window rather than to retry.
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
FeedRowWire   { s: string /*session_id*/, q: number /*seq*/, t: number /*at_ms*/, l: string /*line*/,
                k: FeedKind /*what the row is*/ }
FeedKind      = "turn" | "tool" | "text" | "think" | "user" | "sub" | "appr" | "warn" | "err" | "sys"
              | "unknown"
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

#### `FeedRowWire.k` — the kind discriminator

**Added 2026-09-03. Additive: `s`, `q`, `t` and `l` keep their names and their meaning.** A row is
one pre-rendered string, and without `k` the webview had to parse `l`'s leading label to tell model
prose from a tool call. `k` is that discriminator, and the set is closed — a value outside it is a
protocol error, and a slug a future build adds reads back as `"unknown"` rather than failing the row.

| `k` | derived from |
|---|---|
| `turn` | `Event::TurnStarted`, `Event::TurnCompleted`, `Event::TurnAborted` |
| `tool` | `ItemKind::ToolCall`, `ItemKind::ToolResult` (on `ItemStarted` / `ItemUpdated` / `ItemCompleted`) |
| `text` | `ItemKind::AssistantText`, `Event::ContentDelta` |
| `think` | `ItemKind::Thinking` |
| `user` | `ItemKind::UserText` |
| `sub` | `ItemKind::Subagent` |
| `appr` | `Event::RequestOpened`, `Event::RequestResolved` |
| `warn` | `Event::RuntimeWarning` |
| `err` | `Event::RuntimeError` (fatal or not) |
| `sys` | `Event::SessionStarted`, `Event::SessionExited`, `Event::SessionCompacted` — those three and nothing else |
| `unknown` | No event. A row whose kind was never recorded: it predates `feed.kind` (migration 1, 2026-09-03), or its stored slug came from a build that knows a class this one does not |

**`unknown` is not a class, it is the absence of one.** A UI toggle that filters or styles by `k`
must **leave `unknown` rows alone** — show them under every filter, or under none, but never file
them under a real class. Folding them into `sys` was the first cut of this field and was wrong:
the owner has 10,037 rows written before migration 1, and every one of them would have claimed to
be session housekeeping. `feed::kind` never returns `unknown`; only the store does.

Rust: `brigadier_store::FeedKind` and `brigadier_store::feed::kind(&Event)`
(`crates/store/src/feed.rs`), pinned in `crates/store/tests/feed.rs::kind_is_pinned_for_every_variant`.
`kind` is total where `terse_line` is not, so a new `Event` or `ItemKind` variant fails to compile
until it is mapped. The value is also persisted in `feed.kind` (migration 1), so a row replayed by
`feed_tail` carries the same `k` the live row did.

**Byte cost, measured 2026-09-03.** `,"k":"unknown"` is 14 bytes at the longest slug in the type;
a *batched* row can never carry it (batch rows come from `feed::kind`, longest output `think` at
12 bytes), so 14 is the conservative bound. A full frame of 24 worst-case 200-byte rows serializes
to **6,813 bytes**, up from 6,477
(`crates/supervisor/src/batcher.rs::a_full_frame_of_worst_case_rows_measures_what_the_research_predicted`,
`24 x 14 = 336 B`). That is 1,187 bytes under `MAX_MESSAGE_BYTES = 8000` and 1,379 under Tauri's
8192-byte `eval` cliff, so **the 24-row cap still holds**. The `serialized.len() < 8000` re-check
before every send is unchanged and remains the binding check.

**No dollar figure crosses this boundary in `l`.** `terse_line` for `turn-completed` renders
`turn done · {stop} · {in} in / {out} out`; the cumulative cost stays a *field* on
`Event::TurnCompleted` and on `SessionView`, and is never rendered into a feed row
(`docs/vision.md` §6, changed 2026-09-03).

## Commands

| command | args | returns |
|---|---|---|
| `app_info` | — | `AppInfo { run_id, data_dir, version }` |
| `probe_claude` | — | `ClaudeStatus { binary, version }`; error `claude_not_installed` / `claude_too_old` |
| `list_models` | — | `ModelInfo[]` `{ id, label, default: boolean }` (fixed list, from research) |
| `list_projects` | — | `ProjectView[]` |
| `add_project` | `path: string` | `ProjectView` (path must be an existing directory; `invalid_argument` otherwise) |
| `set_project_mcp` | `project_id, mcp: "off" \| "inherit"` | `ProjectView` as it now stands; errors `no_such_project` / `invalid_argument` (any other slug) |
| `list_sessions` | — | `SessionView[]` newest first |
| `start_session` | `project_id, prompt: string, model: string \| null, permission_mode: string` | `SessionView` |
| `resume_session` | `session_id` | `SessionView`; error `not_resumable` / `no_such_session` |
| `send_turn` | `session_id, text: string` | `{ turn_id: string }` |
| `respond` | `session_id, request_id, decision: Decision` | `()` |
| `interrupt` | `session_id` | `()` |
| `end_session` | `session_id` | `()` |
| `kill` | `session_id` | `()` |
| `cleanup_worktree` | `session_id, force: boolean` | `WorktreeCleanup`; errors `session_running` / `no_such_session` / `invalid_argument` / `worktree` |
| `delete_session` | `session_id, force: boolean` | `SessionDeletion`; errors `session_running` / `no_such_session` / `invalid_argument` / `worktree` / `store` |
| `delete_project` | `project_id, force: boolean` | `ProjectDeletion`; errors `no_such_project` / `session_running` / `worktree` / `store` |
| `feed_tail` | `session_id, n: number` | `FeedRowWire[]` oldest first |
| `pending_approvals` | — | `ApprovalView[]` oldest first |
| `record_frame_stats` | `stats: FrameStats` | `()` (appends one NDJSON line to `<data_dir>/frame-stats.ndjson`) |
| `report_paint` | `report: PaintReport` | `()` (appends one NDJSON line to `<data_dir>/paint.ndjson`) |
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

### `set_project_mcp`

**Added 2026-09-03.** Owner decision the same day: harness-spawned `claude` children do **not**
get the user's MCP servers by default; a project opts in. Basis: MCP server startup is 751.5 ms of
every 1,395 ms median spawn to `system/init` with the user's two servers, 643.5 ms with
`--strict-mcp-config`, CLI 2.1.259 (`docs/research/spawn-split.md` §2 and §6, measured).

- Request: `set_project_mcp(project_id: string, mcp: string)`. The slug set is **closed**:
  `"off"` or `"inherit"`. Anything else is `invalid_argument`; this is not a pass-through like
  `permission_mode`, because the harness owns this vocabulary, not the CLI. An unknown
  `project_id` is `no_such_project`.
- Response: the `ProjectView` as it now stands, with `mcp` set. Replace the project in the
  sidebar's list with it, the way `add_project`'s return is handled.
- View field: `ProjectView.mcp: "off" | "inherit"`, present on every `list_projects` and
  `add_project` result as well. A new project is `"off"`.
- What each value does to the child's argv (`crates/core/src/claude/process.rs`, pinned by its
  argv tests): `"off"` adds `--strict-mcp-config` and never `--mcp-config`, so the allowed set is
  empty and no server loads; `"inherit"` passes neither flag, and the CLI loads the user's and the
  project's own MCP configuration exactly as an interactive session would.
- **`"off"` may be the migration's doing rather than a choice.** Store migration 2 (`user_version`
  2 to 3, `crates/store/src/schema.rs`) added the column with `DEFAULT 'off'`, which switched
  every project that existed on 2026-09-03 to `"off"`, the owner's two live projects included.
  Nothing records which projects were switched and which chose. Render `"off"` as the state, not
  as a decision the operator made.
- Takes effect on the project's **next** spawn, start or resume alike. A child already running
  keeps whatever it was spawned with: the policy is argv, read once. A resume reads the project
  row as it stands at resume time, not the policy the session was first started under.
- **Ground truth is the child's own `system/init` frame.** It carries `mcp_servers`, which is
  `[]` under `"off"` and lists each configured server with its `status` under `"inherit"`
  (`docs/research/spawn-split.md` §1: `[]` on all six off runs, both servers `connected` on all
  six on runs). The view field says what the harness asked for; that frame says what the child
  got. Nothing surfaces the frame's list to the UI yet.
- Follow-up, not built: a file-path variant that passes `--strict-mcp-config --mcp-config <file>`
  naming only the servers a project declares. Deliberately left out: `spawn-split.md` §8 records
  that only the empty case was ever run, so the loading arm of that flag pair is unproven on this
  machine. Adding it is a third slug plus a path column, and this contract will need a new entry.
- The UI toggle is not built. The command exists and is registered
  (`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`); nothing in `src/` calls it yet.

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
- `force: false` is the question, and **`blocked` says which question**. Nothing is ever touched on
  a refusal. There are six refusal reasons and **`force: true` answers only three of them**:
  `dirty`, `commits` and `branch_moved`. Offer the force button *only* for those.
- `unregistered`, `locked` and `left_on_disk` return **before the force check**
  (`crates/supervisor/src/worktree.rs:468`, `:472`, `:549`) and the operator must act outside
  brigadier. A UI that offers "force" on these builds a button that cannot work. Say what is wrong
  and what to do about it instead — do not offer a retry that is guaranteed to refuse again.
- **`dirty_files` counts ignored files too** — `node_modules/`, `.env`, a venv, build output. Not
  a quirk: `git worktree remove` without `--force` deletes ignored content silently (measured), so
  a count that skipped them would present "clean, safe to remove" over the operator's secrets.
  Word the prompt as "N files will be deleted", not "N uncommitted changes".
- The count also survives an operator whose global config sets `status.showUntrackedFiles=no`,
  which otherwise makes git report a worktree full of new work as empty (measured).
- **`commits` is counted against `live_branch`, not the stored `branch`**, because the stored branch
  can be stale — an agent may have detached `HEAD` or checked out its own. It counts commits no
  other ref keeps. Working-tree dirt and unpushed commits are different losses and are reported
  separately; present them separately.
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

### Deleting — added 2026-09-05

`cleanup_worktree` removes a checkout and leaves the session in the sidebar. **`delete_session`
removes the session.** They are different verbs and the UI needs both: one is "I am done with this
checkout", the other is "this should not be on my machine".

```
SessionDeletion { session_id, removed: boolean, rows: DeletedRows,
                  worktree: WorktreeCleanup | null, logs_removed: number,
                  branch: string | null }

ProjectDeletion { project_id, removed: boolean, rows: DeletedRows,
                  worktrees: { session_id, cleanup: WorktreeCleanup }[],
                  logs_removed: number, gate_logs_removed: number,
                  brigadier_dir_removed: boolean }

DeletedRows { projects, sessions, feed, approvals, intents, plans, phases,
              plan_revisions, unknowns, work_orders, work_orders_orphaned }   // all number
```

`WorktreeCleanup` is the same shape `cleanup_worktree` returns, `blocked` and all — there is no
second vocabulary for a refusal here, and a UI that already renders one renders the other.

**What `delete_session` removes:** the `sessions` row and everything the schema cascades from it
(`feed`, `approvals`, `intents`), `<data_dir>/raw/<id>.ndjson` and its rotations,
`<data_dir>/pids/<id>.json`, and the git worktree. Four things, one call.

**What it never removes: the branch.** No path in the Rust side deletes a branch and there is no
command that does. `branch` is on the reply for both a refusal and a success, because once the row
is gone it is the only name that says where the work went — render it.

**A live session is not deletable**, and `force: true` does not change that. The error is
`session_running`, the message says to end it or kill it first, and it covers a resume that has
been requested but whose child has not spawned yet. macOS will let a directory that is a running
process's `cwd` be unlinked at exit 0 (measured), so this check is the only thing standing between
a mis-click and an agent writing into a deleted inode.

**A refusal is a return value, not an error.** A session whose worktree holds uncommitted files or
unmerged commits comes back as `{ removed: false, rows: <all zeroes>, worktree: { blocked, … } }`
with **nothing touched at all** — no rows, no log, no checkout. `worktree.blocked` is the closed
set the Worktrees section already lists, and the same rule applies: **offer the force button only
for `dirty`, `commits` and `branch_moved`.** `unregistered`, `locked` and `left_on_disk` cannot be
forced and never will be.

**Unmerged commits refuse rather than being snapshotted to a ref.** A snapshot would duplicate a
ref that already exists — the branch is kept whatever happens — so the refusal's job is to put the
branch name in front of the operator *before* the row that records it goes. `worktree.commits` is
the count and it comes from `git rev-list --count`, never from `git`'s `cherry` subcommand, which
is measurably wrong in both directions.

**`delete_project` removes the project and everything under it**: every session with its rows,
logs and worktree, and the whole plan tree — `plans`, `phases`, `plan_revisions`, `unknowns`,
`work_orders`. It also removes `<data_dir>/gates/<phase_id>/` per phase, and
`<project root>/.brigadier/` **only if it is empty**. The exclude line in
`$GIT_COMMON_DIR/info/exclude` is left alone: that file is the operator's.

- **Every session's liveness is checked before anything is touched.** One live session refuses the
  whole project with `session_running`, naming the sessions — never "deleted the other forty and
  then stopped".
- **The database half is all-or-nothing; the worktree half is not.** Worktrees go one session at a
  time *before* any row is deleted, and the first refusal ends the pass: `removed: false`, `rows`
  all zeroes, and `worktrees[]` carrying one entry per session attempted, including the one that
  said no. Checkouts removed before that point stay removed — their branches survive, so nothing
  is lost — and the array is what the UI shows instead of a success that would be false.
- **`store` on either command means nothing was deleted.** The database half runs in its own
  savepoint and rolls back whole; a partial delete is not a state either command can produce.

**`rows.work_orders_orphaned` is not a leak.** `work_orders.session_id` is `ON DELETE SET NULL`
where every other relationship cascades, deliberately: the plan is the durable thing and has to
outlive the session that ran it (`docs/vision.md` §8, and the migration 4 comment in
`crates/store/src/schema.rs`). So deleting a session leaves its work order standing with a null
`session_id`, and this field counts how many. A work order that shows no session is a session that
was deleted, and the card should say so rather than drawing a hole.

**No new error codes.** Both commands draw from the closed set in **Conventions**:
`no_such_session`, `no_such_project`, `session_running`, `invalid_argument`, `worktree`, `store`.

### `report_paint`

One timed paint from the page, appended to `<data_dir>/paint.ndjson`. It exists because **B4**,
**B6** and **B7** in `docs/vision.md` §9 are guesses with nothing behind them, and stay guesses
until the app can time its own paints. Adding it does not change a budget.

Everything here rests on `docs/research/perceived-performance.md` §5.3, measured against a real
`WKWebView` on this machine.

- **The clock bridge.** `performance.timeOrigin` is directly comparable to Rust's
  `SystemTime::now().duration_since(UNIX_EPOCH)`. **[documented]** W3C High Resolution Time defines
  `timeOrigin` as the duration from the estimated monotonic time of the Unix epoch;
  **[measured]** `1788355265312 - 1788355262250 = 3062 = performance.now()` in the real webview.
  So both variants send **epoch milliseconds**, like every other `_ms` field on this wire.
- **`T0` is stamped as the first statement of `main()`** (`src-tauri/src/main.rs` →
  `brigadier_lib::mark_process_start`, a `OnceLock<f64>`). `run()` stamps it again so an entry
  point that skips `main()` gets a later-but-honest value rather than a panic; first write wins.
- **Three honest limits, all of which belong on any number quoted from this file.**
  1. The delta is `main()` entry → FCP, **not `posix_spawn` → FCP**. The dyld/pre-main segment is
     invisible from inside the process; `DYLD_PRINT_STATISTICS` is absent from dyld's string table
     on macOS 26.5, not merely disabled (**[measured]**, §5.1), and `ps -o lstart=` is
     second-granularity.
  2. `timeOrigin` rests on an **estimate** of the monotonic time of the epoch, so an NTP step
     mid-launch corrupts the subtraction. Negligible over 300 ms; not exact. **[documented]**
  3. FCP is a **render** timestamp, not a presentation timestamp.
     `LargestContentfulPaint.presentationTime` "always returns `null`" in WebKit 26.5
     (**[documented]** BCD), so the photons land some frames after the reported number. It is not
     "when the user saw it".
- **There is no `first-paint` entry in this WebKit** — only `first-contentful-paint`.
  **[measured]** `PerformanceObserver.supportedEntryTypes` came back as
  `["event","first-input","largest-contentful-paint","mark","measure","navigation","paint",
  "resource"]`: no `element`, no `longtask`, no `long-animation-frame`. **[measured]**
- **The `paint` observer is `buffered: true`.** An FCP that already happened is still delivered, so
  installing the instrument after `createRoot` is not a bug and the ordering in `src/main.tsx`
  carries no meaning. The observer disconnects after the one entry, and the FCP report is sent
  **exactly once** however many times the instrument is started — React 19 StrictMode
  double-invokes effects, the same reason `subscribe_feed` is idempotent in Rust.
- **`interaction` is a mark → double-`requestAnimationFrame` → measure span.** The second rAF
  callback runs after the rendering update that drew the commit; a single rAF measures the wrong
  edge. `label` is what names B4 / B6 / B7 at the call site and is written verbatim.
  `performance.mark`/`measure` (Safari 11+, **[documented]** BCD) are emitted so the span shows in
  Web Inspector's timeline; the reported duration is a `performance.now()` delta, not read back out
  of the entry buffer. An interaction that never settles within 5 s is **dropped** — marks cleared,
  nothing reported: a missing number is honest, a duration measured to an unrelated later paint is
  not.
- **The file is `paint.ndjson`, a sibling of `frame-stats.ndjson`, never the same file.**
  §5.3 step 3 suggests reusing `frame-stats.ndjson`; this contract deviates deliberately. That file
  holds 1,513 homogeneous `FrameStats` lines and is the evidence base for the 60 Hz claim in
  `docs/STATUS.md` §4; a line of a different shape in it breaks every reader of that evidence.
- **Append-only, never read back by the app.** Nothing in the UI reads `paint.ndjson`; it is
  operator evidence, like its sibling. The written line adds `process_start_epoch_ms` and, on an
  `fcp` line, `main_to_fcp_ms` — the delta is never the only copy, because the raw inputs must stay
  checkable. The `fcp` arm also emits one `tracing::info!(main_to_fcp_ms = …)`, so the launch
  recipe in §5.2 that already parses the `RUST_LOG=info` stream picks it up with no new plumbing.
- **Every field is a `number` (`f64` in Rust), counts included**, for the reason `FrameStats`
  gives: JavaScript has one number type, and a `u64` that receives `3.0000000001` fails the whole
  command with an argument-deserialization error the operator cannot act on.
- **The instrument is `src/paint.ts`.** Its FCP half is wired from `src/main.tsx`; its interaction
  half has **no caller** as of this amendment, and the call sites land with the shell and surface
  orders that create those components.
- **Growth is unbounded and nothing prunes it.** One line per launch today (a single `fcp`); one
  line per session switch and per acknowledged button press once the B4/B6/B7 call sites land, in
  **release** builds too — unlike `burn`, this command is not dev-gated. Nothing rotates, truncates
  or deletes `paint.ndjson`: `record_frame_stats`'s "small enough not to need rotation" was
  inherited here without being re-tested at a per-interaction rate. The rotation decided in
  `docs/research/persistence.md` §4 (`file-rotate`, bytes + count + gzip) covers **raw provider
  traffic**, not harness-authored evidence files; `docs/STATUS.md` has no retention section at all
  (it ends at §7), so `frame-stats.ndjson` and now `paint.ndjson` are two files in a class whose
  retention policy is unwritten. Stated as a known liability, not solved.
- **Half of this command's front end is not in the shipped bundle yet.** **[measured]** 2026-09-02:
  `beginInteraction` has no importer, so Rollup drops it and everything it reaches. In
  `dist/assets/index-*.js`, `first-contentful-paint` and `report_paint` each appear **once** while
  `brigadier:` and `clearMeasures` appear **zero** times. So a bundle figure quoted today is the
  cost of the FCP half alone: the interaction half costs **zero bytes until it has a caller**, and
  W4-C / W4-D pay for it on the order that adds one. It also means a real change to that half moves
  the bundle by zero bytes — indistinguishable from a build that did not run, and not one.

```
AppInfo      { run_id: string, data_dir: string, version: string }
ClaudeStatus { binary: string, version: string }
ModelInfo    { id: string, label: string, default: boolean }
ProjectView  { id: string, name: string, root_path: string, created_at_ms: number,
               mcp: "off"|"inherit" /* added 2026-09-03; "off" may be migration 2's doing,
                                       see "### set_project_mcp" */ }
SessionView  { session_id, project_id: string|null, instance_id: string|null, provider_session_id: string|null,
               cwd: string|null, worktree_path: string|null, branch: string|null,
               model: string|null, status: "starting"|"running"|"exited"|"failed",
               started_at_ms: number|null, ended_at_ms: number|null, exit_code: number|null,
               last_event_seq: number, usage: Usage, cost_usd_cumulative: number }
WorktreeCleanup { removed: boolean, dirty_files: number, commits: number, branch: string,
               live_branch: string|null /* what `git worktree list --porcelain` reports NOW; null on a
                                          detached HEAD. Where it disagrees with `branch`, this is the
                                          only trustworthy answer */,
               blocked: "dirty"|"commits"|"branch_moved"|"unregistered"|"locked"|"left_on_disk"|null
                        /* null only when something was removed. The enum is unit-variant with
                           #[serde(rename_all = "snake_case")] (crates/supervisor/src/worktree.rs:64-66),
                           so these six bare strings are the wire form. force answers the first three
                           only. */ }
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
PaintReport  { kind: "fcp", epoch_ms: number /* performance.timeOrigin + startTime of the
                                            `first-contentful-paint` entry; there is no
                                            `first-paint` entry in this WebKit */ }
           | { kind: "interaction", label: string /* names the budget: B4 / B6 / B7 */,
               start_epoch_ms: number, duration_ms: number /* mark -> double-rAF -> measure */ }
               /* internally tagged on "kind" with #[serde(rename_all = "snake_case")]
                  (src-tauri/src/views.rs), so these two bare strings are the wire form. The
                  line written to <data_dir>/paint.ndjson is this object plus
                  process_start_epoch_ms and main_to_fcp_ms; nothing reads it back. */
```

**Added 2026-09-03.** Under the `interaction` shape above:
- An `interaction` whose `label` starts with `trace:` is a launch signpost, not a budget span.
- `report_paint` strips the prefix and emits it as a trace stage through `BRIGADIER_TRACE=1`, and
  returns before the file write, so it never lands in `paint.ndjson`
  (`src-tauri/src/commands.rs:320-337`).
- The only label today is `trace:dcl`, sent with `duration_ms: 0` and
  `start_epoch_ms = performance.timeOrigin + domContentLoadedEventEnd`, on the same epoch basis as
  the `fcp` report (`src-tauri/src/commands.rs:330-331, 363-374`).
- A second signpost needs only a new `trace:` label on the page side.
- See `docs/research/launch-signposts.md`.

## Browser fallback

`src/bridge.ts` detects Tauri via `isTauri()` from `@tauri-apps/api/core`. Outside Tauri (plain
`npm run dev` in a browser) it serves an in-memory mock: two projects, one running session, a
synthetic batch generator at a configurable rows/sec, and approvals that resolve locally. The mock
exists so the front end can be developed and its FPS meter exercised without the Rust side, and it
must implement this same contract.

`report_paint` has no Rust process to measure against in a browser, so the mock's `reportPaint`
`console.debug`s the report and returns. The instrument itself (`src/paint.ts`) runs unchanged
there, which is the point: the double-rAF and the epoch arithmetic are exercised in `npm run dev`
without a Tauri window.

---

## The run — added 2026-09-04, by the lead, during the unattended run

Everything above this line describes a harness that only ever spawns a child when the owner presses
a button (`src-tauri/src/commands.rs:138` is the sole production caller of
`Supervisor::start_session`). This section is the surface for the thing that changes that: **a run**
— one approved goal, one plan, and a loop that dispatches, gates and commits without a human.

The design is `docs/research/orchestration-loop.md`; the decisions taken on top of it are
`docs/plans/w1b-loop-order.md` §1. This section is binding on both the Rust and the TypeScript side
and is the only place these command names and argument keys are spelled.

### Commands

| command | args | returns |
|---|---|---|
| `start_run` | `project_id, goal: string, model: string \| null, permission_mode: string` | `RunView`; errors `no_such_project` / `invalid_argument` (empty goal) / `run_already_live` |
| `current_run` | `project_id` | `RunView \| null` — the newest plan for the project, live or finished |
| `stop_run` | `plan_id` | `()`; errors `no_such_plan`. Stops dispatching. **Never kills a worker mid-order** — see below |
| `unsettled_intents` | — | `IntentView[]` oldest first |
| `settle_intent` | `intent_id, state: "done" \| "not_done"` | `()`; errors `no_such_intent` / `invalid_argument` |

### Shapes

```
RunView { plan_id, project_id, goal, status: "draft"|"approved"|"done"|"abandoned",
          revision: number, created_at_ms, approved_at_ms: number|null,
          phases: PhaseView[], unknowns: UnknownView[] }

PhaseView { phase_id, ordinal: number, title, definition_of_done,
            verify_command: string|null, state: "pending"|"running"|"green"|"blocked",
            attempts: number, base_sha: string|null, commit_sha: string|null,
            last_exit_code: number|null, last_evidence: string|null,
            orders: WorkOrderView[] }

WorkOrderView { order_id, title, owned_paths: string[],
                state: "pending"|"dispatched"|"reported"|"failed"|"unknown",
                session_id: string|null, branch: string|null,
                worktree_path: string|null, report: string|null }

UnknownView { unknown_id, bin: "owner"|"research", question,
              state: "open"|"answered"|"skipped", skipped_for_just_go: boolean }

IntentView { intent_id, kind: string, state: "unknown",
             session_id: string|null, project_id: string|null,
             opened_at_ms: number, subject: string|null, evidence: string|null }
```

### Rules these shapes encode, each of which is a decision and not a formatting choice

- **`verify_command` is nullable and the UI must render the null.** A phase with no verify command
  **cannot go green through a gate**, and the owner has to be able to see that rather than be shown
  a phase that looks like every other one. The harness never fabricates a command to fill the hole.
- **`last_exit_code` is the gate, and `last_evidence` is bounded.** The verify command's output goes
  to a file and to a worker's window, **never into the thread** (`docs/vision.md` §4 step 7.5).
  Nothing on this wire carries it. A UI that renders a log tail here is wrong.
- **`state: "unknown"` on a work order is not a spinner.** It means something moved in that worktree
  and the harness cannot tell what, so the phase is **blocked and will not be repeated**
  (`docs/research/intent-records.md` §5.1). It must not be drawn as in-progress.
- **`IntentView.kind` is a pass-through slug, not a closed set on the wire** — the same treatment
  `permission_mode` gets and the opposite of `mcp` — because a build that adds a kind must not
  break an older webview.
- **No dollar figure appears in any shape above, and none may be added.** `docs/vision.md` §6: the
  owner runs on his own subscription and is never billed per token, so a dollar figure would be a
  lie in his favour, which is still a lie. The currency is the usage window.
- **`stop_run` stops dispatching; it does not kill.** A worker killed mid-order leaves a worktree
  whose `work_order` intent reconciles to `unknown`, which blocks its phase permanently
  (`intent-records.md` §5.1) — so the cheap-looking implementation of "stop" is the one that
  poisons the plan. In-flight orders are allowed to finish and are collected.

### Signals

The run needs no new channel. Every state change the plan card draws is already reachable:
`runtime-warning` is in the signal list above and is what the reconciler emits for an `unknown`
intent, and the plan card refetches `current_run` on it. **One landmine, restated because it is the
one that corrupts data silently:** a synthesized feed row's `seq` must be
`sessions.last_event_seq + 1`, never 0 or 1 — `feed`'s insert is
`ON CONFLICT(session_id, seq) DO UPDATE`, so a writer that numbers from zero **rewrites the
session's oldest rows in place**.

### Approvals, and the one shape that changed

An approval whose decision **did not reach the model** is no longer reported as resolved. The
adapter emits a `runtime-warning` naming the request instead of a `request-resolved`, and the row
expires with **`decision_json` NULL**, which reads as *expired, outcome unknown* — neither allowed
nor denied. `ApprovalView` must therefore admit a resolved row with **no decision**, and the dock
must draw that third state rather than defaulting it to a deny.

This is `docs/vision.md` §9's rule, and it is the only place in this contract where a lie would be
worse than a gap: *"a panel that shows 'denied' for a deny that did not land — or 'allowed' for
something that never ran — breaks the one screen the owner has to be able to trust."*

### `start_run`'s model and permission mode

Both were added 2026-09-05, after the owner's first live session showed the run using
`claude-opus-5[1m]` while his picker said Haiku — `model: None` was passed to every call and his
choice reached nothing.

- **`model` is nullable, and null is a real choice, not an empty field.** A chosen model is a
  **ceiling** over every child of the run — planner, lead, worker and fixer alike — because the
  control sits beside Start and is labelled with a model name, not a role. Null means
  `docs/vision.md` §6's role-based routing instead: judgement takes the provider default, a work
  order takes its own tier **capped at mid-tier**. The UI must offer null reachably and label it;
  it must never send `""` or a sentinel.

  **Corrected 2026-09-05.** This bullet said a chosen model *"applies to every child"* and that
  null let a work order take *"its own tier"* flat. Both were the behaviour up to `bf036d6` and
  both are now wrong in the same direction: nothing bounded the planner's tier above, so a run
  started with **no** pick could put a work order on `--model opus` by itself, and two live runs of
  the same goal one day apart cost $0.192433 and $0.585646 — **3× for identical work**
  (**measured**, `crates/supervisor/tests/live_loop.rs`). A pick is now a ceiling: an order the
  planner tiered *below* it keeps its own cheaper tier, an order tiered *above* it is clamped, and
  the clamp is recorded on the work order's row. A model id this build does not recognise binds at
  the weakest tier rather than widening the ceiling, and the run still starts. The whole rule, and
  why refusing to start was rejected, is in `crates/supervisor/src/loop_/routing.rs`.
- **`permission_mode` is the wire (kebab) spelling** and the full set the CLI accepts on 2.1.261 is
  offered, `bypass-permissions` included. It selects a **hook policy**, not only a CLI flag —
  brigadier's `PreToolUse` hook runs *before* the mode is consulted, so a mode that did not also
  choose the policy could not stop a single prompt. See `docs/research/permission-modes.md`.
- **The mode is read against where the child runs, not only which mode was picked.** A worker in
  its own throwaway worktree takes the mode at face value. **A judgement call runs in the owner's
  own checkout**, where `docs/vision.md` §8's pre-authorization — explicitly *"inside their own
  worktree"* — does not apply, so writes there keep a gate in **every** mode. A UI label for
  `bypass-permissions` that promises no prompts would therefore be false, and the shipped labels
  say "no gate inside a throwaway worktree; your own tree still asks".

### Ambiguities the front end resolved first, now binding on Rust

The run surface was built against this contract before the Rust commands existed. Where the
contract did not say, the front end chose — and an ambiguity resolved silently on one side is a
mismatch, so each choice is written here and the Rust side matches it rather than the reverse.

1. **`run_already_live` covers `draft` *and* `approved`.** Both are live. The composer offers
   **Stop** over a `draft` rather than a **Start** that can only error.
2. **`stop_run` leaves the plan `abandoned`.** `abandoned` and `done` are both not-live. A
   `stop_run` that left the plan `approved` would bring the Start control back for a run that is
   over.
3. **`settle_intent`'s second argument key is `state`**, per this file's own column, and its values
   are `"done"` and `"not_done"`.
4. **`last_evidence` is drawn, clamped to one line and 120 characters.** The rule it serves is that
   the gate's *output* never reaches the thread; the clamp means a future writer that put a log
   tail in that column still cannot turn the plan card into a log pane. It is a bounded field by
   contract and the card treats it as one.
5. **There is no phase-transition signal, so the card polls `current_run` once a second while a run
   is live.** This contract names exactly one edge, `runtime-warning`, and it does not fire when a
   phase goes green — while `docs/vision.md` §9 requires the card be "updating in place as phases
   complete". The poll is the gap being covered, and it is what a real phase-transition signal
   would replace.
6. **`RunView.unknowns` is typed and fetched but not rendered, and that is a gap.** None of the five
   commands can answer or skip an `UnknownView`, so there is nothing the surface could do with one
   beyond print it. A `draft` run holding an open `owner`-bin unknown therefore has **no way out
   through this surface**. It does not bite this run, because the grill is deferred and every
   unknown the planner produces is written already-skipped — but it is the first thing that breaks
   when the grill lands.
7. **`unsettled_intents` is not filtered by project**, matching the command's own signature: an
   intent left by a run in another repository stays on screen.

### Three error codes this section adds

`run_already_live`, `no_such_plan` and `no_such_intent` join the closed set in **Conventions** at
the top of this file. They are listed here rather than there only because the run arrived later;
they are ordinary members of that set.

### Two gaps between this contract and what the store can express

Both were found while wiring the commands, and both are recorded because a reader will otherwise
mistake them for bugs in the wiring.

- **`plans.status` has no transition beyond approval.** The only op that moves it is
  `plan_approved` (draft → approved). So `stop_run` records `abandoned` **for this launch only** —
  after a restart the plan reads `approved` again and one more Stop re-marks it — and `done` is
  **derived** from *every phase green* rather than stored. `RunView.status` is therefore partly a
  computed field, not a column, and the remedy is a store op rather than a change here.
- **`IntentView.state` is typed `"unknown"` in `src/wire.ts`, but `unsettled_intents` also returns
  `open` rows.** Rust sends `"unknown"` for both, following the shipped TypeScript. An `open` row
  is one nothing has closed at all, which for the owner's purposes reads the same way — but the
  wire is lossy here and that is deliberate rather than accidental.
