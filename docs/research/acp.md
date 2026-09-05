# ACP: should brigadier speak it instead of driving `claude` directly?

Date: 2026-09-05. Status: **package source read on disk, one live handshake measured, no prompt turn
run** (a turn costs money and the gate did not need one). Every claim is tagged **[measured]** (run
here, command shown), **[source]** (read in code, `file:line`), **[documented]** (vendor docs, URL,
fetched 2026-09-05) or **[asserted]** (reasoning).

This re-opens a decision `CLAUDE.md` §2 records as settled. It was asked genuinely, on new evidence,
and the answer below is not "the decision stands because it is the decision".

## Bottom line

**Do not adopt ACP as brigadier's transport. Adopt one idea from it.**

**Question 1 fails, and it fails twice over.** ACP the protocol has **no rate-limit, quota, usage-
window or subscription-utilization concept anywhere in its schema** — the words do not appear
**[source]** — and the one adapter that could carry it, `@agentclientprotocol/claude-agent-acp`,
**drops the `rate_limit_event` frame on the floor in exactly the case brigadier depends on**
**[source + measured ordering]**. `docs/vision.md` §6 is built on a reading taken *once per session,
at 804–984 ms, before that session's own spend*; the adapter's handler is guarded by
`lastAssistantTotalUsage !== null`, which is `null` until the first `assistant` frame — and the
`rate_limit_event` arrives **before** the first `assistant` frame in **26 of the 28** events recorded
across this repo's 27 transcripts, and in **every one of the 26 session-start events**. The two
exceptions both arrive at the end of a turn, immediately before `result` — after the spend they would
have gated. The gauge the reserve is built on would read empty. (Corrected 2026-09-05 from a
"15 of 15" that was overstated; see "The adapter drops the frame brigadier reads" below.)

**Question 2 passes.** `session/request_permission` is a real blocking request/response gate carrying
the programmatic tool name and the complete unredacted tool input, and the client's answer is
confirmable because it is a JSON-RPC response the agent awaits **[source]**. It is *narrower* than
what brigadier has — the client picks from an adapter-authored option list, cannot supply its own
deny reason, and cannot interrupt the turn — but it is not disqualifying.

**Question 3 fails and is the quiet one.** There is no ACP equivalent of a `PreToolUse` hook with
`matcher: ""`. Over a subprocess ACP connection there is **no way to register a hook at all**
**[source]**, and `session/request_permission` inherits `can_use_tool`'s two shadows verbatim
(`claude-direct-spike.md` §"The two shadows"). brigadier's wall needs a pre-effect seam that fires on
*every* tool call; ACP does not have one.

There is an escape hatch, and it deserves stating before the verdict:
`_meta.claudeCode.emitRawSDKMessages` tunnels the raw Claude Code stream through an ACP
`_claude/sdkMessage` ext notification **[source]**. That genuinely rescues Q1 — `unifiedWindows`
would survive as an untyped passthrough. **It does not rescue Q3**, because raw frames are read-only
visibility arriving after the fact, not a gate that can hold a tool call. And it is the argument's
own undoing: **if you must turn on raw passthrough to get your economics back, you are paying a Node
process and a second 199 MB `claude` binary to receive the bytes you already receive.**

**And the durability argument, which was the real one, inverts under measurement.** Over the same
eleven months and 289 SDK releases, the Claude control envelope and base argv are **byte-identical**
and exactly one subtype was ever removed (**[measured]** by a subagent over eight downloaded
tarballs; I reproduced only the 0.3.257 endpoint — see "Not checked"); ACP shipped a semver-major Rust break 29
days after 1.0.0 and is mid-migration to a v2 that deletes `session/load`, `session/set_mode`, all
`terminal/*` and all `fs/*` **[documented]**. The undocumented interface moved less than the
documented one. ACP keeps one genuine win — **argv insulation**, against the only change that has
actually bitten — and that is cheaper to buy with a CI diff than with a migration.

**Adopt one idea, not the protocol:** ACP's `PermissionOption` model — the agent offers a small
closed set of typed choices (`allow_once` / `allow_always` / `reject_once` / `reject_always`) instead
of a free-form allow/deny — is better than what brigadier has and costs nothing to copy.

## What ACP is

- **Agent Client Protocol.** JSON-RPC 2.0 over stdio, newline-delimited. Standardizes communication
  "between *code editors* … and *coding agents*". **[documented]** https://agentclientprotocol.com
- **Jointly governed by Zed and JetBrains**, two lead maintainers with veto (Ben Brandt, Zed; Sergey
  Ignatov, JetBrains), explicitly "an **interim** governance model" working toward an independent
  foundation that does not exist yet. **[documented]** https://agentclientprotocol.com/community/governance
- **Apache-2.0** throughout — spec, Rust SDK, TypeScript SDK, and `claude-agent-acp`. No CLA.
  **[documented]** Note the ACP registry entry for `claude-acp` says `"license": "proprietary"`; the
  repo's `LICENSE` and npm both say Apache-2.0. The registry metadata is wrong.
- **Negotiated `protocolVersion` is `1`.** `ProtocolVersion` is documented as "only bumped for
  breaking changes. Non-breaking changes should be introduced via capabilities." **[source]**
  `schema/schema.json` `$defs.ProtocolVersion`
- **It is designed for editors, and it shows.** Of 265 schema definitions, a large block is
  `Nes*` (next-edit-suggestion / inline completion), `Terminal*`, `TextDocument*`, `Did{Open,Close,
  Change,Save,Focus}Document`, `Position`/`Range`/`PositionEncodingKind`. **[source]** None of that
  is a supervisor's vocabulary.

### Versions, as shipped on this machine

