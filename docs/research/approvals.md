# Approvals end to end: `can_use_tool` from the CLI to the UI and back

Date: 2026-09-02. Question: what must be true for a real Claude Code session to raise a `Bash`
permission prompt, show it in the approvals panel, take a deny, let the model see the deny, then
take an allow on a second turn — with the pending prompt surviving a webview reload.

Claims are marked **[measured]** (fixture, binary string table, or a local command run today),
**[documented]** (URL, fetched 2026-09-02) or **[asserted]** (reasoned, not checked).

Prior briefs, not repeated: `docs/research/cli-protocol.md` §2/§5, `docs/research/claude-direct-spike.md`
("The two shadows over `can_use_tool`"), `docs/research/agent-sdk.md` §3–§4, `docs/plans/ipc-contract.md`.

---

## 0. Bottom line

The plumbing is complete and unit-tested against the real captures. **One thing is missing: nothing
makes the CLI ask.** `crates/core/src/claude/process.rs:87-109` ships no ask rule, and
`crates/core/src/claude/hook.rs:45-49` answers every `PreToolUse` with `{}` — no opinion. Claude Code
runs a **non-configurable set of read-only Bash commands with no prompt in every mode**, `ls` and
`echo` among them, so the approvals panel would stay empty for the exact prompt
`docs/plans/next-session.md:72` suggests (``Run `ls` and report the count``).

Fix: make the `PreToolUse` hook return `permissionDecision: "ask"`. §6 gap 1.

---

## 1. Two corrections to what this repo already believes

**(a) The control protocol is no longer undocumented.** `docs/research/cli-protocol.md` §3 says
"Zero occurrences of `control_request`, `control_response` or `can_use_tool` anywhere on
docs.claude.com or code.claude.com". That was measured against a redirect shell:
`docs.claude.com/en/docs/claude-code/*` now **301s to `code.claude.com/docs/en/*`**, and the
permissions content moved out of `/docs/en/iam` into `/docs/en/permissions` and
`/docs/en/permission-modes`. All three terms now appear on
https://code.claude.com/docs/en/agent-sdk/typescript. **[documented]**

Published there: the envelope and the correlation rule — `{ type: "control_request", request_id,
request }`, "a `control_response` … must echo this value", and `pending_permission_requests` on a
re-`initialize`. The **payload schema is still unpublished** (no `can_use_tool` field list, no
`control_response` shape, no subtype enumeration), and `--permission-prompt-tool stdio` remains
undocumented in prose — zero hits across cli-reference, headless, permissions, permission-modes,
hooks, settings-reference, env-vars — confirmed only in first-party SDK source
(`claude-agent-sdk-python` `types.py`, `permission_prompt_tool_name="stdio"`). **[documented]**
So §5 of `cli-protocol.md` still stands; §3's headline does not.

**(b) It is not a classifier.** `process.rs:84`, `hook.rs:5-7` and `claude/mod.rs` all attribute the
auto-approved `echo` to "the CLI's own command-safety classifier". The docs name a different, simpler
mechanism — https://code.claude.com/docs/en/permissions#read-only-commands, verbatim: **[documented]**

> Claude Code recognizes a built-in set of Bash commands as read-only and runs them **without a
> permission prompt in every mode**. These include `ls`, `cat`, `echo`, `pwd`, `head`, `tail`,
> `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, and read-only forms of `git`. **The set
> is not configurable**; to require a prompt for one of these commands, add an `ask` or `deny` rule
> for it.

Static parsing, not a model. A command it cannot parse, or one over 10,000 characters, prompts. The
*model-based* classifier is a separate thing, bound to `--permission-mode auto`, running on Sonnet 5
and billable on API accounts. The quote's last sentence is also why the spike's ask rule worked on a
bare `echo`. **[documented + measured, s2/s3]**

---

## 2. Environment, pinned today

`claude --version` → **`2.1.258 (Claude Code)`** at `/Users/stephen/.local/bin/claude`. The repo's
floor is `2.1.257` (`crates/core/src/claude/driver.rs:261`) and the fixtures were captured on
`2.1.257`. `~/.claude/settings.json` still has `permissions.defaultMode: "bypassPermissions"`,
`permissions.allow: ["mcp__pencil"]`, and a `PreToolUse` `Bash` command hook. **[all measured]**

No `Bash` allow rules there, so nothing shadows the gate beyond `defaultMode` — which
`process.rs:106-107` neutralises by pinning `--permission-mode` unconditionally. The 2.1.257
changelog now **ignores** `defaultMode: "bypassPermissions"` in project/local settings, but the
owner's is in *user* settings, where it still applies. **[documented + measured]**

---

## 3. `--permission-mode` on 2.1.258

`claude --help` lists six choices and **omits `default`**: `acceptEdits`, `auto`, `bypassPermissions`,
`manual`, `dontAsk`, `plan`. Probed with `--version` (commander validates options first — `bogusvalue`
exits 1 with the choice list), `default` and all six exit 0. **[measured]**

The docs resolve it — https://code.claude.com/docs/en/cli-reference, verbatim: **[documented]**

> Accepts `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, or **`manual` as
> an alias for `default`**. The `manual` alias … requires Claude Code v2.1.200 or later; `claude
> --help` lists it in place of `default`, and both values work.

