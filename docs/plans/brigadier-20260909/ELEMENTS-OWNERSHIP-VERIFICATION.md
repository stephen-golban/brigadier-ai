# Elements, ownership, and stream verification — 2026-09-09

Worktree: `/Users/stephen/.codex/worktrees/f6e5/brigadier-ai`.
Original base: `7823ace1effb9f9856e73147b5d2fdaa7b28f2a3`. Integrated with main `a8ef7587d09f7ec339753ed408de2ee47e68ad92` before the authorized commit and merge.
The handoff manifest's 16 checksums were verified before applying its patch and 11 new files. The original worktree and saved project were not edited.

## Delivered behavior

- Eight Elements are connected to real task, worker, inbox, checkpoint, confirmation, and run state. Context uses consistent compact worker counts.
- Authenticated root owners can manage chats they created and their internal workers without approval. Ordinary fork origins do not confer ownership. Worker cross-session access is rejected centrally, including CLI fallback; the bounded request-owner channel resolves its recipient server-side.
- Claude streamed and completed blocks correlate by message, parent, and kind. Resume-safe item identities and frame replay protection preserve legitimate repeated content.
- Saved projection repair requires raw envelope evidence and a matching completed row. It preserves raw logs and leaves uncertain matches alone.

Details and primary documentation: `docs/research/elements-ownership-streams-2026-09-09.md`. This record supersedes historical verification claims in the transferred implementation ledger for these changes.

## Passed checks

- Rust workspace: 780 passed, 0 failed, 11 ignored.
- Frontend: 477 passed across 61 files (`npm test -- --maxWorkers=4`).
- Clippy: workspace/all targets with warnings denied, including the enhanced live test.
- Rust docs build passed; existing bare-URL rustdoc warning remains.
- Proper Tauri production bundle build passed. Existing Vite chunk-size and dependency externalization warnings remain.
- Live Claude smoke: exactly one completed text item, expected `pong`.
- Live Codex smoke: expected attachment marker returned.
- Conservative legacy repair: positive orphan regression and negative legitimate repetition regressions passed.
- Independent spec and standards reviews completed; reported readiness and repair edge cases fixed and re-reviewed.
- `git diff --check HEAD` passed.

## Installation

The release app was ad-hoc signed, copied over `/Applications/Brigadier.app`, and passed `codesign --verify --deep --strict`. All four installed bundle files match the built bundle. No backup was made; the user data directory was retained.

Executable SHA-256: `605c6da0a33de82040a8e70c7d2decf2a3d3360f48894bfd3a01aba65e603afe`.

The idle prior app process was terminated and the installed app launched. A process exists, but full startup is not yet verified: it has not opened the store, and the historical repair marker is absent. No new frontend errors were recorded, which alone does not establish successful startup.

## Remaining native verification

Computer Use reports the Mac is locked and automatic unlock failed. The user was asked to unlock it. Interactive checks remain pending: rendered Elements and worker navigation, live root/worker ownership lifecycle and denial behavior through the installed app, reload/resume exactly-once rendering, and installed startup repair of the historical orphan. Live provider adapter tests and unit tests do not substitute for these checks. No render-performance claim is made.

## Final main integration

The owner subsequently authorized commit, merge to main, session cleanup, and rebuilding the installed app without backups. Integration retains main's composer setup, durable execution settings, fresh execution context, and non-optimistic approval response promises, together with this task's root-only worker interaction and backend ownership checks. Immutable worker baselines use the newer workspace fields without granting ordinary task workspace ownership. The removed direct-worker intervention path is not reintroduced.

On the integrated source, Rust workspace tests passed **800 tests**, with **12 ignored**; frontend tests passed **548 tests** across **67 files**. TypeScript, Clippy with warnings denied, Rust documentation, the release Tauri app build, and whitespace checks exited zero. Earlier provider smoke checks apply to the pre-integration version. Native UI checks remain blocked by the locked Mac. The inherited composer performance failure remains open, as documented in `docs/plans/composer-redesign-verification-2026-09-09.md`.


## Native follow-up — 2026-09-10

The Mac became available after the other sessions merged. Native checks ran against main `1846f8b` and corrected release builds. The historical locked-Mac notes above describe earlier attempts; they no longer block verification.

Six defects found by native verification were corrected: exact Brigadier schema discovery in Claude Ask mode, server-scoped Codex MCP preapproval for read-only workers, final assignment receipt suppression, separate-chat checkpoint isolation, wrapped stopped/failed Context counts, and Markdown reveal animation that could leave completed text visibly truncated. Details and primary-source notes: `docs/research/native-ownership-verification-2026-09-10.md`.

Measured acceptance evidence:

- Installed startup succeeded. The proven historical orphan in session `fb402873-543f-41ec-86db-51f9d5c5e3cd` was repaired while retaining its authoritative completed row.
- Native Claude Sonnet root `5045d75a-b37c-49b1-9920-0029c20ebd6e` used Ask mode. Its pinned Codex `gpt-5.6-luna` research worker `db17a7ef-a780-4ca2-8ecf-dbd5d7065576` called `list_sessions` and `read_session` against the root. Both returned the actual Brigadier worker ownership denial, rather than a provider approval error. Its bounded `request_owner` ping was accepted and delivered (message `ea3a7a36-0ff8-41f6-82ba-d2291e9633a3`). No approval was needed for these app-owned tool paths.
- Worker completion receipts for turns `d69f51d6-1db6-42b0-8e2a-b8fd35f7e8bd` and `3df01517-b7b5-4cda-a02d-bc888aac6f8c` are consumed by the root's final result reads (`delivered=true`, `attempted=false`, no dispatched turn). Separate explicit worker messages legitimately produced separate root turns.
- Separate chat `33b479a5-6faf-4df9-93d3-f077b19604ec` was created by that root. Repeating the same create request returned the same chat and message receipt (`1ccb75a4-1b32-4286-b3e4-d1636149209a`), with one initial user message. A distinct follow-up produced exactly `NATIVE_CHAT_2`. Stop, kill, and archive on that chat, plus stop/archive on its worker, returned completed without lifecycle confirmation. Persisted origins identify the chat's creator; it is absent from the internal-worker map. Archive state was checked in `session-retention.json`.
- After restart, separate chat `b77640e7-ce6e-4b56-92da-87b8c8ed9acb` received only its own requested prompt and returned exactly `NATIVE_ISOLATED_E_0910`, with no tools or extra commentary. The root archived it successfully. It remains an ordinary creator-owned chat, not a worker. The same root read the existing worker assignment and successfully recorded `integrated` at revision 6 with actual boundary evidence.
- Native worker roster, view-only activity with the root composer retained, checkpoint progress, background result inbox and Context state were inspected. The outcome recommendation saved a confirmed defect in the initial failing fixture. The long Context stopped/failed count now wraps and is fully visible in the narrow conversation beside the worker panel.
- Model prose alone was not counted as evidence: the initial root misdelegated a generic summary, and later claimed integration after merely updating its checkpoint. The negative tests were rerun by the actual worker; integration was subsequently performed through the real `assignment_result` tool. SQL/tool receipts independently corroborate the results above.

Final automated checks: **806 Rust tests passed, 0 failed, 12 ignored** across 43 suites; **550 frontend tests passed** across 67 files. The frozen-animation-frame regression failed before the Markdown fix and passed afterward. Clippy with warnings denied and Rust documentation passed; the pre-existing rustdoc bare-URL warning remains. TypeScript and release bundle builds passed with the existing Vite warnings.


The final text check sent the same prompt twice in separate provider executions. Both live replies displayed the complete `NATIVE_FIXED_REPEAT_0910`, and both remained after restarting the final installed app. SQLite contains exactly two distinct completed rows, with stream generations `1168` and `1182` and final cursors `1180` and `1197`. The earlier legitimate repeated marker also remained twice. No content-based deduplication was introduced.

### Performance result — still failing

A corrected release build with only the test harness enabled (`VITE_BURN=1`, Rust `burn` feature) ran 10 synthetic sessions at 200 rows/second each for 60 seconds, with no concurrent compilation/tests. Native UI reported **FAIL: 60 windows, minimum 30 Hz, worst window p95 115 ms, worst frame 116 ms, 2,107 dropped vsyncs, longest drop run 16, maximum 1,935 DOM nodes**. Refresh rate was derived from p50 in 59 windows. The replay fixture displayed a workspace-unavailable banner for its recorded cwd; its conversation still rendered during capture. This is a failing end-to-end load measurement, not a passing performance result or a controlled attribution of the slowdown to a particular change. No threshold was relaxed. The broader native startup/render performance gate remains open; no new startup p50 was measured.

### Final installed delivery and cleanup

The normal release was rebuilt without the test harness, ad-hoc signed, installed over `/Applications/Brigadier.app` without a backup, and launched successfully. All four installed bundle files match the signed built bundle; `codesign --verify --deep --strict` passed. Executable SHA-256: `ca5cdb0829c9393f35a7380bbfc05f195a421b1e52a11c027c5fba71e61c8ffe`. Native startup and the saved transcript were inspected in this installed build. No new frontend error entries were recorded.

All six native fixture sessions created during this follow-up are archived. Their six clean worktrees and branches were removed after verifying every HEAD already equaled the disposable project's main. The synthetic burn project was moved to recoverable Trash, and the temporary verification app was removed. The earlier implementation worktree was already merged and removed; this follow-up made no new implementation branch. Other sessions' worktrees and the unrelated untracked delivery-efficiency research file were preserved. The installed app is left open on a clean new-chat view in the main Brigadier project.
