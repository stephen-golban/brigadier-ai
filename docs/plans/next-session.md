# brigadier harness — phase 4: finish the carry-overs and the UI with the owner

Read `CLAUDE.md` first. Its first section is the one rule that overrides everything: research the
web before any design decision, library choice, API call, version pin or flag; write findings to
`docs/research/<topic>.md`; cite the file when you act. Check the existing briefs before buying new
research. Then read `docs/plans/ipc-contract.md` (the binding webview ↔ Rust contract),
`docs/plans/report-2026-09-02.md` (what the autonomous run did and did not prove), and this file.

## Where things stand (phase 3 committed on `main`, 2026-09-02)

- **Approvals end to end** (`f1b911f`): `AskGatedTools` is the default `PreToolUse` policy and
  answers `permissionDecision: "ask"` for `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
  Live: deny reached the model as an errored `tool_result`, allow ran the real command, a `Write`
  was denied with no file written. `docs/research/approvals.md` §12.
- **Resume** (`b2c1a4c`): same session row, adapter `seq` seeded from `sessions.last_event_seq`,
  `Op::SessionResumed`, `resume_session` command, `not_resumable`; a reservation under the `live`
  mutex before the spawn and a generation-guarded consumer (a blind review proved two concurrent
  resumes both spawned before that fix); cost and usage accumulate across a resume. Live: recall
  answer `pelican`, rows continued after the old `last_event_seq`. `docs/research/resume.md` §11.
- **Worktree per session** (`b2c1a4c`): branch `brigadier/<8 hex>` and
  `<project>/.brigadier/worktrees/<id>`; `.brigadier/` in `$GIT_COMMON_DIR/info/exclude` at
  project-add; unborn HEAD and a project dir below the repository root are refused; branch rolled
  back with `-d` on a failed `add` or driver start; `cleanup_worktree(session_id, force)` counts
  ignored and untracked files and never deletes a branch; `git worktree prune` per project at app
  start. Live: resume from a worktree cwd works. `docs/research/worktree-git.md` "Measured".
- **Two live sessions on one project** (`8351335`): live test passes; interleaved feed ordered,
  counters correct, `shutdown_with(10s)` drained both in 581 ms.
- **UI restyle** (`41e030f`, wiring in `b2c1a4c`): ChatGPT-shaped shell measured from a
  screenshot of the installed app (Codex view, dark only). `docs/plans/ui-restyle-notes.md`,
  `docs/plans/ui-2026-09-02.png`. Resume button, branch chip, cleanup flow are wired but **have
  never been clicked in a Tauri window**; the browser mock exercises them.
- **Gates at HEAD:** `cargo test --workspace` 209 passed, 0 failed, 5 ignored (the five live
  tests); clippy `-D warnings` clean; rustdoc 0 warnings; `npm run build` ~258 kB JS;
  `npm run tauri build` → `target/release/bundle/macos/brigadier.app`.
- **Live tests** (each `#[ignore]`, `claude-haiku-4-5`, cost printed from the store row):
  `live_approvals` ~$0.046, `live_resume` ~$0.031, `live_worktree` ~$0.030,
  `live_two_sessions` ~$0.053, plus the older `live_pong`. Run one at a time:
  `CLAUDE_BIN="$(command -v claude)" cargo test -p brigadier-supervisor --test <name> -- --ignored --nocapture`.
  `live_approvals` rewrites `crates/claude-spike/fixtures/s7-can-use-tool-write.ndjson` on every
  run; `git checkout` it afterwards unless the capture changed on purpose.

## Landmines already paid for (do not rediscover)

- macOS Cmd-Q → `RunEvent::Exit` only; `ExitRequested` never fires. Shutdown runs in the `Exit` arm.
- `#[tauri::command]` functions must be `pub(crate)` with crate-unique names.
- A `Channel::send` after a webview reload is silently dropped; the front end re-subscribes.
- An `Envelope` with `raw` is ~4.3 KB; signals go out with `raw` stripped; every message < 8,000 B.
- The FPS meter's `hz` must snap to 120/60/30.
- A process group outlives its leader; liveness is by group enumeration; never kill on a
  start-time mismatch. `USER` must survive in the child env; `CLAUDE_CONFIG_DIR` is the account
  boundary, never `HOME`.
