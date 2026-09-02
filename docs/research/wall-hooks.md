# The wall on hooks: which hook events the CLI really delivers over the control protocol

Date: 2026-09-02. Status: **executed against a live account**, three sessions, `$0.160698` spent.
Every claim below is marked **[measured]** (a frame in `crates/claude-spike/fixtures/`),
**[binary]** (a schema string embedded in the shipped `claude` executable), **[docs]** (the public
hooks reference) or **[asserted]**. Follow-on to `docs/research/claude-direct-spike.md`, which
proved `PreToolUse` and stopped there.

Spike code: `crates/claude-spike/src/wall.rs` (scenarios 8, 9, 10) on top of the WO-C driver in
`crates/claude-spike/src/session.rs`. Fixtures: `crates/claude-spike/fixtures/s8-*`, `s9-*`, `s10-*`.

## Bottom line

- **The brevity wall can be built on `Stop`.** A `hook_callback` for `Stop` answered
  `{"decision":"block","reason":"…"}` stopped the turn from ending, delivered the reason to the
  model as a `user` frame, produced a second assistant reply, and set `stop_hook_active: true` on the
  next `Stop` so the bounce can be limited to once per turn. **[measured]**
- **The host/subagent split can be built on `agent_id`.** It is present on every `hook_callback`
  raised from inside an `Agent` subagent and absent on every host-side one — including the
  `PreToolUse` for the `Agent` tool call itself, which is the host's. **[measured]**
- **`deny` is usable for `Read`.** `permissionDecision: "deny"` blocked the `Read` and reached the
  model as `tool_result` with `is_error: true` carrying the reason verbatim — but the model then
  read the same file with `Bash head -1`, so a wall that names tools instead of registering
  `matcher: ""` is not a wall. **[measured]**

## Environment

| | |
|---|---|
| CLI binary | `/Users/stephen/.local/bin/claude` → `~/.local/share/claude/versions/2.1.258` (Mach-O arm64) |
| CLI version | `2.1.258 (Claude Code)` **[measured]** |
| Model | `claude-haiku-4-5` on every run **[measured]** |
| Session cwd | a fresh scratch git repo, one `README.md` whose first word is `blueberry` |
| stderr | **0 bytes in all three runs** **[measured]** |
| `can_use_tool` frames | **zero, in all three runs** (`grep -c can_use_tool` = 0) **[measured]** |

### Exact argv

The WO-C base argv (`docs/research/claude-direct-spike.md` §"Exact argv") plus, on **all three**
runs, `--permission-mode default`. The mode is pinned for the same reason WO-C pinned it: the
owner's `~/.claude/settings.json` sets `"defaultMode": "bypassPermissions"`.

```
/Users/stephen/.local/bin/claude \
  --output-format stream-json --verbose --input-format stream-json \
  --model claude-haiku-4-5 --permission-prompt-tool stdio \
  --permission-mode default
```

**One deviation, run 10 only:** `--strict-mcp-config` was appended. It drops the owner's MCP
servers from the system prompt — `system/init.tools` fell from **125 to 33** and `mcp_servers` from
2 to 0 **[measured]** — which is what kept the third run inside the budget after run 9 overshot. It
changes the tool list, not the hook plumbing. No `--settings` and no ask rule was used anywhere;
unlike `can_use_tool`, hooks need neither.

