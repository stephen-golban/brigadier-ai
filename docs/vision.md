# brigadier — the vision

> 2026-09-05 update: the owner requested a rich local chat composer, conversation widgets, and a workspace panel. This supersedes the older no-picker and terse-only UI guidance below. See [the implementation and remaining parity work](research/chat-workspace-implementation-2026-09-05.md) and [its IPC extension](plans/chat-workspace-ipc.md).


Settled with the owner on 2026-09-02. This file replaces `brigadier-guide.md`, which described an
installable CLI that no longer exists and was deleted the same day. It is recoverable from git
history at `2327bb9` if the reasoning behind a decision is ever needed; nothing in it is current.

Rules of this document: one line per fact, a path or a number instead of an adjective, every claim
tagged **[measured]** (run on this machine, command shown or cited), **[source]** (read in code or a
vendor's source, `file:line`), **[documented]** (vendor docs, URL + fetch date) or **[asserted]**
(reasoning, not verified). What was not checked is said outright.

---

## 1. What brigadier is

**A lead that never accumulates.**

The Rust harness owns everything durable — the goal, the plan, what is done, what is left, the
diffs, the thread on screen. Model windows are rented for the moments that need judgement and
thrown away afterwards. The thread is permanent. No context ever is.

That one sentence is the product. Everything below is a consequence of it.

## 2. The problem it is for

A long agent session does not announce that it has gone bad. It gets slower, vaguer and more
expensive, and every individual turn still looks reasonable. The window filled up: the session read
forty files to answer one question, pasted a test run into the conversation, and now every
subsequent turn re-sends all of it.

Two facts make this worse than it sounds:

- Recall accuracy falls as tokens rise — the session **degrades before it hits any limit**
  (`docs/research/long-sessions.md`). The failure is silent by construction.
- A 20-step agent loop can consume over 10x the tokens a per-step estimate suggests, because
  conversation history accumulates quadratically
  (**[documented]** kunalganglani.com/blog/ai-agent-cost-per-task-2026, fetched 2026-09-02).

The industry answer, including Anthropic's own published reference design for long-running coding
agents, is **fresh sessions, files as connective tissue, a git commit per phase — not one long
session** (`docs/research/long-sessions.md`, citing anthropic.com/engineering/effective-harnesses-for-long-running-agents).

brigadier does not ask a model to be disciplined about this. It removes the accumulating window.

## 3. The shape

```
                    ┌──────────────────────────────────────────┐
   durable          │  Rust harness: goal · plan · progress ·  │
   (forever)        │  thread · diffs · worktrees · store      │
                    └───────────────┬──────────────────────────┘
                                    │ rents a window, throws it away
                    ┌───────────────┴──────────────────────────┐
   disposable       │  lead call · grill call · research ·     │
   (seconds)        │  work order · review · judge             │
                    └──────────────────────────────────────────┘
```

Each rented window is a fresh CLI child with a small, curated context the harness assembles. Cost
per step is flat at step 400 as at step 4. Nothing rots, because nothing fills.

**The measured price of this shape: 1,395 ms median from spawn to `system/init` with the user's two
MCP servers connected, 643.5 ms with `--strict-mcp-config`** (`docs/research/spawn-split.md`, six
alternating pairs on CLI 2.1.259, **[measured]**). The 751.5 ms delta is MCP server startup, and it
lands entirely after the `initialize` reply, which is MCP-independent at 663.0 against 624.5 ms
(`docs/research/spawn-split.md`, **[measured]**). A ten-step phase pays about 14 s of pure startup
with MCP and about 6.5 s without. The fan-out harness already passes `--strict-mcp-config`
(`crates/claude-spike/src/bin/fanout.rs:97`), so every fan-out figure in this repo is an MCP-off
number. Owner decision, 2026-09-03: harness-spawned children do **not** get the user's MCP servers by
default, and a project opts in per project (`docs/research/spawn-split.md` §6; the harness passes
`--strict-mcp-config` and no `--mcp-config` unless the project's policy is `inherit`).
Mitigations exist —
a warm pool, or letting one child serve several turns, since `system/init` fires per *turn* and a
process can serve more than one — and **none is built or measured**.

**A consequence worth naming: brigadier always knows what step it is on, because it chose the
step.** The one-line status the user sees is therefore a fact the harness already holds, not a
model being asked to be brief. It costs zero tokens and cannot hallucinate.

## 4. The flow

**1 — Add a project.** Local directories only. No remote, no cloud, no accounts. At startup
brigadier probes which agent CLIs are installed and authenticated; the `initialize` response carries
`models` (6) and `account {email, organization, subscriptionType, apiProvider}`
(**[measured]**, `docs/research/claude-direct-spike.md`), so brigadier knows the available models and
the billing regime without asking.

**2 — Pick the lead CLI.** One modal, once. It is a preference, not a binding — see §6 on failover.

**3 — State an intent.** *"Project X is a job portal SaaS, let's build it."* No settings, no model
picker, no toggles.

**4 — Recon, free.** The harness reads the file tree, manifests, test command, framework and recent
git log itself. No model window is spent on it. This becomes a ~1,500-token brief handed to every
later child (§7).

**5 — Grill and research, concurrently.** brigadier lists what it does not know and sorts each
unknown into one of two bins:

| bin | goes to | example |
|---|---|---|
| only the user can answer | one question at a time, as a real choice | auth model; who posts jobs; payments now or later |
| the internet can answer | research subagents with `WebSearch`/`WebFetch`, findings to a file | what does this framework do about auth; is this library maintained |

Both resolve before the plan is final, and they run at the same time so the wall-clock cost is
whichever is slower. **"Just go" is always one click away, and skipping is recorded** — when a phase
later fails on a question that was waved off, the thread can say which one.

This scales with actual ignorance. A typo fix produces no unknowns and starts immediately. A vague
goal earns the delay, and the delay is the cheapest thing in the product: a question answered here
is a phase not built wrong.

**6 — The plan lands as a checklist.** Phases, each with a definition of done and **a real verify
command**. The owner approves once, as an envelope covering the whole run.

**7 — The loop.** Per phase:

1. A **lead call** — fresh, small: goal + plan + progress + last outcome — emits an *action*, not prose.
2. Usually: dispatch. One git worktree per work order, one fresh child in each, disjoint file
   ownership so no two workers write the same file.
3. Workers return **reports**, not transcripts.
4. Adversarial review where it is earned (§5).
5. **The gate is a real exit code.** The verify command runs; its output goes to a worker's window,
   never into the thread.
6. Green → merge, commit, clean up. Progress updated. Next phase.

**8 — Nothing is left behind**, within one honest limit stated in §8.

## 5. Fusion — what the second CLI is for

Fusion is OpenRouter's pattern: fan one prompt to a panel of models in parallel, then a judge reads
every response and fuses consensus, contradictions and unique insight into one answer
(**[documented]** openrouter.ai/fusion, fetched 2026-09-02).

**Fusion works on answers. It does not work on actions.** OpenRouter fuses text; coding CLIs edit
repositories. Fan one task to two of them and you get two diffs, and no judge can fuse two sets of
file writes — it must pick one and discard the other, paid for.

So the rule is:

> **Fusion for judgement. Single owner for actions. Except where an objective gate can pick the
> winner — and then fusion on actions too.**

The exception is not a loophole, it is the best moment in the product. At a **red gate** there is
already a judge that is not a model: the exit code. Two CLIs attempt the fix in two worktrees, both
run the verify command, and the one that goes green wins. No synthesis, no taste, no judge call.

**The red-gate ladder**, in order:

1. **Fresh worker, same order, told what failed.** One child, ~2 s. Fixes the common case where a
   worker's window got polluted early and it spent the rest of the order defending a misreading.
2. **Fusion.** Both CLIs, two worktrees, the gate picks the winner.
3. **Stop and ask the owner**, with a real diagnosis.

Where fusion is worth real money on judgement: plan review, diff review, "did we miss anything".
A differently-trained model has different blind spots, which is strictly better than Claude
reviewing Claude.

## 6. Economics — usage windows, never dollars

**The owner runs brigadier on his own authenticated CLIs. Dollars never appear in the product.**
Not as a primary number, not as an imputed one. A subscription user is never billed per token, so a
dollar figure would be a lie in the user's favour, which is still a lie.

The currency is the rolling usage window, and the CLI streams it unasked (**[measured]**, spike
fixtures `s8`/`s9`/`s10`):

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
  "unifiedWindows":{"five_hour":{"utilization":0.15,"resetsAt":1788315600},
                    "seven_day":{"utilization":0.03,"resetsAt":1788346800}}}}
