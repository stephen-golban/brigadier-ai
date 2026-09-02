# Does brigadier need its own codebase index?

Researched 2026-09-02. Question posed by the owner: every short-lived child re-discovers the
repository from scratch; would a harness-owned index pay for itself?

**Bottom line: do not build a codebase index. Build a ~1,500-token precomputed brief instead.**
The arithmetic is in §3, the counter-case in §8.

Tag key, used on every claim below:
**[measured]** = a command run on this machine on 2026-09-02, command shown ·
**[source]** = read in the actual repository or shipped binary, path/line or commit given ·
**[documented]** = official docs/blog/changelog, URL + fetch date ·
**[asserted]** = reasoning or an unverified secondhand claim, marked as such.

Token counts marked **[measured]** are `len(chars) // 4`, **not** a tokenizer run. That
approximation is good to roughly ±20% for source code and prose; it is not good enough to
decide anything within 20%, and no conclusion here turns on a margin that small.

---

## 1. What comparable tools actually do today

| tool | persistent index? | kind | refresh trigger | trajectory |
|---|---|---|---|---|
| **Claude Code** | **no** | none — glob/grep/read | n/a | never had one; stated policy |
| **Cursor** | yes, local | **n-gram inverted index for regex**, since 2026-07 | file change | **moved OFF embeddings, 2026-07** |
| **Amp** (Sourcegraph) | **no** | ripgrep + an LLM `finder` subagent | n/a | never shipped one client-side |
| **Cody** (Sourcegraph) | server-side search | Sourcegraph Search (zoekt-class) | continuous | **removed embeddings in v5.3, 2024-02** |
| **Zed** | **no** code index | LSP + tree-sitter outline + on-demand BM25 | n/a | **deleted `semantic_index` crate, 2025-09** |
| **Windsurf / Devin Desktop** | yes, local + optional remote | embeddings + AST | on change; remote "every N days" | still embeddings-first |
| **Continue.dev** | yes, local | embeddings + FTS5 trigram + tree-sitter snippets | mtime → sha256 | still embeddings-first |
| **Aider** | yes, local | tree-sitter tags + PageRank, truncated to ~1k tokens | file mtime | stable design since 2023 |
| **t3code** | **no** | hands the SDK a cwd and nothing else | n/a | — |
| **Codex CLI** | **no** | no search tools at all; prompt tells the model to run `rg` | n/a | — |

The direction of travel is one-way: **four of the closest comparables have publicly moved away
from, or never adopted, a semantic index.** Not one has moved toward one. Details and quotes
follow.

### 1.1 Claude Code — no index, by stated policy

This is the provider brigadier actually spawns, so its behaviour is a constraint, not a data point.

- "It operates locally on the developer's machine and **doesn't require a codebase index to be
  built, maintained, or uploaded to a server**."
  [documented: https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start, published 2026-05-14, fetched 2026-09-02]
- "RAG-powered AI coding tools work by embedding the entire codebase and retrieving relevant
  chunks at query time... **Agentic search avoids those failure modes. There's no embedding
  pipeline or centralized index to maintain** as thousands of engineers commit new code." [same URL]
- "CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep
  allow it to navigate its environment and retrieve files just-in-time, **effectively bypassing
  the issues of stale indexing** and complex syntax trees."
  [documented: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents]
- Nothing changed in 2026: the full changelog, 383 versions from 0.2.21 to 2.1.258, has **zero**
  matches for `codebase index|code index|embedding|vector db|semantic`.
  [measured: `grep -in 'codebase index\|code index\|embedding\|vector db\|semantic' ~/.claude/cache/changelog.md`]
- No index artifacts exist on disk: **zero** `.db`/`.sqlite` files anywhere under `~/.claude`;
  `~/.claude/cache` is 596 KB and holds only `changelog.md` and `my-closed-issues.json`.
  [measured: `find ~/.claude -name '*.db' -o -name '*.sqlite*'` → empty; `du -sh ~/.claude/cache`]