Environment handling is unchanged from `session.rs` (full parent env inherited, `USER` intact,
`CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `NODE_OPTIONS`/`DEBUG` removed, plus the `HARNESS_VARS` de-nesting
list). `SPIKE_CWD` is now an environment override so a spike can point at its own scratch repo.

## (a) Do events beyond `PreToolUse` fire?

**Yes — `PostToolUse`, `Stop`, `SubagentStart` and `SubagentStop` all produced real `hook_callback`
control requests. [measured]**

Registered in `initialize` (run 8, `s8-hook-events.sent.ndjson` line 1, reformatted):

```json
{"type":"control_request","request_id":"spike_1",
 "request":{"subtype":"initialize","hooks":{
   "PreToolUse":  [{"matcher":"","hookCallbackIds":["cb_pre"]}],
   "PostToolUse": [{"matcher":"","hookCallbackIds":["cb_post"]}],
   "Stop":        [{"matcher":"","hookCallbackIds":["cb_stop"]}],
   "SubagentStop":[{"matcher":"","hookCallbackIds":["cb_substop"]}]}}}
```

`hooks_applied: true` came back, which — as `claude-direct-spike.md:217` warns — proves nothing.
The proof is the frames. Prompt: *"Use the Bash tool to run: echo brigadier-wall-ok. Then reply
done."* Callbacks arrived in this order **[measured]**:

```
PreToolUse   cb_pre   tool=Bash  @3196ms
PostToolUse  cb_post  tool=Bash  @3539ms
Stop         cb_stop             @4720ms
result/success                   @4721ms
```

**`Stop` fires 1 ms before the `result` frame, not after it.** **[measured]** An adapter that closes
the turn on `result` and stops reading will still have seen `Stop` first, but it must not assume the
ordering is the other way round.

`PostToolUse` request, verbatim (cwd and transcript path elided):

```json
{"type":"control_request","request_id":"44cb9015-ea6a-4852-a621-576c5e23f7b6",
 "request":{"subtype":"hook_callback","callback_id":"cb_post",
   "tool_use_id":"toolu_01LapvYx28dMpMaUuWvYZVkr",
   "input":{"cwd":"<CWD>","duration_ms":298,"hook_event_name":"PostToolUse",
     "permission_mode":"default","prompt_id":"36bbf72b-…","session_id":"f1139397-…",
     "tool_input":{"command":"echo brigadier-wall-ok","description":"Echo the string brigadier-wall-ok"},
     "tool_name":"Bash",
     "tool_response":{"interrupted":false,"isImage":false,"noOutputExpected":false,
                      "stderr":"","stdout":"brigadier-wall-ok"},
     "tool_use_id":"toolu_01LapvYx28dMpMaUuWvYZVkr","transcript_path":"<PROJ>/<sid>.jsonl"}}}
```

`Stop` request, verbatim:

```json
{"type":"control_request","request_id":"b4b977d8-de22-41e9-8f33-b3396d5fbba2",
 "request":{"subtype":"hook_callback","callback_id":"cb_stop",
   "tool_use_id":"26edee43-f5d7-4663-bb43-2981895581eb",
   "input":{"background_tasks":[],"cwd":"<CWD>","hook_event_name":"Stop",
     "last_assistant_message":"done.","permission_mode":"default","prompt_id":"36bbf72b-…",
     "session_crons":[],"session_id":"f1139397-…","stop_hook_active":false,
     "transcript_path":"<PROJ>/<sid>.jsonl"}}}
```

Two details a Rust decoder must not trip on **[measured]**:

- The envelope's `tool_use_id` on a non-tool event is a **plain UUID**, not a `toolu_…` id. It is
  not a tool use. Do not key anything on it.
- `PostToolUse.tool_response` is an **object** for `Bash` (`{stdout, stderr, interrupted, isImage,
  noOutputExpected}`), not the string the public docs describe as `tool_output` **[docs]**. Decode
  it as `Value`.

`SubagentStop` did not fire in run 8 because run 8 had no subagent; it fired in run 9 (below).

Corroboration, not measurement: the shipped binary's own zod schema keys the `initialize` `hooks`
map on the full 33-name `HOOK_EVENTS` list — `["PreToolUse","PostToolUse","PostToolUseFailure",
"PostToolBatch","Notification","UserPromptSubmit",…,"Stop","StopFailure","SubagentStart",
"SubagentStop",…]` — so the map accepts every event name, and the three tested are not special
**[binary]**. Whether the other 28 actually fire is untested.

## (b) `agent_id` and `agent_type` over the control protocol

**Both present on every callback raised inside a subagent; both absent on every host-side callback.
[measured]**

Run 9 registered `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, all with
`matcher: ""`. Prompt asked for a `Task` tool call; **the CLI's tool is named `Agent`** on this
build — `tool_name: "Agent"`, with `subagent_type: "general-purpose"` in `tool_input` **[measured]**.

Ten callbacks, split cleanly **[measured]**:

| without `agent_id` (host) | with `agent_id` (subagent) |
|---|---|
| `PreToolUse/ToolSearch`, `PostToolUse/ToolSearch` | `SubagentStart` |
| `PreToolUse/Agent`, `PostToolUse/Agent` | `PreToolUse/Bash`, `PostToolUse/Bash` |
| `Stop` ×2 | `SubagentStop` |

The line that matters for the wall: **the `PreToolUse` for the `Agent` tool call itself carries no
`agent_id`** — it is the host asking to spawn a subagent — while the `Bash` the subagent then runs
carries `agent_id: "ac602b38daf9dbdc5"`, `agent_type: "general-purpose"`. A policy keyed on
"`agent_id` present ⇒ subagent" separates them exactly.

Host-side `PreToolUse` for the spawn (trimmed):

```json
{"request":{"subtype":"hook_callback","callback_id":"cb_pre",
  "tool_use_id":"toolu_01XW7tG45rDw919B6zhTthWw",
  "input":{"cwd":"<CWD>","hook_event_name":"PreToolUse","permission_mode":"default",
    "prompt_id":"78a7b6f1-…","session_id":"a4c14e33-…",
    "tool_input":{"description":"Test subagent task execution",
      "prompt":"Run the Bash command: echo brigadier-sub-ok, then reply with the word ok.",
      "subagent_type":"general-purpose"},
    "tool_name":"Agent","tool_use_id":"toolu_01XW7tG45rDw919B6zhTthWw",
    "transcript_path":"<PROJ>/<sid>.jsonl"}}}
```

Subagent-side `PreToolUse` for its `Bash` (trimmed) — note the two extra keys at the top:

```json
{"request":{"subtype":"hook_callback","callback_id":"cb_pre",
  "tool_use_id":"toolu_01BATwoh2V9GziLM9zReFj3P",
  "input":{"agent_id":"ac602b38daf9dbdc5","agent_type":"general-purpose",
    "cwd":"<CWD>","hook_event_name":"PreToolUse","permission_mode":"default",
    "prompt_id":"78a7b6f1-…","session_id":"a4c14e33-…",
    "tool_input":{"command":"echo brigadier-sub-ok","description":"Echo the test string"},
    "tool_name":"Bash","tool_use_id":"toolu_01BATwoh2V9GziLM9zReFj3P",
    "transcript_path":"<PROJ>/<sid>.jsonl"}}}
```

`SubagentStart` and `SubagentStop` (trimmed) carry them too, plus `agent_transcript_path`:

```json
{"request":{"subtype":"hook_callback","callback_id":"cb_substart",
  "tool_use_id":"6464f80b-1945-4b3a-aa19-94b89e89dbec",
  "input":{"agent_id":"ac602b38daf9dbdc5","agent_type":"general-purpose","cwd":"<CWD>",
    "hook_event_name":"SubagentStart","prompt_id":"78a7b6f1-…","session_id":"a4c14e33-…",
    "transcript_path":"<PROJ>/<sid>.jsonl"}}}

{"request":{"subtype":"hook_callback","callback_id":"cb_substop",
  "tool_use_id":"871b9889-307d-4283-a4a5-6f51b233be80",
  "input":{"agent_id":"ac602b38daf9dbdc5",
    "agent_transcript_path":"<PROJ>/<sid>/subagents/agent-ac602b38daf9dbdc5.jsonl",
    "agent_type":"general-purpose",
    "background_tasks":[{"agent_type":"general-purpose","description":"Test subagent task execution",
                         "id":"ac602b38daf9dbdc5","status":"running","type":"subagent"}],
    "cwd":"<CWD>","hook_event_name":"SubagentStop","last_assistant_message":"ok",
    "permission_mode":"default","prompt_id":"78a7b6f1-…","session_crons":[],
    "session_id":"a4c14e33-…","stop_hook_active":false,"transcript_path":"<PROJ>/<sid>.jsonl"}}}
```

The `agent_id` is a 17-char hex-ish token (`ac602b38daf9dbdc5`), **not** a UUID and **not** the
`session_id`. The session id is shared by host and subagent. **[measured]**

Corroboration: the binary's own description of the field is unambiguous — *"Subagent identifier.
Present only when the hook fires from within a subagent (e.g., a tool called by an AgentTool
worker). Absent for the main thread, even in `--agent` sessions. Use this field (not `agent_type`)
to distinguish subagent calls from main-thread calls."* **[binary]** That is exactly the wall's
rule, written by the CLI's own authors.

`crates/claude-wire/src/control.rs:186` models `agent_id` on the **`can_use_tool`** request. **That
field is still unmeasured**: `can_use_tool` did not fire once in these three runs (0 occurrences
across 119 frames). The populated `agent_id` measured here is on `hook_callback.input`, which is a
different struct.

### The surprise in run 9: one user frame, two `result` frames

The `Agent` tool ran the subagent **asynchronously**. The host's first turn ended immediately with
`result#1 = "Subagent launched and running in the background. I'll wait for the completion
notification."`, then the subagent finished, woke the session, and a **second** assistant turn
produced `result#2 = "done"` — with **no second user frame written by us**. **[measured]**

Frame census, run 9 (66 frames): `assistant` 12, `system/thinking_tokens` 29,
`control_request/hook_callback` 10, `user` 3, `system/init` **2**, `result/success` **2**,
`rate_limit_event` 1, `control_response` 1, plus five system subtypes the WO-C 99-frame census never
saw: `system/background_tasks_changed` ×2, `system/task_started`, `system/task_progress`,
`system/task_updated`, `system/task_notification`. Run 10 additionally produced `system/notification`.
**[measured]**

Two consequences for the driver, both **[asserted]** from this one observation:

- A turn is not over at the first `result`. A background subagent can reopen the session and emit
  another `result` with no prompt from the harness. Anything that maps one user message to one
  result will desynchronise.
- Six more `system` subtypes must decode to a catch-all variant.

## (c) `permissionDecision: "deny"` on a non-Bash tool (`Read`)

**Deny works on `Read`. [measured]** Run 10 registered `PreToolUse` with `matcher: "Read"` and
answered:

```json
{"type":"control_response","response":{"subtype":"success",
  "request_id":"545ce041-80e4-4332-9fc9-eb1c70c9e3ac",
  "response":{"hookSpecificOutput":{"hookEventName":"PreToolUse",
    "permissionDecision":"deny",
    "permissionDecisionReason":"brigadier wall: the host session may not read files"}}}}
```

The model received it as an errored tool result — the exact `user` frame off the wire:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"tool_result","content":"brigadier wall: the host session may not read files",
   "is_error":true,"tool_use_id":"toolu_01VG5B459UafcvWcwGYRi5A6"}]}}