```

Utilization for both windows, exact reset epochs, free on the event stream, no extra call. It ticked
0.15 → 0.16 across the spike's runs, so it is live.

> Correction to an existing brief: `docs/research/long-sessions.md` says rate limits are "per model
> class" and that parallel sessions on different models draw from separate buckets. The measured
> frame says `unifiedWindows` with only `five_hour` and `seven_day`. That line is **stale** and
> should be fixed when the file is next touched.

**The reserve.** brigadier never takes utilization above a line the owner sets, defaulting near 80%,
narrowing concurrency as it approaches and parking below it rather than at empty. The reason is
specific: if brigadier drinks the whole window, **the owner's own Claude Code stops working.** The
reserve is headroom for the human, not a cost control.

**How the gauge can actually be sampled — a constraint, measured.** Exactly **one**
`rate_limit_event` fires per session, at 804–984 ms, and it reports utilization *before* that
session's own spend (`docs/research/fanout-vs-children.md`). There is no second reading later in a
session without spawning another child, and `utilization` is reported to two decimals, so 1% is the
finest resolution available.

This is a constraint a long-lived session could not work around and **shape §3 turns into a
non-issue**: brigadier spawns a fresh child per work order, so every dispatch yields a fresh
reading. The reserve is therefore a **per-dispatch gate, not a live control loop** — brigadier
checks the window when it decides to spawn, never mid-flight. At a reserve near 80% and 1%
resolution that is ample; a design needing finer control than that could not be built on this
signal.

**Parallelism is token-neutral.** Four workers at once and four in sequence burn the same total for
the same work; parallelism changes the rate, not the amount. The one genuine waste is four workers
each reading the same five files — a partitioning failure, not a concurrency cost, and the fix is
disjoint file ownership per order.

**Direct children beat fan-out — measured, and not for the reason first assumed.**
**[measured]** N=3 on `claude-haiku-4-5` (`docs/research/fanout-vs-children.md`): harness-spawned
children won every measure — 230,615 tokens against 267,220 (1.16x), $0.072819 against $0.090916
(1.25x), and 9,814 ms against 17,049 ms (1.74x). The direction holds. The margin is narrower than
"fan-out is the expensive shape" implies, and that phrasing oversold a 16% token gap.

The mechanism this file first gave was **half wrong**, and the correction runs against the
conclusion rather than for it: fan-out does *not* pay for N equally-sized worker windows plus a
coordinator. **A subagent's window is 42% smaller than a harness-spawned child's** — roughly 15k of
context per turn against 25k, because the host system prompt is about 10k bigger. That is a real
point in fan-out's favour and it was stated backwards.

Direct children still win, and this is the sentence that matters: **the coordinator alone was
133,858 tokens — 50.1% of the fan-out arm's entire bill, or 1.76 direct children's worth — and
three of its five messages existed only to be woken when a subagent finished, costing 82,190 tokens,
more than one whole direct child.** That per-completion wake-up tax is the largest single lever on
the result, nothing predicted it, and it is the term that scales worst as N grows. Extrapolated
parity sits somewhere near N≈12, which is **[asserted]**, not measured.

The other two objections to fan-out are unchanged and remain **[asserted]**: it loses per-worker
model routing (Claude Code picks its subagents' models, not brigadier) and it loses worktree
isolation (every subagent shares one cwd, so parallel edits collide). Neither was measured.

**Model routing is the throttle.** Role-based: judgement (lead, grill, review, judge) gets the
strong model; work orders get mid-tier; lookups and mechanical edits get the cheapest. As the window
fills, **non-judgement work downshifts and thinking does not** — judgement calls are a small share
of tokens and carry most of the quality. One visible per-session tier is the knob the owner sees.
`codex` takes `-m, --model` per invocation (**[measured]**, `codex --help`), so this works on both.

## 7. What is handed to a worker

**No codebase index.** Measured across 46.1M tool-result tokens in 290 local transcripts: search
results are a **median 127 tokens and 8.2% of tool tokens; `Read` is 73%**
(`docs/research/codebase-index.md`). An index attacks the small number, and nothing lets a worker
skip reading the file it edits. A crude whole-repo symbol map rebuilds in **145 ms**, so persistence
buys nothing; Cursor turned semantic indexing off, Cody removed embeddings, Zed deleted its
`semantic_index` crate, and Codex and t3code precompute nothing.

Instead: a **~1,500-token brief assembled from git in under 100 ms** — file tree, manifests, test
command, framework, recent log — handed to every child.

**Landmine, regardless:** mtime-keyed caching **misses on 100% of files in a fresh worktree** — same
content, different mtime. Every worker runs in a worktree, so any mtime-keyed cache would be wrong
every time. Git blob OIDs are 99.45% identical across branches; content-address, never mtime.

## 8. Autonomy, safety and litter

**Workers are pre-authorized inside their own worktree.** Reads, builds, tests and writes below the
worktree root proceed with no human. Anything reaching outside it — network, package installs with
side effects, `git push`, destructive commands, writes above the worktree root — queues in the
approvals dock.

**A queued approval parks one work order, never the run.** brigadier continues every other order and
phase that does not depend on it. One prompt at 3am costs one work order by morning, not the night.
This matters because the approvals dock as built is proven live and completely useless while the
owner is asleep; without this rule the overnight run does not fail, it *hangs*.

**Re-planning.** brigadier may rewrite, add or drop phases inside the goal the owner approved,
recording what changed and why. A change that would move the **definition of done** escalates to
fusion, and on disagreement to the owner. The failure mode being guarded against is named in our own
research: *agents declaring done prematurely and marking features complete without end-to-end
tests.*

**Cleanup — reversibility beats prediction.** "Is this merged" has **no sound automatic test**:
`git cherry` reports work unmerged after a squash-merge and after a conflict-resolved rebase, and
reports it *merged* when it was applied upstream then reverted (**[measured]**,
`docs/research/worktree-cleanup.md`). The only sound signal is `rev-list --count base..branch == 0`.

So the rule is **auto-remove only when there is nothing to lose**, and before any removal, commit
uncommitted work to a ref so the deletion is reversible (Conductor's approach). Anything unmerged
survives and is listed in the UI for one-click cleanup. Deleting a session removes its rows, its
feed log and its worktree — and because **every phase commits to git, deleting a session destroys
nothing that matters.** The work is in the repository; only the narration goes.

**The honest exception to "no litter".** On this machine right now: 66 MB of our own raw NDJSON
across 23 sessions, and **3.0 GB of provider transcript directories** (**[measured]**). The
transcripts are the only thing `--resume` reads, so they cannot be auto-deleted. The promise is
"brigadier cleans up after itself", not "nothing accumulates". A retention policy for both classes
is **unwritten**.

**Security — measured, and fixed at `5d71793`.** `git worktree add` executes the repository's own
git filter drivers. The escalation is what made it serious: a worktree's `.git` is a *file*, so
there is no per-worktree config, and `git config --local` run from inside a session's worktree
writes the **main** repository's `.git/config`. An agent in one session could plant a driver with an
ordinary-looking git command and have the *next* session's worktree creation execute it as shell,
outside every approval prompt — cross-session arbitrary code execution, in an app whose entire job
is running agents inside repositories. Filter `smudge`/`clean`/`process` are now blanked and
`core.fsmonitor` disabled around every worktree call. **[measured]** on git 2.50.1;
`docs/research/gitattributes.md`.

The general rule this leaves behind: **a session's worktree is not a configuration boundary.**
Anything git reads from repository config is reachable by any agent that has ever had write access
to the project, from any session.

## 9. What the user sees

**The sidebar shows every project, with its sessions nested.** A collapsed project still carries a
dot when something is running inside it, so work in a project you are not looking at is never
invisible. Finished projects collapse to one line with a count. The window gauge is pinned at the
bottom of the sidebar, under everything.

```
+ New session          |   > Plan  6 phases . 3 done
                       |
