# CLI steer/queue behaviour and Bash exit codes — Claude Code stdio protocol

Two measured questions against the live Claude Code CLI stdio control protocol: what happens when a `user`
frame is written mid-turn (steered into the running turn, or queued for the next one?), and how a Bash tool
call's exit code surfaces on the wire. A third section (§3) records incidental findings from the same runs:
partial-message shapes, the `thinking` block on haiku, and the `rate_limit_event`/`result.usage` fields
relevant to a usage-window gauge.

**Measured 2026-09-10 against `/Users/stephen/.local/bin/claude` = `2.1.267`** (symlink to
`/Users/stephen/.local/share/claude/versions/2.1.267`, 200,489,184 bytes), `--model haiku`
(resolved to `claude-haiku-4-5-20251001`), cwd a throwaway `git init` repo.

Method: a custom driver script (`drive.py`) spawned the CLI, wrote JSONL to stdin, and timestamped every
frame in both directions; a summarizer script (`summ.py`) digested the resulting transcripts
(`transcripts/*.jsonl`, one JSON object per line: `{"t_ms", "dir": "in"|"out"|"note"|"stderr", "frame"}`).
Both scripts and the raw transcripts were written to a session-local scratchpad directory and do not persist
in this repository; every citation below of the form `<file>:<line>` names a line in one of those transcript
files, kept as a record of what was observed. Reproduce by driving the same CLI version the same way: spawn
it with the argv below, write a `user` frame mid-turn, and read the raw stream-json frames back. 6 CLI
invocations total.

---

## Amendment — 2026-09-11, CLI `2.1.268`: §2's exit-code grammar was wrong

