# Brigadier desktop redesign — implementation and verification

Owner confirmation: 2026-09-06. Implements the decisions in
[the interview record](chatgpt-redesign-discussion-2026-09-06.md).

## Result

- Flat project navigation with display aliases, working spinners and attention dots.
  Projects restore their tab selection; empty projects open searchable session history.
- Notes accordion, file-backed Markdown notes, stable mention IDs, external edit/rename
  refresh, folder selection, and profile/settings footer. Conflicting external edits keep
  the draft and block autosave until the user reloads or saves elsewhere.
- Main tabs for sessions, files, diffs, notes and terminals. Keyboard new/close/reopen,
  cycling, numbered selection, open file, save and Settings commands. Dirty file close
  waits for Save; working-session close confirms, hides immediately and queues disposal.
- Tree, Search and Changes switch one right panel. The independent environment/agents
  card adapts to a popover when there is insufficient room. Workhorses open on selection;
  native subagent details, source-session navigation and saved rewind history remain available.
- Reference dark palette, rounded user bubbles, message times and copy/edit placement,
  long-message folding, peer attribution, concise nested action disclosures and recorded
  per-turn file cards. Conversation/Activity, verbose and FPS controls are removed.
- Pending questions/approvals remain with their selected conversation. Settings supports
  individual and bulk session disposal. Cleanup retries persist across app restarts.
- New isolated sessions inherit current tracked and untracked source files, excluding
  the checkpoint coverage exclusions. Applying a reviewed session delta changes the
  original project without committing or changing its index; conflicts stop the apply.
- Combined conversation/file rewind and file-only turn Undo use recorded raw snapshots,
  per-path conflict checks, workspace leases and durable recovery journals. Archived
  message epochs stay recoverable but do not inflate current conversation change totals.

## Verification

**Measured:** 258 frontend tests pass. Coverage includes flat project navigation,
notes/profile controls, recorded review/Undo, keyboard tab cycling, no automatic workhorse
tabs, finished close/reopen, immediate working close with pending cleanup, dirty Save,
external note conflicts, existing rewind behavior and paint-span selection regressions.
Obsolete accordion/direct-deletion tests were replaced with the confirmed interaction
contract, rather than retained as assertions of the old interface.

**Measured:** the full Rust workspace suite passes 625 tests with seven intentionally
ignored live/measurement tests. An additional store regression verifies that archived
message epochs are excluded from visible change totals. Native note tests were rerun
following the directory-sync change. No paid provider calls were made.

**Measured:** TypeScript and the production Vite build pass; the macOS Tauri bundle builds
at `target/release/bundle/macos/brigadier.app`. Existing bundle-identifier and asset-size
advisories do not prevent building.

**Measured:** browser preview was inspected at the default narrow viewport and at
1728×1085. Verified flat sidebar, empty history, populated thread/action expansion,
file-in-main-tab behavior, Tree/Search/Changes replacement, responsive independent card,
Notes create/rename/delete and Settings. Monaco loaded and exposed its editor. The wide
DOM measured sidebar width 275 px and conversation/composer width 737 px. The provided
screenshots supplied the colors and spacing; pixel equivalence is not asserted.
The reference Codex app could not be inspected through CUA because that access was denied;
Jan was not installed. The browser preview uses explicitly identified simulated activity.

**Measured:** full release-mode checkpoint capture on disposable repositories:

| Files | Raw bytes | First capture | Second capture |
| --- | ---: | ---: | ---: |
| 100 | 33,090 | 1,051 ms | 428 ms |
| 1,000 | 331,890 | 493 ms | 444 ms |

The optimization batches raw blobs through Git fast-import and reuses object IDs during
verification. These are full capture measurements, not the earlier isolated import probe.
They are one local run, not a latency percentile or a large-repository guarantee.

## Boundaries

- Native provider rewind behavior is covered by protocol fixtures, not a fresh paid live
  conversation. Unknown native or send outcomes remain blocked for explicit recovery;
  they are not automatically replayed.
- Unsupported filesystem metadata, changed Git state, incomplete checkpoint coverage or
  conflicting external writes refuse restoration. Counts require recorded boundaries;
  older sessions do not receive fabricated statistics.
- Worktree disposal removes only exclusively owned app worktrees/branches. A shared
  worktree survives while another session references it. Cleanup failures remain retryable.
- The notes folder is the content authority. Changing folders copies current notes while
  preserving existing destination files; it does not delete the previous external folder.
- Previous source work was committed and the notes worktree merged in `7d00570`. The
  checkpoint implementation was integrated selectively after baseline/hash review, without
  copying its older UI. Pre-existing private worktree backups were not touched.
