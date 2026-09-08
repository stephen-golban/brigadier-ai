# Cross-session coordination — 2026-09-08

The requested workflow is implemented across local Brigadier projects. The model discovers ordinary sessions, creates another session for a task, reads progress, sends a follow-up, and waits for completion or attention. The existing assistant-ui conversation renders attribution and expandable activity with session links.

## Use

After launching the rebuilt app, start a new session or resume a stopped session so its MCP helper loads the new tools. For example:

> Create a session in this project to review the current changes. Continue checking the tests here, then wait for the review and summarize its findings.

> Find the session working on the API in my other project, ask it for the response format, and wait for its update.

The tools are `list_projects`, `list_sessions`, `read_session`, `wait_sessions`, `create_session`, `send_message`, `read_inbox`, `stop_session`, and `close_session`. Project and global session settings still govern creation, messages, and child management. New sessions default to isolated workspaces. A destination's settings are checked as well as the caller's.

## Implementation

- **[source]** Extended the app-owned authenticated MCP router in `src-tauri/src/peer_mcp.rs` and `peers.rs`; no new provider dependency.
- **[source]** Added bounded reads and waits in `peer_sessions.rs`, with per-session cursors, event wakeups, a persistence fallback, timeout, cancellation, per-target errors, and circular-wait rejection. Pending queued work prevents premature completion.
- **[source]** Fixed recursive acquisition of `CREATION` when an agent called the public session creation command. The shared implementation now runs under the caller's existing lock.
- **[source]** Delivery checks live adapter status before invoking checkpointed send; busy work stays queued. New delivery records persist the provider turn UUID for attribution. Older records retain the existing exact-text compatibility path.
- **[source]** Reused assistant-ui activity disclosures and message primitives. Added readable tool labels, source/target links, queued/failed delivery visibility, and tests that prevent message IDs being mistaken for session IDs.

## Verification

- **[measured]** `npm test`: 371 tests passed across 40 files. The final inbox-link correction also passed the focused presentation tests.
- **[measured]** `cargo test -p brigadier -p brigadier-store -p brigadier-core --lib`: 280 tests passed (98 desktop, 142 core, 40 store).
- **[measured]** The integration test uses real temporary stores and supervisor sessions with a replay driver: cross-project discovery, saved replies, waits, repeated-output suppression, missing targets, inbox wakeup, queued work, and interruption passed.
- **[measured]** TypeScript/Vite production build and the native `.app` bundle build passed. `git diff --check` passed.
- **[measured]** The packaged executable's `--peer-mcp` entry point completed initialization and advertised all nine tools in a stdio smoke test, without opening a model session.
- **[measured]** Strict Clippy is blocked by existing `items_after_test_module`, `type_complexity`, `too_many_arguments`, `regex_creation_in_loops`, and `field_reassign_with_default` findings in unrelated existing code. The check passes when these existing lint classes are allowed.

## Limits

**[source]** This is local app coordination using the existing Claude provider. Busy sessions receive queued follow-ups, not mid-turn steering. Wait calls accept up to eight targets and a timeout up to 60 seconds. Reads return at most 20 saved items with 4,000-byte text excerpts. Waiting itself makes no model call; responding or creating sessions uses the normal provider.

**[measured]** No live Claude coordination run, installed-app replacement, or restart was performed for this change. The built app is at `target/release/bundle/macos/brigadier.app`; the already installed app was maintained separately by another task.

The [research note](../research/session-coordination-2026-09-08.md) separates documented public Codex primitives from assumptions about its private desktop implementation.
