# Intent records — surviving "the effect landed, the acknowledgement did not"

Date: 2026-09-04. Status: **design, nothing built**. Written against `main` at `1b18909`.

The gap this closes is `docs/research/panel-review-2026-09-03.md` §3.4, gpt's one unique
correctness finding: *"A tool commits or edits, the process dies before the result is durable, a
fresh context repeats it. The harness is authoritative but SQLite, git, the filesystem and the child
are not one transaction."* It is ranked action 3 in that file's §5 and ships **before any
performance work**. `docs/research/resume.md` and `docs/research/orphan-sweep.md` handle **process**
residue; nothing in this repo handles **effect** residue.

Rules of this document, per `CLAUDE.md` §1 and `docs/vision.md`: one line per fact, a path or a
number instead of an adjective, every claim tagged **[measured]** (run on this machine or read from
a fixture, with the path), **[source]** (read in code on this machine, `file:line`), **[documented]**
(vendor docs, URL + fetch date), or **[asserted]** (reasoning, unverified). §9 says what was not
checked.

---

## 0. The shape, in one paragraph

Every effect the harness causes is preceded by one row in a new `intents` table, and that row is
**committed before the effect is attempted** — an `intent_open` followed by `StoreHandle::flush()`,
which is the only barrier in this codebase that turns "sent to the writer" into "on disk"
(`crates/store/src/writer.rs:419-447` **[source]**). The row carries the *baseline* the
postcondition will later be measured against (a sha, a path, a branch), because that baseline stops
being knowable the moment the effect runs. After the effect, a second write closes the row; that
write is deliberately **not** flushed and may be lost, because losing it costs only a re-derivation.
At the next app open a reconciler reads every still-`open` row, runs that kind's postcondition, and
writes one of **three** outcomes — `done`, `not_done`, `unknown`. `not_done` is the only one the
loop may act on; `unknown` is never retried and is surfaced as a `warn` feed row and a plan-card
entry. The asymmetry is the whole design: **record-before-effect can only ever over-report, and
over-reporting is recoverable by reading the world; effect-before-record under-reports, and nothing
recovers that.**

---

## 1. What an effectful step is, enumerated

An effectful step is one that changes something outside this process's memory and outlives the
process. Every row below was read in the tree on 2026-09-04. **[source]** throughout.

| # | step | `file:line` | effect that outlives us | postcondition observable? |
|---|---|---|---|---|
| 1 | `worktree::prepare` → `add_or_rollback` | `crates/supervisor/src/worktree.rs:302`, `crates/core/src/worktree.rs:316,550` | a checkout on disk **and** a branch ref | **yes**, cheap and sound |
| 2 | the rollback inside `add_or_rollback` | `crates/core/src/worktree.rs:550-562` | deletes the branch a failed `add` leaked (2.50.1 leaks one, `docs/STATUS.md` landmines) | **yes** — but a crash between the failed `add` and the `delete_branch` leaves a leaked branch nothing today notices |
| 3 | `worktree::remove` | `crates/core/src/worktree.rs:464` | a checkout deleted, ignored files included | **yes**, cheap |
| 4 | `worktree::repair` | `crates/core/src/worktree.rs:430` | rewrites two absolute paths in git's admin files | **yes**, cheap; idempotent, so it needs no intent row |
| 5 | `worktree::prune` at every launch | `crates/core/src/worktree.rs:506`, called `crates/supervisor/src/lib.rs:974` | unregisters prunable entries; never touches a branch (**measured**, `worktree-git.md` §4) | idempotent; no intent row |
| 6 | `worktree::ensure_excluded` | `crates/core/src/worktree.rs:666` | one line appended to `$GIT_COMMON_DIR/info/exclude` | idempotent (returns without writing when the line is present, `:679`); no intent row |
| 7 | `cleanup_worktree` | `crates/supervisor/src/lib.rs:916` → `crates/supervisor/src/worktree.rs:425` | #3, wrapped in six refusals | **yes** — and it already re-checks `path.exists()` after git exits 0 (`:545`), which is a postcondition read by another name |
| 8 | `start_session` | `crates/supervisor/src/lib.rs:539` | #1, then a **process**, then a pid file | partly: the process is covered by `crates/proc/`; the *work the process does* is not |
| 9 | `resume_session` | `crates/supervisor/src/lib.rs:624` | a second child on the same transcript and worktree | same as #8 |
| 10 | the pid-file write | `crates/proc/src/tracker.rs:79`, called `crates/supervisor/src/lib.rs:766` | `<data_dir>/pids/<session>.json`, atomic temp+`sync_all`+rename | **yes**; this is the repo's existing prior art for exactly this pattern — see §2.4 |
| 11 | `send_turn` | `crates/supervisor/src/lib.rs:826` | a user frame down the child's stdin: tokens spent, and the child acts | **no**, not directly — see §4 `work_order` |
| 12 | `respond` (an approval decision reaching the model) | `crates/supervisor/src/lib.rs:854` → `crates/core/src/claude/adapter.rs:960` | the `control_response` frame is written to the child's stdin **before** `Event::RequestResolved` is emitted (`adapter.rs:968`) | **no.** Nothing on disk records that the frame was written |
| 13 | **a child's own tool call** — the one the panel meant | seen as `ItemKind::ToolCall` at `crates/core/src/claude/adapter.rs:673` and `ItemKind::ToolResult` at `:706`; gated only when `can_use_tool` fires, `:870` | a commit, a file write, a shell command, a package install | **partly** — see §1.1 |
| 14 | the raw NDJSON writer | `crates/store/src/ndjson.rs:99` (`append_line`), `:106` (`flush`) | bytes in `<data_dir>/raw/<session>.ndjson` | not an intent: it is self-healing (a torn last line is discarded by the reader, module docs `:8-14`) and is explicitly out of scope, §7 |
| 15 | the feed/session/approval writes themselves | `crates/store/src/writer.rs:406` | rows in SQLite | the thing intents are recorded *in*; §3 is about their durability |

### 1.1 The child's own tool call: the harness has exactly one pre-effect hook, and it is the approval

This is the sharpest finding in the design and it constrains everything below.

- The harness sees a tool call **twice**: once as `ItemKind::ToolCall` when the assistant frame
  arrives (`adapter.rs:673`), and once as `ItemKind::ToolResult` when the result comes back
  (`adapter.rs:706`). Both are *after the fact* or *concurrent with* the fact. Neither is a hook.
  **[source]**