So `crates/core/src/driver.rs:117` is safe and not a drift hazard. But **seven values exist and the
repo models four**: `crates/core/src/driver.rs:82` and `:113` record the set as
`default|acceptEdits|bypassPermissions|plan|dontAsk|auto` in a comment and model only the first four
plus `Other`. `manual` is missing from even the comment. Reach for `default` (or `manual`) for this
run: for `claude -p` / SDK-driven sessions the documented starting mode is `default`, **not** `auto`.

Other flags parsed clean: `--permission-prompt-tool stdio`, `--settings '{"permissions":{"ask":["Bash"]}}'`,
`--setting-sources=`. Both `--dangerously-skip-permissions` (= `bypassPermissions`) and
`--allow-dangerously-skip-permissions` (only adds bypass to the Shift-Tab cycle) exist and mean
different things. **[measured + documented]**

---

## 4. The wire, verbatim from the fixtures

### `can_use_tool` for `Bash` — **[measured]**, `s2-can-use-tool-allow.ndjson`

```json
{"type":"control_request","request_id":"c837b6ff-8fce-4f62-8740-cf0b91d70b08",
 "request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
   "input":{"command":"echo brigadier-spike-ok","description":"Echo the string brigadier-spike-ok"},
   "description":"Echo the string brigadier-spike-ok",
   "decision_reason_type":"rule",
   "tool_use_id":"toolu_017EqysfWQUVfeERnAaHzgSW"}}
```

Seven fields, all **snake_case**. `permission_suggestions`, `blocked_path`, `decision_reason`,
`matched_ask_rule`, `title`, `agent_id`, `classifier_approvable`, `suppress_always_allow_rule`,
`default_to_no`, `requires_user_interaction` were **absent, not null** — even `matched_ask_rule`,
despite an ask rule being why it asked.

**A `Write` `can_use_tool` has never been captured** here. Same envelope, `input` would be
`{file_path, content}`; `blocked_path` plausibly appears for a path-blocked write. **[asserted]** —
do not assert its shape in a test until one is recorded. `crates/claude-wire/src/control.rs:162-200`
decodes every optional field and flattens the rest into `extra`, so no decoder change is needed.

### Responses — **[measured]**, `s2/s3 *.sent.ndjson`

```json
{"response":{"subtype":"success","request_id":"c837b6ff-…",
  "response":{"behavior":"allow","updatedInput":{"command":"echo brigadier-spike-ok","description":"…"}}},
 "type":"control_response"}
{"response":{"subtype":"success","request_id":"d4f5da0b-…",
  "response":{"behavior":"deny","message":"denied by spike"}},
 "type":"control_response"}
```

Envelope and `behavior`/`message`/`interrupt` are lowercase; payload keys are camelCase with a
capital D on the id — `updatedInput`, `updatedPermissions`, `toolUseID`, `decisionClassification`.
`crates/claude-wire/src/control.rs:615-653` spells all four correctly. `subtype: "success"` describes
the transport, not the verdict; `toolUseID` was omitted both times and the CLI did not care.
**[measured]** The published type matches and adds that `updatedInput` is optional on allow —
*"Before v2.1.207, Claude Code rejected an allow result that omitted `updatedInput`"* **[documented]**;
`adapter.rs:860-865` sends it anyway, correct on both sides of that boundary.

### What the model sees after a deny — **[measured]**, `s3-can-use-tool-deny.ndjson`

