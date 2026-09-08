# Message submission investigation — 2026-09-08

## Evidence

- The reported session (`983b914f-35b1-41c9-8fed-58f1cb6927d2`) started at 23:04:46 local time. AppKit began normal termination at 23:04:50.509; ToolSearch was cancelled at 23:04:50.644. The user confirmed they quit after the window went blank. The cancellation was a consequence of shutdown, not an approval refusal that caused a crash.
- In the installed release, a fresh “reply OK” prompt and a follow-up using ToolSearch, list_projects, and list_sessions completed with the UI intact. A later first-message test with native error logging reproduced the blank-window trigger: assistant-ui inserts an optimistic assistant message with empty custom metadata, and ThreadView dereferenced its missing Brigadier row.
- The exact create-and-wait prompt exposed a separate deterministic failure: worktree inheritance captures the project root under a writer lease, which conflicts with a running session beneath `.brigadier/worktrees`. The tool reported a workspace-overlap error.

## Changes

- ThreadView now skips runtime-only optimistic messages; existing loading/working indicators cover the interval before persisted message rows arrive. Tests use the real assistant-ui runtime with both an empty history and a trailing user message.
- An outer React error boundary provides a Reload interface action. Reload reconnects the frontend to the existing native supervisor; it does not quit the app or stop sessions.
- React root error callbacks and global error/rejection handlers submit bounded local records to `frontend-errors.ndjson` in the app data directory. The file is capped by replacing its old diagnostic contents at 256 KiB; there is no backup/remote telemetry. Native failures, WebView hangs/termination, or errors before JavaScript initialization are outside this boundary's coverage. [API research](../research/render-failure-diagnostics-2026-09-08.md).
- Submission controls display Starting/Preparing while the request is pending. This exposes preparation latency; it is not a measured speed improvement.
- Agent-created isolated sessions start from committed HEAD without copying uncommitted project files. User-created sessions retain their explicit branch/inheritance behavior. Shared-checkout requests retain workspace exclusion. The tools describe this distinction.

## Verification

- Regression: a peer worktree starts while a sibling holds a writer lease; both can hold independent leases. The unsafe user inheritance path still refuses the same overlap.
- Frontend regression: a descendant throws during render and the recovery screen remains visible; diagnostic payload sizes are bounded.
- Final isolated-checkout frontend suite: 375 passed, including both real-runtime regression cases. Rust: 670 passed, 8 live-account tests ignored. Strict Clippy, TypeScript, documentation and release build passed.
- Native diagnostic release reproduced the render exception and persisted its exact stack. The create/read/wait flow completed successfully while the recovery screen was displayed; reloading reconnected to the completed child session. The final guard addresses the measured missing-row dereference. It does not claim to prevent unrelated native/WebView failures.

- Final installed release: a fresh Tuppi session returned OK; a follow-up created `Coordination final verification`, waited for its READY response, and displayed that response in the parent. Both stayed live. No frontend error records were added (the one diagnostic-release reproduction remains). Installed binary SHA-256 matches the final app bundle.
- The optional DMG installer script failed in this environment; `tauri build --bundles app` succeeded and its native app bundle is the installed deliverable. This flag is confirmed by the installed CLI help.
