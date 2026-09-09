# Composer redesign delivery and verification — 2026-09-09

Implementation follows the approved [composer spec](composer-redesign-2026-09-09.md). The owner subsequently authorized committing, merging to main, cleaning up this session’s worktrees, and rebuilding the installed local app without backups. The functional verification below covers the composer work before integration with the newer main archive/settings change; final integration results are recorded separately below.

## Delivered behavior

- Durable Rust task settings and project preferences separate manual selections from Auto routing. Auto + Approve defaults, inherited projects, setup locking, one-way Auto takeover, effective settings inspection and queued Custom execution snapshots are implemented.
- Auto/Custom has a separate permission-style picker in its existing position; Custom reveals the adjacent provider/model/effort popover and Auto hides it. The provider segments adapt the assistant-ui SettingsPanel source. The thick effort slider orders only available levels from low to high, displays the model and effort centrally, and resets to null/provider default. Unsupported models have no interactive slider. Unavailable saved choices are visible. Both CLI aliases and their observed resolved model IDs are recognized, including effective models inherited during takeover.
- Each subsequent owner/peer dispatch starts a fresh native execution while retaining durable Brigadier identity, event sequence, saved task state, workspace and displayed conversation. Codex steering uses the native acknowledged active-turn operation. Claude steering interrupts and immediately dispatches into a fresh execution. Stop durably pauses work, remains available during queue operations and requires explicit Continue.
- Picker/paste/drop imports share durable per-file pending bytes, receipts, progress, retry and removal. Pending/failed retained attachments block Send. Rich input, exact large pastes, stable request IDs, grouped file/note/session references and staged slash-command selection remain supported.
- Ask/Approve/Full policies reach the actual harness. Independent disposable authorization judgments use authentic owner instructions, durable evidence and conservative escalation. Inline action approvals retain confirmed, expired and failed-response states; the strip jumps without replacing the draft.
- The setup rail remains visible in Auto and Custom before Send and disappears after start. Local/new/existing worktrees and Current/New branch/Checkout choices are staged until Send, shared between modes, and remembered per project. Auto honors explicit setup. Existing worktrees include external Git worktrees, carry active-task status and undergo canonical ownership/lock checks at Send; borrowed paths remain protected from cleanup even after borrower history is deleted. Current new worktrees preserve source changes; alternate refs start from committed state. Checkout neutralizes filters, hooks and filesystem monitors and never silently stashes/discards files. Context exposes the actual locked workspace, changes, sources and workers. The composer has no lifetime token gauge or routine compaction control. Controls respond to the composer container, shorten/wrap and constrain popover width.
- Settings now persists Dark/Light selection, with equivalent semantic palettes. Open Monaco, terminal and highlighted content refresh their palette without remounting the session or editor.
- The existing dev burn panel was reconnected to the sidebar and now opens the newest replay conversation, so render checks exercise a conversation rather than staying on an empty new-task page.

## Automated verification

| Gate | Result |
| --- | --- |
| `cargo test --workspace` | 767 passed, 11 ignored, 42 suites; exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | Exit 0 |
| `cargo doc --workspace --no-deps` | Exit 0 |
| `npm test` | 532 passed, 64 files; exit 0 |
| `npx tsc --noEmit` | Exit 0 |
| `npm run tauri build` | Exit 0; macOS app and DMG built |
| `git diff --check` | Exit 0 |

The rail iteration also updated schema migration fixtures for the new durable borrowed-workspace protection table. Full final Rust and frontend suites pass.

The first final Rust run exposed an existing test race: the process group was no longer alive, but zombie grandchildren had not yet disappeared from kernel membership. The test now uses its existing bounded reaping helper after immediate live-process checks. No production process-management change was made. The orphan suite passed all 15 tests and the focused test passed 50 repetitions before the workspace rerun. Two frontend tests timed out during a concurrent busy run; the unchanged full suite subsequently passed.

Deterministic coverage includes queue snapshot editing, real adapter steering protocol, Stop during pending steering, nonduplicated Stop, durable receipt retries, fresh execution identity, lost acknowledgement recovery, project preference isolation, stale settings events, unsupported effort correction, resolved model aliases, IndexedDB import recovery, large-paste exactness, inline approval lifecycle, references and slash selection.

## Live provider verification

- Claude returned exactly `pong` through the installed authenticated adapter (2.96 seconds).
- Codex accepted a real `turn/steer`; the completed response contained `BRIGADIER_STEER_OK`. A second execution used a different native thread while retaining the Brigadier task ID and increasing event sequence, and returned `BRIGADIER_FRESH_OK` (13.57 seconds). Both owned native processes confirmed exit.
- These tests used disposable prompts/workspaces and no user-project modifications. Reproducible opt-in commands are in [API findings](../research/composer-redesign-apis-2026-09-09.md). Live compaction was not exercised as part of this redesign.

## UI verification

