# Claude final-answer start: verified contract

Checked 2026-09-09 against installed Claude Code **2.1.265**, the matching first-party Agent SDK **0.3.265**, current official docs, and Brigadier's adapter. This is protocol research; the native UI exercise is recorded separately.

**The published Claude Code stream contract does not expose Codex's `commentary` / `final_answer` phase.** Partial streaming can supply a real first-text timestamp, but it cannot tell the UI at that moment whether this text precedes another tool call or is the final answer. Therefore exact first-final-token collapse is not established by enabling streaming alone.

## Evidence

- The local `claude --help` advertises `--include-partial-messages` with `--print --output-format=stream-json`. The matching SDK declares `SDKPartialAssistantMessage` as a wrapper around raw API stream events, including message and content-block starts/deltas/stops. Its `SDKAssistantMessage` and partial-message types have no phase field, and `final_answer` occurs zero times in `sdk.d.ts`. Inspected the first-party [0.3.265 package archive](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.265.tgz), `sdk.d.ts` lines 3318 and 4852; package metadata identifies Claude Code 2.1.265. The downloaded declaration file is inspection-only in `/tmp/claude-final-start-sdk.d.ts`.
- The official SDK guide distinguishes partial stream events from completed assistant messages and the final result. Text can precede a tool-use block within the same streamed message. The guide identifies `message_delta` as the stop-reason update. [SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- `stop_reason` is null at `message_start` and supplied later by `message_delta`. `end_turn` means natural response completion; `tool_use` means tools must execute. Neither is a first-token phase marker. [Stop-reason reference](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- The raw stream sequence places text deltas before the terminal message-level update. Observing `end_turn` can classify the completed API response retrospectively; it cannot announce its final status before those text deltas. [Messages streaming reference](https://platform.claude.com/docs/en/build-with-claude/streaming)

## Brigadier today

[`build_argv`](../../crates/core/src/claude/process.rs) does not enable partial messages. [`Adapter::on_message`](../../crates/core/src/claude/adapter.rs) ignores `StreamEvent` (line 579). `emit_item` (line 1666) emits `ItemStarted` immediately followed by `ItemCompleted` after a completed block arrives. Those current synthetic starts must not be presented as first-token timestamps. The assistant wire object preserves additional provider fields, but the adapter does not derive a final phase from them. [Wire types](../../crates/claude-wire/src/message.rs)

## Feasible event contract

1. Enable partial messages and correlate blocks by provider message ID plus content-block index, preserving the parent tool ID. Reconcile completed assistant frames against streamed blocks so content is not duplicated.
2. Record the first nonempty text-delta receive time per block. Stream updates using stable item IDs; record completion separately. A block-start event may contain no visible text and should not freeze the work timer.
3. Keep phase `unknown` unless the provider or an explicit application protocol supplies it. At successful terminal result, select the final response using the proven turn boundary and retain earlier text as progress. Handle superseded/aborted messages and subagent prose before selecting a final block.
4. The recorded first-text timestamp of that selected final response can improve the **completed** work duration retrospectively. This improves timing accuracy but still cannot safely collapse the live work at its first token.
5. Exact live behavior needs a trusted explicit final-start signal before final text, with a turn/item ID, phase, and observed first-visible-text time. A structured application-owned final-response tool could establish this contract, but it changes the agent interaction protocol and needs separate implementation/validation. Guessing from wording, lack of currently pending tools, or a text-block start is insufficient.

The verified conclusion is a capability limit of the inspected contract, not a claim that no future or private Claude protocol could expose such a signal. No production code or installed application was modified during this investigation.