- The **only** point at which the harness learns of an effect before it happens is
  `can_use_tool` — `Event::RequestOpened { kind: RequestKind::ToolPermission { tool_name,
  input_excerpt, tool_call_id, .. } }` (`crates/core/src/event.rs:428-444`, emitted
  `adapter.rs:870`). The harness parks, the child blocks, and nothing runs until `respond` writes
  the answer. **[source]**
- Therefore: **a tool call that fires an approval is recordable; one that does not is not.** Under
  `docs/vision.md` §8 workers are *pre-authorized inside their own worktree*, and the CLI's built-in
  read-only Bash set never prompts (`docs/STATUS.md`, landmines). So the pre-authorization the
  product promises is exactly the thing that removes the hook. **This is a deliberate hole and §7
  names it as one.** The design does not close it and no design can, short of making every tool call
  prompt, which is the product being refused.
- What is left for an ungated tool call is a *coarse* postcondition on the worktree — did the branch
  gain commits, is the tree dirty — which is per **work order**, not per tool call. That is what the
  `work_order` intent kind in §4 is for.

---

## 2. The record: schema and lifecycle

### 2.1 Migration 3 (`user_version` 3 → 4)

The ladder is `MIGRATIONS` in `crates/store/src/schema.rs:52-138`; three rungs exist and the file
sits at `user_version` 3 (`schema.rs:622`, `assert_eq!(version, 3, "migration 2 is the third
rung")`). **[source]** This is rung index 3.

```sql
-- Migration 3 (2026-09-XX). Effect residue: what the harness was about to do when it died.
--
-- One row per effectful step, written and COMMITTED before the effect is attempted and closed
-- after it. `state` is the three-valued answer reconciliation writes: 'done', 'not_done' and
-- 'unknown' — never two-valued, because "we cannot tell" must not be spelled as "not done", which
-- is what makes a fresh context repeat a commit that already landed.
-- see docs/research/intent-records.md, docs/research/panel-review-2026-09-03.md §3.4.

CREATE TABLE intents (
    id          TEXT PRIMARY KEY,            -- uuid v4, minted before the effect
    run_id      TEXT    NOT NULL,            -- the launch that opened it; == meta.run_id is ours
    kind        TEXT    NOT NULL,            -- closed slug set, read lossily (see below)
    state       TEXT    NOT NULL DEFAULT 'open',
                                             -- 'open'|'done'|'not_done'|'unknown'|'superseded'
    project_id  TEXT    REFERENCES projects(id) ON DELETE CASCADE,
    session_id  TEXT    REFERENCES sessions(id) ON DELETE CASCADE,
    opened_at   INTEGER NOT NULL,
    closed_at   INTEGER,
    subject     TEXT,                        -- what it acts on: worktree path, branch, ref, request_id
    baseline    TEXT,                        -- the value the postcondition is measured against,
                                             -- captured BEFORE the effect (a sha, a count, a path)
    detail_json TEXT    NOT NULL DEFAULT '{}',  -- bounded to INTENT_DETAIL_LIMIT on write
    outcome     TEXT,                        -- 'acked'|'reconciled'|'operator' — how state was set
    evidence    TEXT                         -- the command and the value that decided it; bounded
);

-- The reconciler's only query, and the UI's.
CREATE INDEX intents_unsettled ON intents(opened_at)
    WHERE state IN ('open', 'unknown');
-- Everything a session shows, newest first.
CREATE INDEX intents_session ON intents(session_id, opened_at);
```

Notes that are load-bearing, not decoration:

- **`session_id` is nullable and must be.** `worktree::prepare` runs at
  `crates/supervisor/src/lib.rs:556`, *before* `driver.start_session(req)` at `:562` mints the id.
  **[source]** The `worktree_add` intent therefore has no session to name when it is written; the id
  is filled in on ack. `resume.md` §8 gap 2 already proposes a caller-supplied `SessionId`, which
  would remove the need — do not depend on it.
- **`kind` and `state` are closed slug sets read lossily**, the `McpPolicy` pattern
  (`schema.rs:419-422`, and the test `an_unknown_mcp_slug_reads_back_off` at `:631`). An unknown
  `state` slug must read back as **`unknown`**, never as `done`: the restrictive reading in this
  table is the one that does not authorize a repeat. **[asserted]**
- **`detail_json` is bounded.** A `tool_permission` intent carries an `input_excerpt` already capped
  at `INPUT_EXCERPT_LIMIT = 8 KiB` (`crates/core/src/event.rs:20`) — a `Write` approval is a whole
  file body. Reuse `KIND_JSON_LIMIT`'s treatment (`schema.rs:360-367`): replace an oversized value
  with `{"type":"oversized","bytes":N,"head":…}` rather than storing it. **[source]** for the
  pattern.
- **No `ON CONFLICT` clause anywhere.** `intents.id` is a fresh uuid per open; unlike `feed`'s
  `ON CONFLICT(session_id, seq) DO UPDATE` (`writer.rs:483-485`) there is no second writer that can
  silently rewrite history here. **[source]**
- **`superseded`** exists for one case only: the session the intent belongs to was deleted, or the
  project was, and the FK cascade already removed the row — so in practice it is unreachable and is
  reserved rather than used. State it in the slug set so a future build does not have to migrate to
  add it.

### 2.2 Two new store ops

Beside `Op::SessionEnded` / `Op::SessionResumed` in `crates/store/src/writer.rs:39-85`:

```rust
/// Record an effect the harness is about to cause. Must be followed by `flush().await`
/// before the effect is attempted; without that the row dies with the process.
IntentOpen(Box<IntentRow>),
/// Settle one. Never needs a flush: a lost close reads back as `open` and reconciliation
/// re-derives the same answer from the world.
IntentClose { id: String, state: IntentState, outcome: IntentOutcome, evidence: Option<String>,
              session_id: Option<SessionId>, at: SystemTime },
```

`IntentClose` also carries `session_id` because the `worktree_add` open could not name one.
Its statement is an `UPDATE … WHERE id = ?1 AND state = 'open'` — the same guard
`Op::ApprovalResolved` uses (`writer.rs:527-528`), so a close that races the reconciler cannot
overwrite a settled row.

### 2.3 Lifecycle — the exact points

**Amended 2026-09-04: this is four steps, not five.** As designed it was `intent_open` followed by a
separate `store.flush()` — step (C) — and the barrier was therefore something a caller could forget.
`StoreHandle::intent_open` now **awaits the commit itself** (`crates/store/src/writer.rs`
**[source]**), so (B) and (C) are one call and the ladder below is what shipped. Two consequences
worth stating: the caller can no longer omit the barrier, and `intent_open` can now report
[`Error::IntentOpenTimeout`], which says *the commit did not arrive in time* — never *the row was
not written* — so the answer to one is to stop and reconcile, never to retry the effect.