**Scope: §2 only.** Everything in §1 and §3 still rests on the 2026-09-10 / `2.1.267` runs above and
was **not** re-measured. What follows was measured against `claude --version` = **`2.1.268`**, the
same argv as above (`build_argv`'s flags, `--model haiku`) in a throwaway cwd, reading the raw
stream-json frames back.

**What changed, and why it matters.** §2 below concluded *"parse `/^Exit code (\d+)\n/` off the
first line"*. **The trailing newline is not always there.** The 2026-09-10 runs only ever exercised
a command that produced output (`echo out; echo err 1>&2; exit 3`), so the newline was always the
separator before that output — it was read as part of the grammar when it is only the start of the
next line. A failing command with **no** output writes the line and stops. Requiring the newline
silently returned no code for exactly those cases, which is the common one for a script that fails
quietly.

**The four measured bodies** (`tool_result.content`, verbatim, `\n` shown as an escape; none of the
four ends in a newline):

| # | command | `content` | `is_error` | `tool_use_result` sibling |
|---|---|---|---|---|
| 1 | `bash -c 'exit 3'` | `"Exit code 3"` | `true` | `"Error: Exit code 3"` |
| 2 | `bash -c 'echo err 1>&2; exit 4'` | `"Exit code 4\nerr"` | `true` | `"Error: Exit code 4\nerr"` |
| 3 | `bash -c 'true'` | `"(Bash completed with no output)"` | `false` | the success object `{stdout:"",stderr:"",interrupted:false,…}` |
| 4 | `bash -c 'kill -TERM $$'` | `"Exit code 143"` | `true` | `"Error: Exit code 143"` |

Row 3 is the one that settles a tempting shortcut: a **success** writes no `Exit code` line at all,
so a zero can never be read off the wire and must not be fabricated from `is_error: false`.

**The grammar is therefore `^Exit code (\d+)(\n|$)`**, anchored at byte 0, digits only, the line
ending at the first newline *or at end of input*. Implemented in
`crates/core/src/claude/adapter.rs::parse_exit_code`, pinned by
`measured_bash_bodies_from_cli_2_1_268`.

**Signals are now tested, and 143 is the number.** Row 4 was re-measured on its own on 2026-09-11
after a reviewer disputed an earlier note that recorded **144**. Driven through the CLI itself —
`2.1.268`, `--model haiku`, `--permission-mode bypassPermissions`, the rest of `build_argv`'s flags,
one turn asking for that one command — the Bash tool invoked `bash -c 'kill -TERM $$'` and the
answering frame was, verbatim:

```json
{"type":"tool_result","content":"Exit code 143","is_error":true,"tool_use_id":"toolu_019Ui4HyxRUwYkCzBfvawuJT"}
```

with the sibling `"tool_use_result": "Error: Exit code 143"`. **143 = 128 + SIGTERM(15)** — the same
number a bare `bash -c 'kill -TERM $$'` gives in a plain shell, so the CLI's Bash tool adds nothing
to a signalled child's code. The earlier **144 was wrong**; the reviewer's plain-shell reading was
right, and the two contexts agree.

**A denial is not this shape, and has no fixed marker.** Not a change to §2's measurements but the
correction they were being used to justify: §2 records the interrupt sibling as the fixed string
`"User rejected tool use"`. An operator **denial** is not that string — this repo's own captures
carry `"Error: denied by spike"` (`crates/claude-spike/fixtures/s3-can-use-tool-deny.ndjson:11`) and
`"Error: brigadier wall: …"` (`…/s10-deny-read-stop-bounce.ndjson:10`), because the CLI echoes the
deny *reason* verbatim. **There is no provider-side marker for a denial**, so a harness must take it
from its own `Decision::Deny` and never from the error text — matching text an operator typed would
be a parser pointed at human input, and a denial classified as a failure renders a decision the
operator made as a red error.

**Still not checked, after this amendment:** exit codes other than 0, 3, 4 and 143; signals other
than SIGTERM; whether the `Exit code N` prefix is localized; non-Bash tools' `tool_use_result`
shapes; whether a timed-out or backgrounded Bash ever sets `interrupted: true`.

---

**Authority.** This file is authoritative for Claude Code CLI `2.1.267`'s observed behaviour on: mid-turn
input injection (steering vs. queueing), `interrupt` with and without `cancel_queued`, Bash tool exit-code
representation on the wire, partial-message (`stream_event`) shapes, and the `rate_limit_event` /
`result.usage` fields relevant to a usage-window gauge. It is **not** authoritative for any other CLI
version, any non-Bash tool's result shape, or any model besides haiku-4-5 — see the "Not checked" list under
each question. It directly answers `codex-thread-anatomy.md`'s ambiguity #13 ("does brigadier implement
steering at all?"): no queueing primitive exists on this protocol today, only steering.

Argv reproduced from `crates/core/src/claude/process.rs::build_argv`, verbatim order:

```
--output-format stream-json --verbose --input-format stream-json --model haiku
--include-partial-messages --permission-prompt-tool stdio --strict-mcp-config
--permission-mode default
```

plus `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, brigadier's `STRIPPED_VARS` removed, and
`MAX_THINKING_TOKENS=0` (brigadier's default `ThinkingPolicy::Off`) on every run except the
thinking probe. The driver answers every `can_use_tool` control request with
`{"behavior":"allow"}`. 6 CLI invocations total.

`system/init` in 2.1.267 reports `capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1",
"interrupt_cancel_queued_v1"]` — **not** `queued_notifications`, which `cli-protocol.md` §2
names as an example capability. (`queued_notifications` does exist in the binary's string table
but as an unrelated permission — "read queued external notifications (webhooks, triggers)",
`claude-strings.txt:191802`.) stderr was 0 lines on all 6 runs.

---

## Question 1 — mid-turn input is STEERED INTO the running turn, not queued

**Verdict (MEASURED): a `user` frame written mid-turn is accepted silently, is never echoed back on
stdout, and is injected into the *running* turn — the assistant answers it before the first
`result` — with `queued_turn_count: 0`; nothing on the wire announces a queued state, and
`still_queued` / `cancelled` come back empty even when the message demonstrably exists.**

### (a) Accepted without error, (b) injected not queued — `transcripts/queue.jsonl`

Timeline (t_ms; `sleep 6` running under the Bash tool the whole time):

| line | t_ms | dir | frame |
|---|---|---|---|
| 3 | 30511 | out | `user` — "Use the Bash tool to run exactly \`sleep 6\`, and after it finishes tell me the current working directory." |
| 15 | 32280 | in | `assistant` `tool_use:Bash id=toolu_01E4aAAN1M3iXhAkyk25FVim input={"command":"sleep 6"}` |
| 20 | **33513** | **out** | **`user` — "Also, what is 2+2? Answer with just the number."** (mid-turn) |
| 21 | 35683 | in | `system/task_started` `task_id: bh8sbpc04`, `task_type: local_bash` |
| 22 | 38695 | in | `system/task_notification` `status: completed` |
| 23 | 38698 | in | `user` `tool_result` for the sleep |
| 65 | 40535 | in | `assistant` — one text block, **both answers** |
| 69 | 40539 | in | `result` |

The single assistant text block at line 65:

```json
{"type":"text","text":"The current working directory is `/private/tmp/.../probe-repo`.\n\n4"}
```

and the `result` at line 69:

```json
{"subtype":"success","is_error":false,"num_turns":2,"stop_reason":"end_turn",
 "terminal_reason":"completed","queued_turn_count":0,
 "result":"The current working directory is `/private/tmp/.../probe-repo`.\n\n4"}
