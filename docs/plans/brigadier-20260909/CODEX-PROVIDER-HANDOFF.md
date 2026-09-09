# Codex provider integration — 2026-09-09

Implemented in shared worktree; root owns final integration. No separate commit.

Files: `crates/core/src/codex/{mod,adapter,rpc,capabilities}.rs`, `crates/core/tests/codex_adapter.rs`, core lib export/base64 dependency, `src-tauri/src/provider_catalog.rs`, startup registration/allowance configuration in `state.rs`. Also disabled Claude native Agent/Task when Brigadier peers are configured in `core/src/claude/process.rs`.

Contracts:
- Registered kind `codex`, instance `codex:default`; probe requires working app-server protocol, connected authentication and actual model/list discovery. No guessed catalog. Catalog refresh reads real models and rate limits; errors retain the last observation.
- Dedicated app-server stdio child per harness session; no shared Codex app daemon, no global config changes. Native thread identity is stored as resume token. Resume/fork carry exact model, effort, permissions, cwd and peer config; resumed event numbering continues the harness row.
- `thread/start|resume|fork`, `turn/start|interrupt`, streaming item/delta/completion, command/file approval requests, real token/context/activity data, checkpoint reservation and process-group Stop/End are connected. Turn acceptance is acknowledged by RPC response; explicit RPC rejection is NotDispatched, malformed/missing/timeout acknowledgement is DeliveryUnknown. Busy sends never accidentally steer.
- Native command/file tools project as stable ToolCall and matching ToolResult items; peer MCP arguments/results are in existing UI-compatible bodies.
- Native multi-agent features disabled. Brigadier peers use required stdio MCP config with inherited BRIGADIER_EXECUTABLE/TOKEN/ENDPOINT env vars; tokens never appear in argv. Off disables external MCP/apps; Inherit preserves connected config. Typed config/read optional null fields must be removed before JSON→TOML overrides. Literal dotted server names survive.
- Permission mappings: default/manual → untrusted+read-only; accept-edits → on-request+workspace-write; plan → never+read-only; dont-ask → never+workspace-write; bypass-permissions → never+danger-full-access. Claude Auto classifier and unknown modes reject. Per-request scoped hook can deny native escalation; native sandbox enforces the workspace boundary. Codex has no Claude PreToolUse hook for every tool.
- Images use inline data URLs. Text attachments carry lossless text and identity/name. Other binary files are immutable native file mentions. App startup config retains copies under data_dir/provider-attachments/codex/<harness-session>; native resumes can reread them. These are retained conversation sources, not disposable worker workspace files. Original attachment retention remains store-owned. Native history deletion GC is not added.
- Raw observed rate limits and exact usageLimitExceeded/rateLimitExceeded errors feed shared durable allowance registry. Unknown stays unknown; refresh can lift waiting without restarting stopped work.
- Native rewind, hot permission changes, TUI slash execution and unimplemented server-request kinds fail explicitly. Standard command/file approvals are supported. Arbitrary source paths starting with `/` remain prompt text; slash-shaped command tokens reject.
- Codex supplies no dollar billing amount. Existing core TurnCompleted requires f64 cost and adapter emits its historical zero sentinel; UI must not label that as measured $0. Token usage/windows are observed values.

Verification:
- Official docs fetched: https://learn.chatgpt.com/docs/app-server (redirect from developers.openai.com/codex/app-server).
- Installed `codex --help`, `codex app-server --help`, `codex --version`: codex-cli 0.153.4. Generated installed schemas with `codex app-server generate-ts --out /tmp/brigadier-codex-protocol`; implementation uses those field names, not guessed JSON-RPC shapes.
- Deterministic Codex subprocess suite: 8 passed, 2 opt-in live tests normally ignored. Covers exact model/effort, image/text/binary forwarding, display text, stream IDs/final text, resume identity/sequence/permissions, invalid selections, busy/refused send, approval/interrupt, checkpoint reservation, malformed ACK/Stop under event backpressure, retained binary sources after End/resume.
- Unit checks cover cancellation-safe partial RPC reads and external MCP config null/literal-name handling.
- Live Codex smoke passed, including a real image + text attachment input and exact marker completion. Native required MCP smoke passed with real model invocation of a test peer executable, inherited credentials and projected native tool result. This validates the peer transport; full application cross-provider peer hierarchy is root's integration acceptance.
- Claude restriction argv test passed. Actual installed CLI harmless live probe using `--disallowedTools Agent,Task` returned exit0, init toolsCount25, Agent=false, Task=false, Bash=true.
- Tauri cargo check passed after registration/config changes.

