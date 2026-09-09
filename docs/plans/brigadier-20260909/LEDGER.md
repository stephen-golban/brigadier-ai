# Implementation ledger

Baseline: `289f63d0cb131ee8cbf62cc7494ed0183295462a`. Approved scope: [HANDOFF.md](HANDOFF.md). All six references copied and inspected. No publishing/deployment requested.

## Contracts and ownership

- **lifecycle agent**: `src-tauri` lifecycle, peers, durable queue/drafts/attachments, cancellation, history paging and recovery. Coordinate store schema with orchestration. Durable task identity remains separate from provider process. Consult-only peers are never owned descendants.
- **orchestration agent**: `crates/core`, `crates/supervisor`; exact orchestrator selection, independent worker routing, effort/permissions, streaming and usage observations, automatic workspaces, cancellation, review/fusion. Store migrations coordinated with lifecycle.
- **composer agent**: Composer and new composer modules/styles/tests, package/lock; installed Lexical validation; commands, mentions, attachments, persistent queue adapter `src/composerApi.ts`.
- **root integrator**: App/Dock integration, ThreadView and bounded history, workspaceApi/peerApi/wire types, context card, existing right-panel Subagents tab, verification and independent review.

Shared queue API (backend authoritative): `composer_state`, `save_composer_draft`, `enqueue_conversation_turn` (stable requestId), `update_queued_turn`, `remove_queued_turn`, `resume_conversation_queue`, `stop_conversation_task`. State includes draft, paused/stopping/stopped and queued entries with queued/sending/sent/failed/unknown status. Manual sends use the same serialized dispatcher. Unknown sends pause for reconciliation; Stop survives restart. Composer agent owns matching TS adapter.

Explicit orchestrator model is exact; workers independently choose connected/enabled provider/model/effort. Auto resolves defaults. Resume preserves permissions. No BB port, 9router, or mandatory plan-approval gate.

## Status

- Handoff/reference preservation: complete.
- Focused audit/contracts: complete.
- Backend lifecycle: integrated and tested.
- Core orchestration: integrated and tested.
- Composer: integrated; automated and browser checks passed; native OS interactions pending unlock.
- Context/panel/history: integrated and tested.
- Independent review and integrated tests: complete. Native whole-flow smoke is blocked by the locked Mac.

## Verification bar

Run focused Rust and frontend behavioral tests, TypeScript/build, UI interaction checks. Exercise Stop/spawn/send races, queue/restart/idempotency/attachments, exact routing and permissions, independent peer isolation, worker direct messages, history paging and bounded rows, safe cleanup and retained results. Record actual checks and limitations here; unavailable live provider paths remain unverified.

## Integration checkpoint — 10:31 UTC

- Root implemented context card, Subagents tab in existing panel, hierarchical owned tree, retained Done navigation and embedded worker composer.
- Root implemented latest/backwards history API adapter + event-driven refresh, 600-item client window and virtual rows above 60 projected rows. Backend removed destructive 2,000-item retention.
- Root catalog-driven new composer selection supports Auto/exact model and effort; workspace controls are optional details with automatic defaults.
- Focused root UI tests: 16 passed (ThreadView, conversationHistory, workerTree). Full frontend run during active edits: 413 passed, 17 failed; failures mostly old textarea/Start-label/queue callback expectations. Assigned composer-related test migration to composer worker; root handles remaining panel/new-session expectations.
- Browser interaction checked real preview navigation and context card. Narrow desktop overlap found and CSS corrected. Preview is simulated, not evidence of provider execution.
- New user scope: images and other files via clipboard/drop/picker, file AND note mentions, huge text paste as text-file attachment; composer worker informed. Parent researching Tiptap vs custom Lexical.
- Explicit remaining major work: actual second connected provider driver; observed allowance scheduling/recovery; competing-fix rung and repair from consequential review findings; independent review; integrated tests and end-to-end smoke.

## Integration checkpoint — 10:45 UTC

- First lifecycle and orchestration implementation agents completed. Durable slice reports: LIFECYCLE.md, ORCHESTRATION-HANDOFF.md, COMPOSER-IMPLEMENTATION.md. Composer completed 41 focused tests; custom rich Lexical selected and stock plain wrapper avoided.
- Full frontend suite: **444 passed** (54 files). Root subsequently added SubagentsPanel navigation test (being finalized). Browser verified starter caret appends correctly, rich editor controls and reference-style context card; fixed unnamed formatting controls.
- Root added task_memory.rs, task_checkpoint MCP/IPC and TaskProgress component. Persists goal + revision-controlled checklist/decisions/results/verification/unresolved separately from provider context. Updated peer orchestration instructions to approved automatic execution/integration/review behavior.
- Root added generic start/peer provider selection, list_providers MCP, settings for worker provider/model exclusions; catalog grounded in registered adapters. Codex worker implementing real driver plus startup registration and live model catalog.
- Root added SessionView effort/permission_mode -> SessionRuntime fields, composer displays persisted execution choices. Initial NewSession uses durable project draft and persistent requestId across uncertain startup/reload. Main/worker approvals remain inline.
- Root peer snapshots now event-driven (30s recovery fallback). Latest history remains event-driven via bounded feed counters; paging holds a bounded client window.
- Observed allowance module implemented by recovery agent; root composer drains retain queued messages while blocked and expose waiting metadata. Explicit stopped state takes precedence. Root initial/peer create checks observed allowance. Recovery agent handles peer delivery and legacy run waiting.
- **Current active ownership:** codex_provider owns core/codex + state startup/provider_catalog; recovery_review owns core allowance + supervisor loop repair/cancellation and peer delivery guard; integration_review independently audits system and may implement workspace baseline in worktree.rs/new module; root owns all integration glue and UI.
- Root Tauri compile passed before Codex work started. Current Rust tests may temporarily fail while Codex module files are being created; do not mistake that for a final blocker. Backend app suite was113/114 with only new MCP tool-count expectation; updated count12 after checkpoint+provider catalog. Need full final rerun.
- Remaining: finish second provider + tests, complete/review workspace baseline, independently review defects and remedy, final full tests/build and native desktop smoke using an isolated app identifier/data directory. Main interactive review policy is prompt-directed; deterministic supervisor review gates apply to legacy automation loop, not every arbitrary chat tool.

