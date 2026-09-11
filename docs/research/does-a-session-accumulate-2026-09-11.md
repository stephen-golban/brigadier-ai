# Does a brigadier interactive session accumulate context? — 2026-09-11

Question: **can the session a human talks to through the UI's thread accumulate context until the
provider compacts it, or is every model window disposable?**

Worktree `/Users/stephen/Development/brigadier-ai.worktrees/codex-thread`, branch `ui/codex-thread`,
at `02be7d0`. Every claim is **[measured]** (read today in this tree, with `path:line`) or
**[asserted]** (taken from a prior doc or inferred from code without being run). **Nothing was run:**
no build, no test, no burn, no app launch, no live CLI. Read-only on code; this file is the only
write.

Where code and documentation disagree, the code wins and the disagreement is named.

---

## 0. Verdict

**Every model window on the interactive path is disposable. One user message = one fresh `claude`
child with no `--resume` and no provider transcript.** `docs/vision.md` §1 and §3 are implemented
for the interactive path, not only for the orchestration loop — and more literally than §3 claims,
because the harness does not merely "curate" the context, it *re-assembles it from scratch every
turn* out of a bounded checkpoint and the last four transcript texts.

The mechanism is `task_settings::prepare_dispatch` → `Supervisor::restart_execution`, which sits in
front of **every** send path and kills the live child before dispatching the new turn:

```
src-tauri/src/task_settings.rs:391-415   prepare_dispatch → restart_execution (unconditional)
crates/supervisor/src/lib.rs:1374-1376   "Replace an idle provider execution with a fresh native
                                          session … No native transcript or resume token is passed
                                          to the provider."
crates/supervisor/src/lib.rs:1397        self.kill(session_id).await?
crates/supervisor/src/lib.rs:1461-1469   StartSession::new(cwd) → driver.start_session(req)
crates/core/src/claude/driver.rs:258     resume: None
```

**[measured]**

So the answer to "how many turns until the 167,000-token threshold" is **never, by adding messages**.
The counter returns to its floor on every send. Compaction is reachable only *inside one turn*,
from that turn's own tool output — and that is a real, reachable state, not an impossible one.

---

## 1. Process lifetime — five messages, five children

### The only place a `claude` child is born

`crates/core/src/claude/process.rs:234` `Command::new(&spec.binary)`, called from
`crates/core/src/claude/process.rs:169` `spawn`, whose only non-test callers are
`crates/core/src/claude/driver.rs:178` (inside `ClaudeDriver::open`, shared by
`start_session` at `:232` and `resume_session` at `:277`). A repo-wide grep for `Command::new`
across `crates/` and `src-tauri/src/` finds no other spawn of the CLI. **[measured]**

### What keeps a child alive

`crates/core/src/claude/adapter.rs:1-30` — one long-lived task per child, a select loop whose
`command` arm handles `SendTurn` / `Interrupt` / `Kill` / `Respond`. A turn is one JSON line written
to the child's stdin (`adapter.rs:1965-2064` `start_turn` → `write_frame`). Nothing in the adapter
ends the child at `TurnCompleted`. **[measured]**

`crates/supervisor/src/lib.rs:1589-1597` files the child in the `live` map; the entry is removed at
`crates/supervisor/src/lib.rs:2622-2632`, and **only** when the event stream ends — i.e. when the
child exits. There is no idle reaper, no per-turn teardown, and no TTL anywhere in the supervisor.
**[measured]**

So a child, left alone, would live across turns. It is not left alone.

### What kills it — and it is the composer

Every path from the UI to the provider passes `task_settings::prepare_dispatch`:

| send path | line |
|---|---|
| `send_turn` Tauri command | `src-tauri/src/commands.rs:741-749` → `conversation_data::send_locked` |
| `send_conversation_turn` (composer, with attachments) | `src-tauri/src/conversation_data.rs:300-316` |
| the shared body | `src-tauri/src/conversation_data.rs:318-361` — **`prepare_dispatch` at `:361`, immediately before `send_input` at `:373`** |
| queued-message drain | `src-tauri/src/composer.rs:620`, `:906` → same body |
| peer/MCP `send_message` | `src-tauri/src/peers.rs:1538` → `prepare_dispatch`, then `:1574` `send_input` |
| the "Resume" button | `src-tauri/src/commands.rs:683-699` → `prepare_dispatch` at `:698` |

