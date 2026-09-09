# Persistence — what the database holds and what it must not

Scope: where session state lives across a webview reload and an app restart.
Assumes the decision already made: raw provider traffic goes to rotating NDJSON, not SQLite.
Prior art and its failure mode are in `t3code.md`; session-length limits are in `long-sessions.md`.
Tags: **[docs]** vendor documentation · **[source]** crate source/README · **[measured]** run on this
machine 2026-09-02 · **[asserted]** my reasoning, not verified.

## 1. Claude Code already keeps the full transcript

- **[docs]** "Claude Code clients store session transcripts locally in plaintext under `~/.claude/projects/` for 30 days by default to enable session resumption. Adjust the period with `cleanupPeriodDays`." (code.claude.com/docs/en/data-usage)
- **[docs]** Layout, verbatim from the cleanup table (code.claude.com/docs/en/claude-directory#cleaned-up-automatically):
  - `projects/<project>/<session>.jsonl` — "Full conversation transcript: every message, tool call, and tool result"
  - `projects/<project>/<session>/subagents/` — subagent transcripts, "removed with the parent session transcript when it ages out"
  - `projects/<project>/<session>/tool-results/` — "Large tool outputs spilled to separate files"
- **[docs]** `cleanupPeriodDays` default 30, minimum 1; `0` is a validation error. Same cutoff removes orphaned worktrees.
- **[docs]** The sweep **pauses entirely** if Claude Code "can't safely determine the retention period" — a `retention_sweep` OTEL event lists each cause. Unbounded growth is therefore possible even with defaults.
- **[docs]** `projects/<project>/memory/` (auto memory) is excluded from the sweep; directory removed only after it has been empty for the whole retention period.
- **[docs]** `<project>` encoding example given in the docs: cwd `/home/user/work/my-repo` → dir `/home/user/.claude/projects/-home-user-work-my-repo`. So `/` → `-`, including the leading slash.
- **[measured]** Confirmed on this machine: `/Users/stephen/Development/brigadier-ai` → `~/.claude/projects/-Users-stephen-Development-brigadier-ai`. 314 project dirs, 2726 `.jsonl`, 2.7 GB total. Claude Code v2.1.257.
- **[measured]** All 314 project dir names match `[A-Za-z0-9-]+` — zero contain `.` or `_`. Consistent with a broader "non-alphanumeric → `-`" rule but this machine has no cwd with a dot to prove it.
- **[measured]** Nesting confirmed: a session dir `<session-uuid>/` sits *beside* `<session-uuid>.jsonl`, containing `subagents/` (174 seen) and `tool-results/` (150 seen). Subagent files are paired `agent-<id>.jsonl` + `agent-<id>.meta.json`.
- **[measured]** `agent-<id>.meta.json` top-level keys: `agentType` (str), `description` (str), `toolUseId` (str), `spawnDepth` (int). That is a ready-made subagent tree, no parsing of the transcript required.
- **[measured]** Transcript is heterogeneous NDJSON, not just messages. Line `type` values seen in one 40-line sample: `user`, `assistant`, `system`, `attachment`, `mode`, `permission-mode`, `atis-latch`, `file-history-snapshot`, `ai-title`, `last-prompt`. Common keys: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, `requestId`, `effort`.
- **[measured]** Transcripts get large: biggest single file 44.8 MB; biggest subagent file 36.2 MB. A 2.0 MB main transcript had 2.3 MB of siblings.
- **[measured]** `~/.claude/sessions/` holds one small file per *running* session (`<pid>.json` + a `.key`), removed on exit — **[docs]** used "to detect concurrent sessions and crashes", not part of the age sweep.
- **[asserted]** Consequence: storing raw provider traffic ourselves duplicates a file the CLI already wrote. Our NDJSON should exist only for what the CLI's transcript does *not* contain — our own canonical/orchestration events — or be dropped in favour of a pointer.
- **[asserted]** But a pointer alone is unsafe: the CLI deletes the transcript after `cleanupPeriodDays`, and the path is only reconstructible if we also record the cwd at spawn time (worktree paths move and get deleted). Store `{project_key, session_id, transcript_path, cwd}` and treat the file as a cache that can vanish.

### SDK options that control this

- **[docs]** `persistSession: boolean`, default `true`. "When `false`, disables session persistence to disk. Sessions cannot be resumed later." It is the on/off switch for the `~/.claude/projects` writes, nothing finer.
- **[docs]** `--no-session-persistence` is the CLI equivalent alongside `-p`; `CLAUDE_CODE_SKIP_PROMPT_HISTORY` skips transcripts *and* prompt history in any mode. Python SDK has no `persistSession` equivalent.
- **[docs]** `sessionStore?: SessionStore` — "Mirror session transcripts to an external backend so another host can resume them." Two required methods: `append(key, entries): Promise<void>`, `load(key): Promise<SessionStoreEntry[] | null>`. Optional: `listSessions`, `listSessionSummaries`, `delete`, `listSubkeys`.
- **[docs]** `SessionKey = { projectKey: string; sessionId: string; subpath?: string }`. `projectKey` is "a stable, filesystem-safe encoding of the working directory"; `subpath` "follows the on-disk layout, for example `subagents/agent-<id>`".
- **[docs]** `append` fires "After each batch of transcript entries is written locally" — batched, not per chunk. This is the hook t3code did not have.
- **[docs]** Dual-write: "The Claude Code subprocess always writes each batch of transcript entries to local disk first, and the SDK then forwards the same batch to your store's `append()`, so the store is a mirror of the local transcript rather than a replacement for it."
- **[docs]** Exception: a run **resumed from the store** runs under a temp `CLAUDE_CONFIG_DIR` and "the local copy is deleted at run end, so the store holds the only durable copy."
- **[docs]** `persistSession: false` and `enableFileCheckpointing` each **conflict** with `sessionStore`; "the SDK throws at startup if you combine either with a store."
- **[docs]** Mirror writes are best-effort: up to 3 attempts total with short backoff, timeouts are not retried, then it "logs the error, emits a `{ type: "system", subtype: "mirror_error" }` message into the iterator, drops the batch, and continues". Retries can re-deliver — "deduplicate by `entry.uuid`".
- **[docs]** "The SDK never deletes from your store on its own. Retention is the adapter's responsibility."
- **[docs]** Reference adapters (S3/Redis/Postgres) live in `examples/session-stores/` in the TS SDK repo, are not published to npm, and ship a conformance suite (`shared/conformance.ts`).
- **[docs]** `getSessionMessages` returns the post-compaction chain: "a session whose store holds 503 raw entries may return 18 messages". Raw history requires `store.load(key)`.
- **[asserted]** `sessionStore` is a JS-side interface. From a Rust core it is reachable only if a Node sidecar drives the SDK (see `sidecar-spike.md`); it is not callable from Rust. For a Rust-driven NDJSON-over-stdio design, the local `~/.claude/projects` file plus our own pointer is the equivalent, and costs nothing.
- **[asserted]** Do **not** set `persistSession: false`. It is the only thing making `resume` work, it is what `long-sessions.md` relies on for continuity, and it forfeits the free transcript.

## 2. Rust SQLite for a Tauri 2 app

Repo grounding: **[measured]** `src-tauri/Cargo.toml` currently declares `tauri = { version = "2" }`, resolved to **2.11.5** in `Cargo.lock`. No SQL dependency yet.

| | rusqlite | sqlx (sqlite) | tauri-plugin-sql |
|---|---|---|---|
| version **[docs]** | 0.40.2 (2026-08-08) | 0.9.0 (2026-05-21) | 2.4.1 (2026-08-31) |
| async | blocking | async wrapper | async (sqlx) |
| bundled sqlite | 3.53.2 **[measured]** | 3.51.3 **[measured]** | via sqlx |
| migrations | none built in | `sqlx::migrate!` | `Migration` struct + `add_migrations()` **[docs]** |
| callable from Rust | yes | yes | awkwardly **[source]** |

- **[source]** rusqlite README: "`bundled` uses a bundled version of SQLite. This is a good option for cases where linking to SQLite is complicated, such as Windows." Bundled source is "currently SQLite 3.53.2 (as of `rusqlite` 0.40.1 / `libsqlite3-sys` 0.38.1)". System-library builds need "SQLite version 3.45.3 or newer".
- **[measured]** Resolved on this machine: rusqlite 0.40.2 → libsqlite3-sys 0.38.2 → runtime `sqlite_version()` = **3.53.2**.
- **[measured]** Binary size, macOS arm64, release + `opt-level="z"` + `lto=true` + `codegen-units=1` + `strip=true`:
  - empty binary 285,952 B
  - `+ rusqlite/bundled` 1,192,704 B → **+886 KiB**, 34 crates in the lock
  - `+ sqlx/sqlite + tokio` 1,477,152 B → **+1.14 MiB**, 117 crates in the lock
  - sqlx costs **+278 KiB and 83 extra crates** over rusqlite for this workload.
- **[measured]** sqlx 0.9.0 resolved libsqlite3-sys **0.37.0**, bundling SQLite **3.51.3** — two point releases behind rusqlite's.
- **[docs]** sqlx: "the `sqlite` feature enables the `bundled` feature of `libsqlite3-sys`, which builds SQLite 3 from included source code and statically links it into the final binary." `sqlite-unbundled` links a system install.
- **[docs]** sqlx: "Only one version of `libsqlite3-sys` may appear in the dependency tree of your project" — 0.9.0 uses a version *range* specifically to coexist with rusqlite. Mixing both is possible but is a standing upgrade hazard.
- **[docs]** sqlx FAQ concedes the async story is a wrapper: "we support SQLite, which also only has a blocking API, that's the exception and not the rule. Wrapping blocking APIs is not very scalable."
- **[docs]** sqlx `SqliteConnectOptions` defaults, verbatim: journal_mode — "SQLx does not set a journal mode by default, to avoid unintentionally changing a database into or out of WAL mode."; synchronous — "The default synchronous settings is FULL. However, if durability is not a concern, then NORMAL is normally all one needs in WAL mode."; busy_timeout — "The default busy timeout is 5 seconds."; create_if_missing — "By default, a new file **will not be created** if one is not found."; foreign_keys enabled by default.
- **[docs]** tauri-plugin-sql exposes exactly four public structs (`Builder`, `DbInstances`, `Migration`, `PluginConfig`) and three enums (`DbPool`, `Error`, `MigrationKind`). Query execution is the JS API (`import Database from '@tauri-apps/plugin-sql'`, `Database.load()`, `db.execute()`).
- **[source]** `pub struct DbInstances(pub RwLock<HashMap<String, DbPool>>);` and the plugin calls `app.manage(instances)`, so Rust *can* reach the pool via `app.state::<DbInstances>()`. **[asserted]** That is a back door, not an API: you get a `DbPool` enum you must match on, no typed queries, and every schema decision routed through a plugin whose intended consumer is the webview.
- **[asserted]** The plugin also puts the database on the wrong side of the trust boundary. A supervisor that owns child processes, approvals and cost counters should not have its state table writable from webview JS.

**Recommendation (mine): `rusqlite` with `features = ["bundled"]`.** Blocking is correct here — writes are batched and off the hot path (§3), so they belong on a `spawn_blocking`/dedicated writer thread, not in an async pool. It bundles the newest SQLite, costs 278 KiB and 83 crates less than sqlx, and leaves the DB entirely in Rust. Hand-roll migrations as a `user_version` pragma ladder; 43 migrations (t3code's count) is a symptom, not a target.

## 3. Write patterns that avoid the t3code failure

The failure to design against: **[t3code.md]** append-only `orchestration_events` with per-chunk assistant persistence, 282 KB → 218 MB in 25 h, and deleting threads did not purge events (issue #5110).

- **[docs]** Batching is the whole game: "if you surround multiple INSERT statements with BEGIN...COMMIT then all the inserts are grouped into a single transaction. The time needed to commit the transaction is amortized over all the enclosed insert statements and so the time per insert statement is greatly reduced." SQLite does "50,000 or more INSERT statements per second" but only "approximately 60 transactions per second" on a 7200RPM disk. (sqlite.org/faq.html)
- **[asserted]** One transaction per ~250 ms per writer thread, coalescing all sessions, is the shape. N concurrent sessions must share one writer, because **[docs]** in WAL "there can only be one writer at a time" (sqlite.org/wal.html).
- **[docs]** WAL concurrency: "Writers and readers can run at the same time" — readers do not block the writer and vice versa; but a long-running reader can prevent a checkpoint from completing.
- **[docs]** `synchronous=NORMAL`: "the SQLite database engine will still sync at the most critical moments, but less often than in FULL mode", and crucially "WAL mode is safe from corruption with synchronous=NORMAL... WAL mode does lose durability." (sqlite.org/pragma.html)
- **[docs]** The precise loss, from the WAL page: "Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL but omit this sync if PRAGMA synchronous is set to NORMAL... transactions are no longer durable and might rollback following a power failure or hard reset."
- **[asserted]** That trade is right for UI-reload state and wrong for nothing we store: losing the last few hundred ms of feed rows after a power cut is invisible. Set `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON` at open.
- **[docs]** Autocheckpoint: "SQLite will automatically checkpoint whenever a COMMIT occurs that causes the WAL file to be 1000 pages or more in size" — default ~4 MB. A checkpoint "merely causes SQLite to start overwriting the WAL file from the beginning"; it does not shrink the file.
- **[docs]** `journal_size_limit` "may be used to limit the size of rollback-journal and WAL files left in the file-system after transactions or checkpoints". **[asserted]** Set it (e.g. 64 MiB) or a stalled checkpoint leaves a WAL that never comes back down.
- **[asserted]** Shape the schema so the append log is not the truth. Per session, one **upsert-per-session current-state row** (status, last activity, token/cost counters, resume cursor, pending-approval id) — bounded at O(sessions), rewritten in place. The feed is the only append table and is capped, not archival: keep the last N terse rows per session (N ~ 500), delete older rows in the same transaction that inserts. Cost/usage counters are `UPDATE ... SET tokens = tokens + ?`, never one row per event.
- **[asserted]** Deleting a session must delete its rows in the same transaction — `ON DELETE CASCADE` on every child table. #5110's "deleting threads does not purge events" is a missing foreign key, not a hard problem.
- **[docs]** Why the file will not shrink on its own: "When a large amount of data is deleted from the database file it leaves behind empty space, or 'free' database pages." (sqlite.org/lang_vacuum.html)
- **[docs]** `VACUUM` "rebuilds the database file, repacking it into a minimal amount of disk space", needs "as much as twice the size of the original database file... in free disk space", and "will fail if there is an open transaction on the database connection".
- **[docs]** `auto_vacuum` cannot be retrofitted: "The default setting for auto-vacuum is 0 or 'none'... auto-vacuuming must be turned on before any tables are created. It is not possible to enable or disable auto-vacuum after a table has been created."
- **[docs]** The escape hatch is closed in WAL: "When **not** in write-ahead log mode, the page_size and/or auto_vacuum properties of an existing database may be changed by using the pragmas and then immediately VACUUMing the database." (emphasis mine) **[asserted]** So `auto_vacuum` must be set in the very first migration, before `CREATE TABLE`, or it costs a journal-mode round trip forever after.
- **[docs]** `PRAGMA incremental_vacuum` "causes up to N pages to be removed from the freelist. The database file is truncated by the same amount."
- **[asserted]** Therefore: `PRAGMA auto_vacuum=INCREMENTAL` as the first statement of migration 0, then `PRAGMA incremental_vacuum(<N>)` on idle after a bulk delete. This gives shrinking without VACUUM's 2x disk spike and its inability to run mid-transaction. Full `VACUUM` only as a user-triggered maintenance action.
- **[asserted]** Add a startup assertion on DB size (log loudly above, say, 200 MB). t3code's growth was invisible until a user measured it.

## 4. Rotating NDJSON in Rust

- **[docs]** `tracing-appender` 0.2.5 (2026-04-17, tokio-rs/tracing): `Rotation` is `MINUTELY | HOURLY | DAILY | NEVER` — **time-based only, no size limit**. `Builder` methods: `new`, `rotation`, `filename_prefix`, `filename_suffix`, `max_log_files(n)` ("Keeps the last `n` log files on disk"), `latest_symlink`, `build(directory)`.
- **[asserted]** Disqualifying for this use: a burst of provider traffic can put hundreds of MB into one hourly file. Size is the dimension that matters; `tracing-appender` does not have it. It is also a `tracing` subscriber writer, not a plain per-session sink — wrong shape for N independent streams.
- **[docs]** `file-rotate` 0.8.0 (2025-02-27, kstrafe/file-rotate, MIT, 5.4 M downloads): `FileRotate` implements `std::io::Write`. `ContentLimit::{Bytes, Lines, Time(TimeFrequency)}`. `SuffixScheme::{AppendCount, AppendTimestamp}` with `FileLimit` retention. `Compression::OnRotate` gzips rotated files via flate2. Survives deletion of the log directory without faulting.
- **[asserted]** `file-rotate` covers the requirement exactly (bytes + count limit + gzip) and is the honest answer over hand-rolling — but note the last release is Feb 2025, ~19 months stale. It is small enough that vendoring it is a viable exit if it goes unmaintained.
- **[asserted]** Sizing: t3code used 10 MB x 10 files per stream, 512 MB global cap, 14-day age (`EventNdjsonLogger.ts`). That is a reasonable starting point precisely because it is the one part of t3code that did not blow up.
- **[asserted]** fsync policy: none per line. A line-oriented log wants a `BufWriter` flushed (write(2), not fsync) at the same ~250 ms tick as the DB batch, plus an explicit flush on session end and on app exit. NDJSON is self-healing — a torn final line is discarded by the reader — so the only real requirement is that the DB never references a session whose log is missing. fsync per line would reintroduce exactly the per-chunk syscall cost that sank t3code, on the same hot path.
- **[asserted]** Ordering matters more than durability: flush the NDJSON writer *before* committing the DB transaction that points at it, so the DB never claims data the log lacks. The reverse (log ahead of DB) is recoverable.

## 5. App data location via Tauri

- **[docs]** `PathResolver` methods, all `pub fn ...(&self) -> Result<PathBuf>` (docs.rs/tauri/2.11.5/tauri/path/struct.PathResolver.html), reached as `app.path().app_data_dir()`.
- **[docs]** `app_data_dir()` → `data_dir()/${bundle_identifier}`: macOS `$HOME/Library/Application Support`, Windows `{FOLDERID_RoamingAppData}`, Linux `$XDG_DATA_HOME` or `$HOME/.local/share`.
- **[docs]** `app_local_data_dir()` → `local_data_dir()/${bundle_identifier}`: macOS `$HOME/Library/Application Support`, Windows `{FOLDERID_LocalAppData}`, Linux `$XDG_DATA_HOME` or `$HOME/.local/share`.
- **[docs]** So the **only** difference is Windows: `app_data_dir` is Roaming, `app_local_data_dir` is Local. macOS and Linux resolve identically.
- **[docs]** `app_cache_dir()` → macOS `$HOME/Library/Caches`, Windows `{FOLDERID_LocalAppData}`, Linux `$XDG_CACHE_HOME` or `$HOME/.cache`.
- **[docs]** `app_log_dir()` → macOS `$HOME/Library/Logs/${bundle_identifier}`, Windows and Linux `local_data_dir()/${bundle_identifier}/logs`.
- **[docs]** `app_config_dir()` → macOS `$HOME/Library/Application Support`, Windows `{FOLDERID_RoamingAppData}`, Linux `$XDG_CONFIG_HOME` or `$HOME/.config`.
- **[docs]** The docs do not state whether these methods create the directory. **[asserted]** Assume not; `create_dir_all` before first use.
- **[asserted]** Use `app_local_data_dir()` for the database and NDJSON. A roaming profile that syncs a live SQLite WAL across machines is a corruption vector and a bandwidth problem; machine-local worktree paths and PIDs make the data meaningless on another machine anyway. `app_cache_dir()` is wrong for both — the OS may delete it, and the DB is not reconstructible.

## 6. Pending approvals across a reload

The requirement: after a reload, an unanswered permission prompt is still on screen.

- **[t3code.md]** Prior art: `canUseTool` mints an `ApprovalRequestId` + a `Deferred<Decision>`, registers it in an in-memory `pendingApprovals` map, and awaits it. The answer arrives by RPC and resolves the Deferred. The record is persisted to `projection_pending_approvals` so a reload still shows the prompt.
- **[asserted]** The two failure cases are not the same and must not share code:
  - **Webview reload** (Cmd-R, devtools reload, frontend crash): the Tauri Rust process is the host of the webview, so it does not restart. Child processes, their stdio, and the in-memory `Deferred` all survive. The prompt is **fully resumable** — the frontend re-reads the pending row and re-renders; answering resolves the still-live Deferred.
  - **App restart** (quit, crash, OS reboot): the Rust process is gone, so every child process and every in-memory Deferred is gone with it. The pending row survives, but **nothing is listening**. This case can only be shown as **expired**.
- **[asserted]** Because the two look identical to the frontend, the distinguishing fact must be persisted by the Rust side, not inferred: stamp each app launch with a `run_id` (a UUID minted once at startup) and store it on the pending row. On read, `row.run_id == current_run_id` → resumable; otherwise → expired. This is the same trick `~/.claude/sessions/` uses with a pid file **[docs]** ("used to detect concurrent sessions and crashes"), and it is more reliable than a pid because pids are reused.
- **[asserted]** Minimal record — everything needed to *render* the prompt, and nothing needed to *answer* it (the answer path is in-memory or it does not exist):
  `approval_id` (PK) · `session_id` (FK, cascade) · `run_id` · `created_at` · `tool_name` · `tool_input_json` (truncated, with a byte-length so the UI can say "truncated") · `suggested_permission_updates_json` · `status` (`pending|resolved|expired|cancelled`) · `decision`, `decided_at`.
- **[asserted]** `tool_input_json` must be capped. A `Write` approval carries the whole file body; storing it verbatim reintroduces t3code's growth through the back door. Truncate at ~8 KB and keep the full copy in the NDJSON log, which is already rotating.
- **[asserted]** On startup, one statement before the UI loads: `UPDATE pending_approvals SET status='expired' WHERE status='pending'`. Any row surviving a restart is expired by definition, so this is unconditional and needs no `run_id` comparison — `run_id` is then only for telling the user *why*, and for catching a Rust-side panic-and-restart that the user did not notice.
- **[asserted]** Expired must be visibly different from pending: an expired prompt renders read-only with the tool and its arguments, plus the one honest action available — re-run the turn with `resume: <session_id>`, which replays to the same decision point. Silently showing an expired prompt as answerable is worse than showing nothing.
- **[asserted]** On clean shutdown, cancel every pending approval before exit, the way t3code's teardown "fans cancellations to every pending approval". A cancelled row is a better story than an expired one because the agent saw the cancellation.
- **[asserted]** Unresolved: `measurements.md` M2-M4 in the **old** brigadier repo (that file is not in this repo; see CLAUDE.md §1) recorded `canUseTool` never firing, which `t3code.md` contradicts. This whole section is moot if approvals arrive by a different mechanism. Re-measure before building against it.

## Recommendation (mine)

- **`rusqlite` + `bundled`, blocking, on one dedicated writer thread.** Newest bundled SQLite (3.53.2), 278 KiB and 83 crates cheaper than sqlx, and it keeps the database out of the webview's reach. `tauri-plugin-sql` is a JS-facing plugin and is the wrong trust boundary for supervisor state.
- **Open with `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `journal_size_limit`, and `auto_vacuum=INCREMENTAL` set in migration 0 before any `CREATE TABLE`** — WAL mode makes `auto_vacuum` unchangeable afterwards.
- **One transaction per ~250 ms shared by all sessions; never a write per chunk.** Per-session state is an upsert on one bounded row; the feed is a capped ring (delete-old in the insert transaction); usage is `SET x = x + ?`. Nothing in the DB is append-only and archival.
- **Do not store raw traffic, and do not store a bare pointer either.** Claude Code already writes the full transcript to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, but sweeps it after 30 days. Persist `{project_key, session_id, cwd, transcript_path}` plus our own derived summary, and treat the file as a cache that may be gone.
- **`file-rotate` 0.8.0 for our own NDJSON** (`ContentLimit::Bytes` + `FileLimit` + `Compression::OnRotate`), buffered, flushed on the same 250 ms tick and before the DB commit that references it — no per-line fsync. Accept that it is 19 months stale and vendorable.
- **Persist approvals for rendering only, stamped with a per-launch `run_id`, truncating `tool_input`.** Webview reload is resumable because the Rust host survives; app restart is not — expire every pending row unconditionally at startup and render it read-only with a "re-run from here" action.

## Not checked

- Whether `.`, `_`, or non-ASCII in a cwd are also mapped to `-` in the project dir name — no such path exists on this machine.
- `CLAUDE_CODE_PROJECT_DIR_NAME` (referenced by the session-storage docs, requires SDK v0.3.234+) — not read, not tested.
- Codex JSON-RPC persistence: nothing here is verified against Codex, only Claude.
- No WAL/checkpoint benchmark, no measured write throughput, no measured DB growth under N concurrent sessions. Section 3 is documentation plus arithmetic.
- Binary sizes are macOS arm64 only, for a standalone binary, not measured inside a Tauri bundle where LTO across the whole app may differ.
- `sqlx` async-SQLite threading model: the FAQ concedes it wraps a blocking API but does not describe the thread-per-connection mechanism; not read from source.
- Whether `tauri-plugin-sql`'s `DbPool` exposes its inner sqlx pool publicly — `DbInstances` is `app.manage`d, but `DbPool`'s definition was not read.
- Whether Tauri's `app_*_dir()` helpers create the directory.
- Nothing was run against the SDK: `sessionStore`, `persistSession`, and `mirror_error` are documentation only.
- The `canUseTool` contradiction between the old repo's `measurements.md` and `t3code.md` is unresolved and gates section 6.
