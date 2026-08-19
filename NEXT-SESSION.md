# Prompt for the next build session

Paste everything below the line into a fresh session in `~/Development/brigadier-v2`.

---

/gauntlet brigadier-ai's build phase against BAR.md's thirteen items, driven on the real compiled binary

You are the **coordinator**. You do not write product code yourself. You decompose, delegate to
subagents, verify what comes back, and keep the ledger. Treat your own context as the scarcest
resource in the run. Push every file read, every search, every build and every test run into a
subagent, and demand summaries back — never transcripts.

## Where the work actually is — read this before anything else

**The work is NOT on `main`.** It is on a branch in a separate worktree:

```
/Users/stephen/Development/brigadier-v2-gauntlet-build   branch gauntlet/build   HEAD ca78b0d
```

Thirteen commits ahead of `main`. `cd` there; do not work in `~/Development/brigadier-v2`, which is
still at `7355283`. Nothing has been merged and nothing should be until the owner says so.

**Also: `main` itself is 30+ commits ahead of `origin/main` (`7355283` vs `0dde49b`).** Nothing has
been pushed. See the CI item below, because this matters more than it looks.

## Read these three things, completely, then stop reading and start delegating

1. **The map — issue #1, and it is in FIVE places now.** Rulings 1–48 are in the body; **rulings
   49–72 are in three comments**; and **this session added two amendment comments** recording what
   was measured against the real binary.

   ```
   gh issue view 1 --repo stephen-golban/brigadier-ai            # rulings 1-48, evidence, fog
   gh issue view 1 --repo stephen-golban/brigadier-ai --comments # rulings 49-72 + both amendments
   ```

   The amendments are `#issuecomment-5325912320` and `#issuecomment-5328495299`. They record
   measurements that contradict or complete locked rulings. **Reading the body alone gets you a third
   of the map.**
2. **`BAR.md`** — thirteen items, each driven against the real compiled binary. That file is what
   "done" means.
3. **`AGENTS.md`** — the repo's non-negotiable disciplines.

Do not read `src/` yourself. Send a subagent for an interface map.

## Where the build stands

- **Gates green: 1135 tests, 0 fail, 0 skipped, 0 todo, exit 0.** `bun run gates` is the per-round floor.
- **The bar, driven `--live` against real vendor agents: 6 of 13 PASS, 0 SKIPPED.**
  Passing: 1 (detection), 2 (the lane), 3 (no foreign file touched), 4 (fan-out and integration),
  6 (single-vendor degrades), 8 (impossible plan refused).
  Failing: 5, 7, 9, 10, 11, 12, 13.
- Built and committed: the bar harness, isolation, the sweep, integration, LGPL attribution, drift +
  competence, `brigadier run`, the repo map, review routing, the secrets sink, the plugin asset.
- **A printer fake scores 0/13 and a forger that runs real `git` and writes `fsck`-clean refs scores
  0/13.** Both are checked in as controls. That is what makes the six passes mean anything.

## The one lesson that should shape how you work

**Ten times this session the INSTRUMENT was the defect, not the product.** A fixture that was not an
ACP agent; a deadlocked read loop; a harness timeout shorter than the subject's, so it killed
brigadier before it could report; a runner that orphaned processes; defect markers planted into the
base commit; an empty delegation ledger; a stale fleet claim; a probe reading "ran and failed" as
"not implemented"; a clone path invented identically by both the check *and its own positive
control*; and a reviewer plant landing on the vendor that was routed as the **builder**.

That last one produced `caught 0 of 5` — a plausible, quotable number that I relayed as a
falsification of ruling 52 before it was caught. **Every other harness defect announced itself by
breaking something. That one would have entered the permanent record as evidence.**

So: when a live item fails, the first question is *is the harness looking at the right thing?* — and
the second is *would this check still pass if the property vanished?* Assert on names, not counts;
`.lsp.json` was measured reporting `LSP servers (1)` for `{"notARealKey": 1}`.

## What is left, in priority order

**1. Item 5's plant must follow the routing.** It plants defect-catching on `copilot` and configures
it to catch 3 of 5, but brigadier routes copilot as the **builder** and qwen as the reviewer. Fix the
plant, then add the control: **assert the vendor configured to catch defects is the one the record
names as reviewer.** Do NOT tune the catch rate — whatever number appears once the plant is correct
is the answer, printed whether or not it clears BAR.md's 3-of-5 threshold.

**2. Item 12's plan under-declares its paths.** It declares `config.json` while the fixture also
writes `delivery-proof.txt`, so ruling 51 rejects the item **whole** (correctly) and nothing
integrates. Declare every path. Separately: the leak found was in `r/<run>/1/config.json`, which is
**the worker's artifact, not brigadier's** — ruling 65's sink covers brigadier's own persisted
artifacts and brigadier does not rewrite a worker's commit. That is an owner decision (below).

**3. Items 7, 11, 13** — all were bucket B (built, broken only against real agents) and have had
fixes land since the last live run. **Re-drive `--live` before assuming anything about them.**