**[measured]** There is no send path that reaches `Supervisor::send_input` without it, except the
*first* message of a session (`src-tauri/src/commands.rs:628-645`), which is delivered to the child
`start_session` just spawned.

`prepare_dispatch` (`src-tauri/src/task_settings.rs:391-415`) is unconditional: `require_running`,
read task settings, resolve the execution selection, validate it, then `restart_execution`. **There
is no "settings unchanged, skip the restart" branch.** **[measured]**

`Supervisor::restart_execution` (`crates/supervisor/src/lib.rs:1378-1520`):

1. `:1389` refuses if the current child is mid-response (`activity["status"] != "Idle"` →
   `"Cannot replace a running response; settings apply to subsequent work"`).
2. `:1397` `self.kill(session_id).await?` — SIGTERM then SIGKILL the whole process group
   (`crates/core/src/claude/process.rs:196-219`, `KILL_GRACE` 2 s at `:28`).
3. `:1398-1408` waits up to 10 s for the `live` entry to clear, else refuses and dispatches nothing.
4. `:1461-1469` builds a plain `StartSession` — **no `resume` field, no token** — carrying only
   `Resumed { session_id, start_seq: record.last_event_seq }`, which preserves the *harness* row and
   feed numbering, not provider history.
5. `:1469` `driver.start_session(req)`, which sets `resume: None` at
   `crates/core/src/claude/driver.rs:258`, so `build_argv` emits no `--resume=`
   (`crates/core/src/claude/process.rs:145-152`).
6. `:1500` `replace_execution_settings`, which executes
   `UPDATE sessions SET … provider_session_id=NULL, resume_token=NULL`
   (`crates/store/src/conversation_data.rs:76`).

**[measured]** The supervisor's own test names the contract:
`fresh_execution_keeps_task_identity_and_feed_without_native_resume_token`
(`crates/supervisor/src/lib.rs:2863-2895`), asserting `before.resume_token.is_none()` and that the
call succeeds — "fresh call does not require native history". **[measured — read, not run]**

### The answer to the headline count

**A user who starts a session and sends five messages over an hour causes five `claude` children,
one at a time.** Message 1 goes to the child `start_session` spawned; messages 2–5 each kill the
previous child and spawn a new one. At any instant there is exactly one child; between two messages
the previous child idles alive holding the previous turn's context, and it is killed at the moment
the next message is dispatched. **[measured — from the code; not observed with `pgrep`, see §7]**

---

## 2. Context growth — who holds the conversation

Nobody holds it in the provider. The CLI child that answers message 5 has never seen messages 1–4.

The harness re-assembles a bounded brief for each turn, in this order
(`src-tauri/src/conversation_data.rs:358-368`):

| component | bound | where |
|---|---|---|
| session references expanded | unbounded in principle | `src-tauri/src/session_references.rs` via `:358` |
| workbench context | — | `conversation_data.rs:281-291` → `workbench_data::contextualize` |
| undelivered passive peer messages | — | `src-tauri/src/peers.rs:342-356` |
| the user's text | user's own | — |
| **orchestration instructions** | **7,195 chars ≈ 1,798 tokens** | `src-tauri/src/peers.rs:288-291`, appended at `task_memory.rs:232` |
| **task checkpoint (goal, progress, decisions, results, verification, unresolved)** | **`MAX_CONTEXT_BYTES = 16 * 1024`**, shrunk by dropping the largest array until it fits | `src-tauri/src/task_memory.rs:255-305` |
| **the last four `UserText`/`AssistantText` items**, each truncated to 1,600 chars | **12 KiB encoded**, oldest dropped until it fits | `src-tauri/src/task_memory.rs:234-252` |

**[measured]** `task_memory.rs:218-220` states the intent in the tree's own words: *"Add a small
deterministic slice of durable display state so conversational references such as 'use the second
option' survive even when no model checkpoint was authored. This is bounded retrieval, not native
transcript replay or an LLM compaction."*

Ceiling on the harness-assembled part: ~1,798 + ~4,096 + ~3,072 ≈ **9,000 tokens**, plus the user's
own text and any expanded references. **[measured bound; the token conversion is chars/4, asserted]**

