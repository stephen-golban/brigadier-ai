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
/Users/stephen/Development/brigadier-v2-gauntlet-build   branch gauntlet/build   HEAD 07b0d0a
```

Fifteen commits ahead of `main`. `cd` there. Nothing merged, nothing pushed, and `main` itself is
still 30+ commits ahead of `origin/main`.

## Read these, completely, then stop reading and start delegating

1. **The map — issue #1, in five places.** Rulings 1–48 in the body, 49–72 in three comments, two
   measurement amendments in two more.

   ```
   gh issue view 1 --repo stephen-golban/brigadier-ai --comments
   ```

2. **`BAR.md`** — thirteen items. **It now carries four owner rulings from round 15 that are NOT yet
   in issue #1.** Recording them there is outward-facing and needs the owner's say-so — ask.
3. **`AGENTS.md`** — the non-negotiable disciplines.

Do not read `src/` yourself. Send a subagent for an interface map.

## Where the build stands

- **Gates green: 1321 tests, 0 fail, 0 skipped, 0 todo, exit 0** (was 1135).
- **The bar: 10 of 13 PASS, 3 FAIL, 0 SKIPPED** (was 6 of 13).
  Failing: **10, 11, 13**.
- A printer fake and a forger that writes `fsck`-clean refs both still score 0/13, checked in as
  controls. The honest fixture was rebuilt this round and can now actually fail.

## THE COST CLAIM IN THE LAST HANDOFF WAS FALSE. Read this before planning anything.

The previous version of this file said a full `--live` pass costs ~60 minutes and real vendor tokens.
**It costs nothing.** Traced across all thirteen items and confirmed independently three times:

- every item that drives a plan overrides `PATH` to `isolatedPath(binDir)` — `binDir` plus
  `/usr/bin:/bin:/usr/sbin:/sbin` — and plants shims that exec `bar/fakes/vendor.ts`;
- `npx` and `node` live under `~/.nvm`, **outside that PATH**, so rulings 4 and 44's bridged profiles
  (`claude`, `codex`) structurally cannot launch;
- `baseEnv()` is a 13-name allowlist carrying no credential.

Item 5 is the only item that touches the real fleet at all, and only to **detect**: `brigadier detect`
opens `initialize` + `session/new` and closes. `session/prompt` is never reached.

So **"6 of 13 PASS driven `--live` against real vendor agents" measured planted fixtures on a
harness-controlled PATH.** That is still a real measurement of brigadier's behaviour — the two liar
fixtures scoring 0/13 prove that — but it is not what the sentence said. `--live` gates the *second
half* of the ten items that have one; without it they return `skipped`, which blocks like a `FAIL`.
The "5 minutes per item" figure is `HARNESS_RUN_TIMEOUT_MS`, a ceiling only a hang consumes.

**Drive the bar freely. It is single-digit minutes and bills nothing.** The only real-money path is
`bar/lib/item5-verifier-transcript.ts`, behind `--yes-spend-real-vendor-money`, which the bar never
invokes — two agent sessions per plan item, ~22 minutes worst case for a one-item plan.

## The lesson, now proven seven times out of seven

The last handoff said the INSTRUMENT was the defect ten times. **Round 15 audited seven items and
found all seven reporting green on something they were not checking:**

- **5** — the published catch rate was `FIXTURE_CAN_SPOT`, the harness's own constant, equal to
  BAR.md's `3 of 5` threshold to the digit. It could not exceed the bar, nor fall below it without
  failing, and so could neither confirm nor falsify the assumption it exists to settle.
- **7** — a check iterated an empty list and had passed vacuously for nine rounds. Another read the
  retained clone's byte count from the *harness's own* `stat`, so a product printing no size passed.
- **9** — an ambient file planted under `$HOME`, which `buildEnvironment` inherits, was **obeyed**;
  the worker wrote an undeclared path; ruling 51 rejected the item whole; and "no path carries the
  marker" was true **because the marker was written**.
- **10** — the hook check read `brigadier plugin hooks`, a string compiled into the binary regardless
  of whether install did anything. And `Checks.note()` stamps `ok:true`, so on a machine without
  `claude` the item printed PASS with BAR.md's named instrument never run — with a unit test
  asserting that as correct.
- **11** — `includes("fifty-4")` can never detect the cap hiding item `fifty-4`, because `fifty-43`
  contains that string.
- **12** — it passed with ruling 65's redaction sink **deleted**, because `honest.ts`'s transcript was
  the constant `"turn detail\n".repeat(30)`: redacting and not redacting produced identical bytes.
- **13** — the ceilings were in **dollars** against a product that counts **tokens**, so the first
  wire frame crossed them, nothing dispatched, and every downstream check failed for unrelated
  reasons.

**Items 9 and 12 are the same defect found independently by agents who never spoke.** An undeclared
path makes ruling 51 reject the item whole, and the scan then reads an empty integration as an
absence. That is a flaw in how the harness writes plans.

So: when an item fails, ask **is the harness looking at the right thing?** and **would this check
still pass if the property vanished?** Assert on names, never counts. And a corollary this round
added: **a fixture that cannot fail the check it is a fixture to is not a control.**

## What is left, in priority order

**1. Item 11 is a real product finding — start here.** A fifty-item report is **6,953 chars ≈ 2,121
tokens against ruling 58's 2,000 ceiling**, and to fit it **drops checks**: 18 recorded, several
absent from their item's block. Ruling 52 is explicit — under space pressure print **fewer items,
never fewer checks**. This only became visible once the fixture rendered realistic per-item output.
Fix the product, not the item.

**2. Item 13 needs triage before it is called a product failure.** Three sub-failures, at least one
of them instrument: the triple check expects `(copilot, undefined, …)` where the product renders
`(copilot, unrouted, …)` — the harness stringifies a missing model, the product names it. The
no-ceiling negative control also counts admission lines as ceiling lines. **One may be real:** the
hard ceiling did not report cancelling work already running. Separate them before touching anything.

**3. Item 10 fails deliberately.** Warm start **13.99 ms** on a quiet machine (min of 40,
floor-corrected against a 1.28 ms spawn floor) against an unadjusted **10 ms** budget — 3.99 ms over.
The budget is not to be relaxed; §17's proposed 20 ms exists as a note and gates nothing. The warm
figure has now been recorded three times against three different artifacts (11.29 / 16.13 / 13.99 ms)
and **what changed between them is not established** — no build identifier ties any figure to an
artifact. Do not read a trend into it.

**4. Windows has never run, and the brief is written.** `scratchpad/WINDOWS-BRIEF.md` plus a verified
1.8 MB `git bundle` — the branch transfers without a push. The Windows process reader
(`Get-CimInstance Win32_Process`), the `taskkill /T /F` branch and the `cmd /c start` escapee have
never executed anywhere. **Its STOP section is load-bearing:** `proc.ts` plants a scratch `HOME` while
passing the real `USERPROFILE`, and `install.ts` prefers `HOME` on every platform — if Windows
resolves the other way, item 10 installs into the operator's real profile.

**5. Not started:** `src/serve/` — brigadier as an ACP agent so Zed and JetBrains can drive it. A
from-scratch build, not a fix; it gates none of the thirteen.

## Debt left deliberately — do not rediscover it

- **Nothing mechanically keeps `bar/lib/contract.ts` in step with `src/report/record.ts`.** Round 15
  proved hand-transcription fails **silently**: three agents worked around the drift rather than
  items failing loudly. `CheckOutcome` had listed `skipped`, which the product never emits, and
  omitted `not-run`, which is `INITIAL_OUTCOME`. Fixed once; nothing stops it recurring.
- `judgeSink` (item 12) has **no negative control at all**.
- Item 7 pushes surviving post-reap processes to `did` only — **the harness leaking processes blocks
  nothing.**
- Item 1 is the only item bypassing `combine`, so it emits no `halves`.
- `headLine`/`itemLine` and `readProcessTable`/`listProcesses` are duplicated, with a comment in one
  claiming to use the other.
- Six phrasings exist for "we could not measure this" and five for "the control that proves the
  instrument works".

## Owner decisions — Stephen's, not yours

- **Ruling 65's four encodings do not compose.** A secret containing a quote or backslash is
  JSON-escaped into `config.json`, then escaped again into the ACP frame; `redact.ts` enumerates four
  *flat* forms and misses the composition. BAR.md's stated limit covers it, but the scheme is the
  ordinary transport, not an exotic one. **Ruled 2026-08-19: record it, fix the fixture only.** The
  product is unchanged and the gap is named. Revisit if it should be closed properly.
- **Round 15's four BAR.md amendments are not in issue #1.** Posting them is outward-facing.
- **`gates.yml` now runs the bar, blocking, on all three legs — and has still never executed.** The
  owner accepted a red gate. The step says: *do not tune anything to make this green.*
- Counsel's LGPL review still carries two findings: `WTF/wtf/text/Base64.cpp` is **LGPL v2 only**
  (297 of 302 say "or later"; five do not), and tinycc ships **3 plain-GPL files** of which only
  `lib/libtcc1.c` carries the linking exception.

## Machine discipline — put in every builder brief, verbatim

- **NEVER generate load deliberately.** To tell contention from a real failure, run the test **alone**
  on a quiet machine.
- **One test process at a time.** No background suites. Full `bun run gates` **once**, at the end,
  **and only once the tree is quiet** — round 15's coordinator started gates while a builder was
  still running, got one failure at load 6.50, and two later runs alone passed 1321/0. **That
  discrepancy is unresolved:** contention and flake are not distinguishable from that evidence.
- **`test-gate` writes its log to `$TMPDIR/brigadier-test-<pid>.log` and it is cleaned up.** Two
  separate agents lost failure names by piping to `tail`. Redirect to a file you own.
- **Every spawned process must be reaped, including grandchildren.** Every fixture loop needs a `sleep`.
- **Cleanup must never sit downstream of an unbounded `wait`.** `proc.ts` and `inflight.ts` did
  exactly this — killed on timeout, then awaited the stream unbounded; **measured still blocked at
  12 s after a 2 s kill**, on the path every item reaches through `ctx.run`. Fixed; do not reintroduce.
- `kill %1` and other `%N` job specs are **inert in a non-interactive shell** without `set -m`.
- **Do not delete `~/.brigadier-bar*` wholesale.**
- `ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"` before finishing;
  kill anything of yours and **report what you found**.

## Cadence

Fan out builders on **disjoint owned paths** in one message. Pair every builder with a **separate
blind critic** that never sees the builder's reasoning and inspects the real artifact. Lens diversity
beats vendor diversity (ruling 62e). Then: return each gap to its builder unsoftened → reconcile the
seams → gates once on a quiet machine → drive the bar → commit → report in under fifteen lines.

Round 15's critics earned their cost every single time: one found the catch-rate constant, one found
the `ok:true` note that gated nothing, one found a broadened predicate computed and never used. **The
unit tests demanded of builders found two more holes that the builders had introduced while fixing
the originals** — including a fixture feeding the detector its own needle, so a control passed with
the product's statement deleted.

Keep going until the owner stops you. Do not ask whether to continue.
