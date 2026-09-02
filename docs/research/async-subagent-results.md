# Async subagent results: what the adapter should do with the second `result` frame

Date: 2026-09-02. Question: `docs/STATUS.md` §5 open defect — the `Agent`/`Task` tool runs subagents
asynchronously, one user message produces two or more `result` frames, and
`crates/core/src/claude/adapter.rs:680` takes `self.open_turn` on the first one and returns early on
every later one. This file answers *what to do instead*. It does not write the code.

Every claim is tagged **[measured]** (a command run on this machine, or an exact byte read from a
file, with the file and line), **[source]** (read in vendor source on this machine, `file:line`),
**[documented]** (vendor docs, URL + fetch date), or **[asserted]** (reasoning, unverified).

## Bottom line up front

1. **The cost arithmetic in the adapter is already correct; only the frame is dropped.**
   `ResultView::usage()` (`adapter.rs:1264`) reads the cumulative `modelUsage`, and
   `cost_usd_cumulative` passes `total_cost_usd` through untouched (`adapter.rs:693`). Feeding the
   later `result` frames through the *existing* code path fixes the under-count with no arithmetic
   change and **no `ipc-contract.md` change**. **[measured]**
2. **`system/init` and `result` strictly alternate, one-for-one, in all 16 captures.** Every fixture
   has exactly as many `system/init` frames as `result` frames, and in `s9` and `f-b-fanout` they
   interleave `init → result → init → result …` with no exception. **[measured]** That is the
   cheapest correct hook: **an `init` arriving with no open turn opens a continuation turn**, and the
   next `result` closes it. No finality prediction is needed anywhere.
3. **The vendor's model is N *turns* per send, never N results per turn — so finality never has to be
   predicted.** `sdk.d.ts:4830`: "The CLI emits exactly one result message per turn … treat it as
   the turn-complete signal." A finished background subagent makes the CLI run a turn the host never
   sent, stamped `origin: {kind:"task-notification"}`. **[source + documented, §D]** No
   forward-looking signal exists on the message stream, and the one composite rule that fits all 6
   captured frames is racy by the vendor's own admission. §A. **[measured]**
4. **The under-count is 13.5% on `s9` and 54.3% on `f-b-fanout` in dollars, 37% and 81% in
   `cacheReadInputTokens`.** `s9`: `$0.049362` stored vs `$0.057084` true; `f-b`: `$0.041507` vs
   `$0.090916`; cache-read 72,567 vs 115,395 and 43,590 vs 225,897. **[measured]**
5. **A second, quieter defect rides along: `open_turn` is `None` for the whole subagent phase**, so
   `Command::SendTurn`'s guard (`adapter.rs:917`) is open while the CLI is still working, and any
   `can_use_tool` raised by the subagent gets `RequestOpened { turn_id: None }`
   (`adapter.rs:804`). Whether the CLI queues or rejects a turn written into that window is
   **not verified** — `queued_turn_count` is `0` on all 19 captured `result` frames. **[measured]**

---

## 0. What the fixtures actually contain

Commands run in `crates/claude-spike/fixtures/`, `jq` over the NDJSON. **[measured]**

`s9-subagent-agent-id.sent.ndjson`: 12 lines, exactly one `type:"user"` (line 2 of the file;
`control_request` initialize is line 1). One user message. **[measured]**

`s9-subagent-agent-id.ndjson`, 66 frames, ordered:

| line | frame |
|---|---|
| 3 | `system/init` (#1) |
| 28 | `assistant` `tool_use:Agent` |
| 31 | `system/task_started` — `is_backgrounded: true`, `task_id ac602b38daf9dbdc5`, `subagent_type general-purpose`, `spawn_depth 1`, `task_type local_agent` |
| 37–44 | `assistant`/`user` with `parent_tool_use_id: toolu_01XW7tG45rDw919B6zhTthWw` (the subagent's own frames) |
| 48 | `control_request/hook_callback` `hook_event_name: Stop`, `background_tasks: [1 running]` |
| 49 | **`result` #1** |
| 54 | `system/task_updated` `patch:{status:"completed"}` |
| 55 | `system/task_notification` `status: completed`, carries `output_file` and `usage.total_tokens 16108` |
| 56 | `system/init` (#2) |
| 65 | `control_request/hook_callback` `hook_event_name: Stop`, `background_tasks: []` |
| 66 | **`result` #2** |

`result` #1: `total_cost_usd 0.049362199999999995`, `num_turns 3`, `usage.cache_read_input_tokens
72567`, `subagent_stats.spawned 1 / completed 0`, `terminal_reason "completed"`, **no `origin`
key**, `result` text `"Subagent launched and running in the background. …"`. **[measured]**

`result` #2: `total_cost_usd 0.057083999999999996`, `num_turns 1`, `usage.cache_read_input_tokens
28094`, `subagent_stats.completed 1`, `origin {"kind":"task-notification"}`, `result` text `"done"`.
**[measured]**

`f-b-fanout.sent.ndjson`: 17 lines, exactly one `type:"user"` — "spawn three subagents". **One user
message produced FOUR `result` frames.** **[measured]**

`f-b-fanout.ndjson`, 111 frames. Segment structure, `init` line → `result` line:
`3 → 47`, `73 → 89`, `90 → 102`, `103 → 111`. `system/task_notification` at lines 72, 83, 97.
Three notifications, four results. **[measured]**

| result | line | `total_cost_usd` | `subagent_stats` sp/co | `origin.kind` | `usage.cache_read` | `modelUsage` cache-read (summed) |
|---|---|---|---|---|---|---|
| #1 | 47 | 0.04150675 | 3 / 0 | *absent* | 43,590 | 43,590 |
| #2 | 89 | 0.08040290 | 3 / 2 | `task-notification` | 26,323 | 157,119 |
| #3 | 102 | 0.08681705 | 3 / **3** | `task-notification` | 26,854 | 198,568 |
| #4 | 111 | 0.09091595 | 3 / 3 | `task-notification` | 27,329 | 225,897 |

**The cumulative/per-segment split holds at N=4.** `total_cost_usd` and `modelUsage.*` are monotone
across all four frames; top-level `usage.cache_read_input_tokens` is per-segment (43,590 → 26,323 →
26,854 → 27,329) and is **not** cumulative. **[measured]** This confirms `docs/STATUS.md` §6 and
`docs/research/fanout-vs-children.md:186-188`, which already recorded the same 43,590 → 225,897
sequence.

Result/init counts across every capture in the directory (`.sent`/`.hooks` files excluded).
**[measured]**

```
f-a1-alpha 1/1  f-a2-bravo 1/1  f-a3-charlie 1/1  f-b-fanout 4/4  f-warm 1/1
s1 1/1  s2 1/1  s3 1/1  s4-interrupt 2/2  s5-resume 1/1  s6 1/1
s7-kill 0 results / 1 init  s8 1/1  s9 2/2  s10 1/1
```

`#result == #system/init` in 15 of 16 files. The exception is `s7-kill`, where the child was killed
mid-turn and emitted no `result` at all — an init with no closing result, which is exactly the case
`on_exit` already covers. **[measured]**

## 0b. What this repo already settled

- `docs/research/wall-hooks.md:220-236` already recorded the two-`result` surprise on run 9, the
  five new `system` subtypes, and asserted "**a turn is not over at the first `result`**". It stopped
  at the assertion and proposed no mechanism. **[measured, read at that path]**
- `docs/research/fanout-vs-children.md:182-195` recorded the four-`result` fan-out, that summing
  `result` frames double-counts, and that the accounting field is "the last `result` frame's
  `modelUsage`, summed across model keys" — which is exactly what `ResultView::usage()` computes.
  **[measured]**
- `docs/research/claude-direct-spike.md:87-110,166-179` settled the single-result cases and the
  interrupt's `terminal_reason: aborted_streaming` precedence. It never saw an async subagent; its
  99-frame census has none of the `task_*` subtypes. **[measured]**
- `docs/research/cli-protocol.md` settles hook registration inside `initialize` (§2) and the control
  plane; it says nothing about multiple results. **[measured]**

Adjacent, out of scope, and worth one line to the implementer: `ItemKind::Subagent { task_id,
subagent_type, description }` already exists (`crates/core/src/event.rs:415-422`) and **nothing
emits it** — `system/task_started` decodes to `SystemMessage::Other` and is dropped at
`adapter.rs:522`. Every field it wants is on the frame (`s9` line 31). That is a separate,
contract-free improvement; it is not needed to fix the cost defect. **[measured]**

## A. Detection — the earliest reliable signal that a `result` is not the end

Evaluated against the 6 result frames in `s9` and `f-b-fanout`, plus the 11 single-result captures,
`s4`'s two-results-from-two-user-messages, and `s7-kill`'s zero. 19 result frames in all.

| candidate | verdict |
|---|---|
| `subagent_stats.spawned > completed` | **Fails.** `f-b` result #3 (line 102) reports `spawned 3, completed 3` and a fourth result follows. **[measured]** Correct at `s9`, correct at `f-b` #1 and #2, wrong at #3. Coincidence at N=1. Vendor's own field doc says why: a held-back result "carries the counts as of when it is written to the stream". **[source]** — see §D. |
| `origin.kind == "task-notification"` on the *next* result | **Backward-looking, but it is the field the vendor tells you to key on**, and it reframes the whole problem: this is not one turn with several results, it is several *turns* for one send. **[documented]** It only appears on the continuation result itself, so it cannot pre-warn — but under §B nothing needs to. **[measured + documented]** |
| the second `system/init` | **Correct, and it is the load-bearing one — but it is not predictive.** It always arrives *after* the result it follows (`s9`: 49 then 56; `f-b`: 47 then 73, 89 then 90, 102 then 103). It cannot tell you result #1 is not final; it can tell you a new segment has begun. **[measured]** |
| `system/task_started` | **Not sufficient alone.** It fires at launch (`s9` line 31, `f-b` 3×) and carries `is_backgrounded: true`, but nothing on the stream retires it; a foreground `Task` would presumably emit it too. **[measured for the frame; asserted for the foreground case — not captured]** |
| `system/task_notification` | **Predictive, and each one causes exactly one further result.** `s9`: 1 notification, 2 results. `f-b`: 3 notifications, 4 results. In both, every notification precedes the result it triggers (72<89, 83<102, 97<111, 55<66). **[measured]** But it is silent before the first completion, so it cannot flag result #1. |
| `num_turns` | **Coincidence.** `s9`: 3 then 1. `f-b`: 4 then 1,1,1. It counts assistant turns within the segment; a one-turn first segment is perfectly legal. **[measured]** |
| the `result` text ("… running in the background. I'll wait …") | **Model prose. Not a protocol field.** Never key on it. **[asserted]** |
| `queued_turn_count` | `0` on all 19 result frames in the fixture directory. **[measured]** And now explained: it counts **only** sends the host stamped `origin: {kind:"human"}`, which this harness does not stamp, so it will read `0` forever until it does. **[documented]** — §D. |
| `Stop` hook `background_tasks[]` | **Genuinely predictive and it arrives BEFORE the result** — `s9` line 48 (`Stop`, one running task) precedes result 49, line 65 (`Stop`, `[]`) precedes result 66. **[measured]** **But it is unavailable today**: the production adapter registers only `PreToolUse` (`adapter.rs:326`); `s9` saw it because the spike's own wall registered `Stop`, and `f-b-fanout` — which did not — has **zero** `Stop` callbacks. Using it means registering and answering a `Stop` hook on every turn, on a hook shape `docs/STATUS.md` §6 records as already mis-documented. **[measured]** |

**The only rule that survives all 8 frames** is a conjunction of two undocumented fields:

> more results are coming iff
> `subagent_stats.spawned − completed − failed − killed.* − refused.* > 0`
> **OR** `#system/task_notification seen > #results carrying origin.kind == "task-notification"`.

Checked frame by frame: `f-b` #1 (3 outstanding), #2 (1 outstanding), #3 (0 outstanding but 3
notifications vs 2 consumed), #4 (0 and 0 → final); `s9` #1 (1 outstanding), #2 (0 and 0 → final);
`s4`'s two results carry no `subagent_stats` at all and no notifications → both final, which is
right. **[measured]**

**Do not build on it.** Three reasons, in order of severity:

1. **Unclosable race, and the vendor confirms it.** The CLI's own `subagent_stats` description says
   "a result that was held back while background subagents finished carries the counts **as of when
   it is written to the stream**", so the counts are a snapshot with no ordering guarantee against
   the notification stream. **[source, §D]** In `f-b` result #3 they happened to land 97 then 102 —
   one sample. Invert them and the rule says "final", the turn closes, the next result is dropped
   exactly as today. **[asserted]**
2. **`subagent_stats` is `@internal` and appears in no public type.** Not in `sdk.d.ts` 0.3.251, not
   in either changelog, not on the docs site — only as a bundled zod schema inside the CLI binary,
   whose own description string begins `@internal`. **[source, §D]** It can vanish without a
   changelog line.
3. **`background_tasks_changed` is a level, not an edge**, and its "ordering relative to the
   bookends for the same transition is unspecified", so it cannot be correlated with `task_started`
   / `task_notification` either. **[documented, §D]**
4. It reads three fields none of which are in `claude-wire`'s typed `ResultSuccess`
   (`crates/claude-wire/src/message.rs:634-681` — `subagent_stats`, `origin` and
   `queued_turn_count` all land in the `#[serde(flatten)] extra: Extra` bag). **[measured]**
5. It is more machinery than the fix needs. See §B.

**Answer to A, stated plainly:** there is **no single reliable forward-looking signal**, the
composite one is racy, and — decisively — **the question is the wrong one**. The vendor's own type
comment says the CLI "emits exactly one result message per turn … treat it as the turn-complete
signal" (`sdk.d.ts:4830`, **[source, §D]**). A finished background subagent does not add a result to
your turn; it makes the CLI run **a new turn you never sent**, stamped
`origin: {kind:"task-notification"}` on both the injected `user` message and its `result`
(**[documented, §D]**). `s9`'s two results are two turns from one send, not two results from one
turn. So the design should not predict finality at all — it should **stop assuming one send equals
one turn**.

## B. What closes the turn

**Recommendation: treat each `system/init` that arrives with no open turn as the start of a
continuation turn.** Concretely, and this is a description of behaviour, not a patch:

- `on_init` (`adapter.rs:531`) already returns early once `session_started` is true. In that early
  return, when `self.open_turn.is_none()`, mint a `TurnId` (the adapter already mints one this way
  for the `prompt` path, `adapter.rs:300`) and emit `Event::TurnStarted`.
- `on_result`'s body below the guard is unchanged. It takes the open turn — which is now the
  continuation turn — and emits `TurnCompleted` with `view.usage()` and `view.total_cost_usd`, both
  cumulative, both already correct.
- **Belt and braces, and it is the part that must not be skipped:** in `on_result`, replace the
  early `return` at `adapter.rs:680-683` with the same mint. A `result` that arrives with no open
  turn emits `TurnStarted` and then `TurnCompleted` back to back, rather than being dropped. That
  makes "no result frame is ever discarded" true by construction, independent of whether the
  `init` invariant holds on some future CLI version. It is four lines and it is the actual fix;
  the `init` hook is what makes the *busy* signal honest.
- Nothing else changes. No new `Event` variant, no new field, no timer, no predicate.
- `origin.kind` is worth a `tracing::debug!` on the minted-turn path, so a capture shows whether a
  continuation was a `task-notification` or the documented `auto-continuation`. **Do not branch on
  it** — the design works without knowing the kind, and a whitelist would break on the next one.

This is the vendor's own model, not an invention: one result per **turn**, and a finished background
subagent produces a turn the host never sent (`sdk.d.ts:4830`, and the `origin` docs — §D).

Why this one:

- It rests on the strongest thing measured: `init` and `result` alternate one-for-one in 16 of 16
  captures. **[measured]**
- It never guesses. A turn is open exactly while the CLI is inside a segment.
- The store already does the right thing with repeated `TurnCompleted`s: `set_usage` is a whole-row
  overwrite, not a sum (`crates/store/src/feed.rs:162-166`, `crates/store/src/writer.rs:113`), so
  the last cumulative number wins. **[measured]**
- It fixes finding 5 for free: `open_turn` is `Some` for the whole continuation segment, so
  `SendTurn` is refused while the CLI is genuinely working, and a subagent's `can_use_tool` gets a
  real `turn_id` instead of `None` (`adapter.rs:804`).

**Its failure mode**, said outright: an `init` emitted for some reason *other* than a turn would
mint a phantom turn that stays open until the next `result` or until exit. Nothing in the 16
captures does that, but the CLI's init-per-turn behaviour is a measured observation
(`docs/research/claude-direct-spike.md`, and `docs/plans/ipc-contract.md` states it in the resume
section), not a documented contract. The blast radius is bounded: one spurious `turn-started`
signal, `SendTurn` refused with "a turn is already open" until the next result, and `on_exit`
clearing it. **[asserted]**

**The two rejected alternatives**, for the implementer's record:

- *Defer `TurnCompleted` until the last result.* Needs §A's racy predicate **and** a wall-clock
  backstop, because a subagent that is killed or fails may produce no further result at all — the
  Stop-hook capture shows a task can sit `running` indefinitely, and `on_exit` (`adapter.rs:1034`)
  is the only backstop today. A killed session already produces zero results (`s7-kill`,
  **[measured]**), so the timeout would have to be a genuine timer on `open_turn`, a new piece of
  state the adapter does not have. More code, worse guarantee.
- *A new interim event carrying the interim accounting.* This is an `ipc-contract.md` change (a new
  `event.type` in the Signal-events list, a new arm in `src/wire.ts` and `src/feedStore.ts`) bought
  for nothing: the interim numbers are a prefix of the final cumulative ones and get overwritten
  anyway.

**Backstop the design still needs:** none beyond what exists, *if* the recommendation is taken.
`on_exit` closes any turn left open, which covers kill, crash and a subagent that never finishes,
because a never-finishing subagent leaves the session between segments — turn closed, session
idle, operator free to send — rather than inside one. **[asserted, from the segment structure
measured above]** If a future capture ever shows an `init` with no matching `result` outside the
kill path, that assertion is void and a timer is required.

## C. Cost and usage arithmetic

Nothing changes. Stated field by field so the implementer does not "fix" it:

- **Cost:** `TurnCompleted.cost_usd_cumulative = result.total_cost_usd` of the frame being
  processed, verbatim (`adapter.rs:693`). It is cumulative across results within a child, so the
  latest frame is the true total. **Never sum result frames** — `docs/STATUS.md` §6, and the
  measured monotone sequences above. The store overwrites (`feed.rs:162`), so processing every
  result frame leaves the row holding the last one. **[measured]**
- **Usage:** keep `ResultView::usage()` as written (`adapter.rs:1264-1290`) — sum across the keys of
  `modelUsage` for a *single* frame, never across frames. `modelUsage` is the accounting field and
  it is cumulative; top-level `usage` is per-segment and is only the fallback when `modelUsage` is
  absent. **Do not sum `usage` across segments.** Doing so would produce 72,567+28,094 = 100,661
  for `s9`, against the true 115,395 — wrong in both directions at once (it misses the subagent's
  own tokens and would double-count on any resumed frame). **[measured]**
- **`SessionView.usage` in `docs/plans/ipc-contract.md`:** unchanged in shape and unchanged in
  meaning. It is already documented as cumulative across resumes and it stays that.
- **Interaction with the resume rebasing** (`crates/supervisor/src/lib.rs:215-249`,
  `Accrued::rebase`): the rebase adds the row's stored base to *every* `TurnCompleted` envelope it
  sees, unconditionally. Emitting a `TurnCompleted` per result frame therefore stays correct — each
  one is (base + that child's cumulative total), each overwrites the last, and the row only ever
  climbs. **The recommendation does not touch the rebasing and does not need to.** The one thing
  that would break it is summing across result frames on the adapter side, which is precisely what
  is being avoided. **[measured, by reading `rebase` and `set_usage`]**

Numbers the fix recovers, per fixture. **[measured]**

| fixture | stored today | true | under-count |
|---|---|---|---|
| `s9` cost | $0.0493622 | $0.0570840 | 13.5% |
| `s9` cache-read tokens | 72,567 | 115,395 | 37.1% |
| `f-b-fanout` cost | $0.0415068 | $0.0909160 | 54.3% |
| `f-b-fanout` cache-read tokens | 43,590 | 225,897 | 80.7% |

## D. Vendor truth

All web fetches **2026-09-02**. Local `claude` is **2.1.258**, a compiled bun Mach-O binary at
`/Users/stephen/.local/share/claude/versions/2.1.258` — there is no `cli.js` and no
`@anthropic-ai/claude-code` in any global `node_modules`. A full `sdk.d.ts` for
`@anthropic-ai/claude-agent-sdk@0.3.251` (413 KB, 8,562 lines) is on this machine at
`~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.3.251@@@1/sdk.d.ts`. **[measured]** The SDK
is not a dependency of this harness (`CLAUDE.md` §2); it is read here for wire shapes only.

Sources: [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) ·
[Agent SDK CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) ·
[Agent SDK reference — TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) ·
[Subagents](https://code.claude.com/docs/en/sub-agents) ·
[Environment variables](https://code.claude.com/docs/en/env-vars) ·
[Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking) ·
[Streaming vs single mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

### D1. Background subagents are documented, and they are the default

- Async subagents landed in Claude Code **2.0.64**: "Agents and bash commands can run asynchronously
  and send messages to wake up the main agent." **[documented, CHANGELOG]**
- **2.1.198** made background the default: "Subagents now run in the background by default, so
  Claude keeps working while they run and is notified when they finish." **2.1.232** widened it to
  non-teammate spawns in interactive sessions. **[documented, CHANGELOG]**
- The selection rule is spelled out, first case wins: teammate subagent → foreground;
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` → foreground always; fork mode on → background and
  "Claude can't ask for the foreground"; fork mode off (the default for `-p` and the SDK) →
  background by default. **[documented, /en/sub-agents]**
- **There is a kill switch.** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` "disable[s] all background
  task functionality, including the `run_in_background` parameter on Bash and subagent tools,
  auto-backgrounding, and the Ctrl+B shortcut", from CLI **2.1.4**. **[documented, /en/env-vars]**
  Confirmed in the binary: the Agent tool's schema factory omits `run_in_background` when it is set.
  **[source, binary 2.1.258]**
- Related knobs: `CLAUDE_CODE_FORK_SUBAGENT=0`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20),
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3). `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` was
  removed in 2.1.224 and is a no-op. **[documented]**

**Consequence for this harness, and it is a genuine option:** setting
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the child's environment would make one send equal one
turn again and retire the defect by removing the feature. `docs/vision.md` §6 already routes around
the `Agent` tool by spawning workers as brigadier's own children, so the capability is not being
sold. **This file does not recommend it** — it hides an under-count rather than fixing it, it
silently changes what the model can do, and the §B fix is four lines. Raise it with the owner as a
separate decision; it is not the adapter's call. **[asserted]**

### D2. `origin` is documented, and it is exactly this case

- Added in Agent SDK **0.2.126**: "Added `origin` to result messages (`SDKResultSuccess` /
  `SDKResultError`) — forwards the triggering message's `SDKMessageOrigin` so consumers can
  distinguish user-prompted results from `task-notification` followups." **[documented, SDK
  CHANGELOG]**
- The reference page: "When the SDK injects a synthetic follow-up turn, such as for a finished
  background task, the resulting `SDKResultMessage` carries `origin: { kind: "task-notification" }`
  … Check `kind` to distinguish results that answer your prompt from injected follow-ups before
  routing or suppressing them. The field is absent for results emitted before any user turn."
  **[documented, /en/agent-sdk/typescript]**
- And explicitly: "To detect a task-notification turn, check `origin.kind === "task-notification"`
  … **rather than matching on the notice text**." **[documented]** That retires the `result`-text
  candidate in §A on the vendor's own authority.
- **Why `s9` result #1 has no `origin` at all:** "Claude Code treats a user message with no `origin`
  as unattributed." The harness does not stamp `origin` on its outgoing `user` frame, so the result
  comes back unstamped. **[documented]** Diffing the two frames' key sets confirms `origin` is the
  *only* schema difference between `s9` result #1 and #2. **[measured]**
- `kind` values: the docs list 7 (`human`, `channel`, `peer`, `task-notification`, `coordinator`,
  `auto-continuation`, `unclassified`); `sdk.d.ts:4501-4560` carries 9 — those plus `observer` and
  `observer-activity`. `task-notification` has an optional `subkind`, and a finished background task
  carries **no** `subkind`. **[documented + source]**
- `auto-continuation` is a **second** documented way a result can arrive with no fresh user prompt.
  The §B design handles it without knowing about it, which is the point of not keying on a
  whitelist. **[documented]**

### D3. `subagent_stats` is `@internal` and in no public type

- Zero hits across the whole docs corpus, both changelogs, and `sdk.d.ts` 0.3.251. It exists only as
  a bundled zod schema in the 2.1.258 binary, and its own description string begins `@internal`.
  **[source, binary]**
- The field set matches the captures exactly (`spawned`, `requested{background,foreground,unset}`,
  `started_in_background`, `max_depth`, `spawned_by_subagents`, `completed`, `failed`,
  `killed{parent,user,system}`, `refused{depth_limit,concurrency_limit,budget}`, `by_type`).
  **[source]**
- Two lines from its own description that decide §A: it is "cumulative like modelUsage: read the
  latest result rather than summing", and "**a result that was held back while background subagents
  finished carries the counts as of when it is written to the stream**, as do its `total_cost_usd`,
  `duration_api_ms` and `modelUsage`". **[source]** The second is the race. It also notes
  `completed`/`failed`/`killed` **can exceed `spawned`** after a mid-session `/clear`, which would
  make a subtraction-based predicate go negative.

### D4. `queued_turn_count` — the CLI queues, it does not error

- Added in Agent SDK **0.3.243** (the reference page says 0.3.242; the one-version discrepancy is
  unresolved). **[documented]**
- Queueing is a documented property of streaming-input mode: "**Queued messages**: send multiple
  messages that process sequentially, with ability to interrupt."
  **[documented, /en/agent-sdk/streaming-vs-single-mode]** Nothing in the docs or the type
  declarations describes an error for a `user` frame written mid-turn.
- `sdk.d.ts:4793-4795`: "User-initiated sends still waiting in the command queue when this result
  was produced. Greater than 0 means at least one more user turn (and result) follows without
  further input … **Queued sends may coalesce into fewer turns, so this counts pending sends, not
  remaining results.**" **[source]**
- **It counts only sends stamped `origin: {kind:"human"}`.** The docs' own zero case: "Claude Code
  doesn't count messages you sent without that `origin`, and doesn't count task notifications, so a
  turn can still follow." **[documented]** That is why all 19 captured frames read `0`, and it means
  the field is useless to this harness as written.

**So the answer to the `SendTurn`-guard question:** with the defect present, an operator who sends
during the subagent phase gets the turn **queued** by the CLI, not rejected — a *documented*
behaviour, still **not measured on this machine**. Under §B the guard closes for the duration of
each continuation segment and the send is refused locally with "a turn is already open" instead,
which is the safer of the two and is what the adapter already promises.

**Adjacent, separable, recommended:** stamp `origin: {"kind":"human"}` on the outgoing `user` frame.
`claude-wire`'s `SdkUserMessage` (`crates/claude-wire/src/input.rs:34-48`) has neither an `origin`
field nor a top-level `#[serde(flatten)] extra` bag, so this is a small addition to that struct —
**a `claude-wire` change, not an `ipc-contract.md` change**. **[measured]** It buys a *positive*
discriminator on every result instead of inferring from an absent key, and makes `queued_turn_count`
mean something. It is **not required** by the §B fix; do it as its own work order.

### D5. Cumulative vs per-segment is documented

The cost-tracking page, §"Track costs in streaming input mode":

> "In streaming input mode, one `query()` call carries multiple user turns and each turn emits its
> own result message. The result fields differ in scope: **`usage`**: covers only that turn, and
> within it only the main agent loop, not any subagents it ran. **`total_cost_usd` and
> `modelUsage`**: carry the running total for the whole call so far."

**[documented, /en/agent-sdk/cost-tracking]**, with a table stating `usage` excludes subagent
activity while `total_cost_usd` and `modelUsage` include it; documented in the SDK changelog at
**0.3.223**. Mirrored at `sdk.d.ts:4784` (`usage` — "MAIN AGENT LOOP ONLY … Prefer modelUsage") and
`:4788`. **[source]** This is `docs/STATUS.md` §6 and §C of this file, independently confirmed.

`sdk.d.ts:4830`: "The CLI emits **exactly one result message per turn** … treat it as the
turn-complete signal (informational system messages such as task notifications, session state
changes or prompt suggestions may still follow it)." **[source]** There is **no** documented
sentence of the form "one user message may produce several results" — it has to be inferred from
this plus the `origin` text. Said plainly: the vendor documents N turns per send, never N results
per turn.

### D6. The five `system/task_*` subtypes are all documented

All on `/en/agent-sdk/typescript`, all with matching declarations in `sdk.d.ts` 0.3.251:
`task_started` = `SDKTaskStartedMessage` (`:5060`, SDK 0.2.45; `is_backgrounded` added 0.3.238),
`task_progress` = `SDKTaskProgressMessage` (`:5038`, 0.2.51),
`task_updated` = `SDKTaskUpdatedMessage` (`:5096`; `status ∈ pending|running|completed|failed|
killed|paused`; no changelog entry for its introduction),
`task_notification` = `SDKTaskNotificationMessage` (`:5016`; `status ∈ completed|failed|stopped`),
`background_tasks_changed` = `SDKBackgroundTasksChangedMessage` (`:3269`, SDK 0.3.203 / CLI 2.1.203).
`task_type` values: `local_bash`, `local_agent`, `remote_agent`, `local_workflow`.
**[documented + source]**

Two type comments that matter to any future timeline work: `background_tasks_changed` is a **level,
not an edge** — "replace their set with each payload rather than pairing edges" — and "ordering
relative to the bookends for the same transition is unspecified … do not correlate it with the edge
stream". Also, "nothing is emitted at startup, so consumers must reset to the empty set whenever the
session's CLI process (re)starts". **[source, sdk.d.ts:3269]**

### D7. What `docs/research/agent-sdk.md` already had, and its three gaps

That file's §6 already transcribes all five task subtypes with correct field lists (lines 292-296),
the full `SDKResultSuccess` field set (line 271), the cumulative rule (312-313), and
`queued_turn_count` (319). Gaps found by this pass: **`subagent_stats` is absent entirely** (0 hits,
expected — it is `@internal`); **`origin: {kind:"task-notification"}` is absent** — `origin` appears
only as a field name on `SDKUserMessage` and the string "task-notification" appears zero times,
which is the single most important omission for this defect; and it **nowhere says a finished
background subagent injects a turn the host never sent**, nor that `queued_turn_count` counts only
`origin:{kind:"human"}` sends. **[measured, by the research pass reading that file]** Correcting
those three points in `agent-sdk.md` is a separate, small edit and is not part of the fix.

## E. Test shape

The harness exists: **`crates/core/tests/claude_adapter.rs`**. It replays a fixture's stdout lines
into the adapter over `tokio::io::duplex` pipes, rewriting only a `control_response`'s `request_id`.
Reuse it; do not invent one. **[measured]** Relevant seams:

- `fixture_lines(name)` — `claude_adapter.rs:34`, reads `crates/claude-spike/fixtures/<name>`.
- `Rig::start(fixture, event_buffer)` — `:63`, consumes the fixture's line 1 as the `initialize`
  `control_response`. Both `s9-subagent-agent-id.ndjson` and `f-b-fanout.ndjson` have a
  `control_response` on line 1, so both work unmodified. **[measured]**
- `Rig::send_turn()`, `Rig::feed(n)` (`:137`), `Rig::feed_rest()` (`:150`), `Rig::next_event()`,
  `rig.collected`, and the label helper used by `s1`/`s2`.
- Model the assertion on the existing cost check at `claude_adapter.rs:360-368`, which already
  pulls `cost_usd_cumulative` out of the first `TurnCompleted`.

The two tests to write:

1. `s9_a_background_subagent_produces_a_second_turn` — `Rig::start("s9-subagent-agent-id.ndjson",
   64)`, `send_turn()`, `feed_rest()`. Expect **two** `TurnCompleted` events. Assert the **last**
   one has `cost_usd_cumulative ≈ 0.057_084` (not `0.049_362`) and `usage.cache_read_tokens ==
   115_395` (not `72_567`), and that a `TurnStarted` was emitted between them whose `turn_id` is the
   second `TurnCompleted`'s and is **not** the id passed to `send_turn`.
2. `f_b_fanout_reports_the_last_of_four_results` — same shape on `f-b-fanout.ndjson`. Expect **four**
   `TurnCompleted`, the last with `cost_usd_cumulative ≈ 0.090_916` and `usage.cache_read_tokens ==
   225_897`. This is the one that catches a `spawned > completed` implementation, which would stop
   at result #3 and report `0.086_817`.

**The existing `s4` test is the guard against over-firing.** `s4_interrupt_then_a_second_turn`
(`claude_adapter.rs:486`) calls `rig.send_turn()` *before* `feed_rest()` delivers `system/init` #2,
and asserts the label sequence contains exactly one `turn-started` there with the comment "the
second `system/init` carries the same session id and emits nothing". Under the §B recommendation
`open_turn` is already `Some` at that point, so the guard `open_turn.is_none()` holds and the test
must keep passing unchanged. If it starts failing, the mint condition is too loose. **[measured]**

A regression guard worth adding to test 1: after `feed_rest()`, `send_turn()` must be **rejected**
while the continuation segment is open and accepted once its result has landed — the inverse of the
existing `a_second_turn_while_one_is_open_is_rejected` (`claude_adapter.rs:690`).

## What was NOT checked

- **§D was gathered by a delegated research pass, not by the author of §0–§C.** The URLs, the
  `sdk.d.ts` line numbers and the strings quoted out of the 2.1.258 binary were not independently
  re-opened here. Treat §D's `[documented]` and `[source]` tags as one reader's transcription; §0–§C
  were run command by command on this machine. Re-verify any §D line before it becomes load-bearing.
- **No `claude` process was run for this file.** Every frame cited is from a capture on disk.
- **Nothing was compiled or executed** — no `cargo test`, no `cargo check`. The recommendation is
  read from source, not proved by a build.
- **Whether the CLI queues or rejects a `user` frame written while a background subagent is
  running.** The docs say it queues (§D4) and this was **not measured**: `queued_turn_count` is `0`
  on all 19 captured result frames because the harness never stamps `origin:{kind:"human"}`, so the
  path was never exercised on this machine.
- **Whether a `task_notification` can arrive *after* the result whose `subagent_stats` already
  counts it.** One sample each way is not evidence; this is the race that sinks §A's composite rule.
- **Whether `system/init` can ever arrive without a following `result`** outside the kill path.
  Zero counter-examples in 16 captures is not a proof.
- **A foreground (non-backgrounded) `Task`.** Every captured `task_started` has
  `is_backgrounded: true`; the single-result foreground shape is unobserved here.
- **The `Stop` hook route was not prototyped** — it is described from `s9`'s capture only, and the
  production adapter would have to start registering `Stop` for it to exist at all.
