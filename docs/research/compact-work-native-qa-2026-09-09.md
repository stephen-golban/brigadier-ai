# Compact work blocks: native verification

Measured 2026-09-09 using the real Tauri/WKWebView app and authenticated Claude Code 2.1.265, with the app's default Haiku model. No browser mock or replay driver was used for these conversations.

## Environment

- Separate bundle: `target/debug/bundle/macos/Brigadier Work QA.app`, identifier `ai.brigadier.workqa.20260909`. Built using the installed Tauri CLI's documented `--debug --bundles app --config` options. The installed Brigadier application and its data directory were not replaced.
- Disposable Git repository: `/tmp/brigadier-work-qa-20260909`. Brigadier created its own isolated worktrees from this repository. The test only changed README.md and ran local commands.
- QA data: `~/Library/Application Support/ai.brigadier.workqa.20260909`. SQLite was inspected read-only to compare recorded lifecycle and workspace checkpoints with the native UI.
- The first-run intro remained blank/disabled during background automation. The isolated QA profile was seeded as an onboarded user before continuing; this check does not validate onboarding. No user's existing preferences were changed.

## Native results

| Check | Evidence |
| --- | --- |
| Live progress | Initial session displayed Working for 21s, separate commentary, Read/Edited actions and a Running command. Approval cards stayed outside the work disclosure. |
| Completed turn | Initial turn `a8f9902e-30f6-43a8-beb3-6ed6d6379aa1` recorded 43,918ms; native UI showed Worked for 43s with final text outside the closed parent. |
| Corrected regression | Session `0c2de93e-e6c6-41bc-b703-fbffb3c15108`, turn `2b4482cd-faf5-4484-ba5e-23af24667b56`, recorded 72,458ms. Native UI showed Worked for 1m 12s, “Native regression passed.” and an Edited 1 file +1/−1 card, without sending another turn. |
| Grouping and detail | Opening the parent restored two commentary-separated groups: Read files, ran a command; Edited files, read files. Expanding the first group exposed Read README.md and Ran git status --short. Expanding Read exposed its full worktree path and original file contents. |
| Real interruption | A Python command printed and waited for 45s. Process inspection confirmed execution before choosing the native Interrupt action. Turn `24f21044-6605-4230-9b94-797059f2beed` recorded interrupted at 44,784ms (including approval wait). UI showed You stopped after 44s, retained progress and the failed/interrupted tool, and removed the live status. |
| Persistence | App restart retained the initial Worked for 43s, the recorded file card, and the earlier interrupted turn's You stopped after 3m 8s. A final packaged-build restart also retained Worked for 1m 12s, its file card, and You stopped after 44s. Reopening restored the previously expanded Read group and file output. Read/Edit labels became short filenames while their full requests remained expandable. |
| Tool failure | An intermediate test's standalone sleep was rejected by the provider. The parent exposed 1 failure; the final response reported that the test had not completed. This run was not counted as successful interruption verification. |

## Failures found and fixed

1. **Occluded native windows could show stale approvals and busy state.** The transcript's 700ms database polling advanced while `feedStore` waited exclusively for animation frames. Opening a native menu resumed delivery. A 250ms timer fallback now drains the same buffer when frames stop, with cancellation preventing duplicate drains. Foreground updates still coalesce by animation frame; fallback ticks do not count as FPS samples. A fake-timer regression suspends animation frames, verifies turn-start/turn-end delivery, and checks teardown cancellation. This matches the already documented hidden-window frame suspension in `src/fps.ts` and `docs/research/feed-rendering.md`.
2. **The edited-file card could remain absent until another user turn.** The completed turn had a durable pre-image but no post-image. The next send successfully finalized it. `observe` had silently discarded a failed capture; any incoming provider frame can invalidate the strict revision barrier. The raw event log excludes ignored frames, so the specific racing frame cannot be proven from this capture. Terminal finalization now makes at most three complete barrier/capture/release attempts on provider rejection and logs exhaustion. It never publishes or reuses an invalidated snapshot. The regression invalidates the first capture, changes the file, and verifies a fresh post-image is saved without another send. The corrected native run displayed its file card immediately after completion.
3. **Read/Edit labels were dominated by long worktree paths.** Activity labels now use filenames; expanded request bodies preserve full paths. Verified in the rebuilt native app.

## Validation and remaining limits

- Full frontend suite: 399 tests passed across 45 files. After excluding fallback ticks from FPS sampling, the 29 feed-store tests passed again.
- Supervisor checkpoint tests: all 7 passed, including the new invalidated-capture regression. Supervisor library Clippy passed with warnings denied.
- Native debug app packaging and production frontend build passed. Existing Vite externalization/large-chunk warnings remain.
- The recorded durations include approval waits and end at harness turn completion. Claude's published stream contract has no explicit final-answer phase; exact first-final-token collapse remains unsupported. See [provider evidence](claude-final-start-2026-09-09.md). No synthetic phase or timestamp was introduced.
- These checks establish the exercised native paths, not universal parity with ChatGPT.

## Subsequent installation and cleanup

At the owner's request, the current production release was subsequently installed at `/Applications/Brigadier.app` and its local ad-hoc signature verified. Native launch loaded the saved brigadier-ai and Tuppi projects with the composer ready. The QA bundles, disposable repositories, test profiles, backups, and generated build directories were deleted without making backups. Real app data and source changes were preserved. See [cleanup record](brigadier-machine-cleanup-2026-09-09.json).