| | |
|---|---|
| `@agentclientprotocol/claude-agent-acp` | **0.75.0** (published 2026-09-05) **[measured]** |
| `@agentclientprotocol/sdk` | **1.4.0** |
| bundled `@anthropic-ai/claude-agent-sdk` | **0.3.257** (exact pin) |
| ACP `protocolVersion` the adapter speaks | **1**, hardcoded, no v2 support **[source]** `dist/acp-agent.js:898` |
| author / maintainers | **Zed Industries** — `benbrandt`, `aguzubiaga`, `cirwin`. **Not Anthropic.** |
| the owner's `claude` | `2.1.261` **[measured]** `claude --version` |

`npm view` and `crates.io` reads by a subagent; the package versions above were read from the npx
cache on this machine.

## What was read, and where

The package was already on disk from the owner's Tuppi session — that is a primary source and it
beats the docs:

```
/Users/stephen/.npm/_npx/fa723bcb10ae372a/node_modules/@agentclientprotocol/
  claude-agent-acp/  0.75.0   (dist/acp-agent.js is 8,409 lines)
  sdk/               1.4.0    (schema/schema.json, 370,113 bytes, 265 $defs)
/Users/stephen/.npm/_npx/fa723bcb10ae372a/node_modules/@anthropic-ai/
  claude-agent-sdk/            sdk.d.ts, 422,172 bytes
  claude-agent-sdk-darwin-arm64/claude   199,011,264 bytes
```

Seven copies of the `@agentclientprotocol` scope are in `~/.npm/_npx/` (three of
`claude-agent-acp` at 0.70.0/0.74.0/0.75.0, three of `codex-acp`). **[measured]** `find ~/.npm/_npx`

### One live handshake, measured, zero cost

```
node dist/index.js  <<  {"jsonrpc":"2.0","id":1,"method":"initialize",
                         "params":{"protocolVersion":1,"clientCapabilities":{...}}}
```

**[measured]** (script at `scratchpad/acp-probe.mjs`, not in the repo):

- `initialize` response at **+149 ms**
- unsolicited `_auth/status_update` notification at **+520 ms**, carrying the owner's plan, email and
  organization — the adapter probes identity by running `claude auth status --json` in the
  background from `initialize` **[source]** `dist/acp-agent.js:1155-1159`. Free, no API call.
- clean exit code 0 on SIGTERM; `pgrep -f bin/claude` **1 before, 1 after** — no orphan
- `agentCapabilities` returned: `promptCapabilities{image,embeddedContext}`,
  `mcpCapabilities{http,sse}`, `auth{logout}`, `providers`, `loadSession`,
  `sessionCapabilities{additionalDirectories,close,delete,fork,list,resume,subagents}`.
  **There is no usage, rate-limit, or hook capability in that set.**
- `_meta` advertised `jetbrains.air.capabilities` and a `_session/goal` control method — vendor
  extensions, not spec.

**No `session/new` and no `session/prompt` were sent.** Those spawn a model turn and cost money;
nothing in the gate required one.

## Q1 — usage windows. **Disqualifying.**

### The protocol has no concept of it

Grepping all 265 definitions of the shipped v1 schema for `rate`, `limit`, `quota`, `usage`,
`window`, `token`, `cost`, `budget` returns **fourteen** field names, and every one of them is
context-window or dollar accounting **[source]** `sdk/schema/schema.json`:

```
UsageUpdate { used: uint64          // "Tokens currently in context."
              size: uint64          // "Total context window size in tokens."
              cost?: Cost }
Cost        { amount: double, currency: string }   // ISO 4217
Usage       { totalTokens, inputTokens, outputTokens, thoughtTokens?,
              cachedReadTokens?, cachedWriteTokens? }   // marked **UNSTABLE**
```

`usage_update` is one of the **11 stable** `session/update` variants **[source]**. `Usage` is
`$ref`'d from exactly one place — `PromptResponse.usage` — and is marked **UNSTABLE**: "not part of
the spec yet, and may be removed or changed at any point." **[source]**

The spec's own RFD says so out loud, under the heading *"What about rate limits and quotas?"*:

> "This RFD focuses on context window utilization and cumulative cost. **Rate limits and quotas are
> separate concerns that could be addressed in a future RFD.**"

**[documented]** https://agentclientprotocol.com/rfds/session-usage. No such RFD exists; all 37 in
`docs/rfds/` were enumerated.

So the only account-level number ACP defines is **`Cost.amount` in USD** — the exact figure
`docs/vision.md` §6 rejects as "a lie in the user's favour, which is still a lie."

### The adapter drops the frame brigadier reads

This is the finding that decides it. `claude-agent-acp` does handle `rate_limit_event`, and forwards
`rate_limit_info` verbatim under a vendor `_meta` key **[source]** `dist/acp-agent.js:4264-4275`:

```js
case "rate_limit_event": {
    if (lastAssistantTotalUsage !== null) {
        await sendUpdate({ sessionId: message.session_id,
            update: { sessionUpdate: "usage_update",
                      used: lastAssistantTotalUsage, size: session.contextWindowSize,
                      _meta: { "_claude/rateLimit": message.rate_limit_info } } });
    }
    break;
}
```

`lastAssistantTotalUsage` is initialised `null` at `dist/acp-agent.js:1819`, reset to `null` on every
turn activation (`resetTurnScratch`, `:1974`), and assigned in exactly **three** places — all three
requiring an `assistant` frame, a `stream_event` `message_delta`, or a `compact_boundary`
**[source]** `:2740`, `:3865`, `:4014`. **Nothing sets it before the first assistant frame.**

And the session-start `rate_limit_event` arrives before the first assistant frame in every recorded
session. **[measured]** — frame census re-run here 2026-09-05, over this repo's own fixtures:

```
$ python3 - <<'PY'
import json, glob
files = sorted(f for f in glob.glob('crates/claude-spike/fixtures/**/*.ndjson', recursive=True)
               if not f.endswith('.sent.ndjson') and not f.endswith('.hooks.ndjson'))
tot = before = after = 0
for f in files:
    rl, asst = [], None
    for i, l in enumerate(open(f).read().splitlines(), 1):
        if not l.strip(): continue
        o = json.loads(l)
        if o.get('type') == 'rate_limit_event': rl.append(i)
        if asst is None and o.get('type') == 'assistant': asst = i
    tot += len(rl)
    for pos in rl:
        if asst is None or pos < asst: before += 1
        else: after += 1
print(len(files), tot, before, after)      # -> 28 28 26 2
PY
```

| fact | value |
|---|---|
| `.ndjson` transcripts under `crates/claude-spike/fixtures/**`, excluding `.sent.` and `.hooks.` | **28** |
| of those, carrying at least one `rate_limit_event` | **27** — the 28th, `s7-can-use-tool-write.ndjson`, is a single captured `control_request` line, not a session |
| `rate_limit_event` frames across those 27 transcripts | **28** |
| frames arriving **before** the first `assistant` frame | **26**, at positions **2–5** |
| frames arriving **after** it | **2** — `s5-resume.ndjson` frame 8 of 9 and `spawn-split/off-4.ndjson` frame 8 of 9, each immediately before `result` |
| transcripts carrying a session-start event, where that event precedes the first `assistant` | **26 of 26** |
| `rate_limit_event` frames per transcript | **exactly 1 in 26 of the 27**; `spawn-split/off-4.ndjson` carries **two**, at frames 3 and 8 |
| transcript with no session-start event at all | `s5-resume.ndjson` — a `--resume`, whose only event is the late one |
| its position in `s1-handshake-and-turn.ndjson` | frame **2** of 9 — before `system/init` |
| its position in `s2`, `f-warm` | frame **3** — after `system/init`, before any `assistant` |
| first `assistant` frame in those files | frame **7**–**8** |

**Correction, 2026-09-05.** This table previously read "recorded sessions carrying a
`rate_limit_event` — **15 of 15**" and "`rate_limit_event` frames per session — **exactly 1**, in all
15". Both were overstated, and both are replaced above. Two mistakes produced them: the original
command globbed `crates/claude-spike/fixtures/*.ndjson`, which misses the **12** transcripts under
`fixtures/spawn-split/` and the **13** events in them; and it counted files *containing* the frame
with `grep -c` without comparing each frame's position to the first `assistant`. Re-running the count
with a recursive glob and a per-frame position check found the two counter-examples:
`s5-resume.ndjson` has its only event at frame 8 with the first `assistant` at frame 6, and
`spawn-split/off-4.ndjson` carries two events, at frames 3 and 8. Raised by a recount from another
agent and re-derived independently here before being written down; the numbers above are this file's
own count, and they agreed with that recount exactly.

**The conclusion does not change, and the severity is stated exactly.** The guard drops **26 of the
28** recorded events — not all 28 — but it drops **every recorded session-start event**, and the
session-start reading is the only one `docs/vision.md` §6 can use. Both surviving frames arrive
immediately before `result`, i.e. after the turn's spend has already happened; a reserve fed from
them would be reading a gauge too late to refuse the dispatch it exists to refuse.

`docs/research/fanout-vs-children.md` measured the same thing independently: "**Exactly one
`rate_limit_event` fired per session, at 804–984 ms** — near the *start* of the turn, before that
session's own spend." That "exactly one" holds for the five `f-*` fanout transcripts it measured
**[measured]**, but not across all 27 — see `spawn-split/off-4.ndjson` above; the *timing* claim it
makes is what matters here and is unaffected. `docs/vision.md` §6 then builds the reserve on
precisely that property: "brigadier spawns a fresh child per work order, so every dispatch yields a
fresh reading. The reserve is therefore a **per-dispatch gate**."

**So the one frame brigadier's economics reads is the one frame the adapter's guard rejects.**
**[asserted, from source + measured ordering]** — I did not run a prompt turn through the adapter to
watch it happen, because that costs money. The inference rests on three checked facts: the guard, the
three assignment sites, and the measured frame ordering. It is strong but it is not an end-to-end
observation, and it is the single claim in this document most worth confirming before acting on it.

### The one place the windows do escape, and what shape they are in

`dist/usage-markdown.js` **does** hold the full subscription picture — `five_hour`, `seven_day`,
`seven_day_opus`, `seven_day_sonnet`, `model_scoped[]`, `extra_usage`, each with
`utilization: 0-100 | null` and `resets_at` **[source]**. It comes from
`query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` **[source]**
`dist/acp-agent.js:85`.

Its only consumer is `formatUsageResponse()`, which renders **Markdown with Unicode bar charts**:

```js
lines.push(`**${label}** — **${window.utilization}%**${formatReset(window.resets_at)}`,
           "", `\`${usageBar(window.utilization)}\``, "");
```

triggered by `isUsageCommandText(text)` — the user typing the literal string `/usage`
**[source]** `dist/acp-agent.js:1413`. It is delivered as an `agent_message_chunk`. A supervisor
would have to type a slash command and regex `█░` bars out of prose to read its own gauge.

**Verdict on Q1: ACP cannot carry it, and the adapter actively loses it.**

## Q2 — tool permissions. **Passes, with three real narrowings.**

`session/request_permission` is agent→client, a **request** (not a notification), so the answer is
confirmable by construction — the agent awaits the JSON-RPC response **[source]**
`schema.json` `$defs.RequestPermissionRequest`, `"x-side": "client"`.

Fidelity is good. `dist/permissions/presentation.js` builds the `toolCall` as:

```js
toolCall: { toolCallId: value.toolUseID,
            name: value.toolName,        // programmatic name
            status: "pending",
            rawInput: value.input,       // complete, unredacted
            ...info, title, content, locations }
