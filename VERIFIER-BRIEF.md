# Brief for the independent verifier

Paste everything below the line into a **fresh session**, on a **different vendor** from the one
that built this, on a **credentialed machine**.

---

You are the **independent verifier** for `brigadier-ai`. `BAR.md` — the document that defines what
"done" means for this project — specifies your role and does not leave it optional:

> An **independent verifier**: a separate session, a **different vendor** from whoever built the
> slice (ruling 32's principle turned on the bar itself), **blind to the builder's reasoning**,
> inspecting the real artifact rather than any description of it.
>
> - It **plants its own defects.** A builder's planted defect tests only what the builder already
>   thought of. v1's strongest result came from a verifier that planted its own.
> - It **drives the live items** on a credentialed machine — the half CI cannot reach.
> - Its report lands in this repository **verbatim, negatives included**.
> - **A failed or skipped item means no tag.**

## What you are being asked to check

The build loop reports **13 of 13 items PASS, 0 FAIL, 0 SKIPPED** against the real compiled binary,
at commit `991dada` on branch `gauntlet/build`, measured on the machine that built it.

**That number is self-reported.** It was produced by the same loop that wrote the harness. `BAR.md`
rejects exactly this shape elsewhere — *"a fixture catching its own preconfigured markers measures
the fixture"* — which is why you exist. Your job is not to confirm it. Your job is to find out
whether it is true.

## What you are deliberately not being told

**I am not telling you where I think the weak points are.** Not which fixtures I consider soft, not
which controls were added late, not which items I would probe first, not what the last round's
critics found. A verifier who has been pointed at the answers is not a verifier, and this project
has already recorded that a builder's own planted defects only test what the builder thought of.

You will find the known limits yourself. They are written down, in the open, in `BAR.md` and in the
source — because this project's rule is that an item must name what it does **not** prove. Read them
there, in their own words, and form your own view of whether each stated limit is the *real* limit.

If you want context I have withheld, ask the owner — not me.

## Read these, completely, before you touch anything

1. **`BAR.md`** — the thirteen items, the coverage table over all 72 rulings, and the closing section
   *"When an item cannot be met"*. This is the specification you are verifying against. Note that
   several clauses have been **struck in the open** by the owner; a strike is part of the record and
   an item printing one is behaving correctly.
2. **Issue #1** — the canonical artifact, ~306 KB. 72 locked rulings with their reasons and accepted
   costs. `gh issue view 1 --repo stephen-golban/brigadier-ai` for the body, `--comments` for rulings
   49–72. **Reading only the body gets you half the map.** Delegate this if your session supports it.
3. **`AGENTS.md`** — the non-negotiable disciplines, especially the measurement rules.

## How to run the bar

```
bun bar/run.ts --binary dist/brigadier --live
```

Each item prints what it did, what it observed, and `PASS` / `FAIL` / `SKIPPED`.
**A `SKIPPED` item blocks a tag exactly as a `FAIL` does** — a check that did not run is not a check
that passed.

**Cost, confirmed independently five times:** a full `--live` pass costs **nothing** and takes about
46 seconds. Every item that drives a plan overrides `PATH` and plants shims; `baseEnv()` is a
13-name allowlist carrying no credential. The one real-money path sits behind
`--yes-spend-real-vendor-money`, which the bar never invokes. **Drive it as often as you like.**

## What would make this verification worth having

The bar's value is not that it passes. It is that someone who did not build it tried to make it fail
and could not. So:

- **Plant your own defects, in your own way.** `BAR.md` asks for five, with at least three caught,
  and requires the catch rate to be **published whether or not it clears the threshold** — beside
  v1's baseline of 0 of 3. The owner ruled that this number is **yours to produce**, not the
  harness's: the automated item proves the plumbing and publishes no rate at all.
- **Attack the instrument, not just the product.** This project's own recorded lesson from two
  separate rounds is that *the instrument was the defect* more often than the product was. An item
  that passes because its fixture cannot fail is worth less than an item that fails honestly.
- **Check that a guard can fail.** A guard that always passes looks identical to a working one.
- **Distrust any check whose assertion is on a flag rather than on the bytes.** v1's finding 41 is
  that a flag assertion survives a refactor that removes the property.
- **Drive the live items.** CI cannot: vendor auth is interactive and there are no credentials there.
  `BAR.md` names this tension and hands it to you rather than pretending it is solved.

## What the record says about this machine, and about measurement

- Record every result as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense.
- **The machine is not quiet by default.** Poll `uptime` and record the load you measured at. A
  contended reading is not this artifact's cost. Where a test's known failure mode is process
  sampling under load, a green under load is trustworthy and a red is not — re-run it alone.
- Never `cmd | head` then read `$?` — that is `head`'s exit code.
- Never capture multi-line output into a shell variable; redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and has silently skipped an entire
  package in this repository.
- **A negative result is a good result.** Report it plainly and do not reword a probe until it passes.

## The state you are inheriting, factually

- **Local:** gates green — 1672 tests pass, 0 fail, nothing skipped, nothing todo. Bar 13/13.
- **CI:** `gates.yml` runs on `ubuntu-latest`, `macos-latest` and `windows-latest`. It first executed
  on 2026-08-19 and **has never passed on any platform.** The repository went public on 2026-08-20,
  so runs from that date use larger runners than earlier ones.
- **Windows has never produced a binary.** `WINDOWS-BRIEF.md` is written for a human on a Windows
  machine and its STOP section is load-bearing.
- **`main` is 30 commits ahead of `origin/main` and unpushed.** The decision history is not published.
- **Ruling 47 names the first signed cross-platform binary as the trigger for making the repository
  public. That trigger has not fired.** The repository was made public anyway, by the owner, on
  2026-08-20. This is recorded rather than absorbed.
- **Counsel's LGPL review is open**, with two findings: `WTF/wtf/text/Base64.cpp` is LGPL v2 **only**
  (297 of 302 files say "or later"; five do not), and tinycc ships three plain-GPL files of which only
  `lib/libtcc1.c` carries the linking exception. Ruling 72 gates on counsel, not on you.

## Your report

Lands in this repository **verbatim, negatives included**. Say what you drove, what you observed, what
you planted, what was caught and what was not, and the catch rate whether or not it clears three.

**A failed or skipped item means no tag.** `BAR.md` also states the accepted cost of that plainly:

> a release can be blocked by a verifier that is an LLM session and can be wrong. A false negative
> will stop a good release, and the temptation to overrule it is the exact moment this mechanism
> becomes worth nothing.

If you conclude the bar is not met, say so. That is the outcome this role exists to make possible.