Browser preview checks used explicitly simulated provider/project data. At 1280, 960 and 800-pixel viewport widths, opening the right Files panel reduced the composer container; labels shortened, controls wrapped and popovers remained usable. At the narrowest measurement the composer outer container had clientWidth 256 and scrollWidth 256; the inset control surface was about 216 pixels. The same typed draft survived resizing. Dark and light popovers and composer surfaces were visually inspected; the viewport override was reset afterward. Outside-click dismissal was verified using an unobscured input area.

Native checks used isolated application identifiers and a disposable Git project at `/tmp/brigadier-composer-fixture`. The macOS folder picker loaded the project. New task defaulted to Auto + Approve, Send displayed preparation, a real isolated worktree was created, and the native conversation displayed the exact response `COMPOSER_NATIVE_OK`. The setup rail was absent after start and Context showed the locked actual worktree. Auto inspection showed the actual Claude model; one-way takeover exposed a resolved-model/alias mismatch, now fixed in the catalog and frontend with a regression test. The final alias fix is covered by deterministic tests, not a second rebuilt native takeover run.

## Rail iteration native verification

Measured against the rebuilt isolated macOS app: Auto kept all three setup controls visible and hid execution; Custom exposed the separate provider/model/effort control. Both connected providers appeared in the segmented selector. Native inspection found alphabetical provider-wide effort metadata; the slider now orders actual known levels semantically (low, medium, high, xhigh, max, ultra) with unknown levels retaining their relative order. Medium moved to its correct step, and Reset restored provider default. Browser checks covered nested new-branch starting points and the rail at a 216-pixel container width without horizontal overflow.

A Git worktree created outside Brigadier at `/private/tmp/brigadier-composer-external-rail` appeared through native search, was selected in Auto, and the real task returned exactly `RAIL_EXTERNAL_OK`. The rail disappeared and Context reported Existing worktree with the exact external path and branch. These fixtures belong to the test workflow; no user project was changed. Automated coverage additionally exercises staged Send payloads, occupied/deleted worktrees, out-of-order discovery responses, controls disabled during Send, current dirty snapshot preservation, alternate-branch rejection with dirty local files, remote tracking, and borrowed cleanup protection.

Minor partial-failure boundary: if remote checkout succeeds but upstream configuration fails, the new local branch remains checked out. Retry reports the existing branch and requires selecting it or another new name; it does not overwrite/discard files.

## Outstanding native performance gate

**Not green.** The earlier attempts were interrupted by hot reload/tool failures. The rail iteration completed an uninterrupted native debug 60-second run with 10 synthetic sessions at 200 rows/second each. The UI reported **FAIL: 61 windows, minimum 30 Hz, worst window p95 51 ms, worst frame 61 ms, 22 dropped vsyncs, longest drop run 2, maximum 709 DOM nodes**; 57 windows derived refresh rate from p50. This does not meet the 60 Hz / zero dropped-vsync bar. The replay fixture also displayed a workspace-unavailable banner for its old disposable cwd; its conversation still rendered during capture. No threshold was relaxed.

The latest isolated native launch wrote `main_to_fcp_ms = 4228.675` to `paint.ndjson` while serving the debug frontend. This is one main-entry-to-FCP sample, not an exec-to-FCP p50 and not a passing ≤295 ms result. The broader native startup/render performance gate remains open. This composer task does not claim to resolve that app-wide performance issue.

## Execution and policy boundaries

Fresh per-turn contexts and bounded checkpoint/recent retrieval do not add a hard tool-step/token ceiling inside an individual provider turn. Interactive orchestration uses real peer tools and durable checkpoints, with prompt guidance for decomposition/review/fusion; the separate supervisor loop has additional enforced repair/review limits. The host authorization broker actually performs independent judgments, but interpretation of arbitrary natural-language restrictions remains fallible. Codex native sandbox/approval interception and Claude tool hooks have different coverage. Full access does not guarantee every requested action succeeds. Mixed-provider host dispatch, all native attachment gestures and the complete live approval-fusion interaction were not exhaustively exercised.

## Main integration and local delivery

The owner authorized commit, merge, cleanup and local app replacement without backups. Composer commit `42c5144` was reconciled with main `7823ace`, preserving its dedicated Settings/Archived chats flow, full session disposal, and the composer’s live theme controls. Terminal initialization keeps both archive-state checks and theme updates. The archive navigation helper was moved before its test module to satisfy Clippy without changing behavior.

Measured on the reconciled source: `cargo test --workspace` passed **774 tests**, with **11 ignored** across **42 suites**; `npm test` passed **537 tests** in **65 files**. TypeScript, Clippy with warnings denied, Rust documentation, `git diff --check`, and the release Tauri macOS app/DMG build all exited **0**. The previously reported native render-performance failure remains open; it was not relabeled as passing during integration.

The verified release bundle is used for the authorized replacement of `/Applications/Brigadier.app` after the merge. Temporary test applications, disposable fixture worktrees and this session’s detached worktree are removed during delivery; unrelated worktrees and local reference/research files are preserved.
