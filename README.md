# brigadier v2

**There is deliberately no source code here yet.**

## What this is

brigadier is an **ACP hub**. One [Agent Client Protocol](https://agentclientprotocol.com/) client
drives whichever coding agents are installed on your machine, isolates each unit of work in its own
`git clone --local`, and composes them — one vendor builds, a different vendor reviews. It also
presents itself as an ACP agent, so editors that speak ACP can drive it directly.

You do not run it. You open your normal agent session and it engages from inside.

## The canonical artifact is the map, not this tree

**[Map: brigadier v2 — the ACP hub specification](https://github.com/stephen-golban/brigadier-v2/issues/1)**

Everything decided lives there: the destination, every locked ruling with the reason it was made and
the cost it accepted, the measured evidence behind them, a list of tooling assessed and rejected so
nobody re-proposes it, the fog of what is not yet specified, and what is out of scope.

Its child issues are the open questions, wired with `blocked_by` edges so the takeable ones render as
the frontier.

Read the map before reading anything else here.

## Why no code

The design is deep and its foundation had never been measured. Several locked rulings rested on
assumptions nobody had checked, and some of them reversed when they were. Writing source against
those would have bought a rewrite.

**Phase 1 — measurement — is done, as of 2026-08-17.** 17 research and prototype tickets are closed,
and **eight locked rulings were contradicted or qualified by the evidence** — amended on the map as
rulings 38–45 rather than by editing the originals, so the record of what was believed and why it
changed survives. Among them: the Windows Job Object permits breakaway, so containment is the sweep
rather than the job; the repo map pays but at a 2K budget, not 1K; and effort is a graded axis on one
vendor and a binary one on the other.

See [`MEASUREMENT-SESSION.md`](./MEASUREMENT-SESSION.md) for the work order it ran from, and
[`probes/`](./probes/) for the throwaway scripts that produced the evidence — including two traps
recorded there that produced confidently wrong readings before they were caught.

**Phase 1 closed on 2026-08-17 by the owner.** All 23 research and prototype tickets are closed —
but #46, #47 and #48 were closed *with work outstanding*, by ruling rather than because they were
finished. Their unmeasured halves are named in their resolution comments and on the map: the quota
signal at the limit, the compaction dropped-branch reproduction, five of six agents undriven for
compaction, and JetBrains / the VS Code ACP extension as ACP clients. A check that did not run is not
a passing check, and none of those was rewritten as one.

**Phases 2 and 3 now run together.** 26 `wayfinder:grilling` tickets remain, and the owner has elected
to start building alongside them rather than after. Note which of them gate the first files: identity
(#35) fixes the binary and repository name, licensing (#36) fixes every source header, and the
work-kind, gate and integration rulings shape the core types.

## Relationship to v1

[`stephen-golban/brigadier`](https://github.com/stephen-golban/brigadier) shipped at 0.2.1 — signed,
notarized, on a Homebrew tap. It is an **archive**.

v2 is a clean-room rebuild. **No v1 source is carried.** What is carried is 124 recorded findings —
measured facts, defects and their causes, and several rules learned expensively enough to be worth
more than the code that taught them. Where the map cites a v1 finding, that is why.
