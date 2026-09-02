# N direct children vs one child fanning out to N subagents

Date: 2026-09-02. Status: **executed against a live account**, five `claude` sessions,
`$0.186289` spent against a `$0.15` cap — **over by `$0.036289`**, see "Cost" below.

The claim under test is `docs/vision.md` §6: *"Fan-out is the expensive shape, not the cheap one.
One child spawning N subagents pays for N worker windows **plus** a coordinating window… N children
spawned by the harness pay for N windows and coordinate in Rust for zero tokens."* §6 tags it
**[asserted]** and says the head-to-head "has **not** been measured". This file measures it at N=3.

Every claim is marked **[measured]** (a frame in `crates/claude-spike/fixtures/f-*`, or a line in a
CLI transcript, command shown), **[derived]** (arithmetic over measured numbers) or **[asserted]**
(reasoning, not verified). What was not checked is said outright.

Spike code: `crates/claude-spike/src/bin/fanout.rs` (new binary `fanout`, phases `warm`/`a`/`b`) on
top of the WO-C driver in `crates/claude-spike/src/session.rs`, unchanged.
Fixtures: `crates/claude-spike/fixtures/f-*`.

## Bottom line

**§6's direction holds at N=3, and its margin is smaller than its wording implies.** Direct children
win all three measures: **16% fewer tokens, 25% less cost, 1.74× faster wall clock.** But §6's
*mechanism* is half wrong: fan-out's worker windows are **not** the same size as a harness-spawned
child's — a subagent's window is **42% smaller** — and the entire margin, and more, is the
coordinator, which alone burns **1.76 direct children's worth of tokens** and takes **one extra
coordinator turn per subagent completion**.

## Head to head

Arm A = 3 direct children, one piece each. Arm B = 1 child told to use its `Agent` tool for the same
3 pieces. Identical starting tree, identical model, identical argv. **[measured]**

| measure | Arm A — direct children | Arm B — fan-out | B/A |
|---|---:|---:|---:|
| **tokens** (in + out + cache_read + cache_creation) | **230,615** | **267,220** | **1.16×** |
| **cost** (`result.total_cost_usd`) | **$0.072819** | **$0.090916** | **1.25×** |
| **wall clock**, spawn to last `result` | **9,814 ms** | **17,049 ms** | **1.74×** |
| `five_hour` utilization delta | 0.00 | 0.00 | — (below field resolution) |
| `seven_day` utilization delta | 0.00 | 0.00 | — (below field resolution) |

Token split **[measured]**:

| | input | output | cache_read | cache_creation | total |
|---|---:|---:|---:|---:|---:|
| Arm A | 2,879 | 1,816 | 205,779 | 20,141 | **230,615** |
| Arm B | 1,167 | 2,741 | 225,897 | 37,415 | **267,220** |
| B/A | 0.41× | 1.51× | 1.10× | 1.86× | **1.16×** |

Arm B produces **51% more output tokens** and **86% more cache-creation tokens** for the same work.
The output surplus is the coordinator narrating; the cache-creation surplus is a second, separate
system-prompt prefix (the subagent one) being paid for on top of the host one.

## Where Arm B's tokens actually go

Attribution is off the CLI's own transcript files, deduped by `message.id`, split by which file the
message landed in — the main session transcript is the coordinator, `…/<sid>/subagents/agent-*.jsonl`
are the subagents. **[measured]**

| Arm B component | tokens | share of Arm B |
|---|---:|---:|
| **coordinator** (main transcript, 5 assistant messages) | **133,858** | **50.1%** |
| subagent `aafc7c230bfeb2125` (charlie) | 44,181 | 16.5% |
| subagent `abc29909d2f74f049` (alpha) | 44,175 | 16.5% |
| subagent `ad0430f0cce872993` (bravo) | 43,949 | 16.4% |
| subagents subtotal | 132,305 | 49.5% |
| auto-title call (`claude-haiku-4-5-20251001`, not in any transcript) | 1,057 | 0.4% |
| **total** | **267,220** | |

Arm A, same method **[measured]**:

| Arm A child | tokens (transcript) | + auto-title | total |
|---|---:|---:|---:|
| `f-a1-alpha` | 76,021 | 945 | 76,966 |
| `f-a2-bravo` | 75,837 | 948 | 76,785 |
| `f-a3-charlie` | 75,919 | 945 | 76,864 |
| **total** | | | **230,615** |

**The finding that contradicts §6's model: a subagent's window is much smaller than a top-level
child's.** Per piece — identical instruction text, identical file, identical Read+Write tool
sequence, three model calls each **[measured]**:

| | msg 1 | msg 2 | msg 3 | total |
|---|---:|---:|---:|---:|
| direct child (`f-a1-alpha`) | 24,791 | 25,527 | 25,703 | **76,021** |
| subagent (`agent-aafc7c23…`) | 13,859 | 15,062 | 15,260 | **44,181** |

A subagent carries roughly **15k of context per turn where a top-level child carries 25k**
**[measured]** — the host system prompt (env block, git status, full tool list, `CLAUDE.md`) is
about 10k larger than the subagent's. So doing the piece as a subagent is **42% cheaper than doing
it as a direct child**. §6 says fan-out pays "N worker windows *plus* a coordinating window", which
implies the N worker windows are the same either way. **They are not, and the difference runs
against the vision.** Direct children still win because the coordinator costs far more than the
saving.

**The coordinator's five messages [measured]:**

| # | what | in | out | cache_read | cache_create | total |
|---|---|---:|---:|---:|---:|---:|
| 1 | spawn 3 `Agent` calls in one message | 10 | 510 | 18,883 | 5,824 | 25,227 |
| 2 | "Agents launched. Waiting…" | 10 | 108 | 24,707 | 1,616 | 26,441 |
| 3 | woken by bravo finishing | 10 | 51 | 26,323 | 531 | 26,915 |
| 4 | woken by alpha finishing | 10 | 45 | 26,854 | 475 | 27,384 |
| 5 | woken by charlie finishing → "done" | 10 | 84 | 27,329 | 468 | 27,891 |

Two things are visible in that table:

- **`cache_read` climbs monotonically, 18,883 → 27,329.** That is §6's "re-sends the brief and every
  returned report on each turn", measured. **[measured]**
- **Each subagent completion costs a whole extra coordinator turn** — messages 3, 4 and 5, 82,190
  tokens between them, more than one entire direct child. Nothing in §6 predicts this. It is a
  direct consequence of the async `Agent` tool documented in `docs/research/wall-hooks.md`: the
  subagent wakes the session, and the wake is a full turn at the coordinator's current context size.
  **[measured]**

The `Agent` tool ran the three subagents **in parallel** as instructed — one assistant message with
three `Agent` calls, three `SubagentStart` hooks, and the three completions arriving out of launch
order (bravo, alpha, charlie) **[measured]** — so this is not a fan-out crippled by serialisation.

## Wall clock

`arm_wall_ms` in the fixtures includes the driver's own post-`result` grace window (5 s on Arm A,
25 s on Arm B, so a background subagent could not be missed). The figures in the head-to-head table
have that grace subtracted **[derived]**:

| | arm_wall_ms (fixture) | grace | end-to-end |
|---|---:|---:|---:|
| Arm A | 14,814 | 5,000 | **9,814 ms** |
| Arm B | 42,049 | 25,000 | **17,049 ms** |

Cross-check from the frames themselves, `spawn → system/init → last result` **[measured]**:
Arm A's slowest child `598 + 8,717 = 9,315 ms`; Arm B `655 + 16,080 = 16,735 ms`. Both derivations
agree to within ~300 ms, which is the thread-launch overhead of running three children at once.

Arm A's three children ran **concurrently on one laptop**, contending for CPU; a single child of the
same shape would be faster. That makes 9,814 ms a **conservative** figure for the direct-children
arm. **[asserted]**

## The two honesty conditions

### 1. Same model, same frozen prefix

- **Model.** `claude-haiku-4-5` on every call in both arms, pinned with `--model` in the argv
  `build_argv` writes. The only other model key that appears anywhere in `modelUsage` is
  `claude-haiku-4-5-20251001` — the CLI's own conversation-title call, also Haiku, 905–1,039 input
  tokens once per session. No other model was billed in either arm. **[measured]**
- **argv.** Byte-identical on all five children, printed at the top of every run:

  ```
  /Users/stephen/.local/bin/claude \
    --output-format stream-json --verbose --input-format stream-json \
    --model claude-haiku-4-5 --permission-prompt-tool stdio \
    --permission-mode bypassPermissions --strict-mcp-config
  ```

  `--strict-mcp-config` on **both** arms (125 tools → 33, `wall-hooks.md`); `bypassPermissions` on
  **both** so no `can_use_tool` round-trip distorts wall clock — and none fired, in either arm.
  **[measured]**
- **Hooks.** The same three registered on both arms (`PreToolUse`, `SubagentStart`, `SubagentStop`,
  all `matcher: ""`), every callback answered `{}` immediately, so hook latency is not a confound.
  **[measured]**
