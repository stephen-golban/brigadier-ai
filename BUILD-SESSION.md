# Build session: the product correction

Written 2026-08-21 at the end of the owner-intent session. **This supersedes `NEXT-SESSION.md`**,
which points the gauntlet at `BAR.md` and is now the wrong map: the bar is not what changed, the
product is.

**UPDATED 2026-08-22 at the end of build session 2. TRACK A IS COMPLETE — steps 0–10 are done and
committed.** What a new session needs is *State*, *What Track A bought*, and *What is left*.
Everything measured is under the two **Measured in** sections — do not re-derive any of it.

## What happened, in one paragraph

Six rounds of a gauntlet process produced a repository, two independent verifier reports, 73 locked
rulings and no tag. The owner opened a session to ask whether the thing being verified was the thing
he wanted. It was not. **Ruling 20 — "brigadier's orchestrator has no context window" — was locked on
day one and is why brigadier cannot plan**; `BAR.md`'s coverage table filed it as *"architectural
exclusion — no user-visible promise"*, so no item ever tested it and nobody looked at it again. The
built product is an excellent plan *executor*. The owner wants a plan *maker* that possesses whatever
CLI session he starts. `PRODUCT.md` is the full account and 24 owner decisions.

## Read these, in this order

1. **Issue #1** — `gh issue view 1 --repo stephen-golban/brigadier-ai` and `--comments`. The canonical
   record, now ~440 KB and 88 rulings. Reading only the body gets you half the map. **The three newest
   comments are build session 2's** and are where the current product lives.
2. **`AGENTS.md`** — governs everything. It gained one section in session 2: what brigadier says to a
   person (D24).
3. **`PRODUCT.md`** — section 0 is the 24 owner decisions and section 1 is what `BAR.md` item 15 now
   grades against. Section 4's build order is **complete**; section 2's account of the divergence is
   history rather than a to-do list.
4. **`BAR.md`** — **fifteen** items now. Item 15 is the one that tests the product against the owner,
   and it is the only one that PASSes today.

## State

- Worktree `/Users/stephen/Development/brigadier-v2-gauntlet-build`, branch `gauntlet/next`, **locked**.
  Main lives at `/Users/stephen/Development/brigadier-v2`.
- Tip is `7c4a424` (item 15). **Not pushed** — a push starts a ~53-minute three-platform gates run.
- `bun test`: **2,033 pass, 0 fail, 0 skipped**, 108 files, ~265 s, MEASURED 2026-08-22 on darwin.
- `bun run gates`: **all four green** at that tip (typecheck → build → test-gate → claims, 88 rulings).
- **`BAR.md` item 15 drives PASS on both halves** against the compiled binary, with a demonstrated
  negative — and FAILs against both forgers in `bar/fakes.test.ts`.
- **Rulings 74–82** are `issuecomment-5373310146`; **83–84** are `issuecomment-5374870012`; **85–88**
  are `issuecomment-5377224146`. `BAR.md`'s coverage table carries a row for every one.
- Local `main` is far behind and left alone deliberately.
- CI at the last completed run `32488134420`: **63 distinct Windows failures, 4 macOS failures.**
  Every `gates` run in the repository's history has failed. **Nothing in build session 2 addressed
  that**, and item 15 adds a fifteenth way to be not-met.
- `gauntlet/build`, `ci`, `verify-2`, `verify-3` are all ancestors of `gauntlet/next`. **`verify-2`
  points at the same sha as `build` and marks nothing of its own.**

## What Track A bought, in one paragraph

A person installs one binary, runs `brigadier setup`, starts `brigadier claude`, types a goal in
English, is asked before anything unrequested is spent, answers in the same session, and gets back a
path to a plan they never wrote — made against facts dated today, with the items spread across the
vendors on their machine. That is `PRODUCT.md` section 1, working, and `BAR.md` item 15 is what goes
red if any of it stops being true.

## THE ONE THING THAT NEEDED THE OWNER IS RESOLVED