```
 (A) mint id, capture baseline        <- BEFORE the effect; the baseline stops being knowable after
 (B) store.intent_open(row).await     <- THE BARRIER, and it is inside this call. §3 is why.
 (C) perform the effect
 (D) store.intent_close(...).await    <- no flush, deliberately
```

Why this ordering and no other, crash by crash:

| dies between | row reads | truth | reconciliation says | correct? |
|---|---|---|---|---|
| A and B | (no row) | nothing happened | nothing to reconcile | yes |
| inside B, before its commit | (no row) | nothing happened | nothing to reconcile | yes — the commit inside `intent_open` is what makes this the *only* silent window, and it contains no effect |
| B and C | `open` | nothing happened | postcondition → `not_done` | yes |
| inside C | `open` | **unknowable** | postcondition → `done` or `unknown` | yes; this is the case `unknown` exists for |
| C and D | `open` | it happened | postcondition → `done` | yes |
| after D | settled | it happened | not read | yes |

The reverse ordering (effect, then record) has a row that reads *nothing* while the effect stands —
indistinguishable from "never dispatched", which is precisely the state that makes a fresh context
repeat the commit. **[asserted]**, and it is the panel's whole point.

### 2.4 This is the pid file's pattern, one layer up

`crates/proc/src/pidfile.rs` already does this for processes: *"The durable record of one supervised
child, written before the first protocol frame and deleted when the session ends"* (`:27-28`), with
temp file + `sync_all` + `rename` (`:114-118`), and `PidTracker::track`'s doc says the quiet part
out loud — *"Call it immediately after `spawn`, before the first protocol frame: the window between
`fork` and this call is the only unrecoverable one"* (`crates/proc/src/tracker.rs:63-64`).
**[source]**

Two departures worth naming:

1. `track` is called **after** the spawn (`crates/supervisor/src/lib.rs`, inside `install` at `:713`,
   after `driver.start_session` returned) — so the process-spawn effect is recorded *after* its
   effect, which is the very ordering this document argues against. It is defensible there because
   the record needs the child's kernel start time, which does not exist until the child does. The
   `spawn` intent row in §4 covers the gap: it is written before the spawn and names the *worktree*,
   which is what a leaked child would be running in. **[asserted]**
2. The pid file is fsynced (`sync_all`); the intent row is not (§3).

---

## 3. Durability, from the documentation

The crux is that this repo's writer sets **`synchronous = NORMAL` under WAL**
(`crates/store/src/schema.rs:460-463`) and commits **one transaction per 250 ms window**
(`StoreConfig::batch_window`, `crates/store/src/lib.rs:101`; the loop at `writer.rs:337-377`).
**[source]**

**[documented]** sqlite.org/pragma.html#pragma_synchronous, fetched 2026-09-04, verbatim:

> "WAL mode is safe from corruption with synchronous=NORMAL. … WAL mode is always consistent with
> synchronous=NORMAL, but WAL mode does lose durability. A transaction committed in WAL mode with
> synchronous=NORMAL might roll back following a power loss or system crash. **Transactions are
> durable across application crashes regardless of the synchronous setting or journal mode.**"

**[documented]** sqlite.org/wal.html §2.3, fetched 2026-09-04, verbatim:

> "Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL but omit
> this sync if PRAGMA synchronous is set to NORMAL. … The downside to this configuration is that
> transactions are no longer durable and might rollback following a power failure or hard reset."

So, split cleanly:

| the process dies because | a **committed** intent row | an **uncommitted** one (still in the batch) |
|---|---|---|
| a panic, a `kill -9`, a force-quit, an app crash | **survives** — SQLite's own guarantee, unconditional on `synchronous` | **lost** |
| power loss, OS crash, hard reset | **may roll back** under `synchronous=NORMAL` | lost |

**What the 250 ms batch window means for the intent row specifically.** An `intent_open` sent with
`StoreHandle::intent_open(..).await` is *not written anywhere* — it is an `Op` in a
`std::sync::mpsc` queue and then an entry in a `Vec<Op>` on the writer thread, and it reaches
`tx.commit()` up to 250 ms later (`writer.rs:346-363, 443`). **[source]** For up to 250 ms the row
does not exist in any sense that survives a kill. `Op::Flush` is the fix and it is exact:
`apply_batch` collects flush replies, calls `tx.commit()?`, and only then sends them
(`writer.rs:419-447`). **[source]** So `flush().await` returning is precisely "committed", and by
the quote above, committed survives an application crash.

**`Op::Query` is not a barrier.** A read closure runs *inside* the transaction and replies from
inside it (`writer.rs:424-428`), before `commit`. Read-your-writes is guaranteed; durability is not.
A design that used a read as its "it is saved now" signal would be wrong, and the distinction is not
visible at the call site. **[source]**

**Does the intent write need a stronger guarantee than the feed write? Yes, and only by one step.**
The feed is UI-reload state; `persistence.md` §3 says losing the last few hundred ms of it after a
power cut is invisible, and that is right. An intent row is the opposite: it is read specifically
after an abnormal exit. So the intent open takes the flush (a commit) and the feed does not. It does
**not** take `synchronous=FULL`.

**What `synchronous=FULL` would buy and cost, if the owner ever wants power-loss coverage.**
`PRAGMA synchronous` is per-connection and settable at runtime, and there is exactly one connection,
so the shape would be `PRAGMA synchronous=FULL` → commit the intent → `PRAGMA synchronous=NORMAL`,
expressible as one `Op` on the writer thread. Cost: one `fsync(2)` per dispatch. **Unmeasured on
this machine — no fsync latency figure exists in this repo.** **[asserted]** Not recommended for
v1: a power cut also kills the child that was doing the work and every worktree write it had
buffered, so the intent row and the effect are lost together, which is the one case where losing
both is *consistent*. The failure this design exists for is the app crash, and the app crash is
already covered without an fsync.

---

## 4. Reconciliation on restart

### 4.1 Where it runs, and when

Not in `Store::open`. That function is blocking, holds the launch path, and is SQL-only by design —
`expire_pending_approvals` (`schema.rs:671`) and `settle_stale_sessions` (`schema.rs:546`) are two
statements. Reconciliation needs `git` subprocesses. It goes where `prune_worktrees` goes: spawned
off the setup thread (`src-tauri/src/lib.rs:172-176` **[source]**), so it never lands on B2/B3's
~291 ms launch budget (`docs/STATUS.md` §4).

