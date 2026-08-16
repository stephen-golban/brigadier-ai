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

The design is deep and its foundation is not yet measured. Several locked rulings rest on assumptions
that have never been checked, and some of them will reverse when they are. Writing source against
those now buys a rewrite.

So the next phase is measurement, not construction. See
[`MEASUREMENT-SESSION.md`](./MEASUREMENT-SESSION.md) for that work order, and [`probes/`](./probes/)
for the throwaway scripts that produce the evidence.

## Relationship to v1

[`stephen-golban/brigadier`](https://github.com/stephen-golban/brigadier) shipped at 0.2.1 — signed,
notarized, on a Homebrew tap. It is an **archive**.

v2 is a clean-room rebuild. **No v1 source is carried.** What is carried is 124 recorded findings —
measured facts, defects and their causes, and several rules learned expensively enough to be worth
more than the code that taught them. Where the map cites a v1 finding, that is why.
