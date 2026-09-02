# Rust drives `claude` directly: WO-C spike result

Date: 2026-09-02. Status: **executed against a live account**. Every number below is
**[measured]** unless marked otherwise. This is the gate for decision 1 of
`docs/plans/provider-spi.md`.

Spike code: `crates/claude-spike/` (`src/main.rs`, `src/session.rs`). No Node, no SDK, no
`claude-wire`, no `crates/core` — `tokio::process::Command` plus `serde_json::Value`, 897 lines
of spike (293 of them the reusable driver in `session.rs`). Fixtures: `crates/claude-spike/fixtures/`.

## Bottom line

**7 of 7 scenarios PASS.** Rust speaks the protocol: `can_use_tool` allow *and* deny,
`hook_callback`, `interrupt` with session survival, `--resume` onto the original session id, and a
clean kill with no orphan. Nothing in the gate failed.

One thing the spike changed about the plan's assumptions: **`can_use_tool` does not fire by
default.** It is shadowed twice over — once by the owner's `~/.claude/settings.json`
(`"defaultMode": "bypassPermissions"`), and again, even in `default` mode, by the CLI's own
command-safety classifier, which auto-approves a bare `echo` without ever putting a frame on the
wire. Getting a real approval round trip needed an explicit **ask rule**. See §"The two shadows".

## Environment

| | |
|---|---|
| CLI binary | `/Users/stephen/.local/bin/claude` |
| CLI version | `2.1.257 (Claude Code)` **[measured]** |
| `claude_code_version` on `system/init` | `2.1.257` **[measured]** |
| Model | `claude-haiku-4-5` — accepted on the first try, no fallback needed **[measured]** |
| Account | `Claude Max`, `apiProvider: firstParty`, `apiKeySource: none` **[measured]** |
| Session cwd | `…/scratchpad/spike-cwd` (git-initialised, one README) |
| `capabilities` | `["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` **[measured]** |

`capabilities` did **not** contain `queued_notifications`, which `sdk.d.ts` names as an example.
The array is the open set the docs describe; three values on this build.

### Exact argv

The SDK's base argv in the SDK's own order (`docs/research/cli-protocol.md` §1), plus `--model` and
the `stdio` permission sentinel:

```
/Users/stephen/.local/bin/claude \
  --output-format stream-json \
  --verbose \
  --input-format stream-json \
  --model claude-haiku-4-5 \
  --permission-prompt-tool stdio
```

Scenario 5 appends `--resume=<session-id>` (one argument with `=`, the 0.3.257 shape, not the two
-argument 0.3.159 shape). Scenarios 2, 3 and 6 append:

```
  --permission-mode default \
  --settings '{"permissions":{"ask":["Bash"]}}'
```

`--print` / `-p` is never passed. Confirmed working end to end: this is not headless one-shot mode,
stdin stays open, multi-turn works.

### Exact environment

Full parent environment inherited (`USER` included — `docs/research/sidecar-spike.md` landmine 3;
nothing was `env_clear`ed, and no `Not logged in` ever appeared). On top of that, exactly what the
SDK does:

- `CLAUDE_CODE_ENTRYPOINT = "sdk-ts"`
- `NODE_OPTIONS` removed
- `DEBUG` removed

