# Preserving agent throughput while removing overhead

2026-09-11. Primary-source research; no new benchmarks or production changes. Recommendations below are engineering inferences, not demonstrated Brigadier speedups. Preserve models, reasoning effort, context access, permissions, and CLI/subagent concurrency.

## Search once, search appropriately

Prefer targeted `rg`/file discovery over repeated whole-tree scans: select likely paths and file types, widen when evidence requires it, and combine independent patterns with `-e` only when scope and matching/output semantics are compatible. Ripgrep supports globs/types and automatically excludes ignored, hidden, and binary files; therefore “no matches” is not proof of absence outside that scope. Preserve an explicit route to hidden/ignored/generated files and show searched scope and truncation. Do not silently translate arbitrary `grep` commands: regex, traversal, encoding, and output semantics differ. [Ripgrep guide](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md)

Proposed optimization: share identical read/search computations against a verified snapshot; keep each agent's reasoning independent. Key by canonical worktree, dirty-file contents, query/options, search scope, ignore/config rules, and tool version. Invalidate on writes, renames, deletes, ignore changes, and uncertain watcher state. Commit SHA alone is insufficient. Prefer immutable blob caching initially; a mutable-tree cache needs correctness tests before deployment.

## Cache Git work without mixing worktrees

Git's filesystem monitor uses native change notifications and lets `git status` avoid rescanning the entire disk. It watches one working directory; network filesystems have documented caveats. Investigate support in the installed Git before enabling anything. [Git fsmonitor](https://git-scm.com/docs/git-fsmonitor--daemon)

Brigadier can publish one revisioned status snapshot to every view of the same worktree. Share immutable repository objects where appropriate, but keep status/index/HEAD state separate: Git worktrees have their own `HEAD` and `index`. Watch shared refs plus each worktree's files and administrative directory; reconcile after lost events. [Git worktrees](https://git-scm.com/docs/git-worktree)

## Reuse validation, retain its meaning

Use the repository's existing incremental compiler/task cache. Nx documents result reuse keyed by source/dependency inputs, configuration, runtime, and command arguments, with output restoration. This demonstrates the mechanism; it is not a recommendation to add Nx everywhere. [Nx caching](https://nx.dev/docs/concepts/how-caching-works)

Proposed Brigadier behavior: let identical deterministic validation requests join one in-flight computation only when their effective inputs and outputs are equivalent. Record command, content state, environment/toolchain, exit code, and artifacts. Never reuse solely by task name or commit, omit required checks, deduplicate side effects, or treat a network-dependent/flaky test as deterministic. Changed inputs require fresh validation. Avoid unsafe sharing of mutable build directories across worktrees.

## Preserve full context with provider caching

Claude Code already manages prompt caching automatically: the provider reuses exactly matching request prefixes while the full context remains in requests. Keep Brigadier's session instructions stable and inspect cache-read/cache-creation telemetry. Do not inject changing timestamps into stable instructions. Resumption can reuse an unexpired unchanged prefix; model/effort/tool changes can invalidate it. This reduces provider input processing, not necessarily local CPU, serialization, or upload volume. It does not guarantee lower total completion latency. [Claude caching](https://code.claude.com/docs/en/prompt-caching)

## Defer overhead without removing capabilities

MCP Tool Search defers tool schemas until needed; it is not evidence that local MCP processes are unstarted. Current docs describe background connections and waits for needed servers. Preserve discoverability and required hooks/tools; evaluate lifecycle reuse only with compatible server/session isolation. [Claude MCP](https://code.claude.com/docs/en/mcp)

Brigadier already uses structured piped stream JSON in `crates/core/src/claude/process.rs`; retain that transport and optimize ingestion/rendering. Do not substitute print mode for its interactive protocol. Official programmatic docs establish structured events, but their `--bare` startup optimization omits instructions, memory, extensions, and subscription authentication, so it fails this task's capability requirement as a default. [Programmatic interface](https://code.claude.com/docs/en/headless)

## Evidence and comparison plan

The [September 3 experiment](spawn-split.md) measured 751 ms median MCP-on/off startup difference across 12 spawns. Removing tools changes capabilities; current startup behavior is version-dependent, so this is historical evidence, not a current promised saving. The [fan-out experiment](fanout-vs-children.md) ran each arm once on small Haiku tasks; it cannot establish general superiority or equal-quality orchestration.

Compare identical workload/model/concurrency with optimizations off/on, separately cold and warm. Measure CPU-seconds per completed task, memory/swap, bytes scanned, duplicate commands, cache hits, first-token and end-to-end time, responsiveness, and successful required validation. Include writes during scans, separate dirty worktrees, ignored-file queries, watcher overflow, and external-state tests. Accept improvements only with equivalent results and no throughput regression.