v job-portal       *   |   Phase 3 . API routes
   * schema + auth     |
   o landing page      |   3 workers dispatched
v brigadier-ai         |   Review: 2 blockers
   * the wall          |   Phase 2 green . 41 tests
> old-crm          3   |
> dotfiles             |
-----------------------|   +----------------------+
 ######....  5h   62%  |   | Ask or steer...      |
 #.........  7d   11%  |   +----------------------+
```

**Thread-primary, one column.** The plan sits pinned above the thread as a live card, collapsible to
one line, expandable to the full checklist, updating in place as phases complete. Nothing the owner
steers with ever scrolls away.

**One line per event, harness-derived.** `Grilling — 4 questions.` `3 workers: schema, API routes,
job list.` `Review: 2 blockers, fixing.` `Phase 2 green — 41 tests pass. Committed.` Model prose
lives entirely behind a verbose toggle.

**The gauge is the window**, not a token count and not a dollar figure: two bars and two countdowns,
with the owner's reserve line drawn on them.

**First launch** with no projects is a single centred prompt to add one. No dashboard, no tour.

**Optimistic transitions, and the one that is not.** Starting a session, sending a turn and deleting
a session all paint before Rust confirms them. Starting a session is the important one: it hides the
measured spawn, 1,395 ms with the user's MCP servers or 643.5 ms without
(`docs/research/spawn-split.md`), which is otherwise the most visible dead time in the app, and a
failed spawn turns the row that just appeared into an error in place. Deleting is optimistic with a
few seconds of undo, which is what makes pruning feel free.

**Approvals are never optimistic.** The dock resolves only when Rust confirms the decision reached
the model. Every other transition is a convenience; this one is the safety boundary, and a panel that
shows "denied" for a deny that did not land — or "allowed" for something that never ran — breaks the
one screen the owner has to be able to trust.

**Every optimistic entry is retired by a specific matched echo, never by "the operation finished".**
VS Code #332087 is the whole lesson **[source]**: an optimistic `chat/turnStarted` that was never
retired got replayed over confirmed state on every confirmed action, so 17 streaming deltas were
swallowed and 2,432 characters painted in one update at **19.4 seconds**. An optimistic layer built
to make streaming feel faster hid it entirely. Ours match on `TurnStarted.turn_id`, and the fallback
marks an entry **unknown** rather than leaving it pending forever.

### How fast, in numbers

"We prioritize performance" is only a claim if it has figures behind it. These are the budgets, and
the two that are guesses say so — they are **not quotable as results**. The paint instrumentation
exists, has been run for paints (`1c8b6f6`; `docs/research/perceived-performance.md` §1.4) and now
for one interaction: **B4 got the first `beginInteraction` call site at `a0901e5` and is a number**
(§2.7). B6 and B7 stay guesses for a sharper reason than before — not "no instrument" but **no call
site**. The instrument is built and demonstrated; nothing calls it from those two paths, so W4-D
still owes them.

| | budget | today |
|---|---|---|
| **B1** exec → **painted** shell | ≤ 200 ms | **287–295 ms p50** **[measured]**, n=19 — **~90 ms over budget**, and those pixels are React's, not a shell's |
| **B2** exec → real project list | ≤ 350 ms | **292 ms p50** **[measured]**, replicated at **290.5 p50**, n=7, on a busier machine |
| **B3** first-ever launch, migrations run | ≤ 400 ms | **291.3 ms p50** **[measured]**, n=7 — supersedes a 314 ms n=1 sample; migrations cost nothing measurable |
| **B4** click session → last screenful painted | ≤ 100 ms p95 | **p50 32.5 ms, range 22–144, n=14** **[measured]** — 13 of 14 under 100 ms. **No p95**: n=14 cannot support one. Capped, not fast — see below |
| **B5** …of which the Rust half | ≤ 16 ms p95 | **≤ 8.2 ms** worst case **[measured]** |
| **B6** rest of the scrollback filled in | ≤ 250 ms | **guess** |
| **B7** any button → visible acknowledgement | ≤ 100 ms | **guess** |
| **B8** frame budget throughout | 16.67 ms | 60 Hz confirmed in a real window **[measured]** |

**B4 is close to constant-work by construction, so its budget barely bites.** `TAIL_ROWS = 48` caps
what a selection paints, so there is no large-scrollback regime to be slow in: a session with 500
stored rows measured **25 ms**, faster than the median, and 8 of the 14 samples sit within one frame
of the ~33 ms floor that `beginInteraction`'s own double-`requestAnimationFrame` costs at 60 Hz. So
the row does not say the session-switch path is fast; it says **the path is capped, and this is what
the cap costs**. The cost B4 was written to catch lives in **B6**, which still has no call site.

B2, B3, B5 and B8 are **build gates**; B1 joins them when the static shell lands, and it now joins
them with a measured gap rather than an estimate. B1 and B2 are separate on purpose: a window on
screen with a painted shell early that fills its list at ~290 ms reads as instant, and one that
stays blank until then does not — **blank is what ships today**, for ~290 ms of it. The ~190 ms this
line used to quote was arithmetic; measured, the first paint is ~100 ms later than that, and
`perceived-performance.md` §1.4 puts the missing ~100 ms on the `tauri://localhost` scheme handler
and brotli inflate that its own FCP figures never included — **[asserted]**, by elimination.
The 2026-09-03 per-stage signposts bound that attribution rather than confirm it: the
scheme-plus-inflate share is at most the 49.6 ms `page_load_finished` to `dcl` segment, measured
2026-09-04 (`docs/research/launch-signposts.md`), which also holds the HTML and JS parse, and the
largest single segment is Tauri's own window and WKWebView creation at 108.7 ms **[measured]**,
`docs/research/launch-signposts.md`.