- `Grep` "is built on ripgrep and uses ripgrep's regex syntax, not POSIX grep"; the binary is
  statically embedded (no `rg` file in the install dir), opt out with `USE_BUILTIN_RIPGREP=0`.
  [documented: https://code.claude.com/docs/en/tools-reference; source: ~/.claude/cache/changelog.md:5607]
- The **only** official nod to indexing is deferring to yours: "if your organization already runs
  a code search or RAG index over the repository, expose it as an MCP tool."
  [documented: https://code.claude.com/docs/en/large-codebases]

  That sentence is the single strongest argument that an index, if we ever build one, belongs
  behind an MCP tool the child *calls*, not in the prompt the child *receives*. Held for §3.4.

**Startup context.** Auto-loaded before the first user token: system prompt ~4,200, auto-memory
680, environment info 280, MCP tool names 120, skill descriptions 450, user CLAUDE.md 320,
project CLAUDE.md 1,800 — **≈7,850 tokens**.
[documented: https://code.claude.com/docs/en/context-window — flagged on that page as an
illustrative simulation with a sample project, **not a measurement**; not reproduced here with
`/context`.] Notably: **no file tree or directory listing is auto-loaded.** Git branch, status and
recent commits do load, as a separate block at the end of the system prompt. [same URL]

**Per-cwd keying — directly relevant to worktrees.** Transcript dirs are the absolute cwd with
`/`→`-`; the worktree `/Users/stephen/Development/brigadier-ai/.brigadier/worktrees/73fb34e3`
has its own separate dir under `~/.claude/projects/`.
[measured: `ls -d ~/.claude/projects/*brigadier-ai*`] `~/.claude.json` → `projects` is keyed by
absolute cwd (169 entries) holding `hasTrustDialogAccepted`, `allowedTools`, `mcpServers` — **a
fresh spawn in a new worktree inherits none of it** and will re-prompt for trust and lose any
allowlist. [measured: python read of `~/.claude.json` keys] One exception: auto-memory is keyed by
*git repo*, so "all worktrees and subdirectories within the same repo share one auto memory
directory" [documented: https://code.claude.com/docs/en/memory] — consistent with the local
layout (the worktree dir has no `memory/`), though the write path was not exercised.

### 1.2 Cursor — turned semantic indexing OFF in July 2026

The most important single finding in this brief, because Cursor is the tool that invested most
heavily in embeddings and published the most about them.

- Cursor staff, 2026-07-21: "Over the last months, models have gotten really good at using grep /
  indexed search, so **the older dedicated semantic search path was rapidly no longer helping in a
  meaningful way**." Same thread: "Cursor no longer needs to build a semantic index of your
  codebase which means we're no longer computing embeddings of your code or storing them on our
  servers for search."
  [documented: https://forum.cursor.com/t/what-do-you-think-about-cursor-removing-the-codebase-indexing-settings/165899, fetched 2026-09-02]
- Staff, asked directly, 2026-07-22: "**Yes. Semantic/embeddings indexing is being turned down in
  favor of grep-based retrieval.**" [same URL]
- Staff, 2026-07-16: "The Indexing & Docs tab was intentionally removed in newer versions" and
  "Agent retrieval works via agentic search plus grep/file search and doesn't rely on a semantic
  index." Gated behind a flag literally named `disable_codebase_indexing`.
  [documented: https://forum.cursor.com/t/codebase-indexing-settings-tab-hidden-by-disable-codebase-indexing-feature-gate-please-re-enable/165859]
- Doc-revision corroboration: `docs.cursor.com/context/codebase-indexing` now redirects, and
  `cursor.com/docs/llms.txt` lists **no** page for indexing, embeddings or semantic search anywhere
  in the tree. [documented: https://cursor.com/docs/llms.txt, fetched 2026-09-02]
- What replaced it is *still an index*, but a lexical one: a **sparse n-gram inverted index** that
  accelerates regex, built and queried on the user's own machine — "we're building and querying the
  indexes in the users' machines", a postings file plus a sorted n-gram table that is `mmap`'d and
  binary-searched. [documented: https://cursor.com/blog/fast-regex-search]
- The motivating number was **latency, not tokens**: "`rg` invocations that take more than 15
  seconds" in large monorepos. [same URL]

**Caveat, stated plainly:** the turndown appears in **no changelog entry and no doc page**. The
only official record is staff forum posts. Cursor also never answered whether existing server-side
embeddings were deleted. [asserted — the gap was checked and is real]

The still-published pro-embeddings blog is now describing a turned-down system, and its numbers
are worth keeping because they are the strongest case anyone ever published: "12.5% higher accuracy
in answering questions (6.5%–23.5% depending on the model)", code retention +0.3% overall and
+2.6% on codebases of 1,000+ files, 2.2% more dissatisfied follow-ups without semantic search.
[documented: https://cursor.com/blog/semsearch] **A +0.3% retention lift is what Cursor decided
was not worth the pipeline.**

### 1.3 Sourcegraph — Cody removed embeddings; Amp never had them

Cody's own docs state the reasons verbatim [source: github.com/sourcegraph/docs
`docs/cody/faq.mdx:73-93`]:

> "**More secure**: No code being sent to a third-party embedding API · **Easier to manage**: Less
> tech debt for embeddings setup and need for refreshes · **More repos**: Sourcegraph Search scales
> to larger repos... · **Equal, or better, quality**"

and, in the announcement: "The process of creating embeddings and keeping them up-to-date
introduces complexity that Sourcegraph admins have to manage. As the size of a codebase increases,
so does the respective vector database... This complexity was limiting our ability to build our new
multi-repository context feature."
[documented: https://sourcegraph.com/blog/how-cody-understands-your-codebase, 2024-02-15, fetched
2026-09-02 — note this URL 403s to a plain fetcher and needs a browser UA]

**Read the reasoning honestly: Sourcegraph did not claim embeddings retrieved worse.** The grounds
are security, operational burden and scale; on quality they claim only "Equal, or better", with no
benchmark. [documented, same URL] Anyone citing this as "embeddings lose on quality" is
overreading it.

**Amp** was verified against the shipped binary rather than the docs, because `amp tools list` is
auth-gated. `npm pack @ampcode/cli-darwin-arm64@latest` → `package/amp`, 71,371,874 bytes, version
`0.0.1788350437-g1fc7b5`. Substring counts over the whole binary: `codebase_search` **0**,
`embedding` **0**, `lancedb` **0**, `sqlite-vec` **0**, `SCIP` **0**; `ripgrep` **58**. The tool
array contains `Grep`, `glob`, `Read`, `finder`, `oracle`, `librarian` and no semantic search tool.
[source: `@ampcode/cli-darwin-arm64@0.0.1788350437-g1fc7b5`, `package/amp`, symbol `_u`]

Amp's answer to search cost is **a cheaper model, not an index**: "Amp's search subagent is now 50%
faster. We switched the model powering the `finder` subagent to Haiku 4.5... approximately 50%
speedup with no noticeable loss in quality... around 3X cheaper."
[documented: https://ampcode.com/news/faster-search-agent, 2025-10-21]

Unverified: `librarian` searches public and private GitHub code server-side; whatever backs it is
not in the client and could not be inspected. [asserted]

### 1.4 Zed — deleted the semantic index crate

- The `semantic_index` crate is **gone**: `crates/` lists 245 entries with no `semantic_index`, no
  `embedding`, no index crate; a repo-wide code search for `semantic_index` returns `total_count: 0`.
  [source: `gh api repos/zed-industries/zed/contents/crates`, 2026-09-02]
- Removal commit `4f1634f95cd2722ad7aa3abce5f67d35351d5b54`, 2025-09-08, deleted 18 files including
  `embedding_index.rs`, `project_index.rs`, `worktree_index.rs`, `summary_index.rs`, `chunking.rs`
  and the ollama/open_ai/lmstudio backends. PR title: "**Remove unused `semantic_index` crate**",
  body: "Release Notes: - N/A". [source: https://github.com/zed-industries/zed/pull/37780]
- It had already been switched off for users a year earlier: "This PR disables the embeddings index
  for non-staff users." [source: https://github.com/zed-industries/zed/pull/19618, merged 2024-10-23]
- One orphan remains — `pub fn embeddings_dir()` at `crates/paths/src/paths.rs:427`, with zero
  callers.

The load-bearing word in the removal PR is **"unused"**. It was not ripped out in a controversy;
by 2025-09 nothing called it. Zed's agent tools today are `grep_tool.rs`, `find_path_tool.rs`,
`go_to_definition_tool.rs`, `find_references_tool.rs` — LSP or ripgrep, none semantic. [source:
`gh api repos/zed-industries/zed/contents/crates/agent/src/tools`] The one ranked-retrieval
mechanism in-tree is **lexical BM25 computed on demand, from no stored index**: 40-line chunks with
10-line overlap, `K1 = 1.2`, `B = 0.75`, 12 chunks max, ≤3 per file.
[source: crates/edit_prediction_context/src/bm25_context.rs:17-26]

### 1.5 Aider's repo map — the one design worth stealing from

Aider is the closest prior art to "hand the model a precomputed map", so its mechanism matters more
than its verdict. All line numbers from `aider/repomap.py` @ `Aider-AI/aider` main, fetched
2026-09-02.

- **What it is:** tree-sitter tags. `Tag = namedtuple("Tag", "rel_fname fname line name kind")`
  [source: repomap.py:29]; `kind` is `"def"` or `"ref"` from the capture name, everything else
  dropped [repomap.py:319-324]. Queries are 31 shipped `*-tags.scm` files
  [source: `gh api .../contents/aider/queries/tree-sitter-language-pack`]. Where a language's query
  yields defs but no refs (C++), refs are **backfilled with a Pygments lexer** — every `Token.Name`,
  `line=-1` [repomap.py:338-363]. That fallback is a tell: getting references right per language is
  the expensive part.
- **The ranking is the product, not the tags.** `nx.MultiDiGraph`, **nodes are files, not
  identifiers** [repomap.py:470]. One edge per (referencing file → defining file, identifier),
  weight `mul * sqrt(num_refs)`, with `×10` if the identifier was mentioned in the current message,
  `×10` for long snake/camel names, `×0.1` for leading underscore, `×0.1` if defined in >5 files,
  `×50` if the referencer is already in the chat [repomap.py:489-514]. PageRank is
  **personalized** toward files in the chat and files named in the message
  [repomap.py:422-445, 519-525], then rank is pushed back down to (file, identifier) pairs
  [repomap.py:534-550].
- **The budget is tiny.** Default `map_tokens=1024` [repomap.py:49]; when unset the CLI computes
  `clamp(max_input_tokens/8, 1024, 4096)` [models.py:782-789]. A binary search over the *number of
  ranked tags* — first probe `middle = min(max_map_tokens // 25, num_tags)`, a ~25-tokens-per-tag
  prior — fits the render to the budget, stopping at `pct_err < 0.15` [repomap.py:666-706].
- **Caching:** a `diskcache`/SQLite cache at `<repo_root>/.aider.tags.cache.v{3|4}`, keyed on the
  **absolute filename**, value `{"mtime": ..., "data": [Tag,...]}`, hit requires
  `val["mtime"] == file_mtime` [repomap.py:35-43, 233-264]. Any SQLite error `rmtree`s the whole
  cache dir and rebuilds, falling back to an in-memory dict [repomap.py:177-215]. Note what is
  *not* cached: `get_ranked_tags` **rebuilds the whole graph and re-runs PageRank on every uncached
  call** [repomap.py:365-574].
- **What it claims:** "The LLM can see classes, methods and function signatures from everywhere in
  the repo. This alone may give it enough context to solve many tasks."
  [documented: https://aider.chat/docs/repomap.html, fetched 2026-09-02] — and, in the same docs
  set, the honest caveat: "aider may launch with the repo map disabled by default... **weaker
  models get easily overwhelmed and confused by the content of the repo map**."
  [documented: https://aider.chat/docs/faq.html]
- No published cold-build timing. The in-source signals are a warning string when
  `len(fnames) - cache_size > 100` — "Initial repo scan can be slow in larger repos, but only
  happens once" [repomap.py:391-395] — and a `RecursionError` bailout that disables the map with
  "Disabling repo map, git repo too large?" [repomap.py:143-146]. [asserted: not benchmarked here]

**Three lessons, in order of importance to us:**

1. The map is capped at **1,024–4,096 tokens**. A full symbol dump is not the artifact; a
   *ranked, truncated* one is (see the measured 34,324-token full map in §2.3).
2. The ranking is **query-dependent** — personalized PageRank seeded from the files and identifiers
   in the current message. A precomputed, query-independent map is the weak half of Aider's design.
3. mtime keying **breaks in our shape**. Measured in §4.2.

### 1.6 Continue.dev — the full-fat local index, and what it costs to run one

Worth reading precisely, because it is the reference implementation of the thing we are declining.
Four indexers, from `getIndexesToBuild` [source: core/indexing/CodebaseIndexer.ts:176-195]:

| artifactId | class | storage |
|---|---|---|
| `chunks` | `ChunkCodebaseIndex` | SQLite `chunks`, `chunk_tags` [chunk/ChunkCodebaseIndex.ts:157,167] |
| `codeSnippets` | `CodeSnippetsCodebaseIndex` | SQLite `code_snippets`, `code_snippets_tags` [CodeSnippetsIndex.ts:44,55] |
| `sqliteFts` | `FullTextSearchCodebaseIndex` | FTS5 virtual table, `tokenize = 'trigram'` [FullTextSearchCodebaseIndex.ts:31,37] |
| embeddings | `LanceDbIndex` | LanceDB + SQLite `lance_db_cache` [LanceDbIndex.ts:89] |

Plus bookkeeping: `tag_catalog`, `global_cache`, `indexing_lock` [refreshIndex.ts:28,40,50]. That
is **seven tables, one vector store and a lock** to maintain — which is the real cost, and it is
paid in engineering, not CPU.

- Incremental update is **mtime-gated, content-keyed**: `cacheKey = sha256(fileContents)`
  [refreshIndex.ts:371-372]; pass 1 compares mtime to `tag_catalog.lastUpdated`, reads and hashes
  only if mtime is newer, recomputes only if the hash differs [refreshIndex.ts:200-215]. The
  README's rationale: "checking timestamps is significantly faster than actually reading a file.
  Git does the same thing." [source: core/indexing/README.md]
- Branch switching is handled by **content-addressed tags**:
  `IndexTag = {directory, branch, artifactId}`, each pass yielding
  `compute | del | addTag | removeTag` [source: core/indexing/types.ts:24-35]. A file whose
  `cacheKey` already exists under another branch gets only an `addTag`. LanceDB isolates branches
  with **one table per tag** [LanceDbIndex.ts:83].
- And the honest failure, in Continue's own "Known problems":
  "`FullTextSearchCodebaseIndex` **doesn't differentiate between tags (branch, repo), so results may
  come from any branch/repo**." [source: core/indexing/README.md] — a shipped, documented, wrong-branch
  bug in exactly the sub-index that is cheapest to build. §4 is about this.
- Two gates worth knowing: with **no embeddings model configured, Continue builds no index at all**
  — not even FTS or snippets [CodebaseIndexer.ts:152-155]; and which indexes build is driven by
  which context providers are enabled [CodebaseIndexer.ts:169-174].

### 1.7 Windsurf / Devin Desktop — the counter-example, still embeddings-first

Every `docs.windsurf.com/context-awareness/*` URL now 307s to `docs.devin.ai/desktop/...` after the
Cognition rebrand. [documented: redirect headers, fetched 2026-09-02]

- "The entire local codebase is then indexed (including files that are not open), and relevant code
  snippets are sourced by Devin Desktop's retrieval engine."
  [documented: https://docs.devin.ai/desktop/context-awareness/overview, fetched 2026-09-02]
- Local index cost, the only published figure of its kind found anywhere: "**Windsurf Indexing also
  requires RAM (~300MB for a 5000-file workspace)**" and "this should take **5-10 minutes**, and
  only needs to happen once per workspace". Recommended ceiling: "For users with ~10GB of RAM, we
  recommend setting this no higher than **10,000 files**."
  [documented: https://docs.windsurf.com/llms-full.txt, fetched 2026-09-02 — may be stale relative
  to the rebrand]
- Remote (Teams/Enterprise): the repo is cloned server-side, embeddings computed, "we delete all
  the code and code snippets"; re-index cadence is configurable "**after some number of days**".
  [documented: https://docs.devin.ai/desktop/context-awareness/remote-indexing]

**5–10 minutes to build, days between refreshes.** Against a brigadier spawn budget of 1,981 ms
that is three orders of magnitude out, and the staleness window is longer than most of our work
orders will live.

### 1.8 t3code and Codex CLI — neither builds anything

- **t3code**: zero hits for `embedding|lancedb|pgvector|faiss|hnsw|tree-sitter|ctags` across
  `apps/*` and `packages/*`. Its SQLite is event-sourcing state (`orchestration_events`,
  `projection_threads`, `checkpoint_diff_blobs`) — no files, symbols or chunks table. The one file
  named `WorkspaceSearchIndex.ts` is a transient fuzzy **file-picker for the human UI** (25k entry
  cap, 15-min idle TTL, exposed only as WS `projectsSearchEntries`) and is never passed to the
  agent [source: apps/server/src/workspace/WorkspaceSearchIndex.ts:11,27-32]. It hands the SDK a
  cwd and nothing else [source: apps/server/src/provider/Layers/ClaudeAdapter.ts, the
  `queryOptions` literal at ~4352-4392 — two independent reads gave 4352-4385 and 4353-4392, so
  treat the exact span as approximate]; stock preset prompt, no file map. Incidentally this is also
  a live confirmation of `CLAUDE.md` §1: `canUseTool` is passed here in production.
- **Codex CLI** (HEAD `8d32abc`) goes further: **it ships no search tools at all.** No Grep, no
  Glob, no Read, no LS. The full handler list is `apply_patch`, `shell`, `unified_exec`, `plan`,
  `view_image`, `current_time`, `sleep`, `mcp`, `mcp_resource`, `tool_search`, `multi_agents`,
  `new_context_window`, `get_context_remaining`, `request_permissions`, `request_user_input`,
  `request_plugin_install`, `list_available_plugins_to_install`, `extension_tools`,
  `wait_for_environment` [measured: `GET api.github.com/repos/openai/codex/contents/codex-rs/core/src/tools/handlers`]
  — a generic shell, plus a prompt line telling the model to search for itself: "When searching for text or files, prefer using `rg` or `rg --files`
  respectively because `rg` is much faster than alternatives like `grep`."
  [source: codex-rs/core/gpt-5.2-codex_prompt.md:5]
- Codex's auto-loaded context is a hard cap worth copying:
  `pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;`
  [source: codex-rs/config/src/config_toml.rs:73] — a **shared** budget across all `AGENTS.md`
  files, decremented per file, and the file that crosses it is **truncated, not dropped** —
  `data.truncate(remaining as usize)` with the log line "project doc exceeds remaining budget;
  truncating" [source: codex-rs/core/src/agents_md.rs:153,160]. ≈8k tokens worst case (at ~4
  bytes/token; not a tokenizer run).

t3code is the closest architectural analogue to brigadier — a harness spawning Claude Code sessions
across projects — and it precomputes **nothing**. That is a data point, not a proof: it may simply
not have got there yet.

---

## 2. Measured: what this actually costs, on this machine

Test corpus: `/Users/stephen/Development/freelogo`, **3,089 tracked files, 66,234,313 bytes**
[measured: `git ls-files | wc -l`; `git ls-files -z | xargs -0 wc -c | tail -1`]. Secondary:
`~/.cargo/registry/src/index.crates.io-*`, **26,480 files, 820 MB** [measured: `rg --files | wc -l`,
`du -sh`]. Machine: darwin 25.5.0, ripgrep 15.2.0.

### 2.1 Search is already fast enough that an index buys no latency

All warm-cache, best of 3–5 runs, `/usr/bin/time -p`:

| operation | 3,089 files / 66 MB | 26,480 files / 820 MB |
|---|---|---|
| `rg --files` | **10 ms** | **50–160 ms** |
| `rg` full content scan, one pattern | **50 ms** | **470 ms** |
| `rg` definition-shaped, 2 patterns | 53 ms | 440 ms |

[measured: `for i in 1 2 3 4 5; do /usr/bin/time -p rg ... ; done 2>&1 | grep real`]

Cursor's stated motivation for building its n-gram index was "`rg` invocations that take more than
15 seconds" [documented: cursor.com/blog/fast-regex-search]. **We are 30–1,500× under that
threshold** on the largest tree available here. The latency argument for an index does not apply at
our repo sizes and would only begin to apply somewhere north of ~500k files.

Cold-cache numbers were **not** measured (no `purge` run); first-touch on a fresh worktree will be
slower than these figures. [asserted]

### 2.2 The precomputed brief costs nothing to build

| brief primitive | 3,089-file repo | 214-file repo |
|---|---|---|
| `git ls-tree -r HEAD` | 15 ms | 17 ms |
| `git ls-files` | 10 ms | — |
| `git diff --name-only A...B` | 15 ms | — |
| `git merge-base A B` | 10 ms | — |
| `git log --oneline -20` | 13 ms | 9 ms |
| `git status --porcelain` | 31 ms | 10 ms |
| 2-level dir tree with counts (`ls-files \| awk \| sort \| uniq -c`) | 16 ms | — |

[measured: `s=$(date +%s%N); eval "$cmd" >/dev/null; n=$(date +%s%N); echo $(( (n-s)/1000000 ))ms`]

**Whole brief assembles in under 100 ms**, against a measured 1,981 ms spawn-to-first-frame. It is
~5% of a cost we are already paying, and it needs no storage, no schema and no invalidation.

`git worktree add --detach` on the 3,089-file repo: **530 ms**, producing a 70 MB checkout
[measured: `/usr/bin/time -p git worktree add --detach "$W" HEAD`]. Worth knowing because it sets
the floor under any per-worktree index work: anything that must run per worktree competes with a
530 ms operation inside a 1,981 ms budget.

### 2.3 The artifact is the problem, not the build

Token figures are `chars // 4` [measured: `python3 -c "import sys;d=sys.stdin.read();print(len(d)//4)"`].

| candidate brief item | 3,089-file repo | brigadier (214 files) |
|---|---|---|
| flat file list (`git ls-files`) | **37,224 tok** | 1,953 tok |
| flat list minus json/lock/media | 35,939 tok | — |
| **2-level dir tree with counts** | **785 tok** | **197 tok** |
| top-level dirs with counts | 180 tok | — |
| `git log --oneline -20` | 406 tok | 256 tok |
| package.json scripts + dep names | 1,455 tok | — |
| project CLAUDE.md | — | 1,195 tok |
| **crude symbol map, raw grep output** | **95,541 tok** | — |
| **crude symbol map, collapsed to `file: a, b, c`** | **34,324 tok** | 24,305 tok (Rust) |

The symbol map is 3,834 exported symbols across 1,427 files, from 2,503 `.ts`/`.tsx` files, built
by **two ripgrep passes in 145 ms**
[measured: `rg -n --no-heading -t ts -t tsx '^export (default )?(async )?function ' ; rg ... '^export (const|class|interface|type|enum) '` piped to a python collapser].

Read that table twice. **Building a whole-repo symbol map is trivially cheap — 145 ms, no
persistence needed. The problem is that the result is 34,324 tokens.** Aider's answer is to rank it
and truncate to 1,024 [repomap.py:49], which is why Aider's map works and a naive dump would not.
Ranking is the hard, query-dependent half; extraction is the easy half nobody needs to persist.

That single measurement collapses two of the five candidate designs at once: it kills the
"persistent symbol index" (persistence buys nothing over a 145 ms recompute) *and* it kills the
"just inject the symbol map" shortcut (the artifact does not fit). What survives is only the
ranked-and-truncated variant, which needs the work order to rank against — see §3.4.

### 2.4 Where the tokens actually go — 46 M tokens of real transcripts

Analysis over `~/.claude/projects/`: **290 transcripts ≥20 KB across the 12 largest projects**,
**46,132,987 tool-result tokens** total.
[measured: python JSONL parse, matching `tool_use` ids to `tool_result` blocks, `len(s)//4`;
script at scratchpad `disc4.py`/`disc5.py`]

| tool | result tokens | share | calls | median/call |
|---|---|---|---|---|
| **Read** | **33,699,282** | **73%** | 1,819 | 2,051 (mean 18,525, p90 70,540) |
| Bash | 10,030,142 | 22% | 30,593 | — |
| Agent | 515,667 | 1% | 1,833 | — |
| Glob | 338 | ~0% | **1** | — |
| Grep | 0 | 0% | **0** | — |

Grep/Glob are near-zero here because these sessions search through Bash. Splitting the 30,593 Bash
calls by command shape, to avoid understating search:

| Bash class | calls | tokens | share of Bash | median/call | p90 |
|---|---|---|---|---|---|
| **pure search** (`rg`/`grep`/`find`/`fd`/`tree`) | 13,899 | 3,779,349 | 38% | **127** | 624 |
| read-ish (`cat`/`head`/`sed -n`/`ls`/`awk`) | 8,274 | 4,654,650 | 46% | 231 | 1,431 |
| other | 8,420 | 1,596,142 | 16% | 57 | 433 |

[measured: `disc5.py`, regex classification of the `command` input]

**The headline for our decision: searching costs a median of 127 tokens per call and 8.2% of all
tool tokens. Reading costs 73%.** An index makes finding cheaper. Finding is not the bill. Nothing
any of these tools ships lets the model skip *reading* the file it is about to edit.

### 2.5 The real currency is turns, not result bytes

Over **89,326 assistant API calls with usage records**
[measured: python sum over `message.usage` in the same transcripts]:

- uncached input: 253,322 tok · cache_creation: 442,709,211 · **cache_read: 24,421,198,905** ·
  output: 103,837,244
- **cache_read is 98.2% of all input tokens**
- **median total input per API call: 246,710 tokens; p90 503,828**
- at 1× / 1.25× write / 0.1× read, effective input cost is **12.0%** of nominal

Session length, same corpus: **289 sessions, median 276 assistant API calls, mean 309, p90 582,
max 3,903** [measured: `turns.py`].

Caveat: these are this owner's own sessions — long, delegation-heavy lead sessions, not the short
single-work-order children brigadier will spawn. The median of 276 turns is almost certainly an
overestimate for a brigadier child. §3 therefore runs the arithmetic at both ends.

---

## 3. The honest cost-benefit for brigadier's shape

### 3.1 The two costs are not what they look like

With prompt caching on, a token injected up front and a token discovered mid-session cost **almost
exactly the same per token**:

- injected at turn 0 into a `T`-turn session: `X × 1.25` (cache write) `+ X × 0.1 × (T-1)` (reads)
- discovered at turn `k`: `R × 1.25 + R × 0.1 × (T-k)` — strictly *cheaper*, since `k > 0`

So "an index saves tokens by front-loading the answer" is **false as stated**. Front-loading is the
more expensive placement per token. The only thing an index can win is **turns**, and the only way
it loses is **volume** — paying the 0.1× rent, every single turn, on facts the child never needed.

### 3.2 What one saved turn is worth, in numbers

One eliminated discovery round-trip saves one re-prefill of the whole context:

> median input 246,710 tok × 0.1 (cache read) ≈ **24,671 token-equivalents per turn saved**

One injected token costs `1.25 + 0.1 × (T-1)` token-equivalents. So:

> **break-even injected tokens per turn saved = 24,671 / (1.25 + 0.1 × (T−1))**

| session length `T` | cost of 1 injected token | budget per turn saved |
|---|---|---|
| 30 turns (a short child) | 4.15× | **~5,945 tokens** |
| 100 turns | 11.15× | ~2,213 tokens |
| 276 turns (measured median) | 28.75× | **~858 tokens** |

Now price the candidates from §2.3 against that:

| candidate | tokens | turns it must save at T=30 | at T=276 |
|---|---|---|---|
| 2-level dir tree | 785 | **0.13** | 0.9 |
| `git log --oneline -20` | 406 | 0.07 | 0.5 |
| package manifest digest | 1,455 | 0.24 | 1.7 |
| flat file list | 37,224 | 6.3 | 43 |
| **collapsed symbol map** | **34,324** | **5.8** | **40** |
| Aider-style ranked map @ 1k | 1,024 | 0.17 | 1.2 |

**This is the whole answer.** A 785-token directory tree that saves even one `ls -R` pays for
itself six times over in a short child. A 34,324-token symbol map must eliminate **six** discovery
turns in a short child, or **forty** in a long one, and it will not: measured search results are a
median 127 tokens, so the map is 270 searches' worth of content bought speculatively.

Sensitivity, stated so the numbers can be attacked: halve the median context to 123k and every
budget halves too, which *tightens* the case against a big artifact. Assume brigadier's curated
briefs keep children at 60k context and the per-turn saving drops to ~6,000 equivalents, making the
budget at T=30 about **1,450 tokens** — the symbol map loses by 24×, the dir tree still wins. The
conclusion is robust across the whole plausible range; only the margin moves.

### 3.3 Latency: an index cannot beat 50 ms

Spawn-to-first-usable-frame is a measured 1,981 ms. A whole-repo `rg` content scan is 50 ms at our
corpus size and 470 ms at 820 MB (§2.1). Whatever an index saves in local search time is inside the
noise of a single process spawn, and far inside the noise of one model round-trip. Windsurf's
published **5–10 minutes** to build a local index for 5,000 files
[documented: docs.windsurf.com/llms-full.txt] is 150–300× our entire spawn budget.

The latency win from removing a *turn* is real and large — seconds per round-trip. But that is won
by the brief in §5, not by an index.

### 3.4 The one shape that is not obviously wrong

If an index were ever justified, the evidence points at exactly one form, and it is not a prompt
artifact:

> **an MCP tool the child calls, not a blob the harness injects.**

Anthropic's own guidance says so: "if your organization already runs a code search or RAG index
over the repository, expose it as an MCP tool"
[documented: https://code.claude.com/docs/en/large-codebases]. As a tool, its output is charged
once, only when the child chose to ask, and only for the rows returned — the §3.1 asymmetry
disappears, because you stop paying rent on facts nobody wanted.

That framing also reveals why the harness is poorly placed to build one *now*: as a tool, it
competes directly with ripgrep, which is already 50 ms, already correct, already installed and
already the model's trained habit. There is no gap to fill until repo sizes are 100× ours.

**One genuine asymmetry brigadier does have** and Cursor/Continue do not: the harness knows the
work order *before* the child starts. Aider's ranking is personalized by the identifiers in the
current message [repomap.py:422-445] — brigadier could do the same thing with the work-order text.
That is the strongest pro-index argument in this document and it is answered in §8.

---

## 4. Staleness and invalidation — the part that kills these systems

Everything above is arithmetic. This section is about the bugs.

### 4.1 The failure mode is silent and it is a lie, not a miss

A stale search returns nothing and the model greps again. A stale *index* returns a symbol that
was deleted, at a line number that has moved, in a file that no longer exists — and the child
believes it, because the harness said it. It then writes an edit against a shape that is not there,
and the failure surfaces at compile time in the best case and at review time in the worst.

This is not hypothetical. Continue.dev ships it, documented, in its own README's "Known problems":
`FullTextSearchCodebaseIndex` "doesn't differentiate between tags (branch, repo), **so results may
come from any branch/repo**" [source: core/indexing/README.md]. The cheapest sub-index to build is
the one with the shipped wrong-branch bug.

Cody's stated reason for dropping embeddings names the same class of cost first: "**Easier to
manage**: Less tech debt for embeddings setup and need for refreshes"
[source: sourcegraph/docs `docs/cody/faq.mdx:73-93`].

### 4.2 mtime keying is broken in our shape — measured

Aider keys its tag cache on `mtime` [source: repomap.py:246]; Continue gates on mtime before
hashing [source: refreshIndex.ts:200-215]. Both are correct for a single checkout. Brigadier is not
a single checkout.

**A fresh worktree writes every file, so every file gets a new mtime.** For the same logical file
in the same repo:

```
main checkout   package.json  mtime 1788339285
agent worktree  package.json  mtime 1788336481
```
[measured: `stat -f '%m %N' package.json` in both trees]

An mtime-keyed cache therefore **misses on 100% of files in every new worktree** — it would re-parse
the entire repo per work order, which is precisely the cost the index was supposed to avoid.

### 4.3 Content addressing fixes it, and git already computed the hash

Key on the **git blob OID** instead and the problem inverts. Between `staging` and a real
feature branch in the test repo:

- `staging`: 3,089 entries · branch: 3,091 entries
- **identical `(path, oid)` pairs: 3,074 — 99.45%**

[measured: `comm -12 <(git ls-tree -r staging | awk '{print $3"\t"$4}' | sort) <(git ls-tree -r <branch> | awk ...)`]

Across three live agent worktrees, the branch diverged from `staging` by **17, 14 and 22 files** out
of 3,089 — **0.45%–0.71%** [measured: `git diff --name-only staging..<branch> | wc -l`].

So the framing in the original question — "an index keyed to one checkout may be wrong for
another" — is true of mtime-keyed indexes and **false of content-keyed ones**. Content-address any
per-file derived artifact on `git rev-parse HEAD:<path>` and one cache serves every worktree, with
`git diff --name-only` (15 ms) computing the exact delta. Continue reached the same design from the
other direction: `cacheKey = sha256(fileContents)` plus per-branch tags
[source: refreshIndex.ts:371-372, core/indexing/types.ts:24-35].

This is the finding to keep even though the recommendation is "no index": **if brigadier ever caches
anything derived per-file — a summary, a symbol list, a lint result — key it on the blob OID, never
on the path or the mtime.** It is free (git already computed it), it is exact, and it makes
worktrees a non-problem instead of the central problem.

### 4.4 What would have to trigger a refresh

For completeness, the invalidation surface an index would own, each item being code we would write
and maintain:

| trigger | detection | cost |
|---|---|---|
| child edits a file | none available — the harness sees `Edit`/`Write` tool calls, but Bash-driven edits are invisible | unbounded |
| child runs a codegen/build step | invisible | unbounded |
| commit / amend / rebase | `git` hooks or polling `rev-parse HEAD` | cheap to detect |
| branch switch, new worktree | worktree creation is harness-owned | cheap |
| user edits in their own editor, outside the harness | filesystem watch, or nothing | a watcher per project |
| index schema change on upgrade | version stamp, full rebuild | one full rebuild per user |
| corrupt store | Aider's answer is `shutil.rmtree` the whole cache [repomap.py:177-215] | full rebuild |

The first two lines are the ones that matter and neither has a cheap answer. A concurrent-session
harness — brigadier already runs two live sessions on one project (`8351335`) — has *N* children
mutating one repo, and an index shared across them is a shared mutable cache with no
synchronisation story. That is a genuinely hard problem being adopted voluntarily to save a median
127 tokens per search.

---

## 5. Cheap wins that are not an index

This is the recommendation's positive half: what to hand every child, why each item earns its
tokens, and what to leave out.

### 5.1 The brief

Target: **under ~1,500 tokens**, so it clears the §3.2 break-even by roughly 4× even in a long
session. Assembly cost measured in §2.2 at **under 100 ms** total.

| # | item | how | measured cost | why it earns it |
|---|---|---|---|---|
| 1 | **2-level dir tree with file counts** | `git ls-files \| awk -F/ '{print $1"/"$2}' \| sort \| uniq -c` | 16 ms / **785 tok** (197 on brigadier) | Claude Code auto-loads **no** file tree [documented: code.claude.com/docs/en/context-window]. This is the single highest-value item: it is what a `ls -R`/glob turn buys, at 785 tokens. Never the flat list — measured 37,224 tok. |
| 2 | **the work order's own file set** | harness already knows it | ~50 tok | The child's actual targets, by path. Removes the "where does this live" turn entirely. |
| 3 | **branch delta vs base** | `git merge-base` + `git diff --name-only base...HEAD` | 25 ms / ~50 tok | Tells the child what *this worktree* changed. Also the exact invalidation set for anything cached (§4.3). |
| 4 | **build/test/lint commands** | parse `package.json` scripts, `Cargo.toml`, `Makefile`, `justfile` | ~15 ms / ~150 tok | Highest ratio of turns-saved to tokens in the whole list. A child that guesses `npm test` when the repo uses `npm run test:unit` burns a turn *and* produces a false failure. |
| 5 | **framework/toolchain detection** | manifest + lockfile inspection: `react`, `tauri`, `axum`, package manager, language versions | ~15 ms / ~100 tok | Prevents idiom-mismatched code, which costs a review round-trip, not a turn. |
| 6 | **`git log --oneline -15`** | `git log` | 13 ms / **256–406 tok** | Claude Code already loads recent commits at the end of its system prompt [documented: context-window] — so scope this to the *work order's* paths (`git log --oneline -10 -- <paths>`) rather than duplicating it. |
| 7 | **`git status --porcelain`** | `git status` | 31 ms / ~30 tok | Uncommitted state in this worktree. Cheap, and prevents the child clobbering a dirty tree. |
| 8 | **prior-session outcome for this work order** | brigadier's own store | ~200 tok | The one thing **no other tool can provide.** Brigadier owns durable state across children; that, not a symbol map, is its structural advantage. |

Rough total: **~1,400–1,600 tokens.** At T=30 it must save 0.25 turns to break even; it will save
several.

### 5.2 What to deliberately leave out, and why

- **Flat file list** — 37,224 tokens measured (§2.3). Nine times the entire brief budget. This is
  the most tempting mistake in the list.
- **Whole-repo symbol map** — 34,324 tokens measured; must save 6–40 turns (§3.2).
- **File contents of anything** — Read is 73% of all tool tokens at a median 2,051 per call (§2.4)
  and a p90 of 70,540. Let the child choose what to read; it is better at that than we are, and it
  reads at the moment of need rather than at the moment of maximum uncertainty.
- **Anything the CLI already loads.** CLAUDE.md files from cwd and every ancestor, `@`-imports to
  depth 4, git branch/status/recent-commits, and MEMORY.md (shared across worktrees by repo) are
  auto-loaded [documented: code.claude.com/docs/en/memory, .../context-window]. Duplicating them is
  pure rent.
- **An LLM-generated repo summary.** It costs a model call to produce (so it is not "near-zero
  cost"), it goes stale invisibly, it cannot be verified, and it is the failure mode of §4.1 with
  no ground truth to check against. If one is ever wanted, it belongs in the repo's own CLAUDE.md,
  written by a human-reviewed session, where it is version-controlled and diffable.

### 5.3 Two harness-side fixes worth more than any index

Found while measuring, both cheap, both currently costing us on every spawn:

1. **Per-cwd trust and allowlists do not follow a worktree.** `~/.claude.json` → `projects` is keyed
   by absolute cwd (169 entries) and carries `hasTrustDialogAccepted`, `allowedTools`,
   `mcpServers` [measured: python read of `~/.claude.json` keys]. Every new worktree is a new key,
   so every child re-prompts for trust and starts with an empty allowlist. The harness owns the
   child's config and can seed this at spawn. This is worth more per spawn than any retrieval work.
2. **Auto-memory is keyed by git repo, not cwd**, so worktrees *do* share `MEMORY.md`
   [documented: code.claude.com/docs/en/memory; locally consistent — the worktree project dir has
   no `memory/`]. That is a free, already-working cross-worktree channel for durable project facts.
   Not exercised here; worth a spike before relying on it.

---

## 6. Which index would survive contact, if we built one anyway

Ranked worst to best, so the ordering itself is the argument.

| design | verdict |
|---|---|
| **Embeddings / vector store** | **Dead.** Cursor turned it off [forum.cursor.com/t/.../165899], Cody removed it [docs/cody/faq.mdx:73-93], Zed deleted the crate [PR 37780]. Requires an embedding model call per chunk (cost, and for a local-first desktop app, a network dependency or a bundled model). Cursor's own best published case was +0.3% code retention [cursor.com/blog/semsearch] and they still turned it off. Building this in 2026 is building the thing three vendors just removed. |
| **LLM-generated repo summary on git events** | **Dead.** A model call per refresh is not "near-zero cost". Unverifiable, silently stale, and it is §4.1's failure mode with no ground truth. |
| **ctags** | **Dead on arrival here.** Only BSD `ctags` is present — `/usr/bin/ctags` rejects `--version` [measured: `ctags --version` → "illegal option -- -"]; universal-ctags is not installed. Shipping it means bundling a binary per platform for an artifact ripgrep produces in 145 ms. |
| **Tree-sitter symbol map, persisted** | **Not worth it.** Correct in principle and it is what Aider uses, but: (a) the extraction is not the cost — a crude equivalent took 145 ms with two `rg` passes (§2.3); (b) persistence therefore buys nothing; (c) the dependency is real — no tree-sitter exists anywhere in this project or in the local cargo registry [measured: `ls ~/.cargo/registry/src/*/ \| grep -i '^tree-sitter'` → empty], and each language is a separate C-building grammar crate plus a hand-maintained tags query, inside a Tauri bundle; (d) getting *references* right per language is the hard part — Aider falls back to a Pygments lexer for C++ [repomap.py:338-363]. |
| **Ripgrep on demand, no index** | **This is the recommendation.** 10 ms to list, 50 ms to scan our corpus, 470 ms on 820 MB (§2.1). Zero staleness by construction: it reads the working tree the child is standing in. It is what Claude Code, Amp, Zed and Codex all do. It is already installed and already the model's habit. |
| **Content-addressed derived-fact cache (blob OID → fact)** | **Keep in the back pocket.** Not an index; a cache key discipline. 99.45% of `(path, oid)` pairs are shared across worktrees (§4.3), so one store serves every branch with no invalidation logic. Adopt this *if and when* something expensive per-file ever needs caching. Do not build the store speculatively. |

---

## 7. What was not verified

- **No cold-cache timings.** All ripgrep figures are warm. First touch in a fresh 70 MB worktree
  will be slower; unmeasured.
- **Token counts are `chars // 4`, not a tokenizer.** ±20%-ish. No conclusion here turns on a
  margin that small, but the individual numbers should not be quoted as exact.
- **No brigadier child was actually spawned and measured.** The turn-cost model in §3.2 is built
  from this owner's *lead* sessions (median 276 turns), which are longer and more
  delegation-heavy than a single-work-order child will be. The §3.2 table brackets the range
  rather than resolving it. **The one experiment that would settle this brief is running the same
  work order twice — with and without the §5.1 brief — and diffing turn count and total input
  tokens.** It was not run.
- **Cursor's embeddings turndown has no changelog or doc entry**; it rests on staff forum posts.
  Whether server-side embeddings were deleted for existing users was asked publicly and never
  answered.
- **Amp's server side is opaque.** The 71 MB client binary provably has no index; `librarian` runs
  server-side and whatever backs it could not be inspected. `amp tools list` is auth-gated.
- **Claude Code's 7,850-token startup figure is the docs' own illustrative simulation**, not a
  measurement. `/context` was not run on this machine.
- **Claude Code's 199 MB binary was not inspected**; "no index" rests on the docs plus the absence
  of any on-disk artifact.
- **Aider has no published cold-build timing** on a large repo; not benchmarked here.
- **The MEMORY.md-shared-across-worktrees write path was not exercised** — documented and
  consistent with the local directory layout, not proven.
- Windsurf's `llms-full.txt` figures may predate the Devin rebrand; `devin.ai/blog/*` returned 429.
- **Two citation conflicts were found and resolved by weakening the claim, not the fact.** Two
  independent reads of Codex's tool layer disagreed on where the shell handler lives
  (`tools/handlers/shell_spec.rs:96` vs. a handler list containing `shell`/`unified_exec`); the
  *fact* — no Grep/Glob/Read tool — is agreed by both, so the handler-listing citation is used
  above. The same two reads gave t3code's `queryOptions` span as 4352-4385 and 4353-4392. Neither
  span was opened directly from this session. Verify both before quoting a line number.

---

## 8. Recommendation

### Do not build a codebase index.

Build the **§5.1 brief** instead: ~1,500 tokens, assembled in under 100 ms from `git` and manifest
files, with no persistent store, no schema and no invalidation. Let the child use ripgrep for
everything else — which is what Claude Code, Amp, Zed, Codex and t3code all do.

Three findings carry the decision:

1. **Searching is not the bill.** Measured over 46.1 M tool-result tokens: search results are a
   median **127 tokens** and 8.2% of all tool tokens; **Read is 73%** (§2.4). An index attacks the
   small number. Nothing lets a child skip reading the file it edits.
2. **Front-loading is the expensive placement.** With caching at 98.2% of input, an injected token
   costs `1.25 + 0.1×(T−1)` and a discovered token costs strictly less (§3.1). The only prize is
   *turns*, worth ~24,671 token-equivalents each, which sets a budget of **~858–5,945 tokens per
   turn saved** (§3.2). A 785-token dir tree clears it. A 34,324-token symbol map must save 6–40
   turns; it will not.
3. **Persistence buys nothing at our scale, and staleness costs plenty.** A whole-repo symbol map
   rebuilds in **145 ms** (§2.3) and a full content scan takes **50 ms** (§2.1) — so there is
   nothing to amortise. Meanwhile the invalidation surface is real: mtime keying misses on 100% of
   files in a fresh worktree (§4.2, measured), and a wrong index lies to the child rather than
   returning nothing (§4.1).

Adopt one piece of an index design without building the index: **content-address any per-file
derived fact on the git blob OID**, never on path or mtime. 99.45% of `(path, oid)` pairs are shared
across branches (§4.3), so that key makes worktrees a non-problem the day something expensive ever
needs caching.

Revisit this if any of three things become true: repos routinely exceed ~100k files (Cursor's
15-second-`rg` threshold is 30–1,500× away from ours); a measured A/B shows children burning more
than ~5 discovery turns per work order that a precomputed answer would remove; or the harness
starts needing cross-repo retrieval, where local ripgrep genuinely cannot reach.

### The three strongest arguments against this recommendation

Stated as their proponents would state them.

**1. Brigadier knows the work order before the child starts — and that is exactly the input a
ranked map needs.** This is the real one. Aider's map works *because* PageRank is personalized by
the identifiers in the current message [repomap.py:422-445, 519-525]; a query-independent map is
the weak half of that design, and it is the half everyone else is stuck with. Brigadier is not
stuck with it: the harness has the work-order text in hand and could rank a symbol map against it,
then truncate to Aider's 1,024 tokens [repomap.py:49] — landing *inside* the §3.2 budget at both
T=30 and T=276, unlike the 34,324-token dump this brief priced. My §3.2 arithmetic prices the naive
artifact and quietly lets the ranked one off the hook. The honest counter is that ranking needs
*references*, not just definitions, and references are the expensive, per-language, tree-sitter-
plus-Pygments-fallback part [repomap.py:338-363] — but that is an argument about implementation
cost, not about whether the idea works. It works. If any single item here gets overturned, it will
be this one.

**2. My turn-cost model is built on the wrong sessions, and it is the model that decides
everything.** The 246,710-token median context and 276-turn median (§2.5) come from this owner's
long, delegation-heavy lead sessions. A brigadier child is short, single-purpose and starts from a
small curated brief — plausibly 40k of context and 30 turns, at which point one saved turn is worth
~4,000 token-equivalents, not 24,671, and the whole break-even table shrinks by 6×. That cuts
against big artifacts harder, yes — but it also means the *absolute* saving from any of this is
small enough that the entire question may not be worth optimising, in which case "do the cheap
brief" is right for the wrong reason and "do nothing at all" is nearly as good. Either way, the
brief's §7 admission stands: **no brigadier child was ever spawned and measured.** A recommendation
this quantitative should not rest on a proxy corpus.

**3. "Everyone removed embeddings" is not "nobody should index", and I leaned on it.** Cody's
stated reasons were security, ops burden and scale — on quality they claimed only "Equal, or
better", with no benchmark [docs/cody/faq.mdx:73-93]. Zed's crate was deleted as "unused" [PR
37780], which says it lost an internal priority contest, not that it failed. Cursor's staff framing
is that models got better at grep, not that the index was wrong [forum.cursor.com/t/.../165899] —
and Cursor *replaced* it with a different local index (n-gram, mmap'd) rather than with nothing
[cursor.com/blog/fast-regex-search]. Two vendors still ship full local indexes today and are not
visibly suffering for it. The vendor trend is real and it is one-way, but every one of those
decisions was made for a shared multi-tenant product with a maintenance budget and a security
review — none of which describes a single-user local harness that could keep an index in a SQLite
file it already owns.
