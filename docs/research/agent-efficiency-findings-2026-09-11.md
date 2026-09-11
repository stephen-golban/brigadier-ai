# Coding-agent heat and throughput: findings for Brigadier

Researched 2026-09-11. Owner requirement: retain model choice, reasoning effort, relevant context/tool access, permissions, and CLI/subagent concurrency. Improve useful work per CPU-second and task completion time. This report precedes implementation; no workload benchmark or thermal diagnosis was performed.

Evidence labels: **documented** = upstream documentation/release; **reported** = issue author's observation; **merged** = code change accepted upstream, not independently benchmarked here; **source** = current Brigadier code; **proposed** = engineering recommendation requiring validation. Reports demonstrate particular failures, not their frequency across users.

## What complaints and fixes establish

| Product / evidence | Finding | Implication |
|---|---|---|
| Claude Code, documented release fixes | v2.1.268 fixes an idle CPU spin and terminal-focus CPU problem; v2.1.261 fixes failed background-agent wakeups retrying in a tight loop. | Version-specific bugs can burn CPU without advancing work. |
| Claude Code, documented release fixes | v2.1.267 fixes runaway VS Code ripgrep processes and several prompt-prefix cache invalidations. | Search integration and request construction can be optimized without reducing reasoning. |
| Claude Code, reported, labeled reproduced | #82988 reports 30–40 seconds of local delay in a parent workspace with 83 repositories and millions of files, across multiple models. Traces identify in-process directory walking; switching ripgrep did not help. | Identify the actual scan and workspace boundary before changing tools. |
| Codex, reported | #22053 profiles high desktop-process CPU while its app-server is almost idle. No confirmed fix was established. | Measure frontend/IPC overhead separately from agent execution. |
| Cursor, reported plus support response | Dependency relinking triggers repeated ripgrep workers; support confirms inconsistent ignore handling across retrieval paths. | File events need coalescing and scoped rescans, or polling replacement can still be expensive. |
| OpenCode, merged fix | #6435 guards an empty model-list view that triggered CPU/memory growth. The author's detailed internal-loop explanation is tentative. | Empty and zero-sized UI states deserve performance regression tests. |
| Gemini CLI, merged fix | #16965 addresses orphaned CLI CPU spin after terminal closure with shutdown/lifecycle changes. | Completed or disconnected work must stop consuming resources. |

