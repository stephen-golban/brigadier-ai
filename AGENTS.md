# Working in this repository

`AGENTS.md` rather than a vendor-specific file, because it is the cross-vendor standard — Linux
Foundation stewarded, read natively by Codex, Cursor, Copilot, Gemini CLI, Aider, Windsurf, Zed and
VS Code. Claude Code reads it too.

## Read the map first

The canonical artifact is **issue #1**, not this tree:
`gh issue view 1 --repo stephen-golban/brigadier-v2`

It holds every locked ruling with its reason and its accepted cost. Tickets reference rulings by
number and will not make sense without it. Read it completely before acting.

## There is no product source, and adding some is not a small decision

The design has 37 locked rulings and at least eight rest on unmeasured assumptions. Some will reverse
when measured. **The current phase is measurement.** See `MEASUREMENT-SESSION.md`.

`probes/` holds throwaway measurement scripts. They are not product code and are not held to product
standards. Everything else in a commit should be a document or a ticket.

## Do not port anything from v1

`stephen-golban/brigadier` is an archive. Ruling 1 is true zero: its 124 **findings** are input, its
**code** is not. Reading v1 source to understand a finding is fine; copying it is not.

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

## A deliberate omission

This file says nothing about delegating work to brigadier, and that is on purpose.

A repository's own `AGENTS.md` is loaded by every agent working in a clone of it — including agents
that brigadier itself spawns as workers. Delegation doctrine here would tell a worker to hand its
work back to an orchestrator, which is exactly the failure v1 recorded: a worker given a plain "write
two files" order instead cloned the repo and ran the orchestrator, producing zero files in twelve
minutes where the direct edit took two.

Tracked as issue #34. Do not add delegation instructions to this file.