**One ordering constraint, and it is binding on W1-B:** the orchestration loop must not dispatch
its first work order until reconciliation has completed. Expose it as a `tokio::sync::Notify` or an
awaited `JoinHandle` that the loop's first tick takes. A loop that dispatches into a repository it
has not yet reconciled is the bug this document exists to prevent, arriving one launch later.

### 4.2 The algorithm

1. `git worktree repair` per project **first**. Cleanup already does this before it reads
   (`crates/supervisor/src/worktree.rs:450` **[source]**) and for the same reason: a project
   folder renamed between the crash and the restart leaves two stale absolute paths, and every
   path-based postcondition below would answer `not_done` for a worktree that is sitting there.
   This is the single largest correctness landmine in the reconciler.
2. `SELECT … FROM intents WHERE state = 'open' ORDER BY opened_at ASC` — served by
   `intents_unsettled`. Rows from *any* `run_id`, not just the previous one: the data-dir lock
   (`crates/store/src/lib.rs:125-139`) guarantees one instance, so any `open` row is by definition
   unattended.
3. For each row, in `opened_at` order, run its kind's postcondition (§4.3). Order matters: a
   `worktree_remove` after a `work_order` on the same path must be read second, or the work order's
   postcondition reads a directory the remove already deleted.
4. Write the outcome with `intent_close(state, outcome = 'reconciled', evidence = "<command> -> <value>")`.
   `evidence` is what makes a wrong answer auditable rather than mysterious; the repo has already
   been bitten once by trusting an annotation instead of re-deriving it (`docs/STATUS.md` §5, the
   contrast-ratio comment).
5. For every row that settled `unknown`, emit one surfacing event (§5).
6. One `flush().await` at the end, not per row.
7. Log one `tracing::info!` line with the counts, in the shape `Store::open` already uses for
   `expired` and `stale` (`crates/store/src/lib.rs:196, 203`).

Reconciliation is **idempotent**: a crash mid-reconcile leaves rows `open`, and the next run
re-derives the same answers from the same world. Nothing is retried, so re-running costs only
subprocesses.

### 4.3 Intent kind → postcondition

`WT` = the session's worktree path, `BR` = its live branch from `git worktree list --porcelain`
(never the stored `sessions.branch` — `docs/STATUS.md` §5 defect 5). Costs are per row.

| kind | `subject` | `baseline` captured before | postcondition | `done` | `not_done` | `unknown` | cost |
|---|---|---|---|---|---|---|---|
| `worktree_add` | the worktree path | branch name + `HEAD` sha of the project | `git worktree list --porcelain` contains the path with no `prunable`, **and** `git rev-parse --verify refs/heads/<branch>` exits 0 | both hold | neither holds | branch exists, checkout does not (the 2.50.1 leak, row 2 of §1) | 2 subprocesses, ~10 ms |
| `worktree_remove` | the worktree path | the branch, the pre-remove `dirty_count` | `!path.exists()` **and** the path is absent from `worktree list` | both hold | path still there and still registered | path gone from git, files still on disk — the `left_on_disk` state (`crates/supervisor/src/worktree.rs:545`) | 1 `stat` + 1 subprocess |
| `work_order` | the worktree path | `git rev-parse <BR>` at dispatch, and `dirty_count` at dispatch | `git rev-list --count <baseline_sha>..<BR>` **and** `dirty_count(WT)`, as narration only | — **never `done`**; see below | — **never `not_done` either**, as of the owner decision below | **always**: the only state this kind may settle | 2 subprocesses, ~15 ms |
| `phase_commit` | the base branch | `git rev-parse <BR>` before; the intended message rides in `detail_json` | `git rev-parse <BR>^1` **(the FIRST parent)** and `git log -1 --format=%s <BR>` | first parent == baseline **and** subject == intended message; **or** the fast-forward case, where no merge commit exists at all and `merge-base --is-ancestor <branch> <BR>` exits 0 | `rev-list --count baseline..<BR>` == 0 | count ≥ 1 but the top commit does not match (someone else committed, or it was amended) | 2 subprocesses |
| `merge_to_base` | `<base>..<branch>` | the base ref and its sha | `git merge-base --is-ancestor <branch> <base>` | exit 0 | — **never**; see below | exit 1 | 1 subprocess |
| `tool_permission` | the `request_id` | tool name, `tool_call_id`, and the path when one parses out of `input_excerpt` | **none exists** | only from a stored ack | never | **always**, absent an ack | free |
| `spawn` | the worktree path | the project id | `crates/proc/`'s own sweep already answers "is a child of ours still alive" (`crates/proc/src/sweep.rs`) | pid record matched a live group | no pid record and no group | pid record present, process gone | free (shares the sweep) |

Three entries above are deliberate; the middle one rests on a measurement, the other two on reasoning:

- **`work_order` can never read `done` — and, since 2026-09-04, can never read `not_done` either.**
  "The worker committed something" is not "the worker finished the order". A dirty tree or a new
  commit means *some* of the order ran; repeating it is exactly the failure the panel described, and
  declaring it finished is `docs/vision.md` §8's named failure mode — *agents declaring done
  prematurely*.

  This paragraph originally offered `not_done` as the honest value for *provably nothing moved →
  safe to re-dispatch*. **The owner removed it** (§10.1, and it is enforced at the write:
  `crates/store/src/intents.rs` `settleable` gives `WorkOrder => &[Unknown]`, and `hold_to_settleable`
  downgrades anything else). The reason is that `rev-list --count` plus a dirty count is not a
  sufficient test for *nothing happened*: a worker that ran `npm install`, wrote above the worktree
  root, or made and reverted its own changes leaves both at baseline and would read `not_done`,
  authorizing a re-dispatch of an order that already had effects. *"The accepted cost is a
  re-dispatch we could otherwise have made safely."* **[source]**

  **The consequence for the loop, which is the honest limit on unattended crash recovery:** there is
  no `not_done` branch to take, so `crates/supervisor/src/loop_/` contains **no re-dispatch path at
  all**, and a launch that died with work orders in flight leaves every one of those phases blocked
  until the owner settles each intent by hand
  (`crates/supervisor/src/loop_/state.rs`, `BlockReason::OrdersInFlight`).

  One thing a reconciler must not get wrong, because it is a consequence nothing else in this file
  states: **the live path closes a `work_order` row too, and that close is also downgraded to
  `unknown`.** What distinguishes it is `outcome`: a row the loop closed itself while the process
  was alive carries `IntentOutcome::Acked`, while one a postcondition settled after a restart
  carries `Reconciled`. A reconciler that treats every `unknown` row as *this phase must block*
  without reading `outcome` will block every phase that ever dispatched an order, including phases
  that went green. **[asserted]**