Sources: Claude [2.1.268](https://github.com/anthropics/claude-code/releases/tag/v2.1.268), [2.1.261](https://github.com/anthropics/claude-code/releases/tag/v2.1.261), [2.1.267](https://github.com/anthropics/claude-code/releases/tag/v2.1.267), [directory-walk report](https://github.com/anthropics/claude-code/issues/82988); [Codex report](https://github.com/openai/codex/issues/22053); [Cursor report and support](https://forum.cursor.com/t/retrieval-extension-spawns-runaway-rg-workers-after-yarn-node-modules-relink/160696); [OpenCode fix](https://github.com/anomalyco/opencode/pull/6435); [Gemini fix](https://github.com/google-gemini/gemini-cli/pull/16965/files). Version/date/status details are in [the other-agent evidence note](agent-resource-complaints-other-2026-09-11.md).

**Measured locally, limited scope:** `claude --version` returned `2.1.268 (Claude Code)`. This identifies the binary resolved by this shell, not versions of already-running sessions or an explicitly configured Brigadier binary. Updating is therefore not a sufficient diagnosis. Check each session's initialization version before attributing older regressions to it.

## Ripgrep is useful, but Claude already has it

**Documented:** Claude's built-in `Grep` uses ripgrep, although the tool name says Grep. Shell `grep` is a separate command. Claude's Grep supports file/type scope and filenames/content/count output modes; it skips gitignored files but can search one explicitly. [Tools reference](https://code.claude.com/docs/en/tools-reference#grep-tool-behavior)

**Proposed:** use a narrow search when the question supplies a boundary, then broaden when needed. For example:

```sh
# Locate candidate files without reading their contents.
rg --files src crates -g '*session*'

# Search two literal identifiers in the known module in one traversal.
rg -n -F -e 'start_session' -e 'resume_session' crates/supervisor/src

# Ask only for matching filenames when that is all the next step needs.
rg -l 'SessionStarted' src crates
```

These examples have different scopes/results, not interchangeable semantics. Preserve access to hidden, ignored, generated, and external files when relevant; indicate incomplete results. Do not replace arbitrary shell `grep` text with `rg` mechanically. Ripgrep documents both its filters and overrides. [Ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)

**Source:** Brigadier's UI search is separately implemented using `ignore::WalkBuilder`, `regex`, and file previews in `src-tauri/src/search.rs`. Its explicit `q.paths` filter is checked inside a full root walk. A concrete first optimization is to visit validated selected paths directly when semantics permit. Benchmark streaming search or ripgrep components before replacing the engine; preserve regex, Unicode columns, multiline behavior, ignores, and replacement checks. This UI improvement does not automatically change Claude's internal Grep implementation.

## Implementation priorities

1. **Event-driven shared state, proposed; direct benefit to app overhead.** Implement the [existing revised polling plan](local-resource-control-2026-09-11.md). One Git/workbench snapshot per worktree, shared by all views. Dirty events schedule one refresh; further events during it schedule at most one follow-up. Cache non-Git and missing-HEAD states until relevant changes instead of retrying forever. Watcher overflow triggers deliberate resynchronization, not a task per dropped event.

2. **Incremental streaming, proposed; direct benefit to app overhead.** The existing `process.rs` already uses piped input/output stream JSON. Preserve that protocol and approvals. Append deltas, batch visible UI updates, virtualize history, and release display-only payloads. Avoid repeatedly copying/serializing the complete transcript as each token arrives. Continue ingesting durable events independently of display work; bounded buffers cannot solve sustained overload by themselves.

3. **Shared factual work, proposed; potential agent speedup.** Several agents may need the same file, status, or search. Share exact read computations, not conclusions or reviews. Keys must include worktree and dirty state, scope, query/options, ignore rules, and tool semantics. A commit hash alone misses uncommitted edits. Begin with immutable blobs and app-owned reads. Offering a shared search tool requires provider integration and evidence agents use it; an MCP server alone cannot transparently replace native tools.

4. **Existing incremental build/test caches, proposed; potential large speedup.** Reuse the project's existing compiler/task cache. Identical deterministic validation requests can join one computation only with equivalent source, dependencies, toolchain, environment, commands, and outputs. Keep every required check and final integration gate. Side-effecting, flaky, network-dependent, or different-worktree commands cannot be assumed interchangeable. Do not share mutable build directories blindly. [Input-aware caching example](https://nx.dev/docs/concepts/how-caching-works)

5. **Stable provider prompt prefixes, documented mechanism; proposed audit.** Claude already manages prompt caching. Preserve stable instructions and tool definitions, put changing task state outside stable prefixes, and inspect cache telemetry. Exact prefix reuse retains context; it does not necessarily reduce local serialization/upload work or model output time. [Claude prompt caching](https://code.claude.com/docs/en/prompt-caching)

6. **Scoped integration lifecycle, proposed.** Profile hooks, status scripts, MCP startup/reconnection and language servers. Reuse only when supported isolation/ownership permits; keep all needed capabilities available. Tool-schema deferral is not proof that MCP processes are unstarted. Prefer an already-available language server for symbol definitions/references where it answers more directly; starting many language servers can itself increase memory. [MCP behavior](https://code.claude.com/docs/en/mcp), [LSP behavior](https://code.claude.com/docs/en/tools-reference#lsp-tool-behavior)

7. **Known-good provider versions and lifecycle tests, proposed.** Test protocol compatibility against versioned CPU fixes. Detect persistent idle activity and orphaned owned tools; expose a diagnosis. Clean up only completed/owned resources. Do not silently restart active agents, weaken permissions, or change their model/effort to conceal a leak.

The [throughput note](agent-throughput-efficiency-2026-09-11.md) expands cache correctness and historical measurements. Existing MCP-off startup measurements changed available tools and are not a capability-preserving speedup claim.

## Acceptance criteria and boundary

Hold model, effort, permissions, tools, task, concurrency, and required validation constant. Compare cold/warm and short/long workloads, including three sessions with five subagents each. Measure app, provider, MCP, and tool descendants separately: CPU-seconds per completed task, elapsed completion, first response, peak/retained memory, swap, bytes scanned, duplicated commands, cache hits, wakeups, IPC volume, and UI responsiveness.

A lower instantaneous CPU percentage alone is not success; slower execution can consume more total resources. Accept changes with equivalent results and validation, lower wasted work, and no meaningful throughput regression. Use repeated runs because network/model latency varies. Test dirty worktrees, file edits during search, ignored-file access, watcher loss, dependency-install storms, long transcripts, and process-owner exit.

No blanket context clearing, smaller models, reduced effort, agent caps, CPU quotas, disabled required tools, or skipped tests are recommended. Real compilation/browser/local-model computation still uses local energy. If that useful work dominates, avoiding its heat requires a faster/more efficient execution environment or optional remote execution; remote execution is outside the current local-only product scope and carries network/environment tradeoffs.
