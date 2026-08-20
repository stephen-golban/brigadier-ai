# Ruling 71's detection cache — the three things the ruling left open

Written 2026-08-20, with the ruling text in front of it. Ruling 71 settles that the cache exists;
it does not say where it lives, what invalidates it, or how a stale one is repaired. This is that
record: the choices, the reasons, and what each one costs.

Marked `[owner]` where a real judgement remains open. There is exactly one.

## What ruling 71 actually says

Quoted rather than summarised, because two of the three answers below are read straight out of it:

> **no `init` command; detection is lazy on first run and cached as state** (decision 18:
> regenerable, never hand-edited)

> *What is written and where:* under ruling 61's root, **three files with three lifetimes**, decision
> 18 made concrete — **per-machine config** (roles, consents, budget defaults, ambient-suppression
> toggle; written once, hand-editable); **state** (detection cache and run records; regenerable,
> never hand-edited, safe to delete); **per-repo declarative config** …

> **Deleting state must be a supported repair**, because a cached detection is the thing most likely
> to be wrong after an agent upgrade, which ruling 69 makes a routine event.

And, in its accepted costs:

> **a first run pays a full detection sweep with nothing to show for it in host-first**, bounded by
> the slowest agent and still a silent wait

> a stale detection cache will confuse someone before they learn that deleting state is the repair,
> most likely right after an agent auto-updates

## The problem it is solving, measured

MEASURED against `brigadier` at `838d65f` (tree dirty), bun 1.3.14, on macOS 26.5.2 / Darwin 25.5.0
arm64 on 2026-08-20, at load1 4.01–4.31. **The machine was not quiet** — the operator's editor, an
iOS simulator and an Android emulator were running, and the load could not be brought under 3.0
without touching them. Under contention a *fast* reading is trustworthy and a *slow* one is not, so
the cold figures below are upper bounds and the warm figure is the one to believe.

| invocation | vendors spawned | wall clock |
| --- | --- | --- |
| `run --dry-run`, cold cache | 6 | **4.29 s** |
| `run --dry-run`, cold cache, second reading | 6 | **3.28 s** |
| `run --dry-run`, warm cache | **0** | **0.02 s** |
| `run` (real, refused later at `--verify`) | 6 | 3.96 s |
| `brigadier detect --json`, whole fleet | 6 | 4.01 s (slowest agent 3.92 s) |

The sweep is bounded by the slowest agent rather than their sum, exactly as ruling 71 says. What it
cost was a `--dry-run` that had been sub-second becoming a four-second wait that spawns six vendor
processes.

## 1. Where it lives

**`<run-root>/detect.json`** — a sibling of `r/`, under ruling 61's root: `~/.brigadier`, or
`%LOCALAPPDATA%\brigadier` on Windows.

- **Under ruling 61's root**, because ruling 71 says so and because `src/repo/layout.ts` already
  refused XDG for this region with a measured reason. A second location would be a second answer to
  "where does brigadier keep things".
- **Not under `r/<run-id>/`.** Everything there is scoped to one run and swept by
  `src/run/reclaim.ts`. A fact about the machine that a run's cleanup deletes is a fact nothing can
  cache.
- **Its own file, and this is the part ruling 71 does not say.** Ruling 71 calls the whole state
  region safe to delete. Ruling 63 puts an interrupted item's committed clone under the same root —
  *"not merged and not deleted"*, because finding 92 is a supervisor killed with two workers' real
  work unrecoverable. So `rm -rf ~/.brigadier` is not a repair anyone should be told to run: it is
  also the delete that destroys someone's only copy. Giving the cache its own file makes the repair
  `rm ~/.brigadier/detect.json`, which touches nothing else, while the broad delete still works.

**What it costs.** `--run-root` now scopes the detection cache as well as the run directories, so an
operator who moves the root moves the cache with it and pays one sweep there. That is why `detect`
gained a `--run-root`: without it, the repair command would refresh a cache no run reads.