- **`merge_to_base` can never read `not_done`,** because "not merged" has no sound test.
  `docs/research/worktree-cleanup.md` §2.1–§2.4 **[measured]** on git 2.50.1: `git branch --merged`
  misses every squash and rebase merge; `git cherry` reports three `+` ("not merged") for three
  commits squashed into one upstream commit (§2.2), and reports `-` ("already upstream") for work
  that was applied and then **reverted** (§2.4). The only sound signal in this repo is
  `git rev-list --count <base>..<branch> == 0` — *0 ⇒ nothing to lose, always; non-zero proves
  nothing* (§2.1 table). So exit 0 from `merge-base --is-ancestor` is `done`, and everything else is
  `unknown`. **Do not use `git cherry` anywhere in this reconciler**, including the synthetic-squash
  trick of §2.2, which inherits §2.4's false positive.
- **`tool_permission` has no postcondition and is always `unknown`.** The `control_response` frame
  went down a pipe to a process that no longer exists. The intent row's value is not retry
  avoidance — the child is dead and `expire_pending_approvals` has already denied the row
  (`schema.rs:671`) — it is **narration**: after a crash the harness can say *"you allowed
  `Bash(git push …)` and we do not know whether it ran"*, which is a sentence nothing in the app can
  produce today. For `git push` specifically a postcondition exists (`git ls-remote`), it costs a
  network round trip and it is **not** in v1.

**Cheap vs. subprocess, stated plainly.** `spawn` and `tool_permission` cost nothing. `worktree_remove`
costs one `stat` and one `git worktree list`. Everything else costs one or two `git` subprocesses.
`git worktree list --porcelain` is worth caching per project across the whole reconcile pass — one
call, not one per row.

---

## 5. Three outcomes, and where `unknown` goes

`done` closes the row and the loop treats the step as taken. `not_done` closes the row and makes the
step available to re-plan — and **the reconciler does not itself re-dispatch anything.** It writes
answers; the lead call decides. That separation is what stops a reconciler bug from becoming a
dispatch loop.

`unknown` is the point of the design:

1. **It is never retried.** Not by the reconciler, not by the loop. A `work_order` or `phase_commit`
   sitting at `unknown` blocks its phase rather than repeating it.
2. **It is surfaced, twice.**
   - **A feed row, `k: "warn"`.** The reconciler synthesizes one `Envelope` carrying
     `Event::RuntimeWarning { message }` and routes it exactly as `consume` synthesizes a
     `SessionExited` for a stream that closed without one (`crates/supervisor/src/lib.rs:1240-1252`
     **[source]**). `FeedKind::Warn` is what `feed::kind` derives from `RuntimeWarning`
     (`crates/store/src/feed.rs:125`), and `runtime-warning` is already in the signal list of
     `docs/plans/ipc-contract.md` ("Feed channel"), so the envelope reaches the webview regardless
     of project visibility with **no IPC change at all**.
     **Landmine:** the row's `seq` must be `sessions.last_event_seq + 1`, not 0 or 1. `feed`'s insert
     is `ON CONFLICT(session_id, seq) DO UPDATE` (`writer.rs:483-485`), so a reconciler that
     numbered from zero would **silently rewrite the session's oldest rows** — the exact hazard
     `docs/STATUS.md`'s landmine list names, and the one `crates/store/src/lib.rs:418`'s test
     demonstrates deliberately.
   - **The pinned plan card.** A feed row scrolls away and `docs/vision.md` §9 requires that nothing
     the owner steers with ever does. This needs one new command, specified below in
     `docs/plans/ipc-contract.md`'s own vocabulary — **that file is not edited by this document**;
     the implementer's order must add this section to it in the same change:

     | command | args | returns |
     |---|---|---|
     | `unsettled_intents` | — | `IntentView[]` oldest first |
     | `settle_intent` | `intent_id, state: "done" \| "not_done"` | `()`; errors `no_such_intent` / `invalid_argument` |

     ```
     IntentView { intent_id: string, kind: string, state: "unknown",
                  session_id: string|null, project_id: string|null,
                  opened_at_ms: number, subject: string|null, evidence: string|null }
     ```

     `kind` is a **pass-through slug**, not a closed set on the wire — the same treatment
     `permission_mode` gets and the opposite of `mcp` (`ipc-contract.md`, `### set_project_mcp`) —
     because a build that adds a kind must not break an older webview. A new `AppError` code
     `no_such_intent` joins the list. `settle_intent` writes `outcome = 'operator'`.
3. **It is not in the approvals dock.** The dock is the safety boundary — *"Approvals are never
   optimistic… a panel that shows 'denied' for a deny that did not land breaks the one screen the
   owner has to be able to trust"* (`docs/vision.md` §9). An unknown intent is not answerable in
   that sense; putting it there would make "allowed"/"denied" mean two different things on one
   surface.
4. **The owner is asked nothing, by default.** An unknown intent is information. The plan card
   offers exactly one action, and only when the phase is blocked on it: *mark done* / *mark not
   done*, after the owner has looked at the diff. That is `docs/vision.md` §8's "reversibility beats
   prediction" applied to bookkeeping — the harness does not guess, it asks the one person who can
   look.
5. **No dollar figure crosses any of this.** `docs/vision.md` §6, and the same rule
   `ipc-contract.md` applies to `terse_line`.

---

## 6. What it costs

**Rows.** Under an autonomous run at one phase per five minutes with four work orders per phase —
the shape `docs/vision.md` §4 describes — one project produces per hour:

| kind | per phase | per hour (12 phases) |
|---|---|---|
| `worktree_add` | 4 | 48 |
| `spawn` | 4 | 48 |
| `work_order` | 4 | 48 |
| `worktree_remove` | 4 | 48 |
| `phase_commit` | 1 | 12 |
| `merge_to_base` | 1 | 12 |
| `tool_permission` | — | ~10 (pre-authorization means most tool calls never prompt) |
| **total** | | **~226 rows/hour** |

At ~200 B/row that is ~45 KB/hour, ~1.1 MB/day of continuous running, against a 1.6 MB data
directory today (`docs/research/perceived-performance.md` §1.4 **[measured]**) and a 200 MB warn
threshold (`SIZE_WARN_BYTES`, `crates/store/src/lib.rs:47`). **[asserted]** arithmetic, from an
assumed cadence — the cadence is a guess and the row size is not measured.

**Retention: yes, and this is the repo's first one.** `docs/STATUS.md` has no retention section at
all, and `frame-stats.ndjson` and `paint.ndjson` are already two files in that unpoliced class
(`docs/plans/ipc-contract.md`, `### report_paint`). The rule here:

- At `Store::open`, one statement beside `expire_pending_approvals`:
  `DELETE FROM intents WHERE state IN ('done','not_done') AND closed_at < :cutoff`, cutoff = 7 days.
- **`unknown` rows are never swept.** They are few, they are the ones a human still owes an answer
  to, and sweeping them would delete the only record that something may have happened.
- `ON DELETE CASCADE` on both FKs means deleting a session or a project takes its intents with it —
  the t3code #5110 failure (`persistence.md` §3) already designed against.

**Transactions.** The `intent_open` + `flush` pair forces **one extra transaction per dispatch**;
the close rides an existing batch. At ~226 opens/hour that is ~0.06 extra commits per second against
the writer's ~4/s at a 250 ms window — a **~1.5% increase in transaction count**. Commit cost is
**[measured]** at `docs/research/perceived-performance.md` §2.3: **0.27 ms p50** at steady state (10
sessions × ~20 rows/s), **5.32 ms p50 / 8.03 ms max** under the burn (10 sessions × 2000 rows/s).
The flush also closes the coalescing window early, exactly as an `Op::Query` does
(`writer.rs:349`), so its second-order cost is that the batch it interrupted commits slightly
smaller. At two orders of magnitude below the feed's rate this is not a regime the writer notices.
**[asserted]** from **[measured]** inputs.

**Not a store change in the sense §2.3 of `perceived-performance.md` warns about.** This adds a
table and one op pair to the existing single writer. It does **not** add a second connection — trap
5 in that file's Traps section, measured at ≤ 8.03 ms of upside and withdrawn once already on
2026-09-03 — and it does not cache anything.

---

## 7. What this deliberately does not cover

1. **An ungated tool call.** §1.1. Pre-authorization inside the worktree is the product
   (`docs/vision.md` §8); it is also the removal of the only pre-effect hook. The coarse
   `work_order` postcondition is what is left, and it can only ever say `unknown`.
2. **Anything outside the worktree and outside git.** A package install, a `git push`, a database
   the agent migrated, a file written above the worktree root, a network call. The approvals dock
   gates them and a `tool_permission` intent narrates them; nothing reconciles them, because the
   postcondition is not local.
3. **Power loss and OS crash.** §3: `synchronous=NORMAL` may roll back a committed transaction. The
   upgrade path is stated and costed; it is not taken.
4. **The raw NDJSON and the provider transcript.** The NDJSON is self-healing by design
   (`crates/store/src/ndjson.rs:8-14`) and the transcript is the CLI's, swept after
   `cleanupPeriodDays` (`persistence.md` §1). Neither gets an intent row.
5. **Token and dollar accounting across a lost ack.** `result.total_cost_usd` is cumulative and
   `crates/core/src/claude/adapter.rs:729` already records the accepted risk that a replayed frame
   double-counts a resumed session. An intent record does not help; the number comes from the
   provider.
6. **Two harness instances.** Forbidden by the data-dir lock (`crates/store/src/lib.rs:125`).
7. **Backfill.** There is nothing to backfill: the table starts empty. Unlike migration 1, no
   pre-existing row has to read `unknown` for want of a recorded value.

Failure modes it **cannot** close:

- The window inside step (D) is irreducible. The harness cannot know *where* inside `git commit` or
  inside a child's `Write` it died. `unknown` is the design's answer, not a fix for this.
- `evidence` is a snapshot of the world at reconciliation time. A human who touches the repository
  between the crash and the restart changes the answer, and nothing detects that.
- `phase_commit`'s "top commit's parent is the baseline and its subject matches" is a heuristic. An
  agent that made the same commit twice defeats it.
- A project directory renamed **and** `git worktree repair` failing leaves every path-based
  postcondition reading `not_done` for worktrees that exist. Step 1 of §4.2 mitigates; it does not
  guarantee.

---

## 8. Test plan

### 8.1 Provable with a killed process, in this tree, for free

1. **The barrier.** A child test binary opens the store, sends `intent_open`, calls
   `flush().await`, then `libc::_exit(1)`. The parent reopens the store and reads the row. A second
   arm omits the flush and the row must be **absent**. This is the one assertion the whole design
   rests on, and it is the one that cannot be proved by dropping a `Store` in-process — `Drop`
   sends `Shutdown` and the batch carrying it commits (`crates/store/src/lib.rs:263-272`). The
   process-spawning harness already exists in `crates/proc/tests/orphans.rs`.
2. **Migration 3 on a file that stopped at `user_version` 3**, in the shape of
   `migration_2_switches_a_pre_existing_project_to_off` (`schema.rs:602`): the ladder ends at 4, the
   table exists, both indices exist, and no existing row moved.
3. **Slug lossiness.** A `state` value outside the set reads back as `unknown`, never `done` —
   the `an_unknown_mcp_slug_reads_back_off` pattern (`schema.rs:631`).
4. **Ordering, crash by crash.** Six tests, one per row of §2.3's table, each driving the store to
   the stated point and asserting what reconciliation then writes.
5. **Each postcondition against a throwaway git repo**, in the style of `crates/core/tests/worktree.rs`:
   worktree present / absent / prunable; branch with 0 and with N commits; a dirty tree; a
   fast-forward merge (`done`); **a squash-merge that must read `unknown` and must not read
   `not_done`** — this is the one that pins §4.3's `merge_to_base` rule against a future
   simplification back to `git cherry`.
6. **The `seq` landmine.** A session with rows at seq 1..N; reconciliation emits its `warn`
   envelope; assert every pre-existing row is byte-identical and the new row's `seq > N` — a direct
   analogue of `a_resumed_sessions_rows_land_after_the_old_ones_and_leave_them_untouched`
   (`crates/store/src/lib.rs:418`).
7. **Idempotence.** Run the reconciler twice; the second pass finds no `open` rows, writes no second
   `warn` row, and spawns no `git`.
8. **`unknown` never dispatches.** Assert the reconciler's return value carries no re-dispatch and
   that the loop's first action does not name an `unknown` intent.
9. **Retention.** A `done` row older than the cutoff is swept at open; an `unknown` row of the same
   age is not.

### 8.2 Needs a live `claude` child — **money, owner-gated, DO NOT RUN**

These are the two that would prove the design against the real failure rather than a simulation.
List them; do not run them; they belong beside the five existing `--ignored` tests in
`crates/supervisor/tests/` and their cost belongs in `docs/STATUS.md` §3.

