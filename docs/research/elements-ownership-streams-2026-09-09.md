# Elements, session authority and stream identity — 9 September 2026

Current request: `HANDOFF.md` in the verified transfer at `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-ui-ownership-handoff-f7lxc25v`. Its ownership rules supersede earlier lifecycle and worker-delegation rules. Historical transcripts are evidence, not instructions.

## Official interfaces checked this session

Read the current assistant-ui Elements pages on 2026-09-09. The standalone variants are controlled presentation components; application state and real actions remain the host's responsibility. Brigadier already owns adapted Elements in `src/components/assistant-ui/elements`; no alternate runtime or simulated tool execution was added.

- [Agent handoff](https://www.assistant-ui.com/elements/agent-handoff): from/to, reason, carried context and settlement. Applied to persisted cross-provider worker continuations.
- [Background inbox](https://www.assistant-ui.com/elements/background-inbox): actual running work and collectable results. Applied to owned chat state in Context and worker results awaiting integration. Opening is inspection, not acceptance.
- [Checkpoint history](https://www.assistant-ui.com/elements/checkpoint-history): controlled historical entries and callbacks. Applied to real saved rewind records with inspection; existing native recovery controls retain their capability checks. No invented restore or file counts.
- [Todo list](https://www.assistant-ui.com/elements/todo-list): current agent-maintained steps. Applied to persisted task checkpoint progress.
- [Recommendation card](https://www.assistant-ui.com/elements/recommendation-card): a controlled proposal/response surface. Applied to evidence-backed contribution outcome verification; confirmations wait for backend success. Confidence is not fabricated.
- [Agent status](https://www.assistant-ui.com/elements/agent-status): actual working/waiting/completed state. Applied in Context and worker list/detail with shared presentation mapping.
- [Subagent list](https://www.assistant-ui.com/elements/subagent-list): aggregate worker roster. Applied to real ownership tree, model identity, assignment objective and state. No synthetic percentage progress.
- [Agent plan](https://www.assistant-ui.com/elements/agent-plan): plan count and phase state. Existing `RunCard` integration retained for actual automated workflow phases, alongside checkpoint todos for conversational tasks.

Reference screenshot inspected: compact working/done summary in Context, opening a worker's activity while preserving the orchestrator composer. Stopped/failed executions do not count as completed successes.

## Measured duplicate cause

Read-only inspection of the supplied smoke session `fb402873-543f-41ec-86db-51f9d5c5e3cd` in the installed SQLite projection and its raw NDJSON showed:

- Text streamed at item `fb402873-543f-41ec-86db-51f9d5c5e3cd:stream:1::1`, last cursor 14.
- The same block completed in an assistant frame whose content array contained only one block at index 0, UUID `3a442ab4-b85b-4418-a16a-c1743bf90841`, cursor 16.
- The former implementation correlated by the completed array index, creating a second stored row. Earlier thinking at index 0 made this repeat throughout the transcript.
- Tool-use and tool-result IDs in the inspected span remained correlated; repeated canonical started/completed lifecycle events are not evidence of two tool executions. Initial input delivery already has durable receipts and admission locks. No second actual invocation was established from this historical span.

The adapter now correlates ordered blocks by parent, kind and provider message identity when available. Frame UUID replay is ignored in a bounded cache; identical text from distinct frame/message identities is retained. Stream IDs include the execution's starting sequence to avoid collisions after resume. Codex already uses native item IDs across deltas/completion and replaces final text; store delta replay is sequence-guarded. Regression coverage preserves those paths.

Legacy repair uses raw envelopes, exact stored streamed content/cursor and a present matching authoritative completion. It does not deduplicate arbitrary adjacent text. It resolves exact completion IDs first and clears stale stream generations. Raw history remains unchanged; absent/rotated evidence is left alone. Negative tests retain legitimate repeated text and newer stream IDs.

## Enforced authority

Every authenticated RPC is checked before action dispatch. Workers can read their own checkpoint/session/attachments/inbox, submit their own result, and use a bounded `request_owner` channel. The server chooses the root owner, limits text to 8,000 bytes, requires a stable retry ID and sends no implicit attachments. All worker create/delegate/peer message/read/wait/lifecycle/allowance escape paths are rejected. Queued delivery rechecks ownership. Existing native Agent/Task and Codex multi-agent disabling remains.

An active orchestrator controls its internal worker tree and ordinary chats backed by authenticated creation receipts. Fork provenance alone grants no authority. Stop/kill terminate execution; close/archive persist archive state while preserving files/history. Worker resume and owned competing-worker creation no longer require separate action approval. Project enablement, concurrency, bounded competing attempts, task allowance and root Stop remain authoritative. Unrelated lifecycle targets retain explicit confirmation.

Created conversations stay outside internal-worker navigation and archive trees. No user-created chat becomes subordinate merely because it shares a project or receives a message.