**Format:** one JSON document, written to a temporary name and `rename`d over the real one. Ruling
70 makes the *run record* newline-delimited JSON because finding 92 is a process dying without
warning and a truncated single document is unparseable in its entirety. That reasoning does not
reach here, and the difference is worth stating: a run record is the only evidence that work
happened, while this file is regenerable by construction, so a torn write costs one sweep. `rename`
is atomic, so a reader never sees a partial file at all.

**Concurrency:** `~/.brigadier` is SHARED (amendment §15) and there is still no cross-process lock.
Two concurrent writers means last-rename-wins and the loser's entries are re-probed next time. Both
wrote results measured seconds apart; neither can be wrong in a way the other was right about.

## 2. What invalidates it

**A fingerprint, per agent, and no clock.**

| fact | why | what it catches |
| --- | --- | --- |
| `artifact` | the compile-time stamp plus the running executable's own size and mtime | a brigadier upgrade, and a rebuild of a dirty tree, mechanically — nobody has to remember to bump a version constant |
| `profile` | a hash of the whole launch profile as it will be spawned, override applied | ruling 69's bridge override, which *"invalidates every measured fact"* in a profile; any change to the coordinate brigadier ships |
| `resolved` | where `Bun.which` finds the command now | ruling 46 — an agent that moved on `PATH` is a different agent, and there is no "it was here last time" |
| `entry` | that entry's size and mtime | a vendor that upgraded in place |
| `probedWorkerShaped` | must be `true` | finding V1 — a `usable` produced under the operator's own config root is not a statement about what a worker can do |

The `profile` hash is over the **whole** profile rather than a chosen subset. A subset is a second
list of what matters about a launch profile, and `src/agent/profiles.ts` already calls itself a
standing hazard; the day a field is added, the subset is wrong and silent. Hashing everything costs
a prose edit to `caveats` invalidating the cache — one sweep, on a build whose `artifact` changed
anyway.

`probedWorkerShaped` was **declared, written in three places and read in none** — amendment §19's
shape exactly, and named as debt in the handover for this round. This is the read. It is now a gate
rather than a recorded field.

### Why there is no TTL

Three reasons, in order of weight:

1. **There is a rule that decides it instead, and it is ruling 63's:** *"a state file records intent
   and the world records fact, and where the world can be consulted directly the world wins."* The
   question is not *how old is too old* but *who is allowed to trust this*. See §4.
2. **The record has no TTL in it.** A full read of issue #1 — 72 rulings, 21 measurement amendments,
   10 owner decisions — turns up no TTL, no mtime rule, no schema-version rule and nothing keyed on
   time anywhere. A number invented here would enter this project as one unsourced sentence, which
   is precisely how item 10's two struck start-up clauses entered it.
3. **The record warns against the shape by name.** #46's own trap line: *"`resetsAt` drifts with wall
   clock — never key a cache on it."*

`test/detect-cache.test.ts` asserts that an entry measured a year ago is still served. That test is
what goes red if a TTL is ever added quietly.

### The hole in the fingerprint, named rather than left to be found

**Two of six profiles are bridged and resolve to `npx`**, whose bytes do not move when
`@agentclientprotocol/claude-agent-acp` or `…/codex-acp` publishes. For Claude and Codex the
fingerprint cannot see the upgrade ruling 69 calls routine — nothing on disk changes, and only a
probe finds out.

This is not hypothetical and it was measured in the same session: the Claude bridge now reports
**0.70.0** against a profile measured at **0.69.0**, and ruling 69 grades that drift `blocking` for
write work. A cache that decided that gate would be deciding it from a version string that can be
arbitrarily old. It does not; see §4.

Neither can the fingerprint see a **credential** change. An expired token, or a fresh `qwen` login,
changes nothing on disk that brigadier looks at.

## 3. How a stale one is repaired

