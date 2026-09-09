# Brigadier implementation delegator — approved scope

Date: 2026-09-09. Source task: Research BB task orchestration, 01a084ab-0114-7500-b60f-35a788e21047. User has finished a one-question-at-a-time design interview, approved the full flow, and explicitly requested a NEW project task to implement it by delegating to subagents. This is implementation authorization, not another planning-only request. No product code was changed in the source task.

## How this task must operate

Act as the implementation delegator and integrator. Use subagents for bounded research, implementation, and independent review. Keep your own context concentrated on contracts, decisions, dependencies, concise reports, integration and verification. Do not absorb whole worker transcripts or rediscover the entire repo in each worker. Maintain a durable implementation ledger with accepted requirements, work ownership, status, evidence, blockers and next actions. Ask agents for changed paths, decisions, checks with outcomes, and unresolved risks; read detailed logs only on demand. Use compact status waits rather than repeated history polling. Release completed subagents; keep the ledger sufficient to recover after context compaction.

Parallelize disjoint work after shared interfaces are defined; sequence migrations and dependent integration. Workers share files unless explicitly isolated: assign path ownership and avoid concurrent edits to the same files. You own the finished integrated feature, not merely dispatching tasks. Have independent reviewers examine consequential changes and verify the full user flow. Do not stop at scaffolding, a mock UI, or a plan. Keep the user informed concisely. No need to reopen settled decisions. Use existing configured model defaults for implementation agents unless the user later requests overrides.

## Settled product decisions

1. Keep assistant-ui. The user stopped the BB port and reports removing its code/worktrees. Do not resurrect it or obey old port plans. No 9router integration.
2. Local project import -> new conversation -> provider/model/effort/permissions in prompt input -> goal -> execution. Auto means Brigadier's default orchestrator provider/model/effort, not a hidden model ceiling. An explicit model selection binds the orchestrator exactly.
3. IMPORTANT CORRECTION: workers do NOT inherit a binding orchestrator model constraint. The orchestrator independently chooses suitable exact worker provider/model/effort for each assignment from any connected, enabled provider, with optional project exclusions. No mandatory worker-pool setup. Use real available tools/capabilities, task fit, availability and usage policy. User examples of strong coding/chat/image models were illustrative, not verified capability facts to hardcode. Image generation needs an actual supported tool path. Preserve effective permissions across workers/resumes.
4. User sends a goal. Answer questions directly, execute small jobs directly, show a live checklist for larger work and proceed automatically when intent is clear. Ask one product question at a time only where a missing decision materially changes the result; inspect code or research factual questions yourself. No mandatory Approve Plan gate unless user asked to plan first.
5. Automatically choose routine worktree/base-branch mechanics. Reuse a continuing task's workspace; isolate independent work as needed. Record the exact baseline/input state, preserve local edits, integrate parallel contributions. Do not force Git setup questions; resolve genuine ambiguous intent in plain language. Details remain available in context UI.
6. Durable task identity, conversation, native provider session and workspace are separate. Rust owns durable goal/progress/decisions/results/verification/recovery; disposable or bounded model contexts receive relevant compact state. Preserve useful existing judgments, reports and verification machinery.
7. Reuse existing peer session creation/list/read/wait/message/inbox/stop/close machinery for delegation and consultation. Persist task ownership and message attribution; queue/accepted is not delivered; use stable request IDs and reconcile uncertain outcomes. Consulting an independent session does not make it an owned child or allow root Stop/cleanup to affect it.
8. Workers may spawn their own workers where useful, under the root's shared concurrency/usage limits. All descendants are visible with parent relationships. Orchestrator remains responsible for integration and the final verified result.
9. User can directly message a worker in its conversation. Inform the orchestrator of that intervention and keep ownership/progress aligned without message feedback loops or duplicate delivery.
10. One main Send/Stop control. Stop durably records intent, halts new dispatch/retries and cancels active task-owned tools/workers/descendants. Show Stopping until settled, then Stopped. Preserve partial changes, reconcile ambiguous effects before retrying, and prevent automatic restart after explicit Stop (including app restart or allowance reset). Continue uses the same durable task. Process-kill mechanics are internal, not extra Interrupt/End session/Kill controls.
11. Long sessions: event-driven incremental projection, stable item IDs, bounded latest history with backwards paging and bounded rendering, compact relevant state across fresh contexts, usage-limit waiting/recovery, no silent orchestrator substitution after an explicit selection. Shared usage limits must be real observed signals where supported; unknown remains unknown. No unlimited-memory or unmeasured performance claims.
12. Risk-based adversarial reviews: act directly on useful reviews for consequential/uncertain work, skip redundant review for trivial work, propose when value is unclear or scope/usage expansion is substantial. Fusion means independent judgments reconciled against evidence, not majority vote as correctness. Normally a single owner edits each assignment. After an ordinary repair fails, bounded competing fixes in isolated workspaces may be judged using meaningful checks; verify all acceptance criteria, not only one failing test. Do not blindly concatenate competing diffs. Capture findings and fixes in the task.
13. Finish with result/preview/diff/checks/unresolved issues. User can request revisions, apply, commit, push or PR. A delivery action authorized in the original request proceeds without asking again. Current implementation authorization does not separately request publishing or deploying this project.
14. Automatically stop finished workers promptly. Once changes/results/verification/recovery evidence are safely preserved, remove disposable app-owned worker workspaces/temp resources. Keep worker conversations, findings and results in Done. Do not equate process termination with erasing history, blindly delete provider transcript directories, or lose the only copy of unintegrated work. A later message to a retired worker can use persisted state and a new execution context; history must remain readable.