```

The trailing `4` is the answer to the mid-turn message. **One `result`, one turn.** No second turn
started; the driver waited 86 s past the `result` (line 70, t=126535) and nothing more arrived.

Mechanism, as observed: the pending stdin message is folded into the conversation at the next
model request boundary inside the same turn — here, the request that followed the `tool_result`.

### (c) Nothing announces the queued state

- No `queued`/`still_queued`-type notification frame of any kind. Whole-file `grep` for
  `queue` across all 6 transcripts hits only two keys: `queued_turn_count` (in `result`) and
  `still_queued`/`cancelled` (in the `interrupt` control response).
- `queued_turn_count` is `0` in every `result` across all 6 runs — including the run where the
  message was demonstrably received and answered.
- The only inbound frames between the mid-turn write (t=33513) and the tool finishing (t=38695)
  were `system/task_started` and `system/task_notification` — about the Bash task, not the message.

### Echo / dedupe — the CLI never echoes a `user` text message

**MEASURED: zero.** Across all 6 transcripts, inbound `user` frames carrying a `text` block number
3, and all 3 are the CLI's own synthetic interrupt markers:

- `interrupt_plain.jsonl:34` — `{"type":"text","text":"[Request interrupted by user for tool use]"}`
- `interrupt_cancel.jsonl:11` — `{"type":"text","text":"[Request interrupted by user]"}`
- `interrupt_cancel_matched.jsonl:32` — `[Request interrupted by user for tool use]`

Every other inbound `user` frame is a `tool_result`. Neither the first prompt nor the mid-turn
prompt is ever mirrored back. **A UI's optimistic user row will never be duplicated by the stream,
and there is no CLI-assigned id to reconcile it against** — the client's own id is the only id.
(Inbound frames do carry a CLI-minted `uuid`; outbound frames the driver wrote carried none, and
the CLI did not complain.)

Ids seen on inbound frames: `session_id`, `uuid` (per frame), `parent_tool_use_id`, plus
`request_id` (Anthropic API request) on `assistant` frames and `message.id` (`msg_…`).

### (d) `interrupt` with and without `cancel_queued`

Both probes were driven to the **same** state: interrupt fired while the `sleep 6` Bash tool was
running, ~1.5 s after the mid-turn message was written (`terminal_reason: "aborted_tools"` in both).

**Without `cancel_queued` — `transcripts/interrupt_plain.jsonl`** — the pending message survives and
runs as a new turn:

| line | t_ms | frame |
|---|---|---|
| 29 | 3507 | out `user` — "Also, what is 2+2?" |
| 31 | 5009 | out `control_request` `{"subtype":"interrupt"}` |
| 32 | 5016 | in `control_response` → **`{"subtype":"success","response":{"still_queued":[]}}`** |
| 33 | 5032 | in `user` `tool_result` `is_error:true`, `"The user doesn't want to proceed with this tool use…"`, sibling `tool_use_result: "User rejected tool use"` |
| 34 | 5033 | in `user` text `[Request interrupted by user for tool use]` |
| 35 | 5034 | in `result` `{"subtype":"error_during_execution","is_error":true,"num_turns":3,"stop_reason":"tool_use","terminal_reason":"aborted_tools","queued_turn_count":0,"result":null}` |
| 36 | 5038 | in **`system/init` re-emitted** (same `session_id`) — a new turn begins |
| 42 | 6716 | in `assistant` text `4` |
| 46 | 6733 | in `result` `{"subtype":"success","num_turns":1,"terminal_reason":"completed","result":"4"}` |

**With `cancel_queued: true` — `transcripts/interrupt_cancel_matched.jsonl`** — the pending message
is dropped:

| line | t_ms | frame |
|---|---|---|
| 27 | 7129 | out `user` — "Also, what is 2+2?" |
| 29 | 8634 | out `control_request` `{"subtype":"interrupt","cancel_queued":true}` |
| 30 | 8638 | in `control_response` → **`{"subtype":"success","response":{"still_queued":[],"cancelled":[]}}`** |
| 31 | 8650 | in `user` `tool_result` rejected (same shape as above) |
| 33 | 8651 | in `result` `{"subtype":"error_during_execution","num_turns":3,"terminal_reason":"aborted_tools","queued_turn_count":0}` |
| 35 | 33690 | note — driver closed stdin after **25 s of silence**; no second turn, no second `result` |

A second, unmatched `cancel_queued` run (`transcripts/interrupt_cancel.jsonl`, interrupt landed
during assistant streaming → `terminal_reason: "aborted_streaming"`) behaved identically:
`{"still_queued":[],"cancelled":[]}` at line 10, one `result` at line 12, nothing further in 20 s.

**Both arrays are empty in both directions** — they never named the message that was in fact
pending. Do not use `still_queued`/`cancelled` to decide whether a steer survived an interrupt; the
observable difference is only whether a new turn starts. The binary's string table does contain the
literal `interrupt cleared the queue` (`claude-strings.txt:257022`), so an internal queue exists;
it is just not surfaced for a message delivered this way.

### Consequences for a thread UI

1. Mid-turn input is **steering**, not queueing. There is no "queued" pill to render, because the
   CLI reports none and the message lands inside the running turn.
2. The optimistic user row is the only row — the stream never sends one back, so no dedupe key is
   needed and none is available.
3. Plain `interrupt` = "stop what you're doing, then do the thing I just said" (steer). `interrupt`
   with `cancel_queued: true` = "stop, and forget the thing I just said" (hard stop). That is the
   real semantic split behind an Esc-vs-Esc-Esc affordance.
4. An interrupt produces a **synthetic rejected `tool_result`** plus a `[Request interrupted by
   user…]` user row, then a `result` with `is_error: true`,
   `subtype: "error_during_execution"`, `terminal_reason: "aborted_tools"` (tool running) or
   `"aborted_streaming"` (mid-stream). The UI must render these as an interruption, not a failure.
5. `system/init` is re-emitted at the start of each new turn on the same `session_id` — it is not a
   session-open event, so it must not reset thread state.

### Not checked (Q1)

- Whether a `user` frame carrying a client-supplied `uuid`/`id` would appear in `still_queued`.
  Never tested; the driver sent no id.
- Whether `msg_lifecycle_v1` has an `initialize` opt-in that turns on queued/lifecycle
  notifications. The field name is unknown and was not searched for exhaustively.
- Behaviour of **two or more** stacked mid-turn messages; only one was ever pending.
- A mid-turn message sent while an approval (`can_use_tool`) is outstanding rather than a tool
  running.
- Image / multi-block user content, and `parent_tool_use_id` non-null steering.
- Any model other than haiku. A larger model might split the two answers into separate blocks.

---

## Question 2 — Bash exit codes are TEXT ONLY

**Verdict (MEASURED): there is no numeric exit-code field anywhere. A non-zero exit shows up only
as the literal first line `Exit code 3` inside the `tool_result` text, `is_error` is set to `true`,
stderr is concatenated after stdout in that same text with no delimiter, and the structured sibling
`tool_use_result` object (`stdout`/`stderr`/`interrupted`/…) is *replaced by a plain string* on
failure — so the structured fields are available only when the command succeeded.**

Evidence — `transcripts/exitcode.jsonl`. The approval frame first (line 33), confirming the command
reached Bash verbatim:

```json
{"type":"control_request","request_id":"68ff29fd-…","request":{"subtype":"can_use_tool",
 "tool_name":"Bash","input":{"command":"bash -c 'echo out; echo err 1>&2; exit 3'"},
 "decision_reason":"This command requires approval", …}}
