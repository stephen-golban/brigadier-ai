# Prompt for the build session

Paste everything below the line into a fresh session in `~/Development/brigadier-v2`.

---

/gauntlet brigadier-ai's build phase against v1's shipped 0.2.1 and its 124 recorded findings

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

1. `gh issue view 1 --repo stephen-golban/brigadier-ai` — the map. 46 locked rulings, the measured
   evidence behind them, a rejected-tooling list, the fog, and what is out of scope. Every ruling
   cites the ticket that produced it. **This is the canonical artifact; the source tree is not.**
2. `AGENTS.md` in the repo root.

Do not read `src/` yourself. Send a subagent to summarise it and report back an interface map.

## Where the work stands

- **Phase 1 (measurement) is closed.** 23 research and prototype tickets are done. Eight locked
  rulings were contradicted by evidence and are amended as rulings 38–45; ruling 46 fixes identity.
- **Phase 2 (`wayfinder:grilling`, 25 open tickets) is human-in-the-loop and NOT yours.** Do not
  resolve one. If a build decision is blocked on one, say so, choose the reversible option, mark it
  in code with `// TODO(#NN)` and keep moving.
- **Phase 3 (build) has started.** The first vertical slice is in: an ACP client
  (`src/acp/`), a lane (`src/lane/`), the measured launch-profile table and a `Worker` deep module
  (`src/agent/`), and a CLI. `brigadier detect` reports 6/6 agents usable on this machine.
  24 tests pass, typecheck is clean, the binary compiles at 61 MB.

## The bar

**v1 — `stephen-golban/brigadier`, shipped at 0.2.1, signed, notarized, on a Homebrew tap.** It is an
archive and a reference, never a source of code (ruling 1 is true zero: read it to understand a
finding, never copy it). v2 clears the bar when it does what v1 did, without v1's 124 recorded
defects, and honouring the 46 rulings.

Concrete, checkable, and non-negotiable — a critic must be able to verify each one:

- `bunx tsc --noEmit` clean and `bun test` green, every round, no skipped tests.
- **Every guard has a negative control** — a test proving it fails when it should. A guard that
  always passes looks identical to a working one.
- **Every measured fact in source cites its ticket and the version it was measured against.** Three
  of six agent coordinates in circulation were wrong; a stale one fails as a hang, not an error.
- Binary ≤ 63 MB, cold start ≤ 70 ms, warm ≤ 10 ms (v1's measured numbers).
- `.github/workflows/portability.yml` green on `windows-latest`, `ubuntu-latest`, `macos-latest`.
- No `src/` file imports from `probes/`.

## Slices — fan out, disjoint owned paths

Partition by owned paths and never let two builders claim one path (that is ruling 14's legality
filter, applied to yourselves). Suggested split, in rough dependency order — re-decompose if you see
better:

1. **Isolation** — `src/isolation/`. `git clone --local`; the scratch base commit capturing HEAD plus
   uncommitted tracked *and* untracked work (ruling 33); sparse checkout (ruling from #19); the clone
   pool recycled with `fetch && checkout && clean -fdx` — `checkout --force` leaves residue, measured;
   `core.hooksPath` at an empty directory (ruling 34); `core.autocrlf=false` explicitly on every clone
   (measured: otherwise a one-line edit becomes a 6-line whole-file diff on Windows); short flat run
   directories (a clone target fails at 198 chars on Windows).
2. **The sweep and run manifest** — `src/run/`. Ruling 38 makes the reclamation sweep the containment
   boundary, not the job object: Bun's Windows job sets `BREAKAWAY_OK`, `cmd /c start` escapes it, and
   one `setsid()` escapes a POSIX process group. Every process brigadier causes to exist must carry a
   marker in its command line or the sweep has nothing to match. Three-way delete proof (ruling 15).
   **Run directories must not live under `/tmp` or `$TMPDIR`** — `workspace-write` permits the temp
   roots by design and a worker there poisoned a sibling clone (#49).
3. **Work queue** — `src/queue/`. Ruling 19: N items, a pool bounded by ruling 14's three filters,
   `write` and `read-only` kinds, results streamed as they land. Item count and worker count are
   different numbers.
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

*Note for the owner: `#37 — the success bar: how we know v2 is done` is still an open grilling ticket.
The bar above is a build-phase bar chosen so the loop has something concrete to aim at; it is not a
substitute for ruling #37, and the gauntlet skill's own doctrine is that the bar is the most important
part of the technique.*