```json
{"type":"user","message":{"role":"user","content":[
   {"type":"tool_result","content":"denied by spike","is_error":true,
    "tool_use_id":"toolu_01RDttLRhpBcizQyc9P5zM3N"}]},
 "tool_use_result":"Error: denied by spike",
 "tool_result_meta":[{"id":"toolu_01RDttLRhpBcizQyc9P5zM3N","non_execution_kind":"permission-rule"}]}
```

The model then said: *"The bash command was denied by spike. It appears there's a permission or hook
restriction preventing this command from running."* The turn **completed normally** —
`result.subtype: "success"`, `is_error: false`, `terminal_reason: "completed"` — with
`permission_denials` carrying `{tool_name, tool_use_id, tool_input}` and **not** the message. Docs
agree: the deny `message` is the *"Rejection message returned to the model in the `tool_result`"*, and
`SDKPermissionDeniedMessage` exists so a UI can render the denial *"rather than only observing the
`is_error` tool result that follows"*. **[measured + documented]**

**`interrupt: true` is a field with no published semantics.** It appears in the `PermissionResult`
deny arm and nowhere in prose across five docs pages. Never sent in any scenario;
`src/components/Approvals.tsx:92` hard-codes `false`. Do not guess it — measure it or leave it alone.
**[documented that it is undocumented]**

### Timeout

**There is none, and that is documented.** https://code.claude.com/docs/en/agent-sdk/typescript:
*"leaves the tool call blocked indefinitely, because no `control_response` is ever sent and
**permission prompts don't time out**."* **[documented]** `MCP_TIMEOUT` (30 s) bounds only the
`--permission-prompt-tool` MCP server's *connect*; hook `timeout` defaults to **600 s** for command
hooks (not 60); `CLAUDE_AFK_TIMEOUT_MS` applies to `AskUserQuestion`, not tool prompts.

The only clock is ours: `DEFAULT_APPROVAL_TIMEOUT = 600 s` (`crates/core/src/claude/driver.rs:33`),
after which `ApprovalTable::time_out` denies the waiter with `reason: "timeout"` and the adapter
writes a real deny. Re-answer within ten minutes of the reload. **[measured]** If the child is ever
re-attached rather than kept alive, the documented mechanism is `pending_permission_requests` on a
re-`initialize`, redelivered possibly-duplicated — handle idempotently. **[documented]**

---

## 5. `PreToolUse` vs the permission prompt

