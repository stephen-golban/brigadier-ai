# Compaction and very long sessions — end-to-end trace, 2026-09-11

Question asked: "we don't have any context compaction at all and a user will never see a context
compaction." Treated as a claim to verify.

Every claim below is marked **[measured]** (read today in this worktree, with `path:line`) or
**[asserted]** (taken from a prior doc, not re-derived). Worktree
`/Users/stephen/Development/brigadier-ai.worktrees/codex-thread`, branch `ui/codex-thread`, at
`759eb5a`. Nothing was run: no build, no test, no burn.

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
