# Prompt for the build session

Paste everything below the line into a fresh session in `~/Development/brigadier-v2`.

---

/gauntlet brigadier-ai's build phase against BAR.md's thirteen items, driven on the real compiled binary

You are the **coordinator**. You do not write product code yourself. You decompose, delegate to
subagents, verify what comes back, and keep the ledger. Treat your own context as the scarcest
resource in the run: it is the only thing that cannot be parallelised, and once it is full the run
degrades. Push every file read, every search, every build and every test run into a subagent.

## What this repository is

`brigadier-ai` is an **ACP hub**: one Agent Client Protocol client drives whichever coding agents are
installed on the machine, isolates each unit of work in its own `git clone --local`, and composes
them — one vendor builds, a different vendor reviews. It also presents itself as an ACP agent so
editors can drive it. It compiles to a single `bun --compile` binary for macOS, Linux and Windows.
The binary on `PATH` is `brigadier`.

**Read these two things first, completely, and then stop reading and start delegating:**

1. The map — **72 locked rulings**, the measured evidence behind them, a rejected-tooling list, the
   fog, and what is out of scope. Every ruling cites the ticket that produced it. **This is the
   canonical artifact; the source tree is not.**

   **It is in two places and you need both.** The body outgrew GitHub's 256 KB issue limit during
   phase 2, so **rulings 49–72 live in three comments on the same issue**:

   ```
   gh issue view 1 --repo stephen-golban/brigadier-ai            # rulings 1–48, the evidence, the fog
   gh issue view 1 --repo stephen-golban/brigadier-ai --comments  # rulings 49–72
   ```

   **Reading only the body gets you half the map**, and the half it omits is the half that settles
   integration, the gate, secrets, the cost model and the report budget.
2. `AGENTS.md` in the repo root.
3. `BAR.md` — see *Two bars* below.

Do not read `src/` yourself. Send a subagent to summarise it and report back an interface map.

## Where the work stands

- **Phase 1 (measurement) is closed.** 23 research and prototype tickets are done. Eight locked
  rulings were contradicted by evidence and are amended as rulings 38–45; ruling 46 fixes identity.
- **Phase 2 (decide) is CLOSED — 2026-08-17.** All 27 `wayfinder:grilling` tickets are resolved,
  producing rulings 49–72. **Nothing is blocked on a grilling ticket any more**, so the old
  instruction to defer a blocked decision behind a `// TODO(#NN)` no longer applies: **if you think a
  decision is unmade, you have not found the ruling — go and look.** There are no open tickets on the
  repository except the map itself.
- **Phase 3 (build) has started.** In already: an ACP client (`src/acp/`), a lane (`src/lane/`), the
  measured launch-profile table and a `Worker` deep module (`src/agent/`), a CLI, and the **type and
  policy spine phase 2 landed as it ruled** — `src/work/` (kinds, checks, requirements, fan-out
  arithmetic, the retry ladder), `src/repo/` (refs, layout, git invariants), `src/run/`, `src/report/`,
  `src/router/`, `src/secrets/`, `src/plugin/`. `brigadier detect` reports 6/6 agents usable on this
  machine. **171 tests pass, typecheck clean, binary 60.5 MB.**

  **Those modules are specifications with tests, not implementations.** They carry the constants, the
  predicates and the reasoning; almost none of them is wired to anything. Read them before you build
  the slice that uses them — and do not re-decide what they encode.

## Two bars, and they are not the same thing

**The release bar is [`BAR.md`](../blob/main/BAR.md) — ruling 48, settled on #37.** **Thirteen items**
now, each driven against the **real compiled binary** rather than the test suite, each tied to a
ruling, plus a coverage table over **all 72 rulings**. **That file is what "done" means. Read it
before you decompose anything** — it is the shortest description of what the build is missing, and
**every ruling in it is now covered: no entry is deferred.**

Building `bar/run.ts` — the harness that takes `--binary <path>` and runs those thirteen items — **is
itself a slice, and it is the one that makes every other slice checkable.** Nothing else in this
repository can tell you whether a slice actually did what it claims. **Build it first.**

## The per-round gate

Distinct from the release bar and much cheaper: this is what must be true **every round**, so a bad
round is caught in minutes rather than at a tag. It is not a definition of done, and it never was —
it is the floor.

**`bun run gates` is the whole floor and it is now mechanical** (ruling 62). It runs, in order:

- `bun run typecheck` — `tsc --noEmit` clean.
- **`bun run test-gate`** — `bun test` green **and zero skipped or todo tests**. A skipped test is not
  a passing test, and this is the gate rather than the convention it used to be.
- **`bun run claims`** — the **full-tree** scan, and the only check here not scoped to changed files:
  `BAR.md`'s coverage table is contiguous, nothing cites a ruling the table has never heard of, no
  `src/` file imports from `probes/`, and the router's competence path and the cost store do not
  import each other (decision 22, made mechanical by ruling 66).