```

**Failing command (exit 3), `exitcode.jsonl:39`, verbatim:**

```json
{
 "type": "user",
 "message": {"role":"user","content":[
   {"type":"tool_result",
    "content":"Exit code 3\nout\nerr",
    "is_error":true,
    "tool_use_id":"toolu_01PcoPGbQstsoYTRx3dCMW38"}]},
 "parent_tool_use_id": null,
 "session_id": "6cf806ac-7790-4543-a44a-ad6d822f02ed",
 "uuid": "571e0c34-c4e8-4215-9b07-8db89b3ee635",
 "timestamp": "2026-09-10T16:58:12.135Z",
 "tool_use_result": "Error: Exit code 3\nout\nerr"
}
```

**Successful command (`echo ok`), `exitcode.jsonl:45`, verbatim:**

```json
{
 "type": "user",
 "message": {"role":"user","content":[
   {"tool_use_id":"toolu_015NfB7bHnzgyvQxGdkrnVMW",
    "type":"tool_result",
    "content":"ok",
    "is_error":false}]},
 "parent_tool_use_id": null,
 "session_id": "6cf806ac-7790-4543-a44a-ad6d822f02ed",
 "uuid": "8cbfb747-7018-4953-835a-f9bae855871b",
 "timestamp": "2026-09-10T16:58:12.186Z",
 "tool_use_result": {
   "stdout": "ok",
   "stderr": "",
   "interrupted": false,
   "isImage": false,
   "noOutputExpected": false
 }
}
```

Point by point:

- **Numeric exit code anywhere?** No. Only the text `"Exit code 3"` as the first line of
  `content`. Grep over all 6 transcripts: `exitCode` 0 hits, `exit_code` 0 hits, `returnCode` 0
  hits, `returnCodeInterpretation` 0 hits, `"Exit code"` 2 hits (both the same failing result, once
  in `content` and once in `tool_use_result`).
- **`is_error` on non-zero exit?** Yes — `true` on exit 3, `false` on exit 0. It is on the
  `tool_result` content block, not on the frame.
- **stderr merged?** Yes, into the same `content` string, **after** stdout, newline-separated, with
  no marker: `"Exit code 3\nout\nerr"`. On success the two are split in `tool_use_result`
  (`stdout: "ok"`, `stderr: ""`) but the model-facing `content` still carries only the merged text.
- **Structured parallel field?** Yes, but it is **not** a separate event — it is the key
  `tool_use_result` (snake_case) at the top level of the same `user` frame, sibling to `message`.
  `toolUseResult` (camelCase): **0 hits** in all 6 transcripts. Its type is unstable:
  - success → object `{stdout, stderr, interrupted, isImage, noOutputExpected}`
  - non-zero exit → string `"Error: " + content`
  - interrupted tool → string `"User rejected tool use"` (`interrupt_plain.jsonl:33`)
  - `(Bash completed with no output)` case → object with empty `stdout`/`stderr`
    (`queue.jsonl:23`)
- **`interrupted` field?** Present only inside the success-shaped object, and it was `false` in both
  observations. Even in the interrupt runs it never appeared as `true` — the interrupted tool got a
  *string* `tool_use_result` instead.

### Consequences for a thread UI

- To show an exit code, parse the first line of `tool_result.content`. There is nothing else.
  **Corrected 2026-09-11 — see the amendment at the top of this file: the grammar is
  `^Exit code (\d+)(\n|$)`, not `^Exit code (\d+)\n`.** A failing command with no output writes
  `"Exit code 3"` and stops, and requiring the newline missed it silently. Do **not** "fall back to
  `is_error` alone": `is_error` is `true` for a failure, an interrupt **and** an operator denial,
  so it cannot tell a red exit code apart from a decision the operator made.
- Do not type `tool_use_result` as an object. It is `object | string`, and the string form is
  exactly the failure/interrupt path a UI most wants to style.
- stdout and stderr cannot be rendered in separate panes on failure — they are already merged by
  the time the frame is written.

### Not checked (Q2)

- Non-Bash tools' `tool_use_result` shapes (Read, Edit, Grep, Task) — only Bash was exercised.
- Whether a *timed-out* or backgrounded Bash sets `interrupted: true`; never observed `true`.
- Whether output truncation adds fields (no command produced enough output to truncate).
- ~~Exit codes other than 0 and 3; signals (e.g. 130, SIGSEGV) were not tested.~~ **Superseded
  2026-09-11:** 4 and 143 were measured, and SIGTERM reports 143 — see the amendment at the top.
  Signals other than SIGTERM are still untested.
- Whether the `Exit code N` prefix is localized or version-stable.

---

## Question 3 — while we were there

- **`--include-partial-messages`**: brigadier **does** pass it unconditionally
  (`crates/core/src/claude/process.rs:139`, and pinned by the argv tests at lines 519–532 and
  543–559). `cli-protocol.md` §1 lists it among the SDK's conditional flags but records no shape
  for it; the shapes below are new measurements.
- **Partial-message frames**: every partial arrives as a top-level
  `{"type":"stream_event","event":{…},"session_id","parent_tool_use_id","uuid"}` wrapper whose
  `event` is the raw Anthropic streaming event. Observed `event.type` values and counts across the
  runs: `message_start` (7), `content_block_start` with `content_block.type` of `text` (6),
  `tool_use` (5) or `thinking` (1), `content_block_delta` with `delta.type` of `text_delta`
  (`{"text":"I"}`, 57), `input_json_delta` (`{"partial_json":""}`, 34), `thinking_delta`
  (`{"thinking":"…","estimated_tokens":50}`, 2) or `signature_delta` (1), `content_block_stop`
  (`{"index":0}`, 11), `message_delta`
  (`{"delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"container":null},"usage":{…}}`,
  7), `message_stop` (7). A complete non-partial `assistant` frame is *also* emitted after each
  message — the stream carries both, so a UI must not append twice.
