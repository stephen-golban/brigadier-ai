# Prompt for the next build session

Paste everything below the line into a fresh session in `~/Development/brigadier-v2`.

---

/gauntlet brigadier-ai's build phase against BAR.md's thirteen items, driven on the real compiled binary

You are the **coordinator**. You do not write product code yourself. You decompose, delegate to
subagents, verify what comes back, and keep the ledger. Push every file read, every search, every
build and every test run into a subagent, and demand summaries back — never transcripts.

## Where the work actually is

**Not on `main`.** A separate worktree:

```
/Users/stephen/Development/brigadier-v2-gauntlet-build   branch gauntlet/build   HEAD 2a90d6e
```

Seventeen commits ahead of `main`. `cd` there. Nothing merged, nothing pushed, and `main` itself is
still 30+ commits ahead of `origin/main`.

## Read these, completely, then stop reading and start delegating

1. **The map — issue #1, in five places.** Rulings 1–48 in the body, 49–72 in three comments, two
   measurement amendments in two more.

   ```
   gh issue view 1 --repo stephen-golban/brigadier-ai --comments
   ```

   The body is ~125 KB and the comments ~180 KB. **Delegate this** to a subagent and ask for a
   one-line-per-ruling index plus verbatim text for the handful you actually need. Reading it whole
   costs ~76k tokens of the one resource you cannot parallelise.
2. **`BAR.md`** — thirteen items. It carries owner rulings from rounds 15 and 16 that are **not** in
   issue #1. Recording them there is outward-facing and needs the owner's say-so — ask.
3. **`AGENTS.md`** — the non-negotiable disciplines.

Do not read `src/` yourself. Send a subagent for an interface map.

## Where the build stands

- **Gates green: 1450 tests, 0 fail, 0 skipped, 0 todo, exit 0**, all four stages in 3 m 49 s (was
  1321 at the last handoff).
- **The bar: 12 of 13 PASS, 1 FAIL, 0 SKIPPED** (was 10 of 13). **Only item 10 fails.**
- **`bun run claims` was reached for the first time in the project's history** in round 16 — every
  prior round died before stage 3 or never ran it. It now also guards `bar/lib/contract.ts` against
  `src/report/record.ts` and `src/work/check.ts` structurally *and* at runtime.
- The printer and forger fixtures still score **0/13**. `bar/fakes/honest.ts`, the **positive**
  control, was repaired this round and is green.

## Item 10 is the only failure and it is NOT yours to fix

```
warm start within 10 ms (minimum of 40, floor-corrected)
16.46 ms − 0.83 ms spawn floor = 15.63 ms. MARGIN: 5.63 ms OVER.
```

Every other check in item 10 passes — LGPL body, relink recipe, pinned corresponding source, install
and uninstall on the real discovery path, node absent from `PATH`, the licence gate on the released
artifact, the size budget, and `PreCompact` named by the host rather than counted.

**Do not touch the budget.** Not the constant, not `START_SAMPLES`, not the floor subtrahend, not the
comparison operator, not the statistic, and do not demote the check to a `note` — `Checks.note()`
stamps `ok:true`, and this repository has already shipped that exact defect on this exact item. A
critic verified in round 16 that the budget had not moved by any of those routes; keep it that way.
Amendment §17's proposed 20 ms **gates nothing** until the owner rules.

**What round 16 added is attribution, not speed.** The binary now prints

```
BUILD-ID commit=<40hex> tree=clean|dirty bun=<ver> bun-revision=<40hex>
         binary-sha256=<64hex> binary-bytes=<n>
```

and item 10 independently hashes the file it timed and asserts the two agree. So 15.63 ms is the
first warm-start figure in this project's history tied to a named artifact. The four before it
(11.29, 16.13, 13.99, 15.08 ms) are **not retroactively repairable** — those binaries are gone.

