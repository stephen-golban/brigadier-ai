# Build session: the product correction

Written 2026-08-21 at the end of the owner-intent session. **This supersedes `NEXT-SESSION.md`**,
which points the gauntlet at `BAR.md` and is now the wrong map: the bar is not what changed, the
product is.

**UPDATED 2026-08-21 at the end of build session 1.** Step 0 and Track A steps 1–4 are done and
committed; the plan below is otherwise unchanged and still the map. What a new session needs is the
*State* and *Done* sections, then step 5. Everything this session measured is under **Measured in
build session 1** — do not re-derive any of it.

## What happened, in one paragraph

Six rounds of a gauntlet process produced a repository, two independent verifier reports, 73 locked
rulings and no tag. The owner opened a session to ask whether the thing being verified was the thing
he wanted. It was not. **Ruling 20 — "brigadier's orchestrator has no context window" — was locked on
day one and is why brigadier cannot plan**; `BAR.md`'s coverage table filed it as *"architectural
exclusion — no user-visible promise"*, so no item ever tested it and nobody looked at it again. The
built product is an excellent plan *executor*. The owner wants a plan *maker* that possesses whatever
CLI session he starts. `PRODUCT.md` is the full account and 24 owner decisions.

## Read these, in this order

1. **`PRODUCT.md`** — the map for this session. Section 0 is the 24 decisions; section 3 is the nine
   rulings to overturn with what each was protecting; section 4 is the build order.
2. **`AGENTS.md`** — governs everything, unchanged.
3. **Issue #1** — `gh issue view 1 --repo stephen-golban/brigadier-ai` and `--comments`. Still the
   canonical record. ~345 KB. Reading only the body gets you half the map.
4. `BAR.md` only as needed. Fourteen items, still valid, still not met.

## State

- Worktree `/Users/stephen/Development/brigadier-v2-gauntlet-build`, branch `gauntlet/next`, **locked**.
  Main lives at `/Users/stephen/Development/brigadier-v2`.
- Tip is `5567896` (`--goal`). **Not pushed** — a push starts a ~53-minute three-platform gates run.
- `bun test`: **1,886 pass, 0 fail, 0 skipped**, 102 files, ~266 s, MEASURED 2026-08-21 on darwin.
- `bun run gates`: **all four green** at that tip (typecheck → build → test-gate → claims, 82 rulings).
- **Rulings 74–82 are posted** to issue #1 as `issuecomment-5373310146`, and `BAR.md`'s coverage table
  carries rows for all nine.
- Local `main` carries 2 `NEXT-SESSION.md` commits and is 48 behind `gauntlet/next`. `origin/main` is
  0 ahead, 78 behind. Left alone deliberately.
- CI at the last completed run `32488134420`: **63 distinct Windows failures, 4 macOS failures.**
  Every `gates` run in the repository's history has failed.
- `gauntlet/build`, `ci`, `verify-2`, `verify-3` are all ancestors of `gauntlet/next`. **`verify-2`
  points at the same sha as `build` and marks nothing of its own.**

## Step 0 — DONE 2026-08-21

Rulings **74–82** are posted: <https://github.com/stephen-golban/brigadier-ai/issues/1#issuecomment-5373310146>.
Nine overturns — 20, 25, 71, 26+42, 19, 31, 58, 23 (partially), 48 — each with its reason and its
accepted cost, plus a register of the six owner decisions no overturn carries (D6, D8, D9, D17, D18,
D19) which become rulings with the code that implements them.

**Two questions the 24 decisions did not cover were delegated to the coordinator and are ruled inside
that comment**, each on measurements taken the same day: how the shim reaches `PATH` (ruling 77 — it
does not edit your shell profile by default) and whether `research` needs a fourth requirement term
(ruling 78 — no; web reach is a launch-profile column, because on Codex it is an argv flag and a
boolean cannot pass a flag).

The original instruction, kept because it is why the ordering matters:

**Post the rulings to issue #1.** The 24 decisions in `PRODUCT.md` section 0 are decisions, not
rulings. Nine locked rulings need overturning (section 3). Until that comment exists, every source
file citing ruling 20 or 25 cites something the product no longer obeys, and `bun run claims` will
start failing on exactly that.

The repository's own convention for this: each ruling carries its reason and its accepted cost, and a
ruling taken under delegated authority says so in its opening line.

## Track A — steps 1–4 are DONE, in these commits

```
b53e36c  BAR.md coverage rows 74-82, and ruling 20's row rewritten
a816b89  step 1 settings file + step 2 `brigadier setup` and the shim
f3a3ade  step 3 possession: UserPromptSubmit + `brigadier claude`
57e3198  ruling 78's web-reach column, measured on three vendors
5567896  step 4 `--goal`: a sentence in, a plan out
```

**What a stranger can now do:** install one binary, run `brigadier setup`, start `brigadier claude`,
type a goal in English, and get back a path to a plan they never wrote. That is `PRODUCT.md`
section 1's first four sentences, working.

**Step 5 is partly landed already.** The planner is driven as a `read-only` worker through the
existing machinery (`src/plan/commission.ts`), which is ruling 74's central claim made real — no new
isolation model, no new lane policy, no new spawn path. What is left of step 5 is naming `plan` and
`research` in `WorkKind`/`KIND_CONTRACT` and building `research` with D22's dated-finding rule.

## Then Track A, in order

1. ~~**Settings file.**~~ DONE — `src/config/config.ts`, `test/config.test.ts`. None exists today — only `~/.config/brigadier/bridges.json`, which is ruling
   69's bridge escape hatch. Ruling 71 specified three config layers and only *state* was built.
   Everything below needs somewhere to live.
