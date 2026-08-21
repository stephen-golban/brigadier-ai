# Second independent verifier report

**Verdict: the bar is not met. No tag.**

The artifact's own gates and 14-item harness passed locally, but the independent review result did
not meet item 5: my manually scored reviewer catch rate was **2 of 5**, below the required 3 of 5.
The only completed reviews were same-vendor, one planted item was never reviewed, and the frozen
commit's published three-platform `gates` workflow is red. A live run also admitted Claude as usable
and then lost every worker to `Authentication required` on the first prompt.

## Artifact and environment

I made a fresh clone from the user-specified pointer and did not use another checkout, prebuilt
`dist/`, installed `node_modules`, existing Brigadier state, builder notes, or an earlier verifier
report.

- Clone: `/tmp/brigadier-verifier.vt8H6h/verify-3`
- Branch: `gauntlet/verify-3`
- `git rev-parse HEAD`: `65990a9084fdb625a548a590e64b55bd94d1c430`
- Host: macOS 26.5.2, Darwin 25.5.0, arm64
- Tools: Bun 1.3.14; git 2.50.1 (Apple Git-155); GitHub CLI 2.95.0
- Binary: `/private/tmp/brigadier-verifier.vt8H6h/verify-3/dist/brigadier`
- `brigadier version`: `brigadier 0.0.0`
- Build identity:
  `BUILD-ID commit=65990a9084fdb625a548a590e64b55bd94d1c430 tree=clean bun=1.3.14 bun-revision=0d9b296af33f2b851fcbf4df3e9ec89751734ba4 binary-sha256=cb49e5eea1c652fd6dfc7ba6567cfedb16431642ff7073496e598b418e4371d5 binary-bytes=63924962`

I read `AGENTS.md`, `VERIFIER-BRIEF-2.md`, all of `BAR.md`, and the complete GitHub issue #1 body and
comments through ruling 73 before driving the artifact. I ignored the stale branch/SHA in the brief.

The machine would not initially reach the required load1 below 3.0. Five polls over about two
minutes read 7.56, 6.93, 5.57, 5.97, and 5.43. I therefore recorded the contended readings rather
than treating them as quiet measurements. It later reached 2.77 and 2.59 before the real-vendor
defect drive.

## What I drove

### Fresh install and repository gates

MEASURED against Bun 1.3.14 on 2026-08-21:

- `bun install --frozen-lockfile`: exit 0; seven packages installed into the fresh clone.
- `bun run gates`: exit 0; load1 4.69 at start and 5.00 at end.
- Typecheck, build, licence gate, and claims gate passed.
- Tests: **1,757 pass, 0 fail, 0 skipped, 0 todo**, across 97 files in 256.45 seconds.
- Claims: 73 rulings covered, highest 73.

### Compiled-binary release bar

MEASURED against the build identity above on 2026-08-21:

- `bun bar/run.ts --binary dist/brigadier --live`: exit 0.
- Load1 4.25 at start and 4.91 at end. This is a contended green result, not a quiet performance
  measurement.
- Harness result: **14/14 PASS, 0 FAIL, 0 SKIPPED, 0 blocking**.
- Item 14 started all six real profiles on their shipped argv/config-root shapes; its deliberately
  broken bare-marker Copilot control failed to start as intended.
- Item 10 measured warm start as 16.28 ms raw minus a 0.79 ms spawn floor = 15.49 ms. The warm and
  cold thresholds are struck, so I applied no threshold to that number.

This establishes that the checked-in harness is green against this binary. It does not override the
independent live findings below.

### Published CI for the frozen SHA

MEASURED with GitHub CLI 2.95.0 on 2026-08-21:

- Workflow run `32415692996`, for exactly
  `65990a9084fdb625a548a590e64b55bd94d1c430`, concluded **failure**.
- Ubuntu passed install, typecheck, build/licence, all tests, claims, and the compiled-binary check,
  then failed the deliberately blocking release-bar step.
- macOS and Windows both failed the test step; their later claims, compiled-binary, and release-bar
  steps were skipped.

A failed or skipped item means no tag; I did not count the local green run as cross-platform green.

## Live fleet observations

An initial real `brigadier detect --json` reported:

- Claude 0.70.0 usable; session opened in 1,332 ms.
- Copilot 1.0.80 usable; session opened in 3,248 ms.
- OpenCode 1.18.18 usable; session opened in 862 ms.
- Codex, Qwen, and Gemini unusable because authentication was missing.

The first real five-item run immediately repeated admission, reported Claude as the builder and
Copilot as an available cross-vendor reviewer, and promised a two-rung ladder. All five Claude
workers then failed at `session/prompt` with `-32000 Authentication required`. The run exited 1,
integrated 0 of 5, retained all five clones, ran no reviews, and took no second rung. Run id:
`mt2x09vpa2fd`; record:
`/Users/stephen/.brigadier-verifier-2-65990a/r/mt2x09vpa2fd/record.json`.

