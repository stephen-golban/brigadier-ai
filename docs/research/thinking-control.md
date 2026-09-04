# Thinking control from the harness

**The CLI can express thinking-off, and brigadier can reach it today without a new flag: set
`MAX_THINKING_TOKENS=0` in `SpawnSpec::env_overrides`.** It cannot express an effort level on the
model brigadier is actually running — `--effort` exists, but the CLI hard-codes `claude-haiku-4-5`
as an effort-incapable model and silently drops the flag. Granularity: per-spawn via env or
`--settings`; per-session mid-flight via the `set_max_thinking_tokens` control request, which
brigadier's `ControlRequestKnown` does not yet model.

CLI version behind every **[measured]** claim here: **2.1.260**
(`claude --version` → `2.1.260 (Claude Code)`, this machine, 2026-09-04). The repo's captured
fixtures are 2.1.257/258; the repo's prose is against 2.1.259.

Two `claude` invocations were made for this file and **both cost nothing and spawned no session**:
`claude --version` and `claude --help`. Everything else below is read out of the installed binary
with `strings(1)` — a file read, not a process. No turn was sent; no token was spent.

---

## 0. The question this file was reopened to answer

A real brigadier feed capture on `claude-haiku-4-5` shows a `thinking` item on the prompt *"reply
with exactly the word pong"*. brigadier never asked for thinking. **What turned it on?**

Answer: **the CLI's own default, at §3 below.** Not brigadier's argv, not the model string, not a
settings file. The CLI starts every session at `thinking: {type: "adaptive"}` and, on a model that
has no adaptive mode, rewrites that to `{type: "enabled", budget_tokens: N}` at request-build time.

(The capture's provenance is unconfirmed — it prints a dollar figure, which `docs/plans/
ipc-contract.md` forbids — so it may predate `959bd0c`. The lead is checking that separately; it
does not affect anything below, which is derived from the binary and the docs, not the capture.)

### The Opus 5 warnings do not transfer to Haiku 4.5 — say it out loud

The two named failure modes of disabling thinking — a tool call written into visible text instead
of a `tool_use` block, and `<thinking>` tag leakage — are **[documented]** as properties of
**Claude Opus 5 with thinking disabled**, verbatim: *"This happens on Claude Opus 5 when thinking
is disabled, most commonly on tool-heavy workloads such as search."*
(https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting, fetched
2026-09-04). Haiku 4.5 is a different thinking mode entirely (§1). Turning thinking off on a Haiku
child returns it to that model's own API default, which is **off**. Do not carry the Opus 5
warning across. §7 covers what brigadier would observe if it ever *did* fire.

---

## 1. What the API supports per model — the table that settles the frame

**[documented]** — https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting,
fetched 2026-09-04. Quoted rows:

| Model | Thinking types | Default | Rejected with 400 |
| --- | --- | --- | --- |
| Claude Opus 5 | Adaptive only | On | `"enabled"`, `"disabled"`² |
| Claude Opus 4.5 | Extended only | Off | `"adaptive"` |
| **Claude Haiku 4.5** | **Extended only** | **Off** | **`"adaptive"`** |
| Claude Sonnet 4.5 | Extended only | Off | `"adaptive"` |

*"² Claude Opus 5 accepts `"disabled"` at effort `high` or below; combining it with effort `xhigh`
or `max` returns a 400 error."* And: *"Models marked `Always on` cannot turn thinking off. Models
marked `On` default to thinking but accept `thinking: {type: "disabled"}`."*

So on Haiku 4.5: thinking is **off** unless a caller asks for it; `{type: "enabled", budget_tokens:
N}` is the only way to ask; `{type: "adaptive"}` is a **400**; `{type: "disabled"}` is accepted
(it is not in the rejected column).

Effort on Haiku 4.5: **not supported.** **[documented]** — the effort table at
https://code.claude.com/docs/en/model-config (fetched 2026-09-04) lists Fable 5.1/5, Opus 5, Sonnet
5, Opus 4.8, Opus 4.7, Opus 4.6 and Sonnet 4.6 and no Haiku at all; the extended-thinking page says
*"On Claude Opus 4.5, the only extended-thinking-only model that supports effort…"*
(https://platform.claude.com/docs/en/build-with-claude/extended-thinking, fetched 2026-09-04),
which excludes Haiku 4.5 by construction.

---

## 2. What brigadier's own argv sets: nothing

**[source]** `crates/core/src/claude/process.rs:114-140` — `build_argv` emits exactly
`--output-format stream-json --verbose --input-format stream-json`, then optional `--model`, then
`--permission-prompt-tool stdio`, optional `--resume=`, optional `--strict-mcp-config`, then
`--permission-mode`. No thinking flag, no effort flag, no budget. The argv test at
`process.rs:384-401` pins that shape.

**[source]** `process.rs:41-52` — `STRIPPED_VARS` removes `CLAUDE_EFFORT` from the inherited
environment. That is correct but irrelevant to the cause: `CLAUDE_EFFORT` is an **output**, not an
input. The CLI writes it into the environment of its *own* Bash-tool children
(binary: `…CLAUDE_PID:String(process.pid)}; … if(e.effortLevel!==void 0) n.CLAUDE_EFFORT=e.effortLevel;`).
**[measured]** this shell, a Bash-tool child of a 2.1.260 session, has `CLAUDE_EFFORT=high` and
`AI_AGENT=claude-code_2-1-260_agent` in its environment (`env | grep -i CLAUDE`). Nothing in the
binary reads `CLAUDE_EFFORT` as configuration. Candidate 1: **ruled out.**

Candidate 4, the model string: **ruled out.** `--model` takes an alias or a full name
(`claude --help`, 2.1.260). The only suffix machinery in the catalog is `supports_1m_suffix` for
context windows; there is no effort or thinking suffix. The function that could have carried a
per-model thinking override, `mkt(e)`, reads a *runtime request latch*
(`function mkt(e){return n().host.requestLatches.thinkingTypeOverrides().get(e)}`), populated by
earlier responses in the same process, not by the model string a caller passes.

---

## 3. What actually turned thinking on — the CLI's own default

**[source]** installed binary 2.1.260, `strings(1)`. Two fragments, in order.

**Session startup** picks the config:

```js
… process.env.MAX_THINKING_TOKENS ? Va(process.env.MAX_THINKING_TOKENS) : U.maxThinkingTokens;
if (Le !== undefined) {
  if (Le > 0)       Pn = {type:"enabled", budgetTokens: Le}, Os = true;
  else if (Le === 0) Pn = {type:"disabled"},                 Os = true;
}
Pn ??= PN() ? {type:"adaptive"} : {type:"disabled"};
```

with

```js
function ZEn(){ if(process.env.MAX_THINKING_TOKENS) return Va(process.env.MAX_THINKING_TOKENS)>0 ? null : "MAX_THINKING_TOKENS";
                let {settings:e}=ib(); return e.alwaysThinkingEnabled===false ? "alwaysThinkingEnabled" : null }
