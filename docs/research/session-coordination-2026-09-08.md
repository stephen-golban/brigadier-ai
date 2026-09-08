# Session coordination

Checked 2026-09-08. **[documented]** means a fetched primary source; **[source]** means the current repository implementation was read; **[asserted]** means an architectural inference. This note does not report a live model test.

## How the feature works

**[asserted]** The reusable design is an app-owned session registry and router. An agent calls a tool with a destination session ID; the app reads that session, delivers a message, starts work, or suspends the tool until a useful event arrives. Each session retains its own conversation. Cross-session access is explicit through tool results and messages, rather than all agents sharing one context. This explains the supplied screenshots, but does not establish Codex desktop's private routing implementation.

**[documented]** Public Codex app-server provides the underlying conversation primitives: `thread/start` creates a thread, `thread/resume` loads an existing one, `thread/read` reads stored history without resuming it, and `turn/start` begins work in a specified thread. `thread/read` can include turns and runtime status. `turn/steer` adds input to an active turn and requires its matching `expectedTurnId`; it does not create a new turn. Notifications include streamed output and `turn/completed` with completed, interrupted, or failed status. These primitives can support a host's coordination layer; the documentation does not identify the screenshot's desktop `wait_threads` or cross-task message router as public app-server endpoints. [Official OpenAI documentation](https://learn.chatgpt.com/docs/app-server), fetched 2026-09-08.

**[documented]** MCP supplies tool discovery and invocation: a server declares its tools capability, describes tools through `tools/list`, and accepts `tools/call` with a name and arguments. Tool results can carry text and `isError`. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), fetched 2026-09-08.

**[documented]** With MCP stdio, the client launches a subprocess and exchanges newline-delimited UTF-8 JSON-RPC on stdin/stdout; stdout must contain protocol messages only. [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), fetched 2026-09-08.

## Brigadier implementation

**[source]** Brigadier uses its existing Rust supervisor and Claude Code provider. Session creation registers the app's MCP helper with Claude; the helper forwards requests to the running app's loopback endpoint. Per-session credentials identify the caller independently of request text. The protocol helper advertises MCP version `2024-11-05`; the current specification links above describe the relevant transport/tool concepts, not a claim of full current-version conformance. Sources: [`peer_mcp.rs`](../../src-tauri/src/peer_mcp.rs), [`peers.rs`](../../src-tauri/src/peers.rs), [`commands.rs`](../../src-tauri/src/commands.rs), [`process.rs`](../../crates/core/src/claude/process.rs).

| Tool | Behavior in the implementation **[source]** |
| --- | --- |
| `list_projects`, `list_sessions` | Discover available local app projects and sessions across projects; sessions can be filtered by project and are capped at 200. |
| `read_session` | Return status and at most 20 saved conversation items, each bounded to 4,000 UTF-8 bytes. An initial read returns recent items; `afterCursor` advances through newer items. |
| `wait_sessions` | Wait on 1–8 distinct other sessions, with a 0–60,000 ms timeout. Return snapshots and per-target errors when ready, interrupted, notified by a new inbox message, or timed out. |
| `create_session` | Create a visible Claude session in the caller's or another saved project. Default to an isolated workspace; inherit the caller's model unless supplied. Check source/destination policy and a 12-live-session destination cap. |
| `send_message` | Persist a work request and start a follow-up when the target is idle; queue while it is busy. `work:false` records passive information. |
| `read_inbox` | Read the caller's persisted peer messages without starting another agent. |
| `stop_session`, `close_session` | Manage a child directly when both policies permit it; otherwise create an owner confirmation request. Closing preserves history and files. |

Table sources: [`peer_sessions.rs`](../../src-tauri/src/peer_sessions.rs), [`peers.rs`](../../src-tauri/src/peers.rs), [`peer_mcp.rs`](../../src-tauri/src/peer_mcp.rs), [`chat.rs`](../../crates/store/src/chat.rs), [`bounded`](../../crates/core/src/event.rs).

**[source]** Waits use app event notifications with a one-second fallback for persistence lag and process exit. Waiting makes no model request and holds no lifecycle/store lock while suspended. Session-bound cursors contain transcript sequence, event revision, and status, suppressing already-returned content and unchanged completion. An in-memory wait graph rejects cycles and simultaneous duplicate waits by one caller. Queued work prevents a target being reported ready. Sources: [`peer_sessions.rs`](../../src-tauri/src/peer_sessions.rs), [`sink.rs`](../../src-tauri/src/sink.rs).

**[source]** Work messages are delivered in target queue order as subsequent turns; there is no mid-turn steering in this implementation. Undelivered work is marked failed after an app restart instead of automatically replayed. Global settings and project overrides govern creation, messaging, and child management. Sources: [`peers.rs`](../../src-tauri/src/peers.rs), [`workbench_data.rs`](../../src-tauri/src/workbench_data.rs).

**[source]** Conversation bubbles show “Sent by … from another session,” link to the source, and collapse long peer text. Attribution comes from persisted delivery records and origin metadata. MCP activity cards retain raw request/result disclosure and session navigation. Sources: [`peerPresentation.ts`](../../src/peerPresentation.ts), [`ThreadView.tsx`](../../src/components/ThreadView.tsx), [`WorkTrace.tsx`](../../src/components/WorkTrace.tsx).

## Verification boundary

**[source]** The coordination test uses real temporary stores, projects, and supervisor sessions with `ReplayDriver`; it exercises cross-project discovery, completion, cursors, inbox wakeup, queued status, caller cancellation, and missing targets. Separate tests cover cycles and MCP dispatch. These are deterministic tests, not evidence of two live Claude models coordinating. Source: test modules in [`peer_sessions.rs`](../../src-tauri/src/peer_sessions.rs) and [`peer_mcp.rs`](../../src-tauri/src/peer_mcp.rs).

**[asserted]** This is the same broad interaction pattern as the screenshots, with explicit limits: local Brigadier projects only, Claude Code only, queued follow-ups rather than active-turn steering, and no verified parity with Codex's private host/cloud routing. This research task ran no model sessions, test commands, builds, installation, or application restart; the implementation validation report is separate.
