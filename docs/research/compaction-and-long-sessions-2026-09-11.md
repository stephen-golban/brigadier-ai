# Compaction and very long sessions — end-to-end trace, 2026-09-11

Question asked: "we don't have any context compaction at all and a user will never see a context
compaction." Treated as a claim to verify.

Every claim below is marked **[measured]** (read today in this worktree, with `path:line`) or
**[asserted]** (taken from a prior doc, not re-derived). Worktree
`/Users/stephen/Development/brigadier-ai.worktrees/codex-thread`, branch `ui/codex-thread`, at
`759eb5a`. Nothing was run: no build, no test, no burn.

> **Corrected later the same day — see Addendum 3 at the end.** §§5–7 were written before anyone
> checked whether the interactive session accumulates at all. It does not: every user message kills
> the `claude` child and spawns a fresh one with no `--resume`
> (`docs/research/does-a-session-accumulate-2026-09-11.md`, measured). The measurements below are
> unaffected — they were taken inside one child's lifetime — but "compaction" here means a
> **within-turn** event, never a conversation-long one. Addendum 3 says which of §7's
> recommendations survive.

## 0. Verdict

The claim is **half wrong and half right, and the halves are not the ones you would guess.**

- **Compaction is plumbed end to end.** Wire decode → `Event::SessionCompacted` → a `Notice` item
  in the store → a rendered `InlineNotice` reading "Context automatically compacted". Every link
  exists. **[measured]**
- **Nobody has ever seen it fire.** Zero of the 40 recorded capture files in
  `crates/claude-spike/fixtures/` contain a `compact_boundary` frame, and the one wire fixture that
  does is hand-written and says so in its own first line. **[measured]** So the owner is right that
  a user has never seen a compaction — but the reason is missing *evidence*, not missing code.
- **The context meter is built, wired to a real CLI control, tested — and mounted nowhere.**
  `src/components/SessionContext.tsx` is a `<meter>` plus a token popover. Its only importer is its
  own test. **[measured]** This is the real gap, and it is the smallest one to close.
- **The usage-window gauge is in the same state**: the store keeps the windows, no component reads
  them. **[measured]**

So: compaction is plumbed but unproven; the context meter is complete but unmounted.

## 1. What `docs/research/long-sessions.md` still gets right

Re-read today. Its architecture verdict (fresh sessions + files + a commit per phase, sell
continuity not session length) is the settled line in `CLAUDE.md` §2 and `docs/vision.md`, and
nothing in this tree contradicts it. **[asserted]**

Two of its statements are now **superseded by code in this tree**:

- "**PreCompact hook** is the ONLY programmatic seam into compaction." False for brigadier. The CLI
  exposes a `get_context_usage` control request, brigadier already sends it, and the reply carries
  `autoCompactThreshold` — the compaction trigger point, readable on demand without a hook.
  `crates/core/src/claude/adapter.rs:1710-1711`; measured reply in
  `docs/research/rewind-context-2026-09-05.md` "Current context usage". **[measured]**
- "Does NOT exist: … no `/context` equivalent." False. That is exactly what
  `get_context_usage` is. **[measured]**

Its caution that `usage`/`modelUsage` are cumulative and must not drive a context meter is correct
and is repeated, with the receipts, in `docs/STATUS.md` §7 and
`crates/core/src/claude/adapter.rs:2363-2366`. **[measured]**

## 2. Does the CLI tell us? — decoded from a type file, never observed

### The frame brigadier expects

`crates/claude-wire/src/message.rs:236-267` defines `SystemCompactBoundary` /`CompactMetadata`:
`trigger`, `pre_tokens`, `post_tokens`, `duration_ms`, plus a flattened `extra`. Every doc comment
cites `sdk.d.ts:3378`, i.e. the Agent SDK's TypeScript declarations — **not** a capture. **[measured]**

`crates/core/src/claude/adapter.rs:856-869` maps it:

```rust
SystemMessage::CompactBoundary(boundary) => {
    let trigger = match boundary.compact_metadata.trigger.as_str() {
        "manual" => CompactTrigger::Manual,
        _ => CompactTrigger::Auto,
    };
    let pre_tokens = boundary.compact_metadata.pre_tokens;
    self.emit(Event::SessionCompacted { trigger, pre_tokens }, Some(raw));
}
```

`Event::SessionCompacted` is defined at `crates/core/src/event.rs:285-291` and its comment points at
`docs/research/agent-sdk.md` §6, again a type file. **[measured]**

### The evidence check

| Probe | Result |
|---|---|
| `grep -c compact_boundary crates/claude-spike/fixtures/*.ndjson` | **0 in all 40 files** **[measured]** |
| The 5–11 `compact` hits per fixture | all from the CLI's own slash-command catalog: `autocompact`, `compact`, "Configure the auto-compact window size" **[measured]** |
| `grep -c '"subtype":"status"' …/fixtures/*.ndjson` | **0 files** — no `system/status` frame was ever recorded either **[measured]** |
| `crates/claude-wire/tests/fixtures/system_compact_boundary.json:1` | `// hand-written from sdk.d.ts:3378; replace with a real capture from crates/claude-spike when available` **[measured]** |

Plainly: **no recorded capture contains a compaction.** The decode is aspirational in the precise
sense that it has never met a real frame. The test at `crates/claude-wire/tests/decode.rs:172` and
the round-trip at `crates/core/tests/claude_adapter.rs:326` both exercise the synthetic fixture.

### The live signal brigadier throws away

The CLI also has `system`/`status` with `status: "compacting" | "requesting" | null`, plus
`compact_result` / `compact_error` in `extra`. brigadier decodes it —
`crates/claude-wire/src/message.rs:325-345` — and then **discards it**:

```rust
SystemMessage::Hook(_)
| SystemMessage::Status(_)
| SystemMessage::PermissionDenied(_)
| SystemMessage::Other(_) => {}
```
`crates/core/src/claude/adapter.rs:874-878` **[measured]**

So even if compaction fires, there is no *in-progress* indicator; the first and only sign is the
after-the-fact boundary row. The comment calls `status` "informational" — for `permission_denied`
that is argued from `result.permission_denials`; for `status` nothing argues it.

### Manual compaction is refused

`crates/core/src/claude/adapter.rs:1589-1594` rejects `NativeControl::Compact` outright:
`"Native compaction control is not implemented by the Claude SDK adapter"`. **[measured]**
And `src-tauri/src/composer.rs:977` explicitly filters `compact` out of the advertised slash-command
catalog, while re-adding only `stop` and `context` as `execution:"control"` rows
(`src-tauri/src/composer.rs:972-975`). **[measured]** A user cannot type `/compact` in brigadier.
The Codex adapter *does* implement it (`crates/core/src/codex/adapter.rs:444-463`), so the asymmetry
is deliberate, not an oversight.

**Unknown.** Whether the Claude Code CLI emits `compact_boundary` on the stdio control lane at all,
and whether `pre_tokens` is populated when it does. The protocol research
(`docs/research/cli-protocol.md`, `docs/research/cli-steer-and-exit-codes.md`) does not mention
compaction anywhere — grep confirmed. **[measured]** See §7 WO-5 for the cheap experiment.

## 3. Does the store keep it? — yes, both projections

`crates/store/src/chat.rs:147-164` mints the transcript item:

```rust
Event::SessionCompacted { trigger, pre_tokens } => {
    Some((format!("{session}:notice:compacted:{seq}"),
          ItemKind::Notice { level: NoticeLevel::Info,
                             code: "compacted".to_owned(),
                             detail: pre_tokens.map(|n| json!({ "pre_tokens": n })) },
          trigger.to_owned()))
}
```
**[measured]** The id is deterministic, so a replay cannot duplicate the row
(`crates/core/src/event.rs:487-492`). The **body carries the trigger word** (`auto` / `manual`) —
the only field the event has to hold a discriminator.

`Notice` is the item kind added yesterday. Compaction is the *first* of its three codes; the others
are `runtime` (from `RuntimeWarning` / `RuntimeError`) and `exited`
(`crates/store/src/chat.rs:165-195`). **[measured]**

The feed gets its own row, independently: `crates/store/src/feed.rs:119` classes
`Event::SessionCompacted` as `FeedKind::Sys`, and `feed.rs:205-217` writes
`"context compacted · auto · 180000 tokens before"`. **[measured]**

## 4. Does the UI show it? — yes, and it is reachable in production

| Link | Evidence |
|---|---|
| Wire type | `src/wire.ts:95-101` (`notice` item, `code`, `detail`), `:182` (`session-compacted` event) **[measured]** |
| Feed store | `src/feedStore.ts:515-520` — sets `lastMessage: "context compacted (auto)"` on the session card **[measured]** |
| Projection | `src/threadProjection.ts:356-410` — `emitNotices` pushes a `notice` row in `seq` order; a mid-turn notice is *held* until the open turn flushes so it never splits a work row (`:375-382`) **[measured]** |
| Render | `src/components/ThreadView.tsx:283-306` `NoticePart` → `InlineNotice`; `:326-334` `noticeSentence("compacted", "auto")` → **"Context automatically compacted"**, `"manual"` → **"Context compacted"** **[measured]** |

**The previous worker's "unreachable from the fixture" is correct, and only about the fixture.**
`src/mock.ts` emits no `session-compacted` event (grep: the word `compact` appears there once, in
prose inside a demo assistant message at `src/mock.ts:142`). **[measured]** So the browser demo can
never produce the row. In production the path is complete and reachable — conditional only on the
CLI actually sending the frame, which §2 says nobody has confirmed.

Coverage gap worth naming: `"compacted"` appears in `src/` **only inside `ThreadView.tsx` itself**.
`src/threadProjection.test.ts:548` builds a notice with code `"runtime"` and body
`"context compacted"` — a different code path. So the compaction row has no test. **[measured]**

## 5. Token usage and the approach to a limit

### What is *not* usable

`Usage { input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_window }`
(`crates/core/src/event.rs:580-597`) is **cumulative across the session**
(`crates/core/src/claude/adapter.rs:2363-2366`; `docs/research/agent-sdk.md:54-56`). **[measured]**
`docs/STATUS.md` §7 records the handoff wall being killed for exactly this reason — summing the four
counters gives lifetime spend, and the old wall "would have fired after ~7 turns on a session using
100k of a 1M window." **[measured]** `Supervisor::context_status`
(`crates/supervisor/src/lib.rs:1783-1794`) survives as telemetry off that row, gates nothing, and is
**not exposed through any Tauri command** (grep of `src-tauri/src/` for `context_status`: no hits).
**[measured]**

`contextWindow` *is* captured — `crates/core/src/claude/adapter.rs:2378-2379` takes the max across
`modelUsage` entries, and every recorded fixture carries `"contextWindow":200000`. **[measured]**
That is the denominator, but the numerator is the wrong number.

### What *is* usable, and already built

