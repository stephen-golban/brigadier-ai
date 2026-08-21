# Owner's questions — collected 2026-08-20 by the CI round, ruled 2026-08-20, extended 2026-08-21 by the second verifier

Written by the CI round (branch `gauntlet/ci`). Everything here was found while answering *why has CI
never passed on any platform*. Each entry states the question, the options, and what each option costs.

**STRUCK entries were RULED on 2026-08-20 by the coordinator, the owner having delegated the rulings
for that round.** A struck entry is not a deleted one: the ruling lives in the file the decision
governs — that is what ruling on something means here — and the entry is kept, marked, and pointed at
it, so the reasoning that was available at the time can be read against what was decided. Entries not
yet marked are still open and still red.

The rule this file obeys is `BAR.md`'s: *"Scaling the bar down is the owner's call. Doing it silently
is not available to anyone."*

| # | subject | state |
| --- | --- | --- |
| 1 | detection cache: does `run` trust it | **RULED — left as it is, and closed** |
| 2 | does `brigadier detect` get a ruling | **RULED — ruling 73, in** |
| 3 | the 63 MiB size clause | **RULED — struck, and replaced by a budget on brigadier's own contribution** |
| 4 | ruling 15's directory identity on ext4 | **RULED — a clone token, old entries refused** |
| 5 | `Check` as a discriminated union | **RULED — deferred to its own round; the audit's expiry closed now** |
| 6 | eleven Windows tests that render `(pass)` | **RULED — made blocking failures, named** |
| 7 | an `execute` that asked no permission | open — recorded, not concluded |
| 8 | the verifier's `Authentication required` | **CLOSED INTO #14** — reproduced 2026-08-21 on a second bridge by a second verifier |
| 9 | Windows: the bar harness grades blind | **SEPARATED BY EXPERIMENT — neither candidate alone; the conjunction. Fixed.** |
| 10 | `bar/fakes.test.ts` on the POSIX legs | **DIAGNOSED — both open rows, and one attribution withdrawn** |
| 11 | `bar/lib/orphan.test.ts` flakiness | **DIAGNOSED — a real leak defect, fixed and measured** |
| 12 | **NEW** — a `brigadier run` is 35-160x slower on windows-latest | open, undiagnosed |
| 13 | a dozen planted-payload controls are inert on Windows | **ANSWERED — all three candidates refuted; the cause is the command path's backslashes, which the experiment had normalised away in its own setup** |
| 14 | detection says usable, the first prompt fails authentication | **PARTLY RULED** — the per-item cost is fixed and its cost recorded; the detection gap is open and needs a per-vendor measurement first |
| 15 | the report said the plan had no write items when all five were | **FIXED** — reproduced in a test that fails without the fix; the sentence now comes from the plan |
| 16 | reviewer findings discarded from the host report; item 5 failed at 2 of 5 | **PARTLY FIXED** — the finding text is carried now; the 2-of-5 rate is open and still blocks the tag |
| 17 | **NEW** — actual spend exceeded the predicted upper bound by 1.03% | open — reported honestly, no ceiling configured, one data point |

---

## 1. ~~Does `run` trust the detection cache?~~ RULED 2026-08-20 — the split STANDS

**RULED: leave it.** Recorded in `DETECTION-CACHE.md` under *The one open judgement*, which is the file
the decision governs, with the accepted cost written out: every `run` pays the 3.28–4.29 s sweep for
as long as this stands, and ruling 71's own accepted-cost sentence still reads as though only a first
run does — a mismatch this ruling does not remove.

**The reason is the absence of one.** Carried across two rounds with no new evidence in either
direction, which is the answer to "is there a measured reason yet". The directions are not symmetric:
widening is one line, narrowing back after a stale admission means re-introducing a wait users have
stopped paying, in response to an intermittent failure. Carrying it a third time would have been a
decision by default rather than a decision. What would re-open it is named there.

Carried forward unchanged; this round found no new evidence either way, which is itself the answer to
"is there a measured reason yet". There is not.

Ruling 71's accepted cost reads *"a **first** run pays a full detection sweep"*, as though later ones
do not. The shipped split makes **every** `run` pay it and serves only `plan` / `--dry-run` /
`--estimate` from state.

| option | cost |
| --- | --- |
| **Leave it** (every `run` re-probes) | Every run pays the sweep — MEASURED 3.28–4.29 s cold on the owner's machine with six vendors. Nothing is blocked. |
| **Widen it** (`run` trusts the cache) | One line in `trustCache`, `src/cli.ts`; everything needed to make it honest already exists. Buys back that 3–4 s per run. **Risk:** a stale cache admits a run that then fails at its first prompt — which is the defect the independent verifier found on 2026-08-20, and it would be found the same way again. Narrowing back afterwards is not symmetric with widening. |

**Recommendation: leave it.** Re-open when there is a measured cost to weigh against a stale admission.

---

## 2. ~~Does `brigadier detect` get a ruling?~~ RULED 2026-08-20 — ruling 73

**RULED IN.** `brigadier detect` is a first-class subcommand and ruling 71's named repair. The ruling
is recorded in the record's own form — **ruling 73 on issue #1**, closed under delegated authority on
2026-08-20 — and cited by `BAR.md`'s coverage table and `bar/items/01-detection-is-honest.ts`.

Three accepted costs, stated there rather than summarised here: a fourth verb on a surface ruling 71
kept small; two repair paths instead of one, where the failure mode is one of them silently ceasing to
repair (both are driven by `test/cli-run.test.ts` today); and `detect` reporting the world at the
instant it ran, which narrows the stale-admission window the independent verifier found and does not
close it. What it does NOT decide is #1 below — whether `run` trusts the cache — which stays open.

The reasoning as it stood before the ruling follows.

**It is a shipped command that the ruling record does not contain.** VERIFIED 2026-08-20 by reading
issue #1's body and all six comments end to end: the string `brigadier detect` appears **nowhere**,
and `detect` is never named as a subcommand anywhere in the record. The only command-shaped names in
the whole record are `brigadier run`, `plan`, `brigadier status`, `brigadier licenses`,
`brigadier competence`.

Ruling 71 settles the *shape* — no `init`, detection is lazy inside a run, cached as state, and
deleting state is the supported repair — and detection appears in it only as a behaviour, never as an
entry point. So `detect` is not an implementation of an existing decision; it is a new one.

It is not idle: bar item 1 drives it, and since ruling 71's cache landed it is also **the repair
path** — `detect` is the thing that probes and rewrites when `plan` is being served stale state.

| option | cost |
| --- | --- |
| **Rule it in** | The coverage table can cite a ruling for a command it already grades. Costs one ruling, and admits a fourth verb to the surface ruling 71 deliberately kept small. |
| **Rule it out / remove it** | Bar item 1 loses its driver and the cache loses its named repair; `rm ~/.brigadier/detect.json` becomes the only repair, which ruling 71 does say is supported. |
| **Leave it unruled** | Status quo. The coverage table cannot cite a ruling for a shipped command, which is exactly the *"one-line way to make the bar lie"* ruling 48 warns about. |

