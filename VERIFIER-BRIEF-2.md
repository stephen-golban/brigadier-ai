# Brief for the second independent verifier

Paste everything below the line into a **fresh session**, on a **credentialed machine**, driven by a
**different vendor from whoever built this** — and, where the owner can arrange it, a different
vendor from the first verifier as well. Ruling 32's reason for cross-vendor is that models prefer
their own output when judging the same thing; ruling 62 (e) adds that **lens diversity outranks
vendor diversity**, and a second verifier that reasons the way the first one did is one lens asked
twice.

This brief is written by the session that built the change under test. It is deliberately narrower
than that session's knowledge. Read the section headed *What you are deliberately not being told*
and hold the author to it.

---

You are the **second independent verifier** for `brigadier-ai`. `BAR.md` — the document that defines
what "done" means for this project — specifies your role and does not leave it optional:

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

The build loop reports **14 of 14 items PASS, 0 FAIL, 0 SKIPPED, 0 blocking** against the real
compiled binary, on branch `gauntlet/build`, measured on the machine that built it.

**That number is self-reported.** It was produced by the same loop that wrote the harness. `BAR.md`
rejects exactly this shape elsewhere — *"a fixture catching its own preconfigured markers measures
the fixture"* — which is why you exist. Your job is not to confirm it. Your job is to find out
whether it is true.

**A previous independent verifier examined an earlier artifact and did not pass it.** That is the
whole of what you are being told about it: not what it drove, not what it looked at, not what it
found, not how many findings there were. You are the second ruling, not a re-run of the first.

## What you are deliberately not being told

**I am not telling you where I think the weak points are.** Not which fixtures I consider soft, not
which controls were added late, not which items I would probe first, not what any earlier round's
critics found, not what changed in this artifact since the last one, and not one word of what the
previous verifier reported. A verifier who has been pointed at the answers is not a verifier.

**And a specific instruction, because this repository is now full of the temptation.** It contains
documents written by earlier rounds recording their own conclusions, their own findings and their
own reading of what is weak. Some of them are titled in ways that will look like a map.

- You may read anything in this repository. Nothing is sealed and nothing is being hidden from you.
- **Do not use any of it as your starting map.** A verifier who opens an earlier round's findings
  first has narrowed the search to somebody else's list before forming a view, and every one of
  those documents describes an artifact that is not the one in your hands.
- **Do not reuse any planted defect you find written down anywhere.** They are kept for regression
  value and they are exactly the set this artifact has already been hardened against. Five that
  somebody else already thought of measure the hardening, not the reviewer.

Start from `BAR.md`, the ruling record, and the compiled binary. Form your own view of where the
weak points are. Then read whatever you like.

**If you want context I have withheld, ask the owner — not me.**

## Read these, completely, before you touch anything

1. **`BAR.md`** — the **fourteen** items, the coverage table over all 72 rulings, and the closing
   section *"When an item cannot be met"*. This is the specification you are verifying against. Note
   that several clauses have been **struck in the open** by the owner; a strike is part of the record
   and an item printing one is behaving correctly.
