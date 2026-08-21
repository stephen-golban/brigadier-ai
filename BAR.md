# The bar — how we know v2 is done

Ruling 48, settling [#37](../../issues/37).

**v2 is done when every locked ruling that makes a user-visible promise has an item proving it holds
against the real compiled binary.** Not when the ideas run out.

Every item below obeys three rules, and an item that breaks one is removed rather than argued for:

1. **Checkable by someone who does not trust the author.** A command with an observable result — not
   "routing works".
2. **Driven against the real compiled binary**, not the test suite. v1's worst defect — a global
   git-config check that made the product refuse to run for every git-lfs user, in every repository —
   survived 740 tests, four gates, two adversarial review lenses and twenty-two work orders, and was
   found only by pushing to CI.
3. **Tied to a ruling.** An item that proves no locked decision is decoration.

## How it is run

`bar/run.ts --binary <path>` — a harness **separate from `bun test`**, pointed at a downloaded
release artifact by someone who has never built this repository. Each item prints what it did, what
it observed, and `PASS` / `FAIL` / `SKIPPED`.

**A `SKIPPED` item blocks a tag exactly as a `FAIL` does.** A check that did not run is not a check
that passed. This is the standing rule that closed #46, #47 and #48 with their unmeasured halves
named rather than absorbed.

### Where the authoritative run happens

CI on `windows-latest`, `ubuntu-latest` and `macos-latest`, against a freshly downloaded binary in a
clean checkout — plus **one leg configured hostile-but-legal**:

- `git-lfs` filters installed in the global config
- `core.autocrlf` set
- a non-default `HOME`
- **a v1 `brigadier` already on `PATH`** — not hypothetical: ruling 46 records that v1 shipped one on
  a Homebrew tap at 0.2.1

v1's defect was not that the author's machine was broken. It was that the author's machine was
*normal*. A bar that only runs on normal machines cannot find that class of defect.

**Accepted cost, stated rather than hidden:** live-agent items cannot run on CI — vendor auth is
interactive and there are no credentials there — so the items that matter most run on a credentialed
machine, which is the environment this section calls blind. That tension is not solved; it is handed
to the verifier.

### Who verifies

An **independent verifier**: a separate session, a **different vendor** from whoever built the slice
(ruling 32's principle turned on the bar itself), **blind to the builder's reasoning**, inspecting
the real artifact rather than any description of it.

- It **plants its own defects.** A builder's planted defect tests only what the builder already
  thought of. v1's strongest result came from a verifier that planted its own.
- It **drives the live items** on a credentialed machine — the half CI cannot reach.
- Its report lands in this repository **verbatim, negatives included**.
- **A failed or skipped item means no tag.**

**Accepted cost:** a release can be blocked by a verifier that is an LLM session and can be wrong. A
false negative will stop a good release, and the temptation to overrule it is the exact moment this
mechanism becomes worth nothing.

## The items

Ruling 48 described **ten**. Phase 2 added **item 11** (ruling 58, the run report fits the window the
owner is working in) **item 12** (ruling 65, a granted secret does not reach a persisted artifact
verbatim) and **item 13** (ruling 66, the cost model). **Item 14 was added on 2026-08-20**, after an
independent verifier reported 13 PASS / 0 FAIL on an artifact whose every direct agent profile was
unstartable: the fixtures faithfully tested the fixture protocol and nothing tested the vendors'
current argv and config-root contracts. Ruling 48's text stands; this is the amendment, in the place
a reader looks.

### 1. Detection is honest

`brigadier detect` claims only agents that complete **both** steps, and reports the **resolved `PATH`
entry** rather than assuming it is ours. An agent renamed off `PATH` reports `absent`; an agent
present but logged out reports `unusable` with the vendor's own remedy text.

**And a version that has drifted from the profile is reported** (ruling 69), graded — the lane
assertion blocking, capabilities a warning. Note what cannot be used for this: **all four agents
measured returned `protocolVersion: 1`**, so the protocol version discriminates nothing and the
agent's own version is the only signal.

*Rulings 6, 41, 46, 2, 69, 73.* Exists because v1 inferred installation from a marker file and reported
`opencode` present on a machine where it was not on `PATH`. Ruling 73 (2026-08-20) is what this item
is allowed to cite for the COMMAND it drives: `brigadier detect` was shipped and graded while the
record contained no decision naming it, which is the shape ruling 48 calls a one-line way to make this
document lie.

### 2. The lane holds, including where the payload is empty

A worker instructed to write outside its clone is **denied**, and the file does not exist afterwards.
Driven on both payload shapes: a vendor that sends a full path (Claude / Copilot `edit`) and one that
sends **nothing at all** (Codex `edit`: `title: null`, `locations: []`), where the guard must
**refuse what it cannot place** rather than pass a `locations.every(inLane)` that can never fail.

**And a worker that plants an executable payload in its own clone does not reach the operator**
(ruling 56). Driven by planting all three measured shapes — a `pre-commit` hook, a
`reference-transaction` hook, and a `core.fsmonitor` in `.git/config` — running a **complete
integration**, and asserting the canary file **outside the clone does not exist**. The assertion is on
the escaped bytes, never on a flag: v1's finding 41 is that a flag assertion survives a refactor that
removes the property.

*Rulings 43, 34, 2, 56.* This is the promise most likely to be quietly false: #41 measured that an
**approved** `session/request_permission` on Codex runs the command *outside* its own OS sandbox, and
#50 found opencode has no boundary of any kind for execute-class work. Note what this item does
**not** prove: ruling 56's containment is brigadier not running git inside the clone, **not** the
lane's `.git/**` exclusion, which ruling 43 measured can only fire on two of five vendors.

### 3. No file another product owns is touched

Hash every foreign config file before a full run and after it — `~/.claude/settings.json`,
`~/.codex/config.toml`, `~/.cursor/hooks.json`, `~/.gemini/hooks.json`, `~/.config/opencode/`,
`~/.kiro/hooks.json` — and assert **byte-identical**.

*Rulings 8, 27, 28.* #27 already drove this shape and found `~/.claude/settings.json` unchanged
throughout; the item makes it permanent rather than a one-off observation.

### 4. Fan-out isolates, and integration merges

A plan with disjoint items produces N clones and N workers, each seeing the owner's **uncommitted
tracked *and* untracked work**, and merges to **one integration branch** carrying every change. A
plan with two items claiming one path is **rejected**. The report names **which of the three filters
bound the worker count** and why — driven so that *the plan had one item*, *desirability capped it*
and *RAM capped it* produce three different sentences for the same worker count (ruling 54). The
fan-out **renders in a real ACP client** as a `plan` with concurrent `tool_call`s.

**A `dependsOn` plan runs in waves**: wave 2 clones from wave 1's integration commit and **sees its
prerequisite's output**, and an item whose prerequisite did not integrate is reported unrun rather
than run. v1 proved the opposite behaviour with a real run in which **the run reported both slices
ok**.

**And no run directory is under `/tmp` or `$TMPDIR`** (ruling 61), asserted by `realpath` rather than
lexically — macOS's `/var` → `/private/var` symlink is why. The sharp version: **a worker instructed
to write into a sibling worker's clone fails**, on a vendor with a measured boundary, and **the
report names any worker that ran on a vendor without one**. #41 measured exactly this write
succeeding when both clones were under `/tmp`.

**And the read-only half, which is the one that can quietly fail:** a `read-only` item whose worker
writes into its own directory anyway contributes **nothing** to the integration branch and **no diff
to any report** — the directory is never read back. Driven by planting a file in a read-only worker's
checkout and asserting it reaches neither.

**And the operator's own repository is byte-identical afterwards:** `git status --porcelain -uall`,
the hash of `.git/index`, a hash over the whole working tree, and `HEAD`, captured before the run and
asserted after it — including after the scratch base ref is cleaned up. **`git for-each-ref` is
diffed too**, and every ref that appeared must be one brigadier created: ruling 51 measured that a
worker can push into the operator's repository through the clone's own `origin`, and removing the
remote is a speed bump rather than a boundary, so this is the check that would notice.

The integration branch is `refs/heads/brigadier/<run-id>`, is **visible to `git branch`**, and
**survives cleanup** — an item that let it be deleted would be proving the opposite of ruling 51.

*Rulings 19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50.* The uncommitted-work half is ruling 33 repairing
ruling 7, which had dropped the mechanism without replacing it. The read-only half is ruling 49,
which defines the kind by what brigadier reads back **because** three of five measured vendors give
no lane at all — so an item that asserted "the agent could not write" would be proving a promise the
product does not make.

### 5. Review is cross-vendor, and its catch rate is published

The reviewer's vendor differs from the builder's, and its verdict is recorded. Against **five defects
planted by the verifier**, at least **three are caught**, and **the catch rate is printed whether or
not it clears the threshold**.

**Measured with ruling 52's diff framing, and printed beside v1's baseline of 0 of 3.** Ruling 52
adopts as a *named assumption* — not a measurement — that a reviewer given an exact
`git diff <base>..work` catches more than one given the post-state of the owned files, which
`probes/gate-signal.sh` measured at **4.8× the bytes in aggregate, 3.8× median, 301× worst** over 119
real commits. This item is where that assumption is falsified or confirmed, in public, by a verifier
that did not make it.

**AMENDED by the owner 2026-08-19 — the rate is a verifier artefact, not a harness output.** The
automated item **cannot** produce this number honestly, and the reason is structural rather than a
defect to be fixed. The harness counts distinct quoted identifiers appearing in the diff, never
matched to the planted set: a reviewer quoting three lines of **one** defect scores three, and a
reviewer that correctly describes a planted defect in prose the diff does not carry scores **zero**.
Neither repair survives. Attaching marker tokens to the planted defects makes `grep DEFECT-` score
**5 of 5 without reviewing anything** — the brief instructs reviewers to copy such tokens verbatim.
Matching prose findings to planted defects is a **judgement**, and it is precisely the judgement this
document assigns to the independent verifier.

So the work splits along the seam this section already describes:

- **The automated item proves the plumbing**, blocking: the reviewer's vendor differs from the
  builder's; the vendor configured to catch defects **is** the one the record names as reviewer (a
  misrouted plant is `error`, never a low rate); the identities a reviewer found survive builder →
  diff → reviewer → record; and a reviewer producing no verdict blocks. It publishes **no catch
  rate at all** — a fixture catching its own preconfigured markers measures the fixture.
- **The verifier produces the rate.** It plants its own five defects, drives the real fleet on a real
  `PATH` with prose-only prompts, and scores what the reviewer actually said from the recorded
  transcript. That report lands in this repository verbatim, negatives included, and the number is
  published whether or not it clears three.

The threshold, the diff framing and v1's 0-of-3 baseline are unchanged. What changed is **who
measures**, and the answer is the one this document already gave: a verifier that did not make the
assumption. An automated number here would have been the harness grading itself.

**MEASURED 2026-08-21 — the rate exists, and it is 2 of 5. This item FAILS and there is no tag.** The
second independent verifier planted five defects with no marker tokens, drove the real fleet with
prose-only prompts, and scored the recorded transcript by hand. `VERIFIER-REPORT-2.md` carries the
whole table verbatim. Beside v1's baseline of 0 of 3, and below this item's threshold of 3.

Two conditions sit beside that number. **Neither is an appeal, and the verdict stands as reported:**

- **It was measured SAME-VENDOR.** Copilot returned `Authentication required` mid-session, so OpenCode
  1.18.18 drove builder and reviewer both. This item's first clause is that the reviewer's vendor
  differs from the builder's, so the rate came from a condition this document does not specify, and the
  cross-vendor half is *unrun* rather than passed. The verifier reported it that way itself.
- **Only three of the five plants reached a reviewer.** The builder repaired two of them before review
  and a fourth produced no commit, so the reviewer was handed three defective diffs and named two of
  them precisely. The verifier declined to score a builder repair as a reviewer catch, which is right.

**The instrument finding, which is worth more than the number.** A prose-only plant can be repaired by
the builder, and a plant that never reaches the reviewer measures the builder instead. This item's
threshold is written against five plants; the drive that produced this rate put three in front of a
reviewer. **Whoever runs the next drive decides in advance** whether a repaired plant is a miss, a
re-plant, or an exclusion — deciding afterwards is how a threshold gets tuned to fit its measurement,
which is the failure this whole mechanism exists to prevent.

**What the product did with the same run, recorded because it is the automated half's own prediction
coming true.** Brigadier printed `catch rate 0 of 5` while the transcript unambiguously named two
faults, exactly as the paragraph above says it must — the identifiers were prose the diff does not
carry. The 0 is documented behaviour and is not a defect. What WAS a defect is that the host report
also discarded the reviewer's finding TEXT, so two correctly blocked items reached the operator with
nothing to carry into a retry. Fixed 2026-08-21: a rejected item now repeats what the diff does not
carry, labelled uncounted and bounded by ruling 58's cap. `OWNER-QUESTIONS.md` #16. **The rate did not
move and this item still fails.**

**And a reviewer that produces no verdict is `error`, which blocks** — driven by killing the reviewer
mid-turn and asserting the item does not integrate. v1 merged its most delicate change on
`review: not run (REVIEWER_FAILED)`.

**And the table it ranks with is auditable from the binary** (ruling 68): `brigadier competence`
prints every row with its **evidence class and citation**, and **no citation is a line anchor** — v1
lost 8 of 44 to one comment-only sweep. A model the table has never heard of is **used, sorted last,
and named**, never silently excluded.

*Rulings 32, 10, 24, 52, 68.* The threshold is a stated judgement, not a measurement — review is
probabilistic and a flaky blocking item gets disabled, while a published number gets argued with.
Anthropic documents models preferring their own output when asked to judge it, which is why the
cross-vendor half is pass/fail and the catch rate is not.

### 6. A single-vendor machine degrades visibly

The same run on a machine with one drivable vendor **completes**, and the report states that review
ran **same-vendor**. It does not refuse to start, and it does not render the weakened check as a pass.

**And the retry ladder says which rung it actually got** (ruling 55): a failed item on that machine
renders `attempts 2 of 2 (same-vendor, model changed)` or `attempts 1 of 1 — no second rung`, never
the bare `attempts 2 of 2` a two-vendor machine produces. **A missing rung must not render as an
exhausted one**, and a short ladder is stated **at plan admission**, before anything is spent.

*Rulings 32, 55, 53.* This is the common case for a first-time user.

### 7. An interruption leaves nothing behind — including what escaped

`SIGKILL` mid-run, with a descendant that has **escaped** containment: `cmd /c start` on Windows
(#43 measured Bun's job object carrying `BREAKAWAY_OK` **and** `SILENT_BREAKAWAY_OK`), `setsid()` on
POSIX.

**AMENDED 2026-08-19 — `setsid()` is not what runs, and the document said otherwise for nine rounds.**
MEASURED on macOS 26.5.2 this date: `Bun.which("setsid") === null`. There is no `setsid` on macOS, so
the fixture escapes under `nohup`, and a `nohup` child returns `ppid 1` while **remaining in the
spawner's process group** — it never leaves it. The two mechanisms therefore defeat different links of
ruling 38: `setsid()` breaks the process-group link **and** the ppid link; `nohup` breaks only the
ppid link. The graded property survives either way, because an **unmarked command line plus an
orphaned parent** still forces reclamation through ruling 38's third link — the working directory
inside the clone — which is the link that matters and the only one that reaches a process whose
command line cannot be marked. The item **prints which mechanism actually ran** rather than printing
this document's word regardless. On Windows the mechanism is `cmd /c start`, and it has never
executed on any machine. The next start's **sweep** reclaims it, no clone survives, and the run manifest says what
happened.

**Then the half ruling 63 adds, which points the other way:** an item that had **committed work in
its clone** is **still there afterwards**, reported with its path and its bytes, **not merged and not
deleted**. v1's finding 92 is the precedent — an external signal killed a supervisor, both workers had
done real work, and it was unrecoverable. And a **second** interrupt during the drain **re-raises the
signal** rather than exiting with an invented code, so the process's status is genuinely
signal-terminated.

**RECORDED 2026-08-20 — amendment §18, the one hole in ruling 38, written down where a reader looks.**
Owner's decision this date, under this document's *When an item cannot be met*.

**CORRECTED 2026-08-20 — an earlier draft of this block said *"no such section existed anywhere"*.
That claim was false and is WITHDRAWN, not reworded.** Amendment **§18 exists** and always did: it is
section 18 of the second measurement-amendment comment on issue #1, posted **2026-08-18**, titled
*"Ruling 38's command-line marker cannot cover the operator's verify command — and that needs a
ruling."* VERIFIED 2026-08-20 against `gh issue view 1 --repo stephen-golban/brigadier-ai --comments`.

**The real defect is worse than a missing citation.** §18 granted no carve-out. It **asked for one**,
closing: *"The gap belongs to the owner: ruling 38 is written as universal and there is one process it
structurally cannot reach."* `bar/items/07-…` then cited it for nine rounds **as though it were a
settled limit**, and used an open question to excuse a hole. That is precisely what *struck only in
the open* forbids: an item may not excuse a hole by pointing at something nobody has decided, and a
limit that is settled only in the head of the item it limits is not in the open at all. The section
existed and asked a question; the answer did not exist, and the item behaved as though it did.

**This is that answer.** The owner's decision of this date is the ruling §18 requested, recorded here
by this file's own procedure — which item, why, and what promise is therefore unproven:

- **Which item.** This one, item 7. **What it deliberately does not demand:** ruling 38 says every
  process brigadier causes to exist carries a marker in its **command line**, and an operator's verify
  command structurally cannot. Appending an argument corrupts it — `bun test --brigadier-run=x` is not
  `bun test` — so the sweep **cannot match it**, whatever the product does.
- **Why nothing here is changed to cover it.** Such a process is killed on its own timeout **by the
  process that started it**. That is a **strictly weaker** guarantee than the sweep and it fails in
  **exactly the case this item drives**: a SIGKILLed orchestrator kills nothing on any timeout. What is
  left for that process is ruling 38's working-directory link, and only while the run root is still
  there. A check demanding the marker would fail against a correct product, so the item reports the
  weakness **as a weakness** — never as an absence and never as an equivalence.
- **The promise therefore unproven.** This item's plan **carries no verify command**, so nothing here
  measures that path at all. That an interruption leaves nothing behind is proven for processes
  brigadier spawns and marked; it is **unproven for an operator's verify command**, on every platform.
  Closing it needs a plan that runs one and a mechanism that does not corrupt somebody else's command
  line — neither is invented here.

*Rulings 15, 38, 5, 63.* Ruling 38 promoted the sweep from crash-recovery to *the* containment
mechanism precisely because the job object is opt-out by design and brigadier cannot fix it. An item
that only kills a well-behaved child would pass on a product that leaks every real one. Ruling 63
splits the sweep along a seam: **processes always, directories only for complete runs** — a leaked
process can still act, a retained directory is inert and holds someone's only copy.

### 8. An impossible plan is refused before anything is spawned

A plan requiring a tool absent from the worker's real environment is refused, the refusal **names
what was missing**, and **zero processes and zero clones are created**. A verify command present only
in a committed file is **not executed**.

**A misspelled verify command is caught here too**, before anything spawns — ruling 52 resolves the
checker's executable on `PATH` in the environment it will actually run in. v1's injected `ENOENT`
produced *approved, `tests_pass` skipped, `(approved by codex)`*, after a full build was burned.

**And the refusal names a remedy rather than arithmetic** (ruling 53): which requirement failed on
which agent, and whether it failed because the agent cannot or because **nobody has measured it** —
those need different fixes. v1 said `ROUTING_FAILED — 11 model(s) were eliminated`. A plan whose
retry ladder has nowhere to go at rung two is **admitted with the ladder shortened and that stated
before the run**, never discovered after an attempt is spent (finding 87).

*Rulings 11, 37, 18, 52, 53.* The second half is ruling 37's security property: cloning a hostile repository
must not run its command with the operator's privileges.

### 9. Ambient instructions are suppressed and brigadier's own plugin is inert

A user-global instruction file is **not obeyed** by a worker, and first-run **says so out loud**. A
worker on a machine with brigadier's plugin installed **does the work** rather than invoking
brigadier.

**And there is no `init` to run first** (ruling 71): the item drives a first run on a machine with no
prior state and asserts it completes, that state is created, and that **deleting the state directory
is a supported repair** rather than a corruption.

**And the state that first run created includes ruling 71's detection cache** — added 2026-08-20 with
the cache itself. A second admission against the same run root **spawns no vendor** and says which
stored answer it used, which is the check that would notice a cache that was written and never read.
Asserted on the effect and never on a path: `bar/` may not import from `src/`, so a check written
against a filename would be a second copy of a product decision, drifting the day the product moved
it. **What this half deliberately does not prove:** that a *stale* cache is caught. The fingerprint
axes — a moved agent, a rewritten binary, a replaced bridge, a new brigadier — are driven in
`test/detect-cache.test.ts` and `test/cli-run.test.ts` against a planted agent's own spawn ledger, not
here, because nothing in this harness can upgrade a real vendor.

**Asserted on the effect: the files exist and `brigadier run` was not invoked.** Asserting that
`BRIGADIER_WORKER` is set proves only that a variable exists — the exact *check that reports success
when the thing it checks did not happen* shape v1 kept shipping.

**Driven on all three of finding 114's routes** (ruling 59): a user-global instruction file, the
installed plugin, and **a committed `AGENTS.md` in the cloned repository that says work should be
handed to brigadier**. The third is the one no marker governs, and the run report must carry the
**run-level** line saying how many workers tried and were refused — a signal the brief was wrong,
which must survive ruling 58's cap.

**This item carries ruling 57's one unmeasured assumption**, and is the only thing that can settle
it: brigadier sets the marker on the **agent** process, and whether every vendor passes its
environment through to the shell it runs **tool commands** in is not measured. If a vendor builds a
clean environment, the refusal never fires there and nothing else catches it. v1's `USER` finding is
the precedent — environment propagation into an agent behaving unlike expectation, found only by
bisecting the real binary.

*Rulings 17, 36, 57.* v1's finding 114 — a worker that ran `brigadier run` instead of working: 12
minutes, zero files — **reproduced unprovoked** during #14, where a Codex worker spent 51 s on it.
Twice recorded is not an edge case, and it is also this guard's **demonstrated negative**: the
failure is known to reproduce without anyone having to construct it.

### 10. The artifact ships, and says what is in it

Installs, runs and is removed cleanly on all three platforms by each host's **real** discovery path
(ruling 42: `~/.agents/skills/`, and **no `bin/`-on-`PATH` outside Claude Code**). Runs with **node
absent from `PATH`**. `brigadier licenses` prints the full attribution. The licence gate passes on
the **released** artifact. **Brigadier's own contribution to the artifact** is within budget.

**STRUCK, in the open — the 63 MiB total-size clause.** Ruled 2026-08-20 by the coordinator under this
document's *When an item cannot be met*, the owner having delegated the rulings for that round. It is
the third strike on one sentence, and it is taken by exactly the procedure §23 and §24 used.

- **It was never measured on anything.** Amendment §16 established that the figure enters this project
  as **one unsourced sentence** at `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, under the heading
  *"Already measured — do not redo"*, and that v1's entire history at Release 0.2.1 contains no
  "63 MB". That is the **same sentence and the same commit** behind the two start-up clauses already
  struck.
- **It is unreachable on Linux by an amount no version of this product can close.** MEASURED against
  `bun 1.3.14` on 2026-08-20, a compiled program whose entire source is `process.exit(0)`:
  **63,446,114 bytes** on darwin arm64 and **93,694,096 bytes** on linux. The Linux floor is 27.6 MB
  over the budget before brigadier contributes a byte. §16's sentence about the cold-start clause holds
  word for word: *there is no version of brigadier that fits, because `process.exit(0)` does not.*
- **It budgeted a number this product does not set.** Ruling 5 mandates a `bun --compile` artifact, and
  over 97% of every reading is the Bun runtime.

**The promise therefore unproven:** that the released artifact is small in absolute terms. It is not,
on any platform, and it never was. As with the two struck clauses, **the item prints the strike in its
own output** on a passing run as well as a failing one.

**WHAT REPLACES IT IS A DIFFERENT STATISTIC, NOT A REPAIRED FIGURE.** §24 refused to install a second
number picked to clear the last reading, and that refusal is respected here in the only way that
matters: the new budget is on **brigadier's own contribution** — `size(artifact)` minus an empty
`process.exit(0)` binary compiled by **the same bun on the same platform** — and not on the total.
MEASURED 2026-08-20 at load1 1.61–2.57, compiling both back to back in one process on each platform:

| platform | empty floor | cli + repo map | brigadier's contribution |
| --- | --- | --- | --- |
| darwin arm64 | 63,446,114 B | 64,750,562 B | **1,304,448 B** |
| linux arm64 | 93,694,096 B | 94,939,280 B | **1,245,184 B** |

The two floors differ by 47%; the two contributions agree to 4.5%. The budget is **2,621,440 B
(2.5 MiB)** — twice the larger contribution, by the same rule `test/repomap-binary.test.ts`'s existing
grammar cap already uses. **That number is a judgement and not a measurement**, and it is printed
beside every verdict it produces so it can be argued with against the table above rather than against
v1's sentence.

**The accepted cost, stated rather than discovered:**

- **Nobody can check it from the artifact alone.** The struck clause needed one `ls -l`; this one needs
  a bun of the same version on the same platform to compile a second binary. Where that is not
  available the check is a blocking **`NOT-RUN`**, never a pass — the cost is a red leg on an exotic
  host, not silence.
- **The floor is unbudgeted, deliberately.** If Bun's runtime doubles, this check stays green while the
  download doubles. That is the honest consequence of budgeting only what this product controls, and
  the item prints the floor beside the contribution so a reader sees where the bytes actually are.
- **One measurement is recorded with a discrepancy rather than smoothed over.** The 93,694,096-byte
  Linux floor was recorded on 2026-08-20 against a container labelled **x64** and re-measured the same
  day, to the byte, on **arm64**. The number is reproduced; the architecture label on the earlier
  reading is not confirmed, and it is left standing as a discrepancy in the label.

**STRUCK, in the open — the ≤70 ms cold-start clause.** Owner's decision, 2026-08-19, under this
document's *When an item cannot be met*. Two reasons, both already in the record:

- **It was never measured.** v1's entire git history at Release 0.2.1 contains no "70 ms", no "cold
  start", no "hyperfine" and no benchmark script. The figure enters this project as **one unsourced
  sentence** at `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, under the heading *"Already measured
  — do not redo"*. Every later citation — **ruling 5's included** — restates that line.
- **It is unreachable at this artifact shape.** Minima of fresh, never-executed copies on first-ever
  invocation: a Bun binary whose entire program is `process.exit(0)` costs **873 ms**;
  `dist/brigadier` costs **892 ms**. brigadier's own code is **0.5%** of the artifact and **~19 ms**
  of the total. The cost is XProtect's first-execution scan, fitting ≈ **133 ms fixed + 11.3 ms/MB**,
  and six copies sharing one cdhash **each paid in full** — the scan is cached **per file, not per
  signature**, so **signing cannot pre-empt it**. Under quarantine — the real downloaded-release case
  this section calls authoritative — the unnotarized binary took **6,045 ms and was then SIGKILLed**:
  blocked, not slow. Notarization fixes the kill, not the latency.

**The promise therefore unproven:** that brigadier starts fast enough to be invoked casually on a
machine that has never run it. Nothing else in this item is weakened, and **the item prints the
strike in its own output** rather than omitting it — a `SKIPPED` clause would block a tag exactly as a
`FAIL` does, and a silent deletion is not available to anyone.

**STRUCK, in the open — the ≤10 ms warm-start clause.** Owner's decision, 2026-08-20, under this
document's *When an item cannot be met*, by the same procedure and on the same grounds as the cold
clause above. Three reasons, all already in the record:

- **It was never measured on this product.** The figure enters this project as **one unsourced
  sentence** at `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, under the heading *"Already measured
  — do not redo"* — the same sentence and the same commit that carried the struck 70 ms cold figure.
  It is v1's number, and v1's history contains no benchmark that produces it.
- **What this artifact actually costs is known and recorded.** MEASURED 2026-08-19 on darwin 25.5.0
  at load average 0.76–0.87 with nothing else running: raw min **15.27 ms** − a **1.28 ms** spawn
  floor = **13.99 ms corrected**, distribution raw p10 15.40 / median 15.67 / max 16.88 ms. A run
  MEASURED 2026-08-19 at higher load read **15.01 ms** corrected. Contention on this artifact was
  MEASURED at **0.65 ms**, so the gap is not noise.
- **The figure has been recorded against three different artifacts** — **11.29 ms**, **16.13 ms**,
  **13.99 ms** — and what changed between them was never established. That sequence is therefore
  neither a regression nor an improvement; it is three measurements of three things.

**The promise therefore unproven:** that brigadier is cheap enough to invoke **repeatedly inside a
loop**, which is what a warm figure is about. It is unproven on every platform, not merely unmet, and
it is a different promise from the cold clause's — that one is about a first run on a machine that
has never seen the binary.

**This is a withdrawal, not a relaxation, and the measurement survives it.** No number was moved to
fit a measurement. **Amendment §17's proposed ≤ 20 ms is NOT adopted** — a clause withdrawn because
its figure has no provenance cannot be repaired by installing a second figure picked to clear the
last reading, and 20 ms against a measured 16.13 ms is exactly that shape. Nothing replaces it. The
one shape that would have cleared the original number — a 337 KB JS bundle run by an installed
`bun`, measured **18.9 ms cold** — is an architecture change against ruling 5, not a tuning, and is
not adopted either. **The item still measures and prints the warm figure**, with its method, its
floor correction, its distribution and its provenance, and asserts that a figure was actually
obtained — a number that stops being printed is a number nobody will ever revisit. What is gone is
the comparison: no threshold is applied to it and no margin is stated beside it. And as with the
cold clause, **the item prints the strike in its own output** on a pass as well as a failure.

**And the hook surface is verified by name, not by count** (ruling 60): after install,
`claude plugin details brigadier` names `PreCompact`. Then the negative: a `hooks.json` carrying one
unrecognised event **discards every hook in the file**, and the item asserts brigadier **says so** —
today the symptom is that nothing happens. A count-based check would pass this; `.lsp.json` was
measured reporting `LSP servers (1)` for `{"notARealKey": 1}`.

**And the LGPL obligations are discharged against the artifact** (ruling 72): `brigadier licenses
--full` carries **the LGPL text itself** — §6 makes supplying it unconditional, and Bun's own shipped
binary was measured carrying **875 hits for "JavaScriptCore" and 0 for "GNU Lesser/Library General
Public"**, so nothing upstream discharges it for us. The relink recipe is present, and **WebKit's and
tinycc's corresponding source is reachable from the same place as the binary**, pinned.

*Rulings 26, 42, 12, 4, 44, 47, 5, 46, 60, 72.* ChatGPT is a **permanent blank** — a hosted surface has
no filesystem — and the item must not imply six uniform clients. **Not proven by this item:** that the
documented rebuild path actually reproduces the binary, which §6 requires and which ruling 72 leaves
as a bar item still to be written.

### 11. The run report fits in a host model's window, and never hides a failure to do it

A **fifty-item** run reported into a host session is **under 2,000 tokens** (ruling 58's ceiling,
which is ruling 39's repo-map budget), and **no worker transcript appears in it** — only summaries
and the path to the full record, which is on disk in full.

Then the half that matters: a run where **items fail** is reported into the same ceiling and **every
failing item still appears**, with every one of its blocking checks (ruling 52). Passing items
collapse to a count; a failure never does.

*Rulings 58, 52, 21, 25, 39.* The measured reason this item exists: #14 recorded **~46 KB of
agent→client traffic for a one-line change**, so ten turns is **~115,000 tokens at `chars/4`** — a
floor, since #23 measured that formula underestimating by 22% — against **Copilot's measured 128,000
token window** (#46). Being careless here costs the owner the session they are working in, and
host-first is the normal case under ruling 25, not an edge one.

### 12. A granted secret does not reach any persisted artifact verbatim

A run is given a secret through ruling 65's environment channel, a worker is asked to put it in a
file it commits, and afterwards **no persisted artifact contains that value in any enumerated
encoding** — literal, JSON-escaped, URL-encoded or base64. Checked across the run record, the
transcripts, the commit messages, the diff and the host-session report.

Then the check that would otherwise be theatre: **the same assertion is run in v1's form** — *does
the raw literal appear?* — and both results are printed. v1's version passed on a file that still
held the secret in escaped form, and an item that only reproduces v1's assertion would pass on the
same file.

**And the secret is not in the clone at all.** Ruling 50 puts no gitignored file in the base commit
and ruling 65 adds no exception for secrets, so `grep` over the worker's checkout finds nothing before
the worker starts.

**Scope, ruled by the owner 2026-08-19, because the two sentences above disagreed.** *Persisted
artifact* means **brigadier's own persisted artifacts** — the enumerated list, not an unbounded set.
Ruling 65's single sink is a property of what brigadier writes; brigadier does not rewrite a worker's
commit, and reaching into a clone an agent has touched in order to do so is precisely what **ruling
56** forbids. So **a worker that commits a granted secret into its own clone is not defeated by this
item or by the product**, and the item says so in the same breath it reports its result. The leak
found in round 9 was in `r/<run>/1/config.json` — the worker's artifact, not brigadier's — and is out
of scope by this ruling rather than by omission.

**And the item must prove the secret travelled at all.** An independent critic deleted the redaction
sink entirely and this item still **passed**: it was proving that a secret nobody moved did not move.
So the worker must first commit a **derivation** of the value that is not the value, and if that
derivation is absent from the integrated result the item is `error` — never `pass`.

*Rulings 65, 50, 37, 25, 56.* **What this item deliberately does not prove:** ruling 65 defeats *verbatim*
leaks only. A worker that paraphrases a key, re-encodes it in a scheme we do not enumerate, or
describes it in prose is not caught by this item or by the product, and the item must not be written
so that a reader concludes otherwise.

### 13. The cost model predicts, enforces, and says what it could not see

A run prints an estimate **as a range** with its provenance, and afterwards prints **actual against
predicted**. The **soft ceiling** stops new items being dispatched while in-flight items complete; the
**hard ceiling** cancels work already running, and the run report distinguishes the two. Each item
records its **(agent, model, effort) triple** and the effort actually asserted.

**The `difficulty` clamp is printed per item** (ruling 67) — `difficulty: hard (clamped to medium)` —
and the item asserts brigadier **never clamps upward**, because an upgrade spends money the operator
did not ask for. v1's recurring shape is the silent downgrade, so a clamp that did not print would be
the defect this proves against.

And the half that is easiest to fake: **quota is reported per vendor as `read`, `unreadable` or
`unpriceable`**, never absent and never optimistic. A run using opencode says `unpriceable` — #42
measured it reaching a model with no credential at all through its own gateway, so a successful turn
proves nothing about which account was billed.

**And the run says what it spent without claiming to have saved anything** (ruling 70): the levers
that were active are listed with the numbers measured for them elsewhere, phrased so *the 16.5× cache
lever was active* cannot be read as *this run saved 16.5×*. A run including opencode prints
`unpriceable` and its total as a **lower bound**.

*Rulings 66, 67, 70, 35, 23, 21, 29, 30, 31, 40.* Estimates are ranges because #44 measured **two identical Codex
runs at 427,723 and 28,245 bytes — 15×** — and published tooling puts real cost at 3–5× naive
estimates. **What this item cannot prove:** #45 measured neither vendor's effort setting confirmable
over the protocol, so "the effort we asked for is the effort that ran" is asserted from vendor-private
records or not at all.

### 14. The real fleet starts, on the argv and the config root brigadier actually uses

**The only item that drives the installed vendors' own binaries with no fixture anywhere in the
path.** Every other live item either plants a fake agent or runs builder work through the fixture
protocol; this one takes the launch contract the artifact prints for itself and checks it against the
vendors on this machine.

For each agent the artifact lists that resolves on `PATH`: the item reads `command`, `marker` and
`configroot` out of **`brigadier agents`** — never a constant in the harness, for the same reason
item 1 reads `measured` from there — splices the marker tail onto the argv, points the config-root
variable at a **freshly created empty directory**, and spawns the real vendor. The vendor must reach
its ACP handshake. A vendor that exits before any protocol has **rejected brigadier's command line**,
and that is a failure of this item whatever the fixtures say.

**And the config root must exist before the spawn**, because a directory brigadier has not created
yet is not a config root. MEASURED against `@agentclientprotocol/codex-acp` 1.6.2 on 2026-08-20: with
`CODEX_HOME` naming a directory that is not there the bridge exits immediately; with the same
directory created first it stays up. The builder path created both `agent-config` and `tmp` *after*
`spawnMarkedAgent` returned, so every worker lost that race.

**The demonstrated negative is the point of the item, not an afterthought**: it re-spawns one direct
agent with the marker appended bare — the form that shipped — and requires that to FAIL. A leg that
cannot distinguish the broken contract from the fixed one would pass on the artifact this item was
written against.

*Rulings 38, 41, 69, 57, 46.* Exists because the harness read 13 PASS / 0 FAIL on an artifact whose
every direct agent profile was unstartable. MEASURED on 2026-08-20 against Copilot 1.0.80, Qwen
0.21.13, Gemini 0.55.1 and opencode 1.18.18, all four exited 1 on `--brigadier-run=<run>/<item>`
before any protocol, and `CODEX_CONFIG` — named in the profile table as a config root — is a JSON
string the bridge calls `JSON.parse` on. **What this item cannot prove:** it drives `initialize`, not
work, so it says a vendor STARTS and says nothing about whether it can complete a turn; and it is
credentialed-machine-only, so CI cannot run it and ruling 48 already accepts that for live items.

## Coverage — every ruling, and what proves it

The second column is where a promise gets quietly buried. Writing *no user-visible promise* next to a
ruling that has one is a single-line way to make this bar lie, so it is written out in full and is
meant to be argued with.

Ruling 48 requires this table to be revisited every time a grilling ticket lands a ruling with a
user-visible promise, so it grows through phase 2. Rulings 49 onward were added as they landed.

| ruling | proved by |
| --- | --- |
| 1 true zero | process ruling — no user-visible promise |
| 2 ACP hub, client down and server up | items 1, 4 |
| 3 not an HTTP proxy | architectural exclusion — no user-visible promise |
| 4 vendor the bridges | item 10 (runs with node absent from `PATH`) |
| 5 Bun `--compile`, bridges out-of-process | items 7, 10 |
| 6 detection bar | item 1 |
| 7 clone per unit of work | items 4, 7 |
| 8 own directories only | item 3 |
| 9 local models via an ACP agent | **downgraded to unproven by ruling 45** — no mechanism exists to prove |
| 10 routing constrains, router ranks | item 5 |
| 11 brigadier validates the plan | item 8 |
| 12 Windows first class | item 10 |
| 13 in-tree work under a checkable rule | item 4 |
| 14 three fan-out filters, lowest wins | item 4 |
| 15 cleanup proves ownership three ways | items 3, 7 |
| 16 identifiers up front, contents just-in-time | item 4 |
| 17 ambient files suppressed | item 9 |
| 18 three config layers | item 8 |
| 19 bounded work queue, work kinds | item 4 — **amended by ruling 78**: the kinds are `write`, `read-only`, `plan` and `research` |
| 20 the orchestrator has no context window | **item 15 — this row was WRONG and is the reason ruling 82 exists.** It read *architectural exclusion — no user-visible promise* from 2026-08-17 to 2026-08-21, two paragraphs below this document's own warning that such a line is how the bar lies. Ruling 20 decides whether brigadier can plan, which is the most user-visible promise in the product. **Ruling 74** overturns its consequence and item 15 proves the result |
| 21 token strategy ranked by impact | item 13 |
| 22 repo map adopted | item 4 |
| 23 cost model: predict, enforce, learn | item 13 — **partially overturned by ruling 81**: outcomes may feed competence (falsifiable), cost still may not (#44's 15× variance). The seam is enforced by `bun run claims` check 4, which ruling 81 ADDS to rather than relaxes |
| 24 retry is a ladder | item 5 |
| 25 host-first is the product | items 9, 10, 15 — **direction overturned by ruling 75**: brigadier drives and the session is its face. Ruling 25's measured constraint (stdout lands in a model's context) stands, and `/dev/tty` was measured unreachable from a CLI tool call on 2026-08-21 |
| 26 one plugin directory, both formats | items 10, 3 — **overturned in part by ruling 77**: there IS a `PATH` install. *Uninstall is deleting the directory* holds unless `setup --modify-path` was passed, and item 3 grades the default |
| 27 hooks only in an owned directory | item 3 |
| 28 `PreCompact` recovers ruling 8's cost | item 3 |
| 29 the routing unit is a triple | item 13 (recorded per item in the run report) |
| 30 effort ceiling `high` | item 13 — **partly unprovable**: #45 measured neither vendor's effort confirmable over the protocol |
| 31 router derives effort | item 13 — **amended by ruling 79** for the two new kinds; a `plan` item has no model-supplied `difficulty` at all |
| 32 cross-vendor preferred, not required | items 5, 6 |
| 33 the scratch base commit | item 4 |
| 34 git hooks neutered, `.git/**` excluded | item 2 |
| 35 `difficulty` must be checkable | item 13 (the clamp is printed per item, and it only ever clamps down) |
| 36 brigadier's plugin inert in a worker | item 9 |
| 37 nothing executed comes from a committed file | item 8 |
| 38 the sweep is the containment mechanism | items 7, 14 (item 14 proves the marker is one the vendor ACCEPTS — a marker no agent starts with is a marker on no process) |
| 39 repo map ~2K, per run | item 4 |
| 40 effort graded on Codex, binary on Claude | item 13 (both shapes recorded; see ruling 30's row) |
| 41 detection is two steps | items 1, 14 (item 14 proves the vendor reaches the first step at all, under the worker's own argv and config root) |
| 42 `~/.agents/skills/`, no `bin/` off Claude Code | items 10, 3 — the measurement stands; **ruling 77** supplies the shim it says the ecosystem does not |
| 43 the lane is an approval channel | item 2 |
| 44 `CLAUDE_CODE_EXECUTABLE` is load-bearing | items 2, 10 |
| 45 ruling 9 downgraded to unproven | nothing to prove — see ruling 9 |
| 46 identity | items 1, 10, 14 |
| 47 Apache-2.0, attribution, licence gate | item 10 |
| 48 the success bar | this document — no separate item. **Amended by ruling 82**: the bar was defined against the rulings and nothing asked whether the rulings matched the owner. Item 15 is that organ, and ruling 48's *ten items* is now fifteen |
| 49 `read-only` defined by what is read back | items 4 (read-only half), 2 (the flat `deny` lane) |
| 50 base state, and the operator's tree untouched | item 4 (both halves, including the ref cleanup) |
| 51 integration: fetch not push, no working tree | item 4 (the ref diff, the visible branch, partial reported as partial) |
| 52 four check outcomes, three of them block | items 5 (reviewer `error`), 8 (the unstartable gate) |
| 53 three requirement terms, unmeasured is not permission | item 8 (the refusal names the term and the agent) |
| 54 fan-out arithmetic, waves, no free-memory scheduling | item 4 (the binding filter is named; a `dependsOn` wave runs in order) |
| 55 the ladder's second rung, and a short ladder said up front | item 6 (the rung is named; a missing rung never reads as exhausted) |
| 56 brigadier runs no git inside a clone an agent touched | item 2 (planted hook and config payloads, asserted on the escaped bytes) |
| 57 the binary refuses inside a worker | items 9, 14 (item 9 asserts the effect and carries the ruling's unmeasured assumption; item 14 proves the config-root redirect the ruling's second layer depends on does not itself stop the vendor starting) |
| 58 the host report is capped; the cap can never hide a failure | item 11 — the core property is UNTOUCHED. **Ruling 80** overturns the `Audience` enum's conflation of who reads it with who pays for it, and adds a fourth state |
| 59 a refused delegation reaches the operator | item 9 (a repo `AGENTS.md` that says "delegate to brigadier", and the run-level line) |
| 60 the hook floor, and a names-based self-check | item 10 (hooks register, and a poisoned `hooks.json` is *reported* rather than silent) |
| 61 run directories outside every temp root | items 4, 2 (a sibling clone is unreachable where the vendor enforces one, and named where it does not) |
| 62 evidence standards and this repository's gates | development-process ruling — no user-visible promise; enforced by `bun run gates` in CI |
| 63 resume by ref, retain interrupted clones, re-raise | item 7 (both directions: nothing leaks, and nothing of the operator's is destroyed) |
| 64 shared cache, per-item `TMPDIR`, ports by binding | items 4, 2 (concurrent installs complete; a sibling is unreachable through `$TMPDIR`) |
| 65 secrets in the environment, redaction at one sink | item 12 |
| 66 predict as a range, two ceilings, keyed by root commits | item 13 |
| 67 clamp difficulty down and loudly; check the distribution | item 13 |
| 68 competence cited by identity, unranked is not excluded | items 5, 10 (`brigadier competence` prints class and citation) |
| 69 drift graded by blast radius; a failed lane assertion blocks | items 1, 2, 14 (a drifted version is reported; an unasserted lane blocks a `write`; and `run` admits only what detection proved, which is where a blocking drift is enforced) |
| 70 no token-reduction claim; spend and levers reported | item 13 (the lever line, and a run including opencode says `unpriceable`) |
| 71 no `init`; first run prints the four unlearnable things | items 1, 9, 6, 15 — **overturned in part by ruling 76**: `brigadier setup` exists and is capped. Ruling 71's argument (an interactive propose-flow has nobody to talk to) stands; its promise that there is nothing to run first does not |
| 72 the source relink route, and the Library's own source offered | item 10 |
| 73 `detect` is a supported command, and ruling 71's named repair | items 1, 9 (item 1 drives the command; item 9 asserts the cache is read back) |
| 74 brigadier makes the plan; the binary has no context window | **item 15 — NOT YET BUILT** (Track A step 10). Until it exists this row cites an item that cannot fail, and that is named here rather than left to be discovered |
| 75 the session wears brigadier; the human is the caller | **item 15 — NOT YET BUILT.** The mechanism is measured: a `UserPromptSubmit` hook's stdout reached the model and an identity instruction was obeyed, against a no-hook control answering `NONE` (`claude 2.1.238`, 2026-08-21) |
| 76 `brigadier setup` exists, is non-interactive, and is capped | **item 15 — NOT YET BUILT** (assertion 1: setup runs clean on a fresh `HOME` and `detect` agrees with it) |
| 77 setup installs a launcher shim on `PATH` | item 3 grades the default (no foreign file touched without `--modify-path`); **item 15 — NOT YET BUILT** for the shim itself |
| 78 `plan` and `research` are work kinds | item 4 (the queue and its kinds); **item 15 — NOT YET BUILT** for the goal entry point. Web reach is a launch-profile column, not a fourth requirement term — ruling 53's vocabulary is unwidened. Both kinds are now in `KIND_CONTRACT` with every field answered, and the field that answers what makes them different is `product` — the directory does not, which is why a contract recording only the directory would have said all three read-only-shaped kinds were interchangeable |
| 79 effort for `plan` and `research` | item 13, with ruling 30's standing caveat: what brigadier SET is assertable, what was RECEIVED is not (#45) |
| 80 a fourth audience: a human in a session a model also reads | item 11 — the cap and its one-way property are unchanged; the fourth state and D24's one-line form are what this ruling adds |
| 81 outcomes may feed competence; cost still may not | item 13, and `bun run claims` check 4 — the router↛cost seam stays, and the outcome store must be physically distinct from it |
| 82 one bar item that tests the product against the owner | **item 15 itself — NOT YET BUILT.** Ruled under delegated authority; the owner may strike it |
| 84 research runs before the planner; a plan may not declare it | item 4 (a plan declaring `plan` or `research` is refused by name, which is a plan refusal like any other); **item 15 — NOT YET BUILT** for the phase itself. D22's rule is a SHAPE check and is covered as one — `test/research.test.ts` asserts a finding carries a date, that the date is the one brigadier named rather than the model's training year, and that every source line carries its own. **That a date is TRUE has no item and cannot have one**, which is ruling 78's own accepted cost and is written here so nobody reads the row as more than it is |
| 83 no credential is copied; the ambient lever is per vendor | item 3 (no foreign file touched — the shim is written inside brigadier's own run root and nowhere else) and item 14 (the real-fleet leg spawns a vendor, which is where a wrong lever surfaces as an authentication failure). **The silent direction has no item**: an argv rewrite that stops working fails by succeeding, so `test/ambient.test.ts` executes the generated shim against the argv MEASURED coming out of the bridge, and that is a `bun test` guard rather than a bar item. Ruled under delegated authority |

**Rulings 74–82 were added on 2026-08-21 and are the first ones this table ever got WRONG.** Ruling
20's row read *architectural exclusion — no user-visible promise* for five days, on the ruling that
decides whether brigadier can plan. No item was written against it and nothing looked at it again,
so six rounds verified a specification faithfully and had no organ for noticing it was the wrong one.
Ruling 82 adds that organ as **item 15**. **Five rows above cite an item that does not exist yet**,
and they say so in the row rather than in a footnote — a coverage table whose second column points at
nothing is the exact failure this table's own preamble warns about, and naming it is the only honest
state it can be in until Track A step 10 lands.

**Ruling 73 was added on 2026-08-20 and is the first ruling this document's own coverage table
caused.** `brigadier detect` was shipped, graded by item 1 and load-bearing for ruling 71's cache
repair, and the record contained no decision naming it — so the table had nothing to cite for a
surface it grades. It was ruled in rather than removed; the ruling, its reasons and its three accepted
costs are on issue #1.

**The gap ruling 48 declared is CLOSED.** Rulings 21, 23, 29, 30, 31 and 40 were parked as
*deferred — #24 open* and ruling 35 as *deferred — #31 open*; rulings 66 and 67 settled both tickets
and all seven move to **item 13**. No ruling in this table is deferred.

**One does not fully close, and it is stated rather than absorbed:** ruling 30's effort ceiling can be
asserted as what brigadier *set*, and only asserted as what was *received* where a shim or a
vendor-private rollout file exposes it — #45 measured that **neither vendor's effort setting is
confirmable over the protocol**.

**A deferred ruling is not a covered ruling**, and this table must be revisited each time a grilling
ticket lands a ruling with a user-visible promise.

## When an item cannot be met

An item is **struck only in the open**: a line on the map saying which item, why, and what promise is
therefore unproven. It is never quietly disabled, never marked "known failing", and never left
`SKIPPED` while a tag goes out.

Scaling the bar down is the owner's call. Doing it silently is not available to anyone.

### RECORDED 2026-08-20 — three things this bar could not prove, and what happened to each

These were put on the map by the paragraph above, which requires *a line saying which item, why, and
what promise is therefore unproven*. Each was red, honestly, and each needed a decision by the same
procedure that produced §23 and §24. **Two of the three were ruled on 2026-08-20**, the owner having
delegated the rulings for that round; the rulings are recorded in the items they govern, and the
entries below are kept so that what was decided can be read against what was known.

**(a) RULED 2026-08-20 — item 10's 63 MiB size clause is STRUCK, and a budget on brigadier's own
contribution replaces it.** The strike, its three reasons, the replacement statistic with its
measurements and its accepted cost are recorded above, in item 10, where a reader looks. What follows
is the evidence the ruling was taken on, unchanged.

The budget's only provenance is one unsourced sentence at `MEASUREMENT-SESSION.md:140`, commit
`7e6a547` — amendment §16 established that v1's entire history at Release 0.2.1 contains no
"63 MB". That is the **same sentence** behind the ≤70 ms cold-start and ≤10 ms warm-start clauses the
owner struck in the open (§23, §24). This clause was not struck with them.

MEASURED against `bun 1.3.14` on 2026-08-20, a compiled program whose entire source is
`process.exit(0)`:

| platform | empty-program floor | vs the 63 MiB budget (66,060,288 B) |
| --- | --- | --- |
| darwin arm64 | 63,446,114 B (60.51 MiB) | under, with 2.49 MiB to spare |
| linux x64 (`oven/bun:1.3.14`) | **93,694,096 B (89.35 MiB)** | **over by 27.6 MB** |

brigadier's own contribution on darwin is 478,848 B for `src/cli.ts` alone — **0.75% of the artifact**
— and 1,304,448 B once the repo map is wired in, which is the figure the replacement budget is set
against. §16's sentence about the struck cold-start clause holds here word for word: *there is no
version of brigadier that fits, because `process.exit(0)` does not.* **The promise unproven:** that
the released artifact is within a size budget in absolute terms. On Linux it is not, and no change to
this product can make it so — which is why the clause was struck rather than re-measured.

**(b) RULED 2026-08-20 — ruling 15's directory identity was defeated on ext4 and overlayfs, and a
clone token now carries it.** brigadier generates a random 128-bit token when it records a clone,
stores it in the manifest entry beside the inode, and writes it into the clone's own marker file; a
directory is brigadier's only if the two agree. Every other byte of ruling 15 (b) and (c) is derivable
from the clone's address — the path, the run id, the item number, and on ext4 the inode the filesystem
hands the next directory created there. The token is derivable from nothing.

**What it closes:** CONFUSION, on every filesystem — a stale entry, a directory deleted and remade by
something else, a marker reconstructed from the path. `test/run-reclaim.test.ts` now drives the ext4
case directly by forcing the recorded inode to the impostor's, which is what ext4 does for free 300
times in 300, and the directory is still refused.

**What it does not close:** a forgery. Someone who can write inside `<run root>/r/` can read the token
before deleting the directory, exactly as they can read the inode. The `KNOWN LIMIT` tests assert that
this is still true, so the boundary cannot drift silently; `src/run/reclaim.ts`'s header argument is
unchanged — the reach is bounded by (a), containment by `realpath`, and by nothing else.

**The compatibility fork, ruled rather than left open.** A run recorded by a brigadier from before
2026-08-20 has no token. It is **refused and reported**, not accepted. An old entry is by definition
the one whose directory has had the longest time to be replaced, so an exemption for age would apply
exactly where the check is needed. **The accepted cost: those directories are stranded** — never
reclaimed, accumulating under the run root, removable only by hand. The refusal names the path and
says so. The opposite cost is deleting a directory brigadier did not create, and ruling 63 already
chose between these two in the same direction and said why: *a leaked process can still act, a
retained directory is inert and holds someone's only copy.*

The evidence the ruling was taken on follows, unchanged.

**(b) Ruling 15's directory-identity proof is defeated on ext4 and overlayfs.**

`sameInode` in `src/isolation/manifest.ts` is the third of ruling 15's three ownership conditions: a
directory is brigadier's only if the inode matches what the manifest recorded. MEASURED on
`ubuntu:24.04` on 2026-08-20, 300 trials per filesystem of delete-then-recreate at the same path:

| filesystem | same inode returned |
| --- | --- |
| ext4 | **300 / 300** |
| overlayfs | **300 / 300** |
| tmpfs | 0 / 300 |

APFS is 0/300, which is why this had always passed on the owner's machine and failed on
`ubuntu-latest` (`test/run-reclaim.test.ts`, *"NEGATIVE CONTROL (b): same path, different directory"*).
**Birth time does not rescue it:** MEASURED the same day, `birthtimeNs` was IDENTICAL in 194/200 ext4
trials, so adding it would be a fix that does not fix — reported as the negative result it is rather
than shipped, and it is not to be proposed again. **The promise that was unproven:** that brigadier
will not delete a directory it did not create which has taken a clone's path, marker and manifest
entry. It held on APFS and tmpfs; on the ordinary Linux filesystem the check could not discriminate.
The test was left FAILING rather than weakened — its own comment called this *"a limit worth failing
loudly on"*, and it was right. **That test's fixture asserted a fact about the FILESYSTEM** — that a
recreated directory gets a new inode — which is false on ext4, so it has been rewritten to assert on
the token, which is exact everywhere, and paired with a forced-inode-reuse case so nothing is weaker.

**(c) `macos-latest` has 7 GiB, so every RAM-bound item is bound there.**

Not a new finding — owner decision §22 records it: `feasibilityCap` is
`floor((totalmem − 4 GiB − 3 GiB) / 3 GiB)`, which is **0** at 7 GiB, and `macos-latest` is 7 GB on a
public repository exactly as on a private one. It is repeated here because it is why the macOS leg's
`bar/fakes.test.ts` cannot pass, which nothing had said.

VERIFIED against run 32394716171 on 2026-08-20, that failure is **two items and only one of them is
RAM** — recorded precisely, because "the macOS leg fails on RAM" would have been half true:

- **item 4** is the RAM one, in the binary's own words: *"the binary measured this host's feasibility
  cap at 1 worker(s) … ruling 54's three sentences cannot be told apart on this machine … Remedy:
  grade item 4 on a host with room for at least 2 workers — about 13 GiB."* That is §22 exactly.
- **item 13** is **not** RAM. Its hard-ceiling arm reports *"NEVER REACHED: the run spent 104, under
  its 175 ceiling — this is the calibration missing, not the product ignoring a ceiling."* The
  fixture's ceilings were calibrated from an earlier run's spend, and #44 measured **15× between two
  identical runs**. That is a fixture-calibration fragility, and it is the owner's only in the sense
  that nobody has yet decided whether the calibration should be derived per run instead of pinned.

**The promises unproven:** that fan-out isolates, on macOS CI specifically (item 4); and that the hard
ceiling cancels work already running, wherever the fixture's spend lands under its pinned ceiling
(item 13, on any platform where that happens).

### RECORDED 2026-08-21 — the second independent verifier ran, and its verdict is BAR NOT MET

`VERIFIER-REPORT-2.md`, verbatim and negatives included, from a fresh clone of `gauntlet/verify-3` at
`65990a9084fdb625a548a590e64b55bd94d1c430` on macOS 26.5.2 / Darwin 25.5.0 arm64. **A failed or
skipped item means no tag, and three items failed.** The rulings below are recorded here by this
file's own procedure — which item, why, and what promise is therefore unproven.

Two things it confirmed first, because they bound what the failures mean. `bun run gates` in a fresh
clone: **1,757 pass, 0 fail, 0 skipped, 0 todo**. `bar/run.ts` against the compiled binary:
**14/14 PASS, 0 SKIPPED**. Both at load1 4.25 to 5.00, which the verifier recorded as contended rather
than presenting as quiet readings. So the checked-in instrument is green against this artifact, and
every failure below was found by driving the real thing past where the instrument reaches.

**(d) Item 5's catch rate is 2 of 5, and its cross-vendor half is UNRUN.** Recorded in full in item 5
above, where a reader looks. **The promises unproven:** that a cross-vendor reviewer catches at least
three of five planted defects, which is measured and missed; and that review is cross-vendor at all on
a real fleet, which did not run — Copilot returned `Authentication required` mid-session and OpenCode
drove both roles. The second is an environmental limitation and the verifier reported it as one, which
is the right call and is also why it is `unrun` rather than passed.

**(e) Item 1 graded `detect` honest, and the run then routed five items to an agent that could not
work.** MEASURED: `brigadier detect --json` reported Claude 0.70.0 **usable** with a session open in
1,332 ms; all five workers failed at their first `session/prompt` with `-32000 Authentication
required`; the run integrated 0 of 5. The authentication failure is environmental. **Admitting the
agent on the strength of `session/new` is the artifact's behaviour**, and it is the same signature the
FIRST verifier hit on bridge 0.69.0 — twice recorded, on two bridges, so it is not an edge case.

**The promise therefore unproven:** that an agent this bar reports as `usable` can perform a unit of
work. Ruling 41's second step proves a session opens, and for this vendor a session opens for an
unauthenticated account. Item 1 is not weakened by this and its own assertions all held; what is
unproven is the word *usable* meaning what a reader takes it to mean. **Closing it needs a cheaper
per-vendor credential probe, and nobody has measured which vendors expose one** — a prompt costs a
metered turn at every detection, which is what ruling 71's cache exists to avoid. `OWNER-QUESTIONS.md`
#14 keeps that half open; the per-item cost of relearning it was ruled and fixed on 2026-08-21.

**(f) The run report stated the plan had no `write` item when all five were `write` items.** Found by
the verifier, reproduced in a test before it was fixed, and fixed the same day
(`OWNER-QUESTIONS.md` #15). Recorded here because it is item 11's second half — a run where items fail
is reported without hiding the failure — and what was hidden was the failure's **kind**. An operator
reading that sentence concludes the plan was read-only and no review was owed. **No promise is left
unproven by it now**, and it is on this list because a defect item 11 should have caught was found by
someone driving the product instead.

**What the verifier did NOT find, said plainly.** It planted its own defects, drove the live items on a
credentialed machine, attacked three seams the fixture pass does not settle, and ran the required
process listing at the end — **no surviving brigadier, marked fixture or vendor process**. It accepted
the harness's own negative controls as green where it observed them fire. It retained the interrupted
clones rather than deleting them, because retained work is evidence, which is ruling 63 being obeyed by
someone who did not write it.
