# Resume: continuing an exited session

Date: 2026-09-02. Scope: the "Resume" action on an exited session — reuse the stored
`resume_token`, spawn a new CLI child that continues the old conversation, keep the old history
visible in the feed. No live session was started for this brief; every wire claim is either read
from the s5 fixture (**measured**, from `docs/research/claude-direct-spike.md`), from current docs
(**documented**, URL + fetch date), or marked **asserted**.

**Installed CLI: `2.1.258 (Claude Code)`** — `/Users/stephen/.local/bin/claude` →
`/Users/stephen/.local/share/claude/versions/2.1.258`. **[measured, `claude --version`, 2026-09-02]**
The spike that produced the s5 fixture ran against `2.1.257`. **[measured]**

## 0. Sources

All three docs pages fetched 2026-09-02: `code.claude.com/docs/en/sessions` (lookup order,
transcript storage, what a resume restores, permission mode on resume),
`code.claude.com/docs/en/cli-reference` (flag table),
`code.claude.com/docs/en/agent-sdk/sessions` (`resume`, `forkSession`, storage path,
`CLAUDE_CONFIG_DIR`). Also `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`.
Local: `crates/claude-spike/fixtures/s5-resume.ndjson` (+ `.sent`), read-only `~/.claude/projects/`
(316 dirs), `strings` over the 2.1.258 binary. In-repo: `cli-protocol.md` §1,
`claude-direct-spike.md` §5, `persistence.md` §1/§3, `docs/plans/ipc-contract.md`.

## 1. Current code path

The provider layer already resumes. Nothing above it does.

| what | where |
|---|---|
| `--resume=<token>` in argv | `crates/core/src/claude/process.rs:101-104` (field at `:65-66`, builder `build_argv` at `:85-107`) |
| driver trait method | `crates/core/src/driver.rs:278-281` `fn resume_session(&self, req: ResumeSession)`; `ResumeSession` struct at `:194-208`, `::new` at `:212` |
| Claude impl | `crates/core/src/claude/driver.rs:214-232` — builds a `SpawnSpec` with `resume: Some(req.token)` and calls `open()` |
| **the shared spawn** | `crates/core/src/claude/driver.rs:143` `async fn open`; **`:149` mints a fresh harness id: `SessionId::new(uuid::Uuid::new_v4().to_string())`** — resume gets a *new* harness session id today |
| resume token is derived | `crates/core/src/claude/adapter.rs:539-548` — `system/init.session_id` becomes both `provider_session_id` and `resume_token` |
| event seq counter | `crates/core/src/claude/adapter.rs:196` (`seq: u64`), initialised `:262` (`seq: 0`), incremented `:1089` in `emit()` — **per adapter instance, restarts at 0** |
| supervisor start | `crates/supervisor/src/lib.rs:288-353` `start_session` — resolves project + driver, `driver.start_session`, writes `SessionRow`, opens `RawLog`, tracks pid, inserts into `live`, spawns `consume`. **There is no `resume_session` on `Supervisor`** |
| store schema | `crates/store/src/schema.rs:62-85` `sessions` (has `provider_session_id`, `resume_token`, `cwd`, `status`, `ended_at`, `exit_code`, `last_event_seq`); `:87-93` `feed` — **`PRIMARY KEY (session_id, seq)`**, FK cascade on `sessions(id)` |
| feed ring | `crates/store/src/writer.rs:437-442` insert is `ON CONFLICT(session_id, seq) DO UPDATE SET at, line` — a seq collision **silently overwrites**, it does not error; `:446-449` `last_event_seq = MAX(...)`; `:571-577` `trim_feed` keeps the newest `cap` rows **by `seq`** (cap 500, `crates/store/src/lib.rs:88`) |
| stale-session settle | `crates/store/src/schema.rs:509-520` — at every app open, `starting`/`running` become **`failed`** with `ended_at` set and `exit_code` left NULL |
| fork tripwire | `crates/core/src/claude/adapter.rs:516-535` — a later `system/init` carrying a *different* provider id emits `RuntimeWarning "provider session id changed from … to …"`. That is exactly what a `--fork-session` would trip, and it is the detector if one ever leaks in |
| worktree support | `crates/core/src/worktree.rs` (412 lines) is written and tested but **wired to nothing** — `cwd` today comes only from `sessions.cwd` / `project.root_path` (`src-tauri/src/commands.rs:107`) |
| session upsert | `crates/store/src/writer.rs:522-565` — every column `COALESCE`d; **`ended_at`/`exit_code` are not in the statement**, they are written only by `Op::SessionEnded` at `:487-496` |
| tail read | `crates/store/src/writer.rs:220` → `crates/supervisor/src/lib.rs:433-441` → `src-tauri/src/commands.rs:176-182` |
| Tauri command registry | `src-tauri/src/lib.rs:54-73` (18 commands; no resume) |
| TS bridge surface | `src/bridge.ts:51-78` (`Bridge` interface; no resume) |
| session selection / tail prefill | `src/App.tsx:159-168` (`feedTail(selectedSessionId, TAIL_ROWS)` → `store.seedRows`) |
| where a Resume button goes | `src/components/Composer.tsx:22` (`live = status === "running" \|\| "starting"`; end/kill wired at `src/App.tsx:289,292`) |