`NativeControl::ContextSummary` (`crates/core/src/session.rs:214-215`, documented as "Current
context estimate; never cumulative billing usage") sends
`{"subtype":"get_context_usage","detail":"summary"}`
(`crates/core/src/claude/adapter.rs:1710-1711`). **[measured]**

Measured reply from CLI 2.1.261, recorded in `docs/research/rewind-context-2026-09-05.md`:
`totalTokens:25315`, `rawMaxTokens:1000000`, `maxTokens:1000000`, `percentage:3`,
`model:"claude-opus-5[1m]"`, `autoCompactThreshold:967000`, `autocompactSource:"model-default"`.
**[asserted — that doc's measurement, not re-run today]**

The full chain exists:

1. `src-tauri/src/conversation.rs:57-91` — `#[tauri::command] session_context`, returns
   `{available, used, limit, model, estimated:true, sampledAt}`. Refuses while a rewind is pending.
   **It reads only `totalTokens` and `maxTokens`** — `autoCompactThreshold` and `percentage` are
   dropped. **[measured]**
2. `src/sessionApi.ts:24-29` — `sessionApi.context(sessionId)`; returns
   `{available:false, reason:"Demo session has no live provider telemetry"}` off the desktop.
   **[measured]**
3. `src/components/SessionContext.tsx` — a `<meter>` showing `"62%"`-style percent, polling every
   8 s while busy and 30 s when idle, with a popover reading
   `"≈ 25,315 / 1,000,000 tokens"` and the caveat
   `"Provider estimate · Includes instructions and tools"`. **[measured]**

**And it is mounted nowhere.** `git grep SessionContext` on `HEAD` and on `main` returns only
`SessionContext.tsx`, `Dock.rewind.test.tsx`, and a passing mention in a comment at
`src/components/controls/overlay.tsx:350`. **[measured]** `git log -S "<SessionContext"` shows the
JSX element last touched in `42c5144` "Redesign composer controls and durable execution settings".
**[measured]** The composer redesign dropped the meter and nothing put it back.

So the answer to "what would brigadier need to show a Codex-style context meter" is: **nothing new.
Re-mount one component.** The data exists, the control exists, the command exists, the component
exists.

The usage-window gauge is in the identical state: `Event::UsageWindows` reaches
`src/feedStore.ts:441-445` → `recordUsageWindows`, with a `useSyncExternalStore`-shaped selector
`getUsageWindows` at `:182-184` and tests at `src/feedStore.test.ts:1244-1288` — and **no component
in `src/` reads it** (grep of `src/**` excluding `feedStore.ts`, `wire.ts`, `mock.ts` and tests:
no hits). **[measured]**

Product rule respected throughout: `session_context` returns tokens and a model name, never a
dollar figure; `SessionContext.tsx` prints neither. **[measured]**

## 6. What actually happens to a very long session today

| Boundary | Value | Behaviour past it |
|---|---|---|
| Feed ring | `ROW_CAP = 2000`, `src/feedStore.ts:83` | Trimmed from the head, `buf.slice(buf.length - ROW_CAP)` at `:354`, `:921`, `:1074`. Rows past 2,000 are **gone from the frontend feed**. **[measured]** |
| Chat history window | `HISTORY_WINDOW = 600`, `src/conversationHistory.ts:3` | `rows.slice(-600)` for `'latest'`, `rows.slice(0,600)` for `'older'` (`:12`). A merge keeps 600 in memory. **[measured]** |
| Store page | `limit.clamp(1, 100)`, `crates/store/src/chat.rs:374` | Max 100 items per request; `has_more` drives paging. **[measured]** |
| Turn lookup | `LIMIT 600`, `crates/store/src/chat.rs:91` | At most 600 lifecycle spans overlapping a visible range (`crates/store/src/writer.rs:332`). **[measured]** |
| Full history load | `if all.len() >= 2000 { return }`, `src-tauri/src/conversation.rs:37-52` | The rewind-planning load stops at 2,000 items. **[measured]** |
| SQLite retention | **none for `chat_items` or `feed`** | `crates/store/src/lib.rs:274-276`: "The crate's first retention rule, and `intents` is the only table that needs one." Only settled intents age out. **[measured]** |

**Item 601:** still on disk, still correct. The frontend shows the newest 600; scrolling up pages
`direction:'older'` back through `history_page` in 100-item pages. Nothing is lost, nothing is
silently truncated — the window is a view, not a cap. **[measured]**

**Item 60,000:** same answer for correctness, with two costs nobody has measured. `chat_items` and
`feed` grow without bound; the only protection is a size warning
(`crates/store/src/lib.rs:288-292`, `tracing::warn!("store is large")`) that no UI surfaces. The
rewind path's 2,000-item load ceiling means a rewind target older than 2,000 items back is not
findable. **[measured — the code; the performance cost is unmeasured]**

**`--resume`:** `resume_token` = `system/init.session_id`
(`crates/core/src/claude/adapter.rs:539-548`), put in argv at
`crates/core/src/claude/process.rs:101-104`, kept in the `sessions` row
(`crates/store/src/schema.rs:62-85`). `SessionView` deliberately exposes no `resume_token`
(`docs/research/resume.md:217-220`). Cumulative usage and cost **restart at zero** on a resume
(`crates/core/src/claude/adapter.rs:2364` comment; `docs/research/agent-sdk.md:56`). **[asserted
from resume.md + measured comments]** `get_context_usage` is unaffected — it asks the live CLI.

**When the CLI's context fills:** the harness does not detect it. There is no threshold check, no
pre-emptive warning, and no string match anywhere in the tree for a context-overflow error (grep for
`prompt is too long` / `context limit` / `context_length` / `max_tokens exceeded` across `*.rs`,
`*.ts`, `*.tsx`: no hits). **[measured]** A *subscription* rate-limit rejection is handled —
`crates/core/src/claude/adapter.rs:673-682` turns `rate_limit_event` with `status:"rejected"` into
one sentence: *"Provider usage limit reached on the {window} window; requests are being rejected
until it resets"* — which becomes a `Notice` warning row. **[measured]** That is a different limit.

## 6b. What a user sees, in the four scenarios

| Scenario | What renders | Code path |
|---|---|---|
| **Compaction mid-turn** | Nothing while it runs. When the open turn flushes, one inline row: **"Context automatically compacted"**; the session card's last message becomes `context compacted (auto)`. No token count in the transcript row (`pre_tokens` rides in `detail` and `NoticePart` does not print it). | `adapter.rs:856` → `chat.rs:147` → `threadProjection.ts:375-382` → `ThreadView.tsx:283-306`. **Conditional on a frame nobody has captured.** The `"compacting"` status frame that would give a live indicator is dropped at `adapter.rs:874-878`. |
| **Six-hour session** | **Nothing marks it.** No context meter (unmounted), no usage-window gauge (unconsumed), no elapsed-time surface found. Transcript shows the newest 600 items, feed the newest 2,000; older paged from SQLite on scroll. If the subscription window is exhausted, exactly one warning row appears. | `SessionContext.tsx` exists but is not mounted. `getUsageWindows` has no consumer. Warning row: `adapter.rs:673` → `chat.rs:165` → `ThreadView.tsx:283`. |
| **Context-limit error from the provider** | Nothing specific. It would arrive as an error `result` and fall through the generic mapping to a `StatusBanner tone="error"` headed **"Runtime error"**, or as a turn ending with an unmapped `stop_reason` riding verbatim in `StopReason::Other`. The user gets no hint that *context* was the cause. | `adapter.rs:2277` `stop_reason_of`, `adapter.rs:2320` `error_during_execution`; `ThreadView.tsx:295-300`. **[measured — the paths; that a context error takes them is asserted, since no capture shows one]** |
| **Session resumed after restart** | The transcript replays correctly from SQLite; nothing is lost. Cumulative usage and cost restart at zero — harmless today, because nothing renders them. A re-mounted `SessionContext` would be correct immediately, since it queries the live CLI rather than the stored row. | `docs/research/resume.md:30-37`; `conversation.rs:57-91`. |

## 7. Recommendations, in priority order

Each is one work order sized for a fresh context.

**WO-1 — Re-mount the context meter. (missing UI)**
The single highest ratio of owner-visible result to effort in this document. The meter is built,
polls correctly, degrades to `—` with a reason, and is dead code.
Files: `src/components/SessionContext.tsx` (unchanged or minor), one mount site in the composer rail
or thread header, plus a render test. **Coordinate with the in-flight `src/components/**` worker.**

**WO-2 — Surface the compaction threshold. (missing plumbing, small)**
`get_context_usage` already returns `autoCompactThreshold` and `autocompactSource`;
`conversation.rs:75-86` drops them. Passing them through turns "62% used" into "compaction at 967k",
which is the number that actually answers "can I start a long run now?".
Files: `src-tauri/src/conversation.rs`, `src/sessionApi.ts`, `src/components/SessionContext.tsx`.
Depends on WO-1 landing first (or ships with it).

**WO-3 — Capture a real compaction. (evidence; blocks WO-4)**
The hand-written fixture asks for this in its own first line. Run a `crates/claude-spike` scenario
on haiku with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set low (e.g. 100000) and feed it a large file until
it crosses. Settles three unknowns at once: does `compact_boundary` reach the stdio lane; is
`pre_tokens` populated; does `system/status: "compacting"` appear.
Files: `crates/claude-spike/` (new scenario + fixture),
`crates/claude-wire/tests/fixtures/system_compact_boundary.json`. Costs one cheap billed run.

**WO-4 — Stop dropping `system/status`. (missing plumbing)**
Gives a live "Compacting…" affordance instead of a silent pause followed by a past-tense row, and
carries `compact_error` when compaction fails. **Do not start before WO-3** — there is currently no
evidence of what the frame looks like in this lane.
Files: `crates/core/src/claude/adapter.rs:874-878`, `crates/core/src/event.rs`,
`crates/store/src/chat.rs`, `src/wire.ts`, `src/components/ThreadView.tsx`.

**WO-5 — Mount a usage-window gauge. (missing UI)**
Store side is complete and tested; only a consumer is missing. Tokens and reset times, never dollars.
Files: one new component, one mount site in `src/components/Dock.tsx`.

**WO-6 — Make the compaction row demonstrable. (missing fixture, trivial)**
`src/mock.ts` emits no `session-compacted`, so the row cannot be reviewed without a live compaction.
Adding one event makes it visible in the browser demo and gives `threadProjection.test.ts` a
`code:"compacted"` case, which it currently lacks.
Files: `src/mock.ts`, `src/threadProjection.test.ts`, `src/components/ThreadView.test.tsx`.

**WO-7 — Product decision for the owner: should brigadier *own* compaction, or only watch it?**
Today the Claude adapter refuses `NativeControl::Compact` (`adapter.rs:1589-1594`) and the composer
filters `/compact` out of the catalog (`composer.rs:977`), while the Codex adapter implements it.
Two coherent positions, and the code currently sits between them:
(a) `docs/vision.md`'s line is that windows are rented per decision and thrown away, so compaction
should never be reached and exposing a button would be admitting the accumulating session back in;
(b) the harness drives a real CLI whose window really does fill, and refusing the control while
rendering a row for it is watching without a steering wheel.
Not a code question. No files until the owner rules.

## 8. What I did not check

- Ran nothing: no `cargo test`, no `npm test`, no build, no burn. Read-only, as instructed.
- Did not execute `ThreadView.test.tsx`, so "the notice row renders" is read from source, not
  observed on screen.
- Did not read the Codex adapter's compaction path beyond confirming it exists — Codex is not v1.
- Did not verify whether the Claude Code CLI emits `compact_boundary` over stdio **at all**. No
  capture shows it; the protocol research does not mention it. WO-3 settles this.
- Did not profile SQLite or the feed ring at 60,000 items; the growth is read off the schema and the
  absence of a sweep, not measured.
- Did not check `src-tauri` for a session-age or elapsed-time surface beyond greps for the obvious
  names; "nothing marks a six-hour session" is a negative from grep, which is weaker than a read.
- `docs/research/rewind-context-2026-09-05.md`'s measured `get_context_usage` reply was taken as
  written against CLI 2.1.261 and not re-probed today; the installed CLI may have moved.

---

# Addendum, same day: a real compaction, captured

Everything in this addendum is **[measured]** against CLI **2.1.268** on this machine unless marked
otherwise. Earlier sections were written without a capture; §2's "Unknown" is now settled.

## A1. The cheap trigger

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — the variable §7 WO-3 did not name but the CLI's own
`autocompact_state` schema does — **is inert**. Set to `1` it changed nothing: `autoCompactThreshold`
stayed at its default and three turns produced no compaction. **[measured]** It is read
(`ipt()` in the bundle: `testPctOverride: o ? parseFloat(o) : undefined`) but did not reach the
resolved threshold; why was not chased.

**`CLAUDE_CODE_AUTO_COMPACT_WINDOW` works, and is the trigger.** **[measured]**
`claude --help`, 2.1.268: `--autocompact <auto|tokens>  Auto-compact window size (auto, or
100k–1M tokens)`. 100k is a hard floor — `MXe()` rejects anything below it, and `Fb()` clamps with
`Math.max(min, value)`. The same value can come from the `autoCompactWindow` setting or `/autocompact`.
`DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` turn it off; `CLAUDE_CODE_MAX_CONTEXT_TOKENS` only moves
the window for models the CLI does not recognise.

Measured, `get_context_usage` on `claude-haiku-4-5`, no model turn spent:

| env | `maxTokens` | `autoCompactThreshold` | `autocompactSource` |
|---|---|---|---|
| (none) | 200000 | 167000 | `model-default` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` | 100000 | **67000** | `env` |

So the cheapest real compaction costs **one turn of ~34k filler tokens** on top of the ~33k the
CLI's own prompt, tools, memory files and skills already occupy, then one more turn to cross. Three
haiku turns end to end.

## A2. The capture

`crates/claude-spike/fixtures/s11-auto-compaction.ndjson`, 64 frames. Driven by
`build_argv`'s flags reproduced verbatim (`--output-format stream-json --verbose --input-format
stream-json --model claude-haiku-4-5 --include-partial-messages --permission-prompt-tool stdio
--strict-mcp-config --permission-mode default`), `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, in a throwaway git
repo. The driver script is scratch, not in the tree.

A compaction is **four** frames, not one:

```
{"type":"system","subtype":"status","status":"requesting","session_id":"664bd465…","uuid":"b4711e6b…"}
{"type":"system","subtype":"status","status":"compacting","session_id":"664bd465…","uuid":"c0036d37…"}
{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"664bd465…","uuid":"9344422a…"}
{"type":"system","subtype":"compact_boundary","uuid":"a563fc05-676e-4724-84dc-b594c66b3d5d","compact_metadata":{"trigger":"auto","pre_tokens":70633,"post_tokens":1379,"cumulative_dropped_tokens":69254,"duration_ms":12262,"preserved_segment":{"head_uuid":"ef8eb9d5…","anchor_uuid":"628bfd5a…","tail_uuid":"4af5f796…"},"preserved_messages":{"anchor_uuid":"628bfd5a…","uuids":[…4…],"all_uuids":[…4…]}},"logical_parent_uuid":"4af5f796-b825-4a65-b972-5af75299b87b","session_id":"664bd465…"}
```

Then a synthetic `user` frame (`isSynthetic: true`, 2,474 characters) whose text opens
*"This session is being continued from a previous conversation that ran out of context."*

The same capture contains a **failed** compaction one turn earlier — the threshold was crossed with
too little to summarise:

```
{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"too_few_groups","session_id":"664bd465…","uuid":"388cd023…"}
```

No `compact_boundary` follows a failure. `get_context_usage` measured `totalTokens` **70535 → 23313**
across the successful one.

Not captured: `compact_progress` (`compact_start`/`compact_end`), `stream_mode` and
`autocompact_state` exist in the CLI's schemas, are marked `@internal`, and appeared on **no** line
of this capture. **[measured — absence, on one capture]**

## A3. Where brigadier was wrong, and what changed

| Claim in §2 | Reality | Action |
|---|---|---|
| `compact_boundary` never observed; may not reach the stdio lane | It does, verbatim in the shape `claude-wire` models | Fixture replaced with the real frame |
| `CompactMetadata` = trigger, pre_tokens, post_tokens, duration_ms | Also `cumulative_dropped_tokens`, `preserved_messages` | `cumulative_dropped_tokens` and `logical_parent_uuid` now typed |
| `SystemStatus.status` is `Option<String>` | The frame that **ends** a compaction is `"status":null`, and `Option<String>` + `skip_serializing_if` re-encoded it with the key **gone** | **Decoder bug, fixed**: `Option<Option<String>>` with a `present` deserializer. It cost two lines of `real_captures_round_trip_byte_faithfully` the moment the capture landed |
| `system/status` carries `permissionMode` | The CLI omits it on all six captured status frames | Field kept (modelled, optional); fixture is now the real frame |

Tests pinning this, all on the real capture: `crates/claude-wire/tests/decode.rs`
(`the_real_compact_boundary_keeps_every_field_it_carries`,
`a_compaction_is_three_status_frames_then_a_boundary`,
`a_status_frame_without_the_key_is_not_a_status_frame_with_null`) and
`crates/core/tests/claude_adapter.rs` (`s11_a_real_auto_compaction_is_reported_after_the_fact_only`).

Gates: `cargo test --workspace` exit 0, `cargo clippy --workspace --all-targets -- -D warnings`
exit 0, `cargo doc --workspace --no-deps` exit 0 (one pre-existing bare-URL warning in
`crates/core/src/claude/storage.rs:2`, untouched). Frontend gates not run — another worker holds
`src/`.

## A4. What a user would now see

With the real frames, on the path that exists today:

- **During** the ~12 s compaction: nothing. All three `system/status` frames are dropped by
  `crates/core/src/claude/adapter.rs`'s `SystemMessage::Status(_) => {}` arm. The session simply
  pauses. **[measured — the capture's 12,262 ms `duration_ms`, and the code]**
- **After**: one inline row, **"Context automatically compacted"**, and the session card's last
  message becomes `context compacted (auto)`. The feed row reads
  `context compacted · auto · 70633 tokens before`.
- **The summary is never shown.** `adapter.rs::on_user` emits only for `tool_result` blocks, so the
  synthetic summary frame — a `text` block — produces no item at all. The user sees a gap in the
  transcript where 69,254 tokens of their conversation used to be, and one sentence about it.
- **A failed compaction is completely silent.** `compact_result: "failed"` /
  `compact_error: "too_few_groups"` is carried in the dropped status frame and nowhere else; no
  boundary follows, so no row appears. The session will try again next turn.

Still missing, in order of what the capture now makes cheap:

1. A live "Compacting…" affordance, and a warning row on `compact_result: "failed"` — §7 WO-4 is
   unblocked, and the shape it needs is in `s11-auto-compaction.ndjson`.
2. `post_tokens`, `duration_ms` and `cumulative_dropped_tokens` reach `claude-wire` and stop at
   `Event::SessionCompacted`, which carries only `trigger` and `pre_tokens`
   (`crates/core/src/event.rs:285-291`). "70,633 → 1,379 in 12.3 s" is three numbers the wire hands
   over for free and the product throws away.
3. §7 WO-1 and WO-2 are unchanged: the context meter is still unmounted, and
   `src-tauri/src/conversation.rs` still drops `autoCompactThreshold` — the number this addendum
   spent three turns measuring by hand.

## A5. What was not checked

- One capture, one model (`claude-haiku-4-5`), one window (100k). Whether `trigger: "manual"` or a
  1M-context model produces a different shape was not tested.
- Why `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is inert was not chased past confirming the threshold did
  not move.
- The `@internal` `compact_progress` / `autocompact_state` frames were not provoked; no flag or
  `initialize` option was tried that might enable them.
- `crates/core/src/claude/adapter.rs` was **not** changed — the status frames are still dropped.
  That is WO-4's work and outside this run's owned paths.

---
# Addendum 2, same day: the capture reaches the UI (WO-4)

## A6. What changed

§7 WO-4 is done. `crates/core/src/claude/adapter.rs` no longer drops `system/status`; the boundary's
numbers no longer stop at `claude-wire`; a failed compaction is no longer silent.

Three events now carry it, all pinned against `s11-auto-compaction.ndjson` and nothing hand-written:

| event | source frame | row | thread notice |
|---|---|---|---|
| `session-compacting` | `system/status: "compacting"` | none | none — a signal, like `usage-windows` |
| `session-compacted` (`trigger`, `pre_tokens`, `post_tokens`, `cumulative_dropped_tokens`, `duration_ms`) | `system/compact_boundary` | `context compacted · auto · 70633 → 1379 tokens · 12.3 s` | `info`, code `compacted`, all four numbers in `detail` |
| `session-compact-failed` (`error`) | `system/status: null` with `compact_result != "success"` | `context compaction failed · too_few_groups` | `warning`, code `compact-failed` |

Failure is a **warning**, not an error: the session runs on and the CLI retries on a later turn, so
nothing stopped and nothing was lost — but nothing is hidden either. `compact_error` is passed
through verbatim, bounded to 120 bytes; `too_few_groups` is the only value ever observed and the set
is treated as open. A `compact_result` value this build does not know becomes the reason itself
rather than being dropped, and a bare `"failed"` with no `compact_error` leaves the reason `null`
rather than inventing one.

## A7. Where this addendum corrects §A2 — the capture wins

§A2 calls a compaction "**four** frames" and lists `status: "requesting"` as the first. As a
*description of a compaction* that holds; as a *classifier* it does not, and the same capture is the
counter-example: line 4 is `{"status":"requesting"}` on turn 1, which compacts nothing. The capture
carries **three** `requesting` frames and **two** compactions. So the live phase opens on
`"compacting"` and on nothing else — opening it on `"requesting"` would spin a compaction indicator
on every turn of every session. Pinned by
`crates/core/tests/claude_adapter.rs::s11_the_requesting_status_does_not_open_a_compaction`.

## A8. Tests and gates

Against the real capture, replayed through the adapter rig:
`s11_a_real_auto_compaction_reaches_the_ui_live_and_with_every_number` (the whole lane, in order:
compacting → failed(too_few_groups) → compacting → compacted(70633→1379, dropped 69254, 12262 ms)),
`s11_the_requesting_status_does_not_open_a_compaction`, and
`s11_a_success_with_no_boundary_still_closes_the_compaction` — the capture replayed with its single
`compact_boundary` line deleted, which is the only path that exercises the held close. Plus the
store's row and notice pins in `crates/store/tests/feed.rs` and the wire-shape pins in
`crates/core/src/event.rs`.

Gates: `cargo test --workspace` exit 0, `cargo clippy --workspace --all-targets -- -D warnings`
exit 0, `cargo doc --workspace --no-deps` exit 0, `npx tsc --noEmit` exit 0.

## A9. What was still not checked

- No live CLI was run for this change: every frame came from the recorded capture.
- `trigger: "manual"` is still unobserved; the held-close path asserts `auto` because this adapter
  refuses `NativeControl::Compact`, which is reasoning, not measurement.
- `npm test`, `npm run tauri build` and the burn were not run (another worker holds `src/`). The
  burn harness's `NON_ROW_EVENT_TYPES` / `CHAT_ITEM_EVENT_TYPES` literals in
  `scripts/measure-native-burn.py` were updated for the three events because
  `crates/store/tests/feed.rs` pins them, but the harness itself was not executed.
- The UI half is not built here: no component consumes `session-compacting` yet, so "the user now
  sees a spinner" is **not** claimed — what is claimed is that the event reaches the webview's
  signal path.

---

# Addendum 3, same day: the session does not accumulate — what that changes here

Everything above §5 was written on the assumption, never stated because nobody thought to doubt it,
that the interactive session **accumulates** — that turn 2 is answered by the same `claude` child
that answered turn 1. It is not. Read
**`docs/research/does-a-session-accumulate-2026-09-11.md`** before acting on §7.

The short form, from that file's §0–§2 **[measured]**: every user message passes
`task_settings::prepare_dispatch` → `Supervisor::restart_execution`, which kills the live child and
spawns a fresh one with **no `--resume` and no provider transcript**
(`crates/core/src/claude/driver.rs:258` `resume: None`); the harness re-assembles a bounded brief
from SQLite instead — orchestration instructions, the task checkpoint, and the last four text items,
ceiling ≈ **9,000 tokens**. Five messages over an hour are five children.

**No measurement in this document changes.** §A1's `autoCompactThreshold` **167,000** of **200,000**
on CLI 2.1.268, §A2's capture, and §A3–§A9 were all taken inside a single child's lifetime, which is
exactly the scope that still exists. What changes is the *scope* the recommendations assumed.

## What is now wrong above

- **§6's opening premise, "what actually happens to a very long session".** The table's harness-side
  rows are still right — the feed ring (`ROW_CAP = 2000`), the 600-item history window, the 100-item
  page, the absent SQLite retention are all properties of brigadier's own store and are untouched by
  the child restart. The *provider-side* reading of that section is wrong: there is no long provider
  session. Item 60,000 in SQLite is still item 60,000; the model answering it has seen four texts.
- **§6b, row "Six-hour session".** "Nothing marks it" is fixed (the meter and the gauge are mounted
  at `src/components/Composer.tsx:222-223`), but the row's framing — a six-hour window filling up —
  describes a thing that does not happen.
- **§6b, row "Session resumed after restart"** and §6's `--resume` paragraph. The Resume button does
  not pass `--resume`; it takes the same fresh-child path as a send, and nulls `resume_token` on the
  way through. Corrected in `docs/research/resume.md` §12, which also names the two paths that do
  still pass the flag (fork, and the peer `resume-subagent` action).
- **The verdict line "compaction is plumbed but unproven".** Proven since, by §A2's capture — and
  now correctly scoped: **not reachable across a conversation, reachable within a single turn** whose
  own tool output burns the ~120,000 tokens of headroom left after the ~42–50k cold start, on the
  default model. Effectively unreachable in one turn on a 1M-context model.
  **[asserted — arithmetic in `does-a-session-accumulate-2026-09-11.md` §3, not observed]**

## Which of §7's recommendations survive

| WO | status on 2026-09-11 |
|---|---|
| **WO-1** mount the context meter | **Landed** (`src/components/Composer.tsx:222`). Its *copy* was wrong — it described an accumulating conversation — and is corrected in `src/components/SessionContext.tsx`: "This response", "Resets at your next message", plus a drop line. |
| **WO-2** surface the threshold | **Landed** (`src-tauri/src/conversation.rs:87-88`). Survives unchanged, and matters more now, not less: the threshold is the one thing in the meter that a single runaway turn can still reach. |
| **WO-3** capture a real compaction | **Landed** — the Addendum above. |
| **WO-4** stop dropping `system/status` | **Landed** — Addendum 2. Still right: a within-turn compaction is exactly where a live "Compacting…" affordance is worth having, because the user cannot escape it by sending another message. |
| **WO-5** mount a usage-window gauge | **Landed** (`src/components/Composer.tsx:223`). Wholly unaffected — subscription windows are the provider's rolling 5-hour and 7-day counters and do not reset when a child does. |
| **WO-6** make the compaction row demonstrable in `src/mock.ts` | **Still open.** `src/mock.ts` emits no `session-compacted`; grep finds none. Survives as written. **[measured]** |
| **WO-7** should brigadier *own* compaction? | **Survives, and the finding sharpens it rather than settling it.** Position (a) — "windows are rented per decision and thrown away" — is not an aspiration; it is what the code does. A `/compact` button would therefore be a *within-turn* control only, and the honest question for the owner shrinks to: is there value in compacting one long response mid-flight, versus interrupting and re-scoping it? |

One recommendation this document did **not** make and should have: the meter's own drop line is a
free tripwire on the product's central invariant. A figure that climbs monotonically across messages
means provider history was wired back into the send path. Added as a reported fact, not an alarm, in
`SessionContext.tsx`.

## Not checked

Nothing was run for this addendum. The WO status column is read from the tree at `02be7d0` plus the
uncommitted `SessionContext.tsx` change, not from a test run; "landed" means the code is present and
mounted, not that it was exercised against a live CLI. No figure here is new — every number is
quoted from §A1 above or from `does-a-session-accumulate-2026-09-11.md`, which itself ran nothing.

---

# Addendum 4, same day: the owner's ruling, and where the compaction work stops

Addendum 3 left two things open: what a compaction should *look* like now that it can only ever be a
within-turn event, and whether WO-4's live `session-compacting` signal should drive an affordance.
Both are settled by owner ruling, 2026-09-11. This addendum records the ruling and what was built
against it; it supersedes the WO-4 and WO-6 rows above and the "live Compacting… affordance" line in
§7.

## A10. The ruling

1. **A compaction is presented as a compaction, normally.** Informational, not an alarm, not an
   anomaly. It is a boundary in the timeline, so it is drawn as a separator — a hairline rule with a
   centred label — and it keeps the measured numbers, because they are the useful part.
2. **No live indicator, of any kind.** No spinner, no progress row, no status line while it happens.
3. **The wording must not imply a conversation was summarised.** There is no cross-message history
   to summarise (`docs/research/does-a-session-accumulate-2026-09-11.md` §0). What was compacted is
   **this one response**.

An earlier ruling the same day made the completed compaction a *warning* with no numbers; it was
reversed in full before anything was committed. Only the failure is a warning.

## A11. What the tree now does

| surface | text | level |
|---|---|---|
| thread, compaction | `This response's context was compacted · 12s · 70,633 → 1,379 tokens` | info |
| thread, compaction (manual trigger) | `This response's context was compacted on request · …` | info |
| thread, failure | `Could not compact this response's context: too_few_groups` | warning |
| session list subtitle | `response context compacted (auto)` | — |

The text is minted in two places and both had to change: the level, the code and the trigger
discriminator come from `crates/store/src/chat.rs`; the sentence and the number formatting from
`noticeSentence` / `compactionNumbers` in `src/components/ThreadView.tsx`. The failure's whole
sentence is minted in Rust, because `noticeSentence` falls back to the body verbatim for a code it
does not know.

**Component: the vendored kit's `InlineNotice`** (`src/components/thread/Notices.tsx`, CSS at
`thread.css:601-632`). It is already the separator shape the ruling asks for — `flex: 1 1 0`
hairline either side of a centred, `nowrap` label — and it is already the renderer `NoticePart`
dispatches to, so no new row type and no new dependency. assistant-ui's `day-separator` element was
the other candidate and was rejected: it is not in any installed package (`grep -ril day-separator
node_modules/@assistant-ui` finds nothing — it lives in the Elements registry, abandoned by
`CLAUDE.md` §2 on 2026-09-09), so taking it would mean hand-copying a component identical in shape
to one already vendored here. **[measured]**

Numbers shown: `duration_ms` and the `pre_tokens → post_tokens` pair, each dropped from the label
when the provider did not report it. `cumulative_dropped_tokens` is deliberately **not** shown — it
is every compaction in the provider session added together, not this one's loss, and beside a
before/after pair it would read as a third figure about this event.

## A12. `session-compacting` has no consumer, deliberately

The event stays on the wire end to end — emitted at `crates/core/src/claude/adapter.rs` from
`system/status: "compacting"`, declared at `src/wire.ts:228` — and **nothing consumes it.**
`src/feedStore.ts` has no `case "session-compacting"`, no component reads it, and the feed
projection returns `None` for it (`crates/store/src/feed.rs:210`). That is the ruling, not an
oversight, and it should not be "fixed" by a later reader. **[measured — grep across `src/`,
`crates/`, `src-tauri/` on 2026-09-11 finds the three sites above and no others.]**

The one place the meter could have implied a live state was its past-threshold flag, which read
`compacting`. It now reads `past the line`: what the meter measured, rather than an event it cannot
observe. `src/components/SessionContext.tsx`.

## A13. WO status, superseding the table in Addendum 3

- **WO-4** — *complete, and it stops here*. The signal is decoded and carried; the affordance
  Addendum 2 argued for is ruled out. Nothing further is owed.
- **WO-6** — **landed**. `src/mock.ts` `seedCompactionNotices` seeds both notices mid-turn, with the
  real capture's numbers (`crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`). Evidence:
  `docs/performance/2026-09-11-thread-shots/compaction-notice/`. This fixture had hidden the
  compaction row from review twice; it no longer can.
- **WO-7** — unchanged and still open: whether brigadier should offer a within-turn `/compact`.

## A14. The meter's real job

Stated plainly, because Addendum 3 buried it in a closing paragraph: **the context meter's primary
job on this product is a tripwire, not a budget.** It cannot be a session budget — there is no
session to budget. It exists to (a) show one response approaching the only threshold it can reach,
and (b) prove the central invariant by sawtoothing: a figure that climbs monotonically across
messages is proof that provider history was wired back into the send path. The drop line reports
what it observed and does not accuse, because reads are coalesced at 4 s and the per-turn floor is
not reliably sampled.

## A15. What was not checked for this addendum

- **No live CLI.** The screenshots are the browser fixture (`src/mock.ts`) driven headless; the
  desktop path was not exercised and no `claude` child was spawned. The numbers on screen are the
  fixture's copy of a real capture, not a fresh measurement.
- **`npm run tauri build` and the burn were not run** (excluded from this order). The four gates that
  were run — `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo doc --workspace --no-deps`, `npm test` (708), `npx tsc --noEmit` — all exited 0.
- The manual-trigger sentence was not photographed; only `auto` is reachable from the fixture.
- Nothing was re-probed about `autoCompactThreshold`; §A1's figures stand as quoted.
