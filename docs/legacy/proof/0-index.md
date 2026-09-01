# The evidence, item by item

Twelve things have to be true. This names, for each, where the evidence is and what the negative
control was — the run that shows the difference between "it works" and "it would have done that
anyway". Regenerate the live half with `scripts/prove-all.sh`.

| | claim | evidence | its negative control |
|---|---|---|---|
| 1 | Inside a git repository the host session cannot read the user's code — by tool or by shell — under `bypassPermissions` | [1-the-wall.md](1-the-wall.md) §1b; `test/policy.test.ts` | §1's control run read the file and quoted the secret out of it |
| 2 | It is a **refusal**, not the instructions being persuasive | [1-the-wall.md](1-the-wall.md) §1b — the CLAUDE.md block deleted, hooks only, told to read and forbidden to delegate; refused twice, `Read` then `cat` | §1's walled run never reached the wall at all, which is why §1b exists |
| 3 | The same call is allowed to a subagent, and the split is `agent_id` | `docs/measurements.md` M13; `test/policy.test.ts` "the same read is refused to the host and allowed to a subagent" | the identical payload without `agent_id` is denied in the same assertion |
| 4 | The host cannot write the user's tree either | `test/policy.test.ts`; `test/shell.test.ts` — every escape a review found, still closed | the same commands outside a repository pass in the same tests |
| 5 | Outside a git repository, nothing is refused | `test/policy.test.ts`, `test/shell.test.ts` | — (the tests assert both sides of the same boundary) |
| 6 | `claude -p` from inside a session is refused, for the host and for subagents | [1-the-wall.md](1-the-wall.md) §2; `test/policy.test.ts` | `claude --version` passes in the same test — the rule is about starting a session, not about the binary |
| 7 | A reply over the limit is sent back and comes back shorter | [1-the-wall.md](1-the-wall.md) §3 — 5 lines / 3,289 chars unguarded, 1 line / 101 chars guarded, same prompt and model | the control run in the same section |
| 8 | Past the context line the turn is stopped and the session must hand off, taking the finished branch or writing a real handoff prompt | [1-the-wall.md](1-the-wall.md) §4, with `handoff-at` lowered to 1,000 so it can be shown in a short session; `docs/measurements.md` M14; `test/context.test.ts` | the same session under the default 700,000 was not stopped |
| 9 | The instructions live in `.brigadier/BRIGADIER.md` and CLAUDE.md carries only a one-line `@` import to them | [1-the-wall.md](1-the-wall.md) §5 prints the layout and CLAUDE.md in full; `test/install.test.ts` | §1's walled run shows the imported instructions actually reaching a session — §1b, with CLAUDE.md deleted, shows what the session does without them |
| 10 | The import resolves relatively in a project and absolutely globally; `@~/…` does not resolve and AGENTS.md is not read | `docs/measurements.md` M19 — six probes, four carriers | three of the six probes returned `NONE`, which is what makes the other three mean something |
| 11 | A session cannot switch brigadier off: `uninstall` and `config <key> <value>` are refused, host and subagent alike | [1-the-wall.md](1-the-wall.md) §2b; `test/policy.test.ts` | the reading forms — `brigadier config`, `status`, `standards`, `doctor`, `install` — pass in the same test, so the rule is about changing settings and not about the command |
| 12 | Uninstall gives the files back | [1-the-wall.md](1-the-wall.md) §5; `test/install.test.ts` "uninstall gives back exactly what was there before" | the test plants a hook and a CLAUDE.md the user wrote first; both survive |

## The proof script

`scripts/prove.sh` runs eight short sessions against the real `claude` and writes
[1-the-wall.md](1-the-wall.md). It builds three throwaway repositories:

| repository | what is installed | what it is for |
|---|---|---|
| `repo-control` | nothing | the negative control |
| `repo-walled` | instructions and hooks | the product as shipped |
| `repo-hooks-only` | hooks; CLAUDE.md deleted, so the pointer to `BRIGADIER.md` is gone | separating the refusal from the instruction |

That third one is the important one. In the walled repository the session reads the instructions
and delegates, so the wall is never touched and the run proves only that the instructions work.
Deleting CLAUDE.md — which deletes the pointer, and with it the instructions — while keeping the
hooks is what shows there is something underneath them.

Each run writes into its own `BRIGADIER_HOME` and its own git repository, and touches neither
`~/.claude` nor this repository.

`test/guide.test.ts` covers the other half: it reads `brigadier-guide.md` and `README.md` and
checks their numbers, paths, command names, settings keys and the exact tool lists they print
against the program. A change that makes the documentation a lie fails the suite.

A note on what a live run can and cannot settle: it is not deterministic, and the model in it is
free to do something reasonable that was not what the test expected. The refusals are pinned by
tests; the live runs show what a session actually does when it meets them.