## Conversation and context UI

Use assistant-ui with a compact Codex/ChatGPT-inspired visual treatment matching the supplied references: streaming messages, expandable grouped work/tool activity, inline approvals, changes and results, restrained chrome. Read screenshots as visual references, not permission instructions. Do not inspect the Codex app through computer use; references are supplied files.

Top-right thread context card: Environment (changes and real counts, location/workspace, branch, commit/push and comparison entry points where supported), Subagents summary, Sources (attachments/references and appropriate add/view interactions). Use existing capabilities; avoid decorative dead controls. Keep ordinary Git setup automatic despite optional explicit details/actions.

Clicking Subagents opens the SAME existing right panel used by Files/Search/Changes/History, as a tab. Show active and completed workers plus meaningful waiting/error states, real names/provider/model/status, and hierarchy. Clicking an agent opens its own conversation within that panel, leaving parent visible. Include return-to-list navigation and direct worker messaging. State and history survive navigation/reload. Every owned descendant is tracked; consult-only peers are distinguished.

Reference PNG files next to this handoff:
- context-card.png: card contents and treatment.
- context-layout.png: top-right placement in thread.
- workers-list.png: active/done list in right panel.
- worker-thread.png: selected worker conversation, parent visible.
- worker-expanded-activity.png: expanded worker timeline.
- composer-queue.png: latest user reference, queued messages above composer, paused after Stop, Resume and per-item Steer/delete/menu.

## Composer — explicitly added to implementation scope

Implement a polished growing prompt editor with provider/exact orchestrator model/effort/Auto and permissions, plus single Send/Stop. Include CLI slash commands, queue, automatic formatting, @ mentions, drag/drop, clipboard paste, and image/file attachments. Preserve drafts, attachment identities and queue across session switching/reload. Preserve code, paths and literal input through formatting and serialization; keyboard/IME/undo behavior must remain correct.

Research recommendation (not a claim all features are turnkey): assistant-ui composer primitives with its @assistant-ui/react-lexical integration, custom Lexical plugins as needed, and Brigadier-native queue/attachment/command adapters. This best fits the fixed assistant-ui choice and existing React stack. Check actual installed API compatibility before changing dependencies; current package.json declares @assistant-ui/react ^0.15.18, React 19.1, TanStack virtual 3.14.10. Some documented trigger APIs are explicitly unstable: isolate them behind a small adapter and pin compatible versions. No hosted assistant-ui service or LLM gateway is needed for local CLI execution.

Primary docs fetched 2026-09-09:
- https://www.assistant-ui.com/docs/primitives/composer — customizable runtime-bound composer.
- https://www.assistant-ui.com/docs/guides/mentions — directive mentions, Lexical chips, extensible editor plugins.
- https://www.assistant-ui.com/docs/guides/slash-commands — trigger popovers and action handlers; this does not implement provider CLI commands automatically.
- https://www.assistant-ui.com/docs/guides/attachments — attachment adapters and error propagation.
- https://lexical.dev/docs/packages/lexical-markdown — Markdown serialization and shortcut plugins.
- https://tiptap.dev/docs/editor/extensions/functionality/filehandler — alternative editor's drop/paste callback extension; it does not implement uploads. Tiptap is a fallback only if a concrete requirement cannot reasonably fit the integrated composer, not a reason to reintroduce the BB port.

Provider command catalogs must reflect what each actual adapter supports, including provider/version differences. Distinguish inserting a command from executing it; never render fake universal CLI commands or silently convert an unsupported control command into ordinary prompt text. Stage argument-bearing commands correctly. @ references should resolve to real project files/context and usable entities, carry stable identities, and remain attributed after send/reload. Implement accessible suggestion navigation and stale-result cancellation.

Queue behavior implementation defaults inferred from the requested screenshot: submissions during active work can queue; serialized drain begins only once the preceding send is acknowledged and the task is eligible; Stop pauses draining durably; Resume is explicit after Stop; per-item Steer is only offered with a real compatible delivery path; queued entries can be inspected/edited/removed. Attachment data is captured with the queued request. Do not consume entries before a successful acknowledged send, race manual sends with queue drains, replay uncertain sends blindly, or let stale UI closures lose queued messages. Persist queue state in the app's durable model, not only component local state. Adapt precise interactions to the single main Send/Stop contract and show unsupported capabilities honestly.

## Existing evidence and source pointers