Build session 1 handed over an open credential decision. **It is ruled — ruling 83, under delegation,
on measurements taken the same day.** `brigadier does not copy credentials`, and it costs nothing here:
MEASURED that the Claude credential is in the login Keychain, so seeding `.claude.json` AND the
Keychain item written out as `.credentials.json` both still fail `session/prompt`. The redirect was
replaced on that vendor by `--setting-sources=project,local` through `CLAUDE_CODE_EXECUTABLE`, which
suppresses the operator's user-global files and keeps the metered call. **Every run now works with
`ambientSuppression` at its default.**

## Track A — steps 0–10, all DONE, in these commits

```
b53e36c  BAR.md coverage rows 74-82, and ruling 20's row rewritten
a816b89  step 1 settings file + step 2 `brigadier setup` and the shim
f3a3ade  step 3 possession: UserPromptSubmit + `brigadier claude`
57e3198  ruling 78's web-reach column, measured on three vendors
5567896  step 4 `--goal`: a sentence in, a plan out
6f5e4b1  ruling 83 — the credential is not a file; the lever moves to the argv
f24888f  step 5 `plan` and `research` work kinds, and D22's dated finding
8673b4d  step 6 exit-and-resume: a question leaves the process
b9ef45c  step 7 D24's line form, and ruling 80's fourth audience
582a392  step 8 the router stops being `agents[0]`
9acad23  step 9 failover and the review clamp
7c4a424  step 10 BAR.md item 15 — the organ the process did not have
```