**Recommendation: rule it in.** It exists, it is graded, and it is load-bearing for the cache. No
ruling was invented here.

---

## 3. ~~Is item 10's 63 MiB size clause struck, like its two siblings?~~ RULED 2026-08-20

**RULED: STRUCK, in the open, and replaced by a budget on a different statistic.** The ruling, its
three reasons, the replacement, the measurements it is set against and its accepted cost are recorded
in `BAR.md` under item 10 and in `bar/items/10-the-artifact-ships.ts`'s
`STRUCK_TOTAL_SIZE_BUDGET_BYTES` / `BRIGADIER_SIZE_BUDGET_BYTES`. In one line: the budget is now
`size(artifact) − size(an empty` `process.exit(0)` `binary compiled by the same bun on the same
platform)`, capped at 2,621,440 B, because that is the only part of the number this project sets.

MEASURED 2026-08-20 with `bun 1.3.14`, both platforms, compiling both binaries back to back:
darwin arm64 63,446,114 → 64,750,562 = **1,304,448 B of brigadier**; linux arm64 93,694,096 →
94,939,280 = **1,245,184 B**. The floors differ by 47%, the contributions by 4.5%.

The reasoning as it stood before the ruling follows.

Full evidence in `BAR.md` under *When an item cannot be met*, entry (a). In short:

- The figure's only provenance is **one unsourced sentence** at `MEASUREMENT-SESSION.md:140`, commit
  `7e6a547` — the **same sentence** behind the ≤70 ms and ≤10 ms clauses struck by §23 and §24.
- MEASURED 2026-08-20, an empty `process.exit(0)` bun binary: **60.51 MiB on darwin, 89.35 MiB on
  linux x64.** The Linux floor is 27.6 MB over the budget before brigadier contributes a byte.
- brigadier's own code is **0.75%** of the artifact.