2. **Issue #1** — the canonical artifact, ~306 KB. `gh issue view 1 --repo
   stephen-golban/brigadier-ai` for the body (rulings 1–48), `--comments` for rulings 49–72 plus the
   measurement amendments §1–§21 and the owner decisions §22–§31. **Reading only the body gets you
   half the map.** Delegate this if your session supports it.
3. **`AGENTS.md`** — the non-negotiable disciplines, especially the measurement rules.

## How to run the bar

```
bun bar/run.ts --binary dist/brigadier --live
```

Each item prints what it did, what it observed, and `PASS` / `FAIL` / `SKIPPED`.
**A `SKIPPED` item blocks a tag exactly as a `FAIL` does** — a check that did not run is not a check
that passed.

**Cost.** MEASURED 2026-08-20: a full `--live` pass completed in under two minutes and spent no
vendor money. Every item that drives a plan overrides `PATH` and plants fixtures; `baseEnv()` is a
short allowlist carrying no credential; one item drives the installed vendors' real binaries as far
as their handshake, on their own free or already-authenticated sessions. The one real-money path
sits behind `--yes-spend-real-vendor-money`, which the bar never invokes. **Drive it as often as you
like.**

**Your own defect drives are a different matter.** Planting five defects and driving a real builder
and a real reviewer means real vendor turns on your account. That is the cost of the number you are
being asked to produce, and it is worth saying before you start rather than after.

## The catch rate is yours to produce

`BAR.md` item 5 asks for **five defects, at least three caught**, with the rate **published whether
or not it clears the threshold**, beside v1's baseline of **0 of 3**. Owner decision §25 settles who
measures it: the automated item proves the plumbing and publishes **no rate at all**, because a
harness counting its own markers measures the harness. The judgement — does this reviewer's prose
actually describe the defect I planted? — is yours.

So:

- **Plant your own five, in your own way**, against the constraints above.
- **Prose-only prompts.** Do not label the defects, do not leave marker tokens in the source, and do
  not tell the builder or the reviewer that anything was planted. §25 records what happens
  otherwise: `grep DEFECT-` scores 5 of 5 without reviewing anything.
- **Score from the recorded transcript**, and say what each reviewer actually said.
- **Publish the number even if it is 0 of 5.** A published number gets argued with; a suppressed one
  gets repeated.

## What would make this verification worth having

The bar's value is not that it passes. It is that someone who did not build it tried to make it fail
and could not. So:

- **Attack the instrument, not just the product.** This project's own recorded lesson, across
  several rounds, is that *the instrument was the defect* more often than the product was. An item
  that passes because its fixture cannot fail is worth less than an item that fails honestly.
- **Check that a guard can fail.** A guard that always passes looks identical to a working one.
- **Distrust any check whose assertion is on a flag rather than on the bytes.** v1's finding 41 is
  that a flag assertion survives a refactor that removes the property.
- **Distrust any sentence the product prints about itself.** A binary can print what it did without
  having done it, and that is a whole class this project has shipped before.
- **Drive the live items.** CI cannot: vendor auth is interactive and there are no credentials
  there. `BAR.md` names this tension and hands it to you rather than pretending it is solved.
- **Take the coverage table seriously.** Ruling 48 calls its second column *"a one-line way to make
  this bar lie"*, and it is meant to be argued with rather than read.

## Measurement discipline — non-negotiable, and each rule came from a wrong number that shipped

- Record every result as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense.
- **Poll `uptime` until load1 is below 3.0 before measuring, and record the load you measured at.**
  A contended reading is not this artifact's cost. Where a test's known failure mode is process
  sampling under load, a green under load is trustworthy and a red is not — re-run it alone. **If
  the machine will not go quiet, say so and record the load anyway**; that is what the last two
  rounds had to do.
- Never generate load deliberately. **One test process at a time.**
- Never `cmd | head` then read `$?` — that is `head`'s exit code. Redirect to a file, read the file.
- Never capture multi-line output into a shell variable. Redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and has silently skipped an entire
  package in this repository. `scripts/license-gate.ts` contains a NUL byte — plain `grep` reports
  zero matches on it; use `grep -a`.
- **Never run a probe whose own command line contains `--brigadier-run` while the bar is running.**
  It contaminates an in-flight process scan; that happened on 2026-08-20 and made an item pass on
  the harness watching itself look.
- Reap every spawned process, grandchildren included. Before finishing:
  `ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"`.
- **Do not delete `~/.brigadier-bar*` wholesale**, and do not kill processes matching only the repo
  path — that is the operator's editor.
- Do not generalise from one sample. Two agents, both directions, before writing a rule.
- Verify negative claims as carefully as positive ones.
- **A negative result is a good result.** Report it plainly and never reword a probe until it passes.

## The state you are inheriting, factually

Facts, with no reading attached to any of them:

- **Local, MEASURED 2026-08-20 on macOS 26.5.2 / Darwin 25.5.0 arm64, bun 1.3.14.** The machine was
  **not quiet** and could not be made quiet; the loads are recorded because of that.
  - `bun run gates` — **exit 0**: typecheck, build, licence gate, **1,706 tests pass / 0 fail /
    0 skipped / 0 todo**, claims gate 72 rulings covered. Load1 3.56 at start, 5.47 at end.
  - `bun bar/run.ts --binary dist/brigadier --live` — **exit 0**: 14/14 PASS, 0 FAIL, 0 SKIPPED,
    0 blocking. Load1 5.55 at start, 5.43 at end.
- **CI.** `gates.yml` runs on `ubuntu-latest`, `macos-latest` and `windows-latest`. It has **never
  passed on any platform**. In the most recent run, on all three: typecheck passed, build and the
  licence gate passed, **the test step failed**, and claims, the compiled-binary check and the
  release-bar step were therefore skipped. Windows does now produce a binary; earlier documents in
  this repository say it never has, and that statement is superseded.
- **`origin/gauntlet/build` is the published branch**, 55 commits ahead of `origin/main` as of the
  commit before this round's. `main` is not where this work lives.
- **The repository is public.** Ruling 47 names the first signed cross-platform binary as the trigger
  for that, and **the trigger was not met**; the owner made it public anyway on 2026-08-20 and
  amended the trigger (owner decision §22). Recorded rather than absorbed.
- **The LGPL / counsel gate is CLOSED by the owner** (2026-08-20). Ruling 72's questions are not
  yours and not open. Do not raise them.
- **No tag exists.** Nothing has been released.

## Your report

Lands in this repository **verbatim, negatives included**, as `VERIFIER-REPORT-2.md`. Say what you
drove, what you observed, what you planted, what was caught and what was not, the catch rate whether
or not it clears three, and the load you measured at.

Name the artifact you measured against — `brigadier version` prints a build identifier, and this
project has already lost a series of measurements to nobody recording which binary produced them.

**A failed or skipped item means no tag.** `BAR.md` also states the accepted cost of that plainly:

> a release can be blocked by a verifier that is an LLM session and can be wrong. A false negative
> will stop a good release, and the temptation to overrule it is the exact moment this mechanism
> becomes worth nothing.

If you conclude the bar is not met, say so. That is the outcome this role exists to make possible.
And if you conclude it is met, say that with the same plainness — a second verifier that cannot
return a pass is not a check either.
