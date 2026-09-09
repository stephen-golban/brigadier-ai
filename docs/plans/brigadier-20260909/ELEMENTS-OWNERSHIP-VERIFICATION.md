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