Documented evaluation order (https://code.claude.com/docs/en/agent-sdk/permissions): hooks first,
then deny rules, ask rules, permission mode, allow rules, then `canUseTool`. And the load-bearing
warning: **[documented]**

> **Auto-approved tools never reach `canUseTool`.** … For checks that must run on every tool call,
> use a `PreToolUse` hook: hooks run before every other step, and a hook deny applies even in
> `bypassPermissions` mode.

The 2.1.258 binary carries its own zod schema for the hook answer — extracted with `strings`,
verbatim: **[measured]**

```js
c({hookEventName:x("PreToolUse"), permissionDecision:Zfr().optional(),
   permissionDecisionReason:i().optional(), updatedInput:ge(i(),de()).optional(),
   additionalContext:i().optional()})
var Zfr = m(() => ee(["allow","deny","ask","defer"]))
```

Four decisions, matching the docs: `"allow"` **skips the permission prompt** (except for actions no
mode auto-approves, `AskUserQuestion`/`ExitPlanMode`, critical-path `rm`/`rmdir`, and
`requiresUserInteraction` MCP tools); `"deny"` prevents the call; **`"ask"` prompts the user to
confirm**; `"defer"` exits so the tool can be resumed later. Multi-hook precedence is
`deny > defer > ask > allow`. Top-level `decision`/`reason` are **deprecated for PreToolUse**
(`"approve"`/`"block"` map to `allow`/`deny`) but remain current for PostToolUse and Stop.
**[documented + measured]**

So:

- `permissionDecision: "ask"` is the lever: it forces the prompt past the read-only command set.
- `{}` — what `AllowAll` sends today — is **not** `allow`; `permissionDecision` is `.optional()`, so
  it is "no opinion" and falls through to the normal flow. The type name is misleading. Fall-through
  for an empty `hookSpecificOutput` is **not stated verbatim** anywhere — it is stated for the
  top-level `decision` form and implied by the `defer` example. **[asserted]**
- `hooks_applied: true` on the initialize response proves nothing — it was `true` with `hooks: {}`,
  because the owner's settings file has its own `PreToolUse` Bash hook. **[measured]**

**`defer` is built for exactly this harness shape and is still not our architecture**: honoured
**only with `-p`** (which `CLAUDE.md` §2 forbids), one `--resume` round trip per call, ignored when a
turn has several tool calls. Holding a `control_response` open is the better fit. **[documented]**

---

## 6. Current code path, `file:line`

CLI → UI:

| step | location |
|---|---|
| argv: `--permission-prompt-tool stdio`, `--permission-mode <mode>`, **no** `--settings` | `crates/core/src/claude/process.rs:99-108` (comment at `:83-86` explains the omission) |
| hooks registered in `initialize`, matcher `""` (all tools) | `crates/core/src/claude/adapter.rs:310-316` |
| `hook_callback` answered from the policy | `adapter.rs:796-817`; policy `crates/core/src/claude/hook.rs:44-50` |
| `can_use_tool` dispatched | `adapter.rs:702-704` |
| park opened, `RequestKind::ToolPermission` built, `RequestOpened` emitted | `adapter.rs:757-790` |
| park with deadline, epoch-guarded timer | `crates/core/src/approval.rs:108-146` |
| `RequestOpened` → SQLite `approvals` row | `crates/store/src/feed.rs:179-186` → `crates/store/src/writer.rs:469-478` |
| `request-opened` is a signal envelope (always delivered, ignores project visibility) | `crates/supervisor/src/batcher.rs:52` |
| `approvals` table + partial index | `crates/store/src/schema.rs:96-106` |
| live: `request-opened` → approvals map | `src/feedStore.ts:223-233` |
| reload: `pending_approvals()` on mount → `seedApprovals` | `src/App.tsx:92,101`; `src/feedStore.ts:452-465` |
| render | `src/components/Approvals.tsx:59-191` |

UI → CLI:

| step | location |
|---|---|
| allow / deny buttons build a `Decision` | `Approvals.tsx:76-94` |
| `respond` invoke | `src/bridge.ts:121-122` → `src-tauri/src/commands.rs:132-144` |
| supervisor → session command channel | `crates/supervisor/src/lib.rs:398-408` |
| `ApprovalTable::resolve` wakes the parked oneshot | `crates/core/src/approval.rs:149-167` |
| forwarder task → adapter loop | `adapter.rs:776-782` |
| `Decision` → `PermissionResult` → `control_response` | `adapter.rs:851-888` |
| `RequestResolved` → `approvals.resolved_at` | `crates/store/src/feed.rs:187-190` → `writer.rs:479-484` |
| UI drops the card | `src/feedStore.ts:234-236` |

Reload survival: `run_id` is minted and open approvals expired **at `Store::open`**
(`crates/store/src/lib.rs:119-126`), once per process launch. A webview reload does not reopen the
store, so the row keeps `resolved_at IS NULL`, `run_id` still matches, the session is still live, and
`ApprovalView.expired` comes back `false` — answerable (`crates/supervisor/src/lib.rs:461-472`).
**[measured, by reading; not exercised]**

The adapter is already replay-tested against the real captures: `s2_can_use_tool_allow`,
`s3_can_use_tool_deny`, `s6_hook_callback_is_answered_with_an_empty_object`
(`crates/core/tests/claude_adapter.rs:379,441,537`). **[measured]**

---

## 7. Gaps — what to change, with the file

1. **Nothing forces the CLI to ask.** `crates/core/src/claude/hook.rs` — replace `AllowAll` with a
   policy returning `hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask",
   permissionDecisionReason: "…"}` for the gated tools. `HookJsonOutput.hook_specific_output` is
   already an untyped `Value` (`crates/claude-wire/src/control.rs:705-706`), so this is `hook.rs`
   alone; `ClaudeDriver::with_hook_policy` (`driver.rs:121`) is the seam, but
   `src-tauri/src/state.rs:181` never calls it, so change the default or add one builder call there.
   *Alternative:* `--settings '{"permissions":{"ask":["Bash"]}}'` in `process.rs:87-109` — measured
   working, and an ask rule does override the read-only set — but that is per-tool config rather than
   a gate, and `process.rs:83-86` already argues against it.
2. **Three permission modes are unmodelled.** `crates/core/src/driver.rs:84-124` — add `Auto`,
   `DontAsk`, `Manual`, and fix the comment at `:82`/`:113`, which omits `manual`. `default` is not
   deprecated (docs call `manual` its alias), so this is completeness, not a fix.
3. **Repo comments misname the read-only command set as a "classifier"** —
   `crates/core/src/claude/process.rs:84`, `hook.rs:5-7`, `mod.rs` (§"Two shadows"). Correct to the
   documented mechanism (§1b): the real classifier is `auto`-mode-only and billable, and conflating
   the two leads a reader to the wrong mode.
4. **The user's settings file is still loaded.** `crates/core/src/claude/process.rs:87-109` — no
   `--setting-sources=`. Harmless today (no `Bash` allow rules); a later allow rule would silently
   re-shadow the gate with no error anywhere. Record the decision either way. 2.1.248 also added
   `--restricted`, which ignores user/project/local settings and refuses `bypassPermissions`.
5. **`Write` has no recorded fixture.** `crates/claude-spike/fixtures/` — capture one in the same live
   run (a second turn, same session) rather than asserting its shape.
6. **`ApprovalView.resolved` is always `false`.** `crates/supervisor/src/lib.rs:461-472` — the query at
   `crates/store/src/writer.rs:238-247` filters `resolved_at IS NULL`, so the field carries no
   information and `src/feedStore.ts:454` guards on something that can never be true. Drop it from
   `docs/plans/ipc-contract.md` or widen the query. Related: our deny `reason` lands in
   `approvals.decision_json` and is never read back, and `permission_denials` omits it — no denial
   history is renderable today.
7. **A cross-project approval is hidden after a reload.** `src/App.tsx:172-180` filters
   `visibleApprovals` by `selectedProjectId`, and a reload resets the selection to `projectList[0]`.
   Invisible with one project; with two, the reload test will look like data loss.
8. **600 s park deadline.** `crates/core/src/claude/driver.rs:33` — the reload half of the test must
   finish inside it, or the harness sends a real deny and the card vanishes.

Nothing needs to change in `approval.rs`, `adapter.rs`, `store/`, `commands.rs`, `bridge.ts`,
`feedStore.ts` or `Approvals.tsx` for the happy path. **[measured, by reading]**

---

## 8. A prompt that forces exactly one `Bash` call

`docs/plans/next-session.md:72` suggests ``Run `ls` and report the count``. **`ls` is on the documented
read-only list and never prompts in any mode** — with today's code that run produces no prompt and
reads as a broken harness rather than a missing gate. **[documented]**

With gap 1 fixed (hook returns `ask` for `Bash`), or with an ask rule, the read-only set is overridden
and the command no longer matters. Recommended, on `claude-haiku-4-5`:

> `Run exactly one Bash command: ls -1. Report only the number of lines it printed. Do not use any other tool, and do not run any other command.`

Naming the tool and the literal command removes the model's freedom to pick `Read` or `Glob`; "exactly
one" and "do not run any other command" suppress the retry-with-a-variant behaviour that would open a
second prompt mid-test. **[asserted]** — no live run was made. Do **not** instead reach for a command
outside the read-only set (`mkdir`, a pipe into a writer) to provoke the prompt: that parser has been
patched three times in the last twelve releases, so prompt-worthiness is not stable. **[documented]**

Deny leg: expect the model to narrate the refusal rather than retry (s3), and `result.subtype:
"success"`. Allow leg: a **second turn** with the same sentence; `permission_denials` will be `[]` and
the `tool_result` will carry real stdout.

Cost: the spike's two permission scenarios cost **$0.007520** and **$0.007614** on `claude-haiku-4-5`,
one `echo` each. Deny + allow + reload should land near **$0.02**, under the $0.05 bar. **[measured]**

---

## 9. Risks

- **The read-only Bash parser is a moving target, not a boundary.** 2.1.246, 2.1.251 and 2.1.257 each
  fixed a permission bypass in it (dangling `&&`/`||`, arithmetic assignment, `[[ ]]` zsh parsing,
  compound-command ask-rule skips). Never let brigadier's gate depend on it. **[documented]**
- **`hooks_applied: true` proves nothing** — watch instead for a `hook_callback` with
  `callback_id == "brigadier_pre_tool_use"` (`hook.rs:24`). And the owner's own
  `gh-auth-switch-guard.sh` `PreToolUse` hook fires on every Bash call: a refusal mentioning
  `gh auth switch` is that hook, not ours. **[measured]**
- **A never-sent answer wedges the tool forever** — no CLI-side timeout. The teardown fan-out
  (`adapter.rs:1007-1015`, `approval.rs:171-181`) is what prevents it. Do not remove it.
- **`anthropics/claude-code#34046`** ("CLI does not emit `can_use_tool` when
  `--permission-prompt-tool stdio`", 2026-03-13, against 2.1.73) was **closed as not planned**. Our
  spike measured the frame arriving on 2.1.257, so it does not describe current behaviour — but it is
  a live reminder that `stdio` is undocumented with no support commitment.
- **The fixtures carry the owner's email and organization** in every `initialize` response. Unscrubbed.

## 10. Sources

All web pages fetched 2026-09-02, all under `https://code.claude.com/docs/en/`:
`permissions` (read-only command set, tiered table) · `permission-modes` (seven modes, auto-mode
classifier) · `cli-reference` (`--permission-mode` values and the `manual` alias,
`--permission-prompt-tool` MCP form, the two dangerous-skip flags) · `hooks` (`PreToolUse` decision
control, four decisions, precedence, deprecated `decision`/`reason`, `defer`) ·
`agent-sdk/permissions` (evaluation order, "auto-approved tools never reach `canUseTool`") ·
`agent-sdk/typescript` (`control_request`/`control_response`/`can_use_tool`, `PermissionResult`
casing, the no-timeout statement, `pending_permission_requests`) · `tools-reference` (per-tool
"permission required" column) · `env-vars`, `headless`.

Also: `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` (2.1.200–2.1.258);
`raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/src/claude_agent_sdk/types.py`
(`permission_prompt_tool_name="stdio"`); `github.com/anthropics/claude-code/issues/34046`.

Local: `claude --version` / `--help` / option-validation probes; `strings` over
`~/.local/share/claude/versions/2.1.258`; `crates/claude-spike/fixtures/s2,s3,s6`.

## 11. Not checked

- No live session was run: every wire claim comes from the 2026-09-01 fixtures (CLI 2.1.257) or from
  reading the 2.1.258 binary, never from 2.1.258 on the wire.
- Whether `permissionDecision: "ask"` from Rust actually produces a `can_use_tool` frame; whether an
  empty `hookSpecificOutput` falls through (implied, never stated).
- `interrupt: true`'s effect; a `Write` permission request; `updatedPermissions`;
  `decisionClassification`; `permission_suggestions` (absent on every frame captured);
  `--setting-sources=`.
- The reload path was read, not exercised.

---

## 12. Measured 2026-09-02 — the live run

One live session, three turns, CLI **2.1.258**, model **`claude-haiku-4-5`**, `--permission-mode
default`, cwd a throwaway git repo with three files. Driven through `Supervisor` by
`crates/supervisor/tests/live_approvals.rs` (`#[ignore]`):

```
CLAUDE_BIN=$(which claude) BRIGADIER_LIVE_CWD=<throwaway repo> \
  cargo test -p brigadier-supervisor --test live_approvals -- --ignored --nocapture
```

**One run, passed first time. `cost_usd_cumulative` = $0.045850** (usage: 981 in, 844 out,
148 725 cache read, 12 888 cache creation; `status=Exited`, `exit_code=Some(0)`), 15.2 s wall.
That is 92 % of the $0.05 cap the test asserts — three turns against a 200 k context window cost
six times the two-scenario spike estimate in §8, which was based on single-`echo` turns. **The
$0.05 assertion is nearly binding; treat §8's "near $0.02" as wrong.** [measured]

### The link §11 called unmeasured: `permissionDecision: "ask"` does produce `can_use_tool`

It fired, and the frame says so itself. From the live `Write` capture,
`crates/claude-spike/fixtures/s7-can-use-tool-write.ndjson`: [measured]

```json
{"type":"control_request","request_id":"57ad687f-b3c0-4399-a4fc-daa080f7c61c",
 "request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
   "input":{"file_path":"…/approvals-proj/hello.txt","content":"hi"},
   "description":"hello.txt",
   "decision_reason":"brigadier gates this tool",
   "decision_reason_type":"hook",
   "tool_use_id":"toolu_014D38JJRRdzWT5fwxvAJ8Pa"}}
```

`decision_reason_type: "hook"` and `decision_reason` echoing our own
`permissionDecisionReason` verbatim: **the hook is what asked, not an ask rule.** The fallback in
§7 gap 1 (`--settings '{"permissions":{"ask":[…]}}'`) was never needed and is not shipped — argv
still carries no `--settings` (`crates/core/src/claude/process.rs:101-123`).

Two corrections to §4's field list, which was built from the `s2` capture: `decision_reason` is
**present** here (it was absent in `s2`), and `decision_reason_type` takes the value `"hook"`
alongside the `"rule"` that `s2` recorded. `permission_suggestions`, `blocked_path`,
`matched_ask_rule`, `title`, `agent_id`, `classifier_approvable`,
`suppress_always_allow_rule`, `default_to_no` and `requires_user_interaction` were **still absent**
on a `Write` — `blocked_path` did not appear. [measured]

`ls -1` prompted, which is the whole point: it is on the documented read-only list (§1b) and would
never have prompted without the `ask`.

### Deny: what the model actually saw

Turn 1, `Bash` `{"command":"ls -1"}` denied with `"denied by brigadier test"`, `interrupt: false`:
[measured]

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result",
  "content":"denied by brigadier test","is_error":true,
  "tool_use_id":"toolu_01ShoUB4AY8B27VoT3uTwoz3"}]},
 "tool_use_result":"Error: denied by brigadier test",
 "tool_result_meta":[{"id":"toolu_01ShoUB4AY8B27VoT3uTwoz3","non_execution_kind":"permission-rule"}]}
