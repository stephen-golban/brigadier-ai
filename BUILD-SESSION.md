# Build session: the product correction

Written 2026-08-21 at the end of the owner-intent session. **This supersedes `NEXT-SESSION.md`**,
which points the gauntlet at `BAR.md` and is now the wrong map: the bar is not what changed, the
product is.

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
- Tip is `8e91c42` (`PRODUCT.md`). **Not pushed** — a push starts a ~53-minute three-platform gates
  run. Local `gauntlet/next` was level with `origin/gauntlet/next` before this commit.
- Local `main` carries 2 `NEXT-SESSION.md` commits and is 48 behind `gauntlet/next`. `origin/main` is
  0 ahead, 78 behind. Left alone deliberately.
- `bun test`: **1,771 pass, 0 fail, 0 skipped**, 98 files, 265 s, MEASURED 2026-08-21 on darwin.
- `bun run claims`: passes, 73 rulings covered.
- CI at the last completed run `32488134420`: **63 distinct Windows failures, 4 macOS failures.**
  Every `gates` run in the repository's history has failed.
- `gauntlet/build`, `ci`, `verify-2`, `verify-3` are all ancestors of `gauntlet/next`. **`verify-2`
  points at the same sha as `build` and marks nothing of its own.**

## Do step 0 before you write any code

**Post the rulings to issue #1.** The 24 decisions in `PRODUCT.md` section 0 are decisions, not
rulings. Nine locked rulings need overturning (section 3). Until that comment exists, every source
file citing ruling 20 or 25 cites something the product no longer obeys, and `bun run claims` will
start failing on exactly that.

The repository's own convention for this: each ruling carries its reason and its accepted cost, and a
ruling taken under delegated authority says so in its opening line.

## Then Track A, in order

1. **Settings file.** None exists today — only `~/.config/brigadier/bridges.json`, which is ruling
   69's bridge escape hatch. Ruling 71 specified three config layers and only *state* was built.
   Everything below needs somewhere to live.
2. **`brigadier setup`.** Non-interactive: detect → write config → write the plugin asset → install
   the shim → print. Overturns rulings 71, 26, 42.
3. **Possession.** `UserPromptSubmit` in brigadier's own `hooks/hooks.json`. Plus the shim for the
   `--brigadier` path.
4. **`--goal "<sentence>"`.** The entry point that makes it a product.
5. **`plan` and `research` work kinds.** Overturns rulings 20 and 19. Research carries D22's date rule.
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

## Measured this session — do not re-derive these

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

## Traps

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