- `system/init` arrives **once per turn**, so a resumed session stays `starting` until the first
  turn is sent; `turn-started` can precede `session-started` on the signal stream.
- `hook_callback` frames are answered without an event; hook evidence is
  `decision_reason_type:"hook"` on the next `can_use_tool`. The CLI's built-in read-only Bash set
  (`ls`, `cat`, `echo`, …) never prompts without the hook's `ask`.
- The model may try to `Write` a memory file under `~/.claude/projects/<key>/memory/` on a
  "remember X" prompt; the hook gates it, and a live test must auto-deny it or hang 600 s.
- `feed`'s insert is `ON CONFLICT(session_id, seq) DO UPDATE`: any second writer on a row must
  be seeded past `last_event_seq` or it rewrites history silently.
- `git worktree remove` without `--force` deletes gitignored files and exits 0;
  `status.showUntrackedFiles=no` blinds `--porcelain`. Every git call sets `LC_ALL=C` and
  `-c status.showUntrackedFiles=normal`. A failed `worktree add` leaks its branch on 2.50.1.
- `git rev-parse --git-common-dir` is relative to the `-C` directory. `check-ref-format --branch`
  exits 128 on a bad name. A throwaway repo for a live test needs an initial commit.
- The store's `cost_usd_cumulative` written before `b2c1a4c` under-reports resumed sessions.
- The batcher prunes a session's counters once it saw it start and exit; a resumed session's
  `rows_total` on the wire restarts from zero.
- `crates/proc/tests/orphans.rs` `a_kill_takes_down_the_whole_group` flaked once on 2026-09-02
  (process-group kill timing); passed on every rerun.

## This phase, in order

1. **Click it.** With the owner present: start a session from the restyled UI, see the branch
   chip, end it, press Resume, send a turn, run cleanup on a dirty and a clean worktree. Nothing in
   the new UI has been exercised against the Rust side in a window.
2. **Feed gate after the restyle.** Re-run the burn (`npm run tauri dev -- --release --features
   burn`) and compare against `docs/research/feed-rendering.md`; the row markup is unchanged but
   the centred 736 px column and the new empty state were never measured.
3. **UI follow-ups with the owner** (from `docs/plans/ui-restyle-notes.md`): sidebar vibrancy and
   hidden title bar need `src-tauri` window config; a real icon set; a light scheme is not in the
   reference; a "starts from HEAD, N uncommitted files stay behind" note on New Session; the
   sub-directory-of-a-repo refusal needs a UI message pointing at the repository root.
4. **Carry-overs left** (`7f03eb5` landed the data-dir lock and the batcher shrink):
   `tauri-plugin-dialog` folder picker (research first); the 1 % dropped frames under burn (profile
   before changing anything); a UI branch on `data_dir_locked` at startup; a cross-process lock test.
5. **Resume hardening:** surface the CLI's `No conversation found with session ID` stderr as
   `session_not_found_upstream` (stderr is drained to tracing today); keep the conversation's
   original `started_at` somewhere (it moves on the first resumed turn); a live crash-then-resume
   of a `failed` row.
6. **Not in this phase:** other providers, one-shotting, signing or notarization.

## Verify

    export PATH="$HOME/.cargo/bin:$PATH"
    cd /Users/stephen/Development/brigadier-ai
    git log --oneline | head -6
    cargo test --workspace
    cargo clippy --workspace --all-targets -- -D warnings
    cargo doc --workspace --no-deps
    npx tsc --noEmit && npm run build
    npm run tauri build

## How to work

Lead plans, decomposes into owned-path work orders, delegates to `Agent` subagents concurrently,
reviews every diff in full, calls a blind adversarial review for wide or risky changes (both of
this phase's reviews found real blockers the builders and the live runs had missed), runs the
gates itself, and commits only after the owner's explicit approval. Report every live run's cost
from the store row. No invented progress; a feature "works" only after it has been run. One line
per fact, a path or a number instead of an adjective, the remedy on the same line as the problem,
say what was not checked. Label synthetic feeds loudly.