Two closed doors, both **[source]**: a splash window is a *second* WKWebView, and WKWebView
construction is the ~100 ms that dominates launch, so it pays the cost twice to hide it once. And
creating the window `visible: false` until the frontend is ready hits tauri **#15652**, still open —
such a window "can permanently stop receiving events; undeliverable `EvaluateScript` is silently
discarded", and our entire UI is `eval`-delivered `Channel` traffic. Painting the shell in
`index.html` is the only route.

### What is cached between launches: window state, the last project, scroll position

Nothing else. The tail query is **0.145 ms at 10,000 rows and 0.142 ms at 1,000,000**
(`docs/research/perceived-performance.md`), so a rendered thread snapshot saves nothing measurable
and is stale the instant a live session emits one more row — which for a live session is
immediately. Scroll position is the only part of that idea that is not a trap.

This is the same shape as the no-index finding in §7, and it is worth stating as a principle:
**this app's data layer is fast enough that caching is a liability rather than a win.** Every cache
is a stale-copy bug waiting for a branch switch. Where something genuinely must be cached later, it
carries a validator — `HEAD` plus the manifest `mtime` — or it is recomputed.

**No forking in v1.** Mid-run plan editing covers redirection; fusion-at-a-gate covers try-both; and
forking multiplies exactly the session clutter the owner prunes compulsively.