## Review/integration checkpoint — 10:49 UTC

- Frontend production build passed (existing large Monaco/runtime chunk warning retained). New SubagentsPanel test passed; worker links in main activity now route into the same side panel instead of replacing parent.
- Independent reviewer is implementing read-only source snapshot -> app-owned worker baseline, using caller cwd for same-project peers. Root added start_peer_session_from/SpawnIn source plumbing and updated tool description.
- Recovery worker implemented bounded review repair/competing-fix legacy gates plus durable stop/allowance. Explicitly distinguish deterministic legacy automation gates from the interactive orchestrator's tool-directed review policy.
- Provider configuration preserves actual permissions, rejects Claude-only auto mode for Codex, and respects worker provider/model exclusions from source/destination project settings.
- Native desktop verification is still pending; use separate Tauri identifier/data directory, never the user's installed app data. Browser preview is simulated only.

## Integration checkpoint — 10:59 UTC

- Independent review fixed dirty parent-workspace inheritance, retired worker Continue, session-switch send-ID capture, cross-project worker file/approval context, pre-dispatch initial-send retry, and native Claude Agent/Task bypass of durable peer ownership/shared caps.
- Real Codex CLI smoke passed signed-in probe, model catalog, thread/turn streaming and native Brigadier MCP environment/tool invocation. Claude live argv probe verified native Agent/Task disabled while ordinary tools remain enabled for Brigadier-managed sessions.
- Rich composer queue regression tests now cover navigation during a pending draft acknowledgement and retired workspace resume. Connected Codex remains selectable when Claude is unavailable.
- Full frontend run: **447 passed**, plus subsequent provider fallback regression passed. Production build passed, with pre-existing large Monaco/runtime bundle warning.
- Broad core/store/supervisor run: **565 passed, 10 ignored, 0 failed**. Ignored provider-live checks were exercised separately where reported; do not infer all ignored tests ran.
- First complete Tauri lib run after initial-send receipt fix: **117 passed** (independent reviewer). Final rerun still required after compact checkpoint and Sources changes.
- Actual native debug binary launched using identifier `ai.brigadier.integration20260909`; isolated app-data creation verified. Native UI inspection is blocked by locked Mac; async unlock request issued. Earlier browser navigation/visual checks use demo fixtures and are not native backend proof.
- Sources now use immutable historical attachment refs, compact saved checkpoint is injected on subsequent/peer dispatch (16 KiB max), and bounded history lifecycle queries are being finished to support browsing beyond 2,000 turns.


## Final automated verification — 11:09 UTC

- `cargo test -p brigadier-core -p brigadier-store -p brigadier-supervisor -p brigadier`: **687 passed, 0 failed, 10 ignored**, 33 suite reports, process exit0. Optional live/load tests remain ignored in this command; separately executed live provider checks are documented in CODEX-PROVIDER-HANDOFF.md.
- `npm test`: **454 passed**, 56 files, exit0. Includes native path-event routing/stale completion (synthetic), rich saved file/note reference remount, huge paste from blank draft, absolute path input, cross-project worker file scope and queue navigation regressions.
- `npm run build`: passed (TypeScript + Vite). Existing large Monaco/runtime chunk warning remains; no performance improvement claim.
- All changed Rust sources formatted; `git diff --check` passed.
- Final browser screenshot confirmed the context card reserves thread width and leaves conversation/composer readable. Browser fixtures are visibly simulated.
- Native isolated app process was closed after verification was blocked by Mac lock; its separate data directory is retained for the remaining checks. No user app data touched. To continue native verification, launch with `/tmp/brigadier-integration-config.json` (identifier `ai.brigadier.integration20260909`) using Tauri dev once the Mac is unlocked.
- Live Codex streaming, native peer MCP, binary references/resume and compaction passed; live Claude advertised command argument expansion and native delegation restriction passed. See provider report for precise methods, versions and unsupported controls.
- Implementation and independent review ownership released. Code remains in this worktree, uncommitted. No publishing/deployment. Updated product flow and remaining bounds: USER-FLOW.md.
- **Only outstanding verification:** real native OS clipboard image/file paste, Finder drop, native file picker, and the complete desktop mixed-provider task/worker/Stop/queue/reload interaction. These are explicitly unverified; automated layer checks are not substituted for this claim.