function PN(){ if(ZEn()!==null) return false; return true }
```

`PN()` is `true` unless `MAX_THINKING_TOKENS` is 0 or `alwaysThinkingEnabled: false` is in settings.
So **the default session thinking config is `{type: "adaptive"}`, unconditionally, for every
model.** The initial app state literally carries `thinkingEnabled: PN()`.

**Request build** then rewrites it for the model in hand:

```js
if (Hn && QEn(U))
  if (N4t({runtimeOverride:mkt(f.model), resolvedModel:U, canonicalModel:re}) === "adaptive")
       qf = {type:"adaptive", display:xc};
  else { let Gd = dtr(U);
         if (r.type==="enabled" && r.budgetTokens!==undefined) Gd = r.budgetTokens;
         Gd = Math.max(1024, Math.min(tt-1, Gd));
         qf = {budget_tokens:Gd, type:"enabled", display:xc}; }
else if (r.type==="disabled" && Pe()==="firstParty" && !sr && QEn(U) && !KFe(U))
  qf = {type:"disabled"};
```

- `Hn = r.type !== "disabled" && !Ie(process.env.CLAUDE_CODE_DISABLE_THINKING)` — thinking is wanted.
- `QEn(e)` = model supports thinking = `!model.includes("claude-3-")`. Haiku 4.5: **true.**
- `N4t` returns `"adaptive"` only when `WYe(model)` is true, and
  `function WYe(e){ … if(r.includes("claude-3-")||r==="claude-opus-4-0"||…||r==="claude-haiku-4-5") return false; …}`.
  Haiku 4.5: **false** → the `else` branch.
- Therefore the request carries `thinking: {type:"enabled", budget_tokens: clamp(1024, tt-1, dtr(U))}`.

**That is the answer.** Candidate 2 — the CLI's own default — is the cause, and the mechanism is
that a session default of `adaptive` degrades to *manual thinking with a large budget* on a model
that has no adaptive mode, rather than degrading to off.

The concrete budget: `dtr(e) = OK(e).upperLimit - 1`, and the catalog entry
`id:"claude-haiku-4-5" … max_output_tokens:{default:32000, upper:64000}` gives `63999`, clamped by
`min(tt-1, …)` where `tt` is the per-request max-output ceiling. **[asserted]** the value that
lands is `31999`; the arithmetic was not verified against a live request, and it does not change
the recommendation — any positive budget is thinking-on.

Nothing about this differs between interactive and `--output-format stream-json` mode: the branch
above reads no `isNonInteractiveSession`. The only non-interactive-specific thinking behaviour is
`mtr(…)`, which forces `display: "omitted"` in non-interactive sessions unless the display was set
explicitly — a *display* switch, not an *enable* switch. **[asserted]** from source reading; not
tested against a live session, and the capture shows thinking text arriving, so display was not in
fact omitted there.

Candidate 3, an inherited settings file: **not the cause, but live.** `alwaysThinkingEnabled` and
`effortLevel` are read from the settings stack, and `build_argv` passes no `--setting-sources`, so
the user's `~/.claude/settings.json` is loaded (already noted at `process.rs:107-113`). A user who
sets `alwaysThinkingEnabled: false` for themselves silently changes every brigadier child. That is
the same class of shadow as the `permissions.allow` gap already recorded in
`docs/research/approvals.md` §7 gap 4.

---

## 4. What the CLI can express, and at what granularity

### 4a. `--effort <level>` — real, per-spawn, and a no-op on Haiku 4.5

**[measured]** `claude --help`, 2.1.260:

```
--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
```

It carries no *"only works with --print"* qualifier, so it is available in brigadier's
`--input-format stream-json` mode. **[documented]** https://code.claude.com/docs/en/cli-reference
(fetched 2026-09-04): *"Set the effort level for the current session. Options: `low`, `medium`,
`high`, `xhigh`, `max`, or `ultracode`. Available levels depend on the model. … Overrides the
`modelSettings` and `effortLevel` settings for this session and does not persist."*

The catch, **[source]** binary 2.1.260:

```js
function eh(e){ if(gkt(e)) return false; let n=SJ(e,"effort"); if(n!==void 0) return n;
                let o=Ue(e), r=_4t(e,o); if(r!==void 0) return r.length>0;
                if (o.includes("claude-3-")||o==="claude-opus-4-0"||o==="claude-opus-4-1"
                  ||o==="claude-sonnet-4-0"||o==="claude-sonnet-4-5"||o==="claude-haiku-4-5") return false; … }