So: **the harness holds the conversation, in SQLite** (`chat_items`, `feed`), and hands the provider
a fresh ≤9k-token brief each turn. §3 of `docs/vision.md` — "a fresh CLI child with a small, curated
context the harness assembles" — is a literal description of `task_memory::with_execution_context`.

Within a single turn, the child does accumulate normally: its own tool calls and results build up in
its window until the turn ends, and then the window is thrown away.

---

## 3. Is the compaction reachable on this path?

**Not by conversation length. Yes, inside one turn.**

The threshold, measured on CLI 2.1.268 the same day
(`docs/research/compaction-and-long-sessions-2026-09-11.md` §A1): `autoCompactThreshold` **167,000**
of a **200,000** window by model default on `claude-haiku-4-5`; 967,000 of 1,000,000 on
`claude-opus-5[1m]` (`docs/research/rewind-context-2026-09-05.md`). The ratio is not fixed — 83.5%
in one case, 67% under `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — which is why
`src-tauri/src/conversation.rs:85` now forwards `autoCompactThreshold` rather than deriving it.
**[asserted from those docs; not re-probed today]**

brigadier's default model is `claude-haiku-4-5` (`src-tauri/src/views.rs:532`, `is_default = true`),
so **the 200,000/167,000 pair is the default case**, not the exotic one. **[measured]**

### Turns to threshold

**Unbounded.** Each user message resets the child. The number of messages that can be exchanged
without a compaction is limited by nothing in the provider's context — only by the feed ring
(`ROW_CAP = 2000`, `src/feedStore.ts:83`) and SQLite growth, neither of which triggers a compaction.

### Tokens-to-threshold *within* one turn

Per-turn floor, on the default model:

| component | tokens |
|---|---|
| CLI system prompt, tool schemas, memory files, skills | ~33,000 **[asserted — measured in a throwaway repo on haiku, `compaction-and-long-sessions-2026-09-11.md` §A1; brigadier's own repo and CLAUDE.md are larger]** |
| brigadier's peer MCP server — 17 tool schemas injected via `--mcp-config` (`crates/core/src/claude/process.rs:158-165`, tools listed at `src-tauri/src/peers.rs:290`) | not measured **[asserted: low thousands]** |
| harness-assembled brief (§2) | ≤ ~9,000 **[measured bound]** |

So a turn begins somewhere around **42,000–50,000 of 200,000**, leaving roughly **120,000 tokens of
headroom that only that single turn's tool output can consume**. That is reachable: a few full
`cargo test --workspace` transcripts, or on the order of thirty large file reads, inside one
response. **[asserted — arithmetic on the figures above, not observed]**

A compaction on this path is therefore a **within-turn** event: twelve silent seconds
(`duration_ms: 12262`, measured in `crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`)
in the middle of one long agentic response, after which the *next* message throws the compacted
window away anyway.

On `claude-opus-5[1m]` (threshold 967,000) it is effectively unreachable in one turn.

---

## 4. `--resume` — the app does not use it

`Supervisor::resume_session` (`crates/supervisor/src/lib.rs:1197-1350`), which does pass
`--resume=<token>` (`crates/core/src/claude/driver.rs:277-301` →
`crates/core/src/claude/process.rs:145-152`), **has no caller outside tests in this tree.** The
Tauri `resume_session` command (`src-tauri/src/commands.rs:683-699`) calls `prepare_dispatch`
instead, i.e. the same fresh-child path as an ordinary send. **[measured]**

This contradicts `docs/research/resume.md` (dated 2026-09-02), whose §1 table describes resume as
"reuse the stored `resume_token`, spawn a new CLI child that continues the old conversation".
**The code wins:** the app's Resume button starts a transcript-less child and
`replace_execution_settings` has already nulled `resume_token`. `resume.md` is stale on this point.

What `--resume` *would* do, if it were wired: replay the stored transcript into a fresh child, same
provider session id, cumulative usage restarting at zero (`docs/research/resume.md` §2, §4;
`crates/core/src/claude/adapter.rs:2364`). It **inherits** accumulation, it does not reset it — which
is exactly why `restart_execution`'s doc comment says no resume token is passed. **[asserted from
resume.md, documented not measured]**

One live consumer of `--resume` remains: **fork**. `crates/supervisor/src/fork.rs:103-129` builds a
`ResumeSession` with `fork = true` (`--resume=<id> --fork-session`). Consequence worth naming: since
`replace_execution_settings` nulls the token on every send and the next `system/init` writes a new
one (`crates/core/src/claude/adapter.rs:539-548`), **a fork branches the transcript of the *current
single-turn child*, not the whole conversation.** **[asserted — inferred from those three sites, not
run]**

---

## 5. Subagents

Native `Task`/`Agent` subagents are **disabled** on every app-created session.
`crates/core/src/claude/process.rs:155-158`:

```rust
if spec.env_overrides.contains_key("BRIGADIER_PEER_TOKEN") {
    argv.extend(["--disallowedTools".to_owned(), "Agent,Task".to_owned()]);
}
```

with the comment *"Native Agent/Task sessions bypass Brigadier ownership, Stop and shared limits."*
**[measured]** `BRIGADIER_PEER_TOKEN` is inserted by `src-tauri/src/peers.rs:294-298` (`prepare`),
called on start (`src-tauri/src/commands.rs:492`), on fork (`:720`) and on every restart via
`peers::resume_env` (`src-tauri/src/peers.rs:336-341`, passed at
`src-tauri/src/task_settings.rs:413`). So the flag is on for the interactive path, always.
**[measured]**

Delegation instead goes through the brigadier MCP server's `delegate_task`
(`src-tauri/src/peer_mcp.rs:126`, `:207`), which creates a **separate brigadier session** with its
own child, own worktree and own window. Its tokens land in `modelUsage` only for that session's own
row.

So: the parent's window is unaffected by delegation, because the delegate is not in it. Had native
`Task` been allowed, a subagent's tokens *would* have counted — `crates/core/src/claude/adapter.rs`
takes `result.modelUsage` precisely because it "includes subagents, sidechains and compaction"
(`crates/supervisor/src/lib.rs:170-175`). **[measured]**

---

## 6. Vision versus tree

**There is no gap to close on this question.** The interactive path does not accumulate; it is
disposable per message, exactly as `docs/vision.md` §1 and §3 describe, and by the same mechanism
the orchestration loop uses (`crates/supervisor/src/loop_/call.rs:1` — *"One disposable model call:
spawn, one turn, read the final text, throw the window away"*). **[measured]**

The cost §1 predicts is real and is paid here. A window that is thrown away cannot remember what was
said three messages ago unless the harness re-assembles it, and the harness re-assembles **four text
items** (`task_memory.rs:239`, `.take(4)`) — two exchanges — plus whatever the model itself chose to
write into `task_checkpoint`. Consequences, all **[measured]** from the code unless noted:

- Continuity beyond two exchanges depends on the model having authored a checkpoint. Nothing forces
  it to; the orchestration instructions merely ask (`peers.rs:288`).
- Each item is truncated to 1,600 chars, so a long assistant answer is remembered as its first
  ~400 tokens.
- Every turn re-pays ~42–50k tokens of cold-start context (system prompt, tools, MCP schemas,
  brief). Flat per step, as §3 promises — but the flat number is not small. **[asserted]**
- Prompt caching across turns is unlikely to survive a process restart plus a changed prefix.
  **Not checked.**
- The composer refuses a send while a response is running
  (`crates/supervisor/src/lib.rs:1391-1396`) and queues it instead
  (`src-tauri/src/composer.rs:620`), because a restart cannot pre-empt a live turn.
- Three worst cases if the 10 s wait at `lib.rs:1398-1408` expires: the message is refused and
  nothing is dispatched. That is the right failure, but it is a user-visible one.

The only direction a violation could come from is the opposite one: wiring `--resume` (or
`--continue`) into `restart_execution` to "fix" the four-message memory would convert the
interactive path into an accumulating session in one line, and *then* compaction would become a
session-level event.

---

## 7. The product question: what is the context meter?

The meter mounted at `src/components/Composer.tsx:222` reads
`session_context` → `NativeControl::ContextSummary` → the CLI's own `get_context_usage`
(`src-tauri/src/conversation.rs:55-95`, `crates/core/src/claude/adapter.rs:1710`), i.e. **the live
child's current window**, never the cumulative `Usage` counters. That choice is correct and is the
only correct one here: `context_size` (`crates/supervisor/src/lib.rs:180-186`) is lifetime spend
including subagents and would be meaningless against a window that resets every message.
**[measured]**

Against the three options:

- **(a) insurance against a state that cannot occur** — no. Compaction is reachable, within one
  turn, on the default model, and a real capture proves the CLI does it
  (`crates/claude-spike/fixtures/s11-auto-compaction.ndjson:49`).
- **(b) a leak detector for a design violation** — secondarily, yes, and this is worth keeping. On a
  compliant tree the meter sawtooths: it drops to its floor at every send. A meter that climbs
  monotonically across messages is proof that someone wired provider history back into the send
  path. That is a free tripwire on the product's central invariant.
- **(c) a genuine operational gauge** — yes, but **for the current response, not for the session.**

### What the meter should say

It currently says "Context 62%" with a threshold mark and a "compacts soon" flag at 8 points out
(`src/components/SessionContext.tsx:119-153`). Two changes, both about the noun:

1. **Name the scope.** The popover should read *"this response"*, not *"the conversation"*. As
   written, "Auto-compacts at 167,000 tokens … summarises the conversation so far"
   (`SessionContext.tsx:166-171`) is misleading on this path: the conversation so far is two
   exchanges plus a checkpoint, and the thing being summarised is one turn's tool output. A user
   who reads the current copy will infer an accumulating session that does not exist, and will
   self-censor long threads for no reason.
2. **Let the sawtooth be visible.** The drop at each send is the product working. Today the meter
   coalesces reads at 4 s and polls at 8 s while busy (`SessionContext.tsx:17`, `:107`), so the
   reset is seen, but it is unexplained. One line in the popover — *"resets each message; brigadier
   sends a fresh window"* — converts a confusing number into the feature.

### When it should alarm

- **Not on approach across messages.** There is nothing to warn about; the next message clears it.
- **Within a turn, at the threshold line, as it does now.** `high = autoCompactThreshold`
  (`SessionContext.tsx:145`) is right, and the 8-point "compacts soon" band is right, because the
  actionable move is *interrupt and re-scope this response* before twelve silent seconds go by.
- **Add one alarm the meter cannot currently raise: a compaction that has already fired inside the
  current turn.** The thread does render a past-tense notice
  (`src/components/ThreadView.tsx:326-334`, "Context automatically compacted"), but the meter's
  number will have dropped without explanation. Tying the two together is the honest reading.
- **Escalate only if the floor rises.** If the value at the start of two consecutive turns has
  climbed, the invariant is broken. That is the (b) case and deserves a different, louder surface
  than a colour change — it is a bug report, not a usage warning.

---

## 8. What I did not check

- **Ran nothing.** No `cargo test`, no `npm test`, no build, no burn, no app launch. Every lifetime
  claim is read off the code, not observed with `pgrep`. The decisive experiment — start a session,
  send five messages, watch the pids — was not performed and would settle §1 in one minute.
- Did not re-probe `get_context_usage` against the installed CLI today; the 167,000/200,000 and
  967,000/1,000,000 pairs are taken from `compaction-and-long-sessions-2026-09-11.md` §A1 and
  `rewind-context-2026-09-05.md`.
- Did not measure brigadier's actual per-turn floor. The ~33k figure is from a throwaway repo on
  haiku with no brigadier MCP server; this repo's CLAUDE.md and the 17 injected tool schemas make
  the real number larger by an unmeasured amount.
- Did not measure the token cost of `workbench_data::contextualize` or
  `session_references::contextualize`; only the three bounded components in §2 have stated ceilings.
  If either of those is large, the "≤9,000 tokens" ceiling understates the brief.
- Did not verify the fork consequence in §4 by running a fork; it is inferred from three sites.
- Did not check prompt-cache behaviour across the restart. Re-paying the cold-start prefix every
  message is the load-bearing cost of this design and nobody has priced it.
- Did not examine the Codex adapter's lifetime; Codex is not v1.
- Did not check whether any path bypasses `prepare_dispatch` in a build configuration where
  `composer::SERVICE` is unset (`src-tauri/src/composer.rs:320`, `:329`) — the greps cover the
  wired paths, and a negative from grep is weaker than a read.
