# Working in this repository

`AGENTS.md` rather than a vendor-specific file, because it is the cross-vendor standard — Linux
Foundation stewarded, read natively by Codex, Cursor, Copilot, Gemini CLI, Aider, Windsurf, Zed and
VS Code. Claude Code reads it too.

## Read the map first

The canonical artifact is **issue #1**, not this tree:
`gh issue view 1 --repo stephen-golban/brigadier-ai`

It holds every locked ruling with its reason and its accepted cost. Tickets reference rulings by
number and will not make sense without it. Read it completely before acting.

## The build has started, and `probes/` is not part of it

**Phase 1 (measurement) closed on 2026-08-17.** There are now 46 locked rulings, and rulings 38–46
amend earlier ones against measured evidence. Product source lives in `src/` and is held to product
standards: `bun test` and `bunx tsc --noEmit` must both pass.

`probes/` holds throwaway measurement scripts. They are **not** product code, are excluded from the
typecheck, and must not be imported from `src/`. If a probe's behaviour is worth keeping, port the
finding into `src/` deliberately — do not reach across.

**Every measured fact in `src/` cites its ticket.** The launch-profile table in
`src/agent/profiles.ts` is the clearest case: each entry names the version it was measured against
and the ticket that measured it, because three of six agent coordinates in circulation were wrong and
a stale one fails as a hang rather than an error.

## Licensing is a gate, not a preference

Ruling 47. brigadier is **Apache-2.0**; every `.ts` file outside `probes/` opens with
`// SPDX-License-Identifier: Apache-2.0` as its first line (after the shebang, where there is one).

`THIRD-PARTY.md` and `src/generated/licenses.ts` are **generated** by `bun run licenses`. Never edit
either by hand — `bun run build` runs `licenses --check` first and fails if the committed attribution
disagrees with what is actually bundled.

`--check` compares **bytes**, and the generator always writes LF, so `.gitattributes` pins those two
files and every committed licence text they reprint (`LICENSE`, `vendor/*`) to LF on every platform.
If `--check` reports STALE and adds that only the line endings differ, the **checkout** is wrong and
the attribution is not: run `git add --renormalize . && git checkout -- .`, or clone again. A clone
made before `.gitattributes` existed keeps whatever endings it was given. MEASURED 2026-08-20 on
darwin, by cloning `7ff6431` with `-c core.autocrlf=true`: both surfaces failed `--check` while being
identical to HEAD once CR bytes were removed, and regenerating there wrote 1,272 `\r` escapes into
the licence strings `src/cli.ts` compiles into the binary.

`bun run license-gate` then scans the compiled binary. It fails the build if:

- a production dependency carries a licence outside the permissive allowlist in `scripts/inventory.ts`;
- the binary contains a marker string from `@anthropic-ai/claude-agent-sdk`, which is **proprietary**
  ("© Anthropic PBC. All rights reserved.") and which the Claude ACP bridge depends on — it stays out
  of the binary only because ruling 44's `CLAUDE_CODE_EXECUTABLE` shim keeps it out;
- the `bun` building the binary is not the version `vendor/pins.json` pins the attribution to.

**Adding a production dependency means running `bun run licenses` in the same commit.** If the gate
blocks you, the answer is not to widen the allowlist — it is to say so on the ticket. The failure
this gate exists to catch is legal, not functional: no test goes red and no user reports it.

## Do not port anything from v1

`stephen-golban/brigadier` is an archive. Ruling 1 is true zero: its 124 **findings** are input, its
**code** is not. Reading v1 source to understand a finding is fine; copying it is not.

## The gates

`bun run gates` — **typecheck → build → tests → claims**. Ruling 62 settles what each is for, and CI
runs all of them on **`windows-latest`, `ubuntu-latest` and `macos-latest`, where a failure on any one
blocks**. Ruling 12 makes Windows first class, and #5 measured `MAX_PATH` failing a clone at 198
characters and `core.autocrlf=false` turning a one-line edit into a six-line whole-file diff —
neither visible anywhere else.

**`build` moved ahead of `test-gate` on 2026-08-20, and it is a trade rather than an improvement.**
`bar/lib/item5-transcript.test.ts` drives `--binary dist/brigadier` through an argument parser that
asserts its inputs exist on disk, and `dist/` is gitignored — so on a clean checkout that file cannot
exist until `build` has run. It failed on all three platforms on `gates.yml`'s first ever execution
and had only ever looked green because a local worktree carried a stale artifact. `build` is
therefore a **prerequisite** of `test-gate`, not a peer that happened to come later.

What that costs, said here rather than left to be discovered:

- **A failing `build` now masks every test result.** Nothing is asked less of — all four still run and
  each still blocks — but a test failure surfaces later, behind the slowest gate.
- **The expensive gate runs before the informative one**, which is the wrong way round for anyone
  reading a red CI log.