| option | cost |
| --- | --- |
| **Strike the clause** (§23/§24's procedure) | Consistent with the two decisions already made on this exact sentence. The artifact then carries no size promise at all — and size is a real user-facing property, unlike a start-up figure nobody could reach. |
| **Keep it and re-measure the number** | Honest, but there is nothing to measure it *against*: the only source is the sentence §16 disproved. Any new number would be this project choosing one. |
| **Keep it, per-platform** | A budget that is a function of the runtime's own floor plus a brigadier allowance. Costs a decision about what the allowance is; the marginal-cost half of `test/repomap-binary.test.ts` already passes on Linux and is the meaningful half. |
| **Leave as is** | ubuntu-latest stays red on this one test forever. |

**Recommendation: the third.** The budget that means something is brigadier's own contribution, which
is measurable and currently 478,848 B; the floor is Bun's and no decision here changes it. But this is
a strike in substance, so it was not taken.

---

## 4. ~~Ruling 15's directory identity is defeated on ext4 — what replaces the inode?~~ RULED 2026-08-20

**RULED: a clone token, and old manifests are refused rather than accepted.** The ruling is recorded in
`src/isolation/manifest.ts` (`ManifestClone.nonce`), `src/isolation/internal-git.ts`
(`cloneMarkerBody`), `src/run/reclaim.ts` (`DirectoryProof.cloneNonce`, which carries the fork and its
cost) and `BAR.md` entry (b). brigadier generates a random 128-bit token when it records a clone,
stores it in the entry and writes it into the marker; the two must agree.

**The fork this file called "genuinely the owner's" is ruled: REFUSE.** An entry with no token is
unproven and the directory is retained, with a refusal that names the path and gives the remedy.
**Accepted cost: directories recorded by an older brigadier are stranded and must be removed by hand.**
An old entry is by definition the one whose directory has had longest to be replaced, so an exemption
for age applies exactly where the check is needed — and ruling 63 already chose this direction: *a
leaked process can still act, a retained directory is inert and holds someone's only copy.*

`test/run-reclaim.test.ts` gains the ext4 case driven directly (the recorded inode forced to the
impostor's, which is what ext4 does 300/300), the compatibility fork, and a mismatched-token control.
The `KNOWN LIMIT` tests are updated to forge a token as well, so what the token does NOT reach — a
forger who can write the run root — stays asserted rather than argued.

The reasoning as it stood before the ruling follows.

Full evidence in `BAR.md`, entry (b). MEASURED 2026-08-20 on `ubuntu:24.04`, 300 trials of
delete-then-recreate at the same path: **ext4 300/300 and overlayfs 300/300 return the same inode**;
tmpfs 0/300; APFS 0/300. So `sameInode` cannot tell brigadier's clone from a directory that later took
its path — on the ordinary Linux filesystem.

**Birth time is measured dead as a replacement:** `birthtimeNs` was identical in **194/200** ext4
trials. Do not propose it again.

| option | cost |
| --- | --- |
| **A nonce** — brigadier writes a random token into the clone marker at creation and records it in the manifest; identity becomes the token, not the inode | Filesystem-independent and exact. Touches `src/isolation/clone.ts` (2 sites), `manifest.ts`, `internal-git.ts`, `run/reclaim.ts`. Raises a **compatibility question that is genuinely the owner's**: a run recorded by an older brigadier has no nonce — refuse to reclaim it, or accept it? Refusing strands directories; accepting reopens the hole for exactly the runs most likely to be stale. |
| **Accept the limit** and record it | Free. The guard stays real on APFS and tmpfs and vacuous on ext4 — a *"weakened check"* under ruling 32 on the platform ruling 12 makes first class. |
| **Drop the inode condition** and rely on the other two | Worse: the marker and manifest entry are both forgeable by a directory that took the path, which is precisely what the test plants. |

**Recommendation: the nonce**, with old manifests refused and reported rather than silently reclaimed.
Not done here because it changes what a safety guard proves and it has a compatibility fork in it.

---

## 5. ~~`Check` as a discriminated union~~ RULED 2026-08-20 — deferred, with the expiry closed

**RULED: the union is NOT taken now, and that is a decision with a cost rather than a postponement.**
It is a refactor of the verdict type of the instrument that grades the release, at ~41 call sites, and
it needs a round that begins with it and verifies it alone — this file's own recommendation, and
amendment §20 records three occasions on which the instrument became the defect. Starting it at the
end of a long round is how that happens a fourth time. **Until it lands, a note written in a blocked
branch is invisible to `failures`, and nothing makes that impossible.**

**What IS taken now is the half that stops the audit expiring.** The 21-call-site audit was true on
2026-08-20 and says nothing about the 22nd. `Checks.note` now REFUSES at runtime a row whose name
carries this repository's own blocking vocabulary — `FAIL —`, `NOT-RUN —`, `ERROR —` — because a
verdict written through a channel that has none is the confusion the union would make
unrepresentable. It catches the author who knew they were describing a blocked condition and reached
for `note` anyway; it does NOT catch a note whose prose describes one without the vocabulary, and it
cannot, because that is a judgement about meaning. `bar/lib/checks.test.ts` drives both the guard and
**that limit**, so nobody reads the narrowing as the fix.

The audit the debt list asked for is **done and clean**: all 21 `.note(` call sites were read and none
describes a blocking condition (recorded in `bar/lib/checks.ts`). But `note` still writes `ok: true`
into a field it has no verdict for, and `failures` filters `!ok` — so the **next** note written in a
blocked branch is invisible to the verdict.

| option | cost |
| --- | --- |
| **Make it unrepresentable** — `Check` becomes a union whose note arm carries no `ok` | The real fix. Scoped at ~41 call sites **inside the instrument that grades the release**. |
| **Leave it and re-audit** | Free, and the audit is a point-in-time answer that expires the next time someone writes a note. |

**Recommendation: do it, but as its own round with its own verification.** It was not started here:
beginning a refactor of the verdict type at the end of a long round is how the instrument becomes the
defect a fourth time (amendment §20 records three).

---

## 6. ~~Eleven tests that render as `(pass)` on Windows without running~~ RULED 2026-08-20

**RULED: the second option, taken now.** All eleven are converted to blocking failures that name what
did not run and why, through `notRunHere` in `bar/lib/platform.ts`, which carries the ruling and its
accepted cost. `bar/lib/platform.test.ts` proves the helper fails, scans every `*.test.ts` in the tree
for the shape it replaced, and carries a negative control showing the scan can match — eleven of these
accumulated invisibly, and a prose ruling would not have stopped a twelfth.

**The sequencing call this file said was the owner's is made: redder now.** `windows-latest` goes from
~81 failures to ~92. Nothing is more broken than it was; what changes is that the count is true. A CI
that is green because a check was weakened is worse than one that is red honestly, and a count that is
low because eleven checks vanished is the same defect wearing a number.

**Not taken: the first option.** No Windows implementation is written here. Each message names the
mechanism that would have to be built — a `.cmd` refusal shim; a job object or parent-handle wait for
orphan detection; a `cmd /c start` escape fixture for the four `setsid` tests; a `cmd /c` argv shaper
for the marker filter — and until one exists, that test's property is UNPROVEN on Windows, which is
what the failure now says. The cheapest to close is the marker-filter one: `bar/lib/process-table.ts`
already has a real Windows reader, so it is a fixture away rather than a mechanism away.

The reasoning as it stood before the ruling follows.

Not in any failure count, which is the point. Eleven tests carry `if (process.platform === "win32")
return;` **in the test body**, so they report `(pass)` in fractions of a millisecond. `bar/lib/orphan.test.ts`
is the clearest: `(pass)` in 0.36 ms on Windows, and it failed after 20,073 ms on both Ubuntu and
macOS. `scripts/test-gate.ts` counts only skip/todo/fail/error and cannot see any of it.

Ruling 62 (c) is explicit — *"a platform-gated test must run on that platform, so CI on all three is
not optional"* — and amendment §9 records the standing posture: the Windows process reader and the
`taskkill /T` branch are *"written and UNMEASURED, and are deliberately left to fail loudly on
windows-latest rather than hide behind a skip."* Eleven tests are doing the opposite of that.

| option | cost |
| --- | --- |
| **Implement the Windows arm of each** | The honest answer, and it is product work: it requires deciding what containment *means* on Windows, where there is no reparenting and no signal delivery to an arbitrary process. |
| **Convert each to an explicit blocking `not-run` on Windows** | Makes them visibly red rather than invisibly green — ruling 48's shape. Turns 11 silent passes into 11 red tests on a leg that has never been green. |
| **Leave them** | A vacuous pass is the exact *"check that reports success when the thing it checks did not happen"* v1 shipped four times. |

**Recommendation: the second, then the first per test.** Not done here because it makes CI redder
before it makes it greener, and that is a call about sequencing the owner should make.

---

## 7. An `execute` that asked no permission — recorded, NOT concluded

MEASURED 2026-08-20 against `@agentclientprotocol/claude-agent-acp 0.70.0`: with the lane asserted to
session mode `default` (`set_mode` returned `{}` and the agent echoed `currentValue: "default"`), a
prompt turn produced a `tool_call` with `kind: "execute"`, `toolName: "Bash"`,
`command: "echo brigadier-probe-marker"`, `status: "completed"` — and **zero
`session/request_permission` frames**.

**This is not a finding yet and is deliberately not written up as one.** The mode describes itself as
*"Standard behavior, prompts for dangerous operations"*, and `echo` is not a dangerous operation, so
the observation is fully consistent with the mode working as documented. What would settle it is the
same turn driving an operation the mode calls dangerous — a write outside the lane root. That costs
one more real prompt turn (the turn above cost `$0.1156` on the operator's own subscription).

It is here because an unasked-for `execute` is the exact shape ruling 43 and #3 are about, and because
this round's standing instruction was that an honest *"still unexplained"* beats a plausible story.

---

## 8. ~~Still unexplained: the first verifier's `session/prompt: -32000 Authentication required`~~ CLOSED INTO #14 on 2026-08-21

**Reproduced.** The second verifier hit the same signature on bridge 0.70.0, so the paragraph below
about 0.69.0 no longer stands as a reason to doubt the reading. What was unexplained is now
measured twice on two bridges, and the open question moved with it: it is no longer *why did this
happen once* but *what should admission do about an agent that opens a session and refuses the first
prompt*. That question is #14. The entry as it stood follows.

**No second cause is offered, because none was measured.** The obvious candidate was tested again this
round and refused again: under a scratch `HOME` on this machine the Claude bridge reports `usable` —
handshake and session — so the worker-shaped config root does not log it out. Its credential is in the
macOS Keychain, not under the redirected root.

One new fact that does **not** explain it but bears on it: the bridge has moved 0.69.0 → 0.70.0 since
the verifier ran, so the artifact the verifier drove is not the artifact on this machine today.

---

## 9. ~~Windows: the bar harness grades every item blind~~ SEPARATED BY EXPERIMENT 2026-08-20

**Neither candidate is the cause on its own. The CONJUNCTION is.** `bar/lib/capture.test.ts` drives
the 2x2 plus two synchronous controls against a subject that writes a token to both streams and exits
3. MEASURED on `windows-latest`, 2026-08-20:

| cell | exit | stdout | stderr |
| --- | --- | --- | --- |
| sync / direct | 3 | OK | OK |
| sync / `.cmd` shim | 3 | OK | OK |
| async / direct / attached | 3 | OK | OK |
| async / direct / **DETACHED** | 3 | **OK** | **OK** |
| async / **shim** / attached | 3 | **OK** | **OK** |
| async / **shim** / **DETACHED** | 3 | **`<empty>`** | **`<empty>`** |
| through `exec` (the real call site) | 3 | `<empty>` | `<empty>` |

`detached` alone captures. The `.cmd` shim alone captures. Together they lose both streams while the
exit code survives — which is exactly the symptom the triage read off the leg and could not attribute.
Bun reaches a `.cmd` through `cmd.exe`, and a `cmd.exe` created with `DETACHED_PROCESS` does not carry
the harness's pipe handles through to the program it runs. Every fixture binary the bar drives is a
`.cmd` there (`bar/lib/fs.ts`'s `writeScript`), so all fifteen red items on that leg were artefacts.

**The fix is a Windows branch, not a removal** — removing `detached` unconditionally would reinstate
the POSIX leak it exists for. `DETACH_FOR_GROUP_KILL` in `bar/lib/proc.ts` is `process.platform !==
"win32"`, used at both spawn sites (`exec` and `runSampled`) through one constant so they cannot
drift. **Nothing is lost:** `killTree`'s Windows arm is `taskkill /T /F /PID`, which walks the
parent-pid tree and needs no process group at all. **Accepted cost:** a spawned child now shares the
harness's console on Windows, so a Ctrl-C to the harness reaches it too.

The `async/shim/DETACHED` cell keeps asserting the platform fact — output IS lost there — so the
branch stays justified by a measurement. If a future bun or Windows fixes it, that row goes red and
the remedy is to delete the branch, which is the right way round.

The state as it stood before the experiment follows.

Found by log analysis of run 32387095326, **not fixed**, because the cause could not be settled from a
log and there is no Windows machine here.

Every output reading the bar reported on the Windows leg was empty — `item 8: … exit 4; stdout:
<empty>; stderr: <empty>`, and five more like it — while the **exit codes were correct and varied**
(0, 1, 3, 4). So the subject really ran and only its output was lost. All 15 red bar items on that leg
are therefore artefacts, and `bar/fakes.test.ts` took **929 seconds — 54% of the whole leg's wall
time**.

The call site is `bar/lib/proc.ts:180-193`: `Bun.spawn(…, { stdout: "pipe", stderr: "pipe", detached:
true })`. The discriminator is that plain `Bun.spawnSync` with `stdout: "pipe"` and **no** `detached`
captures output fine on Windows in the same run (`bar/self-check.test.ts`, `test/cli-run.test.ts`).

**Two candidates, not separated:** `detached: true` (which on Windows maps to `DETACHED_PROCESS` /
`CREATE_NEW_CONSOLE` and was never Windows-audited) or the `.cmd` shim indirection. Removing
`detached` unconditionally is **not** safe — `killTree` depends on the process group on POSIX. A
Windows-only branch is the likely fix and it needs a Windows box to confirm.

**This is the highest-value single fix left on that leg.** It was not guessed at.

---

## 10. ~~`bar/fakes.test.ts` fails on CI for a DIFFERENT reason on each platform~~ DIAGNOSED 2026-08-20

**Both open rows are diagnosed, one of them against this file's own guess.** Measured by reproducing
the CI failures locally in a Linux container — all three appear there in one 27-second run — rather
than from logs.

**Ubuntu's item 2: a RACE in the harness, not a difference in the product.** `bar/fakes/vendor.ts`'s
`plant-git-payloads` plants the payload files as the LAST thing it does before returning; brigadier
then integrates and sweeps the clone. The sampler polls at 40 ms, and the window is usually shorter
than that on Linux. MEASURED 2026-08-20, ten runs of item 2 against `bar/fakes/honest.ts` per
platform: **darwin 10/10 saw all three payloads; linux 1/10 saw all three, 1/10 saw two of three,
8/10 saw NONE.** Fixed by ruling 62 (d) — bound the work, not the clock: the sampler writes an
acknowledgement once it has read all three files ITSELF, and the planting fixture waits for it, with a
bounded budget so a run with no sampler fails rather than hangs. Re-measured: **linux 10/10, darwin
10/10.** The cost — the sampler now writes one file into a clone — is recorded at
`bar/lib/inflight.ts`'s `PAYLOAD_OBSERVED`.

**macOS's item 13: the arm's OWN soft ceiling, on a host that can run one worker.
THIS FILE'S ATTRIBUTION BELOW IS WITHDRAWN.** It reads *"the fixture's ceilings are pinned from an
earlier run's spend and #44 measured 15× variance"*. The ceilings were already calibrated per run, and
the two uncapped runs measured **425 (linux) against 438 (darwin) — a 3% spread, not 15×.** The real
cause: the hard arm passed `--soft-ceiling hard/2`, so the soft ceiling stopped dispatch first and the
total could only reach the hard ceiling by OVERSHOOT from work already in flight. MEASURED 2026-08-20:
on darwin (24 GiB, feasibility cap 5) all four items were in flight, the overshoot was certain and the
hard ceiling fired, all four `cancelled`, PASS; under Docker (cap 1) only one item was ever in flight,
the run finished at 101 against a 170 ceiling, FAIL. **It was measuring the host's worker count** —
§22's 7 GiB reaching item 13 by a second route nobody had traced. Fixed by passing no soft ceiling in
that arm and calibrating the hard one from what ONE item costs. Re-measured: linux PASS, darwin 3/3
PASS.

**macOS's item 4 is unchanged and unfixable here:** it is §22's 7 GiB, recorded in `BAR.md` (c).

The state as it stood before the diagnosis follows.

### The original entry

Not a question so much as the honest state of the last blocking test on the POSIX legs. It passes on
the owner's machine (14/14, and inside `bun run gates` at 1,716 pass / 0 fail), and fails on CI.
VERIFIED across runs 32394716171, 32396192311, 32398251476 and 32399494690:

| leg | failing bar item | cause |
| --- | --- | --- |
| macos-latest | **item 4** | RAM. §22's 7 GiB, in the binary's own words: *"feasibility cap at 1 worker(s) … Remedy: … about 13 GiB."* **Explained.** |
| macos-latest | **item 13** | *"NEVER REACHED: the run spent 104, under its 175 ceiling — this is the calibration missing, not the product ignoring a ceiling."* The fixture's ceilings are pinned from an earlier run's spend and #44 measured **15× variance between two identical runs**. **Not diagnosed further.** |
| ubuntu-latest | **item 2** | *"all three measured payload shapes were really planted, observed from outside the clone — looked into the live clone directories for hook files carrying payload-… found NONE."* An **in-flight** observation that found nothing. **Not diagnosed.** |

Only the first is explained. The other two are recorded as unexplained rather than attributed, because
"the macOS leg fails on RAM" was the obvious story and it is **half true** — it does not cover item 13
at all, and it covers nothing on Ubuntu.

**Ubuntu's item 2 is the one that most deserves the next look.** It is an in-flight scan — the thing
amendment §11 added precisely because *"a forger can construct any residue at leisure but not a live
process tree"* — and a scan that finds nothing on a fast machine is the shape of a check that could
report success when the thing it checks did not happen. Whether it is a race in the harness or a real
difference on Linux is **not established**, and one sample per platform is not enough to say.

---

## 11. ~~`bar/lib/orphan.test.ts` is flaky on CI, at two different lines~~ DIAGNOSED 2026-08-20

**It was not a flake. It was a second leak defect in the guard, of the same class as the zombie one —
the predicate was right and its PRECONDITION was not.**

`exitWhenOrphaned` opened with `if (parent <= 1) return;`, on the reasoning that a parent of 1 at
start-up means there is nothing to notice the loss of. Not one of these fixtures is started by init: a
ppid of 1 there means the process it exists to serve died between the spawn and that line — so the
guard armed NOTHING and the fixture ran forever. The test made that window reachable by waiting only
for the fixture's pid to EXIST, which is true the instant a shell backgrounds a command and long
before `bun` has loaded a module.

MEASURED against `bun 1.3.14` under `oven/bun:1.3.14` on 2026-08-20 with `probes/orphan-race.ts`,
killing the parent shell at a range of delays after the fixture's pid appeared:

| kill at | outcome |
| --- | --- |
| 0 ms | **SURVIVED the full 20 s, stderr EMPTY** |
| 30 ms | exited after 999 ms |
| 80 ms | exited after 931 ms |
| 150 ms | exited after 884 ms |
| 400 ms | exited after 651 ms |
| 2000 ms | exited after 51 ms |

**The signature matches, and the signature is what identified it.** All three CI failures consumed the
FULL bound — 20,073 ms and 20,080 ms — rather than a spread of times under it, which is what a merely
slow machine produces. Saturation means the guard never fired; it does not mean the guard fired late.

**One hypothesis refuted along the way, recorded as the negative result it is:** `process.ppid` was
suspected of not re-reading `getppid()` on Linux, since the claim in `bar/lib/orphan.ts`'s header was
measured on darwin. MEASURED 2026-08-20 under `oven/bun:1.3.14` with `probes/ppid-reread.ts`: it does
re-read, going 9 -> 1 within one poll of the parent being killed.

**The fix, and it does not widen a bound.** The already-orphaned branch now exits with a message
naming that branch (POSIX only — Windows has no reparenting and `process.ppid` means something else
there). The guard writes one line when it is armed, and the test WAITS FOR THAT LINE rather than for a
pid to exist — ruling 62 (d), bound the work and not the clock. The racy window is not lost: it is a
second test that kills the parent immediately and requires the vendor to exit anyway, which is the arm
that would have caught this.

Re-measured after the fix: kill-at-0 ms exits in ~52 ms; `bar/lib/orphan.test.ts` 8/8 on Linux under
Docker and passing on darwin. **Neither the 20 s nor the 10 s bound was touched.**

The state as it stood before the diagnosis follows.

Reported because ruling 48 is explicit that *"a flaky blocking item gets disabled"*, and the way that
starts is a test failing intermittently while nobody writes it down.

A real cause was found and fixed this round — `isAlive` reported a zombie as alive, MEASURED under
Docker with and without a reaping init. But across four CI runs since, the test has failed **twice in
eight platform-runs, at two different assertions**:

| run | macos-latest | ubuntu-latest |
| --- | --- | --- |
| 32394716171 | pass | pass |
| 32396192311 | **FAIL `:124`** (20,080 ms) | pass |
| 32398251476 | pass | **FAIL `:121`** |
| 32399494690 | pass | pass |

`:124` waits for the orphaned vendor to notice and exit; `:121` waits for the SIGKILLed parent's own
exit status to be observable within 10 s. They are different waits, so this is not one cause showing
twice. Both are `until(…)` polls over real processes on a loaded shared runner.

**Not diagnosed, and deliberately not "fixed" by widening either bound** — that is how a suite stops
meaning anything, and the round already removed one widened bound whose cause turned out to be a real
product defect (`src/integrate/gate.ts`). Options are: leave it and gather samples; bound the work
rather than the clock per ruling 62 (d), which needs a signal from the vendor fixture that it has
noticed rather than a poll; or accept it as environmental. **Two failures in eight is not yet enough
to tell a flake from a slow machine, and saying so is the point.**

---

## 12. NEW, 2026-08-20 — a whole `brigadier run` is 35–160× slower on `windows-latest`

**Found while answering why ten NEGATIVE CONTROLS and no positive arms were failing on that leg, which
turned out to be two facts stacked.**

The first is a test-shape defect and is fixed: every one of the ten drives a whole `brigadier run`
**synchronously** through `Bun.spawnSync` inside the test body, and none of them declared a timeout —
so they ran under bun's 5 s default while the arms they control do their expensive work in
`beforeAll`. On POSIX that never showed. They now carry an explicit 180 s bound, which is a BOUND and
not a measurement, and no assertion is changed: a control that cannot run is not a control, and that
is the same shape as the eleven vacuous Windows passes ruled on the same day, pointing the other way.

**The second is not fixed, is not attributed, and is the reason this entry exists.** MEASURED
2026-08-20 across runs 32403947990 (windows) and its POSIX siblings, same tests, same commit:

| test | ubuntu-latest | macos-latest | windows-latest |
| --- | --- | --- | --- |
| *the same two items on disjoint paths DO create a run root* | 897 ms | 338 ms | **51,116 ms** |
| *the SAME plan with the same agent committing does land* | 318 ms | 651 ms | **31,014 ms** |
| *the same worker with the path DECLARED integrates* | 315 ms | 657 ms | **31,035 ms** |
| *with no `--planted` there is a count and no invented denominator* | 378 ms | 895 ms | **50,917 ms** |

The Windows figures are real durations rather than artefacts of the timeout: the body is
`Bun.spawnSync`, which cannot be interrupted, so bun's deadline can only fire once it returns.

**What is NOT claimed:** any cause. Candidates nobody has separated — process creation on Windows
being dearer, every planted vendor being reached through `cmd.exe` as a `.cmd` shim, `git` on Windows,
Defender scanning each spawned artifact, or something in the product's own worker path. That is
exactly the shape the 2x2 in #9 settled for the harness, and the same treatment would settle it here:
one CI experiment that times the pieces separately rather than the whole. It was not run this round.

**Why it matters beyond CI wall-clock.** Ruling 12 makes Windows first class. A run that costs 30–50 s
where it costs under a second elsewhere is a user-visible property of the product on a supported
platform, and nothing in `BAR.md` measures it.

---

## 13. ~~NEW, 2026-08-20 — a dozen planted-payload NEGATIVE CONTROLS are inert on Windows~~ ANSWERED 2026-08-21, and the experiment had contaminated its own control

All three named candidates are refuted. MEASURED on `windows-latest` by
`test/git-payload-shape.test.ts`, run 32415677392, job 96576151123, against `65990a9`:

| shape | result |
| --- | --- |
| sh + `touch` + native path | **FIRED** |
| sh + redirect + native path | **FIRED** |
| sh + redirect + forward-slash path | **FIRED** |
| `cmd` batch file | **FIRED** |

Four of four. The `#!/bin/sh` shebang runs there, `touch` is present in Git for Windows' userland, and
a backslash inside the payload's own double-quoted string does no harm. Three theories are dead and
none needs trying again. A negative result is a good result, and this one cost one CI leg instead of
three guesses.

**What the experiment did not vary is the answer.** All four shapes are planted through one line,
`test/git-payload-shape.test.ts:127`, which writes `fsmonitor = ${forward(command)}`. That converts
the command's own path from `C:\Users\…` to `C:/Users/…` before git ever sees it. The fixtures under
investigation do not. `test/isolation-live.test.ts:115` writes `fsmonitor = ${payloadScript(canary)}`
natively. So the experiment held the causal variable constant, at its working value, in all four
cells. It refuted its three candidates honestly and could not have found the cause, because its own
setup code had already fixed it.

This is candidate 3, the path, surviving in the one place the experiment did not look. It was named,
tested at the wrong site, and recorded as refuted. Both halves of that are true and both are kept.

**The discriminator is the slash direction of the command path.** Three planting routes agree,
MEASURED in the same job:

| fixture | how `core.fsmonitor` is set | command path | result |
| --- | --- | --- | --- |
| `git-payload-shape.test.ts` | config file written by hand | forward-slash | FIRED ×4 |
| `isolation-live.test.ts` E1, E2 | config file written by hand | native | inert |
| `isolation-live.test.ts` E5 | `GIT_CONFIG_VALUE_0` environment variable | native | inert |
| `isolation-recycle.test.ts` | `git config core.fsmonitor <path>` | native | inert |

Three different routes, all native, all inert. One route, forward-slash, fires. The route is not the
variable. The slash is. The environment-variable row carries its own weight: it involves no config
file, so git's config-file backslash-escape parser cannot be the explanation.

**The mechanism is in plain text elsewhere in the same log.** `test/integrate-parity.test.ts` failed on
that leg with git's own error, unabridged:

```
payload-config-filter-smudge.sh: line 1: C:UsersRUNNER~1AppDataLocalTempbrigadier-parity-eXF0Rjpayload-config-filter-smudge.sh: command not found
```

Git for Windows runs these commands through its bundled `sh`, which eats backslashes as escapes.
`C:\Users\…` arrives as `C:Users…`, which names nothing, so nothing runs. Git then ignores a failed
`fsmonitor` in silence, which is why a dozen controls read as inert rather than as errors. The payload
never ran and nothing said so.

**The predicted fix, written down before it is measured, so CI can refute it.** Convert the command
path to forward slashes at five sites: `payloadScript` in `test/isolation-live.test.ts`, one helper
serving E1, E2 and both E5 arms, and four in `test/isolation-recycle.test.ts` (`plantFsmonitor`, the
planted `.git/config` at :281, and the two global-config plants at :367 and :379). Never the canary
path inside the script, which shapes 1 and 2 prove is fine native. Prediction: those controls fire on
`windows-latest`, and every guard beside them stops being vacuous. If a Windows leg shows them still
inert, this diagnosis is wrong and the entry reopens. That is the refutation condition, stated in
advance.

**APPLIED 2026-08-21, at all five sites.** MEASURED on darwin 25.5.0 / bun 1.3.14 at load1 3.17 to
3.50: `bun run gates` exit 0, 1,757 pass, 0 fail, 0 skipped, 0 todo, unchanged from before the edit,
which is what a no-op on POSIX should look like. Whether it does anything on Windows is what the next
leg says, and nothing here claims it in advance.

**The hook-file plants are untouched, deliberately.** `plantHookIn` writes a script into
`.git/hooks/`, and git executes a hook file by path itself rather than handing a string to a shell, so
none of the evidence above applies to it. Changing it would be a guess, and the same leg that grades
this edit says whether those controls are inert too.

**The lesson outlives this entry.** An experiment must vary its variable in its setup, not only across
its cells. This one was written in the shape of #9's 2×2, which worked, but #9 varied the whole call
path and this varied only the payload. A matrix that normalises its inputs before the cells begin is
measuring its own normalisation. Same class as the harness scoring itself in `BAR.md` item 5, and as
the first verifier's observation about instruments.

**The state as it stood before the experiment follows.**

Roughly a dozen controls across `test/isolation-live.test.ts` and `test/isolation-recycle.test.ts`
plant a payload into a clone's `.git` and assert that it **fires** — E1, E2, E4, E5/E6, *"recycling a
pooled directory a previous agent could write to"*, *"git's other two config levels"*. VERIFIED
against run 32403947990: every one failed on `windows-latest` and only there. The payload did not
fire, so **each control is inert and every guard it stands beside is unproven on that platform** —
which is the shape ruling 32 forbids, recorded there as a dozen separate failures rather than as one
cause.

**Three candidates, and none of them is separated.** This is deliberately not guessed at:

1. **The shebang.** `#!/bin/sh` is not executable by Windows itself — though Git for Windows runs
   hook-shaped commands through its own bundled `sh`, so this may not be the answer at all.
2. **`touch`.** The fixtures' payload runs `touch "<path>"`. Git for Windows ships a reduced MSYS2
   userland and whether `touch` is on the path its shell sees has never been measured here. A payload
   using only shell redirection needs no external command.
3. **The path.** `join()` produces `C:\Users\…`, and a backslash inside a double-quoted POSIX shell
   string is an escape before some characters and literal before others. Git's own shell accepts
   `C:/Users/…`.

**`test/git-payload-shape.test.ts` is the experiment**, written in the same shape as #9's 2x2 and
pushed with this round. It drives four payload shapes — sh+`touch`+native path, sh+redirect+native
path, sh+redirect+forward-slash path, and a `.cmd` batch file — through a real `core.fsmonitor` on a
real repository, RECORDS which fired, and asserts only the property the controls depend on: that at
least one shape fires on this platform. On POSIX it is a control on the control (6/6 on darwin and
under `oven/bun:1.3.14`). On Windows the matrix is the finding, and it should let the next round fix a
dozen tests in one edit rather than guessing three times.

---

## 14. NEW, 2026-08-21 — detection reports an agent usable and its first prompt fails authentication

**PARTLY RULED 2026-08-21. The cost is ruled; the detection gap is NOT, and stays open.**

Two halves, and only one of them could be settled without spending a metered turn on every detection.

**Ruled, and built: a refused credential is learned once per run rather than once per item.**
`isCredentialRefusal` in `src/agent/worker.ts` matches an authentication refusal and nothing else, and
the dispatch loop stops at the next batch boundary — the same place and for the same reason as ruling
66's soft ceiling. The run says it once, names the vendor, and says the plan is not implicated.
Undispatched items are `unrun`, never `failed`, because `failed` sends an operator to look for a defect
in work that never started.

*Why this is a ruling and not a tidy-up.* It changes when a run stops. **The accepted cost: a TRANSIENT
authentication error now stops a run that might have recovered on the next item.** The alternative is
spending every remaining item to relearn the same answer, and finding 87 is exactly that shape — a cost
discovered after it is spent. Ruling 53 chose in this direction once already: an unmeasured requirement
is not permission to proceed.

*The limit, stated rather than discovered.* This stops the next BATCH, not work already in flight. A run
wide enough to dispatch every item at once still shows several items failing this way, exactly as the
soft ceiling behaves. The verifier's five-item run may well have been one such batch, in which case this
change would have improved its REPORT and saved it nothing.

*The classifier is narrow on purpose.* Authentication only. One that also swallowed timeouts, rate limits
or model errors would stop runs for reasons nothing here has measured, and each of those is a different
remedy. The negative control drives a second `-32000` on the first prompt reading *model is overloaded*
and asserts the run does NOT stop — without it, *stop whenever an item errors* passes every other
assertion while being a worse product.

MEASURED darwin 25.5.0 / bun 1.3.14 2026-08-21, load1 5.78 to 5.90: `bun run gates` exit 0, 1,766 pass,
0 fail, 0 skipped, 0 todo. Both positive tests fail without the change; the negative control passes
either way, which is what makes it one.

**STILL OPEN, and it is the harder half: `session/new` does not prove usable, and nothing here changes
that.** Detection still admits an agent whose first prompt will be refused. Closing it needs a cheaper
credential probe per vendor, and **nobody has measured which vendors expose one** — a prompt costs a
metered turn at every detection, which is what ruling 71's cache exists to avoid, and would make
`detect` a spender. That measurement comes before the ruling, and it is not made here.

The entry as it stood follows.

### The original entry — 14. NEW, 2026-08-21 — detection reports an agent usable and its first prompt fails authentication

This is #8, reproduced, and it is no longer a one-off on a bridge that has since moved. The second
independent verifier drove it on `@zed-industries/claude-code-acp` 0.70.0. The first hit it on 0.69.0.
Two verifiers, two bridges, one signature: `session/prompt: -32000 Authentication required`. Twice
recorded is not an edge case.

MEASURED 2026-08-21 on darwin 25.5.0, from `VERIFIER-REPORT-2.md`, run `mt2x09vpa2fd`:

- `brigadier detect --json` reported Claude 0.70.0 usable, session opened in 1,332 ms.
- The run re-ran admission, routed all five items to Claude, and promised a two-rung ladder.
- All five workers failed at `session/prompt` with `-32000 Authentication required`, seconds later.
- The run exited 1, integrated 0 of 5, retained all five clones, ran no reviews, took no second rung.

**Where the boundary is.** The authentication failure is environmental and is not brigadier's defect.
Admitting the agent on the strength of it is. Ruling 41 defines detection as two steps, a handshake
proving present and a session proving usable, and this run is the measurement that says `session/new`
does not prove usable. The vendor opens a session for an unauthenticated account and then refuses the
first unit of work. Ruling 41's second step tests a weaker property than the word *usable* claims, on
the vendor `BAR.md` item 1 grades most closely.

**What is not claimed:** that a third step is the answer. A prompt that proves usability costs a real
turn on the operator's account at every detection, which is what ruling 71's cache exists to avoid,
and it would make `detect` itself a spender. The options are at least a cheaper vendor-specific
credential probe, treating the first `Authentication required` of a run as an admission failure rather
than an item failure so it fails once and loudly, or accepting the gap and saying so in `BAR.md` under
*When an item cannot be met*. Nobody has measured which vendors distinguish these two states at all,
and that measurement comes before the ruling.

**Why it is worse than five failed items.** The ladder never engaged. Five items each burned an
attempt against the same broken credential, and the run reported five independent item failures rather
than one machine-level fact. That is finding 87's shape, a cost discovered after it is spent, pointing
at admission rather than at routing.

**#8 closes into this entry.** It was open as *still unexplained*. It is now reproduced with a record
on disk, and the open question is the ruling above rather than the diagnosis.

---

## 15. ~~NEW, 2026-08-21 — the run report told the operator the plan had no write items, and all five were write items~~ FIXED 2026-08-21

**Reproduced in a test before it was fixed, and the test fails without the fix.** `test/review-run.test.ts`
plants two `write` items whose builder produces no diff, which reaches the same state by a cheaper road
than five dead workers. MEASURED on darwin 25.5.0 / bun 1.3.14 2026-08-21 against the unfixed source, the
run-level reason read, in full:

> no item in this plan is a `write` item, so ruling 49 left no diff for a reviewer to be handed and
> ruling 32's cross-vendor rule had nothing to apply to. Nothing was reviewed and nothing here claims
> otherwise.

That is the verifier's sentence, word for word, on a plan of two write items. Both new tests fail against
`039d0ee` and pass after the change, which is the negative control `AGENTS.md` requires: a guard that
cannot fail looks identical to a working one. The read-only world's existing assertion is the control in
the other direction, so the fix cannot be *print the new sentence unconditionally*.

`src/queue/execute.ts` now derives the sentence from `writeItems`, which was already counted ten lines
above for the deliverable, instead of from whether a reviewer spawned. Where write items existed and none
was reviewed, that fact also outranks a `sameVendorReason`, which describes how a review WOULD have been
routed and, printed alone, describes a review that never happened.

MEASURED after the change: `bun run gates` exit 0, 1,759 pass, 0 fail, 0 skipped, 0 todo, load1 5.36 to
7.40. The +2 is the negative control.

**What this does NOT fix.** The verifier's run reached this state because five workers died at their
first prompt, and that cause is #14 and is untouched. This entry was only ever about the report telling
the truth about the plan.

The entry as it stood follows.

A false sentence in the run report. The second verifier found it, and it is one condition. MEASURED
2026-08-21: run `mt2x09vpa2fd` carried five plan entries, every one `kind: write`, and the host report
asserted *"no item in this plan is a `write` item"*.

The site is `src/queue/execute.ts:1990`:

```ts
const reviewReason = routedCrossVendorBroken
  ? …
  : reviewedAny
    ? reviewer.sameVendorReason
    : (reviewer.sameVendorReason ?? nothingReviewable);
```

`nothingReviewable` is that sentence, and the code reaches it whenever no reviewer process spawned.
`reviewedAny` is false in two situations the report cannot then tell apart:

1. the plan genuinely has no `write` item, so ruling 49 left no diff to review; and
2. every `write` item failed before producing a diff, so nothing ever reached a reviewer.

The verifier's run was the second and the report printed the first. The report infers the plan's shape
from the reviewer's fate instead of reading the plan.

**The correct value is already in scope, ten lines up.** `execute.ts:1733` computes
`writeItems = plan.items.filter((item) => item.kind === "write").length`, and the integration-branch
block at :1746 gates on `writeItems === 0` and gets it right, printing *"no item in this plan declares
`kind: write`"* only when that is true. Two sentences about one fact, in one function, derived from
two different things, and one of them lies.

**Why this is bar-grade and not a wording bug.** `BAR.md` item 11's second half is that a run where
items fail is reported without hiding the failure, and this hides what kind of failure it was. An
operator reading that sentence concludes the plan was read-only and no review was owed. It is also the
shape this repository keeps naming, a check that reports success when the thing it checks did not
happen, with the reviewer's absence rendered as the plan's shape.

**The fix and its test are one edit each.** Gate `nothingReviewable` on `writeItems === 0`, and give
`writeItems > 0 && !reviewedAny` its own sentence saying write items existed and none reached a
reviewer, with the count. The test is a plan of `write` items whose workers all fail before a diff,
asserting the report does not contain the read-only sentence. It has to be a negative control, because
the current code passes any test that only checks the read-only case.

---

## 16. NEW, 2026-08-21 — the reviewer's findings are discarded from the host report, and item 5 is failed at 2 of 5

The rate first, because it is the blocking half. The second verifier planted five defects with no
marker tokens, drove a real fleet, and scored the recorded transcript by hand: 2 of 5 caught, against
item 5's threshold of 3 and v1's baseline of 0 of 3. `BAR.md` item 5 assigns exactly this judgement to
the verifier and requires the number published whether or not it clears. It does not clear. The bar is
not met and there is no tag.

Two measurements sit beside that number. Neither changes it, and both belong on the record, because
item 5 is where the diff-framing assumption is meant to be falsified in public.

**It was measured same-vendor.** Copilot returned `Authentication required` mid-session, so OpenCode
1.18.18 drove both builder and reviewer. Item 5's first clause is that the reviewer's vendor differs
from the builder's, so the published rate came from a condition the item does not specify. Anthropic's
documented same-vendor self-preference is why item 5 separates those clauses at all. The verifier
reported this as an environmental limitation rather than as a passed cross-vendor check, which is
right.

**Only three of the five plants reached a reviewer.** The builder repaired two of them, the
empty-string cursor and the cross-tenant cache key, before review. The verifier declined to score a
builder repair as a reviewer catch, which is also right. A fourth was never reviewed at all, because
the builder made no commit. So the reviewer was handed three defective diffs and named two of them
precisely.

That is an instrument finding, not an appeal. A prose-only plant can be repaired by the builder, and a
plant that never reaches the reviewer measures the builder instead. Item 5's threshold is written
against five plants. The drive that produced this number put three in front of a reviewer. Whoever
runs the next one should decide in advance whether a repaired plant counts as a miss, a re-plant, or
an exclusion, and decide it before seeing the score, because deciding afterwards is how a threshold
gets tuned to fit its measurement. The verdict stands as reported: 2 of 5, below 3, no tag.

**The separate defect is the product's.** Brigadier printed `catch rate 0 of 5` while the transcript
unambiguously named two planted faults, because it counts identifiers appearing as literal contiguous
text in the diff and the reviewer wrote prose. `BAR.md` item 5 predicted this exactly, *a reviewer that
correctly describes a planted defect in prose the diff does not carry scores zero*, and that is why
the automated item publishes no rate. The 0 is documented behaviour.

**PARTLY FIXED 2026-08-21 — the discarded finding text. The RATE is untouched and still blocks.**

`src/queue/review.ts` gains `unverifiedFindings`, and a rejected item's check now repeats what the
reviewer said that the diff does not carry, labelled `NOT counted above`. `caughtIn` is unchanged and
deliberately still strict: not counting a claim the diff cannot carry is the right decision, and
`BAR.md` item 5 explains why. Discarding it was a different decision, and one line was making both.

Bounded rather than unbounded, because ruling 58 caps the host report and a reviewer's prose is the
least predictable thing in it: three findings, 120 characters each, `(+N more)` after that. The count
is exact even where the quotation is truncated.

MEASURED darwin 25.5.0 / bun 1.3.14 2026-08-21, load1 3.17 to 4.51: `bun run gates` exit 0, 1,763 pass,
0 fail, 0 skipped, 0 todo. Four negative controls, all of which fail without the change: the integration
assertion in `test/review-run.test.ts` (the ghost defect appears in the detail and the rate stays 2 of
3), and three unit tests covering the empty case, the bound, and that nothing is appended when the diff
carried everything.

**A second place to LOOK, never a second way to SCORE.** `review.caught` and `caughtDefects` are
untouched, so nothing here moves the published rate, and the 2-of-5 verdict stands exactly as reported.

The entry as it stood follows.

What is not documented, and is new: the host report also drops the reviewer's finding text. Both items
were blocked, correctly, on `rejected` verdicts naming `src/retry.ts missing between-attempts abort
check` and `src/median.ts [...values].sort()`. The operator was told the reviewer named zero defects,
with nothing to carry into a retry. A blocking verdict whose reason is discarded makes the ladder
blind, because rung two re-runs with no more information than rung one had. That is item 11's rule
that a failure never collapses, applied to the reason rather than to the item, and nothing in `BAR.md`
currently asserts it.

---

## 17. NEW, 2026-08-21 — actual spend exceeded the predicted upper bound, and this repository's own guard would reject it

MEASURED 2026-08-21, run `mt2x3vpp247d`: estimate 71,835 to 359,175 tokens, actual lower bound
362,877. Over the upper bound by 3,702 tokens, 1.03%.

Reported honestly, and not a ceiling failure. No ceiling was configured, so nothing was enforced and
nothing was concealed. The run printed actual against predicted exactly as item 13 requires, and the
actual is a lower bound because the run included opencode, which ruling 70 makes `unpriceable`.

It is still a calibration miss, and this repository already treats it as one. Item 13's own negative
guard rejects a run that spends above its predicted upper bound, so the product's test suite holds the
estimator to a standard the estimator missed on its first independent drive. One overshoot of 1.03% is
a data point, not a trend, particularly with #44's measured 15× between two identical Codex runs
already in the record. What nobody knows yet is whether the range is systematically narrow or whether
this run was ordinary variance, and one drive cannot tell those apart. It is recorded so the next
drive has something to compare against instead of noticing it again from scratch.

---

## What the first post-fix Windows leg measured, 2026-08-20

Run 32410206092, job 96558602057, against `ec56b87`. **83 failing before, 83 after — and the
composition is the finding, not the total.**

**FIFTEEN FIXED, and each is a family rather than a test:**

| gone | why |
| --- | --- |
| `the temporary index is nowhere near the operator's repository` (2) | `refuseInsideRepo` asks the filesystem now — the 8.3 short name defeated the string test |
| `the spellings refuseInsideRepo compares` (3) | the diagnostic that found it now passes there |
| `the subject's output reaches the harness` (2) | `exec` no longer combines `detached` with a `.cmd` shim |
| `the worker's clone` (3), `a first-day repository`, `ruling 54: a wave boundary`, `recycling leaves nothing` (6) | CRLF, asserted against the repository's own effective `core.autocrlf` |
| `item 1's early exit reports its provenance` | downstream of the capture fix |
| `cli plus repo map is under 63 MiB` | the struck clause; replaced by the contribution budget |

**TWELVE OF THE FIFTEEN NEW ARE THE CONVERSION, exactly as ruled:** the eleven platform-gated tests
that used to render `(pass)` in fractions of a millisecond, plus the new `THE RACE, driven` arm in
`bar/lib/orphan.test.ts`. They are red on purpose and each names the mechanism that would have to be
built.

**THE THREE THAT ARE NOT** — one is new information and two were already failing:

- **`brigadier's own contribution is within budget` — a Windows path interpolated raw into a
  JavaScript string literal.** MEASURED: `REPO` is `D:\a\brigadier-ai\brigadier-ai`, and
  `import … from "${REPO}/src/cli.ts"` produced a specifier bun read as
  `D:arigadier-airigadier-ai/src/cli.ts` — `\a` is a bell and `\b` a backspace. **Every compile in
  `test/repomap-binary.test.ts` failed there**, which is why the binary-budget assertion has never
  run on Windows under either the old clause or the new one. Fixed by interpolating a forward-slash
  form into the generated SOURCE only; `REPO` itself still goes to the OS in its native form. This
  is the *"hardcoded POSIX path separators in expectations"* family in its sharpest form, and it was
  found only because the new budget moved the assertion behind a compile that had to succeed.
- `the stamp the build step collects` and `the operator's repository survives the gate…` were both
  failing before this round and are untouched by it.

**So the honest count is 83 → 71 real failures, with 12 previously invisible checks made visible.**