Two routes, and the first is a command the operator already has:

- **`brigadier detect`** always probes, never reads the cache, and rewrites what it found. After an
  agent upgrade the operator runs the command they would have run anyway. A subset probe merges:
  `brigadier detect claude` refreshes Claude and carries the other five, verified on this machine.
- **Deleting the file** — `rm ~/.brigadier/detect.json`, or the whole state region — is a supported
  repair, and the product never describes it as damage. `BAR.md` item 9 already drives a run against
  a deleted state directory and asserts the report says nothing about corruption; the tests assert
  the same words about an unreadable file.

An **unreadable** file is regenerated with one line on stderr saying so. A product that calls its
own supported repair a corruption has taught the operator not to perform it.

## 4. Who is allowed to trust it — and who writes it

These are two questions with two different authorities, which is why `sweep` in `src/cli.ts` takes
two parameters rather than one.

**Reading is ruling 63's call.**

| command | detection | why |
| --- | --- | --- |
| `run` (real) | **probes, every time** | it is about to clone, spawn and spend; it can consult the world, so it does. Finding V1 is `run` admitting on evidence that was not the evidence, and a cache would be V1 again with a time axis. Ruling 69's blocking drift gate is therefore never decided from a stored version string — which matters most for the two bridged agents above. |
| `plan`, `run --dry-run`, `run --estimate` | **serve from the cache, and say so** | they spend nothing and create nothing. This is the cost ruling 71 objected to, and on a warm cache they now spawn no vendor at all — which restores the property `src/queue/admit.ts` claims for itself, that nothing at admission starts a process. |
| `detect` | **probes, every time** | it is the question the cache stores. A `detect` that printed a stored answer could not repair one. |

**Writing is ruling 71's own words plus ruling 53's.** Ruling 71 caches on *first run*; `--dry-run`,
`--estimate` and `plan` are not runs. And ruling 53's ordering promise is checkable precisely because
a refused or dry run can be verified from the outside by listing the run root and finding it
unchanged — `test/cli-run.test.ts` asserts an untouched run root in three places, one of them
immediately after a `--dry-run`. So the commands that create nothing create nothing here either.
`run` and `detect` write.

A cached answer prints what it is:

```
detection: 6 agent(s) from cache, oldest measured 6s ago — no vendor was spawned (ruling 71).
  `brigadier run` re-probes before it spends. To re-probe now: `brigadier detect`, or delete
  /Users/…/.brigadier/detect.json.
```

and a cold `plan` prints the one command that would warm it, rather than leaving an operator to
discover that a fast path exists.

## What all of this costs, stated

- **Every `run` pays the sweep, not only the first.** MEASURED at 3.28–4.29 s here. On a run that
  clones repositories and drives workers for minutes this is noise; it is charged on the invocation
  where a stale answer would cost the most, and saved on the ones ruling 71 named.
- **`plan` can promise a run that `run` then refuses**, because the cached answer was older than the
  vendor's credential or its version. The divergence is in the safe direction — the prediction was
  stale, the run is truthful, and the run prints the vendor's own remedy — but an operator will meet
  it. The printed age and the named repair are the whole mitigation.
- **A machine where nobody ever gets past `plan` never warms the cache** and pays the sweep every
  time. One command fixes it and the output says which.
- **A harness that lies to the binary about `PATH` while sharing the operator's `HOME` will write
  its fixtures into the operator's cache.** `bar/items/01` does exactly that: it drives
  `brigadier detect <agent>` on an isolated `PATH` under `baseEnv`, which keeps the real `HOME`, so
  those probes write to `~/.brigadier/detect.json`. It is self-healing — the planted agent's
  `resolved` path is gone the moment the harness's temp directory is, so every such entry reads as
  stale on the next invocation — but the file is written, and that is recorded rather than
  discovered. **OBSERVED after the live bar of 2026-08-20:** the file held six entries, all six
  naming the operator's real binaries, because item 1's real-fleet leg runs after its fixture legs
  and overwrote them. That ordering is not a guarantee, and the self-healing is what the claim rests
  on rather than the ordering.