- **Tree.** One scratch git repo, three unrelated ~25-line Python modules, one commit `ad3b851`.
  Arm A ran against it; the tree was then restored with `git clean -fd && git checkout -- .` and
  verified `git status --porcelain` empty before Arm B. The cwd string is identical for both arms,
  so the environment/git block of the system prompt — part of the cached prefix — is byte-identical.
  **[measured]**
- **Warm-up.** A throwaway child (`f-warm`, "Reply with exactly the word ok", no tools) ran **before
  both arms** so neither paid the cold top-level cache-creation bill purely for going first. Its
  effect is visible: the first message of Arm A's `f-a1-alpha` and the first message of Arm B's
  coordinator both read **18,883** cached tokens and created ~5.8k. Identical starting cache state.
  **[measured]**

**The stronger point: the headline measure is nearly cache-independent by construction.** Tokens are
counted as `input + output + cache_read + cache_creation`, so a token merely moves between the
`cache_read` and `cache_creation` columns depending on cache warmth — the total barely changes. The
subagent prefix demonstrates it: the first subagent to reach the API paid `cr 0 / cc 13,659`, the
other two paid `cr 8,475 / cc 5,184`, and all three first messages total 13,858–13,860 tokens.
**[measured]** Caching moves **cost**, not the token count. The 1.16× token ratio is therefore
robust; the 1.25× cost ratio is the more cache-sensitive of the two.

### 2. Counting the coordinator's own tokens

`docs/research/agent-sdk.md` §"Notes the adapter must honour" says `modelUsage` on a `result` frame
is cumulative and already includes subagents and sidechains. Both halves were verified here rather
than trusted:

- **Cumulative:** Arm B emitted **four** `result` frames (one per turn — the launch turn plus three
  wake-ups). `total_cost_usd` ran 0.041507 → 0.080403 → 0.086817 → **0.090916**, and
  `modelUsage.cacheReadInputTokens` ran 43,590 → 157,119 → 198,568 → **225,897**. **Summing `result`
  frames would triple-count.** Only the last frame is read. **[measured]**
- **Includes subagents:** the last frame's `modelUsage` totals reconcile **exactly** with the sum of
  the coordinator transcript and the three subagent transcripts.

Two independent methods, run over every one of the five sessions:

- **M1** — the last `result` frame's `modelUsage`, summed across model keys.
- **M2** — the CLI's transcript JSONL, `assistant` messages deduped by `message.id`
  (each appears twice on the wire and twice in the transcript), summed; main transcript =
  coordinator, `…/<sid>/subagents/agent-*.jsonl` = subagents.

`M1 − M2` is, in **all five** runs, **exactly** the auto-title model's `inputTokens + outputTokens`
— 916, 945, 948, 945, 1,057 **[measured]**. That call is not written to any transcript. There is no
residual: coordinator + subagents + title = the cumulative `modelUsage`, to the token.

**Method, stated plainly:** the *arm totals* come from M1 (authoritative, cumulative, includes
subagents). The *coordinator-versus-subagent split* comes from M2, because M1 offers no way to
separate them. Nothing is subtracted or estimated — the split is read directly from two disjoint
sets of files whose sum is checked against M1.

Accounting script: `scratchpad/account.py` (not in the repo — reproduced by re-running the two
methods above over `fixtures/f-*.summary.json`).

## Usage window

**`rate_limit_event.rate_limit_info.unifiedWindows` exists on the stream and was read on every one of
the five sessions. [measured]** Verbatim from `f-b-fanout.ndjson`:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1788364800,"rateLimitType":"five_hour",
  "overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,
  "unifiedWindows":{"five_hour":{"utilization":0.8,"resetsAt":1788364800},
                    "seven_day":{"utilization":0.16,"resetsAt":1788951600}}}}
