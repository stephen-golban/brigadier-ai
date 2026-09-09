# Recovery and review slice

Owner: recovery_review, 2026-09-09. Shared worktree, no separate commit.

Implemented behavioral gates in supervisor legacy plan loop:
- Consequential review rejection gets one ordinary repair, full executable command rerun, and independent review rerun.
- Failed ordinary repair gets at most two independently isolated alternatives from the pre-fix committed snapshot. Each requires an answered call, full gate pass, clean branch and independent reviews before eligibility. Exact orchestrator model/effort evidence judge selects one eligible complete branch or rejects both. Winner reruns full gate; failed ordinary and losing alternative are never concatenated into winner.
- Repair reservations persist before dispatch in gates/<phase>/0.repair-budget.json. Restart cannot reset budget or blindly retry an uncertain repair; it blocks for retained-work reconciliation.
- Review reports use unique durable filenames. Alternatives report includes branch/path/baseline, gate log, clean-tree check, review evidence and selection.
- Verified uncommitted data cannot be silently omitted from merge. Project-root local edits refuse phase commit. Cleanup verifies that failed snapshotting left no uncommitted changes before permitting removal.

Cancellation audit/fixes:
- SupervisedCall starts the provider idle and only sends goal after registration and a new Stop check. A deterministic delayed provider-start test verifies Stop prevents initial prompt and kills the registered child.
- JoinSet dispatch now awaits all siblings after one failure, avoiding dropped call futures that skip process cleanup.
- Stop interrupts reconciliation waiting, queued workspace preparation and allowance waiting.
- Legacy RunHandle Stop writes data/runs/<plan>/stopped; prepare_run restores it. clear_run_stop is for explicit user Continue only. App lifecycle already has separate stopped-runs state; integration must keep both in step for legacy Continue.
- Destructive cancellation retains abort while caller holds lifecycle write lock; cooperative await there deadlocks pending read-locked spawn. Registered sessions are killed by destructive caller.
- Plan/reviewer calls use read-only hook scope in worktrees. Parked deadline checking avoids a zero-timeout spin.

Observed allowance:
- New core allowance module exposes configure, record, blocked(provider,instance), blocked_provider(provider). Registry durably stores actual exhaustion/reset observations; no observation remains unknown.
- Claude usage hooks record under claude-code. Codex worker hooks account limits and explicit usageLimitExceeded/rateLimitExceeded; sessionBudgetExceeded does not block the account.
- Known exhausted windows define reset; unrelated non-exhausted windows do not extend it. Missing reset stays unknown. A later denial without reset retains the existing observed future reset. Passing reset permits an unsent probe, never claims fresh usage and never replays uncertain sends.
- Supervisor calls wait before spawn without replacing model/provider. Peer deliver waits before resume/send while releasing lifecycle lock; root added composer queue waiting and initial/create guards. Stopped checks take precedence.

Validation:
- cargo test -p brigadier-supervisor --test loop_spine -- --test-threads=4: 36 passed (real git integration, review repair, competing selection, no failed-diff merge, delayed startup Stop, stopped restart, dirty verification rejection).
- cargo test -p brigadier-supervisor --lib -- --test-threads=4: 160 passed before final budget test.
- cargo test -p brigadier-supervisor --lib loop_::ladder -- --test-threads=4: 7 passed including durable repair budget (total library now 161).
- cargo test -p brigadier-core --lib allowance -- --test-threads=1: 3 passed, including persisted unknown-reset round trip, account separation, reset boundary and structured Codex errors.
- cargo check --manifest-path src-tauri/Cargo.toml: passed with peer wait guard and root composer integration.
- cargo test -p brigadier-supervisor --test deletion -- --test-threads=4: 12 passed.

Material limits:
- Hard review/repair gates apply to supervisor plan loop. Main interactive assistant/peer path currently receives policy in prompt plus task checkpoints; it does not invoke green.rs. Do not claim arbitrary chat tools are mechanically gated by the legacy loop.
- A crash in a repair reservation blocks for reconciliation; this slice deliberately does not automatically replay ambiguous edits.
- Unknown allowance reset needs a new provider observation to release; no fabricated recovery timer. Provider catalog refresh must remain usable while work is waiting.
- Alternatives currently use provider defaults independently (not an orchestrator ceiling), with distinct approaches and full evidence checks; this is not proof of cross-model diversity.
- New live provider/account-specific behavior requires the provider worker's separate adapter checks. No live paid model runs were executed in this slice.

## Final provider/context integration follow-up

- Run now carries default DriverKind into worker dispatch. `worker_for_provider` supplies legacy haiku/sonnet/opus aliases only to claude-code; Codex and future providers receive None to resolve their real provider default. Independently specifying provider without model is supported, never filled with another vendor's tier. Explicit worker model remains unchanged. Codex worker thinking inherits its provider policy rather than Claude tier policy.
- Added two end-to-end fake-model/real-git dispatch tests: Codex root default -> worker model None; Claude root with independently selected Codex -> worker model None. Existing legacy tier tests now explicitly simulate Claude instead of relying on provider-agnostic aliases.
- Added task_memory::with_context. Normal conversation sends and peer deliveries carry actual saved checkpoint reference JSON, bounded to 16KiB encoded bytes, with current goal, active-first checklist, recent decisions/results/verification and unresolved issues. Complete durable checkpoint remains readable via MCP. Slash control text is untouched; display_text stays the original user message. Peer delivery reads checkpoint at actual dispatch after waiting. New child receives bounded parent context. Integration reviewer wraps initial send as well.
- Task-memory tests: 2 passed, including reload/stale-writer, actual send-context contents, slash preservation, and encoded-byte cap under worst-case JSON escaping.
- Final follow-up validation: loop_spine 38 passed; routing unit tests 2 passed; task-memory 2 passed; Tauri cargo check passed.