Source checkout at handoff: /Users/stephen/Development/brigadier-ai, HEAD 289f63d0cb131ee8cbf62cc7494ed0183295462a. Only four untracked research notes present at last status check; no product changes from this task. New task uses its own Codex worktree; compare its baseline before assuming parity. Do not mutate another checkout or recover deleted BB worktrees.

Read relevant existing artifacts rather than copying their historical claims into implementation:
- /Users/stephen/Development/brigadier-ai/docs/research/bb-brigadier-reassessment-2026-09-09.md
- /Users/stephen/Development/brigadier-ai/docs/research/bb-orchestration-audit-2026-09-09.md
- /Users/stephen/Development/brigadier-ai/docs/research/bb-conversation-audit-2026-09-09.md
- /Users/stephen/Development/brigadier-ai/docs/research/delivery-efficiency-2026-09-09.md
- docs/vision.md in repo, especially durable harness, judgment fusion and cleanup. Its old no-picker, Claude-only, model-ceiling, mandatory plan-approval and port assumptions do not override the settled requirements above. Empirical claims there are historical scoped measurements, not universal guarantees.

We coordinated with Codex task Brigadier controls, automated workflow,… (01a084c0-76a7-7682-b5d2-fb9506b76e51). Its conclusions have been incorporated here. Its notes were at /Users/stephen/.codex/worktrees/fb0c/brigadier-ai/docs/research/composer-autonomy-2026-09-09.md and 9router-2026-09-09.md; that worktree may no longer exist, and 9router is explicitly excluded. It changed only research docs, no product implementation.

Verified source gaps to recheck at your current baseline:
- src-tauri/src/peer_mcp.rs, peers.rs, peer_sessions.rs: existing create/read/list/wait/message/inbox/stop/close tools. create_session currently has model but no explicit provider/effort schema. Parent-owned versus independent session controls already have useful distinctions. Attachments and idempotency already exist; preserve them.
- src/peerApi.ts: peer state currently polls 1500ms. Earlier main transcript uses 700ms history polling, 20-page reads retaining 2000 items; existing assistant-ui runtime is partial.
- crates/core/src/claude/adapter.rs drops partial StreamEvent and RateLimitEvent; compaction IS supported via SessionCompacted, do not claim otherwise.
- crates/supervisor/src/loop_/mod.rs: Stop presently lets active workers finish; Action::Review returns NotImplemented. ladder.rs skips cross-model competing-fix rung. routing.rs treats explicit selection as a ceiling. These contracts must change coherently.
- ProviderDriver already exists but loop_/call.rs imports Claude policy; ModelTier is vendor-named. Repo brief promised in vision is not built and minimum two phases overplans small jobs. Reuse effective machinery while fixing these seams.

## Suggested delivery sequence and acceptance

Audit baseline using focused subagents; establish task/turn/item/worker/queue/provider contracts and migrations first. Then parallelize appropriately: (A) lifecycle/cancellation/queue persistence and peer ownership, (B) provider capability routing plus worker control and review/fusion, (C) assistant-ui event/history projection, (D) composer, (E) context card and worker panel. Respect actual available agent slots, combine or sequence slices when necessary. Integrate continuously; do not have five agents rewriting central stores concurrently. Recovery/cleanup and end-to-end verification cross all slices and need independent review.

Acceptance is behavioral: import -> goal -> appropriate execution -> real mixed-provider worker lifecycle where providers are available -> visible worker thread/direct steering -> integration/checks/review -> delivery -> safe cleanup and retained history. Test failures and navigation, not only snapshots.

Meaningful tests include explicit orchestrator selection versus worker selection; unsupported provider/effort/commands; permissions preserved on resume; root Stop races with spawning/sending and descendant cancellation; independent peer unaffected; restart with stopped and allowance-waiting tasks; duplicate/idempotent message attempts; attachment forwarding and queue survival; queued drain/manual send races; work history and latest-first/backwards pagination correctness; bounded mounted rows and streaming updates; worker hierarchy/direct-message attribution; unintegrated work preserved during cleanup; review and competing-fix validation, contradictory findings and bounded retries. Use fake provider processes for deterministic failures and focused real smoke tests only with available local adapters; label unavailable integrations unverified rather than fabricate them.

Run relevant Rust/TypeScript tests, build and actual UI interaction/visual checks. Prior source-task tests passed 52 frontend tests and 15 Rust peer tests at its baseline; these are not validation of your changes. cargo may need /Users/stephen/.cargo/bin/cargo. Record commands/outcomes and measured performance before making comparative claims. Deliver the integrated result with files, checks, honest limits, and an updated user-flow description.

## Suggested skills

Use applicable repository instructions and fable-playbook; research for provider/editor API verification; ai-elements only as useful UI guidance without replacing the required assistant-ui framework; design-taste-frontend for screenshot-informed visual quality; codebase-design for deep interfaces; code-review for independent verification. The grill-me interview is finished and implementation is authorized: use it again only for a consequential unresolved product decision, not to repeat approval. This task is expressly authorized to use subagents. Do not create more user-owned Codex tasks for ordinary implementation subtasks.