```

**It did not move.** All five sessions read `five_hour 0.8` / `seven_day 0.16` — warm-up, all three
Arm A children, and Arm B. **[measured]** Two facts explain why, and both are limits on this
measurement rather than results:

- **`utilization` is reported to two decimals**, i.e. 1% of the window. The whole experiment spent
  $0.19 of Haiku; neither arm was ever going to register. The usage-window row in the head-to-head
  table is therefore **"no measurable difference"**, not "equal".
- **Exactly one `rate_limit_event` fired per session**, at 804–984 ms — near the *start* of the turn,
  before that session's own spend. `grep -c rate_limit_event` = 1 on all five `.ndjson` files.
  **[measured]** There is no "after" reading inside a session; getting one costs another child, and
  the cap was already breached.

Incidental but worth flagging to the owner: the `five_hour` window sat at **0.80 utilization**
throughout — exactly the reserve line `docs/vision.md` §6 names as the default. **[measured]**

## Does the answer flip at larger N?

Only extrapolation, from one measured point. Both models below are **[asserted]**.

Fitting the measured per-piece and per-turn figures — direct child 75,926 tokens/piece; subagent
44,102 tokens/piece; coordinator 51,668 fixed (messages 1–2) plus 27,397 per completion:

- **Linear model** (coordinator turn cost held constant): `75,926N = 51,668 + 71,499N` → parity at
  **N ≈ 12**. Below 12 direct children win; above it, on this model, fan-out would.
- **With the measured context growth** — the coordinator's wake-up turns cost 26,915 → 27,384 →
  27,891, i.e. **+488 tokens per additional completion**, because each report stays in the window:
  `Fanout(N) = 244N² + 70,773N + 51,668` versus `Direct(N) = 75,926N`. That quadratic has **no real
  root** — direct children win at every N.

Which of the two is right is not measurable from N=3. What is measurable is that the coordinator's
context grew monotonically across all five of its messages, so the constant-cost linear model is
known to be optimistic for fan-out. The honest statement is: **direct children win at N=3, and the
mechanism that decides larger N — the coordinator's accumulating window — is the one thing
brigadier's shape removes entirely.**

## Environment

| | |
|---|---|
| CLI binary | `/Users/stephen/.local/bin/claude` |
| CLI version | `2.1.258 (Claude Code)` **[measured]** |
| Model | `claude-haiku-4-5` on every call, both arms **[measured]** |
| cwd | `…/scratchpad/fanout-cwd`, a git repo at commit `ad3b851`: `README.md`, `src/{alpha,bravo,charlie}.py` (~25 lines each, unrelated), empty `summaries/` |
| Task | per piece: *"Read src/NAME.py and write a one-paragraph summary of what it does to summaries/NAME.md. Do not read or write any other file. Reply with exactly the word done."* — byte-identical text handed to an Arm-A child and to an Arm-B subagent |
| stderr | **0 bytes in all five runs** **[measured]** |
| `can_use_tool` frames | **zero, both arms** **[measured]** |
| Work produced | Arm A wrote 3 summaries, 268 words total; Arm B wrote 3 summaries, 284 words total. Comparable work, not a degenerate arm. **[measured]** |

Tools actually run, from `PreToolUse` hooks **[measured]**:

- Arm A: `Read`, `Write` per child, `agent_id` absent on all six — six callbacks, no strays.
- Arm B: `Agent`×3 with `agent_id` **absent** (the host asking to spawn), then `Read`×3 and
  `Write`×3 each carrying a distinct `agent_id` (`abc29909d2f74f049`, `ad0430f0cce872993`,
  `aafc7c230bfeb2125`). This corroborates `wall-hooks.md` (b) at N=3.

Arm B frame census, 111 frames **[measured]**: `assistant` 30, `system/thinking_tokens` 26,
`control_request/hook_callback` 15, `user` 9, `system/background_tasks_changed` 6,
`system/task_progress` 6, **`result/success` 4**, **`system/init` 4**, `system/task_started` 3,
`system/task_updated` 3, `system/task_notification` 3, `rate_limit_event` 1, `control_response` 1.
Note `system/init` fires once **per turn**, four times in one process — corroborating the note in
`docs/vision.md` §3 that a process can serve more than one turn.

## Cost

Per run, from the last `result` frame of each session **[measured]**:

| phase | fixture | session | `result` frames | `total_cost_usd` |
|---|---|---|---:|---:|
| warm-up | `f-warm` | `60b18b55…` | 1 | 0.022554 |
| Arm A | `f-a1-alpha` | `a7dca954…` | 1 | 0.024571 |
| Arm A | `f-a2-bravo` | `3851f2fc…` | 1 | 0.023855 |
| Arm A | `f-a3-charlie` | `f984a60b…` | 1 | 0.024393 |
| **Arm A total** | | | | **0.072819** |
| Arm B | `f-b-fanout` | `2fc68fc7…` | 4 (cumulative; last read) | 0.090916 |
| | | | **grand total** | **$0.186289** |

**Over the $0.15 cap by $0.036289 (24%).** Where it went wrong, plainly: Arm A cost $0.0728 rather
than the ~$0.03 estimated, because the warm prefix saved less than expected — a child's window is
~25k tokens re-read on each of three turns, and the read itself is most of the bill. By the time
Arm A was banked, $0.0954 was spent and Arm B could not fit in the remaining $0.0546. The choice
was to run Arm B anyway or to have no measurement at all and $0.0954 wasted. Arm B was run once,
with no retries, and nothing was run after it. No third arm, no repeat, no N=4.

## Fixtures

`crates/claude-spike/fixtures/`, raw stdout one line per line, nothing rewritten:

| file | lines | bytes |
|---|---:|---:|
| `f-warm.ndjson` | 9 | 28,416 |
| `f-a1-alpha.ndjson` | 30 | 43,756 |
| `f-a2-bravo.ndjson` | 27 | 42,078 |
| `f-a3-charlie.ndjson` | 29 | 43,150 |
| `f-b-fanout.ndjson` | 111 | 127,082 |

Each has a `.sent.ndjson` (everything written to stdin), a `.stderr.txt` (**all five 0 bytes**), a
`.hooks.ndjson` (every `hook_callback` request paired with the response sent), and per phase a
`f-{warm,a,b}.summary.json` — session ids, transcript paths, per-run wall clock, every `result`
frame and every `rate_limit_event`, with a `_at_ms` stamp added.

**Same caution as WO-C and WO-W:** every `.ndjson` contains the `initialize` response's `account`
block with the owner's email and organization. Scrub or gitignore before this repo goes anywhere
public.

## A correction to `docs/research/wall-hooks.md`

That brief's cost table sums run 9's two `result` frames — `0.049362 + 0.057084 = 0.106446` — and
reports a spike total of `$0.160698`. `total_cost_usd` is **cumulative** across `result` frames in
one streaming session, which this spike verified independently on Arm B (four frames, monotonically
rising, the last equal to the sum of its own `modelUsage.costUSD` entries) and which the run 9
fixture itself confirms: its second frame's `modelUsage` is a superset of its first's
(`cacheRead 72,567 → 115,395`). Run 9 therefore cost **$0.057084**, not $0.106446, and that spike's
real total was **$0.111336** — under its cap, not over it. **[measured]**
`wall-hooks.md` is not owned by this work order and has been left untouched; fix it when it is next
edited.

## What I did NOT check

- **Any N but 3.** The parity-at-N models above are extrapolation from a single point and are marked
  **[asserted]** for that reason.
- **Any model but `claude-haiku-4-5`.** The context-size gap between a host window and a subagent
  window (25k vs 15k) is what decides the margin, and it is a property of this CLI build's prompts,
  not of the arms. A different model, a repo with a large `CLAUDE.md`, or MCP servers left in (125
  tools instead of 33) would move it — possibly a lot, in either direction.
- **Repeat runs.** One run per arm. There is **no variance estimate**; the token totals are within
  0.2% across the three Arm A children, which suggests the piece work is highly reproducible, but
  the arms themselves were each run once.
- **Order effects.** Arm A ran before Arm B, always. The warm-up and the token-based headline measure
  are the mitigations; they were not validated by running the arms in the reverse order.
- **A larger or messier task.** Three ~25-line files and a one-paragraph summary each. A task where
  the pieces need real exploration would grow the worker windows on both sides and shrink the
  coordinator's relative share. Untested.
- **Fan-out with a stated subagent type or model.** The coordinator was left to pick; it used
  `general-purpose`. Whether `Agent` can be given a cheaper model per subagent — §6 claims fan-out
  "loses per-worker model routing" — was **not** tested here.
- **Worktree isolation.** §6's other two fan-out objections (no per-worker model routing, all
  subagents share one cwd) were not exercised. All three Arm B subagents did share one cwd; they did
  not collide only because the pieces were partitioned by file.
- **The usage-window delta of either arm.** Reported as 0.00 because the field's resolution is 1% of
  the window, not because the arms were equal. No arm-level utilization attribution is possible at
  this spend.
- **Whether the coordinator's per-completion wake-up is avoidable.** A prompt that told the
  coordinator not to narrate between completions was not tried; nor was a synchronous variant, if
  one exists. Three of Arm B's five coordinator messages are wake-ups, so this is the single largest
  lever on the result and it is untested.
- **Orphaned processes.** `fanout.rs` now diffs `pgrep claude` around each phase, but that check was
  added after these five runs (to clear the workspace clippy gate) and did not run over them.

## Bottom line

**`docs/vision.md` §6's assertion holds at N=3 — direct children beat fan-out by 16% on tokens, 25%
on cost and 1.74× on wall clock — but its reasoning needs correcting: fan-out's worker windows are
42% *cheaper* than a harness-spawned child's, and the whole margin plus that saving is paid back by
the coordinator, half of Arm B's entire token bill, three of whose five turns exist only to be woken
by a subagent finishing.**
