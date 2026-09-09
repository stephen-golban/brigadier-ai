# Approved orchestration implementation — 9 September 2026

Working base: cbebd9adbb08f86d7905a803d648ac95d89447d5. Imported the authorized handoff patch after validating its base, SHA-256 and clean checkout. Both handoff documents were copied and byte-verified. No source-worktree edits, commits or app/data backups.

## Implementation

- Shared supervisor routing policy for conversational workers and automatic workflow: Quality/Balanced/Economy, concurrency, durable background-turn allowance, review intensity, exclusions and app/project inheritance.
- Maintained provisional capability profiles with quality/context/image eligibility, supported model-specific effort, a quality floor for automatic fallback, and exact user-pinned selections. Ordinary conversation creation and automatic run root selection bypass worker ranking.
- Priors derive from provider model positioning, not comparative Brigadier benchmarks. Profile source: `crates/supervisor/src/orchestration/profiles.json`. Unknown profiles require explicit pins or configured profiles. Observed acceptance is smoothed with ten neutral observations and expires after 30 days; adapter/resolved model identity scopes evidence. Unknown cost/tokens/latency are not fabricated.
- Durable assignments separate execution from disposition, use revision/generation checks, retain prior contributions and require actual candidate review for configured review gates. Reviewers receive immutable candidate snapshots and criteria without parent checkpoint persuasion; stale candidate trees invalidate review.
- Competing requests have immutable baseline, common criteria/scope, bounded attempt count and exact user approvals outside Full access. Automatic workflow has a corresponding saved approval and UI control.
- Background dispatch reservation includes creation, follow-ups and completion wakes. Shared admission covers concurrency and policy intersection. Full access does not bypass task allowance. UI approval can extend allowance; Stop invalidates pending grants.
- Read-only worker scope uses assistant-ui ReadonlyThreadProvider, with existing AgentStatus and ApprovalCard Elements. The root keeps its composer and owns user decisions and human outcome confirmation. Assignment completion drives Done, distinct from accepted/integrated/rejected state.
- Added root-only redirect/reassign tools for changed requirements and explicit reconciled cross-provider handoffs. Prior workspace/results remain inspectable; provider-native hidden state is not transferred.

## Review and verification ledger

Two independent review axes identified admission divergence, stale assignment transitions, accidental root routing, missing conversational review gates and weak capability eligibility. Follow-up passes found cancelled receipt races, replacement ordering and provider discovery short-circuiting. All actionable correctness findings were addressed. Architectural observations remain normal future refactoring opportunities; no claim that this diff eliminates all debt.

Verified in this worktree:

- Rust workspace: **768 passed, 0 failed, 11 ignored**. The ignored set includes opt-in live account tests.
- Frontend: **468 passed across 59 files**, including the actual assistant-ui read-only runtime and full worker transcript (sending/editing rejected; saved messages still update; standalone viewport avoids an unavailable writable thread-list scope).
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- TypeScript/Vite production build and release macOS bundle: passed. Existing Vite chunk-size and bundle-identifier advisories remain.
- Focused recovery checks: completed-before-ack, stopped/superseded/cancelled/stale acknowledgements, stale failure receipts, changed generation, follow-up concurrency, durable allowance, cancelled grants, immutable review candidate and two-arm repair bounds. Approved repair + restart executes alternatives without repeating the ordinary repair.
- Live Claude adapter response: passed (Claude Code 2.1.266).
- Live Codex native MCP tool call and result projection: passed (Codex CLI 0.153.4).
- Production worker routing executed across **both provider directions** with explicit opposite-provider eligibility constraints. Exact root selections in baseline calls stayed intact.

### Small held-out comparison — negative/mixed evidence retained

The corrected experiment prompt asks the model to discover a boundary defect without providing its answer. A second task reasons about active/completed/rejected/stopped assignments. Fixed expected results and no model-tool use. One trial per task/policy; this is a tiny smoke comparison, not representative coding-performance evidence. The first exploratory run supplied the defect answer and is excluded from the comparison.

