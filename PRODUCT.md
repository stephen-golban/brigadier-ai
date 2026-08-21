# What brigadier is, where the built thing went, and what it costs to correct

RECORDED 2026-08-21 by the owner-intent session. Nothing here is a ruling. Every ruling named below
is still locked, and only the owner can overturn one. This document exists to bring them to him with
the cost attached, which is what section 3 is for.

**Nothing in this document was committed, tagged, merged, or moved.** `gauntlet/verify-3` is where it
was.

---

## 0. What the owner decided in this session, 2026-08-21

These are the owner's answers, recorded before the analysis that produced them, because they are what
the rest of this document is now written against. **None of them is a ruling yet.** A ruling goes on
issue #1 with its reason and its accepted cost; these are the decisions that a ruling round would
turn into one.

| # | decision |
| --- | --- |
| D1 | **The model drives; brigadier is worn by the session.** Start any CLI and that session *is* brigadier — toggleable in settings, forceable per session. The user types a goal in English and never learns a command. |
| D2 | **Brigadier drives a planner.** Research and planning are delegated to a workhorse, not done by the host model, so the user's session is never flooded with the work. The host session is a conductor: the request, the progress, the report. |
| D3 | **Planning and research are not forced.** Work that needs neither gets neither. Brigadier decides — and **asks the user anyway** before spending on either. |
| D4 | **A plan is always shown, never inline.** One line naming a path. The plan file lives in the run record, so the operator's repository is never touched — item 4 already asserts byte-identity and a plan written into the tree would fail it. |
| D5 | **Brigadier asks questions in its own voice, in the session.** Not a handoff to another party — the same conversation. Mechanically: MCP elicitation, measured available on this machine. |
| D6 | **Fan-out width is `min(independent items, RAM cap, configured cap)`. Vendor count does not cap it.** Assignment spreads across distinct vendors first, then reuses — so three items on three vendors get one each, and three items on a claude-only machine get **three claude workers**. A single-vendor machine keeps its parallelism. |
| D7 | **The planner decides per item whether work gets an adversarial review.** Its judgement is the default. |
| D8 | **Any failure routes to another vendor. Quota is never read.** A failure is signal enough. A vendor that fails is marked cold in state and stops receiving work for a window. |
| D9 | **A failure matching no known class defaults to *the work failed*, not *the vendor failed*** — ruling 24's rung 1 first, rung 2 after. Routing away on an unclassified failure would walk broken work down the whole fleet, one burnt attempt per vendor. |
| D10 | **Windows is not cut. Ruling 12 stands.** The owner has a Windows machine with the project and a working Claude Code on it, so the 63 failures are a backlog on a real host rather than blind work. |
| D11 | **Ollama and raw local models are cut from v0.1. Ruling 9 stands.** No ACP agent exists in front of ollama, and writing brigadier's own agent loop would make it a competitor to everything it drives rather than a hub. |
| D12 | **Product correction first; Windows once the shape is settled.** Steps 1–4 land, then Track B is safe to run in parallel because nothing further moves the files it touches. Windows CI stays red for that period, which is the accepted cost. |
| D13 | **Questions travel by exit-and-resume, not MCP.** Brigadier exits with the question and enough state to continue; the model raises it in conversation; `brigadier resume <run-id> --answer …` picks it up. **No ruling is overturned by this** — it works on all six vendors, where MCP elicitation is measured on Claude Code alone, and it matches the owner's own sentence (*"if brigadier has a question the model raises it"*) more closely than a dialog box does. MCP stays available as a later upgrade if progress turns out to need it. |
| D14 | **A run that exits to ask a question cleans up on ruling 63's seam.** Every process dies; every empty clone is deleted; every clone holding committed work is kept and reported with its path and its bytes. The exit is a **drain**, reusing the interrupt path ruling 63 already built — finished items stay merged on `refs/heads/brigadier/<run-id>`, which survives cleanup by design. |
| D15 | **A pending run is invalidated by divergence, not by a clock** — the owner delegated the duration and this is the answer. It expires the moment resuming would be wrong: the operator's `HEAD` moved, the working tree changed, a path the plan claims was touched, or a routed vendor is gone or drifted (ruling 69). Item 4 already captures `HEAD`, `git status --porcelain -uall`, the `.git/index` hash and a whole-tree hash before every run, so the comparison is already computed for another purpose. **Backstop: 7 days** for the case where nothing diverges and the owner forgot. **That number is a judgement and not a measurement**, and it is printed beside every expiry it causes. Divergence is path-scoped rather than whole-tree, so an unrelated typo fix does not invalidate a run. |

