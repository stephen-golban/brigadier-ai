# Panel review, 2026-09-03: five models on the architecture and the UI, adjudicated against the measurements

Date: 2026-09-03. Two prompts (Prompt A, architecture and performance; Prompt B, design direction)
were sent as plain web chats, outside this project and without repo access, to gpt-5.6-sol (high
effort), grok fast, claude-opus-5 (high effort) and gemini-3.1-pro. A fifth answer came from a
Google AI Mode search that was asked a stack question the brief did not ask. The five answers are
verbatim in §7. The adjudication in §3 was written by the lead session, then every claim that touched
a number was checked against the files on this machine (§4).

The rule this document applies: **N models agreeing is not evidence.** Frontier models share most
of their pretraining corpus, so consensus among them is a much weaker signal than it looks. Each
agreed point is tagged with whether it is agreed because it is true or because it is received
wisdom. A measurement on this machine outranks any number of confident generic claims.

Tags: **[measured]** (a command run on this machine, or a number read from a fixture, with the
path), **[source]** (read in source on this machine, `file:line`), **[asserted]** (reasoning,
unverified), **[panel]** (a panellist's claim, attributed by model, not verified unless said so).

## 1. The measured numbers the panel argued against

Every line below was re-read at the cited location on 2026-09-03.

| Figure | Value | Where |
|---|---|---|
| spawn → `initialize` `control_response` | 719 ms | `docs/research/claude-direct-spike.md:106` **[measured]** |
| spawn → `system/init` | 1,981 ms | `claude-direct-spike.md:107`, `docs/STATUS.md:128-130` **[measured]** |
| `system/init` → `result`, first user frame → `result` | 1,239 ms, 2,501 ms | `claude-direct-spike.md:108-109` **[measured]** |
| exec → first contentful paint, p50, n=19, three arms | 287–295 ms against a ≤ 200 ms budget | `docs/research/perceived-performance.md:42`, `STATUS.md:125` **[measured]** |
| `brigadier started` → FCP | 132–141 ms against a 38 ms estimate | `perceived-performance.md:262-269` **[measured]**; the ~100 ms attributed to the scheme handler and brotli inflate is **[asserted]** by elimination, `:267-269` |
| React 19 + 258 kB bundle over a 400-byte static page | ~12 ms of FCP | `perceived-performance.md:164-165`, `STATUS.md:131` **[measured]**, loopback HTTP, bare `NSWindow` |
| WKWebView construction | ~100 ms | `perceived-performance.md:165` **[measured]** |
| bundle | 258,493 B raw, 81,140 gzip, 70,640 brotli-11 | `perceived-performance.md:24` **[measured]** |
| SQLite tail query, 1M rows, 152 MB, `LIMIT 500`, warm | 0.142 ms | `perceived-performance.md:325` **[measured]** |
| same, fresh connection each time | 0.283 ms (p50), 0.414 ms | `perceived-performance.md:326` **[measured]** |
| window refresh rate | 60 Hz over 1,513 one-second samples | `perceived-performance.md:838`, `STATUS.md:132` **[measured]** |
| fan-out, N=3, direct children vs in-agent subagents | 16% fewer tokens, 25% less cost, 1.74× faster wall clock | `docs/research/fanout-vs-children.md:21-22` **[measured]** |
| coordinator share of Arm B tokens | 50.1%, 133,858 tokens; 27,397 per completion wake | `fanout-vs-children.md:61`, `:244-245` **[measured]** |
| eight parallel `git worktree add` against one repo | no lock contention | `docs/research/worktree-git.md:153` **[measured]** |
| feed harness | ten synthetic sessions over the real `Channel` path, one per-frame flusher at 16 ms | `docs/research/feed-rendering.md:439-458` **[measured]** |
| feed batch cap | 24 rows, `serialized.len() < 8000` before every `send` | `feed-rendering.md:486` **[measured]** |

One of these is now known to be misleading on its own. See §4(a): five later runs on the same
machine put spawn → `system/init` at 569–656 ms, not 1,981 ms.

## 2. What the panel was asked

Prompt A asked: where the measurements above are wrong; what breaks first at ten concurrent
sessions across three projects; whether the spawn cost should be hidden by a warm pool of children or
by letting one child serve several turns; and what was not measured that matters. Prompt B asked:
what makes a dense desktop UI read as dated; concrete type, spacing and radius numbers; hierarchy
without colour; motion; and the one thing the build will get wrong. The Google AI Mode result is a
generic stack recommendation and is included only for completeness.

## 3. Adjudication

### 3.1 Agreement, and why

- **The SQLite write path is unmeasured.** All four. True, the tail-query work is read-only. But every
  panellist reasons from "ten writers contending", and the design has one writer thread batching all
  sessions per 250 ms (`crates/store/src/writer.rs:303-360` **[source]**, verified in §4(b)). The
  agreement is the one-writer WAL line from every SQLite thread, recited without the design in view.
  The real gap is narrower than any panellist stated: the single-writer batch under ten producers,
  and, because reads go through the same thread (§4(b)), the latency a UI query pays waiting for the
  in-flight batch to commit.
- **Batch IPC on the Rust side.** gpt, gemini, opus. Already built and measured: Channel path, one rAF
  drain, one commit per frame, batch capped at 24 rows or 8 kB, ten synthetic sessions
  (`src/feedStore.ts:2-8`, `feed-rendering.md:439-486`). This is the Tauri performance guide recited
  back. It ignores the brief.
- **The scheme-handler attribution is weak.** All four. Agreed because the brief tagged it
  `[asserted]` itself. The panel added nothing here except opus's alternative hypothesis (§3.4).
- **Rule lines are overused, no log-row animation, nothing over 200 ms.** All four. Received doctrine,
  cheap and correct. gemini contradicts itself by specifying a 1 px `#333333` panel rule two
  paragraphs before calling rule lines the overused mechanism.
- **Session rows around 28 px, log at 12 px mono.** Three of four land on 28. That is the platform
  sidebar default, not a derivation. Convention, not evidence. The build is at 30 px project rows and
  27 px session rows today (`src/index.css:109-110` **[source]**).

### 3.2 Contradictions, as forks

- **Spawn mitigation: pool (gpt, grok) versus reuse (opus, gemini).** opus's reuse position is
  conditional on a context-reset primitive in the control protocol. `docs/research/cli-protocol.md`
  lists none; only `--resume` and `--fork-session` exist, both at spawn (`cli-protocol.md:51-56`).
  gemini's "strict working-directory reset and state-clear command over stdio" does not exist.
  gemini is confidently wrong. opus's fallback, capped reuse at three to five turns, breaks the
  no-accumulation invariant opus itself names as the cost, and that invariant is a settled decision
  (`CLAUDE.md` §2). The pool side has a measured ceiling: `system/init` only arrives after the first
  user frame (`claude-direct-spike.md:114-116`), so a pool warmed to the handshake hides at most the
  spawn → `initialize` slice. gpt predicted exactly this caveat. Neither side wins on the current
  numbers. **Corrected after verification (§4(a)):** the slice a pool could hide is not 719 ms but
  whatever spawn → `initialize` is on a warm machine, and spawn → `system/init` in five later runs was
  569–656 ms in total. The whole spawn question is smaller than the brief said. What settles the fork
  is a second-turn user frame → `result` timing inside one process, which no fixture carries (§4(a)).
- **What breaks first at ten sessions.** grok says file descriptors at eight to twelve. Wrong: thirty
  pipes is nothing, though opus's note that a Finder-launched app gets a 256 soft limit is the useful
  residue, and nothing in the tree raises it (§4(d)). gemini says the webview main thread at five,
  from one message per frame per session. opus says the same at four to six, from per-event
  `setState`. Both assume the per-event shape the feed does not have (§4(e)). gpt's answer survives:
  the tool trees under the children, not the harness. Nobody has a per-tree memory figure and
  neither does the repo. **[asserted]**
- **Sidebar density.** gpt wants sessions at 32 px, opus and gemini at 28, grok at 24 while claiming
  the sidebar should be denser than the log. grok's own numbers make it sparser than an 18 px log.
  Internally inconsistent. The gpt versus opus fork is 32 versus 28; the build is at 27
  (`src/index.css:110`), so the current ratio to the log is 1.5. Settle by opus's blur test (§3.4).
- **Opacity ladders (gemini, grok) versus literal greys (opus, gpt).** opus and gpt are right for
  this repo: the tokens are literal greys with measured contrast (`docs/research/oklch-tokens.md`),
  the stylesheet says "a weight difference, never an opacity one" (`src/index.css:593`), and the only
  `opacity` rules in `src/` are disabled and expired states, not text hierarchy (§4(g)). gemini's 40%
  tertiary fails AA on both backgrounds (§4(h)). **Corrected after verification:** grok's 55% passes
  AA on both backgrounds (6.08:1 on the thread, 4.66:1 on the sidebar); the lead's earlier table
  lumped it with gemini's 40%, and that was wrong for the thread background and marginal on the
  sidebar. The compositing objection stands regardless.
- **Expand and collapse motion.** gpt says instant. The other three animate at 120 to 150 ms. opus's
  own rule, never transition a state the user just caused, argues for gpt, and opus hedges "drop it
  if it costs frames". Side with gpt. Note the build already animates session arrival at 140 ms,
  transform and opacity only (`src/index.css:530-542`).
- **Base sans size.** gpt says 14 to 15, the rest say 13. Only opus gives a reason: mono at 12 reads a
  step larger than sans at 12. The build's base is a measured 14 px with 13 px session rows
  (`src/index.css:129-130`). Confirm with a screenshot at both before moving.

### 3.3 Claims against the measurements

| Panellist | Claim | Repo | Verdict |
|---|---|---|---|
| gemini | The 263 kB asset pays IPC serialization; test by serving over localhost HTTP | Assets go through the scheme response body, not the JSON bridge. The localhost test is how the 12 ms and ~100 ms numbers were produced (`perceived-performance.md:157-169`) | Ignored the brief |
| gemini | 600 IPC messages/s at ten sessions, breaks at five | One Channel batch per frame, measured at ten sessions (`feed-rendering.md:439-458`) | Ignored the brief |
| opus | The 60 Hz feed result came from one or two sessions | The feed harness runs ten (`feed-rendering.md:445`) | Wrong, unless the brief omitted the count |
| opus | Report p99 and max frame intervals, not fps | `src/fps.ts:178-180` reports p95, p99 and worst; the "60 Hz over 1,513 samples" figure is the refresh-rate measurement, not the feed metric | Misread which number was which. The ProMotion caveat matches the repo's open 60/120 question (`feed-rendering.md:644`) |
| opus | Use `PerformanceObserver` longtask | `feed-rendering.md:302-310`: longtask and long-animation-frame unsupported in WebKit | Confidently wrong instrument for this webview |
| opus | SQLite figures are warm-RAM only | Fresh-connection cold-cache run measured at 0.283 ms (`perceived-performance.md:326`) | Half right: the OS page cache was not dropped |
| opus, gpt | The fan-out "wake-up tax" is an inference on top of three runs | The coordinator's 50.1% share and 27,397 tokens per completion were counted from transcripts (`fanout-vs-children.md:61`, `:244-245`) | Wrong on mechanism, right that n=3 wall clock is thin |
| opus | The spawn number is an unbroken aggregate | The 719 / 1,981 split exists; the 1,262 ms after the first user frame is unbroken | Half right, and see §4(a): the five later runs were MCP-off and the 1,981 ms run was MCP-on (`spawn-split.md:105`) |
| opus | packed-refs lock flakes at three or four sessions | Eight parallel worktree adds measured with no contention (`worktree-git.md:153`). Concurrent commits unmeasured | Stands as a hypothesis, not as stated |
| gemini | Tertiary text at 40% white | 3.80:1 on the thread, 3.21:1 on the sidebar (§4(h)); commit `c54f039` just lifted muted-side to 4.56:1 | Contradicts the measured contrast work |
| grok | Timestamps at 55% white | 6.08:1 on the thread, 4.66:1 on the sidebar (§4(h)) | Passes AA. The objection is compositing, not contrast |
| grok, gemini, opus | The 1,981 ms spawn is the cost to hide | Five later runs: 569–656 ms spawn → `system/init` (§4(a)) | Every panellist priced a number the repo's own later fixtures do not reproduce; the brief carried the stale figure |

### 3.4 Unique insight that survives

- **gpt: effect succeeded, acknowledgement lost.** A tool commits or edits, the process dies before the
  result is durable, a fresh context repeats it. The harness is authoritative but SQLite, git, the
  filesystem and the child are not one transaction. Record intent before dispatch, reconcile
  postconditions on restart, represent unknown as unknown instead of retrying. Nobody else raised it
  and it is a correctness bug, not a tuning question.
- **gpt: stale initialization in a pool,** and "prove ready is useful". The `system/init`-after-first-
  user-frame ordering confirms the second point.
- **gpt: drain child output independently of frontend consumption.** Verified in part: the feed sink
  wraps `tauri::ipc::Channel::send`, which is synchronous and fire-and-forget
  (`crates/supervisor/src/sink.rs:3-4` **[source]**), and store writes go to their own thread. Whether
  the webview side can back up the Channel was not checked.
- **gpt: the feed as dominant reading material will read as diagnostic whatever the radii.** This
  questions the brief's own constraint, the fixed 18 px log as the primary surface, and says the plan
  card must answer "what needs me" first.
- **opus: cache reads per step.** Sharpened by the repo: every fresh child in the fan-out run read
  18,883 cached tokens on its first message (`fanout-vs-children.md:166-170`), so the CLI's static
  prefix does cache across spawns. The exposure is only the harness-authored brief, and usage frames
  already carry the numbers.
- **opus: steps to completion.** Per-step cost was measured, steps to finish never. If the compressed
  state costs 1.6× the steps, flat cost is real and irrelevant. The deepest item on the panel.
- **opus, small and real:** raise the 256 soft file limit at startup (nothing does, §4(d)); mono
  optical size; an orange budget of two at rest (the build uses the accent in nine selectors including
  the focus ring, §4(g)); tabular numerals; the 8 px blur test.
- **grok: composer-enter to first painted token under load.** The one latency a user feels end to
  end. Nobody else defined it.
- **gemini: scrollbars.** Small, and more of a problem on Windows and Linux than on macOS overlay
  bars.

### 3.5 Blind spots

- **The brief's own research holds the leading candidate for the missing ~100 ms,** and the brief's
  framing hid it. `src-tauri/src/lib.rs:137` runs `block_on(state::build(..))` inside `setup`, on the
  main thread, after the window exists. That call opens the store (flock, migration ladder, pragmas),
  opens the pid directory and sweeps stale groups with a 400 ms grace when any exist, and spawns and
  awaits `claude --version` (§4(c)). `perceived-performance.md:85-100` says this stalls scheme
  delivery and paint. Every panellist accepted "scheme plus brotli" as the two candidates.
- **The binding constraint at ten sessions is the subscription window, not the machine.**
  `docs/vision.md` §6 runs on the user's plan with a reserve near 80%; the warm-up fixture on this
  machine already reads `five_hour` utilization 0.8 (`crates/claude-spike/fixtures/f-warm.summary.json:24`
  **[measured]**). Ten concurrent sessions drain the window long before file descriptors or the write
  lock. The panel answered a hardware question because the brief asked one.
- **The spawn figure the panel priced is stale.** §4(a).
- **Nobody saw the UI.** Part B is generic advice against `docs/plans/ui-2026-09-02.png` unseen. opus's
  warning that you will build the lists and miss the ratio applies to the panel itself.

Net: on Part A the panel mostly restated the brief's own `[asserted]` tags. The additions are gpt's
crash-recovery point and opus's two experiments. On Part B, the blur test and the mono-optical note
are the two things a checklist would not have given.

## 4. Verified on this machine, 2026-09-03

(a) **Reuse pricing.** No fixture carries wall-clock timestamps for a second turn in one process.
`crates/claude-spike/fixtures/s4-interrupt.ndjson` (20 lines) holds two `result` frames with the
CLI's own clocks only: turn 1 `duration_ms` 1,665 / `duration_api_ms` 902 (interrupted), turn 2
`duration_ms` 1,634 / `duration_api_ms` 2,530 / `ttft_stream_ms` 933 **[measured]**. The spike doc
records for scenario 4 only that the second turn completed (`claude-direct-spike.md:176-177`). The
s1 turn's CLI clock is `duration_ms` 1,249 against a wall of 2,501 ms from user frame to result
(`claude-direct-spike.md:109`); the 1,252 ms gap is the CLI's pre-turn work that its own clock does
not count. **What the later fixtures show instead:** the fan-out spike's summaries record
`spawn_to_init_ms` of 645 (`f-warm.summary.json:151`), 598, 656, 569 (`f-a.summary.json:151,309,467`)
and 655 (`f-b.summary.json:504`), measured from `spawned_at` to the first `system/init`
(`crates/claude-spike/src/bin/fanout.rs:120-160`), and `f-warm`'s user frame → `result` at 1,259 ms
with `duration_ms` 1,254 (`f-warm.summary.json:40-44`). Five runs on 2026-09-02 put spawn →
`system/init` at 569–656 ms, MCP-off because `fanout.rs:97` passes `--strict-mcp-config`, against the
1,981 ms MCP-on figure in `STATUS.md:128-130` (both of the user's MCP servers connecting). Six
alternating pairs in `spawn-split.md` price that arm difference at 751.5 ms median (`on` 1,395.0 ms,
`off` 643.5 ms), which accounts for most of the gap; cold start explains the rest, since
`spawn-split.md`'s own `on-1` run was 2,447 ms against an `on` median of 1,395 ms. **[measured,
spawn-split.md:105,197-202]**

(b) **Single writer.** Yes. One `rusqlite::Connection` on one dedicated thread named
`brigadier-store`, `std::sync::mpsc`, one transaction per 250 ms window
(`crates/store/src/writer.rs:303-315`, `:323-361`, `:396`; `crates/store/src/lib.rs:6-7`, `:100`).
Pragmas actually set: `busy_timeout = 5000`, `foreign_keys = ON`, then `journal_mode = WAL`,
`synchronous = NORMAL`, `journal_size_limit = 64 MiB` (`crates/store/src/schema.rs:40`, `:416-427`).
`wal_checkpoint(TRUNCATE)` runs only at shutdown (`writer.rs:365`). **Readers do not use a separate
connection:** a query is an `Op::Query` closure run on the writer thread inside the same transaction,
and its arrival closes the batch window early (`writer.rs:329-335`, `:407-411`). A UI tail query
therefore waits for the pending batch to commit. **[source]**

**[measured]** The wait tops out at 8.03 ms, the writer's own worst case at 10 sessions burning
2000 rows/s each (`docs/research/perceived-performance.md:354`, table at `:371`). A second
read-only connection to take reads off the writer thread is a documented dead end, not an open
action: it would buy at most that 8.03 ms and was shelved, "revisit only if `feed_cap` grows by an
order of magnitude" (`perceived-performance.md:939-943`).

**[source]** Read-your-writes is load-bearing on three callers outside the store:
`crates/supervisor/src/lib.rs:465` (`add_project` dedupe via `list_projects`, guarded by
`crates/supervisor/tests/supervisor.rs:528-531`), `crates/supervisor/src/lib.rs:601`
(`resume_session` reading the status `session_ended` wrote), and `crates/store/src/lib.rs:305`
(a `session()` read with no preceding flush). A second connection would have to pay for that
ordering.

(c) **`state::build` in setup.** `src-tauri/src/lib.rs:137`
`tauri::async_runtime::block_on(state::build(data_dir))`, inside `.setup`, which the comment at
`:124-127` says runs on `RuntimeRunEvent::Ready` after the window exists, on the main thread. `build`
(`src-tauri/src/state.rs:208-238`) awaits in order: `create_dir_all`; `Store::open` (flock,
migrations, pragmas, `:215`); `open_pid_dir` (`:222`) which sweeps with `DEFAULT_GRACE` = 400 ms
(`state.rs:257`, `crates/proc/src/sweep.rs:32`); `Supervisor::new`; `probe(&supervisor).await`
(`:236`) which spawns `claude --version` through `ClaudeDriver::probe` (`state.rs:181-182`). Only
`prune_worktrees` is spawned off the setup thread (`lib.rs:146-148`). **[source]**

(d) **File limit.** `grep -rnE "setrlimit|rlimit|NOFILE" src-tauri/src crates/*/src` returns nothing.
Not raised anywhere. **[measured]**

(e) **Frame meter and feed batching.** `src/fps.ts:178-180` reports `p95_ms`, `p99_ms`, `worst_ms`;
the pass rule is p95 within 10% of budget and worst within three budgets (`:237-247`).
`src/feedStore.ts:2` "Channel -> module buffer -> one rAF drain -> one commit per frame"; `:6-8`
`pushBatch` is the Channel `onmessage` and exactly one `requestAnimationFrame` loop drains;
`:355`, `:395` the rAF re-arm. **[source]**

(f) **Prompt cache evidence.** `docs/research/fanout-vs-children.md:166-170`: "the first message of
Arm A's `f-a1-alpha` and the first message of Arm B's coordinator both read **18,883** cached tokens
and created ~5.8k. Identical starting cache state. **[measured]**" And `:174-176`: the first subagent
to reach the API paid `cr 0 / cc 13,659`, the other two `cr 8,475 / cc 5,184`.

(g) **Part B in `src/`.** `opacity` appears in five rules, none for text hierarchy:
`textarea:disabled` 0.4 (`src/index.css:197`), `.notice svg` 0.75 (`:961`), `.approval.expired` 0.65
(`:1161`), `.send:disabled` 0.28 (`:1374`), `.fps.off` 0.5 (`:1473`); plus the 140 ms arrival
transition (`:530-542`). `1px solid` borders: ten declarations (`:761`, `:816`, `:892`, `:1068`,
`:1100`, `:1154`, `:1187`, `:1232`, `:1460`, `:1501`), six of them `--color-line` on cards
(suggestion and approval cards), two `--color-sidebar-line`, one `rgba(255,255,255,0.05)`. How many
are visible at rest depends on state; not counted from a screenshot. `--color-accent` (#ef8c57) is
used in nine selectors: `:focus-visible` outline (`:202`), `.side-project.holds` rail (`:450`),
`.side-holds` (`:458`), `.chip` (`:672`), `.dot.starting` (`:717`), `.col-s` (`:1033`),
`.approval.elsewhere` left border (`:1165`), `.status-chip.warn` (`:1414`), `.dock-note.warn`
(`:1427`). Rows and type: `--row-h` 30px project rows, `--row-h-nested` 27px session rows,
`--feed-row-h` 18px (`:109-114`); `--fs-xs` 11, `--fs-sm` 12, `--fs-md` 13 (session rows),
`--fs-base` 14 (row label and document base), `--fs-lg` 17 (`:127-131`); sans is the system stack,
mono is `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas` (`:99-101`). **[source]**

(h) **Contrast arithmetic.** White composited at the given alpha over `--color-thread-bg` #181818
and `--color-sidebar-bg` #3a3b3b (`src/index.css:53-54`), WCAG 2 relative luminance:

| alpha | on thread-bg | on sidebar-bg |
|---|---|---|
| 40% | #747474, 3.80:1 | #898989, 3.21:1 |
| 55% | #979797, 6.08:1 | #a6a7a7, 4.66:1 |
| 70% | #bababa, 9.15:1 | #c4c4c4, 6.44:1 |

Cross-check against the shipped tokens: `--color-text-muted` #848484 on the thread 4.748:1,
`--color-text-muted-side` #a5a5a5 on the sidebar 4.562:1, matching `src/index.css:68,74`.
**[measured]**

**Corrections.** 2026-09-03: the lead's order to move reads onto a second connection was issued
from a code reading and withdrawn the same day after §2.3 was re-read; the panel's SQLite-contention
consensus was already answered by a measurement the brief did not surface.

2026-09-03, later: the "cold outlier" label was itself wrong; the five fast runs were MCP-off and
the slow one MCP-on (`spawn-split.md`).

## 5. Actions and the next measurements

Ranked.

1. Instrument launch with signposts at exec, `setup` entry and exit around `state::build`, first
   scheme request, handler response, `DOMContentLoaded`, FCP. One work order.
2. Re-measure spawn → `initialize` and spawn → `system/init` on a warm machine, ten runs, and replace
   the 1,981 ms headline in `STATUS.md` with a distribution. Then time a second user frame → `result`
   in one process against a fresh spawn, and spawn one child with MCP disabled to split whatever
   pre-turn work remains. Decide pool versus reuse after that, not before.
3. Write an intent record before any effectful step and reconcile on restart. Correctness, ships
   before any performance work.
4. Raise `RLIMIT_NOFILE` at startup, and record the RSS of one session's whole process tree during a
   real build.
5. Log input, cache-read and cache-creation tokens per turn from frames already parsed.
6. Design: keep literal greys; 28 and 32 px sidebar rows if the blur test says so, else stay at 27
   and 30; 13 px sans confirmed by screenshot; cut orange to the selected session and running state
   and take it off `:focus-visible`; two rule lines at rest; instant expand; a styled log scrollbar.
   Blur-test the screenshot before and after. Leave the plan card's content alone until it is known
   what it says when a session needs approval.

| Measurement | Flips to |
|---|---|
| `state::build` on the main thread over 50 ms | Move it off `setup` behind a ready event; the brotli hypothesis is dead. Under 20 ms: inline HTML, JS and CSS into one scheme response, opus's round-trip hypothesis |
| Warm spawn → `system/init` confirmed near 600 ms | The spawn question drops below the launch question; neither pool nor reuse is worth an invariant argument. Near 2 s: proceed to the second-turn measurement |
| Second turn in one process at least 1 s cheaper than a fresh spawn | Reuse is worth filing an upstream reset primitive. Near equal: the spawn question is now answered by `--strict-mcp-config` (751 ms per spawn, `spawn-split.md:105`), the remaining floor is 643.5 ms (624.5 ms of it before the CLI answers anything, `spawn-split.md:104,207-210`), and the pool is not worth its memory |
| Three real tasks, harness versus long-lived control, at 1.3× the steps or worse | Stop all performance work and work on the state brief |
| Cache-read share of per-step input under half | Prefix-stable brief construction becomes a design item now |
| Ten sessions, one flooder, one approval: approval visible under 100 ms, no backlog | Failure implicates the approval path and the non-feed store updates, since the feed is measured |
| Five-hour window utilization slope at ten sessions | If it drains in under an hour, the concurrency ceiling is the window and the hardware questions are moot |

## 6. Not checked

- No panellist's browser or OS claims were re-verified against vendor docs here; §4 is repo-only.
- The number of 1px borders visible at rest was not counted from a screenshot.
- Whether the webview side of the Channel can apply backpressure to the supervisor was not read.
- The s4 second-turn wall clock does not exist in any fixture; only the CLI's own `duration_ms`.
- The RSS of a child process tree has never been recorded in this repo.

## 7. Appendix: the panel answers, verbatim, in the order received

### 7.1 gpt-5.6-sol, high effort

#### Brigadier — Architecture, Performance, and UI Review

The architectural claim I would reject first is **"fresh context means flat cost."** It guarantees neither bounded work nor preserved decision quality.

1. **Your measurements are stronger than the conclusions drawn from them.**

   | Inference I would challenge | What would settle it |
   |---|---|
   | **Cost stays flat over hundreds of steps.** Reconstructing context can grow, or remain bounded by omitting information that later causes retries. One CLI request can also contain multiple model/tool turns. | On long tasks, record context assembly time, all input/output/cache tokens, repeated file reads, retries, and accepted progress. Compare early and late steps of similar complexity. Measure **cost per accepted change**, including failed attempts. |
   | **Constant DOM size and sustained FPS mean the feed scales.** Virtualization bounds mounted elements; it does not bound retained JS objects, parsing, subscriptions, or queues. A smooth feed can display stale information. | Stamp events at ingestion, persistence, frontend receipt, and presentation. Measure event age, individual frame intervals, heap growth, and input latency during bursts and session switching. |
   | **The tail query establishes storage performance.** It establishes one read path. It says little about concurrent ingestion, transaction overhead, checkpoints, or recovery. | Run the same query while ten producers write representative payloads. Record commit latency, writer queue age, WAL size, and checkpoint duration. SQLite still permits only one writer at a time in WAL mode. [SQLite documentation](https://www.sqlite.org/wal.html) |
   | **Worktrees mean agents cannot collide.** They separate ordinary working files, but shared refs/configuration remain, and tools can share ports, databases, caches, or paths outside the worktree. Independently passing changes can also conflict semantically when integrated. | Run simultaneous builds, dev servers, and repository operations; then integrate competing changes against the current project HEAD. Count successful integrations, not completed agent sessions. [Git documentation](https://git-scm.com/docs/git-worktree) |
   | **Harness fan-out wins because of coordinator wake-up overhead.** Three runs cannot distinguish scheduling overhead from different work, cache conditions, or output quality. | First use deterministic fake workers with identical completion schedules. Then use paired real tasks with identical acceptance checks. Trace worker completion → coordinator scheduling → next dispatch. The claimed tax should be visible there. |

   For startup, directly instrument scheme callback entry, asset lookup, decompression, response delivery, navigation, and paint. Compare otherwise identical compressed and uncompressed builds. **Subtracting component timings does not establish their contribution to the critical path.**

   The static-page comparison supports "React is not the dominant launch cost in that experiment." It does not establish that JavaScript cannot become the interaction bottleneck under concurrent ingestion.

   Also measure launch to **usable restored state**: selected session loaded, composer accepting input, controls connected. An earlier decorative paint would satisfy the wrong budget. Repeat on Windows and Linux; the macOS result cannot characterize their webviews.

2. **At ten sessions, I expect tool-process CPU and memory to fail first under real coding workloads.**

   Ten sessions are not ten processes. Builds, test runners, language servers, MCP servers, and browser tests determine the resource multiplier.

   The thresholds below are conditional forecasts and worked examples—not measurements of brigadier.

   | Resource | Where I would expect trouble | Decisive measurement |
   |---|---|---|
   | **CPU from tool descendants** | As early as **two simultaneous builds** if each independently consumes all available cores. | Full process-tree CPU and runnable work, correlated with approval and cancellation latency. |
   | **Memory** | Potentially before ten. With 6 GiB available headroom and 768 MiB incremental memory per active tree, the arithmetic limit is **eight**. Your actual tree footprint is missing. | Incremental system memory pressure, swap activity, and peak tree footprint during tests—not just Rust RSS. |
   | **IPC / webview main thread** | My first harness-specific suspect at **5–10 noisy sessions** if every event crosses the bridge and triggers frontend work independently. At ten sessions × 100 events/s × 0.5 ms frontend work/event, ingestion occupies half a main-thread second every second. | Cost per event and batch, bytes crossing IPC, pending queue age, and input-to-paint latency. |
   | **SQLite writes** | Potentially **five sessions** under the illustrative combination of 100 transactions/session/s and 2 ms serialized transaction service time. Batching changes this threshold substantially. | Actual transactions/s, batch sizes, commit service time, and writer utilization. |
   | **File descriptors / handles** | I would not predict exhaustion at ten without leaks or heavy tool fan-out. Three captured stdio streams contribute roughly 30 parent descriptors for ten children. | Baseline plus incremental handles, actual process limits, and leakage after repeated start/cancel cycles. |
   | **Process supervision** | A correctness failure can occur at **one session**; ten increases opportunities. A stopped direct child may leave descendants running. | Cancel while tools spawn descendants, then verify the whole owned tree has stopped and been reaped. |

   If you use Tauri events for every streamed record, change that path to bounded channel delivery with batching. Tauri explicitly identifies channels as the mechanism for ordered, high-throughput streams. Channels still need application-level queue limits. [Tauri documentation](https://v2.tauri.app/develop/calling-frontend/)

   **Do not make draining child output depend on frontend consumption.** Otherwise a slow or hidden webview can eventually stall the agent through pipe backpressure. Persist independently; let the UI catch up by sequence number.

   The first stress test I would run: **eight ordinary sessions, one flooding output, one requesting approval**, distributed across the three projects. Switch sessions and type while it runs. Proposed gates: approval visible within 100 ms of harness receipt, no growing durable-event backlog after the flood ends, and no lost events. Then repeat while real builds compete for resources.

3. **Choose a bounded pool of single-use warm children.**

   Ordinary multi-turn reuse contradicts your central invariant: later decisions inherit history outside the harness's explicit context selection. Anthropic documents that persistent sessions retain earlier prompts, tool results, and responses. Disabling transcript persistence does not itself establish a fresh context between turns. [Session documentation](https://code.claude.com/docs/en/agent-sdk/sessions)

   I would implement the pool with these rules:

   - Bind each child to its worktree, CLI version, model, environment, and permission/configuration identity.
   - Warm only through initialization that requires no task prompt.
   - Give it exactly one harness decision request, then retire it.
   - Begin with at most two speculative children globally, prioritizing known upcoming work.
   - Discard children when configuration they captured during initialization becomes stale.

   **The correctness failure is stale initialization.** A warm child might retain project instructions, permissions, or tool configuration that changed while it waited. Test this deliberately: warm it, change those inputs, then compare its behavior with a fresh child. Do not assume it rereads everything.

   Also prove that "ready" is useful. If expensive initialization happens only after the first user message, an idle process pool will hide little. Sending a dummy prompt to force initialization would contaminate the supposedly fresh session.

   Pooling overlaps startup; it does not eliminate startup work. It adds idle memory and can drain during synchronized completions. Measure **dispatch-to-first-useful-action latency, pool misses, and total resource consumption**.

   I would favor reuse only after a supported reset operation demonstrably clears history and relevant session state while preserving expensive initialization. "Forget everything" is not such an operation.

4. **The missing measurement most likely to damage this design is recovery after an effect succeeds but its acknowledgement is lost.**

   Concrete sequence:

   - A tool edits a file or creates a commit.
   - The child or harness dies before the result becomes durable.
   - On restart, the harness sees an unfinished step.
   - A fresh context repeats the operation.

   Your durable plan does not reveal whether the effect happened. Making the harness authoritative does not make SQLite, Git, filesystem changes, and subprocess execution one transaction.

   Inject crashes immediately before execution, after the effect, before recording completion, and before updating the UI. Include an interrupted cancellation and a surviving descendant.

   Measure **duplicate effects, falsely completed steps, orphan processes, and recovery time**. Record operation intent before dispatch; reconcile observable postconditions afterward. Where an effect cannot be identified safely, represent the outcome as unknown instead of automatically retrying.

   Cancellation needs explicit ownership too: Tokio does not kill a child merely because its handle is dropped, and terminating a Windows process does not terminate its children. Use platform-appropriate process-tree management and verify its behavior. [Tokio documentation](https://docs.rs/tokio/latest/tokio/process/struct.Child.html), [Windows process termination](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)

For the UI, these are implementable starting values, not observations about your unseen build. **The largest improvement will come from separating navigation, human-readable intent, and diagnostic output into visibly different levels of attention.**

1. **These mechanisms make a dense desktop UI read as dated, ranked by expected impact.**

   1. **Every container announces its boundary.** Borders around the sidebar, plan, log, composer, and every row produce a grid of compartments. Remove row separators and the log's enclosing box first.
   2. **Everything has equal typographic authority.** Monospace labels, timestamps, headings, and controls at similar size/weight make the interface read like an inspector. Restrict monospace to diagnostic content.
   3. **Navigation inherits data-table density.** Eighteen-pixel events can work; equally compressed session targets make navigation feel cramped and mechanically assembled.
   4. **Alignment lacks consistent anchors.** Slightly different left edges across the title, plan, feed, and composer create more disorder than a wrong radius.
   5. **Permanent controls compete with names.** Repeated close buttons, chevrons, badges, and timestamps overwhelm sidebar labels. Keep primary state visible; reveal secondary actions on hover and keyboard focus.
   6. **Every surface receives the same treatment.** Identical padding, radius, background, and border make controls, containers, and content indistinguishable.

2. **Use this type and geometry specification.**

   All values are CSS pixels.

   | Element | Size / line-height | Weight | Family |
   |---|---:|---:|---|
   | Active thread title | 20 / 26 | 600 | System sans |
   | Project label | 13 / 18 | 600 | System sans |
   | Session label | 14 / 20 | 400; selected 500 | System sans |
   | Plan heading | 14 / 20 | 600 | System sans |
   | Plan text / current outcome | 14 / 20 | 400 | System sans |
   | Counts and metadata | 12 / 16 | 400 | System sans |
   | Composer | 15 / 22 | 400 | System sans |
   | Event payload and timestamp | 12 / 18 | 400 | System monospace |

   Use platform system font stacks; verify actual rendering on all three platforms.

   | Geometry | Value |
   |---|---:|
   | Layout spacing set | **4, 8, 12, 16, 24, 32** |
   | Sidebar outer horizontal inset | 12 |
   | Sidebar row internal horizontal padding | 8 |
   | Project row pitch | 36 |
   | Session / collapsed finished-project pitch | 32 |
   | Session indentation relative to project label | 24 |
   | Gap between project groups | 12 |
   | Main-column side gutters | 24; reduce to 16 below 600px main-column width |
   | Title → plan gap | 16 |
   | Plan internal padding | 16 |
   | Plan → feed / feed → composer gap | 12 |
   | Composer internal padding | 12 vertical, 16 horizontal |
   | Log pitch | **18, unchanged** |

   Align the title, plan, log, and composer to the same outer content edges. Do not independently center them at different widths.

   Radius by surface: **sidebar selection 6px; buttons 8px; plan 10px; composer 12px; log 0px**. No decorative shadows or row borders.

   Sidebar session pitch is **1.78×** log pitch: a 576px region holds 18 session rows versus 32 log rows, excluding headers.

   This deliberately sacrifices sidebar capacity for easier targeting and scanning. Do not silently resolve that tradeoff by shrinking navigation back toward log density.

3. **Carry hierarchy through typography and grouping; use rules sparingly.**

   - **Title:** largest size and semibold weight.
   - **Projects:** semibold, with space above each group.
   - **Sessions:** regular weight; selection gets a background from the existing palette and weight 500.
   - **Plan:** one clearly dominant current action. Supporting steps remain regular weight.
   - **Log:** payload uses the stronger existing text grey; timestamp and token accounting use the weaker grey. Align timestamps in a fixed-width column using tabular numerals.
   - **State:** combine the existing state colour with a short label or shape. A dot alone cannot distinguish every state someone must act on.
   - **Separation:** one sidebar/main divider is enough. Add a rule elsewhere only when spacing cannot communicate the boundary.

   **Rule lines are the most commonly overused mechanism here.** Opacity is the next: dimming an entire inactive row also dims the information needed to select it. Use the supplied text greys directly.

   Keep log rows unwrapped and fixed-height. Reveal clipped details through selection or an explicit detail surface; never change row geometry.

4. **Keep motion restricted to feedback that does not move content.**

   | Interaction | Treatment |
   |---|---|
   | Sidebar hover background | 80ms, `cubic-bezier(0.2, 0, 0, 1)` |
   | Small contextual overlay, if present | 100ms opacity/2px translation on entry; 60ms opacity on exit; no delay |
   | Session selection and keyboard focus | Immediate |
   | Project expand/collapse | Immediate geometry change |
   | Plan expansion / composer resizing | Immediate geometry change |
   | Session switching / log insertion | No animation |
   | Jump to latest | Immediate; no smooth scrolling through accumulated history |

   Commit state and enable controls immediately; never wait for a transition to finish. Under `prefers-reduced-motion`, remove these transitions.

   Avoid animated heights, staggered children, crossfades between threads, pulsing running dots, and `transition: all`. They either move targets, obscure state, or keep attracting attention after the user has understood it.

5. **You will probably improve the containers while leaving the information hierarchy unchanged.**

   The manifestation: rounded surfaces and better spacing, but "tool Bash done" still dominates while the user searches for what the agent is accomplishing or what needs approval.

   Make the pinned plan answer, immediately: **current outcome, current action, and anything waiting on the user**. Keep those above the technical stream and express them in plain language.

   Test the result with ten populated sessions: can someone identify which session needs intervention and what it needs within three seconds?

   There is a real constraint conflict: if timestamped machine events remain the dominant reading material, the application will continue to read as a diagnostic tool. Typography and radii can improve that tool substantially; they cannot make its content conversational.

### 7.2 grok fast

**Prompt A — architecture and performance**

#### 1. Where are we wrong?
The ~100 ms custom URL scheme + brotli attribution is the weakest link you already flagged; it is almost certainly overstated. Elimination is not measurement. WebView construction (~100 ms) + scheme registration + decompression + React hydration + first paint are concurrent and overlapping; the residual is not cleanly additive. Measure with Instruments (Time Profiler + System Trace) or `os_signpost`/`tracy` markers around the exact points: scheme handler entry/exit, brotli decode start/end, webview `didFinish`/`load` events, and React root commit. On M4 Pro the scheme handler itself is rarely the dominant 100 ms slice once the webview is already spinning up.

Second weak inference: "cost per step is flat at step 400 as at step 4" because context windows are rented and thrown away. This only holds if the *harness* itself never accumulates unbounded state that the model later sees, and if every decision truly starts from a clean slate with identical prompt size. In practice the durable plan/progress/diffs/git state still has to be serialized into the rented window each turn. As sessions lengthen, that serialization cost and the size of the "current state" blob grow; the model's context may be flat, but the harness-to-CLI payload is not. Measure actual bytes shipped on the stdio control protocol and wall-clock time from "decision requested" to "CLI ready for input" at step 4 vs step 400 under a realistic growing plan.

Third: the SQLite tail numbers (sub-millisecond even at 1 M rows) are true for pure reads, but they do not capture the write path under concurrent sessions. The interesting metric is lock wait time and WAL checkpoint cost when multiple sessions are appending events while the UI is also reading. Tail latency under pure load is almost irrelevant.

Fourth: "harness-spawned child processes beat in-agent subagent fan-out" on tokens and wall time is directionally useful but the sample (N=3) and the dominant "per-completion wake-up tax" claim need isolation. The tax may be in the coordinator's event loop, not inherent to subagents. Measure the same workload with the coordinator instrumented for time spent in process supervision vs message serialization vs waiting on the model.

#### 2. What breaks at 10 concurrent sessions across 3 projects?
Process table and file-descriptor pressure hit first. Each CLI child + its own worktree + pipes + any temporary files quickly multiplies. On macOS the default soft limit is still modest; 10 sessions with realistic tool use (git, file watchers, language servers the agents may start) will start exhausting FDs or hitting `kern.maxproc` long before SQLite or the webview main thread saturates. Expect the first hard failures in the 8–12 session range when agents are actively running tools, not idle.

Next is IPC serialization and the Rust event loop. Every status update, tool call, approval, and progress tick crosses the stdio boundary and must be demuxed, stored, and pushed to the UI. At 10 sessions with chatty agents the main-thread (or the single Tokio runtime that owns the UI bridge) will spend measurable time just marshaling. SQLite write contention appears later: WAL mode helps, but concurrent appends from 10 writers plus a reader that is virtualizing the active feed will produce lock waits that the single-session numbers never showed.

Webview main-thread pressure is secondary on M4 Pro for the virtualized feed itself (you already measured 60 Hz), but the moment you start pushing high-frequency status updates for all 10 sessions into the React tree (even if most are filtered), the bridge cost shows up. Process supervision (reaping, signal handling, zombie cleanup) becomes noisy but is rarely the first hard failure.

Concrete prediction: at N≈8–10 active sessions the first observable breakage is either "too many open files" or multi-hundred-millisecond stalls in the event feed while the Rust side is busy demuxing.

#### 3. The 1,981 ms spawn cost
Prefer a warm pool of pre-spawned children over "one child serves several turns."

A warm pool (keep 1–2 idle CLIs ready per project or globally, with the control protocol already negotiated) removes the cold start from the critical path of a new turn or new session. Failure mode: the pre-spawned process has drifted — environment variables, cwd, git state, or the agent's internal caches no longer match the session it is about to be assigned. You pay a correctness tax in the form of subtle non-determinism or "it worked when I tested it cold." Mitigation is aggressive reset protocols (clear state, re-inject the exact worktree and goal) and a short TTL so the pool does not go stale. The cost is memory and a small background CPU footprint, plus the complexity of the pool manager.

Letting one long-lived child serve multiple turns re-introduces the exact problem the architecture was designed to avoid: a growing context window, accumulating hidden state inside the CLI process, and non-flat cost. The failure mode is worse for correctness — the "rented and thrown away" invariant is broken — and the latency win is smaller than a properly managed warm pool once the child has already paid its first-token tax.

Warm pool is the lesser evil and preserves the core cost model.

#### 4. What did we not measure that matters?
End-to-end latency from "user types in the composer and hits enter" to "first token of the agent's response appears in the virtualized feed," under concurrent load and with a realistic growing plan/diff set. None of the isolated numbers (spawn, FCP, SQLite tail, event-feed FPS) capture the full pipeline: UI → Rust → CLI spawn or reuse → prompt assembly (including the durable state) → model → streaming back through the control protocol → SQLite append → React virtual list update. That number is what users actually feel, and it is the one that will degrade non-linearly at 5–10 sessions when serialization, lock contention, and process scheduling all compound. Measure it with a synthetic workload that grows the plan and the event history, not with isolated micro-benchmarks.

---

**Prompt B — design direction**

#### 1. What specifically makes a dense desktop UI read as dated?
Ranked by cost:

- Uniform type size + weight across an entire column (every row 14 px / regular). Hierarchy collapses; the eye has nothing to latch onto.
- Insufficient vertical rhythm / consistent but too-large gaps. Everything floats at the same density; the layout feels sparse and "listy" rather than information-dense.
- Over-rounded or inconsistently rounded corners (large radii on small surfaces, or every surface the same radius). Looks either toy-like or like a 2015 Material card.
- Heavy or double rule lines / borders used as the primary separator instead of spacing + subtle weight change. Borders age faster than whitespace.
- Monospace used for everything that is not a true code log. Timestamps and status labels in mono make the whole column feel terminal-emulation rather than a modern tool.
- Fixed, large padding inside interactive elements (composer, plan card) that does not scale with the denser log.

The uniform-weight flat list is the single highest-cost item; the rest amplify it.

#### 2. Concrete numbers
Type scale (system UI font, not mono except the log):

- Sidebar project title: 13 px / 600
- Sidebar session name: 12 px / 500
- Sidebar meta (counts, status): 11 px / 400, 70 % opacity
- Log event text: 12 px / 400 mono, 18 px row height (already fixed)
- Log timestamp: 11 px / 400 mono, 55 % opacity
- Plan card title: 13 px / 600
- Plan card body: 12 px / 400
- Composer input: 13 px / 400
- Section labels / "Running" pills: 11 px / 500 uppercase, tracking +0.02 em

Vertical rhythm base unit: 4 px.
Sidebar row height: 28 px (project) / 24 px (session).
Log remains 18 px.
Plan card internal padding: 12 px horizontal, 10 px vertical.
Composer: 12 px padding, 8 px gap to the log above.
Sidebar left/right padding: 12 px; nested session indent: 16 px.

Radii:
- Sidebar items / small controls: 4 px
- Plan card / composer container: 6 px
- Pills / status dots: 999 px (full)

Density target: sidebar ≈ 1.4–1.6× denser than the log (more items per vertical inch). Log stays sparse enough to scan; sidebar should feel packed but not cramped.

#### 3. Hierarchy without colour
Primary carriers, in order of usefulness here:

1. Weight (600 vs 400/500) — use sparingly for titles and active session.
2. Size (13 → 12 → 11) — the main ladder.
3. Opacity (100 % → 70 % → 55 %) — for meta, timestamps, finished items.
4. Indentation + left accent bar (1–2 px orange or green) for the active session only.
5. Spacing (tighter groups, larger gaps between projects).

Most often overused: opacity. Once you drop below ~55 % the text becomes hard to scan in a dense list; people then compensate by increasing size or adding rules, which undoes the density. Prefer weight + size first, opacity only for truly secondary data.

Rule lines: almost never. Prefer a 1 px hairline at 8–10 % white only between major sections (projects), never between every session.

#### 4. Motion
Worth having (respect `prefers-reduced-motion`):

- Sidebar expand/collapse of a project: 120–150 ms, ease-out.
- Active session highlight (left bar + background) fade-in: 80–100 ms, ease.
- Plan card appearance / update: 100 ms opacity + 4 px translateY, ease-out.
- Composer focus ring: 60 ms.

Avoid or kill:

- Any per-row animation or staggered reveal in the virtualized log.
- Layout shifts when the plan card grows (animate height only if the change is < 40 px; otherwise snap).
- Hover transitions longer than 80 ms on dense lists — they make the UI feel laggy under mouse travel.
- Spring or bounce easings; they read as mobile/web, not desktop tool.

Desktop polish is short, purposeful, and never in the way of the next click. Anything that delays the perception of the click itself is net negative.

#### 5. The one thing you will get wrong
Over-tightening the sidebar density while leaving the log and plan card at "comfortable" spacing. The result is a jarring density mismatch: the left column feels modern and packed, the right column still feels like a 1999 terminal log with too much air. Because the log row height is locked, the only levers left are type size, opacity, and the plan-card/composer padding. People usually under-adjust those, so the whole right column never catches up to the sidebar's density and the app continues to feel uneven and dated.

### 7.3 Google AI Mode (a single search)

Note: this answered a stack question the brief did not ask ("what is the best stack for building a super performant ai harness for macos, windows, linux ...") and contains no measurement. Reproduced as pasted, formatting lost in the copy.

AI Mode conversation: what is the best stack for building a super performant ai harness for macos, windows, linux. This harness should be very performant, not eat up user's machine, and it should be able to handle multiple claude/codex/or other ai cli sessions simultaneously and should be able to handle smoothly and performantly multiple projects a user works on at a timeYou said: what is the best stack for building a super performant ai harness for macos, windows, linux. This harness should be very performant, not eat up user's machine, and it should be able to handle multiple claude/codex/or other ai cli sessions simultaneously and should be able to handle smoothly and performantly multiple projects a user works on at a timewhat is the best stack for building a super performant ai harness for macos, windows, linux. This harness should be very performant, not eat up user's machine, and it should be able to handle multiple claude/codex/or other ai cli sessions simultaneously and should be able to handle smoothly and performantly multiple projects a user works on at a timeTo build a cross-platform, ultra-performant AI harness that manages multiple concurrent CLI sessions and large codebases without draining system resources, your primary focus must be low memory overhead, non-blocking I/O, and native execution.The absolute best stack for this use case pairs Rust for the core engine with a light, native-rendered frontend like Tauri or Flutter, or running it purely as a optimized headless daemon.🏛️ The Core Engine: RustRust is the definitive choice for the backbone of this harness.Zero-Cost Abstractions & No GC: Unlike Node.js or Python, Rust has no garbage collector. It won't suffer from memory spikes or random latency hikes when managing massive context windows or file trees.Fearless Concurrency: Rust's ownership model guarantees thread safety. Handling dozens of concurrent streaming connections to Claude, OpenAI, or local runners (via llama.cpp) won't result in race conditions or memory leaks.Async Network I/O: Using Tokio, you can handle thousands of concurrent asynchronous network requests (streaming LLM tokens) on a single thread pool with negligible CPU utilization.🖥️ The User Interface (If Needed)If your harness requires a GUI alongside a CLI, do not use Electron. Electron bundles Chromium, which will easily eat up 500MB–1GB of RAM per project window.Option A: Tauri (Rust + Webview). Tauri uses the OS's native webview (WebKit on Mac, WebView2 on Windows, WebKitGTK on Linux). The binary size is tiny (~10-20MB), and the idle memory footprint sits around 30-50MB.Option B: Flutter (Dart/Native). Flutter compiles directly to native C/C++ machine code and renders via Impeller/Skia. It bypasses web architectures entirely, offering highly responsive 60fps+ timeline rendering for streaming text across multiple windows.Option C: Pure Terminal (Ratatui). If the harness is strictly a terminal workspace, use the Ratatui crate in Rust to build a gorgeous, incredibly fast TUI (Terminal User Interface).🗄️ State & Large Context ManagementSimultaneously managing multiple active coding projects means indexing massive file trees and caching large LLM prompts.File System Operations: Use notify (Rust) for zero-overhead, asynchronous file-watching to see code changes across projects instantly without polling the disk.Embedded Storage: SQLite (via rusqlite) or RocksDB. SQLite is perfect for storing project metadata, user prompts, and conversation histories. It operates in-memory or via light local files without running a heavy background database server.Context Caching & Embedding Storage: LanceDB or Qdrant (embedded mode). If your harness performs RAG (Retrieval-Augmented Generation) across the user's projects, LanceDB is an ultra-fast, serverless vector database built in Rust that can query code embeddings directly from local disk space.📊 How the Top Architectures Stack UpLayerThe Ultimate Stack (Best)The Web-Forward AlternativeWhy It Beats the RestBackend CoreRust (tokio + reqwest)Go (goroutines)Rust provides tighter memory control than Go and has zero GC pauses.Frontend/UITauri or Ratatui (TUI)React + Electron (Avoid)Tauri saves gigabytes of RAM by using native OS webviews instead of Chromium.DatabaseSQLite + LanceDBPostgreSQL (Local)Embedded DBs eliminate the CPU/RAM overhead of running a separate background database service.IPC LayerRust Channels / Protocol BufferstRPC / WebSocketsDirect memory channels or binary serialization reduce CPU serialization overhead to near zero.⚡ Architectural Strategies for Peak PerformanceMultiplexing Streams: Use HTTP/2 or HTTP/3 connection pooling via Rust's reqwest client. This allows dozens of concurrent streaming sessions to Claude or OpenAI to share a single, long-lived TCP connection, reducing TLS handshake overhead.Backpressure Controls: Implement token bucket rate-limiting natively in your async runtime. If a user triggers actions across 5 projects at once, the harness should gracefully throttle and queue API calls to prevent local UI stuttering or hitting remote rate limits.Lazy Project Loading: Keep project trees serialized on disk using protocol buffers or flatbuffers. Only load a project's full context and file index into RAM when that specific project tab/session becomes active.

### 7.4 claude-opus-5, high effort

#### brigadier — architecture review and design direction

---

#### Part A — Architecture and performance

#### 1. Where you're wrong

**The SQLite result is measuring a tautology.** A descending index scan with a LIMIT is invariant to table size by construction; you proved the B-tree works. It says nothing about the number that will actually hurt you, which is read latency *while ten writers are inserting and a WAL checkpoint is running*, on a cold page cache. Both of your figures are RAM numbers on a quiescent file. Falsifiable claim: your p99.9 tail-query latency under ten concurrent writers is two to three orders of magnitude worse than your quiet-state number, and it will arrive in bursts that correlate exactly with the moments the UI is busiest. Measure: loop the tail query while ten writers insert at your real event rate in WAL mode, report the full distribution including checkpoint moments, count busy-handler retries, and drop the file from cache before the first read. Separately, measure query→*painted row*, not query — if diffs and full tool payloads live in the same table, the index scan is fast precisely because it never touches the overflow pages that the render path does.

**"React costs ~12 ms" is a mount measurement generalised into a runtime claim.** It tells you what an empty shell costs to boot. It predicts nothing about steady state, and the 60 Hz feed result almost certainly came from one or two sessions. Falsifiable claim: at ten sessions the cost is not render, it is state-update frequency — the number of React commits per second and whatever re-renders the sidebar and plan card on every event. Measure commits/sec against events/sec, and count long tasks via `PerformanceObserver({entryTypes:['longtask']})` during a ten-session run. Any long task over 50 ms while the composer has focus means the feed being 60 Hz is cosmetic.

**The 60 Hz figure is the wrong statistic.** Sustained-fps-per-second is the metric specifically designed to hide jank: 60 fps average with one 180 ms frame every eight seconds reads as a pass and feels broken. Report frame *intervals* — p99 and max — and dropped-frame counts. Also, on an M4 Pro with ProMotion, if the webview is capped at 60 and you measured 60, you measured a cap, not headroom.

**N=3 with six-significant-figure token counts.** A 14% difference across three runs of a stochastic process is a direction, not a result — and the mechanism ("per-completion wake-up tax") is an inference layered on top. I think your conclusion is right. What's missing is the shape of the task where it *isn't*: when subtasks need each other's intermediate findings, your architecture pays to re-establish that from durable state on every step and the in-agent version gets it free. That's the price of your entire thesis and it isn't in the number. Measure five task shapes at N=5 — independent subtasks, heavily shared context, and one where a subtask fails and retries — and report the range, not the mean.

**The one I think is most misleading, more than the scheme-handler attribution: the launch budget itself.** Two problems compounding.

First, p50 over nineteen warm launches on the fastest consumer silicon Apple sells is not a launch measurement; nobody experiences p50, they experience the cold one — first launch after boot, after eviction, after Gatekeeper's first-run check, on Windows with WebView2 doing a runtime version check. Purge the file cache between launches and get numbers on the slowest machine you'd support; I'd bet the honest p50 there is over a second and the variance is what users actually complain about.

Second and worse: FCP of an empty shell is not the thing the user waits for. Their launch ends when sessions are visible and live — which includes opening SQLite, hydrating state, and re-attaching to or restarting children. If that's 900 ms, your 90 ms overage is noise and you have been optimising a number that doesn't appear in anyone's experience. Measure exec → *first frame with real session state rendered*, and set the budget on that. It may turn out the 200 ms target was never the right goal.

**On the scheme handler**, since "by elimination" isn't a measurement: don't A/B it, instrument it. Emit `os_signpost` (or plain monotonic timestamps) at exec, Tauri setup entry, webview created, first scheme-handler request received, handler responded, `DOMContentLoaded`, FCP. My prediction is that brotli is not the cost — 263 kB decompresses in single digits of milliseconds — and the cost is the *round trips*: `WKURLSchemeHandler` callbacks marshal onto the main thread, so three sequential requests for HTML, JS and CSS is three main-thread hops with parser-blocking in between. Test in ten minutes by inlining everything into a single HTML response. If the ~100 ms collapses, it was never compression.

**And the spawn number is an unbroken aggregate.** 1,981 ms contains fork/exec, runtime startup, bundle parse, config reads, possibly MCP server connections, possibly a network auth round trip, and the first token. If any of that is network, you've measured someone's Wi-Fi and it will be six seconds in a hotel. Break it down *before* building a mitigation — you may find 1,400 ms of it is one thing you can turn off.

#### 2. What breaks at 10 sessions across 3 projects

Not file descriptors. Thirty pipes plus SQLite plus the webview is nothing — though note the macOS soft `RLIMIT_NOFILE` for a Finder-launched GUI app is 256, not 10240, and worktree pack files plus per-worktree watchers close that gap faster than you'd expect. Raise it at startup and stop thinking about it.

#### First real failure, around N=4–6: the webview main thread, via IPC

Every event becomes serialize → postMessage → deserialize → setState, and each one is a separate JS task. Ten sessions emitting 20–50 events/sec during active tool use is 200–500 messages/sec. The feed is virtualized so *rendering* stays cheap; the state churn does not. The symptom isn't dramatic frame drops, it's a composer that lags behind typing and a sidebar that updates in visible steps — and nothing you've measured at N=2 would have caught it.

Fix it structurally, now, before the state shape hardens: **coalesce on the Rust side into one frame-aligned emit per window per ~16 ms**, containing all events across all sessions, and take one React update per frame regardless of N. That also caps you at N=50 instead of N=10.

Corollary: nothing large goes over the event channel. Diffs and big tool payloads should be a `GET` the frontend issues over the custom protocol, or you'll find multi-millisecond `JSON.parse` calls sitting on the main thread.

#### Second, N≈6–10: SQLite write contention

Not from throughput. WAL handles thousands of small inserts fine. What bites is ten connections each doing a transaction per event, serialising on the write lock with `SQLITE_BUSY` retries; and WAL growth during a burst that can never checkpoint because there is always an open reader. That's how your 0.14 ms read becomes a 40 ms read against a 200 MB WAL.

Fix: one writer task owns the connection, everyone else sends over an mpsc channel, batch into transactions of ~50 events or 20 ms whichever comes first, `synchronous=NORMAL`, and audit for long-lived read transactions — those are what block checkpointing. Log the return of `PRAGMA wal_checkpoint(PASSIVE)` so you can see when you're failing to checkpoint rather than inferring it later.

#### Third, N≈8–12: memory and orphan supervision

Ten Node children at 50–80 MB baseline, more once each has real work, plus everything *they* spawn (ripgrep, git, a dev server an agent decided to start). On a 16 GB machine with an editor open you're in swap at N=10, and swap on the main thread is how a 60 Hz feed becomes a slideshow.

Then: does `kill -9` on the app kill the children? On macOS you don't get that for free. If you don't put children in a process group and kill it, or give them a watchdog pipe to poll, you leave ten orphaned Node processes running after quit. That's the bug users report as "brigadier makes my fan spin after I close it." Test it today — it takes one `ps`.

#### Fourth — a correctness failure, not a performance one: git

One worktree per session prevents file collisions, not `.git` collisions. All worktrees of a repo share one object database and one ref namespace.

Falsifiable claim: **at three or four concurrent sessions in the same project you will get intermittent `fatal: Unable to create '.../packed-refs.lock': File exists`, and it will present as a random flake nobody can reproduce.** Worse, auto-`gc` fires on commit thresholds in any one worktree, locks the object store, and can prune objects another worktree's in-flight operation needs.

Fix: a Rust-side mutex keyed by gitdir serialising all git *write* operations per repository, `gc.auto=0` in the worktrees with your own gc when idle, and retry-with-backoff around ref updates. Also price the disk: ten worktrees of a 2 GB monorepo is 20 GB. I'd question whether the right granularity is per-session rather than per-project-run.

#### Fifth, Linux only: watchers

If you watch worktrees to drive the diff view, ten trees can exceed `max_user_watches` (8192 default on several distros, and it's per-directory), at which point watching silently stops working — no error, just staleness. And on macOS, an agent running `npm install` in its worktree is a firehose. Ask git instead of watching, where you can.

#### 3. The 1,981 ms spawn

Reuse the child. But bound it in a specific way, and check one thing first that may make the whole argument moot.

#### The warm pool is the wrong one, and not for cost reasons

A pre-spawned child isn't warm in the sense you need. If a meaningful share of that 1,981 ms is project context — cwd, config, credentials, whatever the CLI reads at startup — then a pool member spawned before you know its project can't do that work, and you've saved only the process-launch fraction. To fix that the pool becomes per-project, so three projects at depth two is six idle Node processes at ~60 MB permanently resident, paid whether or not the user runs anything, on a machine that (per §2) is already the constrained resource.

Pool members also go stale: config changed, credentials rotated, the CLI self-updated, and you can't tell without paying to check.

And the failure mode is the ugly kind — pool exhaustion under burst gives you **bimodal latency**, where steps 1–2 are instant and 3–10 pay full price. Users tolerate uniformly slow much better than unpredictable.

Reuse is the only mitigation whose benefit scales with phase length, which is exactly where the pain is: a ten-step phase pays one spawn instead of ten.

#### The correctness costs of reuse, named precisely

1. **Context bleed, and it breaks your audit story.** Your durable record asserts "given plan P and progress R, the model decided D." With a reused child that is false — it decided D given P, R, *and* everything else in the window. If you ever debug a bad decision by replaying from durable state, you will not reproduce it. This is the real cost.
2. **Cost stops being flat.** Step 4 and step 40 in the same child cost different amounts, and the difference depends on how chatty the tools were. You lose the property you're selling.
3. **Poisoning.** A tool that returned 200 kB of garbage, or a model that went down a wrong path, stays in the window and degrades every subsequent turn that child serves. Spawn-per-turn isolates bad turns by construction; that's a real quality property you'd be trading away, not a theoretical one.
4. **Blast radius.** A child that dies takes k turns' worth of assumed state with it, so the reuse path must be provably equivalent to the fresh path — otherwise you have two code paths and only test one.

#### The version that costs nothing: reuse the process, reset the context

If the CLI's control protocol lets you start a fresh conversation inside a live child — clear history, keep the process, runtime, config and auth — then every objection above disappears, because turn k still begins from exactly the durable state the harness supplies. Find out whether the protocol supports that before you build anything; if it does, this isn't a trade-off, and if it doesn't, that's the feature request worth filing upstream.

Absent that: reuse with a hard cap of k ≤ 3–5, plus a mandatory fresh spawn at every phase boundary, every error, and every turn whose predecessor produced output above some size threshold. And in debug builds, have the harness assert that a reused turn's inputs match what a fresh turn would have received, so drift is caught by a test rather than by a user.

**The measurement that settles it:** run the same twenty-step phase five times fresh and five times reused, from identical durable state, and **diff the decisions**. If reuse changes decisions, you've bought milliseconds with correctness and you should know the exchange rate. If it doesn't, the worry is theoretical and you cap at k=10.

#### 4. What you didn't measure

#### The sharpest one, checkable within an hour: prompt caching

Renting a fresh window per decision means you re-send goal, plan, progress and context every step, uncached — and cache hits require a *byte-stable prefix*. If the harness reconstructs the prompt with a progress log that grows and a plan that gets revised, your cache hit rate is approximately zero, while the long-lived session you're comparing against gets near-100% prefix hits and pays a tenth as much for the same input tokens.

Falsifiable claim: **your input tokens per step are growing with plan and progress size even though your context window isn't, and your 14% token win over subagent fan-out reverses at some step count.**

Measure input tokens, cache-read tokens and cache-write tokens per step at step 4, 40 and 400. If cache reads are near zero, "flat cost at step 400" is false as stated. The fix is architectural, not a tuning knob: prefix-stable prompt construction — immutable header, append-only progress, cache breakpoints at stable boundaries — and it is far cheaper to design in now than to retrofit after the state serialisation hardens.

#### The deepest one, and the one that could falsify the whole design

You have measured cost per step and never measured steps to completion.

Your thesis is a compression claim — that full history compresses into (goal, plan, progress, relevant diffs) with no loss that matters. At step 4 that's obviously true. At step 400 the plan has been revised eleven times, progress is a summary of summaries, and the thing the model needed was in step 37's tool output that nobody kept.

It will not look like a bug. Every individual step stays fast, cheap, and correct-looking. What happens is that the agent redoes work it already did, re-litigates decisions already made, or quietly contradicts an earlier choice — and the phase takes 900 steps instead of 400. Flat cost per step is then real and irrelevant.

Measure outcomes, not throughput: take ten real multi-step tasks of varying length, run each to completion or a step budget, and record steps-to-completion, redundant-work rate (turns whose diff is empty or reverts a prior turn), and decision-contradiction count. Then run the same tasks with a long-lived session as the control, eat its cost, and compare *end states*. If the harness needs 1.6× the steps to get there, your token savings are negative and the state-reconstruction layer — not the spawn cost, not the scheme handler — is the only thing worth working on.

Everything else on your list is an optimisation inside an assumption. That's the experiment that tests the assumption.

---

#### Part B — Design direction

#### 1. What makes a dense desktop UI read as dated, ranked by cost

1. **No grouping — every row identical in height, weight and colour.** 1999 apps rendered lists literally: uniform rows, separated by a hairline or alternating stripes. Modern dense UIs make the *group* the unit. "tool Bash start / tool Bash done / turn done" is one thought; if all three get identical treatment the eye has no entry point and has to read linearly. Biggest single cost, by a distance.
2. **Borders doing work that spacing should do.** The tell is `1px solid` around every container. Replace each one with 8–12 px of padding plus a 3–4% lightness step in the background; at that delta a dark surface reads as a distinct plane without a line.
3. **One spacing constant everywhere.** If the gap between a label and its value equals the gap between two unrelated sections, proximity — the cheapest grouping signal in existence, and free — is doing nothing.
4. **Baselines off-grid and line-heights mixed.** Sidebar rows at 28, log rows at 18, plan-card text at 1.5 × 13 = 19.5 → nothing aligns across columns and the whole thing reads as assembled rather than designed. You fixed this inside the log; the rest of the app almost certainly hasn't.
5. **Type crimes:** system font at 14/400 for literally everything; the OS default mono (Menlo/Consolas) rather than a modern face; letter-spacing untouched at every size; and specifically — no `tabular-nums`, so "915 in / 2113 out" jitters horizontally on every update. Jitter reads as cheap.
6. **Chrome that announces itself:** always-visible scrollbars, 1px or dotted focus rings, disabled state done as `color: grey` rather than opacity, hover states that move the background four steps instead of one, and hover affordances on things that aren't interactive.
7. **Uniform radii.** Everything 0 or everything 4. Radius should scale with surface size; a 6px radius on a 400px card and the same 6px on a 20px chip look wrong together in a way people feel but don't name.
8. **Icons at the wrong optical weight** — 1px strokes beside 500-weight text — and worst of all, unicode glyphs standing in for icons (▶ ● ✓). That one is a very strong date stamp.
9. **Motion absent entirely, or linear and 300 ms+.**

#### 2. Numbers

#### Type

Base is 13, not 14. Dense desktop wants 13.

| token | size / line-height | weight | tracking | use |
|---|---|---|---|---|
| `--text-2xs` | 10 / 14 | 500 | +0.04em, uppercase | sidebar section labels only |
| `--text-xs` | 11 / 16 | 400 | 0 | timestamps, token counts, meta |
| `--text-sm` | 12 / 18 | 400 | 0 | log rows (mono) |
| `--text-base` | 13 / 18 | 400 | 0 | session names, composer, body |
| `--text-md` | 14 / 20 | 500 | 0 | project names, plan-card body |
| `--text-lg` | 16 / 22 | 600 | −0.01em | plan-card title — the one heading |

Three weights total: 400, 500, 600. Never 700 at these sizes in dark — it blooms and fills counters. Negative tracking above 15px, positive below 11, zero between.

Mono stack: `ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace`, with `font-variant-numeric: tabular-nums` and `font-feature-settings: "calt" 0` (kill ligatures in a log).

**Important and non-obvious:** mono at 12px optically reads a step larger than sans at 12px — wider advance, taller x-height in most mono faces. So the sans around your 12px log wants to be 13px to feel like a peer. Matching the numbers is what makes them look mismatched.

#### Spacing set

Deliberately gappy so adjacent steps are distinguishable: `2, 4, 6, 8, 12, 16, 24, 32`.

| px | use |
|---|---|
| 2 | optical nudge between a glyph and its label |
| 4 | inside a chip, vertically |
| 6 | status dot to text; horizontal padding of small inline elements |
| 8 | **default gap between related items in a group** |
| 12 | padding inside surfaces (plan card, composer) |
| 16 | gap *between* groups; sidebar horizontal padding |
| 24 | between major regions (plan card ↔ log ↔ composer) |
| 32 | page level, used roughly once |

The rule that does the actual work: **gap between groups ≥ 2× gap within a group.** 8 inside, 16 between. Obey nothing else and obey this.

#### Vertical rhythm

Everything snaps to 2; row-ish elements snap to 4.

- **Log row:** 18px pitch, 12/18 text, zero padding — line box *is* the row. Already right.
- **Sidebar session row: 28px** (13/18 text, 5px padding top and bottom). Not 26 — 26 doesn't snap.
- **Sidebar project row: 32px.** Taller than its children; that height difference is a free hierarchy signal.
- **Composer:** 12px padding, min-height 72px, 13/18.
- **Plan card:** 12px 16px padding; title 16/22, body 14/20; **cap its height and scroll internally** — it must never push the log.

#### Density

Sidebar at 28/32 with 16 between project blocks gives ~24 rows in 800px. Log at 18 gives ~44.

**The ratio between them — roughly 1.55 — is the most important number in this entire section.** If the sidebar is as dense as the log, both read as data dumps and neither reads as navigation.

#### Radii by surface class

- **0** — anything full-bleed or touching a window edge: the sidebar itself, the log viewport, dividers. Rounding these is the opposite tell — it makes a native app look like a web page.
- **4** — small interactive elements: sidebar row hover, chips, badges, buttons under 28px.
- **6** — buttons ≥28px, inputs, the composer.
- **8** — surfaces sitting on a different plane: the plan card.
- **10–12** — modals and popovers only.

Concentric nesting: inner = outer − padding, floored at 2. Apply that only when elements are genuinely concentric; otherwise use the class value.

#### Background ladder

Substitute your measured values; the intervals are the point.

| step | value | use |
|---|---|---|
| L0 | `#181818` | app background, log viewport |
| L1 | `#1f1f1f` | sidebar |
| L2 | `#242424` | raised surfaces (plan card, composer) |
| L3 | `#2c2d2d` | hover |
| L4 | `#3a3b3b` | active / selected |
| — | `#494a4b` | tertiary text; the one visible border you're allowed |

**Hover is exactly one step. Selected is exactly two.** Not one step plus a border.

Rules, when you must: `rgba(255,255,255,0.06)` for a within-region separator, `0.10` for the structural sidebar↔main divider. Never both inside one visual unit.

#### 3. Hierarchy without colour

Where the work comes from, weighted:

- **Spacing / proximity — ~40%.** Grouping by gap, costing nothing. This is the thing your build is missing and the thing that will change it most.
- **Size — ~25%.** The 28-vs-18 row ratio; 16 vs 13 for title vs body. Size differences must be ≥2px to register at all here — a 13/14 distinction is invisible and you've spent a token for nothing.
- **Weight — ~15%,** only as 400 / 500 / 600. 500 means "this is a name" (project, session, tool). 600 appears exactly once per region.
- **Luminance — ~15%.** Three text levels, not four. Set them as literal greys, never as `opacity` on the element — opacity fades a container's background along with its children and gives you muddy composites.
- **Indentation — ~5%.** One level, 12px, sidebar only. Never indent the log.
- **Rule lines — ~5%, and this is the one that gets overused, by a wide margin.** In a monochrome dark palette the instinct is to reach for a hairline every time you need a boundary, and the result is a grid of boxes — precisely the 1999 look you're escaping. Budget: **at most two rule lines visible at rest.** The sidebar divider and the composer's top edge. Everything else is spacing and background.

#### Applied

- **Sidebar:** project 14/500 in a 32px row; session 13/400 in a 28px row indented 12px. No rule between them. Disclosure is a 6px inline-SVG triangle rotated 90° on expand — not a boxed chevron.
- **Running dot on a collapsed project:** 6px circle, orange, in the row's right gutter at 8px inset. One dot for the project, not one per session.
- **Finished project collapsed to one line:** same 32px row, count in `--text-xs` tertiary, right-aligned, tabular.
- **Log row internals — three fixed columns.** Timestamp in tertiary grey at a fixed `8ch`; 8px gap; a `5ch` kind column (`tool`, `turn`, `appr`) in secondary; 8px gap; payload in primary. **Cross-row alignment is itself a hierarchy signal**, and it's exactly what a flat uniform list throws away.
- **State colour:** green and red go on a 6px dot or a 2px left edge, never on the text. Coloured text in a dense mono feed costs legibility and reads as a 2003 terminal.
- **Selected session:** L4 background + 2px orange left edge + weight 500. Three signals is right for the single most important state in the app.

#### Two of these conflict — stated, not resolved

**"At most two rule lines" fights "group runs of log rows,"** because with a fixed row pitch the only way to make a gap is to spend a row on it.

- **(a)** Insert an empty 18px spacer row — virtualization stays trivial, costs ~5% of visible scrollback.
- **(b)** Put a hairline top-border on the first row of a group — free in layout, but it breaks the rule-line budget.

I'd take (a), because a hairline every three or four rows in a mono feed *is* the 1999 grid. (b) is defensible if scrollback density matters more to you; if you take it, alpha ≤ 0.06 and inset it to start at the payload column rather than full-bleed.

**Second conflict, smaller:** fixed row pitch rules out group *labels* ("Bash — 3 events"), since a label wants to be smaller and shorter than a row. So don't have them. Groups are defined by spacing and by the first row's content, full stop.

#### 4. Motion

#### Worth having

- **Hover on interactive rows.** The trick worth knowing: light instantly, fade slowly. `transition: background-color 60ms ease-out` on the base rule, overridden to `0ms` in `:hover`. It's the most expensive-feeling motion available to you and it costs nothing.
- **Sidebar project expand/collapse:** `grid-template-rows: 0fr → 1fr`, 140ms `cubic-bezier(0.2, 0, 0, 1)`. Height-auto animation with no JS. This is the one place a transition genuinely earns its keep — it explains where rows came from. Skip it above ~15 children; animating twenty rows in is worse than a cut.
- **Plan card content swap** when the plan is revised: 120ms opacity crossfade. Worth it because the change is otherwise invisible and people will miss it.
- **Composer enabled/disabled:** `opacity 100ms ease-out`. Nothing else.
- **Focus ring:** 0ms, always. Never animate focus.
- **New log rows:** nothing. Correct as specified.
- **Scroll-to-latest:** instant if already pinned to bottom; `smooth` only for jumps under ~2 viewports, instant beyond.

Duration set: **60** (state echo), **120** (small), **180** (layout). Nothing above 200ms anywhere in this app.

Easings: `cubic-bezier(0.2, 0, 0, 1)` for entering/expanding, `ease-out` for opacity, `linear` under 80ms because the curve is unobservable and you shouldn't pay for it.

#### What makes a desktop app feel slow rather than polished

- **Any transition on a state the user just caused.** Click a session, panel crossfades 200ms → the app is 200ms slower than it was. Direct manipulation is instant, always. This is offender number one.
- **Staggered entrances.** Rows animating in at 30ms intervals is the single strongest "this is a website" signal and it directly delays readability.
- **Transitioning anything that lays out** — height, width, top, left. Only `transform`, `opacity`, and grudgingly `background-color`. The `grid-template-rows` trick is a layout animation but a contained one; measure it with ten sessions running and drop it if it costs frames.
- **Skeletons and shimmer.** They exist for network-bound web apps; here they announce that a local operation is slow.
- **Spinners for work under ~400ms.** A spinner that appears and vanishes reads as a stutter.
- **Overshoot easings** — spring, back, bounce. One use dates the whole app to a different but equally specific year.
- **Hover transitions ≥150ms.** The pointer outruns them and you get trails.

`prefers-reduced-motion`: kill all of it via the standard global override. One caveat I'll flag rather than decide for you — killing the 60ms hover fade produces a visible strobe on fast pointer travel, and 60ms is arguably below the threshold the media query is meant to address. Keeping it is a defensible reading; honouring the query literally and eating the strobe is the safer one. Be deliberate rather than defaulting.

#### 5. The one thing you'll get wrong

You will implement the type scale, the spacing set and the radii — those are lists, and lists get built — and you will **not** change the density ratio between the sidebar and the log, because both are individually defensible and nothing in a checklist tells you they're wrong *together*.

How it manifests: the app looks measurably better and still feels like a tool rather than a product, and you won't be able to say why. The specific symptom is that the eye never rests — the window is uniformly dense edge to edge, so there's no entry point and nowhere to land. You'll suspect the palette (it's fine) or the font (it's fine), and you'll try adding a rule line or a border to "separate the columns," which pushes it back toward exactly the thing you were escaping.

**The check**, and it's the only cheap way to see what you're blind to: screenshot the app, apply an 8px Gaussian blur, look at it. You should see three distinct textures — a lighter, coarser sidebar; a fine-grained log; and quieter blocks top and bottom. If the blurred image is uniform grey noise across the whole window, the ratio is wrong no matter how correct every individual number is. Run it before and after.

**A close second, because it's the one that will actually ship: you'll overuse the orange.** With a near-monochrome palette a single accent is enormously tempting, and every additional use steals meaning from every other. Budget it: **at most two instances of orange on screen at rest** — the selected session, and running state. Not the send button, not links, not the plan card's border, and not focus rings (use white at 0.4 alpha). The moment orange is on the send button *and* the selected row *and* the running dots, it stops meaning "here" and becomes decoration, and you've spent your only colour-based hierarchy signal on nothing.

### 7.5 gemini-3.1-pro

#### Architecture and Performance

**1. Where the measurements mislead**
Attributing ~100 ms to the custom URL scheme and brotli decompression by elimination is a blind spot. In Tauri, passing a 263 kB asset through the IPC layer often incurs a serialization/deserialization penalty that dwarfs the actual decompression. You are likely measuring the framework's internal bridging overhead, not the scheme handler's execution.
*What to measure instead:* Serve the exact same bundle over a local HTTP server (`localhost:port`) bypassing the custom scheme entirely, and measure the delta to FCP. If the FCP remains identical, your scheme handler is innocent and the bottleneck is React hydration or Tauri's window initialization sequence.

**2. The concurrent breakdown threshold**
At 10 concurrent sessions, the Tauri IPC event bridge will choke the webview main thread long before you hit file descriptor limits or SQLite write contention. You are running 60 Hz virtualized updates. For 10 sessions, that is 600 IPC messages per second. Tauri serializes IPC payloads to JSON. The main thread will spend its entire budget deserializing those payloads and triggering React state updates, leading to dropped frames and severe input latency on the composer. You will feel this break at around N=5.
*The resource that goes first:* The macOS WindowServer and the webview's JS main thread.
*Mitigation:* You must debounce/batch IPC events on the Rust side before they cross the boundary, emitting arrays of events rather than single updates.

**3. The 1,981 ms spawn cost**
Let one child serve several turns. A warm pool is a trap for this specific architecture; it shifts the 2-second CPU penalty to the background, burning battery and stealing core time from the active agent while waiting for the user to do something.
*The failure mode of multi-turn:* Correctness through state leakage. The Claude CLI maintains hidden internal state—working directory, cached context, or previous command history. If one child serves multiple turns, a hallucinated directory change or failed state in turn 3 will silently corrupt turn 4. You trade latency for non-determinism. To mitigate, you must issue a strict working-directory reset and state-clear command at the start of every logical turn over `stdio`.

**4. The missing critical measurement**
You measured SQLite tail query times, but you did not measure SQLite write concurrency under sustained load. 10 concurrent agents blasting fine-grained `stdio` events means high-frequency, overlapping writes. Even in WAL mode, SQLite enforces a single concurrent writer. Without a dedicated Rust channel batching these logs into fewer, larger transactions, your async workers will block waiting for database locks. You measured a static 400-byte page and an isolated tail query; you missed the IO write-queue depth under multi-agent pressure.

---

#### Design Direction

**1. Mechanisms of a dated dense UI**
*   **Bounding boxes:** Using explicit 1px borders to define every container, panel, and row.
*   **System defaults:** Native scrollbars inside a custom-themed app.
*   **Flat typography:** Relying solely on size rather than weight to establish hierarchy.
*   **Cramped hit areas:** Padding that matches the text height (e.g., 14px text in a 20px box).
*   **Absolute blacks:** Using pure #000000 or un-tinted dark grays for backgrounds, which flattens depth.

**2. Concrete numbers for implementation**
*   **Type Scale:**
    *   Sidebar Projects: 13px, Medium weight (system font).
    *   Sidebar Counts/Metadata: 11px, Regular weight.
    *   Log Feed: 12px, Regular weight (monospace).
    *   Plan Card Title: 14px, Semibold weight.
*   **Rhythm & Spacing (4px baseline):**
    *   Sidebar items: 28px height (13px text + 7px top/bottom padding).
    *   Sidebar indent: 16px per nesting level.
    *   Panel Gap: 1px vertical rule line (#333333).
    *   Log padding: 16px left/right inside the feed container.
*   **Radii:** 6px for active sidebar items and the composer input. 8px for the pinned plan card. 4px for inner badges/counts.

**3. Hierarchy without colour**
Opacity and font weight carry the load.
*   **Primary text:** 100% opacity white (commands, active project names).
*   **Secondary text:** 70% opacity white (timestamps, inactive projects, standard log output).
*   **Tertiary text:** 40% opacity white (dividers, placeholder text).
*   **Overused:** Rule lines. Do not draw a horizontal line between the pinned plan card and the log feed. Use a 24px vertical gap and background contrast instead. Save the 1px lines strictly for resizable pane borders.

**4. Motion**
Motion in desktop utilities should be nearly invisible.
*   **Keep:** The sidebar project expand/collapse (150ms, ease-out). Status indicators (like a running dot or state pill) benefit from a crisp "pop in fadein" effect. However, ensure the removal animation smoothly contracts (100ms, ease-in) rather than instantly snapping out or glitching—the visual fluidity of these micro-components dictates perceived quality.
*   **Kill:** Any easing longer than 200ms. Hover state transitions (buttons should react in 0ms). Row-insertion animations in the log feed—they destroy the perception of terminal speed.

**5. The one thing you will get wrong**
Scrollbars. You will build a beautifully dense, virtualized log feed, but leave the native macOS/WebKit scrollbar active. In a dark, monochrome interface, a thick, default gray scroll track will ruin the spatial rhythm of the right edge. You must style `::-webkit-scrollbar` to be a 4px wide, semi-transparent track that only expands on hover, matching the #494a4b accent gray.