**Know what the digest does not prove.** It is computed at run time from `process.execPath`, so it is
self-consistent by construction. A critic byte-patched `dist/brigadier`, re-signed it with
`codesign -f -s -`, and it reported the original `commit=` beside the tampered file's true digest. Two
source comments claiming otherwise were corrected in the open. Only a signature over the stamp would
make `commit` checkable, and that needs a key and a release process — deliberately not invented.

## The lesson round 16 adds, and it is different from round 15's

Round 15's lesson was *the instrument was the defect*. Round 16's is narrower and sharper:

**1. The critics found holes the builders introduced WHILE fixing the originals — three of four.**
Not holes that were already there. A drift guard that failed open through `?? []` — the same
silent-empty shape its own file header cites as the incident it was written to prevent. A cost-model
repair that removed a false positive and opened a false negative on the same property. A build stamp
whose two shipped comments claimed a guarantee the mechanism cannot give. **Pair every builder with a
blind critic, every round, without exception. It is the highest-yield thing in this loop.**

**2. Transcription drift happens inside a single round.** `bar/` cannot import `src/`, so everything
the harness knows about product output is hand-transcribed. `src/report/run-report.ts` moved **three
times in round 16** and every citation in `bar/lib/item13-cost.ts` was stale each time:

```
397 → 556 → 522  |  404 → 563 → 529  |  95 → 244 → 211
```

A sentence was even added mid-round by one builder and removed again before the round closed. **If
two slices touch related files, tell each to re-verify its transcriptions against the WORKING TREE,
not against HEAD.** A critic checking `git show HEAD:` will confirm a transcription that is already
wrong.

**3. The design that survives drift: classify, do not whitelist.** Item 13 now requires every line
matching `/ceiling/i` to be a known event *or* a known non-event, and **unrecognised is a failing
row**. A stale whitelist is a silent false negative; a stale blacklist is a loud false positive;
demanding classification makes both loud. It caught all three drifts within minutes. Prefer this shape
anywhere a harness reads product prose.

**4. Anchor on the stable head of a sentence, never on an interpolation.** Item 13's pattern broke
because it keyed on `${why}`, which another builder correctly changed. It now keys on
`/^\s*this report is OVER the [\d,]+-token ceiling\b/` and leaves the whole tail free.

**5. A positive control needs the same discipline as a negative one.** Item 13's tightened checks went
red against `bar/fakes/honest.ts` — and the reason was that those cost-line checks had **never been
exercised by the positive control at all**. Two were genuine fixture gaps. The third was the check
over-constraining: it matched the product's sentence *word for word*, which fails any from-scratch
reimplementation. BAR.md asks that a run "prints actual against predicted"; it does not specify the
prose. **When a fixture and a check disagree, establish which side is wrong and say so before
changing either.**

## What is left, in priority order

**1. The smoothing pass this wave owes.** Four slices landed on adjacent concerns and nobody has
reconciled the seams. Known, recorded, do not rediscover: `headLine`/`itemLine` duplicate
`readProcessTable`/`listProcesses`, with a comment in one claiming to use the other; **six** phrasings
exist for "we could not measure this" and **five** for "the control that proves the instrument works".

**2. `judgeSink` (item 12) has no negative control at all.** Named as debt for three rounds now. An
independent critic once deleted ruling 65's redaction sink entirely and item 12 still passed, because
the fixture's transcript was `"turn detail\n".repeat(30)` — redacting and not redacting produced
identical bytes. That specific hole is closed; the *control* is still missing.

**3. Item 7 pushes surviving post-reap processes to `did` only — the harness leaking processes blocks
nothing.** An item that reports a leak without failing on it is an item that will be believed.

**4. `src/serve/` is the last unbuilt slice.** brigadier as an ACP agent so Zed and JetBrains can drive
it. Four methods are enough, confirmed against real Zed; report fan-out progress by **re-sending the
stable `plan`**, because `plan_update` is UNSTABLE and Zed silently ignores it. It gates none of the
thirteen, so it is genuinely optional — but it is the only promise in ruling 2 with no code behind it.

