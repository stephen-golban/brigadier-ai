# brigadier: the run lifecycle, against real workers

Run 2026-08-31T09:50:52Z. Every worker below is a real Claude session driven
through the Agent SDK against the user's own binary and their own login.

## The arena

A repository with three failing tests and no `src/`, plus uncommitted work in flight:
an untracked `NOTES.local` and an uncommitted edit to `README.md`.

- tree fingerprint before: `7428da0210c5c6ceb99f8f89e513b0081a8a1d9ffbb23787b272bdf2323b8fbf`
- branches before: `refs/heads/main `

## Both spending gates fire, in order

### `brigadier plan` refuses before gate 1 is answered
```
$ brigadier plan --goal "..."
brigadier refused: the planning gate has no recorded answer, and it will not spend the user's tokens without one.
Ask the user, then have THEM run:
  brigadier gate plan --goal "Implement slugify, truncate and titleCase in src/, each in its own file, and re-export all three from src/index.ts so the existing tests pass." --answer yes
Nothing was cloned and nothing was spent.
```

### Gate 1 — planning alone, in turns and tokens
```
$ brigadier gate plan --goal "..."
estimate  planning "Implement slugify, truncate and titleCase in src/, each in i…"
turns     4-12
tokens    20k-120k
          one planning worker, off-session, reading the tree and writing a plan file
          4-12 turns, 20k-120k tokens
          this buys a plan file and nothing else -- no clone, no worker, no change to the repository

Put this to the user with a recommended option and a freeform option, then record
their answer:  brigadier gate plan --goal "..." --answer yes
```

Answered: `recorded  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/approvals/plan-bee3ccc9b978b815.json`

## A plan is written off-session and comes back as a file

```
$ brigadier plan --goal "..."
plan      /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/plans/plan-20260831-095053-1aa5.json
spent     5 turns, 81719 tokens
clone     /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/_offsession/plan-20260831-095053-e8c4  (left in place; nothing is deleted)
checks    passed — 4 pieces, 3 can start at once, depth 2
```

The session gets one line naming a path. The plan itself is never pasted into the
conversation. Its shape, for the record only:

```
goal    Implement slugify, truncate and titleCase as separate modules under src/ and re-export the
verify  bun test
  slugify        depends_on=[] files=['src/slugify.ts']
  truncate       depends_on=[] files=['src/truncate.ts']
  title-case     depends_on=[] files=['src/titleCase.ts']
  index-barrel   depends_on=['slugify', 'truncate', 'title-case'] files=['src/index.ts']
```

## brigadier refuses an invalid plan, and reports every problem at once

```
$ brigadier check broken.json
checks    FAILED — 4 problems, all of them:
  file-collision      pieces[].files: "src/shared.ts" is claimed by a and b; merge those pieces or split the file so exactly one piece owns it
  unknown-dependency  pieces[b].depends_on: "ghost" is not a piece in this plan; correct the id or add the piece
  dependency-cycle    pieces[].depends_on: circular dependency: a -> b -> a; break the ring by removing one edge
  verify-missing      verify: "definitely-not-a-real-command" is not on PATH; install it, correct the command, or drop "verify" — a repository with no tests is normal

Nothing was cloned and nothing was spent.
```

Two pieces claiming one file, a dependency ring, a dependency that is not a piece, and a
verify command that is not on PATH — all four in one pass, nothing cloned, nothing spent.

## Gate 2 — after the plan exists, with the piece count and the width known

```
$ brigadier run --plan <plan>      # before gate 2 is answered
brigadier refused: the run gate has no recorded answer, and it will not spend the user's tokens without one.
Ask the user, then have THEM run:
  brigadier gate run --plan /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/plans/plan-20260831-095053-1aa5.json --answer yes
Nothing was cloned and nothing was spent.

An approval covers one run of one exact configuration: this plan, this
repository, this verify command, this width, this review setting.
  repo    /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/strutil
  verify  bun test
  width   3, review false

$ brigadier gate run --plan <plan> --review
estimate  running 4 pieces
turns     24-104
tokens    160k-960k
          4 pieces x 4-20 turns = 16-80 turns
          4 pieces x 25k-180k tokens = 100k-720k tokens
          fan-out width 3, so ~2 waves of wall-clock time; the token cost does not change with width
          review adds 4 x 2-6 turns and 15k-60k tokens per piece
          verify (`bun test`) runs once on the merged result and costs no model turns
          no dollar figure: brigadier does not know the rate, the plan, or the cache state
width     min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
repo      /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/strutil
verify    bun test

Show this to the user with a recommended option and a freeform option. They record
their own answer — you are refused if you try:
  brigadier gate run --plan /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/plans/plan-20260831-095053-1aa5.json --review --answer yes
```