```

`info` comes from `toolInfoFromToolUse()`, which returns only `{title, kind, content, locations}`
**[source]** `dist/tools.js:16` — so the spread does **not** clobber `name` or `rawInput`. A gate sees
the real tool name and the whole input. That is what brigadier needs.

Three narrowings, all real:

1. **`ToolCall.name` is marked UNSTABLE in the schema** — "not part of the spec yet, and may be
   removed or changed at any point" **[source]**. The only stable identifier is `title`, a
   human-readable string. Gating on tool name means gating on an unstable field. (The Rust crate
   gates it behind feature `unstable_tool_call_name`. **[documented]**)
2. **The client cannot author a deny.** It answers with an `optionId` chosen from an
   adapter-authored list, and `decodeClaudePermissionResponse` **throws** if the id was not offered
   **[source]** `dist/permissions/response.js`. The deny message is hardcoded: `deny(context,
   message = "User refused permission to run tool")` **[source]** `dist/permissions/effects.js:19`.
   brigadier's spike sent `{"behavior":"deny","message":"denied by spike"}`; over ACP it cannot.
   (Mitigated: `claude-direct-spike.md` §3 already found the CLI does not echo the deny message into
   `permission_denials` anyway, so brigadier must keep its own record keyed by `tool_use_id`
   regardless.)
3. **A deny cannot stop the turn.** `interrupt: true` is emitted only for two hardcoded
   `ExitPlanMode` paths **[source]** `dist/permissions/effects.js`; a general deny is
   `deny(context)` with `interrupt` unset. brigadier's wall cannot escalate "no" to "stop".

**The idea worth stealing.** `PermissionOptionKind` is a closed set —
`allow_once | allow_always | reject_once | reject_always` **[source]** — and the adapter builds
tool-specific option lists (`buildBashPermissionOptions`, `buildWritePermissionOptions`, …) that
carry the *durable rule* an "always" would install. That is a better-shaped approval than a bare
allow/deny bool, and copying it into brigadier's own approval UI costs one enum and no dependency.

## Q3 — a pre-effect seam for every tool call. **Fails.**

`session/request_permission` is driven by `canUseTool` **[source]** `dist/acp-agent.js:5953,5196`,
so it inherits both shadows measured in `claude-direct-spike.md`: the user's
`"defaultMode": "bypassPermissions"`, and the CLI's own safe-command classifier, which auto-approved
a bare `echo` without ever putting a frame on the wire. The spike's conclusion was explicit — to see
*every* tool call you need a `PreToolUse` hook, which fired where `can_use_tool` did not.

**Over ACP a client cannot register one.** The adapter's hook block is assembled from its own
callbacks plus `userProvidedOptions?.hooks` **[source]** `dist/acp-agent.js:5979-5989`, and
`userProvidedOptions` is `sessionMeta?.claudeCode?.options` — the `_meta` of `session/new`
**[source]** `:5831`. That is JSON on the wire. An SDK `HookCallback` is a **function**
(`agent-sdk.md` §4), so it cannot survive JSON-RPC. The type comment even advertises "hooks (merged
with ACP's hooks)" **[source]** `dist/acp-agent.d.ts:619`, but that path is only reachable when you
`import { ClaudeAcpAgent }` into your own Node process — which is the sidecar this project deleted.
**[asserted, from the two source facts]** — I did not attempt to send a JSON hook through `_meta` to
watch it fail.

`session/update` with `sessionUpdate: "tool_call"` does fire for every tool call, but it is a
**notification**: there is no response, so the agent never waits. It is a mirror, not a gate.

## Q4 — raw provider frames. **Available, via a vendor escape hatch.**

```js
if (session.emitRawSDKMessages && shouldEmitRawMessage(session.emitRawSDKMessages, message)) {
    await this.client.extNotification("_claude/sdkMessage",
                                      { sessionId: params.sessionId, message });
}
```

**[source]** `dist/acp-agent.js:2563-2568`, enabled by `_meta.claudeCode.emitRawSDKMessages` on
`session/new` — `true` for everything, or an array of `{type, subtype, origin}` filters
**[source]** `dist/acp-agent.d.ts`. It sits **before** the message switch, so every frame passes
through it, `rate_limit_event` included, and `unifiedWindows` would survive as an untyped
passthrough.

Four `_claude/*` vendor keys exist in total: `sdkMessage`, `rateLimit`, `origin`,
`askUserQuestionOption` **[source]**. None is in the ACP schema; none is documented in the npm
tarball (the README links `docs/*.md` that `package.json` `files` does not ship).

Without the hatch, a turn's final assistant text must be reassembled from streamed
`agent_message_chunk` notifications — workable, but a normalised view.

## Q5 — per-session control. **Mostly passes.**

| control | over ACP | evidence |
|---|---|---|
| model | **yes** — `session/set_config_option` `configId: "model"` → `query.setModel()` | **[source]** `:4814`, `:6741` |
| permission mode | **yes** — `session/set_mode`, and `configId: "mode"` | **[source]** `dist/session-mode.js:3` |
| effort | **yes** — `configId: "effort"` | **[source]** `dist/session-config-ids.js` |
| **thinking budget** | **no, not per session** — `resolveThinkingConfig(process.env.MAX_THINKING_TOKENS)` | **[source]** `:5836` |
| interrupt a turn | **yes** — `session/cancel` notification; agent MUST answer the prompt with `stopReason: "cancelled"` | **[documented]** |
| kill | process-level, same as today | — |

`session/set_mode` and the whole `modes` API are **documented as slated for removal**: "Dedicated
session mode methods will be removed in a future version of the protocol." **[documented]**
https://agentclientprotocol.com/protocol/v1/session-modes

Thinking budget being a **process-wide environment variable** is workable only because brigadier
would spawn one adapter per session — which is also the thing that makes the process cost real.

## Q6 — session continuation. **Passes cleanly. ACP's best answer.**

The ACP `sessionId` **is** the Claude session id. On resume, `sessionId = creationOpts.resume`, and
otherwise the minted UUID is handed straight to the SDK as `options.sessionId`
**[source]** `dist/acp-agent.js:5759-5776`, `:6080-6083`. `session/load`, `session/resume` and
`session/fork` all route to `getOrCreateSession`, and `session/list` reads the Claude transcript
store via the SDK's `listSessions` **[source]** `:967-1010`. Provider-side identity is preserved 1:1
— no shadow id, no mapping table.

## Q7 — per-turn cost and usage. **Partial.**

`usage_update` on the `result` frame carries the dollar figure **[source]** `:3466-3474`:

```js
update: { sessionUpdate: "usage_update", used: lastAssistantTotalUsage,
          size: session.contextWindowSize,
          cost: { amount: message.total_cost_usd, currency: "USD" } }
```

So `total_cost_usd` survives, and it is as cumulative as the CLI's is — `docs/STATUS.md` §6 warns
that summing `result` frames double-counts, and that hazard passes through unchanged.

**`modelUsage` does not survive.** `agent-sdk.md` §6 records `modelUsage` as "the correct field for
accounting (includes subagents, sidechains, compaction)"; ACP's `usage_update` carries only `used`
and `size`, and the richer `Usage` (input/output/thought/cache tokens) is UNSTABLE and lives only on
`PromptResponse` — whose own RFD says "**This shape is not ready for Preview.**" **[documented]**
https://agentclientprotocol.com/rfds/end-turn-token-usage

## The strongest argument for adoption, at full strength

The lead's hypothesis was **durability**: ACP is a documented, versioned contract; the CLI control
protocol is undocumented and Anthropic can change it without notice. That argument deserves its
weight, and part of it is simply correct.

**What is genuinely true, and in ACP's favour:**

1. **There is a real, first-class Rust client.** `agent-client-protocol` **2.1.0**, published
   2026-09-04, **4,174,917 total downloads / 1,849,652 in 90 days**, Apache-2.0, repo
   `agentclientprotocol/rust-sdk`. **[measured]** `curl https://crates.io/api/v1/crates/agent-client-protocol`.
   Its own docs name the use case: "**Clients** that talk to ACP agents (**like building your own
   Claude Code interface**)". **[documented]** This kills the naive objection "ACP means Node".
   The *client* side would be Rust.
2. **The wire version has held.** `protocolVersion: 1` has not been broken since it shipped, the
   bump-only-for-breaking rule is written into the schema, negotiation is properly specified, and
   new features arrive as capabilities. **[documented]**
3. **`_meta` is a specified escape hatch**, not a hack — every type carries it, extension methods
   prefixed `_` are reserved, and custom capabilities can be negotiated at `initialize`.
   **[documented]** https://agentclientprotocol.com/protocol/v1/extensibility
4. **The ecosystem is not a toy.** Governance is Zed + JetBrains; the agent registry carries ~40
   vetted entries (amp, cline, codex-acp, cursor, devin, gemini, goose, junie, opencode, …). If
   brigadier ever wants a second provider, ACP is a real answer to that question — and a better one
   than writing a fourth bespoke adapter.

**What the evidence does to it — part 1: the CLI protocol turns out to be remarkably stable.**

The hypothesis's premise is that the undocumented side churns. It was tested by extracting **eight
SDK tarballs spanning the package's whole published life** (0.1.0, 2025-09-29 → 0.3.261, 2026-09-04)
and diffing the wire literals in `sdk.mjs` rather than trusting the changelog's account of itself.
**[measured]**

| over 289 releases and 342 days | result |
|---|---|
| base argv `--output-format stream-json --verbose --input-format stream-json` | **byte-identical, 0.1.0 → 0.3.261** |
| `control_request` / `control_response` / `control_cancel_request` envelope | unchanged; only an added docstring |
| `can_use_tool`, `hook_callback`, `initialize`, `interrupt` | present in every version |
| `--permission-prompt-tool stdio` sentinel | present in every version |
| SDK→CLI subtypes | **21 → 42, monotonically additive; exactly one removal ever** (`set_proactive`, inside 0.2.x, never a primitive) |
| inbound subtypes a driver must answer | **3 → 8, zero removals** — ~one new one every two months |
| `can_use_tool` request fields | 19 → 20 (`+default_to_no`); **none lost** |
| changelog entries renaming or removing a control subtype | **zero, in the entire history** |

I re-ran the three load-bearing greps against the copy on this machine: the base-argv literal is
present verbatim in `sdk.mjs` at 0.3.257, `Unsupported control request subtype` appears once, and the
argv form is `` `--resume=${v}` ``. **[measured]**

Two more things fall out of that work, both of which cut *against* ACP:

- **The reference client itself error-responds to unknown subtypes rather than crashing** —
  `throw Error("Unsupported control request subtype: " + subtype)`, wrapped into a
  `{subtype:"error"}` response, in **every** sampled version. **[measured]** The CLI must already
  tolerate that reply, so a Rust driver that lags a new inbound subtype degrades exactly the way the
  official SDK does. That is a real, if accidental, compatibility guarantee.
- **`capabilities` is documented in prose, not just types** — "Check it to feature-detect instead of
  comparing version strings, and ignore values you don't recognize." **[documented]**
  https://code.claude.com/docs/en/headless. Narrow (interrupt and queued-notification semantics
  only, not the envelope or the permission plane), but real.

And **Anthropic does not declare direct CLI driving unsupported.** No page checked calls it
internal, unsupported or discouraged; `code.claude.com/docs/en/headless` is a whole page documenting
`--output-format stream-json --verbose` with field-level event schemas, and the SDK overview says:
"**To drive the same agent loop from another language, run the CLI as a subprocess.**"
**[documented]** The endorsed recipe is `-p` with `--output-format json`, so brigadier's control
channel still sits in an unaddressed gap — but "unaddressed" is not "forbidden", and that is a
weaker hazard than the durability argument assumed.

**The one place the argument lands, and it should be conceded plainly.** The single measured
breakage in eleven months was **not** in the wire. It was argv: `--resume <id>`, `--session-id <id>`
and `--resume-session-at <v>` all flipped from space-separated to `=`-joined between **0.3.159 and
0.3.221**, with **no changelog entry in either project**. **[measured]** `claude --help` today
declares `-r, --resume [value]` — an *optional*-value option — so a following bare token is not
consumed as the flag's value and the old form would degrade into a positional prompt rather than an
error. **[asserted; the failure mode is inferred from the `[value]` arity, not executed.]**
`claude-direct-spike.md` already guessed the `=` form correctly and passed, so brigadier is on the
right side of this one — but it is exactly the class of change ACP would insulate against, because an
ACP client never constructs argv at all. **That is the strongest concrete point in ACP's favour in
this document, and it is a real one.**

Also worth recording, because a hand-rolled driver walks paths the SDK never does: the CLI would
**hang permanently** on a `control_request` carrying a non-string `set_model` payload until CC
**2.1.208**, and mishandled duplicate `control_response` frames until **2.1.51**. **[documented]**
CC changelog.

Anthropic's own compatibility signal is not usable as an early warning: `manifest.json.sdkCompat`
has `harnessSchema: 1`, which has never incremented, and `testedWrapperVersions` on CLI 2.1.257
lists only `0.3.216`–`0.3.227` — **it does not list `0.3.257`, the wrapper it ships with.**
**[measured]** — read from `manifest.json` on this machine.

**What the evidence does to it — part 2: the ACP side moves faster than the thing it would replace.**

- **A breaking protocol version is being built right now.** ACP v2 is in draft, and it is not a
  tidy-up: `session/prompt` no longer ends the turn (completion moves to a `state_update`
  notification); `session/load`, `session/set_mode`, all five `terminal/*` and both `fs/*` are
  **removed**; `initialize` is restructured with `info` becoming required; the `tool_call`,
  `current_mode_update` and `plan` update variants are **removed**. The maintainers' own guidance is
  "support both versions side by side… v1 peers will remain in the wild well after v2 stabilizes."
  **[documented]** https://agentclientprotocol.com/protocol/v2/migration. The v2 schema is shipped
  on disk *alongside* v1 in the same npm package (`schema/v2/schema.unstable.json`), and diffing them
  is the plainest statement of the cost: **190 of the 223 shared definitions differ, 42 are gone, 42
  are new. [measured]**
- **v1 is not forward-compatible; v2 is being built to be.** v2's headline is "Everything is
  extensible now. Enums and tagged unions accept unknown values" — which is a v2 property, and an
  admission about v1.
- **`claude-agent-acp` is not the stable thing in this picture.** 69 versions since 2026-03-26 on
  the new scope, 142 counting the renamed `@zed-industries/claude-code-acp`; **2–4 releases per
  week**; and its own `docs/RELEASES.md` says "**Breaking changes bump the minor rather than the
  major**" because it is pre-1.0. **[documented]** A `0.x` minor bump can break you.
- **The Rust crate is not the stable thing either.** 78 versions; `1.0.0` on 2026-06-24 and
  `2.0.0` on **2026-07-23 — a semver-major break 29 days later.** **[measured]**
  `curl https://crates.io/api/v1/crates/agent-client-protocol/versions`. Zed itself pins
  `agent-client-protocol = { version = "=2.0.0", features = ["unstable"] }` — an **exact** pin,
  with `unstable` on, while 2.1.0 has been out since 2026-09-04. **[documented]** zed `Cargo.toml:519`
- **There is no deprecation policy.** No policy document exists anywhere in the spec repo or site;
  deprecations are ad-hoc prose notes with no dates — and features named for removal
  (`session/set_mode`, `modes`, `current_mode_update`) are shipping in v1 today. Governance is
  self-described as **interim**.
- **Adopting ACP would not remove a dependency on the CLI's undocumented protocol. It would add a
  second party who depends on it.** `claude-agent-acp` wraps `@anthropic-ai/claude-agent-sdk`
  **0.3.257**, which speaks the same undocumented stdio control protocol brigadier speaks. Every
  churn risk brigadier carries today, it would still carry — one process further away, with the
  adapter's own release cadence stacked on top. The adapter's source says so itself, at
  `dist/acp-agent.js:5247`: *"The attribution rests on an **undocumented SDK invariant** … Should an
  SDK bump break it …"*

**Honest summary of the durability argument.** It was the right question and it deserved the test.
The test says: over the same eleven months, **the undocumented interface changed less than the
documented one.** The Claude control envelope and base argv did not move at all across 289 releases;
ACP shipped a semver-major Rust break 29 days after 1.0.0 and is mid-migration to a v2 that deletes
`session/load`, `session/set_mode`, all of `terminal/*` and `fs/*`, and redefines what
`session/prompt` returns. Adopting ACP would not *replace* an undocumented dependency — the SDK
still speaks it underneath — it would **add a second contract on top of the first**, plus a pre-1.0
wrapper that ships breaking changes as minor bumps twice a week.

The argument keeps one genuine win: **argv insulation**, against the one class of change that has
actually bitten. That is worth answering, and it is answerable for far less than a protocol
migration — a CI job that re-packs the SDK on every CLI bump and diffs both the control types **and
the argv construction**. The argv half is the part the existing brief does not cover and the part
where the measured breakage occurred.

## What adoption would actually cost, measured

| | |
|---|---|
| Node runtime, reintroduced | `engines: {"node": ">=22"}`; measured on `v24.18.0` |
| adapter process RSS, idle, no session open | **114,192 KB ≈ 111 MB** **[measured]** `ps -o rss= -p <pid>` |
| a **second** `claude` binary | **199,011,264 bytes**, pinned at CLI **2.1.257** **[measured]** |
| total npx tree | **243 MB** **[measured]** `du -sh` |
| the owner's own `claude` | **190 MB**, version **2.1.261** **[measured]** |
| processes per session | **3** (brigadier → node → claude) vs **2** today **[source]** |

The second binary is not incidental. `claudeCliPath()` resolves
`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` through a require bound to the SDK, and only
falls back to something else if `CLAUDE_CODE_EXECUTABLE` is set **[source]**
`dist/acp-agent.js` (`export async function claudeCliPath`). **`CLAUDE.md` §2 records as settled:
"The `claude` binary is never bundled. The harness depends on the user's own install."** Adopting the
default path violates that directly; the `CLAUDE_CODE_EXECUTABLE` override rescues it, at the cost of
running the user's 2.1.261 against an SDK pinned to 2.1.257 — the exact drift `agent-sdk.md` §"Implications"
warns shows up as "silently missing fields".

## Who actually uses it — two corrections to the owner

**The framing has a category error in it, and it matters.** `claude-agent-acp` is an ACP **agent**
(the server side). **No IDE takes a dependency on it.** A client *spawns* it as a subprocess. So "IDE
X uses claude-agent-acp" can only ever mean "IDE X can launch it as an installable external agent".

- **t3code — DOES NOT USE IT. The owner's belief is wrong.** `apps/server/package.json` on `main`
  depends on `@anthropic-ai/claude-agent-sdk@^0.3.260` and drives Claude through it — matching
  `docs/research/t3code.md`. A GitHub code search over `repo:pingdotgg/t3code` for
  `claude-agent-acp` returns **0 hits**. t3code has its own homegrown ACP implementation
  (`packages/effect-acp`, code-generated from the schema, no `@agentclientprotocol/*` dependency),
  and uses it only for **Cursor, Grok and Antigravity** — there is no Claude-over-ACP file in
  `apps/server/src/provider/acp/`. **t3code made the same call brigadier did: SDK/CLI direct for
  Claude, ACP for the vendors that only speak ACP.**
- **Zed — confirmed, and it is the origin.** Zed announced ACP 2025-08-27 and implements the client
  in `crates/agent_servers/src/acp.rs` (+ `acp_thread`, `acp_tools`, `agent`, `agent_ui`). It
  launches `claude-agent-acp` via the ACP registry
  (`crates/project/src/agent_registry_store.rs:20`), whose `claude-acp/agent.json` pins
  `@agentclientprotocol/claude-agent-acp@0.75.0`. **[documented]**
- **Devin — half right.** Devin Desktop *is* an ACP client — Cognition's own blog (2026-06-02) and
  `docs.devin.ai/desktop/acp` confirm it, and Devin ships as an ACP *agent* too (`devin acp`). But
  **there is no primary evidence Devin uses `claude-agent-acp` specifically**; Cognition never names
  an npm package, and their docs say "Devin Desktop does not currently download agent distributions
  directly from the registry" with both sample configs using `distribution.binary`, not `npx`.
- **Also worth knowing:** `claude` 2.1.261 has **no `acp` subcommand** **[measured]**
  `claude --help | grep -ic acp` = 0. There is no native ACP mode in Claude Code. The Node wrapper is
  the only ACP path to Claude that exists.

## Verdict

**Do not adopt.** The burden of proof was on ACP to beat something measured and working, and it does
not clear it: Q1 fails outright, Q3 fails, Q2 passes only in a narrower form, and the durability case
— which was the real argument — inverts once you count the v1→v2 break, the pre-1.0 adapter shipping
breaking minors twice a week, and the fact that the undocumented SDK protocol is still down there
underneath either way.

**`docs/research/claude-direct-spike.md`'s 7/7 stands. Nothing here beats 293 lines of `session.rs`.**

**Adopt for a named subset — one thing:** ACP's `PermissionOption` / `PermissionOptionKind` shape.
A closed set of typed choices with the durable rule attached is better than brigadier's current
allow/deny, and it is an enum, not a dependency.

**Revisit ACP if and only if the provider question comes back.** `CLAUDE.md` §2 defers Codex,
Cursor and Grok, and keeps the provider layer a trait. If that deferral ever ends, ACP is the right
answer *for those providers* — `codex-acp` is already in this npx cache, Cursor and Grok speak ACP
natively, and t3code reached exactly that conclusion. **The correct shape is ACP as a second
implementation behind brigadier's existing provider trait, never as a replacement for the Claude
lane.**

## Two things this turned up that are not about ACP

1. **File the `rate_limit_event` guard upstream.** `dist/acp-agent.js:4265`'s
   `lastAssistantTotalUsage !== null` makes every ACP client blind to the session-start rate-limit
   frame — 26 of the 28 frames recorded here, and every session-start one. That is a bug for anyone building a subscription-aware client, not a
   brigadier-specific complaint, and it is a one-line fix. Worth reporting whatever brigadier decides.
2. **Extend the CLI-bump CI job to diff argv, not just control types.** `cli-protocol.md:394,408`
   already proposes "a CI job that re-packs the SDK on each CLI bump and diffs the control types so
   drift shows up as a red build rather than a field that silently stopped arriving." The **only**
   measured breakage in eleven months was in argv construction (`--resume <id>` → `--resume=<id>`,
   unannounced), which a control-type diff would not catch. Diff the built argv array too. That one
   addition buys most of what ACP's argv insulation would have bought.

**A correction that was proposed to `cli-protocol.md` and should be rejected.** A subagent reported
that file's `get_plan` / `get_workspace_diff` entry (`:221`, `:224`) as wrong, on the grounds that
neither literal is emitted from `sdk.mjs` at 0.3.232 or 0.3.251. Reading the file itself, that is a
misreading and **no edit is warranted**: `cli-protocol.md:220` is explicitly counting the "`subtype:`
literal set **across the whole `.d.ts`**", and cites **[verified: diff of the three sdk.d.ts files]**.
It never claimed either subtype was on the wire — it says four lines later that a union change is "a
type-curation change, not a protocol removal". Logged here because the finding was cited to me as
fact and is not one.

## What would have to be true for this answer to flip

Any **one** of these would reopen it; the first two would settle it on their own.

1. **ACP defines account-level rate limits in the spec.** A stable `session/update` variant carrying
   per-window `utilization` and `resetsAt` for `five_hour` and `seven_day`. The RFD that would do
   this is named as future work and does not exist. Watch https://agentclientprotocol.com/rfds/.
2. **`claude-agent-acp` stops dropping the `rate_limit_event`.** Deleting the
   `lastAssistantTotalUsage !== null` guard at `dist/acp-agent.js:4265` — a one-line upstream PR —
   would make `_meta["_claude/rateLimit"]` arrive on the frame brigadier reads. This is worth filing
   regardless of the verdict; it is a bug for any subscription-aware client, not just us.
3. **ACP gains a blocking pre-tool gate that fires on every call** — a `session/request_permission`
   that is not routed through `canUseTool`, or a client-registerable equivalent of `PreToolUse` with
   `matcher: ""`.
4. **Anthropic ships a native `claude acp` mode.** That deletes the Node process and the second
   binary at a stroke, and turns this into a much closer call — the durability argument would then
   be running against a first-party surface. Today: no `acp` in `claude --help`.
5. **The Claude Code stdio control protocol actually breaks brigadier**, more than once, in a way
   `system/init.capabilities` feature detection cannot absorb. That is the empirical test of the
   durability hypothesis, and brigadier should record each instance rather than argue about it. The
   baseline to beat is on the record now: **zero envelope or argv changes across 289 SDK releases**,
   with one unannounced argv-arity flip. Two real breaks would change the arithmetic.
6. **v1 stops moving and the deferred providers arrive.** ACP v2 stabilizes, the foundation forms, a
   deprecation policy is published — *and* the owner un-defers Codex/Cursor/Grok. Then ACP earns a
   place behind the provider trait, still not in front of it.

## Not checked

- **No ACP prompt turn was ever run.** `initialize` only. Everything about `session/new`,
  `session/prompt`, `session/request_permission` and `usage_update` on the wire is read from source,
  not observed. The Q1 drop in particular is a source-plus-ordering inference — see the caveat in
  that section.
- Whether `_meta.claudeCode.emitRawSDKMessages` actually delivers `rate_limit_event` end to end, and
  what latency the extra hop adds. Both are one cheap turn away and worth measuring before anyone
  argues the escape hatch rescues this.
- Whether sending `hooks` as JSON through `_meta.claudeCode.options` throws, is silently ignored, or
  crashes the adapter. Reasoned from `HookCallback` being a function type; never attempted.
- The ACP **v2** schema was diffed against v1 but not read. The 190 changed definitions were counted,
  not inspected — the migration guide's prose is the source for *what* changed.
- The Rust crate `agent-client-protocol` was **not compiled or used**. Its client-role claim is read
  from its published docs and crates.io metadata, not exercised. No `cargo` was run, per the work order.
- `@agentclientprotocol/sdk`'s `experimental/http-client`, `ws-client`, `server` and `node-adapter`
  entry points — ACP over HTTP/WebSocket — were not investigated at all. If a remote-agent story ever
  matters, that is unexamined ground.
- `codex-acp` (1.7.0 and 1.10.0, both in this npx cache) was not read. It is the obvious next file if
  the provider deferral ends.
- Windows and Linux. macOS arm64 only, one Node version (`v24.18.0`), one account.
- Whether the ACP registry's `claude-acp` entry pins a version Zed then honours, or floats.
- **Provenance of the web-sourced evidence.** The ACP spec/governance/RFD reads, the
  Zed/t3code/Devin verification, and the eight-tarball SDK churn diff were gathered by three
  subagents against primary sources. I re-verified the load-bearing ones on this machine — the
  crates.io figures (`curl`), the base-argv and `Unsupported control request subtype` literals in
  `sdk.mjs`, `manifest.json`'s `harnessSchema: 1` and its stale `testedWrapperVersions`, the
  adapter's hardcoded `protocolVersion: 1`, and the 11 stable `session/update` variants. **The
  historical tarball diff (0.1.0 → 0.3.261) I did not reproduce**; only 0.3.257 is on this disk. The
  "byte-identical across 289 releases" claim rests on that subagent's measurement, spot-checked at
  one endpoint.
- Whether `--resume <id>` (space form) actually fails against a current CLI. Inferred from the
  `[value]` arity in `--help`; never executed.
- SDK versions between 0.2.113 and 0.3.159 (a six-week gap) and between 0.3.221 and 0.3.232 were not
  sampled in the churn diff.
- No adversarial second pass. This document was written by one agent from primary sources; the
  Q1 inference in particular has not been argued against by anyone.