## 10. Scope

**Claude Code only for v1.** Codex is deferred and the provider layer stays a trait so a second is
additive. `gemini`, `opencode`, `qwen` and `copilot` are installed on this machine and are
deliberately ignored. Cursor and local models come after those.

**Consequence, stated plainly:** deferring Codex defers cross-vendor failover. With one vendor, an
empty window means park and wait for reset, so v1's "longest runs" claim rests on **surviving window
resets**, not on extra capacity. When a second vendor lands it buys throughput that is physically
unavailable from one — a different account is a different bucket — and only then does failover
become real.

## 11. What is not promised

- Not "one-shot an entire project in one session". That was never achievable and is not claimed.
  Continuity across many short sessions is the product.
- Not a security boundary. Isolation is a git worktree; the blast radius of a bad worker is work
  brigadier can throw away, which is a containment property, not a sandbox.
- Not remote or hosted. Local projects, local CLIs, the user's own subscriptions.
- Not multi-vendor at v1.

## 12. Open and unmeasured

Everything here that has not been checked, in one place:

1. Fan-out vs direct children beyond N=3. One run per arm, so **no variance**; arm order was not
   reversed; N was never varied. The N≈12 parity extrapolation is asserted. Fan-out's other two
   costs — lost model routing and worktree collision — were reasoned, never measured.
