# Orchestration implementation slice

Owner: orchestration subagent, 2026-09-09. All edits shared directly in integration worktree; no separate commits.

Implemented:
- StartSession, ResumeSession, SpawnSpec optional effort; installed `claude --help` verified low/medium/high/xhigh/max and include-partial-messages. Claude validates unsupported effort / Haiku effort; effort opts into inherited thinking.
- Migration 13 records session effort, permission_mode and thinking. Supervisor spawn persists them; resume and fork restore them and rebuild scoped hooks. Source-compatible defaults via constructors; struct literal callers require effort.
- `RunSpec.effort` pins orchestrator effort; `model` exact, no worker ceiling. `Order` adds optional provider/model/effort; CallRequest provider selects only registered adapter at spawn. Legacy model_tier remains for old plans. Lead prompt names registered providers. Only actual Claude is currently registered; second provider adapter remains to implement.
- `provider_catalog` Tauri module supplies registered adapters, account instance, version, runtime model catalog, effort values, modelCatalogKnown and usage (observed raw Claude windows or null). Root/lifecycle register command. No fixed fabricated model catalog used here.
- Claude partial stream creates stable IDs keyed parent/content-block; ContentDelta projects incrementally; final assistant completes same ID and body. Lifecycle owns chat delta persistence. Added deterministic duplex pipe test.
- Claude rate limit frames preserved in per-instance observed usage registry; rejection emits RuntimeWarning retaining structured JSON/raw. **No durable shared scheduler/recovery implemented yet.** Accepted usage is not presented as warning.
- Run stop shared atomic cancels active supervised calls every <=50ms including parked approvals, stops queued order dispatch, checks before merge. Gate wrapper drops owned verification future; existing verify machinery kills process group on cancellation. Tick turns cancellation into Stopped.
- Minimum plan length now 1; no mandatory two-phase decomposition.
- Explicit Review action invokes two independent read-only critics then pinned evidence judge; next lead sees findings. Consequential paths/5+ files automatically reviewed before merge. Reports saved alongside gate logs and rejection retained in phase evidence. **Rejected review currently blocks; automatic repair and bounded competing-fix rung remain open.** Risk detector uses simple explicit sensitive-path heuristic, not a proven universal classifier. Do not claim full review policy delivered.
- Retired app-owned missing workspace recreated at exact recorded path from retained branch on resume; validates .brigadier/worktrees child and brigadier branch; no force. Lifecycle owns automatic retirement preserving dirty work.

Checks:
- cargo check -p brigadier-supervisor passed; cargo check --manifest-path src-tauri/Cargo.toml passed.
- Core lib 142 passed (two added effort/usage tests added afterward), adapter integration 34 passed / 1 live ignored, core worktree 25 passed, checkpoints 15 passed.
- Store lib 41 passed; schema integration 2 passed after migration expected-version updates; other store integration suites passed until schema halted previous aggregate.
- Entire deterministic supervisor suite passed: lib160, deletion12, loop_spine31, supervisor13; live and measurement tests ignored.
- New review test rejects malformed judgment and keeps contradictory evidence unresolved.

Open important integration work:
1. Real second provider adapter + registry; project provider exclusions + shared root limits for peer hierarchy. Unknown provider must stay rejected.
2. Durable observed usage backoff/recovery and queue waiting. Current capability::usage is in-memory observation only. Never silently replace explicit orchestrator.
3. Automatic evidence-based repair after review rejects; bounded independent competing fixes after ordinary fixer fails (ladder remains rung1→diagnosis).
4. RunSpec effort app start_run currently needs optional effort bridge wiring (lifecycle/root commands ownership).
5. Automatic baseline currently existing worktree.prepare_from exact base_sha per phase; supervisor legacy loop still integrates into original root and ignores local working edits in base snapshot. New interactive task workspace lifecycle is app-owned. Check input-state capture acceptance.
6. Independent review should inspect cancellation spawn race, workspace rehydration ownership/symlink checks, and streaming final ID reconciliation under interleaved same-parent frames.

Files owned: crates/core/src/{driver,claude/{adapter,driver,process,capabilities}}; crates/core/tests/claude_adapter.rs; crates/store/src/schema.rs and writer upsert_session only + tests/schema.rs; crates/supervisor/src/{lib,fork,action,loop_/*}; crates/supervisor/tests/loop_spine.rs; src-tauri/src/provider_catalog.rs.