| Policy | Strict JSON acceptance | Substantive acceptance | Mean elapsed |
|---|---:|---:|---:|
| Exact root (Claude Haiku) | 1/2 | 2/2 | 13.02 s |
| Provider default (GPT-6 Astra) | 2/2 | 2/2 | 6.14 s |
| Light/strong heuristic (Claude Sonnet) | 1/2 | 2/2 | 13.26 s |
| Provisional adaptive (Claude Opus) | 1/2 | 2/2 | 5.55 s |

Markdown fences caused the strict JSON failures. The opt-in `live_routing` test intentionally retains its failing strict-format assertion; this is **not** counted as a passing live test. All four policies found the defect and returned the correct counts after separately parsing the fences. Raw responses, model identities, both acceptance measures and observed elapsed times are in [routing-live-observations.json](routing-live-observations.json). No usage/cost values were invented. No evidence of general routing superiority was established, and these results were not injected as positive training labels. Routing remains based on labeled provisional profiles plus future verified outcomes.

## Installed delivery

Release bundle built and copied to `/Applications/Brigadier.app`, replacing the old app **without backups**. Existing app data retained. Ad-hoc signature verified with `codesign --verify --deep --strict`. Installed and built executable SHA-256 match:

`ca08473d2252feb1570003c4b78f89d6e1052c67b54f5b4e7bc9f2bb01532589`

The updated app launched successfully with existing projects/history. Native QA found and fixed an unnecessary catalog/checkpoint permission prompt, raw process-retirement status incorrectly presented as assignment failure, and a crash opening the full read-only transcript. The actual-runtime and full-transcript regressions now pass. A stopped worker resume requires exact owner approval and cannot race away a newer Stop. Workspaces awaiting contribution judgment remain available for review and continuation.

An external process replaced the installed bundle during QA; the verified final bundle above was restored and rechecked. Native conversational delegation completed in both directions, as recorded below. No commit or push was requested or performed.


### Native installed-app acceptance

In the disposable `brigadier-native-verification-20260909` project:

- A: Claude Sonnet root (`ea7fbeb6-4447-470c-8515-84845ac2beb9`) delegated to Codex GPT-5.6 Luna low worker (`e46c9340-198b-4094-bd60-7fe9032055b7`); the completed worker returned exactly `NATIVE_A_OK`.
- B: Codex GPT-5.6 Sol root delegated to Claude Code Haiku worker (`26bc750d-1931-4106-8f1d-af5536239ab7`, resolved `claude-haiku-4-5-20251001`); wait/read verified exactly `NATIVE_B_OK`, assignment completed, and the root recorded an integrated contribution with evidence. Retired process status remained separately visible. The optional unrelated-worker read was skipped.
- Opening B's full worker activity succeeded: requested/resolved model, criteria, scope, baseline, completed assignment and result were visible. No worker composer or Edit action appeared; the Codex root composer stayed in place. Done showed one completed worker.
- Codex's app-owned Brigadier MCP server now bypasses redundant generic tool prompts after native identity/schema and scoped-denial checks. Exact configured executable, endpoint and token are required; external servers retain interactive approval. Task ownership and action-specific approval remain enforced by the peer server. Deterministic adapter tests cover configured versus external/unconfigured servers, stale thread/turn and scoped policy denial.

After installing the final hash above and relaunching, the existing Codex root resumed and executed exactly `list_providers` then `read_session` without a user approval prompt. It returned `NATIVE_FINAL_OK`, verified `NATIVE_B_OK`, resolved Claude Haiku identity, completed assignment and integrated disposition. The full worker activity also restored successfully after restart. Signature and executable hash were checked again after native verification.

These are read-only conversational smoke tests, not a full coding-performance benchmark. The provisional-ranking limitation above remains.