2. ~~**`brigadier setup`.**~~ DONE — `src/setup/setup.ts`, `src/setup/shim.ts`. Non-interactive, and
   capped: it writes files and prints, never asks and never runs work.
3. ~~**Possession.**~~ DONE — `src/plugin/possess.ts`, `src/setup/launch.ts`. `UserPromptSubmit` is
   registered and `brigadier claude` injects with `--plugin-dir` + `--append-system-prompt-file`.
4. ~~**`--goal "<sentence>"`.**~~ DONE — `src/plan/planner.ts`, `src/plan/commission.ts`.
5. **`plan` and `research` work kinds.** Overturns rulings 20 and 19. Research carries D22's date rule.
   **START HERE.** `WorkKind` is still `"write" | "read-only"`; `KIND_CONTRACT` needs a row for each
   new kind and every field answered, because that constant exists so a caller cannot implement half a
   kind. `research` can route to **claude, copilot and opencode** — see the web-reach column — and must
   refuse elsewhere saying *unmeasured on this agent*, which is a different sentence from *unsupported*
   and a different remedy.
6. **Exit-and-resume.** D13–D15. Reuses ruling 63's interrupt drain.
7. **One-line progress and the report shape.** D24.
8. **Router.** Best-of-available, spread across vendors, outcome learning with an exploration floor.
   D20, D21. **This one moves a `bun run claims` gate**, so the gate and the ruling change together.
9. **Failover and the review clamp.** D8, D9, D17, D18, D19.
10. **The section-1 bar item.** D23.

**Track B — Windows** starts after step 5, on the owner's Windows machine, once the files it touches
stop moving. Two things to check on arriving there: what is actually checked out (a clone predating
`gauntlet/next` debugs a different artifact, and a `core.autocrlf=true` clone was MEASURED failing the
licence check while byte-identical to HEAD), and that **`build` now runs before `test-gate`**, so a
broken build there yields no test signal at all.

## THE ONE THING THAT NEEDS THE OWNER BEFORE STEP 5 LEANS ON IT HARDER

**Under decision 17's default, workers on this machine cannot do paid work at all.**

`RULING-38-AMENDMENT.md` measured the config-root redirect logging Codex and Qwen out at
`session/new`, and recorded the Claude *bridge* as unaffected — but its table stopped at
`session/new`. MEASURED 2026-08-21 by driving `--goal`: **the Claude bridge opens a session under the
redirect and then fails at `session/prompt` with `-32000 Authentication required`**, which is the
METERED call. `isCredentialRefusal`'s own note in `src/agent/worker.ts` already records that
*"`session/new` does not prove a credential works; for this vendor only a prompt does"* — this is that
fact meeting the ambient-suppression redirect.

So every real run today needs `"ambientSuppression": false` in `~/.config/brigadier/config.json`.
That is decision 17's own owner-facing override and it is honoured rather than worked around: the
refusal names it, and says out loud that brigadier will not copy a credential to avoid it.

**The open decision is the owner's and is untaken:** whether to seed a credential into a run-scoped
directory a worker can write to. `RULING-38-AMENDMENT.md` reserves it explicitly — *"copying an
operator's credential into a run-scoped directory a worker can write to is a decision about a
credential boundary and belongs to the owner"* — and measured that seeding `auth.json` alone fixes
Codex. **Do not take it in a build session.** It is worth a ruling before step 5, because `research`
and `plan` both spend metered turns on the same path.

This very likely explains part of why both verifier reports read as they do.

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

## Traps — the first three were paid for in build session 1

- **Read the GATE's own exit line, not the wrapper's.** `bun run gates > log; echo "EXIT=$?"` reports
  the *echo*'s success to a background-task notification. Gates failed twice while the notification
  said exit 0. Grep the log for `GATES EXIT` and `test gate passed`.
- **Run the whole suite, not the files you touched.** Step 3 was reported working on two green test
  files while eight existing guards disagreed with the change. They were guards pinning *"exactly one
  hook event"* — correct until that moment.
- **A guard that pins the behaviour you are changing is updated with the SAME rigour, never
  loosened.** Two of them got stronger in the process, and `test/repomap-binary.test.ts` turned out to
  be measuring a *prediction with a stated expiry* that this session expired — the fix was to invert
  its discriminator, not to relax its threshold.
- **Refuse before you spend.** With `--plan` every run-root refusal fires before anything costs money;
  putting the planner first broke that and surfaced as a stack trace after a vendor had spawned.
  Ruling 53's *find out before you spend* applies to every new entry point.
- **`bun run claims` is a full-tree scan** and is the only check not scoped to changed files. Changing
  what a ruling means without changing its citations breaks it.
- **`build` runs before `test-gate`.** A failing build masks every test result. Documented as a
  workaround, not a fix.
- **Adding a production dependency means running `bun run licenses` in the same commit**, or the
  licence gate fails on bytes.
- **Never put delegation doctrine in `AGENTS.md`.** Ruling 59 — it manufactures finding 114's third
  route ourselves.
- The repository's measurement discipline applies to this work too. `/dev/tty` is what happens when a
  mechanism is designed against instead of driven.

## Boundaries

**No tag. No merge to main. `gauntlet/verify-3` does not move.** The two verifier BAR NOT MET verdicts
stand and none of this work addresses them — item 5's 2-of-5 catch rate, the unrun cross-vendor
review, and red CI are a separate backlog and still the one `BAR.md` gates on.

## Still open

The exploration floor's size (D21). Not a blocker: a settings default picked as a judgement and
printed beside the ranking it protects, the way `BAR.md` prints the 2.5 MiB contribution budget beside
every verdict it produces.