| D16 | **The plan file is deleted by default**, and keeping it is the toggle. Against the recommendation, which was the opposite; the cost is that the record of how brigadier split a task is gone by the time the split turns out to have been wrong. |
| D17 | **The review decision clamps** (ruling 67's shape): the planner decides, brigadier may override **toward** review and never away from it, and the `review: false` rate is tracked against each repository's own history. |
| D18 | **A cold vendor stays eligible as a reviewer and is removed from build.** A reviewer failure costs one turn and blocks nothing; a builder failure costs an attempt. Cold expires on elapsed time and re-probes, never on a vendor's stated reset — `resetsAt` is already recorded as drifting with wall clock. |
| D19 | **No review globs, and brigadier never requires a verify command.** Nothing pushes the operator toward having tests, nothing warns them for not having them, and a repository with no test suite is a normal repository. The clamp's floor is instead **ruling 67's existing structural input — owned-path count and bytes changed** — which needs no tests, no settings and no maintained list, and which a planner cannot inflate to dodge review without giving up fan-out (ruling 14 rejects two items claiming one path). |
| D20 | **Ranking stays: brigadier picks the best of the vendors available.** The objection was never to ranking — it was to a monoculture. D6 already spreads work across vendors within a plan; D20 keeps best-of-available for a single item. |
| D21 | **Ruling 23's separation is overturned for OUTCOMES ONLY, never for cost.** Brigadier records whether each item passed, how many rungs it took and whether the reviewer rejected it, per (vendor, work kind), and competence learns from that. **Ruling 23's reason permits this even though its letter does not**: it separated the paths because *"a prediction is falsifiable, a competence score is editorial"* — and an outcome is falsifiable. What it was protecting against is **cost** data driving competence, and cost was measured at 15× variance between two identical runs. Cost stays barred. **An exploration floor is mandatory**: every capable vendor keeps receiving some work regardless of score, or a single early failure entrenches itself — v1's finding 87, a model scored 85 silently excluded from every `hard` item, is what that looks like. `BAR.md` records the current separation as **a gate in `bun run claims`**, so this overturn changes a build check and not only a document. |

| D22 | **`research` is a work kind with a dated-finding rule.** Its brief names today's date, requires sources to carry dates, and requires the finding to say when it was measured — which is `AGENTS.md`'s own standing discipline (*"Record results as MEASURED against `<tool> <version>` on `<date>`, never in the present tense"*) pointed at a worker instead of at ourselves. A research finding with no date is rejected, exactly as a reviewer with no verdict is `error` and blocks (ruling 52). **The accepted cost:** a worker that fabricates a date passes. This verifies that a claim *carries* a date, not that the date is true — the same limit ruling 30 accepts about effort and ruling 67 about difficulty. Third instance of one shape, which makes it a property of driving somebody else's model rather than an oversight. |
| D23 | **`BAR.md` gets one item that tests the product against section 1 of this document** — the organ the process did not have. It grades **no prose**. Section 1 makes six mechanically checkable claims and the item is six assertions: setup runs clean on a fresh home and `detect` agrees with it; a session engages brigadier without being named; `run --goal "<sentence>"` produces a run with no hand-authored plan; the session output carries a path and not the plan; the operator's repository is byte-identical (already item 4); and a question round-trips through exit-and-resume. Remove the goal entry point or let a plan render inline and the item goes red and the tag is blocked. Called by the coordinator rather than the owner, who twice recorded having no view; **the owner may strike it, and this note records that it was his to strike.** |

| D24 | **Unslop is a written standard plus a line form, and no lint.** The standard lives in `AGENTS.md` and covers tone. **The enforcement is structural: every user-facing message is one line.** `brigadier: planning` · `brigadier: plan ready → <path>` · `brigadier: item 3 → codex` · `brigadier: item 3 done`. A word list detects slop after someone writes it; a line form leaves nowhere to put it, and it is checkable without judgement. **Scope is the owner's own: output TO THE USER only** — brigadier keeps talking normally to its workhorses, and `AGENTS.md`, `BAR.md`, worker briefs and this document are all out of scope. **The final report reconciles with ruling 58 as one line per fact**: passing items collapse to a count, and a failing item gets one line per blocking check (`item 3 — codex — verify failed: 2 tests red`), so ruling 52's *fewer items, never fewer checks* survives the compaction. **What cannot be linted or shaped:** the reviewer finding text a rejected item carries into a retry (`OWNER-QUESTIONS.md` #16) is a worker's prose. Brigadier can quote it or drop it; it has no model with which to rewrite it. |

### Still open — the owner has not ruled on these

1. **The exploration floor's size** (D21). Every capable vendor must keep receiving some work
   regardless of score, and how much is unmeasured. Not a blocker: it can be a settings default
   picked as a judgement and printed beside the ranking it protects, the way `BAR.md` prints the
   2.5 MiB contribution budget beside every verdict it produces.

---

## 1. What brigadier is, in product terms

A person installs one binary and runs `brigadier setup` once. Setup looks at the machine, finds every
coding agent that can actually be driven, writes a settings file, and says what it found.

From then on, **every CLI session that person starts is a brigadier session.** They type `claude`, or
`codex`, or `qwen`, and the session that opens is wearing brigadier. They can turn that off in
settings, and they can force it on for one session regardless of the setting.

They type a goal in English: *"create the settings page for this app."*

Brigadier takes it from there:

- It works out whether this needs research, a plan, or neither, and **asks before spending on
  either** — a typo fix does not get a research phase.
- It researches the codebase, and the web **as of today**, not as of whatever year the model's
  instincts reach for.
- It plans, and the plan is a file. The session gets **one line naming the path**, never the plan
  inline.
- It splits the work and hands pieces to the models on that machine — some to Opus, some to GPT, some
  to Qwen — choosing by what each is good at and what quota is left.
- It fans out as wide as the work and the machine allow, and no wider.
- It decides which results need an adversarial review, and gets one from a different vendor where the
  machine has one.
- When something runs out of quota, it moves the work rather than failing it.

**What the person sees is a handful of concrete lines.** Researching. Done. Planning. Done. Item 3 to
codex. Codex finished. Nothing else. All the real traffic — prompts, transcripts, retries, the
arguing with workhorses — happens where they never see it and never pay for it.

**When brigadier needs a decision, it asks, in the session, in its own voice.** Not a different
party interrupting. The same conversation.

That is the product. Four sentences of it are already built to a very high standard. The rest was
never a work item.

---

## 2. Where the built thing diverges, item by item

Evidence is from the working tree at `gauntlet/next` `2844da7`, issue #1 in full (345,173 bytes,
body plus seven comment threads), and probes run on this machine on 2026-08-21. Every claim below
names where to check it.

### 2.1 Nothing puts brigadier into the session

**Wanted:** start a CLI, that session is brigadier.
**Built:** `brigadier install` writes one markdown file to `~/.agents/skills/brigadier/SKILL.md` and
`~/.claude/skills/brigadier/`. A skill's name and one-line description sit in the model's prompt; its
body loads only if the model decides your request matches.

The shipped `SKILL.md` says so itself, at line 71:

> **Everywhere else there is no hook, and the trigger is model discretion.** brigadier is reached
> when the agent reading this decides the description above matches the task. That is the whole
> mechanism outside Claude Code, and it is not a guarantee.

**And the mechanism to fix it is already permitted by this repository's own build gate.**
`src/plugin/hooks.ts`:

```
FLOOR_HOOK_EVENTS   = ["PreCompact", "UserPromptSubmit", "SubagentStop"]
REGISTERED_HOOK_EVENTS = ["PreCompact"]
```

`eventsAboveFloor()` fails `bun run build` on anything above the floor. `UserPromptSubmit` is
**below** the floor — pre-approved, and unused for five days.

MEASURED 2026-08-21 against the published Claude Code hook reference: `UserPromptSubmit` fires before
the model processes a prompt, and **its plain-text stdout is added as context the model can see and
act on**. It lives in `hooks/hooks.json` inside brigadier's own plugin directory, so registering it
touches no foreign file and does not disturb ruling 8 or ruling 27.

**This is a one-line change to an asset brigadier already ships, for the single largest missing
feature in the product.** It was never refused. It was never a ticket.

### 2.2 `claude --brigadier` cannot exist, and its real form does

**Wanted:** `claude --brigadier`.
**Reality:** Claude Code owns its argv. An unknown flag is an error, and no amount of work on our side
changes that.

MEASURED 2026-08-21 against the published CLI reference, the real mechanisms are:

- `claude --append-system-prompt-file <path>` — append text to the system prompt for one session.
- `claude --system-prompt-file <path>` — replace it.
- `claude --settings <path or inline JSON>` — override settings for one session.

So `--brigadier` is a **shim on `PATH`**: a small `brigadier` launcher that execs the vendor's real
binary with its own injection flag. The user types `brigadier claude`, or aliases it.

**The cost, named rather than discovered:** ruling 26 says *"there is no separate PATH install"* and
ruling 42 forbids a `bin/` outside Claude Code. A shim is exactly a PATH install. That is a ruling to
overturn, not a detail — see 3.5.

### 2.3 Brigadier does not plan, and cannot

**Wanted:** brigadier researches and plans.
**Built:** `brigadier run --plan <path>`. The plan is a JSON file **somebody else already wrote**.

`src/work/kind.ts:32` — `export type WorkKind = "write" | "read-only"`. There is no `research` kind
and no `plan` kind. The shipped `SKILL.md` instructs the host model to write the plan file and call
the binary.

The cause is **ruling 20, locked 2026-08-16 — day one, session 3, before a line of product code
existed**:

> **"brigadier's orchestrator has no context window. It is deterministic code, not an LLM loop."**

Researching is thinking. Planning is thinking. Ruling 20 says brigadier does not think.

**And this is where the process failed rather than the engineering.** In `BAR.md`'s coverage table,
ruling 20 is recorded as:

```
| 20 the orchestrator has no context window | architectural exclusion — no user-visible promise |
```

It is the most user-visible ruling in the record — it decides whether the product can think — and it
was filed as having no user-visible consequence. So no bar item was written against it, and nothing
looked at it again.

`BAR.md`'s own preamble names this exact failure mode two paragraphs above that table:

> *"The second column is where a promise gets quietly buried. Writing `no user-visible promise` next
> to a ruling that has one is a single-line way to make this bar lie."*

The document predicted its own defect and then committed it, on the ruling that mattered most.

### 2.4 "Smart delegation" is a hand-written table with no measurements in it

**Wanted:** intelligently delegate — some work to Opus, some to GPT, some to Qwen.
**Built:** `src/router/table.ts`, a constant compiled into the binary. Its own header:

> *"Read the numbers below for what they are. **Not one row says `measured`**, and that is the honest
> state of this repository rather than an omission."*

Six agents × two roles, scored by hand. The model column reads `default` on five of six, because
MEASURED (#2): only Codex returns a model list at `session/new`. **On five of six vendors brigadier
never learns which model answered.** So "some work to Opus 5, some to gpt-5.6-sol" is not
expressible — brigadier routes to *an agent*, and whatever model that agent is configured with is
what runs.

That is honest and well-documented. It is not what you asked for.

### 2.5 Quota failover has no input signal

**Wanted:** when a provider runs out, move the work.
**Built:** `src/queue/execute.ts:2020` —

```js
quota[agent.id] = agent.id === "opencode" ? "unpriceable" : "unreadable";
```

**Brigadier has never measured a way to read remaining quota on any vendor.** The nearest thing is
ruling 24's two-rung retry ladder, which fires **after** a failure, on a different vendor. That is
reactive, not graceful, and it costs a burnt attempt every time.

One partial exception is in the record: `src/agent/profiles.ts:308` — *"Pre-flight quota is readable
out of band via `codex app-server` account/rateLimits/read (#46)."* One vendor, out of band, unused.

### 2.6 The progress channel is switched off precisely where you sit

**Wanted:** live, concise progress on your screen; nothing in the model's context.
**Built:** `src/report/budget.ts:30` defines three audiences and conflates two independent things —
*who reads it* and *who pays for it*:

| audience | assumption | progress |
| --- | --- | --- |
| `terminal` | a person watches; scrollback is free | streams |
| `acp-client` | an editor renders it | streams |
| `host-session` | a model reads it and pays forever | **hard cap, none** |

`hasInFlightDisplay()` returns `false` for `host-session`, arguing that progress would be
*"paying tokens for an animation nobody watches."*

**You are the nobody.** The streaming renderer exists, works, and is unreachable from the only
configuration you use.

**MEASURED 2026-08-21, and this kills the cheap fix.** The obvious repair is for brigadier to write
progress straight to the screen via `/dev/tty`, bypassing the model entirely — zero tokens, full
visibility. It does not work:

```
subject: child of a CLI tool call    open("/dev/tty") -> ENXIO "Device not configured"
control: same script under a real pty  open("/dev/tty") -> OK, bytes reach the terminal
```

The control fires, so the probe is sound: **a CLI's tool children have no controlling terminal at
all.** `/dev/tty` appears zero times in 345 KB of record — nobody considered it, and it would not
have worked. Recorded as a negative result rather than reworded until it passed.

So progress must travel through the client. MEASURED against the published Claude Code MCP reference
on 2026-08-21, there are two candidates and both need driving before either is designed against:

- **`notifications/progress`** — Claude Code *consumes* them (they reset the per-call idle timer,
  which defaults to 30 minutes for stdio servers). Whether it *displays* them is not stated in the
  official reference, and a third-party incident report claims it does not. **Unmeasured. Do not
  design against it until it is driven.**
- **Channels** — an MCP server declaring the `claude/channel` capability, opted in with `--channels`
  at startup, can push messages directly into a live session. Documented, Anthropic-specific, and it
  lands in context, so it costs tokens.

### 2.7 Brigadier cannot ask you anything — and that is now fixable

**Built:** ruling 25, day one: *"in host-first, brigadier's stdout lands in the model's context, not a
terminal, so brigadier cannot prompt the operator."* Ruling 71 records that this one wall forced
three separate features to become pre-authorised settings instead of questions — the cost threshold
(ruling 23), the secret grant (ruling 65), the role proposal (ruling 71) — and calls it *"a property
of the design rather than a workaround."*

**MEASURED 2026-08-21: it stopped being true on 2026-03-14.** Claude Code 2.1.76 shipped MCP
elicitation. From the official reference:

> *"MCP servers can request structured input from you mid-task using elicitation. When a server needs
> information it can't get on its own, Claude Code displays an interactive dialog and passes your
> response back to the server. **No configuration is required on your side**: elicitation dialogs
> appear automatically when a server requests them."*

And it does not time out under you: *"A call waiting on an open elicitation dialog isn't backgrounded
while the dialog is open; the server is blocked on your input, not slow."*

MCP is currently in issue #1's **Out of scope** list — *"An MCP server — follows from decision 8;
pays a per-session token tax against the token-reduction goal."* That reasoning was aimed at a
multi-tool server. Brigadier needs **one tool**, and it is now the only measured channel by which
brigadier can ask a question. See 3.4.

This machine runs Claude Code 2.1.238, so elicitation is available here today.

### 2.8 The provider list was never in the record

**Wanted:** claude-code, codex-cli, antigravity-cli, cursor-cli, grok-cli, qwen-cli, ollama.
**Built:** claude, codex, copilot, qwen, opencode, gemini.

Across all 345,173 bytes of issue #1 — 73 rulings, every amendment, seven comment threads — the
strings **`ollama`, `grok` and `antigravity` appear zero times.** `cursor` appears eleven times and
never once as an agent brigadier drives; only as a directory that discovers plugins.

All six shipped profiles landed together in the **first source commit**, `ccf438f`, 2026-08-17. The
selection rule was *speaks ACP and was measured on this machine*. Nobody wrote down that this was a
different rule from the owner's.

**And measured on this machine on 2026-08-21, the built set is the better guess:**

| wanted | on this machine |
| --- | --- |
| claude | `/Users/stephen/.local/bin/claude` 2.1.238 |
| codex | `/Users/stephen/.local/bin/codex` 0.147.0 |
| qwen | present, 0.21.13 |
| cursor-cli | **absent** |
| grok-cli | **absent** |
| antigravity-cli | **absent** |
| ollama | **absent** |

| not asked for | on this machine |
| --- | --- |
| copilot | present, 1.0.80 |
| opencode | present, 1.18.18 |
| gemini | present, 0.55.1 |

Three of seven wanted providers exist here. All three unwanted ones do. **This is not drift — it is
a specification that was never taken.**

Ollama is the different case and it is a genuine wall: ruling 9 says *"local models participate only
through an ACP agent that supports them"*, and *"brigadier's own agent loop for raw local models"* is
in **Out of scope**. Ollama has no ACP agent. Ruling 45 did not downgrade your local-model support —
it recorded that no mechanism was ever found. See 3.6.

### 2.9 Research and web-freshness do not appear anywhere

Zero mentions of research, web search, or date-freshness in 345 KB. Not refused, not deferred,
not out of scope. **Absent.** The staleness problem you named — models reaching for 2024 and 2025
when it is 2026 — has no ruling, no ticket and no code.

### 2.10 Configuration is one escape hatch, not a settings file

**Wanted:** highly configurable; a settings file for any of its settings.
**Built:** ruling 71 promised *"three files with three lifetimes"* — per-machine config (roles,
consents, budget defaults, ambient-suppression toggle), state, and per-repo declarative config.

There is no `src/config/`. The only file brigadier reads is
`~/.config/brigadier/bridges.json` (`src/cli.ts:196`), which is ruling 69's bridge-coordinate escape
hatch and nothing else. State exists (`~/.brigadier/detect.json`, run records). **The per-machine
config file and the per-repo config file were specified in a ruling and never built.**

Every knob is a CLI flag today: `--review`, `--workers`, `--max-difficulty`, `--xhigh`, `--verify`,
`--secret-env`, `--audience`. In host-first, a flag is something the *model* has to remember to pass.

### 2.11 "Unslop" is a different discipline from the one that got built

**Wanted:** brigadier's output *to the user* is concise and concrete; it keeps talking normally to its
workhorses.
**Built:** ruling 58's token cap — a hard ceiling of ~2,000 tokens on the host report, with one
property held by test: *the cap can hide a success and can never hide a failure.*

That is **compression, not prose discipline.** It bounds how much you get; it says nothing about
whether what you get reads well. The two are compatible and neither implies the other. The record
contains zero mentions of `unslop`, `slop` or `concise`.

### 2.12 Where "adversarial review" is decided

**Wanted:** brigadier understands whether work needs an adversarial review.
**Built:** `--review` is a flag the caller passes. Ruling 32 makes cross-vendor *preferred, not
required*, and ruling 52 gives the reviewer an exact `git diff`. All of that is good work. **Nothing
decides whether a review is warranted** — a human or a host model does, by typing a flag.

### 2.13 What the verification machinery could not see

Two independent verifiers, 14 bar items, 73 rulings, 1,771 local tests. `BAR.md`'s first line:

> *"v2 is done when every locked ruling that makes a user-visible promise has an item proving it
> holds against the real compiled binary."*

**The bar is defined against the rulings.** Every item asks *does the code match the rulings*. Not
one check in that machinery asks *do the rulings match the owner*. The owner was an input on day one
and never an input again.

So the answer to the uncomfortable question is: the machinery worked. It verified the wrong
specification, faithfully, at real expense, and it had no organ for noticing that. It is also the
only reason this document can cite line numbers instead of guessing — which is worth more than it
sounds, and section 4 spends it.

---

## 3. The rulings to overturn, and what each was protecting

Only the owner can overturn a locked ruling. Each entry names what it was protecting, because the
protection is usually real and usually survives in some other form.

**After the owner's rulings of 2026-08-21, the list is nine and three survive.** To overturn: **20**
(no context window), **25** (the model invokes brigadier), **71** (no `init`), **26** and **42** (no
PATH install), **58**'s audience enum, **19** (work kinds), **31** (effort derivation), **23**
(partially — outcomes may feed competence, cost still may not, D21, and this one moves a
`bun run claims` gate rather than only a document), and **48** / `BAR.md` itself.

Surviving, having each been proposed for overturn and refused: **ruling 9** (no agent loop for raw
local models — D11), **ruling 12** (Windows first class — D10), and the **Out-of-scope MCP
exclusion** (D13 — exit-and-resume needs no new transport, works on all six vendors where MCP is
measured on one, and is closer to what the owner described). Ruling 8 is untouched throughout, and
ruling 27 holds where it reaches. 3.4 below is kept as the record of an argument that was made and
did not survive.

### 3.1 Ruling 20 — "brigadier's orchestrator has no context window"

**Protecting:** deterministic, debuggable orchestration, and a real insight — that published
LLM-harness advice (compaction, pruning, memory ledgers) assumes an LLM orchestrator and does not
apply to a pipe.

**What must change:** `research` and `plan` become work kinds, routed to a workhorse exactly as
`write` is today.

**What it costs:** a planning turn before any work starts — money and latency on every request,
including the ones where you already knew the plan. Keep `brigadier plan` as the show-me-first path.

**Cheaper than it looks.** Ruling 20's literal text survives: the binary still holds no context
window. It drives a planner agent the same way it drives a builder. The clone-per-item, marker, lane,
merge, report and cost machinery all apply unchanged. **What dies is the consequence everyone drew
from it** — that brigadier takes a plan rather than making one.

### 3.2 Ruling 25 — "The model invokes brigadier; the human does not"

**Protecting:** the recognition that brigadier cannot prompt or render progress, which correctly
forced three features into pre-authorised settings.

**What must change:** the direction inverts. Brigadier drives; the host session becomes brigadier's
face — its voice and its ears.

**What survives:** brigadier still cannot prompt *directly*. It asks through MCP elicitation, and the
client puts the question to you. That is ruling 25's own escape hatch — *"or relayed by the model"* —
finally having a mechanism.

**What it costs:** the terminal entry point stops being *"a power-user and debugging surface"* and
becomes a supported path, which is more surface to document and hold.

### 3.3 Ruling 71 — "There is no `init`"

**Protecting:** v1's `init` — 1,503 lines, CLI dispatch and report renderer and proposal prompts and
composition root in one file, *"the single file that made that codebase hard to work in."*

**Overturn narrowly.** Ruling 71's argument is that an *interactive propose-flow* has nobody to talk
to. That is true and can stand. It does not cover a **non-interactive** setup: detect, write config,
print what was found, exit. That needs no interlocutor.

**The real defect is not the refusal — it is that ruling 71 refused the interactive version and then
behaved as though the whole category was closed.** Its own accepted cost says so: *"no `init` means
no guided setup and someone will want one."*

**What it costs:** a second entry point to keep correct, and a standing temptation to grow it back
into 1,503 lines. Cap it: setup writes files and prints; it never asks and never runs work.

### 3.4 Out of scope — "An MCP server" — PROPOSED AND REFUSED (D13)

**The owner refused this overturn on 2026-08-21 and was right to.** The argument below was made
before exit-and-resume was compared against it properly, and it does not survive that comparison:
elicitation is measured on Claude Code alone while exit-and-resume works on all six vendors, MCP's
one clear advantage is a progress path nobody has driven, and a dialog box is further from *"the
model raises it"* than a model raising it. The section is kept rather than deleted, because an
argument that was made and lost is worth more on the map than a gap where it used to be. What follows
is unchanged.

**Protecting:** ruling 8 (own directories only) and a per-session token tax against ruling 21's
token-reduction goal.

**What must change:** brigadier ships an MCP server exposing **one** tool.

**Why the protection does not apply:** the tax was reasoned against a multi-tool server. One tool
definition is comparable to the skill description already sitting in every session, and it buys the
only measured channel by which brigadier can ask a question — elicitation, shipped in Claude Code
2.1.76 on 2026-03-14, no configuration required.

**What it costs:** a second distribution surface beside the plugin, a protocol-revision dependency,
and per-vendor variance. Measured on Claude Code; **unmeasured on Codex, qwen, opencode, gemini and
copilot.** A channel that works on one vendor is not a product.

### 3.5 Rulings 26 and 42 — "no separate PATH install", "no `bin/` outside Claude Code"

**Protecting:** ruling 8. v1's worst defect was a write into a file another product owned.

**What must change:** `brigadier setup` installs a launcher shim on `PATH`.

**Why the protection survives:** a shim in brigadier's own directory, added to `PATH`, writes no
foreign file. Ruling 8 is untouched. What is overturned is the narrower claim that no PATH entry is
needed — which was true only while brigadier was a skill nobody launched.

**What it costs:** uninstall stops being *"delete the directory"*. Ruling 26 leans on that promise
explicitly.

### 3.6 Ruling 9 and Out of scope — "brigadier's own agent loop for raw local models"

**Protecting:** brigadier never speaks to a raw model and never grows an agent loop — the thing that
would turn a hub into a competitor of everything it drives.

**This is the ruling that blocks Ollama**, and it is the strongest of the ones on this list. Ollama
serves raw models. There is no ACP agent in front of it, so under ruling 9 it can never participate.

**Three ways out, in ascending cost:** wait for someone else to ship an ACP bridge for Ollama;
drive an installed CLI that already speaks to Ollama; or write the loop. The third overturns the
ruling for real, and it is a different product.

**RULED BY THE OWNER 2026-08-21 (D11): leave ruling 9 locked, cut Ollama from v0.1.** It is the
single most expensive item on the owner's list and the only one that changes what brigadier *is* —
the moment brigadier has its own loop it stops being a hub that drives your agents and becomes a
competitor to them, carrying its own prompting, context management and tool protocol against every
model it touches. Ruling 20's real insight was that a pipe needs none of that.

### 3.7 Ruling 58 and the `Audience` enum

**Protecting:** a real and well-defended property — *the cap can hide a success and can never hide a
failure* — which should not be touched.

**What must change:** the enum conflates *who reads it* with *who pays for it*. It needs a fourth
state: a human watching a session a model is also sitting in.

**What it costs:** every progress byte in that state is paid for twice — once by the model's window,
once by the user's attention. That is the price of `/dev/tty` not working, and it is why every
progress line has to earn its place.

### 3.8 The smaller ones

- **Ruling 19** — work kinds are `write | read-only`. Amend to add `research` and `plan`.
- **Ruling 31** — effort derived from `(kind, difficulty)`. Needs a rule for the two new kinds.
- **Ruling 27** — hooks only inside a directory brigadier owns. On Claude Code, `UserPromptSubmit`
  goes in brigadier's own `hooks/hooks.json` and this ruling is **not** disturbed. Elsewhere there is
  no owned hooks file, so possession needs the shim. Ruling 27 holds; it just does not reach.
- **Ruling 48 / `BAR.md`** — the bar is defined against the rulings. It needs one item that tests
  against the owner, or 2.13 happens again.

### 3.9 What survives untouched, and is worth what it cost

Not a consolation. This is the reusable half, and it is most of the engineering:

clone-per-item isolation and run directories outside every temp root (7, 13, 61, 64) · the lane as an
approval channel and the neutered git hooks (43, 34, 56) · integration by fetch-not-push with the
operator's repository byte-identical afterwards (50, 51) · the command-line marker and the sweep
(38, 63) · the worker's refusal to orchestrate, on all three of finding 114's routes (57, 59) ·
two-step detection and drift graded by blast radius (41, 69) · secret redaction at exactly one sink
(65) · the cost model as a range with two ceilings and no savings claim (66, 67, 70) · the effort
ceiling at `high` with `xhigh` as a declared per-item exception (30, 31) — **this one matches your
stated wish exactly** · the competence table auditable from the binary (68) · the licence gate and
the LGPL relink obligations (47, 72) · and ruling 58's core property, that a cap may hide a success
and may never hide a failure.

**Six rounds were not wasted.** They built the half that is hard to get right and impossible to
retrofit. What they did not build is the half that makes it a product.

---

## 4. The shortest path to something a stranger can install and use

Ordered. Each step is checkable. What gets cut is named at the bottom, not buried.

**1. `brigadier setup`.** Non-interactive. Detects, writes `~/.config/brigadier/config.json`, writes
the plugin asset, installs the shim on `PATH`, prints what it found and ruling 71's four unlearnable
things. Overturns 3.3 and 3.5. *Checkable: a fresh machine, one command, and `brigadier detect`
agrees with what setup printed.*

**2. Possession on Claude Code.** Add `UserPromptSubmit` to brigadier's own `hooks/hooks.json`.
Already below the build gate's hook floor. *Checkable: start `claude`, type a goal, and brigadier
engages without being named.*

**3. A goal entry point.** `brigadier run --goal "<sentence>"` beside `--plan <path>`.
*Checkable: a sentence in, a run out, no plan file authored by hand.*

**4. `plan` and `research` as work kinds.** Routed to a workhorse like any other. Overturns 3.1.
*Checkable: the plan file exists at `~/.brigadier/r/<run-id>/plan.json`, the session got one line
naming it, and the operator's repository is byte-identical — which item 4 already asserts.*

**5. Exit-and-resume for questions** (D13, D14, D15). Brigadier drains, exits with the question and
its state; the model raises it; `brigadier resume` continues. Reuses ruling 63's interrupt path.
Overturns nothing. *Checkable: a run stops for an answer, holds no live process, keeps every clone
with committed work, and resumes onto the same integration ref.*

**6. Progress.** The one genuinely unmeasured step. `/dev/tty` is dead (2.6), and MCP
`notifications/progress` is unmeasured for display and now off the critical path anyway (D13). What
remains for v0.1 is chunked — each exit and each resume returns a short block. **Drive it before
designing it.** `/dev/tty` is what happens when you don't.

**7. One bar item that tests against the owner.** A page in the owner's words, and an item that fails
when the product stops matching it. Without this, 2.13 recurs.

### What gets cut to get there

- **Ollama and raw local models** (D11). Ruling 9 stands. The one item on the owner's list that is
  free at the point of use is the one that cannot be had, and every run spends metered quota. The
  follow-up measurement — whether any of the six installed agents can be pointed at ollama's
  OpenAI-compatible endpoint, which would *satisfy* ruling 9 rather than overturn it — is worth
  running afterwards. Ruling 45 is the record of that same question coming back empty once already,
  so it is a measurement and not an assumption.
- **cursor-cli, grok-cli, antigravity-cli.** Not installed on the owner's own machine, absent from
  345 KB of record, and no measured ACP surface. Name them in the README as not supported and let the
  six measured profiles ship.

**NOT cut — Windows (D10).** 63 distinct failing tests at run `32488134420`, clustered rather than
scattered: roughly half are the ruling 38/63 containment family — the sweep, orphan reclamation,
grandchild kill, the marker filter, ruling 63's drain reaching a process that reparented to pid 1.
Some of those are fixtures escaping under `setsid`, which does not exist on Windows (or macOS — item 7
is already amended for it); the rest sit on the Windows-only branch the README records as never having
executed anywhere. `OWNER-QUESTIONS.md` #12 records a whole run **35–160× slower** on
`windows-latest` and #18 records the detection cache's `size:mtime` fingerprint colliding on two
writes a millisecond apart, granularity unmeasured. #13 already found one root cause — backslashes in
a command path — that explained a dozen inert negative controls at once, so **63 tests is likely four
or five causes, not sixty-three.**

This stays in because the owner has a Windows machine carrying the project and a working Claude Code,
so it is a backlog on a real host rather than five more days of writing Windows code blind. Two things
to check on arriving there: **what is actually checked out** (a clone predating `gauntlet/next`
debugs a different artifact, and `AGENTS.md` records a `core.autocrlf=true` clone failing the licence
check while byte-identical to HEAD), and that **`build` now runs before `test-gate`**, so a broken
build there yields no test signal at all.

- **macOS CI**, for now. 4 failures in the same run, one of them a 62-second fixture. Fix the two;
  don't gate v0.1 on the leg being green.
- **Cross-vendor possession.** All four mechanisms are measured on Claude Code and none on the other
  five. **v0.1 possesses Claude Code; everywhere else keeps today's skill and says plainly that the
  trigger is model discretion** — which is what `SKILL.md` already says.
- **Quota-aware failover.** No vendor exposes readable quota except Codex, out of band. **Ship
  ruling 24's reactive ladder and stop calling it graceful.**
- **Model-level routing.** Five of six vendors never reveal which model answered. **"Some work to
  Opus, some to GPT" is not expressible today** — brigadier routes to an agent. Say so.
- **The tag.** Two verifiers have ruled BAR NOT MET. Neither verdict is wrong and neither is about
  the divergence in this document. **v0.1 ships as pre-release, or the bar is rewritten first — and
  rewriting a bar to fit what you built is the one move this whole repository exists to prevent.**

### The single decision that gates everything

Steps 3, 4 and 5 are the product. Steps 1 and 2 are the door. **Step 6 is unmeasured**, and it is the
one your description leans on hardest — *"the user sees unslopped, concise, concrete output."*

Measure step 6 first. It is half an hour and it decides whether the progress design is real or
another `/dev/tty`.