Root follow-ups: keep generic provider selection on start/peer/resume; do not map missing Codex worker model to a Claude ModelTier slug. Respect project exclusions/shared allowance in dispatch. Independently review default/sandbox policy and full app peer lifecycle. Suppress unobserved dollar-cost display for Codex.

## Final native command extension

Added `NativeControl::Compact` for Codex, using installed v2 `thread/compact/start {threadId}`. It accepts no arguments. The actor reserves the session as busy, records the native manual compaction event and terminal turn, rejects concurrent sends/checkpoints, and remains stoppable. Composer control checks durable Stop/observed allowance before dispatch. Actual live text+image turn followed by compaction passed with a manual SessionCompacted notification.

Claude initialize exposes prompt-command entries `{name,description,argumentHint}`. These are now retained per harness session (not per account, since project skills differ), displayed as prompt commands, and dispatched through the existing durable queue. Enqueue, edit and drain revalidate the session's advertised command and argument contract; no unadvertised slash invocation falls through to a normal prompt. Nonempty native argumentHint enables arguments; empty hints do not claim argument support. CLI skill descriptions are display data, never app instructions. A temporary real `/brigadier-echo <marker>` command with `$ARGUMENTS` returned exactly BRIGADIER_CLI_ARGS_OK, exit0. The probe explicitly closed stdin; CLI print mode otherwise appends inherited stdin to the prompt.

Verified `NativeControl::Compact` fake process test passed, preserving control/turn distinction and manual event provenance. Targeted Tauri `prompt_commands_require_current_catalog_and_preserve_advertised_arguments` test passed. Core gained deterministic per-session command-catalog/argument-hint tests for root's final combined run. Codex deterministic integration suite now has 9 ordinary tests plus 2 opt-in live tests. Both live tests passed; text/image smoke additionally checks compaction.

Unsupported distinction: Claude native SDK compact control is explicitly rejected; only its actually advertised prompt commands are exposed. Arbitrary Codex TUI slash commands remain unsupported; `/compact` and `/context` are real adapter controls. Root aligned literal path detection and added command-list refresh on resume/provider-session changes plus argument-hint UI.

Ownership released to root after these updates; no ongoing test processes or further planned edits.

## Native MCP approval correction

Recognizes only Codex's marked `mcp_tool_call` form elicitation with an empty object schema and current thread/turn. It uses the existing permission broker and scoped policy; generic forms, URL elicitation and malformed requests remain unsupported. UI tool name is `MCP · <server>`; excerpt contains native message, description and tool arguments. Suggestions are empty, and provider persistence hints never grant session/global permissions. Numeric and string native request identities remain exact.

Installed CLI JSON schemas generated with `codex app-server generate-json-schema --out /tmp/brigadier-codex-json-schema` confirm the response shape: Allow sends `{action:"accept",content:{},_meta:null}`; Deny sends `{action:"decline",content:null,_meta:null}`; Stop sends `{action:"cancel",content:null,_meta:null}`. `serverRequest/resolved` uses native `{threadId,requestId}` and expires the local broker entry. Evidence matches native application raw session `545e2b81-c5e7-4c22-bb12-9394e6564864`, sequences 85/94/100.

Kill/End and teardown now emit one cancelled RequestResolved per pending command, file or MCP approval before SessionExited. Broker entries expire before Stop acknowledgement, and queued/late approval answers cannot reply after cancellation or native resolution. An RPC write failure retains the open registry until teardown, which records cancelled/unconfirmed delivery rather than leaving a durable active prompt.

Focused verification: `/Users/stephen/.cargo/bin/cargo test -p brigadier-core --test codex_adapter` completed successfully: 17 passed, 0 failed, 2 live opt-in tests ignored, 3.90 seconds. New cases cover exact Allow/Deny/Stop schema and identity; unknown/malformed/stale requests; duplicate/native resolution; Kill and End with pending Edit/MCP; interrupt ordering; queued Allow versus Stop; scoped policy denial; and failed approval writes. No packaging build was run for this correction. Code ownership released to root.
