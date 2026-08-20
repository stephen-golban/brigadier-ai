# brigadier

An **ACP hub**. One [Agent Client Protocol](https://agentclientprotocol.com/) client drives whichever
coding agents are already installed on your machine, isolates each unit of work in its own
`git clone --local`, and composes them — so one vendor builds and a different vendor reviews. It also
presents itself as an ACP *agent*, so an editor that speaks ACP can drive brigadier the same way
brigadier drives everything else.

It ships as a single `bun --compile` binary for macOS, Linux and Windows. It carries no model and no
credential of its own: it drives the agents you already have, with the accounts you already pay for.

## Status, before anything else

**Pre-release.** There is no tag and no published artifact; you build it from source. Nothing here is
a promise that it works on your machine.

- **The bar reads 13 of 13 on the author's machine, and that is not the same as met.** `BAR.md`
  defines "done" as thirteen items driven against the real compiled binary, each checkable by someone
  who does not trust the author — and it assigns the verdict to an **independent verifier**: a
  separate session, a different vendor, blind to the builder's reasoning, planting its own defects.
  That has not happened. What exists is the loop that built the harness reporting that the harness
  passes, which is the shape `BAR.md` rejects elsewhere. The number is self-reported until a verifier
  says otherwise. See `VERIFIER-BRIEF.md`.
- **The last item closed by a withdrawal, not a fix.** Item 10's ≤10 ms warm-start clause was struck
  in the open on 2026-08-20: it was never measured on this product, entering the record as one
  unsourced sentence. No number was moved to fit a measurement, and no replacement budget was
  adopted. The figure is still measured and printed; it no longer gates. What is now unproven is
  named in the item's own output.
- **CI has run on `macos-latest`, `ubuntu-latest` and `windows-latest`, and does not yet pass on any
  of the three.** The gates workflow executed for the first time on 2026-08-20 and found a real Linux
  defect on that first run. Before then the only workflow that had ever executed was `portability`,
  which ruling 62 says is not a gate — so "green" had meant green on one macOS machine for the entire
  life of the project.
- **No binary has ever been produced on Windows.** The Windows leg has never got past the build
  stage. Cross-compiling to `bun-windows-x64` from macOS does work, which is a different and much
  weaker claim: the Windows-only code paths — the process reader, the `taskkill /T /F` branch — have
  never executed anywhere.

## Where the documentation actually is

This file is deliberately the smallest of the four.

- **[Issue #1](https://github.com/stephen-golban/brigadier-ai/issues/1) is the canonical artifact**,
  not this tree. Seventy-two locked rulings, each with the reason it was made and the cost it
  accepted, the measured evidence behind them, the tooling that was assessed and rejected so nobody
  re-proposes it, and what is deliberately out of scope. Source files and tickets cite rulings by
  number and will not make sense without it.
- **[`BAR.md`](./BAR.md)** — what "done" means. The thirteen items, how they are run, who verifies
  them, and the coverage table mapping every ruling to the item that proves it. A `SKIPPED` item
  blocks a release exactly as a failing one does.
- **[`AGENTS.md`](./AGENTS.md)** — how to work in this repository: the four gates, the licence gate,
  and the measurement discipline, each rule of which came from a confidently wrong number that
  reached a shipped file.
- **[`MEASUREMENT-SESSION.md`](./MEASUREMENT-SESSION.md)** and **[`probes/`](./probes/)** — the work
  order and the throwaway scripts behind the measurements the design rests on, including two traps
  recorded there that produced confidently wrong readings before they were caught.

The binary's own `brigadier --help` is the command surface; `brigadier version` prints the commit,
the compiler and the sha256 of the running executable, so any number measured against it can name
the artifact it was measured against.

## Relationship to v1

[`stephen-golban/brigadier`](https://github.com/stephen-golban/brigadier) shipped at 0.2.1 — signed,
notarized, on a Homebrew tap. It is an **archive**. v2 is a clean-room rebuild and **no v1 source is
carried** (ruling 1). What is carried is 124 recorded findings: measured facts, defects and their
causes, and several rules learned expensively enough to be worth more than the code that taught them.
Where the map cites a v1 finding, that is why.

## Licence

Apache-2.0 — see [`LICENSE`](./LICENSE). Every `.ts` file outside `probes/` opens with an SPDX
identifier. Attribution for everything compiled into the binary is **generated** into
[`THIRD-PARTY.md`](./THIRD-PARTY.md) by `bun run licenses` and is never edited by hand.
`bun run build` fails if the committed attribution disagrees with what is actually bundled, and the
shipped binary prints the same thing with `brigadier licenses`.