**One deliberate deviation**, in `session.rs:HARNESS_VARS`: the spike also removes the variables
Claude Code injects into its own Bash-tool children — `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
`CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`. The spike was run from inside a
Claude Code session; a real Brigadier process would never have them. Leaving them in would have
nested the child inside our own session. The SDK's own rule (set `CLAUDE_CODE_ENTRYPOINT` only if
unset) was also overridden for the same reason — ours was already `"cli"`.

Stdio: all three piped, `kill_on_drop(true)`. **stderr was empty in all seven runs** (0 bytes in
every `fixtures/*.stderr.txt`) — stderr carried no protocol and no diagnostics.

## Results

```
PASS 1 handshake-and-turn  spawn->system/init 1981ms; init->result 1239ms; initialize
                           control_response at 719ms; result "pong"; stdin close -> exit 0 in 571ms
PASS 2 can-use-tool-allow  can_use_tool for Bash received and answered allow; tool_result carries
                           brigadier-spike-ok; result success
PASS 3 can-use-tool-deny   can_use_tool answered deny; no tool_result; permission_denials has 1 entry
PASS 4 interrupt           first assistant 2070ms; interrupt control_response 2071ms; result#1
                           terminal_reason="aborted_streaming" 2076ms; process alive; second turn
                           returned a second result ("pong")
PASS 5 resume              --resume=<sid> reused the SAME session_id; answer "pong"
PASS 6 hook-callback       PreToolUse hook_callback for Bash received, answered {}, tool proceeded,
                           can_use_tool followed and was allowed, tool_result carries the marker
PASS 7 kill                killed at 2139ms mid-stream; zero result frames; pgrep -f claude 12
                           before / 12 after, 0 new pids left behind
```

Per-scenario detail, all **[measured]**:

### 1. handshake-and-turn — PASS

- spawn → `initialize` `control_response`: **719 ms**
- spawn → `system/init`: **1981 ms**
- `system/init` → `result`: **1239 ms**
- first user frame → `result`: **2501 ms**
- `result`: `subtype: "success"`, `is_error: false`, `result: "pong"`
- `total_cost_usd`: **$0.026221**
- stdin closed → process exit code **0** after **571 ms**. No SIGTERM needed.

Ordering note worth building on: the `initialize` `control_response` arrives **before**
`system/init`, and `system/init` only arrives after the first user frame is written. Do not block
on `system/init` during the handshake.

**`system/init` is emitted once per turn, not once per process.** Scenario 4 ran two turns in one
process and produced two `init` frames, same `session_id`, different `uuid`. **[measured]** An
adapter that treats `system/init` as a one-shot session-start event will double-fire. Frame-type
census across all seven fixtures (top-level `type`/`subtype` pairs, 99 frames): `assistant` 21,
`system/thinking_tokens` 40, `system/init` 8, `control_response` 8, `rate_limit_event` 7,
`result/success` 6, `control_request` 4, `user` 4, `result/error_during_execution` 1.

Two frame types appear on the wire that `docs/research/cli-protocol.md` does not list:
`{"type":"system","subtype":"thinking_tokens", estimated_tokens, estimated_tokens_delta, …}` (the
single most common frame, 40 of 99) and `{"type":"rate_limit_event","rate_limit_info":{status,
resetsAt, rateLimitType:"five_hour", overageStatus, overageDisabledReason, isUsingOverage, …}}` —
exactly one per session, in all seven. Both must decode to a catch-all variant, not an error.

`initialize` response body keys: `commands` (60), `agents` (5), `output_style`,
`available_output_styles` (5), `models` (6), `account` `{email, organization, subscriptionType,
apiProvider}`, `pid`, `current_permission_mode`, `hooks_applied`, `analytics_disabled`,
`remote_control_auto_enable`, `remote_control_available`, `remote_control_auto_on_by_default`,
`ide_rc_auto_enable_gate`, `fast_mode_state`, `fast_mode_disabled_reason`, `session_state`.
`sdk.d.ts:3975-4006` under-describes this: `pid`, `current_permission_mode`, `analytics_disabled`,
`session_state`, `ide_rc_auto_enable_gate` and the three `remote_control_*` keys are on the wire
and not in the documented union. Another instance of "the `.d.ts` is a curated subset".

`system/init` keys: `cwd`, `session_id`, `tools` (127), `mcp_servers`, `model`, `permissionMode`,
`slash_commands` (60), `terminal_slash_commands`, `apiKeySource`, `claude_code_version`,
`output_style`, `agents`, `skills` (28), `plugins`, `capabilities`, `analytics_disabled`,
`product_feedback_disabled`, `uuid`, `memory_paths`, `messaging_socket_path`, `fast_mode_state`,
`fast_mode_disabled_reason`.

### 2. can-use-tool-allow — PASS. `total_cost_usd` **$0.007520**
### 3. can-use-tool-deny — PASS. `total_cost_usd` **$0.007614**

Deny made the model report the failure verbatim:

> "The bash command was denied by spike. It appears there's a permission or hook restriction
> preventing this command from running."

`result.permission_denials` shape (the whole array, one entry):

```json
[{"tool_name":"Bash",
  "tool_use_id":"toolu_01RDttLRhpBcizQyc9P5zM3N",
  "tool_input":{"command":"echo brigadier-spike-ok","description":"Echo the test message"}}]
```

Three fields: `tool_name`, `tool_use_id`, `tool_input`. **The spike's deny `message` is not echoed
back in `permission_denials`** — if the harness wants to show *why* a call was denied it must keep
its own record keyed by `tool_use_id`. On an allowed turn the array is `[]`.

### 4. interrupt — PASS. `total_cost_usd` **$0.004300** (cumulative, from result#2)

- first `assistant` frame at **2070 ms** after the user frame; interrupt written at the same ms
- `control_response` at **2071 ms** (1 ms later)
- `result#1` at **2076 ms**: `subtype: "error_during_execution"`,
  `terminal_reason: "aborted_streaming"`, `total_cost_usd: 0.000984`, `permission_denials: []`
- receipt ordering matched `sdk.d.ts`: the `control_response` came **before** the result
- interrupt response body: `{"still_queued": []}` — `interrupt_receipt_v1` **was** advertised, and
  the receipt was populated as documented
- process alive after the interrupt: **true**
- second user frame on the same process produced `result#2` `subtype: "success"`, text `"pong"`.
  **The session survived the interrupt.**

Note that `subtype` on an interrupted result is `"error_during_execution"`, not `"success"` — an
adapter must not treat `subtype != "success"` as a failure without checking `terminal_reason`.

### 5. resume — PASS. `total_cost_usd` **$0.003079**

Fresh process, `--resume=8380cdea-0e11-4fa3-b5df-9c606b7262aa`. `system/init` came back with
**the same `session_id`** (`session_id equal: true`) — a plain resume continues the id, it does not
mint a new one; that only happens with `--fork-session`. The answer contained `pong`, so the
transcript from scenario 1's process really was reloaded.

### 6. hook-callback — PASS. `total_cost_usd` **$0.007429**

The SDK's initialize hook shape worked verbatim, first attempt, no exploration needed. Sent:

```json
{"type":"control_request","request_id":"spike_1",
 "request":{"subtype":"initialize",
            "hooks":{"PreToolUse":[{"matcher":"Bash","hookCallbackIds":["hook_0"]}]}}}
```

The CLI called back with the id we minted. Full `hook_callback` request:

```json
{"type":"control_request","request_id":"2c84bba3-7ffd-4d2d-a319-092793b5f07f",
 "request":{"subtype":"hook_callback","callback_id":"hook_0",
   "tool_use_id":"toolu_01Ks39rtmrfT1YK5dEL1dJFH",
   "input":{"session_id":"baf370d2-bce6-4597-9fd5-11f0b96412fd",
            "transcript_path":"/Users/stephen/.claude/projects/<encoded-cwd>/<sid>.jsonl",
            "cwd":"…/spike-cwd","prompt_id":"a76b70af-d8a2-4615-81a4-f219059d6ce1",
            "permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash",
            "tool_input":{"command":"echo brigadier-spike-ok","description":"Echo test message"},
            "tool_use_id":"toolu_01Ks39rtmrfT1YK5dEL1dJFH"}}}
```

Answered `{"subtype":"success","request_id":…,"response":{}}`; the tool proceeded, a `can_use_tool`
followed (allowed), and the `tool_result` carried the marker. `hook_callback` and `can_use_tool` are
independent gates and both fire on the same call.

`hooks_applied: true` came back on the initialize response — but it is **also** `true` when we send
`hooks: {}`, because the owner's settings file has its own `PreToolUse` Bash hook. `hooks_applied`
is not a confirmation that *your* hooks registered.

### 7. kill — PASS

Counting prompt, streaming confirmed (`assistant` frame seen), then `Child::start_kill()` at
**2139 ms**. **Zero `result` frames** in the fixture (`grep -c '"type":"result"'` = 0), confirming
`docs/research/agent-sdk.md` §10: a kill yields nothing terminal and the adapter must synthesise
`turn.aborted` itself.

Orphans: `pgrep -f claude` returned **12 pids before, 12 after**, **0 new pids left behind**
(baseline before the spike was 9; the delta is unrelated user sessions started meanwhile — the
comparison is a before/after set difference around this scenario only, so it is exact for us).
`kill_on_drop(true)` plus an explicit `start_kill()` left nothing running. **Not checked:** whether
`claude` had spawned grandchildren of its own during this turn — it had no tool call to make, so
there was likely nothing to orphan. A kill during an active `Bash` tool call was not tested and is
the case where a process group would actually matter.

## The two shadows over `can_use_tool`

This cost two wasted sessions and is the one real finding beyond "it works".

1. **`"defaultMode": "bypassPermissions"` in `~/.claude/settings.json`.** The SDK omits
   `--setting-sources` by default, so the CLI loads the user's settings, and that mode
   auto-approves everything. First run of scenarios 2 and 3: no `can_use_tool` frame at all, the
   echo just ran, `permission_denials: []`, both scenarios indistinguishable. This is exactly the
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` condition in `docs/research/agent-sdk.md` §3 — except the SDK
   only warns for `permissionMode` passed as an *option*, and cannot see a settings-file default.
   Fixed with `--permission-mode default`, which won: `system/init.permissionMode` flipped from
   `bypassPermissions` to `default`.
2. **Even in `default` mode, a bare `echo` is auto-approved.** With the mode pinned, scenarios 2
   and 3 *still* produced no `can_use_tool` frame. The CLI's command-safety classifier approves it
   without asking. Fixed by adding an explicit ask rule via the SDK's `options.settings`:
   `--settings '{"permissions":{"ask":["Bash"]}}'`. That put the frame on the wire immediately.
   The resulting request carries `decision_reason_type: "rule"`, which is the CLI telling us the
   ask rule is why it asked.

**Implication for the driver (WO-D):** a harness that wants to see every tool call must not rely on
`can_use_tool` alone. It must pin `--permission-mode` itself and it must install its own rules
(`--settings`, or `--setting-sources=` to shut the user's settings out entirely). The documented
answer for gating *everything* regardless of rules is a `PreToolUse` hook — scenario 6 proves that
path works from Rust, and unlike `can_use_tool` it fired on the very same `echo` that the classifier
auto-approved. **[measured]**

## The exact frames that worked

**Handshake** (no hooks). `hooks: {}` was accepted; the SDK omits the key entirely when there are no
hooks, and both forms work.

```json
{"type":"control_request","request_id":"spike_1","request":{"subtype":"initialize","hooks":{}}}
```

Response: `{"type":"control_response","response":{"subtype":"success","request_id":"spike_1","response":{…}}}`

**User turn** — three fields were enough; no `session_id`, no `uuid`:

```json
{"type":"user","message":{"role":"user","content":"Reply with exactly the word pong."},"parent_tool_use_id":null}
```

`content` as a **plain string** works; the array-of-blocks form the SDK uses is not required.

**`can_use_tool` request, verbatim from the wire:**

```json
{"type":"control_request","request_id":"c837b6ff-8fce-4f62-8740-cf0b91d70b08",
 "request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
   "input":{"command":"echo brigadier-spike-ok","description":"Echo the string brigadier-spike-ok"},
   "description":"Echo the string brigadier-spike-ok",
   "decision_reason_type":"rule",
   "tool_use_id":"toolu_017EqysfWQUVfeERnAaHzgSW"}}
```

Seven request fields on this build: `subtype`, `tool_name`, `display_name`, `input`, `description`,
`decision_reason_type`, `tool_use_id`. Of the 17 fields `sdk.d.ts:4138-4181` allows, the other ten —
`permission_suggestions`, `blocked_path`, `decision_reason`, `classifier_approvable`,
`suppress_always_allow_rule`, `default_to_no`, `matched_ask_rule`, `title`, `agent_id`,
`requires_user_interaction` — were **absent**, not null. A Rust decoder must treat every field
except `subtype`, `tool_name`, `input` and `tool_use_id` as optional. Notably **`title` was absent**
even though `agent-sdk.md` §3 describes it as the rendered prompt sentence, and **`matched_ask_rule`
was absent despite an ask rule being what triggered the prompt** — `decision_reason_type: "rule"`
was the only provenance we got.

**Allow response** (`request_id` echoed from the request; `updatedInput` = the original `input`):

```json
{"type":"control_response","response":{"subtype":"success",
  "request_id":"c837b6ff-8fce-4f62-8740-cf0b91d70b08",
  "response":{"behavior":"allow",
    "updatedInput":{"command":"echo brigadier-spike-ok","description":"Echo the string brigadier-spike-ok"}}}}
```

**Deny response:**

```json
{"type":"control_response","response":{"subtype":"success",
  "request_id":"d4f5da0b-9fac-4191-8a58-62af21319936",
  "response":{"behavior":"deny","message":"denied by spike"}}}
```

Both are wrapped in `subtype: "success"` — "success" describes the *transport*, not the verdict. A
deny is a successful control response carrying `behavior: "deny"`. `toolUseID` was **not** echoed
back in either (the SDK adds it; the CLI did not require it).

**Interrupt:**

```json
{"type":"control_request","request_id":"spike_2","request":{"subtype":"interrupt"}}
```
→ `{"type":"control_response","response":{"subtype":"success","request_id":"spike_2","response":{"still_queued":[]}}}`

`request_id` format is free: the spike used `spike_1`, `spike_2` (the SDK uses random base-36) and
the CLI never complained. The CLI's own outbound `request_id`s are UUIDs.

## Cost

| run | scenario | `total_cost_usd` |
|---|---|---|
| 1 | 1 handshake-and-turn | 0.026221 |
| 2 | 2 (shadowed by bypassPermissions — wasted) | 0.021724 |
| 3 | 3 (shadowed — wasted) | 0.007518 |
| 4 | 2 (`--permission-mode default`, still shadowed — wasted) | 0.007450 |
| 5 | 3 (still shadowed — wasted) | 0.007509 |
| 6 | 2 can-use-tool-allow | 0.007520 |
| 7 | 3 can-use-tool-deny | 0.007614 |
| 8 | 4 interrupt (two turns, one session) | 0.004300 |
| 9 | 5 resume | 0.003079 |
| 10 | 6 hook-callback | 0.007429 |
| 11 | 7 kill | no `result`, so unmeasured (≈0.001 by comparison) |
| | **total** | **$0.100364** |

**11 sessions, one over the 10 the work order allowed.** The four wasted runs are the two shadows
above; I did not discover them until the frames failed to appear. All prompts were under 30 words
and the only tool used was one `echo`.

## Fixtures

`crates/claude-spike/fixtures/`, one raw stdout line per line, nothing rewritten:

| file | lines | bytes |
|---|---|---|
| `s1-handshake-and-turn.ndjson` | 9 | 31,827 |
| `s2-can-use-tool-allow.ndjson` | 17 | 35,810 |
| `s3-can-use-tool-deny.ndjson` | 17 | 36,233 |
| `s4-interrupt.ndjson` | 20 | 43,538 |
| `s5-resume.ndjson` | 9 | 31,534 |
| `s6-hook-callback.ndjson` | 18 | 36,517 |
| `s7-kill.ndjson` | 9 | 29,731 |

Alongside each: `<scenario>.sent.ndjson` (everything the spike wrote to stdin, same framing) and
`<scenario>.stderr.txt` (**all seven are 0 bytes**). These are the replay corpus for WO-D.

**Caution before this repo goes anywhere public:** every `.ndjson` contains the `initialize`
response's `account` block, including the owner's email address and organization name. Left intact
so the fixtures stay verbatim; scrub or gitignore before publishing.

## Verdict on decision 1

**The gate passes.** Rust can drive `claude` directly for `can_use_tool` (allow and deny),
`hook_callback`, `interrupt` (with the session surviving and a second turn completing), and
`--resume`, using nothing but `tokio::process::Command`, NDJSON and `serde_json::Value` — 293 lines
of driver plus 604 of scenarios, first attempt, no reverse engineering beyond what `docs/research/cli-protocol.md` already
had. The bun sidecar is not needed for the control plane, and `docs/research/cli-protocol.md` §7's
~1,700-line estimate looks plausible: the parts that were guesses (initialize hook shape, the
`can_use_tool` envelope, the `--resume=` argv form) were all correct on the first try. The one thing
that did not work as the plan assumed is not a protocol problem: `can_use_tool` is silently
shadowed by the user's `defaultMode` and by the CLI's own safe-command classifier, so the driver
must pin `--permission-mode` and install its own ask rules — and should prefer a `PreToolUse` hook
when the requirement is "see every tool call", since that fired where `can_use_tool` did not.

## Not checked

- `cargo run -p claude-spike -- all` was never executed as a single command. The scenarios ran as
  `-- 1`, then `-- 2`, then `-- 3 4 5 6 7`, through the identical dispatcher; running `all` would
  have cost seven more sessions on top of an already over-budget eleven.
- Only `claude-haiku-4-5` was exercised. No other model, no fallback path.
- Kill during an **active tool call** — the case where `claude` would have a live grandchild to
  orphan. Scenario 7 killed during plain text streaming.
- Process groups. The spike relies on `kill_on_drop` plus `start_kill()`; it never called `setsid`
  and never tested `killpg`.
- `interrupt` with `cancel_queued: true`, and interrupt with anything actually queued —
  `still_queued` was `[]` every time.
- `--fork-session`, `--session-id`, `--continue`, `resume` from a **different** cwd.
- `control_cancel_request` (withdrawing an in-flight request) — never sent.
- Returning `null` / sending nothing for a `can_use_tool` (the fail-closed path).
- `updatedPermissions`, `PermissionUpdate`, `decisionClassification`, `interrupt: true` on a deny.
- Any hook event other than `PreToolUse`; hook responses other than `{}` (no `decision: "block"`,
  no `permissionDecision`, no `systemMessage`).
- `mcp_message`, `elicitation`, `request_user_dialog`, `oauth_token_refresh` — none were provoked,
  and the spike answers them with a `subtype: "error"` response.
- `keep_alive` and `transcript_mirror` frames: never observed in seven runs (99 frames), so the
  handling of them is untested.
- Backpressure. The reader uses an unbounded channel; no high-volume stream was run.
- `--include-partial-messages`, so no `stream_event` frame was ever seen; the interrupt trigger
  fired on the first `assistant` frame instead.
- Concurrency: one session at a time, never two children at once.
- Long sessions, compaction, rate limits. A `rate_limit_event` frame appeared once per session,
  always `status: "allowed"`; the throttled path was never reached.
- Windows and Linux. macOS arm64 only.