- **`thinking` block with haiku**: `MAX_THINKING_TOKENS=0` (brigadier's default) → no thinking
  blocks at all, `usage.output_tokens_details.thinking_tokens: 0`. With the variable left alone
  (`transcripts/think.jsonl`), haiku-4-5 **does** emit one, but the text is empty:
  `content_block_start` → `{"type":"thinking","thinking":"","signature":""}` (line 8), two
  `thinking_delta`s each `{"type":"thinking_delta","thinking":"","estimated_tokens":50}`, one
  `signature_delta`, and the completed `assistant` block is
  `{"type":"thinking","thinking":"","signature":"Et0ECrIBCBEYAipAqh1w…"}` (line 14) — a signature
  with no visible reasoning. `result.usage.output_tokens_details.thinking_tokens: 120`. So on haiku
  the only renderable thinking signal is `estimated_tokens` / `thinking_tokens`, not text.
- **`rate_limit_event`**: one per turn, early (t≈1.0–2.5 s after the prompt), shape
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789068000,
  "rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
  "isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":1789068000},
  "seven_day":{"utilization":0.16,"resetsAt":1789556400}}},"uuid","session_id"}`. `utilization` is
  a 0–1 fraction; `resetsAt` is unix seconds. This is the gauge `docs/vision.md` calls for.
- **End-of-turn `usage`** (on `result`): `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`,
  `server_tool_use.{web_search_requests,web_fetch_requests}`, `service_tier`,
  `cache_creation.{ephemeral_1h_input_tokens,ephemeral_5m_input_tokens}`, `inference_geo`,
  `iterations[]` (per model call), `speed`. Alongside it: `modelUsage[<model>]` with
  `inputTokens`/`outputTokens`/`cacheReadInputTokens`/`cacheCreationInputTokens`/`costUSD`/
  `contextWindow`/`maxOutputTokens`/`thinkingTokens`/`canonicalModel`/`provider`/`costBasis`, plus
  `total_cost_usd`, `permission_denials[]`, `terminal_reason`, `subagent_stats{…}`, `num_turns`,
  `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `first_content_frame_ms`, `duration_ms`,
  `duration_api_ms`, `queued_turn_count`, `api_error_status`, `fast_mode_state`.
  (`total_cost_usd` / `costUSD` exist on the wire; per `docs/vision.md` the product shows windows,
  never dollars.)
