# brigadier — current state map at c4d9d29 (for the bb comparison)

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# brigadier today — a stranger's map (HEAD `c4d9d29`, 110 commits, 2026-09-09)

Tauri v2. Rust: 6 crates (~52k LOC) + `src-tauri` (~11k). Frontend: React/TS/Vite, `src/` ~46 top-level
files + ~79 `components/`, one 1,124-line `App.tsx`, no router. macOS only. ~95 registered Tauri
commands (`src-tauri/src/lib.rs:200-300`).

**Read STATUS.md carefully: §§1–3 are dated 2026-09-04 and describe a UI that has since been replaced
twice.** The header notes (2026-09-06/08) and `docs/plans/*-2026-09-0[689].md` are current. README's
"Status, honestly" is stale too (says the loop is "not built"; it was, at `31e551f`).

## 1. Session model — exists and runs (chat); loop exists, barely surfaced

Spawn: `src-tauri/src/commands.rs::start_session` → `Supervisor` → `brigadier_core::claude::process::build_argv`
(`crates/core/src/claude/process.rs:118-160`). Always `--output-format stream-json --verbose
--input-format stream-json --permission-prompt-tool stdio`, `--permission-mode <mode>` pinned last
(deliberate: a user's `defaultMode: bypassPermissions` would otherwise silence every approval),
optional `--model`, `--resume=<tok>` (+`--fork-session`), `--strict-mcp-config` when MCP policy is
`off` (the default). Never `--print`. Own process group; SIGTERM→SIGKILL after 2 s.

Stored: sqlite at `<app_local_data_dir>/brigadier.sqlite`, 10 migration rungs (`crates/store/src/schema.rs`;
STATUS calls it "version 9"). Tables: `projects`, `sessions`, `feed`, `approvals`, `meta`; `intents`;
`plans`, `phases`, `plan_revisions`, `unknowns`, `work_orders`; `chat_items`, `chat_turns`,
`chat_rewinds`, `chat_archive`, `workspace_epochs/rewinds/applies`. So goal/plan/progress/thread all
have durable homes.

**The "rent a window per decision" harness exists in code and runs — but only from tests and one
buried UI affordance.** `crates/supervisor/src/loop_/call.rs:1` is literally "One disposable model
call: spawn, one turn, read the final text, throw the window away… a lead call is never resumed."
`loop_/` = `plan.rs` (planner + lead judgement), `dispatch.rs` (worktree+child per work order),
`green.rs` (merge, run gate, commit), `ladder.rs` (red-gate rung 1 only; rung 2 fusion omitted as
unproven), `barrier.rs`, `state.rs`, `routing.rs`, `verify.rs`, `action.rs`. Proven live **once**,
n=1, driven from `crates/supervisor/tests/live_loop.rs`, on a tempdir throwaway repo, $0.192433,
106 s (STATUS §2). `start_run`/`stop_run`/`current_run`/`unsettled_intents`/`settle_intent` are
registered commands, and `RunCard` is mounted — but at `src/App.tsx:1041-1052` it is inside a
collapsed `<Details>Automation history</Details>` shown **only when no session is selected**. The
loop has never been driven end-to-end through the UI.

Manager/lead/subagents: "lead" is a per-phase disposable call, not a session. Work orders are the
loop's unit (disjoint path ownership validated in `action.rs`). A **separate**, newer parent/child
concept exists in `src-tauri/src/peers.rs`, `peer_sessions.rs`, `peer_mcp.rs` (2026-09-08): an
app-owned stdio MCP server giving a live session nine tools — `list_projects`, `list_sessions`,
`read_session`, `wait_sessions`, `create_session`, `send_message`, `read_inbox`, `stop_session`,
`close_session` — so sessions delegate to and wait on each other across projects. Exists and runs
(installed-release verification in `docs/plans/submission-diagnostics-2026-09-08.md`). Two
orchestration models now coexist and are not unified.

## 2. Worktrees / branches / diffs / commits — exists and runs

`crates/core/src/worktree.rs` (add/remove/prune, filter-driver neutralisation), `crates/supervisor/src/worktree.rs`
(branch namespace `brigadier/<8hex>`, base = `HEAD`, never deletes a branch except a rollback `-d`),
`fork.rs` (fork session into a new worktree). UI: `src/components/SourceControl.tsx` (stage, commit,
amend, push, branch checkout), `ChangesFileList.tsx`, diffs as tabs in `ProjectWorkbench.tsx`,
`src-tauri/src/source_control.rs` / `session_changes.rs`. `commit_message.rs` drafts commit messages
with a disposable tool-denied Claude call over a budgeted staged diff. Session review/apply/undo with
checkpoints exists (`crates/core/src/checkpoint/`).

## 3. Model / provider / mode selection — exists and runs

`src/components/NewSession.tsx` + shared `Pickers.tsx`: model (from `list_models`, default is the
provider's `default` flag), permission mode (`OFFERED_PERMISSION_MODES` in `src/wire.ts`, the full
CLI set including `bypass-permissions`), effort level, and "Project folder vs Isolated worktree" with
a base-branch picker. **No claude-binary path picker**: `probe_claude` auto-detects from PATH,
version-checks, and shows path+version read-only in the sidebar footer; Start is blocked on
`claude_not_installed` / `claude_too_old`. MCP is off per project by default with a `set_project_mcp`
command — but STATUS notes nothing in `src/` ever calls it, so the toggle is still absent.

## 4. Approvals — exists and runs, non-optimistic as specified

`can_use_tool` control request → `crates/claude-wire/src/control.rs` → `core/src/claude/hook.rs` +
`adapter.rs` → `core/src/approval.rs::ApprovalTable` → `pending_approvals` → `src/components/Approvals.tsx`
+ `assistant-ui/elements/approval-card.tsx`. Allow/Deny (deny requires a typed reason).
`App.tsx:769-774` fires `respond()` and changes nothing locally; the card clears only when
`request-resolved` arrives back through the feed (`feedStore.ts:270-271`). A resolved row with
`decision_json = NULL` is a third state, `Expired` — neither allowed nor denied. Free-text answers to
model questions are explicitly unwired (`Approvals.tsx:227`).

## 5. Usage windows — planned only

`rate_limit_event` is a typed wire message but its payload is `Option<Value>`, deliberately untyped
(`crates/claude-wire/src/message.rs:876`), and the adapter drops it in a pass-through arm
(`crates/core/src/claude/adapter.rs:587`). `unifiedWindows` appears nowhere outside the research
binary `crates/claude-spike/src/bin/fanout.rs:311` and fixtures. **No storage, no emission, no gauge,
no 80% reserve anywhere.** `src/components/Composer.tsx:692-701` says so in a comment and shows raw
token counts instead. What does exist is a different thing: a per-session **context-window** meter
(`SessionContext.tsx`, `session_context` command, polled 8 s busy / 30 s idle).

## 6. Long sessions — partial

Resume: `--resume` + `fork-session`, `supervisor/tests/live_resume.rs` (`#[ignore]`d, has been run).
Process death: `process.rs` races `child.wait()` against a kill request and always resolves an
`ExitInfo`; `crates/proc` sweeps orphaned process groups at startup. Transcripts: our own rotating
NDJSON at `<data_dir>/raw/<session_id>.ndjson`, reopened on resume; sqlite `feed`/`chat_items` hold
the rendered thread; provider transcripts (3.0 GB on this machine) are the CLI's own and can't be
deleted because `--resume` reads them. Retention policy for both is unwritten (vision §12.5). No
compaction handling in Rust — it is the CLI's concern.

## 7. Performance — measured, mostly good

Events reach the webview over one `tauri::ipc::Channel<FeedBatch>` (`src-tauri/src/sink.rs`),
replaced not accumulated on each `subscribe_feed` (a post-reload send is silently dropped); batching
happens in the supervisor. Frontend: `src/feedStore.ts` appends to a module buffer and drains once per
`requestAnimationFrame` (250 ms `setTimeout` fallback for when WKWebView pauses rAF), fixed 2,000-row
rings, `notify()` once per frame into `useSyncExternalStore`. Virtualization is
`@tanstack/react-virtual` in `Feed.tsx`.

Headline numbers: `substrate.md` — 1.47M msg/s parsing one NDJSON child, 2.68M msg/s across 10
children, Tauri 8.6 MiB / 172 MB RAM vs Electron 244 MiB / 409 MB, and the finding that *which* IPC
path you pick matters more than Electron-vs-Tauri; its Electron recommendation is overridden.
Elsewhere: exec→FCP **287–295 ms p50 (n=19)** against a ≤200 ms budget — ~90 ms over, and blank for
all of it; spawn→`system/init` **643.5 ms** MCP-off, **1,395 ms** MCP-on; click-session→painted p50
32.5 ms (capped by `TAIL_ROWS=48`, not fast); 60 Hz held in 62/62 windows under load but the run
failed its own dropped-vsync gate 1/62 — and every burn number is a debug build.

## 8. User flow today

Launch → `src/Launch.tsx`: a cinematic intro with a 10 s ambient audio track (`public/audio/welcome.m4a`),
name entry, greeting, then lazy-loads `App`. Then: sidebar of projects with nested sessions (archive/
trash/search) → pick or add a project (native folder picker) → the dock (`Dock.tsx`) in "Session"
mode with model/permission/effort/worktree pickers → Start → `ThreadView` renders an assistant-ui
thread with compact expandable work blocks (`threadProjection.ts`, `WorkTrace.tsx`) → approvals appear
inline as cards → optional workspace: file tree, Monaco editor tabs, diffs, source control, notes,
xterm.js terminal dock, session review/rewind.

**What a stranger will find confusing:** the product reads as a polished multi-session Claude Code
*chat client with an IDE bolted on*, not as "a lead that never accumulates". The autonomous loop —
the thing `docs/vision.md` says *is* the product — is reachable only as a collapsed "Automation
history" panel when nothing is selected. There is no usage gauge despite the vision making it the
one number. Two orchestration stories (loop work orders vs peer-MCP session delegation) sit side by
side unexplained. And a cinematic intro with music in a developer tool is a genuine surprise.

## 9. Tests and gates

Rust: 517 `#[test]`/`#[tokio::test]` markers — core 204, supervisor 175, store 98, proc 24,
claude-wire 16, claude-spike 0. Last recorded full run: **670 passed, 8 ignored**
(`submission-diagnostics-2026-09-08.md`). Frontend: **Vitest + jsdom + Testing Library**, 45–58
`*.test.*` files, last recorded **375 passed**. `#[ignore]`d live tests that spend real money:
`live_pong`, `live_approvals`, `live_resume`, `live_worktree`, `live_loop`, `live_two_sessions`;
`flood_baseline` is a free instrument.

**Clippy:** STATUS §3 records `cargo clippy --workspace --all-targets -- -D warnings` **exit 0** at
`e0f1375` (2026-09-04). It then went red — `session-coordination-implementation-2026-09-08.md` says
strict clippy was **blocked** by `items_after_test_module`, `type_complexity`,
`too_many_arguments`, `regex_creation_in_loops`, `field_reassign_with_default` in existing code. The
later `submission-diagnostics-2026-09-08.md` says "Strict Clippy, TypeScript, documentation and
release build passed". Not re-run here; treat green as claimed, not verified.

## 10. Landmines (STATUS.md, one line each)

- macOS Cmd-Q fires only `RunEvent::Exit`; `ExitRequested` never fires — shut down in the `Exit` arm.
- `#[tauri::command]` fns must be `pub(crate)` with crate-unique names.
- `Channel::send` after a webview reload is silently dropped; the frontend must re-subscribe.
- Envelopes with `raw` are ~4.3 KB; signals strip `raw`; every message must stay under 8,000 B.
- The FPS meter's `hz` must snap to 120/60/30.
- A process group outlives its leader; check liveness by group enumeration, never start-time match;
  `USER` must survive in the child env and `CLAUDE_CONFIG_DIR` (never `HOME`) is the account boundary.
- `system/init` arrives once per *turn*, so a resumed session stays `starting` until the first turn.
- `hook_callback` frames get no event; hook evidence is `decision_reason_type:"hook"` on the next
  `can_use_tool`; the CLI's built-in read-only Bash set never prompts.
- A "remember X" prompt makes the model try to `Write` under `~/.claude/projects/.../memory/`; a live
  test must auto-deny it or hang 600 s.
- `feed`'s insert is `ON CONFLICT(session_id, seq) DO UPDATE`; a second writer not seeded past
  `last_event_seq` rewrites history silently.
- `git worktree remove` without `--force` deletes gitignored files and exits 0;
  `status.showUntrackedFiles=no` blinds `--porcelain`; every git call sets `LC_ALL=C`.
- `git rev-parse --git-common-dir` is relative to `-C`; `check-ref-format --branch` exits 128 on a
  bad name; a throwaway test repo needs an initial commit.
- The first launch after `e0f1375` migrates the owner's DB one-way; an older binary then refuses it.
- `cost_usd_cumulative` written before `b2c1a4c` under-reports resumed sessions; `result.total_cost_usd`
  is cumulative and must never be summed.
- The batcher prunes counters after start+exit, so a resumed session's `rows_total` restarts at zero.
- `crates/proc/tests/orphans.rs::a_kill_takes_down_the_whole_group` flaked once.
- Tailwind's oxide scanner walks the filesystem and reads Markdown — a class named in prose ships;
  fix is `source(none)` plus explicit `@source`, gated by `src/index.css.test.ts`.
- An edit to a tree-shaken export moves the bundle zero bytes — check a string literal, not an identifier.
- jsdom 30 has no `PerformanceObserver` (Node's stand-in never fires, so tests pass vacuously) and no
  `window.matchMedia`.
- A contrast ratio is a property of a *pair*: every hover/selected state is a new ground needing its
  own derivation; a token comment certifies exactly one pairing.
- Every launch spawns `claude --version` twice (setup + `probeClaude`) — no session, no cost.
- `pgrep -fl claude` is not evidence; use `pgrep -x claude` and set-diff before against after.
- A measured dead end can be re-proposed from a code reading — read
  `perceived-performance.md`'s trap list before ordering any store change.
- The dev burn writes synthetic sessions into whatever data dir the app points at, including the
  owner's real one (40 synthetic sessions are in it now).

## In flight, not landed

`docs/plans/assistant-ui-parallel-work-2026-09-09.md` — a six-task parallel migration to official
assistant-ui Elements (92 approved catalog entries, 51 deferrals), plus attachments across peer
delegation. Planned only; 8 untracked docs in the tree.