- `bun run build` — the **licence gate** (ruling 47): a non-allowlisted dependency licence, a
  proprietary marker string in the compiled binary, or a `bun` drifted from `vendor/pins.json` each
  fail the build.

Plus, still on you rather than on a script:

- **Every guard has a negative control** — a test proving it fails when it should. A guard that
  always passes looks identical to a working one. Mutation testing was researched and **declined**
  (ruling 62: Stryker has no Bun support, and mutation score correlates weakly with real fault
  detection once suite size is controlled for), so this rests on you.
- **Every measured fact in source cites its ticket and the version it was measured against.** Three
  of six agent coordinates in circulation were wrong; a stale one fails as a hang, not an error.
- Binary ≤ 63 MB, cold start ≤ 70 ms, warm ≤ 10 ms (v1's measured numbers).
- CI: **`.github/workflows/gates.yml`** green on all three platforms — a Windows failure blocks
  exactly as any other does. `portability.yml` drives `probes/` and is **not** a gate; its results are
  data, and a noisy gate gets ignored.

**v1 — `stephen-golban/brigadier`, shipped at 0.2.1, signed, notarized, on a Homebrew tap** — is an
archive and a reference, never a source of code (ruling 1 is true zero: read it to understand a
finding, never copy it). Its 124 findings are input to both bars.

## Slices — fan out, disjoint owned paths

Partition by owned paths and never let two builders claim one path (that is ruling 14's legality
filter, applied to yourselves). Suggested split, in rough dependency order — re-decompose if you see
better:

0. **`bar/run.ts`** — the release-bar harness, 13 items, `--binary <path>`. Build it first; it is what
   makes every slice below checkable.
1. **Isolation** — `src/isolation/`. `git clone --local`; ruling 50's base commit built through a
   **temporary index** (`GIT_INDEX_FILE` + `read-tree HEAD` + `add -A`, then `write-tree` and
   `commit-tree`) — **seed from HEAD or `git add -A` silently drops tracked-but-ignored files**;
   published at `refs/brigadier/<run-id>/base` and fetched in, because a default clone does not carry
   it; sparse checkout (#19); the pool recycled with `fetch && checkout && clean -fdx` —
   `checkout --force` leaves residue, measured; `core.autocrlf` set **explicitly** to match what the
   base commit was built under (ruling 50; otherwise a one-line edit becomes a 6-line whole-file
   diff); layout and the **MAX_PATH refusal** from `src/repo/layout.ts` (ruling 61).
   **Ruling 56 changed this slice's shape:** the real invariant is *brigadier runs no git command
   inside a clone after an agent has touched it* — `core.hooksPath` is defence in depth, not the
   mechanism, and it does **not** close `core.fsmonitor`. See `src/repo/git.ts`.
2. **The sweep and run manifest** — `src/run/`. Ruling 38 makes the reclamation sweep the containment
   boundary, not the job object: Bun's Windows job sets `BREAKAWAY_OK`, `cmd /c start` escapes it, and
   one `setsid()` escapes a POSIX process group. Every process brigadier causes to exist must carry a
   marker in its **command line** or the sweep has nothing to match. Three-way delete proof (ruling
   15) — **and ruling 63 splits it: the sweep reclaims processes always, directories only for runs the
   manifest marks complete**, because a retained directory holds the only copy of someone's work.
   Interrupt semantics and the NDJSON record are already specified in `src/run/interrupt.ts` and
   ruling 70.
3. **Work queue** — `src/queue/`. Ruling 19: N items, `write` and `read-only` kinds, results streamed
   as they land; item count and worker count are different numbers. The fan-out arithmetic is already
   written (`src/work/fanout.ts`, ruling 54) — **use `totalmem()`, never `freemem()`, and the test
   file says why.** `dependsOn` is **waves**, not sibling fetches: wave N+1 clones from wave N's
   integration commit, and a wave boundary is a gate boundary.
3b. **Integration** — `src/integrate/`. Ruling 51, and it is a whole module the old list omitted:
   the **parent fetches from the clone** (never the clone pushing — a worker *can* push through its
   own `origin`, measured); `git merge-tree --write-tree` merges with **no working tree** (git ≥
   2.38 is a hard floor); ownership checked by diffing **in the parent**; one atomic
   `update-ref --stdin`; `refs/heads/brigadier/<run-id>` is the deliverable and the one ref never
   deleted.
4. **Repo map** — `src/repomap/`. Ruling 39: tree-sitter WASM (proven to embed under `bun --compile`
   on all three platforms), PageRank, **~2K token budget not 1K**, built **per run, not per item**.
5. **Router and cost** — `src/router/`. Rulings 29/40: the unit is (agent, model, effort); Codex takes
   the triple over `session/set_model`, Claude's effort is a **switch, not a dial**. `usage_update`
   arrives from Copilot, Qwen and opencode — opencode with a cost object.
6. **brigadier as an ACP agent** — `src/serve/`. Four methods are enough, confirmed against real Zed.
   Report fan-out progress by **re-sending the stable `plan`**; `plan_update` is UNSTABLE and Zed
   silently ignores it.
7. **The plugin asset** — `assets/plugin/`. Ruling 42: `~/.agents/skills/brigadier/SKILL.md`, and note
   VS Code reads a **bare** `plugin.json` while Codex reads `.codex-plugin/plugin.json`, so ship both.
   **`hooks/hooks.json` carries exactly one event** — ruling 60 measured that **one unrecognised event
   discards every hook in the file**, silently, so adding one is a breaking change gated against a
   pinned floor. `src/plugin/hooks.ts` has the floor set and the names-based self-check.
8. **The gate and the report** — `src/gate/`, `src/report/`. Ruling 52's four outcomes with the
   **write-ahead** slot that makes absence impossible, and the integration-branch gate that closes
   #9's handoff. Ruling 58's report is the one to get right: **hard-capped at 2,000 tokens into a host
   session, O(items) never O(work), and the cap may hide a success but never a failure.** The
   arithmetic is in `src/report/budget.ts`.
9. **Secrets** — `src/secrets/`. Ruling 65: environment injection at spawn, source list **per-machine
   only**, and redaction at **one sink after composition, every encoding**. `redact.ts` and its tests
   already encode v1's three failures; what is missing is the sink every writer must go through — and
   ruling 65 names that as the most likely way it fails in practice.

## How to delegate — this is the point of the run

- **Fan out in one message with multiple `Agent` calls.** Never serially when the work is disjoint.
- **Every subagent gets a self-contained brief**: the task, the acceptance criteria, the gate it must
  pass, and its owned paths as an explicit list. Brief them like ruling 16 says — identifiers up
  front, contents just-in-time. They read the files themselves.
- **Demand summaries back, never transcripts** (ruling 21, item 5). A subagent that returns a file
  dump has wasted the delegation. Ask for: what changed, what the tests say, what it could not do.
- **Pair every builder with a separate critic** that never sees the builder's reasoning and inspects
  the real artifact — the diff, the test output — not the builder's description of it.
- **Give the review to a different vendor than the build where you can** (ruling 32). Anthropic
  documents models preferring their own output when judging it.

**The specific failure mode this repo has already recorded, twice — do not reproduce it.** v1's
finding 114: a worker given a plain "write two files" order instead cloned the repo and ran the
orchestrator, producing zero files in twelve minutes where the direct edit took two. It happened
again unprovoked during #14. **Your subagents are workhorses. Tell them to do the work directly, in
the files they own. A subagent must never delegate further or invoke brigadier.**

## Discipline, inherited and non-negotiable

Each of these came from a confidently wrong number that reached a shipped file:

- Record results as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense.
- Never `cmd | head` then read `$?` — that is `head`'s exit code.
- Never capture multi-line test output into a shell variable; redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and silently skipped an entire
  package this week, nearly producing a false finding.
- A skipped test is not a passing test. A negative result is a good result — report it plainly and do
  not reword a probe until it passes.
- **If a measurement contradicts a locked ruling, say so explicitly, name the ruling number, and add a
  line to the map.** A reversal is a success, not a problem.

## Cadence

Work in rounds. Each round: fan out builders → fan out blind critics → apply the gaps → run the gates
→ commit → append one line to the ledger. Between rounds, report to me in **under fifteen lines**:
what landed, what the gates say, what is blocked and on which ticket. Then start the next round
without asking.

Keep going until I stop you. Do not ask whether to continue.

---

*Note for the owner, updated 2026-08-17 after phase 2 closed:*

*All 27 grilling tickets are resolved — rulings 49–72 — so this file's "phase 2 is not yours" section
is gone and the slice list has been corrected where a new ruling changed a slice's shape. Three
slices were missing entirely and are added: **integration** (ruling 51), **the gate and the report**
(rulings 52, 58) and **secrets** (ruling 65). The map-reading instruction is the important edit:
**rulings 49–72 are in comments on issue #1, not its body**, and a session reading only the body
would work from half the map.*

***Two non-code gates stand before the first tag, and neither is the build session's:***

1. ***Counsel reviews the LGPL position*** *(ruling 72). The route is chosen and documented, and the
   ticket's own deadline is the first signed cross-platform binary — which is also ruling 47's trigger
   for flipping the repository public. Those are the same event.*
2. ***The BSD attribution gap is named but not fixed*** *(ruling 72): JavaScriptCore is ~95%
   BSD-licensed, not LGPL throughout, and `THIRD-PARTY.md` now says so — but enumerating those files'
   attribution properly is work nobody has done.*