function Uy(e,n){ return eh(e) ? ET(e,n) : undefined }
```

`claude-haiku-4-5` is hard-coded as effort-incapable, and `Uy` then returns `undefined`, so **no
effort parameter is sent at all**. `--effort low` on a Haiku child is accepted by the parser and
silently discarded. There is no warning on that path — the only effort diagnostic in the binary is
the thinking-off/effort-cap 400 relay (§4d). **This is the trap to write down:** a harness that
"downshifts effort for the mechanical lane" while routing that lane to Haiku changes nothing and
reports nothing.

Precedence, **[source]**:
`B(e){ let n=A(e.cli.effort); if(n!==void 0) return n; if(e.settings.ultracode===true) return "xhigh"; return pK(e.settings.effortLevel) }`
— `--effort` beats `ultracode` beats `effortLevel`; and `CLAUDE_CODE_EFFORT_LEVEL` overrides the
lot for the session (`LH()`, and the bridge refuses a change with *"CLAUDE_CODE_EFFORT_LEVEL
overrides effort for this session"*). **[documented]** https://code.claude.com/docs/en/env-vars
(fetched 2026-09-04): *"`CLAUDE_CODE_EFFORT_LEVEL` — Overrides `--effort` and `/effort`."*

### 4b. Thinking off, per spawn — two levers, both real

**`MAX_THINKING_TOKENS=0`.** **[documented]** https://code.claude.com/docs/en/model-config (fetched
2026-09-04): *"Set `MAX_THINKING_TOKENS=0`, which turns thinking off on the Anthropic API except on
Fable 5.1 and Fable 5."* **[source]** it reaches `Pn = {type:"disabled"}` directly at startup (§3),
ahead of the `adaptive` default. The env-vars reference page did not list it in the fetched
excerpt, which was truncated; the model-config page is the source of record here.

**`alwaysThinkingEnabled: false` in settings.** **[documented]**
https://code.claude.com/docs/en/settings-reference (fetched 2026-09-04): *"Turn extended thinking
off for every session."* **[source]** the zod settings schema in 2.1.260 describes it as *"When
false, thinking is disabled. When absent or true, thinking is enabled automatically for supported
models."* — the CLI stating its own default in its own words. `--settings <file-or-json>` loads
additional settings (`claude --help`), so `--settings '{"alwaysThinkingEnabled":false}'` should be
a per-spawn form that never touches the user's file. **[asserted]** — the flag's acceptance of that
particular key was not exercised; the env var was preferred precisely because it needs no such
assumption.

**`CLAUDE_CODE_DISABLE_THINKING`** is a third form and behaves differently: it sets `sr`, which
kills `Hn` *and* fails the `!sr` guard on the `disabled` branch, so the request carries **no
`thinking` key at all**. On Haiku 4.5 omitting is equivalent to disabled (default Off, §1), so it
is not worth the extra variable. **[source]** binary only; **not documented** on the pages fetched.

### 4c. Thinking off, per turn / mid-session — `set_max_thinking_tokens`

The stdio control protocol does carry a thinking lever. **[source]** binary 2.1.260, request schema:

```js
c({subtype:k("set_max_thinking_tokens"),
   max_thinking_tokens: T().int().nullable().optional(),
   thinking_display: Y(["summarized","omitted"]).nullable().optional()})
  .describe("Sets the maximum number of thinking tokens for extended thinking. …")