```

and the turn's `result.permission_denials` carried the entry, same three-field shape WO-C measured
for Bash:

```json
[{"tool_input":{"file_path":"<CWD>/README.md"},"tool_name":"Read",
  "tool_use_id":"toolu_01VG5B459UafcvWcwGYRi5A6"}]
```

`permissionDecisionReason` **is** echoed into the `tool_result` content — unlike a `can_use_tool`
deny `message`, which WO-C measured as *not* echoed into `permission_denials`. **[measured]**

**The finding that actually matters: the model routed around the deny in the same turn.** With the
matcher scoped to `"Read"`, it immediately ran `Bash head -1 README.md`, which no hook was watching,
and got `blueberry pancakes are the reference string for the brigadier wall spike` into its context.
The `PostToolUse` callback (matcher `""`) recorded it verbatim. **[measured]** The scenario is
marked FAIL for exactly this reason: deny did its job, the wall did not.

Implication for the wall, **[asserted]**: register `PreToolUse` with `matcher: ""` and decide on
`tool_name` inside the policy. Denying `Read` alone leaves `Bash`, `Grep`, `Glob`, `NotebookRead`
and every MCP tool open. The bypass here was not adversarial — the model was being helpful.

## (d) What `Stop` carries, and whether a non-empty response bounces the turn

**It bounces. [measured]** Same session as (c), so the bounced turn is the turn whose `Read` was
denied — a deliberate confound, taken to stay inside the spend cap.

`Stop` input keys, first callback: `background_tasks`, `cwd`, `hook_event_name`,
`last_assistant_message`, `permission_mode`, `prompt_id`, `session_crons`, `session_id`,
`stop_hook_active`, `transcript_path`. `last_assistant_message` carried the **full** reply text
(`"The first word is: **blueberry**"`), so a brevity policy needs no transcript read.
`stop_hook_active: false`. **[measured]**

Answered:

```json
{"type":"control_response","response":{"subtype":"success",
  "request_id":"2d3a57fc-505a-4e6c-b48f-be55ae08d251",
  "response":{"decision":"block",
    "reason":"brigadier wall: that reply is too long. Reply with exactly the word ok."}}}