## 2. Flag recipe

Append exactly one argument to the existing start argv — nothing else changes:

```
claude --output-format stream-json --verbose --input-format stream-json \
       [--model <slug>] --permission-prompt-tool stdio \
       --resume=<provider_session_id> --permission-mode <mode>
```

**[measured: s5 fixture; the repo already emits this, `process.rs:101-104`]**

- `--resume=<id>` as **one** argument; the two-argument form is the pre-0.3.221 SDK shape.
  **[measured: `cli-protocol.md` §3]** No `-p`/`--print` — the mode predicate is the `stream-json`
  in/out pair. **[measured: `cli-protocol.md` §1; s5 resumed without it]**
- `--permission-prompt-tool stdio` and `--resume` coexisted in s5 with no conflict. **[measured]**
  The docs still call `--permission-prompt-tool` `--print`-only and the `stdio` sentinel is
  undocumented; it works anyway. **[documented vs measured — mismatch]**
- Keep pinning `--permission-mode`. On a non-interactive resume the CLI does **not** restore the
  session's stored mode; it starts in the mode a new run would start in.
  **[documented: sessions#permission-mode-on-resume]** `process.rs:85-107` already pins it
  unconditionally — do not drop that on the resume path.
- **Flags are not restored from the original launch**: `--mcp-config`, `--settings`, `--plugin-dir`,
  `--fallback-model`, `--add-dir` must be passed again. **[documented: sessions]** The harness passes
  none today, but building resume from the *same* `SpawnSpec` builder keeps this true later. It does.
- Do **not** pass `--fork-session`; it mints a new provider session id.
  **[documented: cli-reference; agent-sdk/sessions]**

## 3. The cwd question — answered

**Resume is no longer keyed by cwd on this CLI version.** `claude --resume <session-id>` searches
the current project directory and its git worktrees first, then **every other project on this
machine**. The cross-project search resolves only when exactly one other project holds a transcript
with messages for that id; a duplicate copy makes the CLI report not-found rather than pick one.
Before **v2.1.223** the lookup stopped at the current project directory and its worktrees.
**[documented: code.claude.com/docs/en/sessions, "Resume a session", fetched 2026-09-02; repeated in
cli-reference and agent-sdk/sessions]** Installed CLI is 2.1.258 > 2.1.223. **[measured]**

So phase-3's "resume into a git worktree path instead of the project root" works, and even the
harder case (an unrelated directory) works. Two caveats:

- **It is documented, not measured here.** s5 resumed from the *same* cwd, so cross-cwd resume is
  untested locally. `claude-direct-spike.md` "Not checked" lists `resume` from a different cwd.
- **Failure mode if it ever regresses**: `No conversation found with session ID: <id>` and exit 1.
  **[measured: that exact format string is in the 2.1.258 binary]** Surface it as a distinct
  `AppError` code rather than a generic spawn failure.

Storage: `~/.claude/projects/<project>/<session-id>.jsonl`, `<project>` being the working directory
path with every non-alphanumeric character replaced by `-`, truncated to 200 chars plus a hash of
the full path when longer. `CLAUDE_CONFIG_DIR` moves `projects/` wholesale;
`CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+, requires `CLAUDE_CONFIG_DIR`) overrides the `<project>`
segment; `--resume <id>` finds a session under either name.
**[documented: sessions#where-transcripts-are-stored]**

**Landmine, measured.** The spike's s5 `system/init` reported `cwd: "/tmp/spike-scratch/spike-cwd"`,
but its transcript is on disk at
`~/.claude/projects/-private-tmp-claude-501--Users-stephen-Development-brigadier-ai-c9b1b0ce-…-scratchpad-spike-cwd/8380cdea-0e11-4fa3-b5df-9c606b7262aa.jsonl`.
**[measured: `find ~/.claude/projects -name '8380cdea*'`]** The encoded directory is the *resolved*
path, not the cwd string the CLI echoed back — `/tmp/spike-scratch` was a symlink. **[asserted]**
Consequence: never derive the transcript path from `system/init.cwd`; canonicalise first, or treat
`transcript_path` as unknown. `persistence.md` §1 already says treat it as a cache that can vanish.

## 4. `--resume` vs `--continue` vs `--fork-session` vs `--session-id`

All **[documented: cli-reference + sessions, 2026-09-02]** unless marked.

| flag | what it does to the session id | verdict |
|---|---|---|
| `--resume <id\|name>` | keeps the **same** id **[measured: s5]** | the one this feature uses |
| `--continue` / `-c` | same id, but finds the most recent session **in the current directory** and *skips* sessions created by `-p` or the Agent SDK unless `-p` is also passed | wrong primitive — a harness session is exactly the kind it skips |
| `--fork-session` | mints a **new** id, original untouched; combines with `--resume`/`--continue` | not this feature; the primitive for a future "branch" action |
| `--session-id <uuid>` | sets the id of a *new* conversation | not a resume mechanism; out of scope |

## 5. What the first `system/init` after resume reports

**Measured, from `s5-resume.ndjson` — 9 lines total:** a `control_response` for our `initialize`
(before `system/init`, as on a cold start); `system`/`init` with `session_id: 8380cdea-…`
**identical to the original**, a new `uuid`, and the same key set and `capabilities` as s1; then
three `thinking_tokens`, two `assistant`, one `rate_limit_event`, one `result`.

**No prior turn is replayed on stdout.** History is loaded into the model's context, not onto the
wire: s1's `result.usage` was `cache_read 14,630 / cache_creation 11,784`; s5's was
`cache_read 26,414 / cache_creation 94`, and the model answered a question only the prior transcript
could answer. **[measured]** So **the CLI gives the harness nothing to rebuild history from** —
whatever the operator sees after a resume must come from *our* store.

`system/init` fires **once per turn, not once per process** (`claude-direct-spike.md`, measured), so
the adapter's existing "don't treat init as session-start" handling covers the resume path too.

## 6. s5 fixture vs the docs — mismatches

- Docs describe `--input-format stream-json` and `--permission-prompt-tool` as print-mode features.
  s5 used both without `--print` and resumed successfully. **Docs are incomplete, fixture wins.**
- Docs' `--resume` row says nothing about the stdout shape after resume. The fixture settles it:
  no replay. **Fixture is the only source.**
- "Resume from a summary" dialog: on Pro/Max, resuming a session idle >~1 h and >100k tokens opens a
  dialog before the first message. **[documented: sessions#resume-from-a-summary]** Whether that
  reaches a stdio client as a `request_user_dialog` control request is **unverified** — the spike
  never provoked it, and the adapter answers unknown dialog kinds with `subtype:"error"`. This is the
  one behaviour that could silently hang a resume of a long session. Cheapest check: resume a large
  existing transcript and watch for a `request_user_dialog` frame before the first `assistant` —
  costs one turn. Until then, treat a resume that produces no `assistant` frame within a timeout as
  a failure and surface it, rather than parking forever.

## 7. Recommended data model

**Reuse the existing harness `session_id` row.** On resume: same row, `status` back to `starting`
→ `running`, new `instance_id`, `ended_at`/`exit_code` cleared, and the adapter's envelope `seq`
**seeded from `sessions.last_event_seq`** so the new child's rows append after the old ones.

Why, not a new row linked to the old:

- The provider itself keeps one id across a plain resume (**measured, s5**), so one harness row per
  provider session is the honest mapping. A second row would claim two sessions where the CLI has one.
- `feed_tail` needs **no change at all** — it already returns the newest `n` rows for one
  `session_id`, oldest first, and `src/App.tsx:159-168` already seeds the ring from it. Old history
  is visible for free. A linked-row model needs a recursive union in the query and a new column.
- `approvals.session_id` and `feed.session_id` are FK-cascaded to `sessions(id)`; keeping one row
  keeps both coherent with no migration.

The seq seeding is not optional, and its failure is silent. `feed`'s primary key is
`(session_id, seq)`, but the insert at `writer.rs:437-442` is `ON CONFLICT … DO UPDATE SET at, line`
— an adapter restarting at `seq = 1` (`adapter.rs:262`) does not error, it **rewrites the oldest
rows of the old conversation in place**, and `trim_feed` (`:571-577`) then deletes the genuinely new
rows as if they were the stale ones. The operator would see history quietly corrupt itself. This is
the single highest-risk detail in the build and the one an adversarial reviewer should be pointed at.

**Resumable predicate: `exited` *or* `failed`.** `settle_stale_sessions` (`schema.rs:509-520`) turns
every session that outlived a crash or a force-quit into `failed`, so restricting resume to `exited`
would exclude the most common reason an operator wants it. Gate on `resume_token.is_some() &&
!supervisor.is_live(id)` instead of on the status string alone.

Reserve `--fork-session` + a `forked_from` column for a later "branch" feature; do not add the
column now.

## 8. Gaps — one line and one file each

1. `crates/core/src/claude/adapter.rs` — `AdapterConfig` needs a `start_seq: u64` (default 0) that
   initialises the counter at `:262` instead of the hard-coded zero.
2. `crates/core/src/claude/driver.rs` — `open()` at `:143-149` must accept a caller-supplied
   `SessionId` and `start_seq` instead of always minting a uuid; `start_session` passes `None`,
   `resume_session` passes the existing id.
3. `crates/core/src/driver.rs` — `ResumeSession` (`:194-208`) needs the harness `session_id` and
   `start_seq` fields, or a `Resumed { session_id, start_seq }` sub-struct, so the trait carries them.
4. `crates/supervisor/src/lib.rs` — new `pub async fn resume_session(&self, session_id) -> Result<…>`
   modelled on `:288-353`: load the `SessionRecord`, refuse unless `status` is `exited`/`failed` and
   `resume_token` is `Some`, refuse if already in `live`, build `ResumeSession` from the stored
   `resume_token` + `cwd` + `model` + permission mode, then run the identical row-write → `RawLog`
   → tracker → `live` insert → `consume` spawn sequence.
5. `crates/store/src/writer.rs` — `upsert_session` (`:522-565`) cannot clear `ended_at`/`exit_code`
   (they are absent from the statement; every other column is `COALESCE`d so `NULL` means "leave").
   Add an explicit `Op::SessionResumed { session_id, at }` beside `Op::SessionEnded` (`:487-496`)
   that sets `status='starting', ended_at=NULL, exit_code=NULL`.
6. `crates/store/src/writer.rs` — confirm `RawLog::open` (`crates/store/src/ndjson.rs:50`) appends
   to an existing `raw/<session_id>.ndjson` rather than truncating; a resume reopens the same path.
   **[unverified — `file-rotate`'s open mode was not read]**
7. `src-tauri/src/commands.rs` + `src-tauri/src/lib.rs:54-73` — add `resume_session(session_id) ->
   SessionView`, register it, and add error codes `not_resumable` (no token / wrong status) and
   `session_not_found_upstream` (the CLI's `No conversation found with session ID`).
8. `docs/plans/ipc-contract.md` — the contract is the shared spec for both sides; the new command and
   its error codes must land there in the same change. `SessionView` needs no new field.
9. `src/bridge.ts:51-78` + `src/mock.ts` — add `resumeSession(sessionId)` to `Bridge` and to the
   browser mock.
10. `src/components/Composer.tsx:22` + `src/App.tsx:281-295` — a Resume button, `disabled={live}`,
    mirroring the existing end/kill buttons at `Composer.tsx:50-76`. The success callback copies the
    `startSession` pattern at `App.tsx:197-208` (`store.seedSessions([view])` +
    `setSelectedSessionId`), which re-triggers the `feedTail` effect at `:159-168` and re-seeds the
    old history.
11. `src-tauri/src/views.rs:83-111` — `SessionView` exposes no `resume_token`. **Do not add one.**
    The command should take only `sessionId`, read the record server-side via
    `supervisor.session()` (`crates/supervisor/src/lib.rs:448`), and return `not_resumable` when the
    token is `None`. No wire-shape change, nothing to keep in sync.
12. `src/feedStore.ts:196-200` vs `crates/store/src/schema.rs:148-153` — a **pre-existing
    divergence**: the front end maps `killed → "exited"`, Rust maps `Killed → Failed`. Not caused by
    resume, but a resume predicate written against the status string would behave differently on the
    two sides. Fix it or gate on liveness instead (see §7).

## 9. Risks

- **seq collision** (gap 1–4). Ranked first; see §7.
- **Two children on one provider session.** Resuming a session that is still live interleaves both
  processes' messages into one transcript. **[documented: sessions#branch-a-session]** Guard on
  `Supervisor::is_live` (`lib.rs:364`) before spawning.
- **Transcript swept.** Default retention is 30 days (`cleanupPeriodDays`); the resume then fails
  with `No conversation found`. The row keeps its history in our feed either way — the UI should say
  "the provider no longer has this conversation", not "resume failed".
- **Duplicate ids defeat cross-project resume.** The cross-project search resolves only when exactly
  one other project holds the id. This repo's tests use fixed uuids
  (`11111111-1111-4111-8111-111111111111`, `22222222-…`) which already appear in two project dirs on
  this machine. **[measured]** Harmless for real sessions (uuid v4), but do not let a test fixture id
  reach a real spawn.
- **Resume-from-summary dialog** — §6. Unverified; the only candidate for a silent hang.
- **Permission mode is not restored** on the non-interactive path. Already handled by pinning, but
  it means a session that was in `plan` comes back in whatever the harness pins. Say so in the UI.

## 10. Not checked

No live session was started; nothing ran beyond `claude --version`, `strings`, and read-only
`ls`/`find` in `~/.claude/projects/`. So cross-cwd resume, worktree resume, `--fork-session`,
`--continue` and the resume-from-summary dialog are documented-or-unverified, never measured here.
`file-rotate`'s open mode (gap 6) was not read. The 2.1.223 changelog entry itself was not read —
the cross-project lookup change is cited from the three docs pages, which agree on the boundary.

## 11. Measured 2026-09-02

One live run of `crates/supervisor/tests/live_resume.rs` against `claude 2.1.258 (Claude Code)` at
`/Users/stephen/.local/bin/claude`, model `claude-haiku-4-5`, permission mode `default`, cwd
`/tmp/brigadier-live-resume`. Exit 0, `test result: ok. 1 passed`, 7.94 s wall.

| what | measured |
|---|---|
| harness `session_id` | `72d86074-d9dd-42ba-b28a-a97ad50d7718`, **the same row before and after** |
| provider session id / resume token | `950a011a-55cf-412d-8af7-488341774c65`, **identical across the resume** — confirming §4's "keeps the same id" through the harness, not only from the s5 fixture |
| `last_event_seq` at end of the first child (`old_seq`) | 8 |
| first feed row written after the resume | seq **10** (seq 9 was the resumed child's `turn-started`, which contributes no terse line) |
| feed rows | 7 → 13; the first 7 compared byte-identical after the resume |
| `ended_at` / `exit_code` while live | `None` / `None`, cleared by `Op::SessionResumed` |
| recall answer | `pelican` — the second child answered from the first child's transcript |
| `cost_usd_cumulative` on the row at the end | **0.003187** (ceiling 0.08) |
| final `last_event_seq` | 16 |
| signals, in order | `turn-started, session-started(950a011a…), turn-completed(EndTurn), session-exited(Graceful, Some(0)), turn-started, session-started(950a011a…), turn-completed(EndTurn), session-exited(Graceful, Some(0))` |

### What reality contradicted in this brief

- **§7's "new `instance_id`" is not a thing the code has.** `InstanceId` names the *driver
  instance* — the account — and one driver serves every session it opens
  (`crates/core/src/claude/driver.rs`, `instance_id: self.config.instance_id.clone()`). Measured:
  `claude-code:live-resume` before and after. There is no per-child id to change, and inventing
  one would collide with the multi-account meaning the field already carries. §7 should read
  "same row, same instance, new child process".
- **`turn-started` precedes `session-started` on the signal stream**, both times (see the signal
  list above). `system/init` fires once per turn, so a resumed child that has been asked nothing
  **never emits `session-started` at all**. A resume therefore leaves the row in `starting` until
  the operator's first turn, and any caller that waits for `session-started` before sending one
  hangs. `docs/plans/ipc-contract.md` now says so; the live test sends the turn first.
- **§8 gap 6 is settled: `RawLog::open` appends.** Read from `file-rotate` 0.8.0 source
  (`~/.cargo/registry/src/index.crates.io-*/file-rotate-0.8.0/src/lib.rs`): `FileRotate::new` →
  `ensure_log_directory_exists` → `open_file` (`:477-486`) uses the caller's `OpenOptions`
  verbatim — ours is `read/create/append`, no `truncate` — and seeds the rotation byte count from
  the existing file's length (`:459-462`). Covered by a unit test in `crates/store/src/ndjson.rs`.
  **[measured: source read + test]**
- **The CLI's `No conversation found with session ID` cannot reach the driver today.** §3 asks for
  a distinct `AppError` code; the code (`session_not_found_upstream`) is reserved in the contract
  but nothing emits it, because `crates/core/src/claude/process.rs` drains the child's stderr to
  `tracing::warn` and hands it to no one. A bad token dies as a failed handshake:
  `driver` / `protocol error: child stdout closed before the initialize response`. Plumbing a
  stderr tail into `DriverError` is the fix and was not in scope. **[asserted — not provoked; no
  bad-token resume was run, to avoid a second billed spawn]**

### Two things the run exposed

- **`cost_usd_cumulative` under-reported across the resume — now fixed.** `total_cost_usd` is
  cumulative *per child process*, and `Op::SetUsage` overwrites rather than sums (deliberately,
  per `persistence.md` §3), so the 0.003187 above is the **second** child's total only; the first
  child's spend had been overwritten. Fixed without a schema change: `Supervisor::resume_session`
  reads the row's `cost_usd_cumulative` and `usage` as a base (`Accrued`) and the consumer adds it
  to every `TurnCompleted` before the store and the wire see it, so the row and `SessionView`
  carry the true total across every child. The **raw log keeps the CLI's own numbers**. The
  0.003187 figure above therefore under-reports the run it came from; a rerun would show the
  first child's spend added in. Covered by
  `crates/supervisor/src/lib.rs::cost_and_usage_accumulate_across_a_resume`.
- **`started_at` moves to the resume.** `feed::apply`'s `SessionStarted` branch writes
  `started_at = env.at`, and `upsert_session` COALESCEs the *parameter* first, so a non-`None`
  value overwrites. The conversation's original start time is not retained anywhere.
  `list_sessions` orders by it, so a resumed session sorts to the top — arguably right, but it is
  a side effect, not a decision. Left as it is, and recorded in `docs/plans/ipc-contract.md`.

### One thing the review caught that the live run could not

Resuming the same session twice concurrently used to succeed twice. `is_live` was checked before
the driver spawned the child but the live entry was only filed after it, and the gap spans a whole
process spawn — `tokio::join!` of two `resume_session` calls returned `Ok` twice, putting two
children on one transcript with the same `start_seq`, each overwriting the other's feed rows.
Fixed with a reservation set taken under the same `live` guard as the liveness check, before the
first `await`; the second caller now gets `not_resumable`. Each live entry also carries a
`generation` now, so a previous child that is slow to die cannot remove the live entry belonging
to the child that replaced it.
**[measured: `crates/supervisor/src/lib.rs::two_concurrent_resumes_cannot_both_win`]**

### One incidental change

`ReplayDriver` now pre-increments its envelope `seq` like the real adapter, so a replayed session's
first envelope is **1** rather than 0, and a replayed *resume* starts at `start_seq + 1`. Nothing
asserts the old numbering; the burn's fixtures and rates are unaffected.

### Not checked

Cross-cwd and worktree resume (§3), `--fork-session`, the resume-from-summary dialog (§6), a
resume whose transcript the provider has swept, and a resume of a `failed` (rather than `exited`)
row: the predicate accepts `failed`, and a unit test covers the refusal branches, but no live
crash-then-resume was staged. The live test was run **once**, by instruction.