- `live_intent_allow_then_kill` — allow a `Write` approval, `kill -9` the child's process group
  between the allow and the `tool_result`. Assert: the file's existence is whatever it is, and the
  intent reads `unknown` either way. This is the panel's scenario, exactly.
- `live_intent_commit_then_kill` — a work order that commits, killed before its `result` frame.
  Assert the `work_order` postcondition reads commits > 0 and settles `unknown`, not `done` and not
  `not_done`.

---

## 9. Not checked, and the weakest claim

Not checked:

- **Nothing here was compiled or run.** Another worker held `cargo` and `npm` during this order;
  `cargo check` was not run. Every SQL statement, index and Rust signature above is written from
  reading, not from a build.
- No fsync latency was measured on this machine, so the `synchronous=FULL` cost in §3 is unpriced.
- The row size (~200 B) and the phase cadence (one per five minutes, four orders) in §6 are
  assumptions; neither has been observed, because the loop they describe (W1-B) is unstarted.
- Whether `git worktree list --porcelain` output can be cached safely across a whole reconcile pass
  while `repair` is running was reasoned, not tested.
- `git ls-remote` as a `git push` postcondition was rejected on cost, not measured.
- No Windows, no git other than 2.50.1 — the same limits `docs/research/gitattributes.md` §§4-6
  records.

**The single weakest claim in this document:** that `work_order`'s composite postcondition —
`rev-list --count <baseline>..<BR>` plus `dirty_count` — is a *sufficient* test for "nothing
happened". It is not obviously so. A worker that ran `npm install`, wrote outside the worktree,
pushed a branch, or made and then reverted its own changes leaves both numbers at their baseline and
reads `not_done`, which authorizes a re-dispatch of an order that already had effects. The
mitigation in the design is that pre-authorization is scoped to the worktree
(`docs/vision.md` §8) so most such effects would have fired an approval and left a `tool_permission`
row — but that is a claim about the wall's coverage, and the wall's set membership is table data
that has never been exercised against a real work order (`crates/core/src/wall/tables.rs`, W3-A
unstarted). If that mitigation is wrong, `work_order` should lose `not_done` entirely and become a
kind that only ever reads `unknown`. **[asserted]**

---

## 10. Amendment — what was built, 2026-09-04

The body above (§0–§9) is the design as written on 2026-09-04 against `main` at `1b18909`, with
**nothing built**. This section records what the implementing order actually landed and the two
places the owner overruled the design. It amends; it does not rewrite. Same tagging rules as §0.

### 10.1 `work_order` loses `not_done` entirely — owner decision, 2026-09-04

**[source]** Owner decision, carried in the implementing work order. §9's "single weakest claim"
paragraph anticipated exactly this and named the remedy: *"If that mitigation is wrong, `work_order`
should lose `not_done` entirely and become a kind that only ever reads `unknown`."* It is now the
decision, not the contingency.

- **§4.3's `work_order` row is superseded.** Its `not_done` column ("both unchanged from baseline:
  no commits, dirt equal") no longer applies. The kind's settled set is `{unknown}` — `done` was
  already forbidden by that same row.
- **§9's weakest-claim paragraph is superseded** by this decision rather than by evidence: the
  composite postcondition was never measured and now never needs to be.
- **The reasoning, restated [asserted]:** `rev-list --count baseline..BR` plus `dirty_count` is not
  a sufficient test for "nothing happened". A worker that ran `npm install`, wrote above the
  worktree root, pushed a branch, or made and then reverted its own changes leaves both numbers at
  baseline and reads `not_done`, which authorizes re-dispatching an order that already had effects.
- **The accepted cost, stated plainly [asserted]:** a re-dispatch that could otherwise have been
  made safely. A `work_order` that genuinely did nothing now settles `unknown` and blocks its phase
  until a human or a fresh lead call reads the diff, rather than being re-dispatched automatically.
- **[source]** Encoded as data, not prose: `KnownIntentKind::settleable`
  (`crates/store/src/intents.rs`) returns `&[Unknown]` for `WorkOrder`, and
  `a_work_order_can_only_ever_settle_unknown` in the same file pins it. It is data the reconciler
  reads; the store does **not** refuse an `intent_close` that ignores it.

### 10.2 `respond` gets a pre-record — owner decision, 2026-09-04

**[source]** `crates/core/src/claude/adapter.rs:960` writes the decision to the child's stdin and
only emits `Event::RequestResolved` at `:968`. So the one path `docs/plans/ipc-contract.md` calls
the safety boundary is the one effect in §1's table with no pre-record at all.

- A `tool_permission` intent is therefore opened **before** the `control_response` frame is
  written, and flushed, exactly like every other kind. §1 row 12's "**no.** Nothing on disk records
  that the frame was written" is superseded: something on disk now does.
- **§4.3's `tool_permission` row still stands unchanged.** A pre-record does not create a
  postcondition — the frame went down a pipe to a process that no longer exists — so the kind still
  settles `done` only from a stored ack and `unknown` otherwise. The value is narration, per §5.
- **The wiring is a later order and is not in this change.** `crates/core/` was not the
  implementing order's path. What landed is only the store side: the `tool_permission` kind and the
  `intent_open`/`intent_close` pair that wiring will call. **[source]** grepped 2026-09-04: nothing
  in `crates/core/` or `crates/supervisor/` calls `intent_open` yet.
- **A pre-record is a durability fix and not licence to show a decision before it is real.**
  `docs/vision.md` §9: *"Approvals are never optimistic. The dock resolves only when Rust confirms
  the decision reached the model."* The intent row records that we were **about to** answer; it is
  not evidence that the answer landed, and no UI may read it as one.

### 10.2b `phase_commit`'s postcondition is wrong for a merge commit — correction to §4.3

§4.3 gives `phase_commit`'s postcondition as `git log -1 --format=%H%x00%P%x00%s <BR>`, settling
`done` when "top commit's parent == baseline **and** subject == intended message". **That rule is
broken and must not be implemented as written.**

- **[measured]** by the lead in a throwaway repository on git **2.50.1 (Apple Git-155)** — the same
  version every other git measurement in this repo was taken on. `%P` lists **all** parents,
  space-separated, so a `--no-ff` merge commit gives:

  ```
  %P       -> 9114da80815f2ce60bb016771b5518b8984212a2 b4d63c6f1b381ade27da692764257aea6be769b0
  baseline =  9114da80815f2ce60bb016771b5518b8984212a2
  "%P == baseline"                 -> FAILS
  "first field of %P == baseline"  -> PASSES
  ```

- **[source]** `docs/vision.md` §4 step 7.6 has the loop **merge, then commit** per phase, so a
  phase commit is routinely a merge commit, not a single-parent one.
