# Autonomous run, 2026-09-02: finish phase 3 and restyle the UI while the owner is away

You are the lead for this session, working under `~/.claude/CLAUDE.md` (plan, decompose into
owned-path work orders, delegate to `Agent` subagents, review every diff in full, run the gates
yourself) and the project's `CLAUDE.md` (research before any API or library decision; no invented
progress; say what was not checked). Read both first, then `docs/plans/next-session.md` and
`docs/plans/ipc-contract.md`, then the three research briefs written this morning:
`docs/research/approvals.md`, `docs/research/resume.md`, `docs/research/worktree-git.md`.

## The owner's standing instructions for this run

- The owner (Stephen Golban) is away for about 1 h 40 min from the moment this session starts.
  Nobody can answer a question or click in the Tauri window. Do not block on the owner.
- The owner said on 2026-09-02: finish the product while away; it should be done on return. That
  is the explicit go for **committing each finished item on `main` without waiting**, one commit per
  item, message prefixed `phase 3.<n>:`. Never push. Never run `gh auth switch`.
- Live spend: `claude-haiku-4-5` only, cents, and report **every** live run's cost from the store's
  `cost_usd_cumulative`, never from memory. Cap this session's total live spend at $0.60. One live
  run per proof; at most two retries per proof. No live run outside an `#[ignore]` integration test.
- The previous lead session is done and will not touch the tree again. You are the only writer.

## Where the tree stands right now (uncommitted, on top of `d95d6e3`)

Item 1 (approvals end to end) is **built and proven live but not committed**. Two workers changed:

- Rust: `crates/core/src/claude/{hook,driver,process,mod}.rs`, `crates/core/src/driver.rs`, new
  `crates/supervisor/tests/live_approvals.rs`, new fixture
  `crates/claude-spike/fixtures/s7-can-use-tool-write.ndjson`, §12 appended to
  `docs/research/approvals.md`. `AskGatedTools` is the default hook policy (`claude/driver.rs:104`,
  `:120`): `PreToolUse` answers `permissionDecision: "ask"` for `Bash`, `Write`, `Edit`,
  `MultiEdit`, `NotebookEdit`, `{}` for all else. Live run, 1 of 1: deny → model saw
  `tool_result is_error:true "denied by brigadier test"`; allow → real `ls -1` stdout; `Write`
  denied, no file written; the CLI echoed our reason as `decision_reason_type:"hook"`.
  **Cost $0.045850** (981 in / 844 out / 148 725 cache read / 12 888 cache creation).
- TypeScript: `src/App.tsx`, `src/components/{Approvals,Sidebar}.tsx`, `src/feedStore.ts`,
  `src/mock.ts`, one note in `docs/plans/ipc-contract.md`. Approvals are no longer filtered by the
  selected project; cards carry the project name; sidebar shows an `N pending` badge; the browser
  mock seeds a clearly labelled synthetic cross-project approval. `tsc` and `npm run build` pass
  (251 kB JS).
- The previous lead reviewed the TypeScript diff in full and found it clean. **The Rust diff has
  not been lead-reviewed.** Gates reported by the worker: 182 passed / 0 failed / 2 ignored, clippy
  `-D warnings` clean, rustdoc 0 warnings. Re-run them yourself.
- Also untracked: `docs/research/{approvals,resume,worktree-git}.md`. Commit them with item 1.

Finish item 1 first: review the Rust diff yourself; fix the one known fragility (the live test
asserts `cost < 0.05` and the run cost $0.0459; raise the ceiling to $0.08 or split turn 3 into a
second `#[ignore]` test); run the gates; commit as `phase 3.1: approvals end to end`.

## Then, in this order, each ending in gates + commit

Use the briefs' gap lists as the work orders. Split every item into Rust and TypeScript workers by
owned paths; `docs/plans/ipc-contract.md` is the seam and must be updated in the same commit as any
command or shape it describes. Call a blind adversarial review (a fresh subagent that did not build
the code, briefed with diff + spec) for items 2 and 3; they are the risky ones.

2. **Resume** (`docs/research/resume.md`). Reuse the harness `session_id` row; new `instance_id`;
   `resume_token` → `--resume=<id>` appended to the existing argv; **seed the adapter's envelope
   `seq` from `sessions.last_event_seq`** (the insert is `ON CONFLICT DO UPDATE`, so a restart at
   seq 1 silently overwrites history — point the adversarial reviewer here); resumable when
   `resume_token.is_some() && !is_live(id)`, status `exited` **or** `failed`; new `Op::SessionResumed`
   in the store writer to clear `ended_at`/`exit_code`; new `resume_session` command + `not_resumable`
   error code; Resume button in the composer, disabled while live; `feed_tail` unchanged. Live proof:
   an `#[ignore]` supervisor test that starts a session (one short turn), ends it, resumes it with a
   question only the prior turn can answer, and checks the feed rows continue after the old
   `last_event_seq`. Report cost.