- **The `artifact` fingerprint empties the cache on every rebuild.** For an operator that is one
  sweep per upgrade, which is correct. For a developer running `bun run build` in a loop it is one
  sweep per build, which is the price of the invalidation being mechanical instead of a convention.

## The one open judgement

**`[owner]` — ruling 71's accepted cost says *"a first run pays a full detection sweep"*, in a way
that reads as though later runs do not.** Under the split in §4 every `run` pays it, and only the
question-asking commands are served from state. That is a narrower reading of ruling 71 than its own
sentence implies, and it is taken deliberately on ruling 63's authority rather than by oversight.

It is recorded here rather than absorbed, because the two directions are not symmetric:

- Widening it — letting `run` trust the cache too — is a one-line change to `trustCache` in
  `src/cli.ts`, and everything needed to make it honest already exists.
- Narrowing it back, after a stale cache has admitted a run that fails at its first prompt, is the
  same defect the independent verifier found on 2026-08-20 and it would be found the same way.

Nothing is blocked by leaving it as it is. Re-open it when there is a measured reason to weigh
against a stale admission.

## Where the code is

| file | what it holds |
| --- | --- |
| `src/agent/detect-cache.ts` | the path, the fingerprint, the pure read/validate decision, the atomic write, and the rendered disclosure |
| `src/cli.ts` — `sweep` | the one seam that reads and writes it, and the two parameters above |
| `src/queue/admit.ts` | unchanged behaviour; its module comment now says what the cache does and does not reach |
| `test/detect-cache.test.ts` | every invalidation axis, one fact at a time, each with its demonstrated negative |
| `test/cli-run.test.ts` | the same through the binary, asserted on a planted agent's own spawn ledger rather than on a printed sentence |
| `bar/items/09-…` | the compiled binary: a first run creates the cache, a later admission answers from it and spawns nothing, and deleting the state directory is still a repair |

## What was driven, and where it landed

MEASURED 2026-08-20 on the machine described above. **The machine was not quiet** and could not be
made quiet: the operator's editor, an iOS simulator and an Android emulator held load1 between 3.5
and 12 for the whole session. Poll-until-under-3.0 was attempted for several minutes and abandoned;
the load at each reading is recorded beside it, per `AGENTS.md`.

| gate | result | load1 |
| --- | --- | --- |
| `bun run gates` | **exit 0** — typecheck, build, licence gate, 1,706 tests pass / 0 fail / 0 skipped, claims gate 72 rulings | 3.56 at start, 5.47 at end |
| `bun bar/run.ts --binary dist/brigadier --live` | **exit 0** — 14/14 PASS, 0 FAIL, 0 SKIPPED, 0 blocking | 5.55 at start, 5.43 at end |

The suite found three things this change got wrong before a human did, and all three are fixed:

- **`test/queue-ceiling.test.ts`** — a run refused for a ceiling-ordering error left `detect.json`
  behind, so the run root was no longer empty after a refusal. Ruling 53's ordering promise is
  checkable exactly by listing that directory, so the write moved behind every refusal. That is why
  `sweep` returns a `commit` closure instead of writing where it probes.
- **`test/secrets-audit.test.ts`** — a new `writeFileSync` outside `src/secrets/sink.ts` is new debt
  on a ratchet that exists to retire debt. The writer is injected now, and the product passes its
  `Sink`; a detection result carries the vendor's own text, which is a stream out of brigadier and
  belongs in ruling 65's one sink.
- **`bar/fakes.test.ts`** — `bar/fakes/honest.ts` did not implement the behaviour item 9 now gates
  on. It does: it stores what detection found on a real run and reads it on a `--dry-run`. A fixture
  that printed the sentence without keeping the file would have made the item measure a string.
