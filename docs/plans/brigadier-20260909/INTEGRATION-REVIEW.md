# Independent integration acceptance review

Reviewer slice, 2026-09-09. Reviewed current code against HANDOFF and lifecycle/composer/orchestration notes. Root owns final integration and live smoke evidence.

## Confirmed defects addressed in this slice

- Isolated peers used project committed HEAD rather than the caller's current task branch/input. `worktree::prepare_from_source` now validates repository identity, reads a stable checkpoint without taking an ancestor writer lease, applies covered source files into the unstarted worker checkout, and creates an internal baseline commit from raw checkpoint blobs. Source HEAD/index/files remain unchanged; generated/secret exclusions retain existing checkpoint scope. Worker branch and snapshot manifest preserve input provenance. Root supplied supervisor/commands routing from caller workspace.
- Initial Send marked every error uncertain, permanently blocking the same request even after a temporary pre-dispatch failure settled. Commands now create the process/workspace and bind metadata before sending the initial input. An explicit dispatch boundary distinguishes retryable pre-write failure from uncertain attempted delivery; failed receipts can retry the same immutable request after reload. Unknown receipts remain blocked. Compact task memory is injected before that boundary.
- Context Sources lacked direct owner attachment history. Added metadata-only `session_sources` IPC/store query from persistent conversation refs, with session-project scoping. Root owns UI wiring.
- Old history pages lost turn timing/outcomes beyond the latest 2,000 turns. Added optional inclusive start/end range to chat_turns IPC and `chat_turns_in_range`, returning at most 600 overlapping lifecycle spans. Existing callers retain the original API when range omitted. Root owns bounded visible-window hook wiring.

## Findings handed to root/other owners

- Composer queued write captured mutable request.current across session switching; capture the immutable request ID and scope post-await updates.
- Composer blocked Continue for a safely retired worker whose workspace can now be reconstructed; remove obsolete worktreeRemoved restriction.
- Cross-project worker panel scoped selected ThreadView/attachments/approval paths to root project; use selected worker project.
- Claude native Agent/Task bypassed tracked peer hierarchy and shared cap; disable native delegation when Brigadier peers are configured. Codex already disabled its native multi-agent features.

The first two Composer fixes and Claude argv restriction were confirmed present on final read. Root is responsible for final combined regression evidence.

## Executed checks

- `cargo test -p brigadier-supervisor --lib worktree::tests`: 29 passed, including real Git source snapshot tests (parent-only commits, staged/unstaged CRLF bytes, untracked filenames, deletions, unchanged parent index/HEAD, foreign repo rejection).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib composer::tests`: 4 passed, including known failure retry after restart and late validation error remaining uncertain after dispatch.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 117 passed at initial-send checkpoint before subsequent source/history additions.
- `cargo test -p brigadier-store --test conversation_data`: 6 passed, including initial/follow-up/retained queued source refs, source isolation and reload.
- `cargo test -p brigadier-store --test history_pages`: 2 passed, including 2,101 lifecycle spans, old range overlap, running turn, max600 response and reload.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed after all slice changes.
- `git diff --check`: passed before final source/history additions (root reruns integrated check).

No live provider invocation or native UI interaction was performed by this reviewer. Provider paid execution, native clipboard/drop and complete mixed-provider end-to-end flow remain root's smoke-test scope. Interactive review/fusion is directed through the real peer tools and durable checkpoints; deterministic review/fusion execution additionally exists in the separate supervisor run loop. This review does not claim prompt instructions alone enforce all model behavior.
