# Owner's questions — collected 2026-08-20, none of them ruled on

Written by the CI round (branch `gauntlet/ci`). Everything here was found while answering *why has CI
never passed on any platform*. **None of it is decided.** Each entry states the question, the options,
and what each option costs, and nothing below has been acted on in the tree.

The rule this file obeys is `BAR.md`'s: *"Scaling the bar down is the owner's call. Doing it silently
is not available to anyone."* Three of these would scale something down. They are red in the meantime.

---

## 1. Does `run` trust the detection cache? — `DETECTION-CACHE.md`'s one open `[owner]`

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

## 2. Does `brigadier detect` get a ruling?

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

## 3. Is item 10's 63 MiB size clause struck, like its two siblings?

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

## 4. Ruling 15's directory identity is defeated on ext4 — what replaces the inode?

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

## 5. `Check` as a discriminated union — the standing hazard behind `Checks.note()`

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

## 6. Eleven tests that render as `(pass)` on Windows without running

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

## 8. Still unexplained: the first verifier's `session/prompt: -32000 Authentication required`

**No second cause is offered, because none was measured.** The obvious candidate was tested again this
round and refused again: under a scratch `HOME` on this machine the Claude bridge reports `usable` —
handshake and session — so the worker-shaped config root does not log it out. Its credential is in the
macOS Keychain, not under the redirected root.

One new fact that does **not** explain it but bears on it: the bridge has moved 0.69.0 → 0.70.0 since
the verifier ran, so the artifact the verifier drove is not the artifact on this machine today.

---

## 9. Windows: the bar harness grades every item blind

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

## 10. `bar/fakes.test.ts` fails on CI for a DIFFERENT reason on each platform — two of three undiagnosed

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

## 11. `bar/lib/orphan.test.ts` is flaky on CI, at two different lines

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