Answered: `recorded  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/approvals/run-70c65469a0287ed3.json`

## The run is detached and survives the shell that started it

```
$ ( cd repo && brigadier run --plan <plan> --review )   # in a subshell that then exits
run       20260831-095136-7379  detached, 4 pieces
width     min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
check in  brigadier status 20260831-095136-7379
```

`brigadier run` returned in under a second with a run id. The shell that launched it has
exited; the supervisor has not.

## `brigadier status` — progress, from a terminal that never launched it

```
run       20260831-095136-7379  done
goal      Implement slugify, truncate and titleCase as separate modules under src/ and re-export them from src/index.ts so `bun test` passes.
repo      /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/strutil  (never written to; results land on refs/brigadier/20260831-095136-7379/<piece>)
width     min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
  merged   slugify  6 turns, 87977 tokens
           refs/brigadier/20260831-095136-7379/slugify
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)
  merged   truncate  6 turns, 88187 tokens
           refs/brigadier/20260831-095136-7379/truncate
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)
  merged   title-case  8 turns, 119456 tokens
           refs/brigadier/20260831-095136-7379/title-case
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)
  merged   index-barrel  7 turns, 102952 tokens
           refs/brigadier/20260831-095136-7379/index-barrel
           review: approved (same vendor as the builder — a weaker check than a different vendor reading it)

verify    `bun test` on the merged result: exit 0

left behind (nothing is deleted):
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/20260831-095136-7379/_merged
  /private/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/strutil refs/brigadier/20260831-095136-7379/merged
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/20260831-095136-7379/slugify
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/20260831-095136-7379/truncate
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/20260831-095136-7379/title-case
  /var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-proof/prove-run/home/workspaces/20260831-095136-7379/index-barrel
```

### The wave log, showing independent pieces running together

```
verify    `bun test` on the merged result: exit 0
  2026-08-31T09:51:36.996Z  -  wave  min(3 independent pieces, cap 4, memory allows 12) = 3, bound by independent pieces
  2026-08-31T09:51:37.057Z  title-case  worker-start
  2026-08-31T09:51:37.061Z  truncate  worker-start
  2026-08-31T09:51:37.062Z  slugify  worker-start
  2026-08-31T09:52:02.200Z  truncate  published  refs/brigadier/20260831-095136-7379/truncate
  2026-08-31T09:52:03.224Z  slugify  published  refs/brigadier/20260831-095136-7379/slugify
  2026-08-31T09:52:16.143Z  title-case  published  refs/brigadier/20260831-095136-7379/title-case
  2026-08-31T09:52:16.144Z  -  wave  min(1 independent pieces, cap 4, memory allows 12) = 1, bound by independent pieces
  2026-08-31T09:52:16.345Z  index-barrel  worker-start
  2026-08-31T09:52:43.649Z  index-barrel  published  refs/brigadier/20260831-095136-7379/index-barrel
  2026-08-31T09:52:43.963Z  -  published  refs/brigadier/20260831-095136-7379/merged
  2026-08-31T09:52:43.964Z  -  verify-start  bun test
  2026-08-31T09:52:43.983Z  -  verify  exit 0
```

## The user's repository afterwards

| | before | after |
|---|---|---|
| tree fingerprint | `7428da0210c5c6ceb99f8f89e513b0081a8a1d9ffbb23787b272bdf2323b8fbf` | `7428da0210c5c6ceb99f8f89e513b0081a8a1d9ffbb23787b272bdf2323b8fbf` |
| branches | `refs/heads/main ` | `refs/heads/main ` |
| `NOTES.local` (untracked) | present | present |
| `src/` in the user's tree | absent | absent |

**Identical.** Byte for byte, uncommitted changes included.

Where the work actually landed:

```
refs/brigadier/20260831-095136-7379/index-barrel
refs/brigadier/20260831-095136-7379/merged
refs/brigadier/20260831-095136-7379/slugify
refs/brigadier/20260831-095136-7379/title-case
refs/brigadier/20260831-095136-7379/truncate
```