- **Other frames seen**: `system/status` with `status: "requesting"` (8), `system/task_started`
  (`task_id`, `tool_use_id`, `description`, `is_backgrounded`, `task_type: "local_bash"`),
  `system/task_notification` (`status: "completed"`, `output_file`, `summary`). No `keep_alive`
  or `transcript_mirror` in any run.

### Not checked (Q3)

- `thinking` on any model except haiku-4-5; a Sonnet/Opus session may emit real reasoning text.
- Whether `--include-partial-messages` off changes anything besides removing `stream_event`.
- `rate_limit_event` under a throttled account (`status` was `"allowed"` on all 6 runs); the
  `"rejected"`/warning shapes were never observed.
- Subagent (`parent_tool_use_id != null`) framing — no Task was ever spawned.
- No `cargo`/`npm` build was run and nothing under `/Users/stephen/Development/brigadier-ai` was
  modified.

## See also

- `codex-thread-anatomy.md` — ambiguity #13 (steer vs. queue), directly answered by Question 1 above.
- `codex-thread-row-mapping.md` — row 15 ("Queued / steer strip") uses this file's finding that Codex's
  steer has no brigadier analogue, and row 7 ("Command execution") uses Question 2's exit-code finding.
- `thread-render-path-2026-09-10.md` §9 — the gap list this file's exit-code finding confirms: brigadier's
  `ItemKind::ToolResult` carries only `is_error: bool`, never a numeric exit code.
