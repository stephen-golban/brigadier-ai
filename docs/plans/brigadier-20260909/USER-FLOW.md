# Integrated Brigadier flow

Implementation: 2026-09-09. Scope: HANDOFF.md. No publishing or deployment performed.

1. Add a local project and start a conversation. Choose a connected provider, Auto or an exact model, supported effort and permissions. The orchestrator keeps that selection; worker selections are independent, constrained by connected adapters, project exclusions and shared limits. Workspace details default to an isolated copy of the current branch/input; routine Git mechanics require no setup interview.
2. Enter a goal in the growing rich composer. Markdown formatting, file/note references, clipboard/drop/picker attachments and literal code/path input are supported. Large pastes become exact `.txt` attachments with preview and retry. An attachment-only initial request can be sent. Binary files keep original bytes and provide an accessible file reference; format comprehension depends on available provider tools.
3. Send begins execution. Questions and small jobs can be answered directly; larger work uses the durable checklist/checkpoint and peer tools. The checkpoint records goal, decisions, results, verification and unresolved work independently of the provider process. Subsequent execution receives up to 16 KiB of compact checkpoint context and can read the full checkpoint through its tool.
4. While working, Enter queues a follow-up; the main button becomes Stop. Queue entries retain their request IDs and attachment bytes and can be inspected, edited or removed before delivery. Stop records intent before cancellation, pauses dispatch, and stops owned descendants. Resume/Continue is explicit after Stop. Unconfirmed deliveries remain paused until the user verifies whether they were delivered.
5. Open Context for actual workspace changes/branch, Sources and workers. Subagents opens the existing right panel. Active/Done includes nested workers; opening one keeps the parent visible and provides the worker conversation, inline approvals and direct composer. Direct owner messages notify its orchestrator passively once. Cross-project worker files/attachments resolve in the worker's project/workspace.
6. Workers start from recorded task input snapshots, including covered local edits, with the parent index and HEAD unchanged. Finished idle workers can retire safely; unintegrated or dirty work is retained. Done history remains available, and Continue can reconstruct a removed disposable worktree from its retained branch.
7. The orchestrator integrates contributions, verifies acceptance and delivers results/diff/checks/unresolved issues. Interactive review/fusion uses real peer tools and durable checkpoints under the orchestration policy. The separate supervisor run loop additionally enforces bounded ordinary repair, isolated alternatives, independent reviews, meaningful gates and evidence-based selection. Prompt policy is not presented as a deterministic guarantee of every model decision.

## Controls and bounds

- Both providers support task Stop and observed context queries. Codex exposes native `/compact` without arguments. Claude exposes command/skill entries actually advertised by that initialized session, including argument hints; prompt commands use the durable queue. Unknown commands and unsupported arguments fail visibly. Native terminal UI commands without a programmatic equivalent are not exposed.
- In-flight Steer, Codex native rewind and hot permission-mode changes are unsupported. The UI does not advertise full screenshot parity for Steer.
- History opens latest-first, supports older pages and keeps a 600-item client window with bounded lifecycle metadata and virtual rows. Saved history is not deleted by that client bound. No unlimited-memory or comparative speed claim is made.
- Allowance is based on observed provider windows. Unknown remains unknown; explicit Stop takes precedence over reset. Codex reports tokens/windows, not dollar cost; its existing internal numeric cost sentinel is not a billing estimate.
- Images and opaque files are limited to 5 MiB, UTF-8 text to 1 MiB, and each message to 20 attachments. Original file access does not imply the provider understands every file format.

## Verification boundary

See LEDGER.md and slice reports for commands and counts. Automated checks cover deterministic failure/recovery, references and attachments, provider controls, workspace snapshots, history bounds and UI navigation. Live CLI checks cover Codex streaming/MCP/compaction and Claude advertised command arguments/native delegation restrictions. Browser layout/editor checks use explicitly simulated preview data.

The native debug app launched successfully with isolated identifier `ai.brigadier.integration20260909`. The Mac was locked during the native UI attempt; OS clipboard, Finder drop, native picker and the complete mixed-provider desktop interaction flow remain pending an unlocked Mac. These are not claimed as passed.