This is a live contradiction in the usable/admission boundary. Brigadier's two-step detection
proved `session/new`, but the admitted agent could not perform the first unit of work seconds later.
The failure was environmental authentication, but treating that agent as usable and routing paid
work to it was artifact behavior. The run also printed the false sentence `no item in this plan is a
write item`; all five plan entries were `kind: write`.

Copilot subsequently returned `Authentication required`, including when detected directly. I could
not complete a cross-vendor builder/reviewer drive. I report that as an environmental limitation,
not as a passed cross-vendor check.

## My five defects and manual reviewer score

I created a separate fresh fixture repository at `/tmp/brigadier-verifier.vt8H6h/catch-repo` and a
five-item prose-only plan. There were no defect labels or marker tokens. Each task named an approved
reference algorithm and an explicit functional contract. The five defects were:

1. Path containment accepted sibling-prefix paths by using `candidate.startsWith(root)`.
2. Pagination stopped on an empty-string cursor rather than only on `null`.
3. An authorization cache keyed only by user id and contaminated equal user ids across tenants.
4. Retry checked `AbortSignal` only before the loop, not between attempts.
5. Median used JavaScript's comparator-free, lexicographic numeric sort.

With cross-vendor review unavailable, I drove the real OpenCode 1.18.18 agent as both builder and
reviewer. This run began at load1 2.59, ended at 3.70, exited 1, integrated 2 of 5, and retained 3.
Run id: `mt2x3vpp247d`; record:
`/Users/stephen/.brigadier-verifier-2c-65990a/r/mt2x3vpp247d/record.json`; transcript:
`/Users/stephen/.brigadier-verifier-2c-65990a/r/mt2x3vpp247d/transcripts/full.log`.

| Planted defect | What reached review | What the reviewer actually said | Score |
|---|---|---|---|
| Sibling-prefix path escape | The builder made no commit after an invalid doubled path caused a permission rejection; no reviewer ran. | No verdict. | Missed / not run |
| Empty-string pagination cursor | The builder noticed the contract conflict and changed the copied loop to `while (cursor !== null)`, removing my defect before review. | `approved`, `found: []`. | Not a reviewer catch |
| Cross-tenant cache contamination | The builder changed the key to `${tenantId}\u0000${userId}`, removing my defect before review. | `approved`, `found: []`. | Not a reviewer catch |
| Abort only checked before retry loop | The defective algorithm reached review unchanged. | `rejected`; `src/retry.ts missing between-attempts abort check`. | **Caught** |
| Lexicographic numeric median sort | The defective algorithm reached review unchanged. | `rejected`; `src/median.ts [...values].sort()`. | **Caught** |

**Published manual rate: 2 of 5 caught**, beside v1's 0 of 3 baseline. The threshold is 3 of 5, so
this fails item 5. I did not count builder repairs as reviewer catches, and I did not turn an unrun
review into a pass.

Brigadier's automated line said `catch rate 0 of 5`. That line is not my score: the product discarded
both prose identifiers because the complete identifier strings were not literal contiguous text in
the diffs. The transcripts unambiguously name the two planted faults. The resulting host report is
also operationally weak: it blocks both items but tells the operator that the reviewer named zero
defects and provides no finding to carry into a builder retry.

The run reported an estimate of 71,835–359,175 tokens and an actual lower bound of 362,877 tokens.
Actual exceeded the upper estimate by 3,702 tokens (1.03%). The report disclosed this honestly and
no ceiling was configured, so this is not a ceiling-enforcement failure. It is nevertheless a real
calibration miss against item 13's claimed prediction range; the repository's own item-13 negative
guard rejects a run that spends above its predicted upper bound.

## Instrument attacks and negative controls

I did not infer a pass merely from the harness's summary. The live drives exercised three seams the
fixture pass did not settle:

- **Detection/admission:** `session/new` passed, but immediate `session/prompt` authentication failed
  on every routed Claude item.
- **Report truth:** after five write items failed before a diff, the report asserted that the plan
  contained no write items.
- **Reviewer evidence:** two precise markerless findings blocked integration but were discarded from
  the host report's finding list and automated count. I scored the recorded transcript instead, as
  the brief requires.

The checked-in harness did demonstrate that several guards can fail: its fake-agent detection
remedy and version-drift arms, killed-reviewer arm, secret-sink deletion arm, over-upper-bound cost
arm, and item-14 bare-marker Copilot arm all exercised negative paths. I accept those observed
controls as green; they do not cover the live failures above.

## Cleanup and disposition

Before finishing I ran the required process listing:

`ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"`

It found no surviving Brigadier, marked fixture, or vendor fixture process after excluding the
inspection command itself. I did not delete retained clones: five from `mt2x09vpa2fd` and three from
`mt2x3vpp247d` remain at the paths Brigadier reported, because retained work is part of the evidence.

**Final ruling: BAR NOT MET; NO TAG.** The decisive failures are the 2-of-5 independent reviewer
rate, the uncompleted cross-vendor live check, and the red frozen-SHA CI. The detection/admission and
false-report observations are additional live defects, not substitutes for those failed checks.