```

Byte-identical in shape to the `s3` fixture, down to `non_execution_kind: "permission-rule"`. The
denial came from our `control_response` in both cases, so that label is unchanged whether the
prompt behind it was raised by an ask rule (`s3`) or by a hook `ask` (here). The command did not
run: no filename from the project tree appears anywhere in the turn. The turn
completed normally (`turn-completed(EndTurn)`). [measured]

### Allow: real stdout on the second turn

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Y4xPiPbxMrBUAMqhjGks6L",
  "type":"tool_result","content":"alpha.txt\nbeta.txt\ngamma.txt","is_error":false}]},
 "tool_use_result":{"stdout":"alpha.txt\nbeta.txt\ngamma.txt","stderr":"","interrupted":false,
   "isImage":false,"noOutputExpected":false}}
```

Same session, same prompt, one turn later. [measured]

### Signal sequence, in order

```
turn-started, session-started,
request-opened(tool-permission:Bash), request-resolved(Deny{…}), turn-completed(EndTurn),
turn-started, request-opened(tool-permission:Bash), request-resolved(Allow{…}), turn-completed(EndTurn),
turn-started, request-opened(tool-permission:Write), request-resolved(Deny{…}), turn-completed(EndTurn),
session-exited(Graceful, Some(0))
```

Three prompts for three turns, no spurious fourth: §8's prompt wording held — the model narrated
the refusal rather than retrying with a variant, on both denies. `turn-started` arrives **before**
`session-started`, which the UI must not assume otherwise. A denied `Write` created no file.
[measured]