```

It appears in the host→CLI subtype set alongside `set_model` and `set_permission_mode`
(`new Set(["set_model","set_permission_mode","interrupt","stop_task","background_tasks",
"set_max_thinking_tokens","rename_session","set_color", …])`), and the SDK's own client wraps it as
`async setMaxThinkingTokens(e,r){ await this.request({subtype:"set_max_thinking_tokens", …}) }` —
so it is the same stdio lane brigadier already speaks. It applies as a permission layer:

```js
function Q1e(e){ let o=e.options.thinkingConfig;
                 for (let s of e.permissionLayers??[]) if (s.kind==="max_thinking_tokens") o=g(s.maxThinkingTokens);
                 return o }
function g(e){ return e===0 ? {type:"disabled"} : {type:"enabled", budgetTokens:e} }
```

**`max_thinking_tokens: 0` ⇒ `thinking: {type:"disabled"}` from the next request onward.** That is
per-session and mid-flight, which is strictly more than a per-spawn flag gives.

Two caveats. **[source]** the schema's own describe ends *"…and older builds, ack success without
applying it"* — the fragment is truncated, so some build or model combination acks without effect;
which one was **not determined**. And `crates/claude-wire/src/control.rs:92-140` models only
`Initialize`, `Interrupt`, `SetPermissionMode` and `SetModel` on the host→CLI side, so brigadier
would need a new `ControlRequestKnown` variant (or a raw frame) to send it. There is **no
`set_effort` control request** in the binary at all (`strings | grep -c set_effort` → 0); the only
effort-over-the-wire path is `apply_flag_settings`, which the binary gates to the Remote Control
bridge and restricts to `effortLevel` and `ultracode`.

**No per-turn field exists on the user frame.** Thinking and effort are session state changed by a
control request, never a field on the message being sent. A `per_turn_effort` capability string
exists in the catalog and is gated behind a statsig check (`DTt(…)` requiring
`em(n,"per_turn_effort",e)`), and Fable 5 carries it — Haiku 4.5 does not, and it is not reachable
from a flag today.

### 4d. What `initialize` / `system/init` advertises

**[source]** the `system/init` zod schema in 2.1.260 **does** carry an `effort` field:

```js
effort: Y(["low","medium","high","xhigh","max"]).nullable().optional()
  .describe("The effort level the session will send on its next request — after env overrides,
             session state, org caps and model-support downgrades; … null when no effort parameter
             will be sent (a model without effort, CLAUDE_CODE_EFFORT_LEVEL=unset, or an internal
             numeric budget). Present on Remote Control bridge init frames (terminal- and
             Desktop/VS Code-hosted sessions); absent on hosts that do not publish it and on CLIs
             that predate the field. …")
```

`crates/claude-wire/src/message.rs:208-211` already models it as `Option<String>`, which matches.

**[measured]** it is absent from **all 15** captured real `system/init` frames in
`crates/claude-spike/fixtures/*.ndjson` (2.1.257/258) — the only fixture carrying `"effort":"high"`
is the synthetic `crates/claude-wire/tests/fixtures/system_init.json`. Two reasons, both in the
describe: the frames predate the field, and Haiku 4.5 is *"a model without effort"*, so the value
would be `null` even on 2.1.260. **Nothing on the init frame reports the thinking configuration**
— there is no thinking field in the schema at all, so a harness cannot read back what §3 decided.
That is the observability gap: `fast_mode_state` is reported, thinking is not.

---

## 5. Where the docs and the machine disagree

- **`--effort` on an unsupported model.** The docs say *"If you set a level the active model does
  not support, Claude Code falls back to the highest supported level at or below the one you set"*
  (model-config, fetched 2026-09-04). That describes a model with a *shorter ladder*. For a model
  with *no* effort support at all — Haiku 4.5 — the binary's `Uy` returns `undefined` and no effort
  is sent. The documented sentence would lead a reader to expect `low` to become `high`; it in fact
  becomes nothing. Same practical outcome, different mechanism, and neither is a warning.
- **`MAX_THINKING_TOKENS` and `CLAUDE_CODE_DISABLE_THINKING`** are absent from the env-vars
  reference as fetched (that page was truncated mid-fetch, so this is a soft disagreement).
  `MAX_THINKING_TOKENS` is documented on the model-config page instead; `CLAUDE_CODE_DISABLE_THINKING`
  is documented nowhere the fetch found and exists only in the binary — treat it as unsupported.
- **`https://code.claude.com/docs/en/effort-levels`** is linked from the env-vars page and returns
  **404** (fetched 2026-09-04). The effort table lives on `model-config` instead.

---

## 6. Consequences already visible, not mine to fix

**The feed writes each thinking item twice.** `crates/core/src/claude/adapter.rs:1188-1202`:
`emit_item` emits `Event::item_started` and `Event::item_completed` back to back with the same
summary, for every content block. The capture's `thinking · …` / `thinking done · <same text>` pair
is that, not a CLI duplication. The row carries `summarize(body)`
(`adapter.rs:1278-1281`: first non-empty line, bounded by `SUMMARY_LIMIT`), so it is a first line,
not the full prose — on a short thought those are the same string. Whoever builds the
`docs/vision.md` §9 verbose toggle inherits a `ItemKind::Thinking` row that arrives twice per
thought.

---

## 7. What brigadier would observe if a tool call landed as visible text

Only relevant on Opus 5 with thinking disabled (§0), but the answer matters because §8 has to weigh
it. **[source]** `crates/core/src/claude/adapter.rs:640-679`, `on_assistant_block`:

- `ContentBlockKnown::Text` → `emit_item(…, ItemKind::AssistantText, …)`.
- `ContentBlockKnown::ToolUse { id, name, input }` → `emit_item(ItemId::new(id), ItemKind::ToolCall { name }, …)`, and the item id **is** the `tool_use` id, which is what `can_use_tool.tool_use_id` and the answering `tool_result.tool_use_id` carry.

A leaked tool call arrives as a plain `text` block. brigadier would emit **one ordinary
`AssistantText` row whose body happens to read like a tool invocation**, and then:

- **no `can_use_tool` control request**, so the approvals panel stays silent and the gate is never
  consulted;
- **no `PreToolUse` hook callback**, so the wall never fires;
- **no `tool_use` item**, so nothing correlates and no `tool_result` is ever expected;
- the turn ends `stop_reason: "end_turn"` — `stop_reason_of` (`adapter.rs:1285-1292`) maps that to
  `StopReason::EndTurn`, a **success**.

**Nothing in `adapter.rs` would catch it.** There is no text-block heuristic and there should not
be one — substring-sniffing model prose is exactly what `docs/research/provider-driver.md` §6 #21
warns against for stop reasons. The failure is silent by construction: a green turn in which the
work did not happen. In a red-gate race, brigadier would score a worktree that never ran the
command.

---

## 8. Recommendation — what the harness should actually set for a pure-execution work order

**Set `MAX_THINKING_TOKENS=0` in `SpawnSpec::env_overrides` for the execution lane, and do not
touch `--effort`.** `crates/core/src/claude/process.rs:213-215` applies `env_overrides` after the
strip list, so this needs no change to `build_argv` and no new flag — only the caller that builds
the spec. Do not add `CLAUDE_CODE_DISABLE_THINKING` (undocumented) and do not write
`alwaysThinkingEnabled` into anyone's settings file (it is global and persists).

**Why off rather than low effort, on this model.** The "prefer low effort to disabling thinking"
guidance is an *Opus 5* rule and rests on an *Opus 5* failure mode (§0). On Haiku 4.5 there is no
effort knob to lower — `--effort` is discarded (§4a) — so the choice is not off-versus-low, it is
off-versus-a-31999-token budget the harness never asked for. And "off" here is not an exotic mode:
it is the model's own API default (§1, *Default: Off*), which every non-Claude-Code caller of Haiku
4.5 gets by omitting the parameter. brigadier is undoing an opt-in it did not make.

**What it costs to be wrong.** `docs/vision.md` §6 measures spend in usage windows, not dollars, and
thinking tokens are billed output tokens that count against `max_tokens`
(https://platform.claude.com/docs/en/build-with-claude/extended-thinking, fetched 2026-09-04). A
31999-token budget on a *"reply with the word pong"* turn is a window charge for deliberation the
work order did not ask for, and it is per turn, on every mechanical child, forever. Being wrong in
the other direction — thinking off where a work order needed it — costs one re-issued work order
against a harness that already rents a fresh window per decision and throws it away. The asymmetry
favours off for the execution lane. Two rules on top: **never set it on the judgement lane**, and
**never add a "do not think" instruction to a prompt** — that is the one mitigation the docs say
makes leakage worse (*"System-prompt rules instructing the model not to think or not to reason
increase the tag leakage"*), and the env var achieves the same thing at the API without touching
the prompt.

**If the execution lane is ever routed to Opus 5 instead**, invert the answer: leave thinking on and
set `--effort low`. Opus 5 supports effort, and disabling thinking there buys the §7 failure that
brigadier cannot detect. The rule is per-model, not per-lane, and the two must be decided together.

**The nearest thing to true per-turn control** is the `set_max_thinking_tokens` control request with
`max_thinking_tokens: 0` (§4c), which would let one session alternate deliberation and execution
without respawning. It needs a new `ControlRequestKnown` variant in `crates/claude-wire/src/control.rs`
and a spike to settle the *"older builds ack success without applying it"* caveat. Not required for
role-based routing, since brigadier spawns a fresh child per work order anyway.

**One thing to fix regardless of the decision above:** brigadier cannot currently see what thinking
configuration its child is running (§4d — `system/init` reports `fast_mode_state` but nothing about
thinking, and `effort` is `null` on an effort-less model). The cheapest check is the one this file
used: a `thinking` item in the feed means thinking is on. If the execution lane sets
`MAX_THINKING_TOKENS=0`, a `ItemKind::Thinking` event on an execution child is a regression signal
and worth an assertion in whatever test drives that lane.

---

## 9. What was not checked

- **No live request was made.** Every §3 and §4 claim is read out of the 2.1.260 binary or the
  vendor docs. That `MAX_THINKING_TOKENS=0` actually removes the thinking item from a brigadier
  feed is **[asserted]**, not measured — it follows from the startup branch plus the API table, and
  it is one cheap spike to confirm.
- **The 31999 budget figure** is arithmetic over `dtr`/`tt` that was not run.
- **`--settings '{"alwaysThinkingEnabled":false}'`** was not exercised; the key is documented as a
  settings key and the flag as a settings loader, but the combination is inference.
- **The truncated describe** on `set_max_thinking_tokens` (*"…and older builds, ack success without
  applying it"*) — which builds, and whether 2.1.260 is one of them, is unknown.
- **`--effort` was not run against a Haiku session** to confirm the silent drop; that rests on
  reading `eh`/`Uy`.
- **Whether interactive and stream-json mode differ** rests on the absence of a mode check in the
  request-build branch, not on a diffed capture of both.
- **The weakest claim in this file** is §4b's `--settings` form. Everything the recommendation
  depends on has both a binary fragment and a vendor doc behind it; that one has neither a fetch
  confirming the flag accepts the key nor a run.