- **[asserted]** Consequence as written: the postcondition reads `unknown` on every phase the loop
  ever successfully commits, and per §5 an `unknown` `phase_commit` *blocks its phase*. The design
  would halt the loop on its own successful work, on the happy path, every phase.
- **The fix:** compare the **first parent** — `%P` cut at the first space, or `git rev-parse <BR>^1`
  — not the whole `%P` field. The rest of §4.3's `phase_commit` row (subject match for `done`,
  `rev-list --count baseline..<BR> == 0` for `not_done`, and `unknown` for everything else) is
  unchanged.
- **Not implemented here.** The reconciler is a later order; this is recorded so that whoever
  builds it inherits the fixed rule rather than the broken one. **Not checked:** whether an
  amended-then-merged commit, or an octopus merge, defeats the first-parent comparison too.

### 10.3 Which rung it landed on, and what `user_version` is now

- **[source]** §2.1's heading says "Migration 3 (`user_version` 3 → 4)" and that is still literally
  true: `intents` is rung **index 3** and takes a file from `user_version` 3 to 4.
- A second rung landed in the same change — migration **4**, the plan and progress tables
  (`plans`, `phases`, `plan_revisions`, `unknowns`, `work_orders`), which is `docs/plans/phase-4.md`
  W1-A and has no design document of its own; its spec is `docs/vision.md` §4 steps 5–7, §8 and §9.
- **`crates/store/src/schema.rs::MIGRATIONS` now has five entries and `user_version` is 5.**
  **[measured]** `crates/store/tests/schema.rs` asserts 5 at open and at reopen;
  `schema::tests::migrations_3_and_4_land_on_a_file_stopped_at_user_version_3` drives a file
  stopped at 3 up to 5 and asserts every new table and index exists and that no pre-existing row
  moved.
- **[source]** §2.1's note that the file "sits at `user_version` 3 (`schema.rs:622`,
  `assert_eq!(version, 3, ...)`)" is stale by construction: that assertion now reads 5, and the
  line number moved.
- Consequence worth naming **[asserted]**: `docs/STATUS.md` records the owner's own data directory
  at `PRAGMA user_version` **3** as of 2026-09-04. The next app launch on that directory runs both
  new rungs. Both are `CREATE TABLE`/`CREATE INDEX` only — no `ALTER`, no backfill, no existing row
  read or written — so unlike migrations 1 and 2 there is nothing for them to change. **Not
  checked:** they have not been run against that file, read-only or otherwise.

### 10.4 The IPC commands of §5 are deferred to the reconciler order

§5 point 2 specifies `unsettled_intents` and `settle_intent` and instructs the implementer to add
that section to `docs/plans/ipc-contract.md` "in the same change". **That did not happen, on
purpose.**

- **Nothing produces an `unknown` intent until the reconciler exists**, and the reconciler is a
  later order: it lives in `crates/supervisor/`, needs `git` subprocesses, and is §4 of this
  document. Both commands would therefore ship dead — `unsettled_intents` returning an empty list
  forever and `settle_intent` reachable only by hand.
- `src-tauri/` and `docs/plans/ipc-contract.md` were also outside the implementing order's owned
  paths, so adding them would have been a second worker's file.
- **The store side is a thin wrapper away** and is built: **[source]**
  `StoreHandle::unsettled_intents` returns every `open`-or-`unknown` row oldest first, served by
  the `intents_unsettled` partial index, and `StoreHandle::intent_close` takes the
  `outcome = 'operator'` that `settle_intent` needs. What the reconciler's order still owes:
  the two commands, the `IntentView` shape, the `no_such_intent` `AppError` code, and the
  `ipc-contract.md` section.

### 10.5 What was built, in one list

**[source]**, all in `crates/store/`:

- Rung 3: `intents`, both indices (`intents_unsettled`, `intents_session`), `IntentRow` (write
  shape), `IntentRecord` (read shape), `IntentKind` (pass-through), `KnownIntentKind`,
  `IntentState`, `IntentOutcome`, `Op::IntentOpen`, `Op::IntentClose`,
  `StoreHandle::{intent_open, intent_close, unsettled_intents, session_intents}`, the
  `INTENT_DETAIL_LIMIT` bound with §2.1's placeholder treatment, and the §6 sweep at
  `Store::open`.
- Rung 4: `plans`, `phases`, `plan_revisions`, `unknowns`, `work_orders`, three indices, their row
  types, ten ops and six readers.

### 10.6 What was not checked

- **The reconciler does not exist**, so §4's algorithm, every postcondition in §4.3, and §8.1 items
  4–8 are unbuilt and untested. Nothing has ever settled an intent from a real crash.
- **No live `claude` child was run.** §8.2's two money tests are still unwritten and unrun.
- **The barrier test proves an application crash, not a power cut.** The child calls
  `std::process::exit`, which skips Rust destructors — so no `Op::Shutdown` is sent and no commit
  happens on the way out — but it is not `libc::_exit`, and it does not test `synchronous=NORMAL`
  under power loss. §3's second row of the durability table is still **[documented]** only.
- **No fsync latency was measured**, so §3's `synchronous=FULL` cost is still unpriced.
- **The row size (~200 B) and the cadence in §6 are still assumptions.** Nothing has run long
  enough to observe either, so the ~226 rows/hour and ~1.1 MB/day figures are unchanged and
  unverified.
- **Neither new rung has run against the owner's real database.**
- The `UNIQUE(plan_id, ordinal)` constraint on `phases` is checked per statement, not per
  transaction, so swapping two phases' ordinals in one batch fails the second statement — logged
  and skipped by `apply_batch`, not raised. A reorder has to move one phase to a spare ordinal
  first. **[measured]** by `plan::tests::two_phases_cannot_share_an_ordinal_in_one_plan`, which
  pins the constraint; the swap hazard itself is **[asserted]** and untested.
- **Two `expire_pending_approvals` citations in the body were corrected in place** from
  `schema.rs:526` to `schema.rs:671` (§4.1 and §4.3), an authorized exception to "append only".
  **[measured]** `grep -n 'fn expire_pending_approvals' crates/store/src/schema.rs` → 671. The
  `settle_stale_sessions` citation beside the first of them (`schema.rs:546`) is **also stale** —
  it is at `schema.rs:691` — and was left alone because only the `expire_pending_approvals`
  occurrences were authorized. Fix it in the next order that touches this file.
- **Line numbers in this document rot on every edit to `schema.rs`,** and this change moved most
  of them: the file grew by two migration rungs and a test. Nothing re-derives them.