### What changed in the code

- `crates/core/src/claude/hook.rs` — `AskGatedTools` answers
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":…}}`
  for `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `{}` for everything else. It is the
  **default** policy of every `ClaudeDriver` (`claude/driver.rs:104`, `:120`), so
  `src-tauri/src/state.rs` needed no change. `AllowAll` is kept, renamed in its docs to what it
  actually is — "no opinion" — and is still what replay and the adapter fixtures use.
- `crates/core/src/driver.rs` — all seven modes modelled (gap 2): `Manual`, `Auto`, `DontAsk` added.
  Wire spelling stays kebab-case (`"dont-ask"`), CLI spelling camelCase (`"dontAsk"`).
- `process.rs`, `hook.rs`, `claude/mod.rs` — the "classifier" misnomer corrected to the built-in
  read-only Bash command set (gap 3), and the `--setting-sources` decision recorded in place
  (gap 4): not added, user settings still loaded, a user `Bash` allow rule would shadow the gate.

### Not checked, still

- `interrupt: true` — every deny in this run sent `interrupt: false`.
- `updatedPermissions`, `decisionClassification`, `permission_suggestions` — all still absent.
- The reload half (`pending_approvals` across a webview reload) was not exercised; this test never
  reloads anything.
- Only **one** live run was made, so nothing here is a repeated measurement.
- A `Bash` `can_use_tool` frame from 2.1.258 was not kept as a fixture — its `decision_reason_type`
  was not read; only the `Write` frame was captured.
- `--setting-sources=` was not exercised, and no user allow rule was planted to prove the shadow.