**5. Windows has never run.** `WINDOWS-BRIEF.md` (repo root, not `scratchpad/`) plus a verified 1.8 MB
`git bundle` — the branch transfers without a push. The Windows process reader
(`Get-CimInstance Win32_Process`), the `taskkill /T /F` branch and the `cmd /c start` escapee have
never executed anywhere. **Its STOP section is load-bearing:** `bar/lib/proc.ts` plants a scratch
`HOME` while passing the real `USERPROFILE`, and `src/plugin/install.ts` prefers `HOME` on every
platform — if Windows resolves the other way, item 10 installs into the operator's real profile.

**6. Item 1 is the only item bypassing `combine`, so it emits no `halves`.**

## Debt left deliberately — do not rediscover it

- **`bar/lib/item13-cost.ts`'s 20-regex pattern table has no mechanical link to its sources**, and the
  builder declined to build one with a reason worth keeping: `contract.ts` works because it compares
  two TypeScript *declarations*, parseable on both sides. The regex table matches **rendered prose from
  template literals** — the emitted string exists nowhere in the source to compare against. Checking it
  mechanically means either evaluating templates (running `src/` code from `bar/`, which
  `bar/self-check.test.ts` forbids) or fuzzy-matching source text, which drifts in its own right. The
  honest substitute — unclassified fails loudly, quoting the line, costing one edit — is in place and
  caught three drifts in one round. **A real mechanism is a design change to how `bar/` learns product
  strings. Worth a ticket, not a patch.**
- **Ruling 65's four encodings do not compose.** A secret containing a quote or backslash is
  JSON-escaped into `config.json`, then escaped again into the ACP frame. Owner ruled 2026-08-19:
  record it, fix the fixture only. The product is unchanged and the gap is named.
- **~~`scripts/claims.ts` and `scripts/license-gate.ts` share a `new URL(…).pathname` bug~~ — CLOSED
  2026-08-20, and the note was wrong twice.** `scripts/license-gate.ts` never had it: it imports
  `REPO_ROOT` from `scripts/inventory.ts:37`, which is `resolve(import.meta.dir, "..")`, and
  `import.meta.dir` is already a decoded filesystem path. Sending a reader hunting a bug that was
  never there costs as much as missing one. And the bug was **not** confined to `scripts/` — it was at
  **24 sites in 22 files** across `test/`, `bar/`, `scripts/` and `vendor/`, where it made every
  subprocess-driven CLI test unreachable on Windows. All 24 now use `fileURLToPath` from `node:url`,
  and `test/path-idiom.test.ts` scans `src/ test/ bar/ scripts/ vendor/ probes/` so it cannot return.
- **`scripts/license-gate.ts` contains a NUL byte**, so plain `grep` reports **zero matches** on it
  rather than an error. Use `grep -a`. Recorded in that file's own header.
- **The build stamp's `dirty` field counts `git status --porcelain` lines including untracked files**,
  so on a dirty tree the binary's bytes move with unrelated scratch files. On a clean checkout it is 0.
  Counting only tracked changes would call a tree with an uncommitted compiled-in file "clean" — the
  worse error.
- **A docs-only commit changes the binary**, because the stamp carries the commit sha. "Same source
  tree, same binary" holds; "same `src/`, same binary" no longer does. Two builds of one tree are
  byte-identical, verified with `cmp -l`.

## Owner decisions — Stephen's, not yours

- **The warm-start budget.** 15.63 ms against 10 ms, and neither number was ever measured on this
  product. This is the only thing between the project and 13/13.
- **May the report cap a checker's tail?** Ruling 58 requires O(items); the report carries
  `VERIFY_TAIL_LINES = 12` lines of checker output per failing item, which is O(work). Round 16 capped
  line **width** at 320 characters — that keeps every check and every outcome, so ruling 52 holds and
  it needed no ruling. Dropping tail **lines** is a different question and is the owner's. Related:
  **checks-per-item is unbounded by the renderer** (1 item × 300 checks ≈ 3,778 tokens) and ruling 52
  forbids printing fewer checks.