```

What happened next, in order **[measured]**:

1. The CLI injected the reason into the conversation as a plain `user` frame:
   `{"type":"user","message":{"role":"user","content":[{"type":"text",
   "text":"Stop hook feedback:\nbrigadier wall: that reply is too long. Reply with exactly the word ok."}]}}`
2. The model produced a **second** assistant message: `"ok"`.
3. A second `Stop` callback arrived, `last_assistant_message: "ok"`, **`stop_hook_active: true`**.
4. Answered `{}` → the turn ended. **One** `result` frame for the whole bounced turn,
   `subtype: "success"`, `result: "ok"`, `num_turns: 4`. **[measured]**

So the brevity wall's shape is: on `Stop`, if `stop_hook_active` is `true` you have already bounced
this turn — answer `{}`. Otherwise measure `last_assistant_message` and either answer `{}` or
`{"decision":"block","reason":…}`. The CLI maintains the once-per-turn flag itself; the harness does
not need to. **[measured for the two-callback case; a third bounce was not attempted]**

### This contradicts `docs/research/agent-sdk.md`

`docs/research/agent-sdk.md` line ~205 lists the `Stop`/`SubagentStop` output as
"`additionalContext?` — non-error feedback, **conversation continues**". That understates it: the
response that actually bounced the turn was **top-level `decision: "block"` plus top-level
`reason`**, not `hookSpecificOutput.additionalContext`. The binary's own sync-hook-output schema has
both fields at the top level — `{continue?, suppressOutput?, stopReason?, decision: "approve"|"block",
systemMessage?, terminalSequence?, reason?, hookSpecificOutput?}` **[binary]** — which matches what
was measured. Research beats the plan: **`Stop` can block, and it blocks from the top level of the
response body.**

Also worth flagging: the public hooks reference describes the Stop block as living **inside**
`hookSpecificOutput` (`{"hookSpecificOutput":{"hookEventName":"Stop","decision":"block","reason":…}}`)
**[docs]**. That form was **not tested**. The top-level form is the one with a frame behind it.

## Cost

| run | scenario | `result` frames | `total_cost_usd` |
|---|---|---|---|
| 1 | 8 hook-events | 1 | 0.029722 |
| 2 | 9 subagent-agent-id | 2 (0.049362 + 0.057084) | 0.106446 |
| 3 | 10 deny-read + stop-bounce | 1 | 0.024530 |
| | **total** | | **$0.160698** |

**Over the $0.15 cap by $0.0107, and the overrun is entirely run 9.** Its async subagent turned one
planned turn into two billed turns (`num_turns` 3 then 1), and the 125-tool/2-MCP-server system
prompt was paid twice. Run 10 was merged from two planned scenarios and given
`--strict-mcp-config` in response; at 33 tools it cost less than run 8 despite doing more. No fourth
run was attempted once the cap was passed.

## Fixtures

`crates/claude-spike/fixtures/`, raw stdout one line per line, nothing rewritten:

| file | lines | bytes |
|---|---|---|
| `s8-hook-events.ndjson` | 19 | 38,066 |
| `s9-subagent-agent-id.ndjson` | 66 | 76,531 |
| `s10-deny-read-stop-bounce.ndjson` | 34 | 43,050 |

Each has a `.sent.ndjson` (everything written to stdin), a `.stderr.txt` (**all three 0 bytes**), and
new to this spike a **`.hooks.ndjson`** — every `hook_callback` request paired with the exact
response the spike sent, in order. That last file is the replay corpus for a hook policy.

**Same caution as WO-C:** every `.ndjson` contains the `initialize` response's `account` block with
the owner's email and organization. Scrub or gitignore before this repo goes anywhere public.

## What I did NOT check

- **The other 28 hook events.** Only `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`,
  `SubagentStop` were registered. `UserPromptSubmit`, `SessionStart`, `PreCompact`, `PostToolUseFailure`
  and the rest are accepted by the schema **[binary]** but never observed firing.
- **`can_use_tool.agent_id`** (`crates/claude-wire/src/control.rs:186`). No `can_use_tool` frame
  appeared in any of the three runs, so that field remains unmeasured. Only
  `hook_callback.input.agent_id` was measured.
- **The `hookSpecificOutput` form of a Stop block** (`{"hookSpecificOutput":{"hookEventName":"Stop",
  "decision":"block",…}}`), which the public docs show. Only the top-level `decision`/`reason` form
  was sent.
- **A second bounce.** `stop_hook_active: true` was observed, but the spike answered `{}` there. What
  the CLI does if you block again while `stop_hook_active` is true is untested — including whether it
  loops forever.
- **`SubagentStop` blocking.** Never answered anything but `{}`. Whether a subagent's turn can be
  bounced the way the host's can is unknown.
- **`PostToolUse` outputs**: `additionalContext`, `updatedToolOutput`, `classifierContext` — all
  answered `{}`. Whether the harness can rewrite a tool result is untested.
- **`PreToolUse` `permissionDecision` values other than `deny`**: `allow`, `ask`, `dontAsk`,
  `defer`, and `updatedInput` (rewriting a tool's arguments) were never sent.
- **Deny under `matcher: ""`.** The one thing the wall will actually ship with. Run 10 used
  `matcher: "Read"` and the model escaped through `Bash`; blocking every tool from one callback is
  the obvious next measurement and was not made, because the budget was gone.
- **Deny inside a subagent** — that subagents keep the permissions the host is refused was never
  exercised; only the *distinguishability* of the two was.
- **Hook timeouts.** The `timeout` field on `HookCallbackMatcher` was never set, and the spike always
  answered promptly. What happens when a hook answer is slow or never comes is untested; the binary
  carries `hook_callback_timeout` and `tengu_sdk_hook_callback_timeout` telemetry names **[binary]**,
  so there is a timeout to find.
- **A response body the CLI rejects.** Every response the spike sent validated; the error path is
  unseen.
- **Interaction with the owner's own settings hook.** `~/.claude/settings.json` has a `PreToolUse`
  Bash command hook; it was left loaded in all three runs and never observed to conflict, but
  conflict resolution between a settings hook and an SDK hook was not deliberately provoked.
- **Any model but `claude-haiku-4-5`**, any platform but macOS arm64, and any CLI but 2.1.258.
- **Whether `Stop` fires on an interrupted or errored turn.** All three runs ended `success`.