- **On Windows this currently means no test signal at all.** Until 2026-08-20 `bun run build` could
  not succeed there (`bun build --compile` writes `brigadier.exe`; `scripts/build.ts` looked for
  `dist/brigadier` and refused), so under the new order the Windows leg dies at stage 2 and never
  reaches the suite — where under the old order it at least ran the tests first. `scripts/build.ts`
  and `scripts/license-gate.ts` now discover the artifact's real name, which removes the cause;
  the ordering exposure remains, and Windows CI has yet to run green even once.

The price is only worth paying because the alternative — a test that passes when the binary is absent
— is a weakened check, and `test-gate` cannot skip (ruling 62 (c)). **This is a workaround, not the
fix.** A unit test of a pure argument parser has no business depending on a build artifact; `bar/lib/`
owns that fixture, and pointing it at a path that is always on disk would let the cheap gates go back
in front. `package.json` and `.github/workflows/gates.yml` must be changed in the same commit as each
other — a local `bun run gates` that runs a different order from CI cannot reproduce CI.

- **`bun run test-gate`** fails on any **skipped or todo** test. A skipped test is not a passing test,
  and ruling 62 makes that a gate rather than a line in this file. It is ruling 48's *"a `SKIPPED`
  item blocks a tag exactly as a `FAIL` does"* at a third scale — release, change, test run.
- **`bun run claims`** is a **full-tree** scan, and it is the only check here that is not scoped to
  changed files. That is the point: v1 lost four documents in one day to invisible staleness and
  every instance passed all four gates, because the stale file was one nobody had touched. It checks
  `BAR.md`'s coverage table is contiguous, that nothing cites a ruling the table has never heard of,
  and that nothing in `src/` imports from `probes/`.

**The `portability` workflow is not a gate.** It drives `probes/`, its results are data, and a noisy
gate gets ignored.

## Measurement discipline

The rules below each came from a confidently wrong number that reached a shipped file.

- Record results as **"MEASURED against `<tool> <version>` on `<date>`"**, never in the present
  tense. A dependency moved mid-project last time and made every present-tense claim stale.
- Never `cmd | head` then read `$?` — that is `head`'s exit code. Same through a subshell.
- Never capture multi-line test output into a shell variable; redirect to a file and grep the file.
- A probe must be the first thing that touches its subject, or it measures its own warm-up.
- Do not generalise from one sample. Two agents, both directions, before writing a rule.
- Every check needs a negative control showing it can fail. A guard that always passes looks
  identical to a working one.
- A skipped test is not a passing test.
- Verify negative claims as carefully as positive ones.
- Do not trust a package coordinate copied from documentation; check the registry.
- A negative result is a good result. Report it plainly and do not reword a probe until it passes.

## What brigadier says to a person

D24, carried by ruling 80. **Scope is output TO THE USER only** — this section
governs what the binary prints for a person to read, and nothing else. Worker
briefs, this file, `BAR.md` and `PRODUCT.md` are all out of scope, and brigadier
goes on talking to its workhorses in whatever prose gets the work done.

**Every user-facing message is one line**, and that is enforced structurally
rather than by a lint: `src/report/say.ts` is the only constructor for one, and
it REFUSES a multi-line message rather than flattening it. A word list detects
slop after somebody writes it; a line form leaves nowhere to put it.

The standard the line form cannot enforce, which is why it is written here and
enforced by review:

- **Say the fact, not the effort.** `plan ready → <path>`, not *"I've gone ahead
  and prepared a plan for you"*.
- **Name the thing that happened, with its subject.** `item 3 → codex` beats
  *"dispatching work to an agent"*.
- **A number or a path beats an adjective.** If a line has neither, ask what it
  is for.
- **No apology, no preamble, no offer to continue.** A run that failed says what
  failed and what to do about it.
- **The remedy belongs on the line that reports the problem**, not in a
  paragraph after it.
- **Somebody else's prose is quoted, never rewritten.** A worker's finding text
  is theirs; `quote()` flattens and bounds it, and brigadier has no model with
  which to improve it and does not pretend otherwise.

There is deliberately **no lint for tone**. D24 declines one, and a tone lint is
the kind of check that passes on bad writing and fails on good writing.

## A deliberate omission

This file says nothing about delegating work to brigadier, and that is on purpose.

A repository's own `AGENTS.md` is loaded by every agent working in a clone of it — including agents
that brigadier itself spawns as workers. Delegation doctrine here would tell a worker to hand its
work back to an orchestrator, which is exactly the failure v1 recorded: a worker given a plain "write
two files" order instead cloned the repo and ran the orchestrator, producing zero files in twelve
minutes where the direct edit took two.

**Ruling 59** (settling #34): this is finding 114's **third** route, after ambient globals and the
installed plugin, and all three are closed by one mechanism that is deliberately indifferent to how
the model got the idea — **ruling 57's binary refusal**. The rule here is the *request* half of that
ruling, and it applies to brigadier's own documentation as much as to this file: **never suggest
putting delegation doctrine in a repository file**, or we manufacture the third route ourselves.

Do not add delegation instructions to this file.