- **Push the branch so `gates.yml` finally runs.** It exists and has **never executed**. Every CI run
  this project has ever had is `portability`, which ruling 62 says is not a gate — so "gates green" has
  meant *green on one macOS machine* for the entire life of the project.
- **Rounds 15 and 16's BAR.md amendments are not on the map.**
- **Counsel's LGPL review** still carries two findings: `WTF/wtf/text/Base64.cpp` is **LGPL v2 only**
  (297 of 302 say "or later"; five do not), and tinycc ships **3 plain-GPL files** of which only
  `lib/libtcc1.c` carries the linking exception.

## The cost claim, re-confirmed — drive the bar freely

A full `--live` pass costs **nothing** and takes **46 seconds**. Confirmed independently four times
now. Every item that drives a plan overrides `PATH` to `isolatedPath(binDir)` and plants shims that
exec `bar/fakes/vendor.ts`; `npx` and `node` live under `~/.nvm`, outside that PATH, so rulings 4 and
44's bridged profiles structurally cannot launch; `baseEnv()` is a 13-name allowlist carrying no
credential. Item 5 is the only item touching the real fleet, and only to **detect**. The one
real-money path is `bar/lib/item5-verifier-transcript.ts` behind `--yes-spend-real-vendor-money`, which
the bar never invokes. **`HARNESS_RUN_TIMEOUT_MS` is a ceiling only a hang consumes, not a cost.**

## Machine discipline — put in every builder brief, verbatim

- **NEVER generate load deliberately.** To tell contention from a real failure, run the test **alone**.
- **The machine is never quiet by default.** Two or more other Claude sessions run on it. **Poll
  `uptime` every 60 s until load1 is below 3.0 before any measurement**, and record the load you
  proceeded at. Round 15 got one failure at load 6.50 that two later runs alone could not reproduce;
  that discrepancy is still unresolved and must not gain a second data point.
- **One test process at a time.** Builders run only the single test files they own, **by path**. No
  bare `bun test`, no `bun run gates`, no `bun run build`, no `bar/run.ts` end to end — the coordinator
  runs those once, alone, at the end. A builder that runs the full suite invalidates every other
  builder's measurement.
- **`test-gate` writes its log to `$TMPDIR/brigadier-test-<pid>.log` and cleans it up.** Redirect to a
  file you own. Two agents have lost failure names by piping to `tail`.
- Never `cmd | head` then read `$?` — that is `head`'s exit code.
- Never capture multi-line output into a shell variable; redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and silently skipped an entire package.
- **Every spawned process must be reaped, including grandchildren.** Every fixture loop needs a `sleep`.
- **Cleanup must never sit downstream of an unbounded `wait`.** Fixed in `proc.ts` and `inflight.ts`;
  do not reintroduce.
- `kill %1` and other `%N` job specs are **inert in a non-interactive shell** without `set -m`.
- **Do not delete `~/.brigadier-bar*` wholesale.**
- `ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"` before finishing; kill
  anything of yours and **report what you found**. Cursor helper processes matching only on the repo
  path are the operator's — do not kill them.
- Record results as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense.
- **A negative result is a good result.** Report it plainly and do not reword a probe until it passes.

## Cadence

Fan out builders on **disjoint owned paths** in one message. Pair every builder with a **separate
blind critic** that never sees the builder's reasoning and inspects the real artifact — the diff, the
test output — not the builder's description of it. Lens diversity beats vendor diversity (ruling 62e).
Then: return each gap to its builder **unsoftened** → reconcile the seams → gates **once**, alone, on a
quiet machine → drive the bar → commit → report in under fifteen lines.

Round 16's critics earned their cost four times out of four, and no builder disputed a finding. Two
builders deleted their own work rather than repair it once the measurement said it did not pay — the
report's dedup rung fired in a 130-token window and had two ways to state something false; it is gone.
**That is a good outcome, not a failure. Say so, so the next one does it too.**

Keep going until the owner stops you. Do not ask whether to continue.