2. Whether a child's tool set can be constrained at `initialize`, which would make the wall a
   *capability* rather than a *refusal*. Unresearched. The proven fallback is `PreToolUse` denial
   with `matcher: ""`.
3. Whether `codex app-server` exposes anything equivalent to `rate_limit_event`. Not checked, and
   cross-vendor failover depends on it.
4. Spawn-cost mitigation: warm pool vs. multi-turn children. Neither built nor measured.
5. Retention policy for raw NDJSON and provider transcripts. Unwritten.
6. The `.gitattributes` filter-driver hole is **fixed** at `5d71793` — §8, and
   `docs/research/gitattributes.md`. What is still open is the mechanism beside it:
   **`.git/hooks/post-checkout` runs at `git worktree add` [measured]** and is deliberately not
   neutralised, because `core.hooksPath` at an empty directory would also disable a repo's own
   load-bearing checkout hook; that is a policy call `crates/supervisor` owns and it is **unmade**.
   Unmeasured on the fix itself: the enumerate-then-spawn TOCTOU window, the git-lfs pointer-file
   consequence (git-lfs is not installed on this machine), Windows, and any git other than 2.50.1
   (`gitattributes.md` §§4-6).
7. Whether the ~1,500-token brief actually reduces turns. The settling experiment — same work order
   with and without it — was **not run**.
8. **The front end's test runner covers `src/feedStore.ts`, `src/paint.ts` and one unmounted
   provider.** *Closed:* a runner exists — Vitest, jsdom and Testing Library, `npm test`, 66 tests
   in three files at `3e5c3fd` **[measured]**, pinning the rAF drain, the `ROW_CAP` trim, the
   `seedRows` two-pointer merge, cost never summed across turns, `seedSessions`, counter throttling
   and array-reference stability, plus the paint instrument and `ThemeProvider`'s stored-preference
   contract. *Still open:* the only component under test, `src/providers/ThemeProvider.tsx`, is not
   mounted, renders nothing of its own and has no visual effect while we ship dark-only, so no
   component that draws anything has a test and nothing below this line changed. The six
   worktree-cleanup refusal notes were proven by rendering synthesized values through
   `react-dom/server` from a throwaway script that is now gone; the sentences and buttons are right,
   the click wiring was checked by reading only. No refusal note has been seen in a real window, and
   none came from a real repository's refusal. That gap closes the first time the owner clicks it,
   and not before — which is true of the Resume button, the branch chip and the cleanup flow as well.
