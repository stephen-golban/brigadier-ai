# Prompt for the autonomous decision session

> **✅ EXECUTED 2026-08-17. Phase 2 is closed.** All 24 remaining `wayfinder:grilling` tickets were
> ruled and closed in one session, producing **rulings 49–72**, which live in three comments on the
> map (issue #1) because its body exceeded GitHub's 256 KB limit. `BAR.md` gained items 11, 12 and 13,
> and **its six deferred rulings are now covered — no ruling in the coverage table is deferred.**
>
> Kept for the record rather than for re-use: the delegation of decision authority it grants was for
> that session and only that session, and `wayfinder:grilling`'s normal rule — *an agent that answers
> its own question here has broken the ticket type* — is back in force.

Paste everything below the line into a fresh session in `~/Development/brigadier-v2`.

---

You are closing out **phase 2** of the brigadier v2 map: the 24 remaining `wayfinder:grilling`
tickets on `stephen-golban/brigadier-ai`.

**The owner has delegated decision authority for this session. Do not ask for opinions. Decide.**

That is a deliberate, recorded override of the ticket type. `wayfinder:grilling` tickets normally
say *"an agent that answers its own question here has broken the ticket type"* — that rule is
suspended for this session and only this session. Every resolution you post must open with
**"Ruled under delegated authority — 2026-08-17"** so the decision record never later reads as
though the owner made a call they did not.

## What brigadier-ai is

An **ACP hub**: one Agent Client Protocol client drives whichever coding agents are installed on the
machine, isolates each unit of work in its own `git clone --local`, and composes them — one vendor
builds, a different vendor reviews. It also presents itself as an ACP agent so editors can drive it.
Single `bun --compile` binary for macOS, Linux and Windows. The binary on `PATH` is `brigadier`.

## Read these first, completely, before deciding anything

1. **`gh issue view 1 --repo stephen-golban/brigadier-ai`** — the map. **48 locked rulings**, the
   measured evidence behind them, a rejected-tooling list, the fog, and what is out of scope. Every
   ruling cites the ticket that produced it. **This is the canonical artifact; the source tree is
   not.**
2. **`BAR.md`** — ruling 48. What "done" means, and the coverage table you are required to maintain
   (see *The two things people forget* below).
3. **`AGENTS.md`** — working discipline, including the licence gate.

Then read the ticket you are working, **and every closed ticket it cites**. Phase 1 closed with 23
research and prototype tickets, and their resolution comments hold the measured evidence. Most
questions you are about to answer already have half their answer sitting in one of them.

## The decision discipline

**Look up every *fact*. Decide every *choice*. Never confuse the two.**

- **Facts inside the project** — the repo, the map, closed tickets, `probes/`, the real binaries on
  this machine. Look them up. Never ask, never assume, never re-derive something the map already
  measured.
- **Facts outside the project** — published vendor documentation, standards, protocol specs,
  research. **Research the web.** Cite the source and the date you read it. This is expected of you,
  not optional: several open tickets (`#21` version drift, `#16` runtime isolation, `#12` telemetry
  schemas, `#38` evidence standards) turn on what the wider world already does.
- **Distinguish research from measurement, always.** A published claim is not a measured one.
  Record research as *"per `<source>`, read `<date>`"* and measurement as *"MEASURED against `<tool>
  <version>` on `<date>`"*. Never let the first wear the clothes of the second.
- **When a decision needs a fact nobody has,** either run a cheap probe in `probes/` and record it
  properly, or **state plainly that it is unmeasured and decide anyway under a named assumption.** A
  skipped check is not a passing check, and an invented number is worse than an admitted gap.
- **Choose the reversible option when genuinely torn**, and say that is why.

**Every ruling states its accepted cost out loud.** A decision with no cost is a decision you have
not finished thinking about. This is the single most important convention on the map — read any of
rulings 30, 37, 46, 47 or 48 to see the shape.

## The ritual, per ticket

1. **Post a resolution comment**: the ruling, the reasoning, and the cost it accepts. Open with
   *"Ruled under delegated authority — 2026-08-17"*.
2. **Close the ticket.**
3. **Add a numbered ruling to the map.** **The next free number is 49.** Bold claim, the reason, the
   accepted cost. If it amends an earlier ruling, **say which and why, and leave the original text
   standing** — that is the 13/32/33/37/38–45 precedent and the record of what was believed matters
   as much as what is believed.
4. **Append one line to the map's "Decisions so far"**, in the existing style.
5. **Make the tree match the ruling** where it has consequences — types, a module, a doc, a
   `// TODO(#NN)` removed.
6. **Commit**, one commit per ticket, with a message that explains the *reasoning*, not the diff.

Then start the next ticket. **Do not ask whether to continue.**

## The two things people forget

**1. `BAR.md`'s coverage table is a live artifact.** Ruling 48 defines done as *every locked ruling
that makes a user-visible promise has an item proving it against the real compiled binary*, and the
table currently parks **six rulings as DEFERRED** — 21, 23, 29, 30 and 40 on `#24`, and 35 on `#31`.
**When you close `#24` or `#31`, those entries must move from deferred to a real item.** And when any
ticket lands a new ruling that makes a user-visible promise, it needs a row. A deferred ruling is not
a covered ruling, and the second column of that table is a one-line way to make the bar lie.

**2. If a ruling contradicts something already locked, say so explicitly, name the ruling number, and
add a line to the map. A reversal is a success, not a problem.** Eight rulings were reversed or
qualified by phase 1's evidence and the map is stronger for it.

## Order of work

Types first, because early code is already being written against them; then composition; then the
hazards that are already ticketed with a measured mechanism; then operations; then economics; then
the product surface.

1. **Core types** — `#20` work kinds · `#29` base state · `#9` integration · `#8` the gate ·
   `#28` what a work item may require
2. **Composition** — `#7` fan-out and slice dependencies · `#33` single-vendor retry rungs
3. **Hazards with a measured mechanism** — `#30` `.git/hooks` · `#32` inert plugin · `#34` a repo's
   own `AGENTS.md` re-creating the delegate loop · `#40` one unknown hook event discarding every
   hook · `#49` run directories outside `/tmp`
4. **Evidence and operations** — `#38` what counts as evidence · `#17` interruption and resumption ·
   `#18` what the owner sees in flight · `#16` runtime isolation · `#10` secrets and redaction
5. **Economics** — `#24` the cost model · `#31` checkable `difficulty` · `#13` the competence table ·
   `#21` version drift · `#12` output, persistence and our own cost
6. **Surface and release** — `#11` the first run · `#51` the LGPL-2 relink obligation

Deviate if a dependency forces it, and **say so in the commit** when you do.

## What just landed, so you do not re-open it

- **Ruling 47 (`#36`)** — brigadier is **Apache-2.0**; attribution ships **inside** the binary
  (`brigadier licenses`) as well as in `THIRD-PARTY.md`, both **generated**; the repository goes
  **public at the first tag producing a signed cross-platform binary**; and a build gate fails on a
  non-allowlisted dependency licence, on a proprietary marker string found in the **compiled binary**,
  or on a `bun` that has drifted from `vendor/pins.json`. The reason it is a gate and not a note:
  **`@anthropic-ai/claude-agent-sdk` is proprietary** and the Claude bridge depends on it — it stays
  out of the binary only because ruling 44's `CLAUDE_CODE_EXECUTABLE` shim keeps it out.
- **Ruling 48 (`#37`)** — the success bar, in `BAR.md`.

**Consequences for anything you write:** every new `.ts` file outside `probes/` opens with
`// SPDX-License-Identifier: Apache-2.0`. **Adding a production dependency means running
`bun run licenses` in the same commit**, or `bun run build` fails. If the licence gate blocks you,
the answer is not to widen the allowlist — it is to say so on the ticket.

## Standing discipline, inherited and non-negotiable

Each of these came from a confidently wrong number that reached a shipped file.

- Record measurements as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense.
- Never `cmd | head` then read `$?` — that is `head`'s exit code.
- Never capture multi-line test output into a shell variable; redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and silently skipped an entire package
  during phase 1, nearly producing a false finding.
- Do not generalise from one sample. Two agents, both directions, before writing a rule.
- **Every guard needs a demonstrated negative** — a check proving it fails when it should. A guard
  that always passes looks identical to a working one.
- A skipped test is not a passing test. A negative result is a good result; report it plainly and do
  not reword a probe until it passes.
- Do not trust a package coordinate copied from documentation; check the registry. **Three of six
  agent coordinates in circulation were wrong**, and a stale one fails as a hang, not an error.

## Gates, every commit

`bunx tsc --noEmit` clean · `bun test` green with no skipped tests · `bun run build` green (which
runs the licence gate) · nothing in `src/` importing from `probes/`.

## Scope

**Decide, do not build the product.** Phase 3 is a separate effort with its own prompt
(`NEXT-SESSION.md`). Touch the tree only where a ruling has a direct consequence — a type, a
constant, a doc, a `// TODO(#NN)` you can now remove. If a ruling implies a whole module, **specify
it in the ruling and leave the module to the build session.**

## Reporting

After each ticket, report in **under ten lines**: the ruling in one sentence, what it accepts as a
cost, anything it contradicted, and which ticket is next. Then start the next one.

**Keep going until every ticket in the list is closed.** Do not ask whether to continue.