**4. Item 10 cannot pass as written.** See the owner decisions.

**5. Not started at all:** `src/serve/` (brigadier as an ACP agent so Zed/JetBrains can drive it).

## Owner decisions — these are Stephen's, not yours. Do not decide them.

- **The ≤70 ms cold-start budget was never measured.** v1's entire git history at Release 0.2.1
  contains no "70 ms", no "cold start", no benchmark script. It enters the record as one unsourced
  line at `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, and every later citation — including ruling
  5's — repeats it. **And it is unreachable:** a Bun binary whose whole program is `process.exit(0)`
  cold-starts at **873 ms**; brigadier at **892 ms**, ~25 ms more than an empty Bun program. The cost
  is XProtect's first-execution scan at **133 ms + 11.3 ms/MB**, cached **per file, not per
  signature**, so signing cannot pre-empt it. Measured alternative: a **337 KB JS bundle run by an
  installed `bun` is 18.9 ms cold** — an architecture change against ruling 5, not a tweak.
- **Under quarantine — the real downloaded-release case — the unnotarized 63 MB binary took 6,045 ms
  and was then SIGKILLed.** Blocked, not slow. Notarization fixes the kill, not the latency.
- **BAR.md item 12's two sentences disagree.** "No persisted artifact" is unbounded; the enumerated
  list is brigadier's own outputs; the worker is *asked to commit the secret*. A proposed amendment
  is drafted in the round-9/10 commits.
- **BAR item 1's lane-assertion check structurally cannot fire** — every plantable profile declares
  `laneAssertion: {kind: "none"}`.
- **Counsel's LGPL review**, now carrying two new findings: `WTF/wtf/text/Base64.cpp` is **LGPL v2
  only** (297 of 302 say "or later"; five do not), and **tinycc ships 3 plain-GPL files** of which
  only `lib/libtcc1.c` carries the linking exception.

## `gates.yml` HAS NEVER RUN. On any platform. Ever.

`origin/main` is 30+ commits behind local. Every CI run on the repository is `portability`, which
ruling 62 states is **not** a gate. So "gates green" has always meant *green on one macOS machine*.
Ruling 12 makes Windows first class, and #5 measured `MAX_PATH` failing a clone at 198 characters and
`core.autocrlf=false` turning a one-line edit into a six-line whole-file diff — **neither visible
anywhere else**. The Windows process reader and the `taskkill /T /F` escape branch are **written and
unmeasured**, deliberately left to fail loudly rather than hide behind a skip.

**Ask the owner before pushing anything.** It is their repository and the push is outward-facing.

## Machine discipline — this went badly wrong and the rules are not optional

An agent ran **16 busy-wait subshells plus two concurrent test suites** to check whether failures were
load-related, and drove the owner's machine to **load average 146 on 14 cores**. Separately, a harness
runner SIGKILLed only its direct child on timeout and orphaned ACP vendor children at **98.7–100% CPU
sustained** — one survived **2h20m**, and a peer session reaped **18 orphans across seven run ids**.

Put these in **every** builder brief, verbatim:

- **NEVER generate load deliberately.** To tell contention from a real failure, run the test **alone**
  on a quiet machine.
- **One test process at a time.** No background suites. Full `bun run gates` **once**, at the end.
- **Every spawned process must be reaped, including grandchildren.** Every fixture loop needs a `sleep`.
- **Cleanup must never sit downstream of an unbounded `wait`** — if the awaited thing wedges, the
  cleanup line is never reached. Use `trap` or a bounded wait.
- `kill %1` and other `%N` job specs are **inert in a non-interactive shell** without `set -m`: they
  return exit 0 and kill nothing. Verified.
- **Do not delete `~/.brigadier-bar*` wholesale** — that took out another builder's `bun test`.
- `ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"` before finishing;
  kill anything of yours and **report what you found**.

## The live bar costs real money and time

`bun bar/run.ts --binary <path> --live` is **~5 minutes per item, ~60 minutes for a full pass**, and
spends real vendor tokens. **Build against a snapshot copy of the binary** (`cp dist/brigadier
/tmp/...`) so a concurrent `bun run build` cannot swap the artifact mid-run. Do not let builders run
it; schedule it yourself.

## Cadence

Fan out builders on **disjoint owned paths** in one message. Pair every builder with a **separate
blind critic** that never sees the builder's reasoning and inspects the real artifact — the diff, the
test output, the running binary. Lens diversity beats vendor diversity when only one axis can be
spent (ruling 62e). Then: apply the gaps → run the gates → commit → report to the owner in **under
fifteen lines** → start the next round without asking.

**Subagent spawns hit `529 Overloaded` three times in a row near the end of this session, and a DNS
failure killed two mid-edit.** Both times the tree was clean or typechecked, and agents resumed from
their own transcripts with nothing lost — because paths were disjoint and commits were frequent. If
spawns keep failing, do the work by hand rather than stalling; a focused edit is cheaper than waiting.

Keep going until the owner stops you. Do not ask whether to continue.