**Rulings 74–88 are all posted.** Nine were the owner's own; 77, 78 and 82 were delegated in the
owner-intent session; 83 and 85–88 were delegated on 2026-08-22 (*"please take this decision
yourself"*), and 84 is the owner's own call between two readings of ruling 78.

## What is left, and where to start

**Nothing in Track A. The backlog is what `BAR.md` gates on, and none of it is new:**

1. **Track B — Windows.** 63 distinct failures at run `32488134420`, on the owner's own Windows
   machine. Unblocked since step 5 and now fully unblocked: the files it touches have stopped moving.
   Two things to check on arriving: **what is actually checked out** (a clone predating `gauntlet/next`
   debugs a different artifact, and a `core.autocrlf=true` clone was MEASURED failing the licence check
   while byte-identical to HEAD), and that **`build` now runs before `test-gate`**, so a broken build
   there yields no test signal at all.
2. **macOS CI** — 4 failures in the same run, one a 62-second fixture.
3. **Item 5's catch rate** — 2 of 5 against a required 3 of 5, and the cross-vendor review has not been
   run. This is the one both verifiers named.
4. **The measurements listed as still open** in `issuecomment-5377224146`: web reach on qwen and
   gemini, whether a metered call survives the redirect on copilot and opencode, ambient suppression on
   Linux, and the progress mechanism.

**Do not start any of these by writing code.** Every one is a measurement or a platform this session
could not reach, and three of the four are on a machine this session does not have.

## Measured in build session 2, 2026-08-22 — do not re-derive these

All against `claude 2.1.238` and `@agentclientprotocol/claude-agent-acp 0.70.0` on macOS 26.5.2. Every
row names its control.

- **The config-root redirect breaks the Claude bridge at `session/prompt`, one call past where anybody
  looked.** `session/new` OK, `session/prompt` `-32000 Authentication required`, against a no-redirect
  control that answered. **`RULING-38-AMENDMENT.md`'s table stopped at `session/new`** — so copilot's
  and opencode's `usable` rows there are not evidence about a metered call either, and that is now an
  open measurement rather than an assumption.
- **Seeding does not repair it.** `.claude.json` seeded with `oauthAccount`/`userID`, then the login
  Keychain item written out as `.credentials.json`, then a BYTE COPY of the whole `~/.claude.json`:
  all three still failed. **The credential is in the login Keychain**, which `CLAUDE_CONFIG_DIR` does
  not move — so seeding is not a mechanism that exists for this vendor on this platform.
- **`--setting-sources=project,local` suppresses the operator's user-global `CLAUDE.md` and keeps the
  credential.** Driven through the real bridge with the argv captured from a shim: the control (no
  shim) had the planted nonce in its answer; the subject did not, and the turn completed.
- **The bridge passes `--setting-sources=user,project,local`**, which issue #1 recorded on 2026-08-17
  and called *"a mechanism for decision 17"*. Unused for five days.
- **A fresh `HOME` logs `claude` out.** `Not logged in · Please run /login`, exit 1, against a
  real-`HOME` control that answered and exited 0. This is why `BAR.md` item 15 runs its two halves under
  two environments, and it is a property of the item rather than a compromise.
- **A first framing of the ambient probe tripped a model fallback** (the word *passphrase*, read as
  cyber content) and was discarded rather than reported: a negative that arrives together with a model
  substitution is not a clean negative. The kept pair uses neutral wording.

## Traps — the first three were paid for in build session 1, the rest are new

- **Read the GATE's own exit line, not the wrapper's.** `bun run gates > log; echo "EXIT=$?"` reports
  the *echo*'s success. Grep the log for `gate passed` and `gate FAILED`.
- **Run the whole suite, not the files you touched.** Step 3 was reported working on two green test
  files while eight existing guards disagreed.
- **A guard that pins the behaviour you are changing is updated with the SAME rigour, never loosened.**
  Build session 2 rewrote three suppression guards and the bar's item-count guards this way; each got
  a new assertion, not a weaker one.
- **`session/new` is not evidence about `session/prompt`.** The whole of ruling 83 is one call further
  down a table that stopped too early. If a measurement's subject is a metered call, drive a metered
  call.
- **A bar item that needs new product surface to grade itself is designing the product around the
  harness.** Item 15's launcher assertion was rewritten to plant a fake vendor and read the argv, rather
  than asking for a `--dry-run` flag that existed for the test's benefit.
- **A check that passes for the wrong reason is worse than one that fails.** Item 15's first launcher
  check asserted the subcommand was *recognised* while driving a flag that does not exist — green, and
  measuring nothing.
- **Refuse before you spend.** With `--goal` this now includes asking: the question fires before the
  base commit, before the repo map, before a clone.
- **`bun run claims` is a full-tree scan** and is the only check not scoped to changed files. It caught
  `bar/lib/contract.ts` omitting the two new work kinds.
- **Adding a production dependency means running `bun run licenses` in the same commit.**
- **Never put delegation doctrine in `AGENTS.md`.** Ruling 59.

## Measured in build session 1, 2026-08-21 — do not re-derive these

All against `claude 2.1.238`, `codex-cli 0.147.0`, `copilot 1.0.80`, `opencode 1.18.18` on macOS
26.5.2. Every row names its control, including the one whose control did not fire.

- **`claude --brigadier` exits 1** with `error: unknown option '--brigadier'`; `claude --help` exits 0.
  Reasoning became measurement.
- **Four injection flags exist**, discriminated by the fact that a real option missing its argument
  reports `argument missing` while an invented one reports `unknown option` (the control fires):
  `--append-system-prompt-file`, `--system-prompt-file`, `--settings`, and **`--plugin-dir <path>`,
  which loads a plugin *for that session only* and appears nowhere in 345 KB of record.**
- **`UserPromptSubmit` possession works, driven.** A hook-injected identity instruction produced
  `brigadier: planning` from a session never told brigadier's name; the no-hook control answered
  `NONE`. Against a real repository, a possessed session reached for `brigadier run --goal` unprompted
  where the control read files instead.
- **A model discounts hook-injected text framed as a secret**, and says so unprompted. Possession is
  unaffected (identity and state travel fine); what does not travel is *trust in a secret's
  provenance*, which is ruling 65's territory. n=1, one framing.
- **`Hooks (2)  PreCompact, UserPromptSubmit`** — captured from `claude plugin details brigadier` with
  the asset installed. This is ruling 60's silent total-discard failure mode **observed not
  happening**, and it is why the fixture in `test/plugin-hooks.test.ts` is captured rather than
  hand-written.
- **Web reach, ruling 78's column:** claude, copilot and opencode all returned the exact 40-hex
  `dist.shasum` of bun's current npm release, matching an independent `curl`. Control fires — asked for
  the same value from memory with no tool, the answer was `UNKNOWN` — so a match proves retrieval, and
  a 40-hex match cannot be luck. **Copilot BLOCKS loopback** (`WebFetchBlockedUrlError`), so a
  localhost-token probe would have written `reachesWeb: false` for a vendor that reaches the public web
  perfectly well. **codex, gemini and qwen are unauthenticated here, so their reach could not be driven
  at all** — a fact about the measurement, not about the vendor.
- **`codex --search` exists** — *"Enable live web search"* — while the built-in default is **cached
  snippets**, which is exactly what D22's dated-finding rule exists to defeat. This is why web reach is
  a launch-profile column and not a ruling 53 capability: a boolean requirement cannot pass an argv flag.
- **macOS `/etc/paths` excludes `~/.local/bin`.** There is no zero-edit route onto `PATH` on a fresh
  Mac; where it is on `PATH` a shell profile put it there. The owner's `~/.zshrc` already carries
  **seven** `PATH`-touching lines, several in installer-written delimited blocks (`# pnpm` … `# pnpm end`).
- **What the CLI probes measure is an UPPER BOUND on the ACP worker channel.** If a vendor's CLI cannot
  reach the web its worker certainly cannot; the converse does not follow, and ruling 53 calls
  conflating them *"the research-in-measurement's-clothes error"*. The ACP-channel measurement has not
  been taken.

## Measured in the owner-intent session — also do not re-derive

- **`/dev/tty` is unreachable from inside a CLI tool call.** `ENXIO`, "Device not configured". The
  same probe under a real pty opens and delivers, so the control fires and the probe is sound: a
  CLI's tool children have **no controlling terminal**. This kills free zero-token progress. It
  appears zero times in 345 KB of record.
- **MCP elicitation shipped in Claude Code 2.1.76 on 2026-03-14.** *"No configuration is required on
  your side."* A call waiting on the dialog is not backgrounded. **Not adopted** (D13) — exit-and-
  resume works on all six vendors where this is measured on one.
- **`UserPromptSubmit` can inject context via stdout**, and is already in `FLOOR_HOOK_EVENTS` while
  `REGISTERED_HOOK_EVENTS` is `["PreCompact"]`. Pre-approved by this repository's own build gate,
  unused.
- **`claude --brigadier` cannot exist.** The real mechanisms are `--append-system-prompt-file`,
  `--system-prompt-file`, `--settings`, reached through a shim on `PATH`.
- **Installed here:** claude 2.1.238, codex 0.147.0, qwen 0.21.13, copilot 1.0.80, opencode 1.18.18,
  gemini 0.55.1. **Absent:** cursor-cli, grok-cli, antigravity-cli, ollama. Of the seven providers
  the owner named, three are installed; all three he did not name are.
- **`ollama`, `grok`, `antigravity` appear zero times in issue #1.** `cursor` appears eleven times and
  never as an agent brigadier drives.

## Boundaries

**No tag. No merge to main. `gauntlet/verify-3` does not move. Nothing is pushed** — a push starts a
~53-minute three-platform gates run, and build session 2 did not take that decision.

The two verifier BAR NOT MET verdicts stand and **none of Track A addresses them** — item 5's 2-of-5
catch rate, the unrun cross-vendor review, and red CI are a separate backlog and still the one
`BAR.md` gates on. **Item 15 adds a fifteenth way to be not-met**, which is what it is for.

## Still open

Six measurements and one judgement, all listed in `issuecomment-5377224146` and none of them a blocker
for the work that is built:

1. **The exploration floor's size** (ruling 81) — shipped as a settings default of 0.2, anchored on the
   map's own five-agent ceiling (*one slot in a maximal wave*), printed beside every ranking it
   protects. Still a judgement and still the owner's.
2. **Web reach on qwen and gemini**, and whether Codex's `web_search` survives ruling 49's sandbox
   modes. The probe's shape is specified in ruling 78 and has been run for three vendors.
3. **Whether a metered call survives the config-root redirect on copilot and opencode** — new, and it
   is ruling 83's row 2 pointed at the vendors nobody drove past `session/new`.
4. **Ambient suppression on Linux.** The argv lever is measured on darwin; Linux inherits it unmeasured.
5. **The progress mechanism** (ruling 80). Chunked for v0.1 and named as unmeasured where it is adopted.
6. **Whether `run` should trust the detection cache** — `DETECTION-CACHE.md`'s one open `[owner]`
   question, untouched.