3. **Worktree per session** (`docs/research/worktree-git.md`). Short id = first 8 lowercase hex of
   the session UUID; branch `brigadier/<id>`; path `<project>/.brigadier/worktrees/<id>`; write
   `.brigadier/` to `$GIT_COMMON_DIR/info/exclude` once at project-add time, never `.gitignore`;
   pre-check `git rev-parse --verify HEAD` and refuse an unborn HEAD instead of orphaning; roll back
   the branch when `add` fails (git 2.50.1 leaks it); cleanup on end/kill removes the worktree and
   **keeps the branch**, never `--force` on a dirty tree without an explicit second call carrying the
   dirty count; `git worktree prune` per project at app start. `sessions.worktree_path`/`branch`
   already exist in the schema; add them to `SessionView`, `wire.ts`, `feedStore.ts`, the mock and
   the sidebar row. Note for resume: a worktree cwd changes the CLI's transcript directory; since
   CLI 2.1.223 `--resume` searches other projects, but this is documented, not measured — measure it
   in item 2's or 3's live test if the budget allows, otherwise say it was not checked.
4. **Two live sessions on one project.** `#[ignore]` supervisor test: two real Haiku sessions on one
   project, one trivial turn each, interleaved feed ordered by time, per-session counters and
   costs correct, both ended gracefully via `shutdown_with`. Report both costs.
5. **UI restyle to match the ChatGPT macOS app** (see next section). Separate commit.
6. **Carry-overs** from `next-session.md` §5 only if time remains, in this order: lock the data dir
   against a second app instance; shrink the batcher's per-project maps; `tauri-plugin-dialog`
   folder picker (research first). Skip the burn profiling.

Stop starting new items when about 20 minutes of the owner's absence remain, and write the report.

## UI restyle: match the ChatGPT desktop app's sidebar and chat surface

The owner wants the sidebar and the chat interface to match the installed ChatGPT macOS app
exactly, and will do the remaining UI changes together with you on return. Facts:

- `/Applications/ChatGPT.app` is installed, version 26.825.51511, **native** (Swift; frameworks are
  Sparkle and a Codex framework, no web bundle, no CSS to read). It is not running.
- To see it: `open -a ChatGPT`, wait a few seconds, then screenshot its window with
  `screencapture -l <windowid> <file>` (get the id with `osascript`/`swift` via `CGWindowListCopyWindowInfo`,
  or use `screencapture -x` full-screen). This needs Screen Recording permission for the terminal;
  if macOS blocks it, do not fight it: fall back to the `design-taste-frontend` skill and a web
  research pass (`research` skill) on the current ChatGPT desktop layout, and say in the report
  that the restyle was done from references, not from a screenshot. **Only observe the app**: never
  sign in, type, send a message, or change its settings. Quit it afterwards (`osascript -e 'quit app "ChatGPT"'`).
- Map, not replace, the harness's information: the ChatGPT sidebar's chat list becomes the
  project → session list (branch name and cost per row stay), its "new chat" becomes the new-session
  form, its message thread becomes the feed (rows stay virtualized on TanStack Virtual; do not
  regress the feed gate in `docs/research/feed-rendering.md`), its composer becomes the composer.
  Approvals keep a visible panel or inline cards; the FPS meter stays in dev.
- Owned paths for the UI worker: `src/` only. No IPC contract change. Gates: `npx tsc --noEmit`,
  `npm run build`, `npm run tauri build`. Take a screenshot of the built app if permission allows
  and save it under `docs/plans/ui-2026-09-02.png` for the owner.

## Gates (run yourself before every commit)

    export PATH="$HOME/.cargo/bin:$PATH"
    cd /Users/stephen/Development/brigadier-ai
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    cargo doc --workspace --no-deps
    npx tsc --noEmit && npm run build
    npm run tauri build            # at least once, before the final report
    # live proofs, one at a time, each reports cost_usd_cumulative:
    CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test live_approvals -- --ignored --nocapture

Landmines already paid for are listed in `docs/plans/next-session.md`; add these from today:
`turn-started` arrives before `session-started` on the signal stream; `hook_callback` frames are
answered without an event, so hook evidence is the `decision_reason_type:"hook"` field on the next
`can_use_tool`; `ls` and other read-only Bash commands never prompt without the hook.

## End of run: the report the owner reads first

Write `docs/plans/report-2026-09-02.md` and update `docs/plans/next-session.md` to the new state.
The report, one line per fact: per item — done/partial/not started, commit hash, live-run cost
from the store, what was not checked; total live spend; gate results at the final HEAD; the UI
restyle's source (screenshot or references); every decision made in the owner's absence (the
$ ceiling change, cleanup defaults, anything the research contradicted). Nothing in it may claim a
Tauri window was clicked; nobody was here to click it.
