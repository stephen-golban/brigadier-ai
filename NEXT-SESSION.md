> **SUPERSEDED 2026-08-21 by [`BUILD-SESSION.md`](./BUILD-SESSION.md).** This file points the
> gauntlet at `BAR.md`, and the bar is not what changed — the product is. The owner-intent session of
> 2026-08-21 found that ruling 20 made brigadier unable to plan and that `BAR.md` filed it as having
> no user-visible promise. Read [`PRODUCT.md`](./PRODUCT.md) first. Kept, not deleted, because what
> the previous round believed can be read against what was decided.

# NEXT SESSION

Start a fresh session and say:

> Read @NEXT-SESSION.md and execute the prompt.

The round this replaces — the delegated-rulings round, executed 2026-08-20 — is kept verbatim in
`PREVIOUS-SESSION.md`. Its work is on `gauntlet/next`, six commits, and the artifact frozen for the
second verifier is `gauntlet/verify-3`.

---

## The prompt

You are the **coordinator**, and the owner continues to delegate **the rulings as well as the
engineering**. Decide everything yourself. The short list of what is genuinely a human's is at the
end, and it is unchanged: if you find yourself wanting to ask, re-read it, and if it is not on it,
**rule on it and write down why**.

**Ruling on something means recording it in the record's own form** — what was decided, the reason,
and the accepted cost, in the file the decision governs, and on **issue #1** when it is a ruling.
`OWNER-QUESTIONS.md` is now a mixed file: eight entries are struck and carry their rulings, three are
still open, and **two are new and were opened by measurement rather than by opinion**. Turn what you
act on into decisions in the tree and strike it there as you go.

**Two hard boundaries, unchanged and still the point of the mechanism:**

- **You do not run the verifier.** `VERIFIER-BRIEF-2.md` is the owner's to hand over. Do not run it,
  do not simulate it, do not predict what it will find, **do not edit it**, and do not write anything
  anywhere that would steer it.
- **You do not tag.** The catch rate is still unmeasured after two attempts, and the second verifier
  has still never run.

### Where the work is

- **Worktree:** `/Users/stephen/Development/brigadier-v2-gauntlet-build`
- **Branch:** `gauntlet/next`. Start from it. Never work in `/Users/stephen/Development/brigadier-v2`
  (that is `main`); `cd` into the worktree and verify `pwd` before launching anything.
- Pushing — git holds a stale `osxkeychain` token and SSH authenticates as the wrong account:

```
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$(gh auth token)"; }; f' push
```

- **The local Linux runner earns its keep and should be the first thing you build.** Docker works, and
  the last round reproduced all three POSIX-leg bar failures in it in one 27-second run rather than
  reading CI logs:

```
cat > /tmp/Dockerfile.brig <<'EOF'
FROM oven/bun:1.3.14
RUN apt-get update -qq && apt-get install -y -qq git util-linux procps lsof nodejs curl >/dev/null 2>&1 && rm -rf /var/lib/apt/lists/*
RUN git config --global user.email "ci@e.invalid" && git config --global user.name "ci" && git config --global init.defaultBranch main
EOF
docker build -q -f /tmp/Dockerfile.brig -t brig-linux /tmp
docker run --rm --init -v "$PWD":/w -w /w -e HOME=/root brig-linux bun test <path>
```

  **`--init` is a measurement, not a flag** — without a reaping init an exited process lingers as a
  zombie, which is how `isAlive` was found unable to tell one from a running process. Run both ways
  when process lifetime is involved. **The container is NOT faithful for the process table** (PID
  namespace), and it reports **linux/arm64** on an Apple Silicon host, which matters for any size or
  architecture claim. Use it for filesystem, tooling and stream semantics; trust CI for the process
  tree.
- **There is no Windows machine here, and the round that just ended proved what to do about that:
  send an EXPERIMENT, not a guess.** A Windows leg takes 45–55 minutes, so a guess costs an hour and
  answers nothing. Two matrices — `bar/lib/capture.test.ts` and `test/git-payload-shape.test.ts` — are
  the shape that works: drive every candidate, assert only the property that must hold, and print the
  readings in the failure message.

### Read completely, before touching anything

You are **not** the verifier. Nothing is withheld from you; read all of it.

1. **`AGENTS.md`** — the four gates and the measurement discipline. Shortest, and it governs everything.
2. **`OWNER-QUESTIONS.md`** — thirteen entries, eight of them struck with their rulings. **#12 and #13
   are new, are open, and are where the next Windows work is.**
3. **`BAR.md`** — fourteen items, the coverage table over all 73 rulings, and *"When an item cannot be
   met"*, where two of its three 2026-08-20 entries are now RULED.
4. **`DETECTION-CACHE.md`** — ruling 71's cache. Its one `[owner]` question is closed.
5. **`VERIFIER-REPORT.md`** — the first verifier's verdict. Read it for its **structural** finding
   about instruments, not for its list.
6. **Issue #1** — the canonical artifact, ~310 KB. `gh issue view 1 --repo stephen-golban/brigadier-ai`
   for the body (rulings 1–48), `--comments` for rulings 49–72, **ruling 73**, measurement amendments
   §1–§21 and owner decisions §22–§31. **Reading only the body gets you half the map.**

Do not read `VERIFIER-BRIEF-2.md` looking for hints about your own work. It is not for you.

### What the last round established, so you do not re-derive it

MEASURED 2026-08-20, macOS 26.5.2 / Darwin 25.5.0 arm64, bun 1.3.14.

- `bun run gates` — **exit 0**, 1,751 pass, 0 fail, 0 skipped, 0 todo, 96 files, load1 2.30–3.08.
- `bun bar/run.ts --binary dist/brigadier --live` — **exit 0**, 14/14 PASS, load1 2.90–3.26.
- **`ubuntu-latest`'s test suite went green for the first time**: 1,757 pass, 0 fail, 0 skipped. Its
  only failing step is the release bar itself, which is *expected red* on CI — no credentials, so
  eleven items report SKIPPED and a SKIPPED blocks (ruling 48). That is the accepted cost `BAR.md`
  already records, not a regression.
- **`macos-latest` is down to ONE failing test**, and it is item 4 — §22's 7 GiB, recorded under
  `BAR.md`'s *When an item cannot be met* (c) as unmeetable on that host. Items 7 and 13 are fixed.

### Do not re-open these — each is measured dead

- **`Bun.which` DOES find npm `.cmd` shims on Windows.** MEASURED on windows-latest 2026-08-20.
- **Birth time cannot replace the inode in ruling 15's identity** — `birthtimeNs` identical in 194/200
  ext4 trials. The **clone token** replaced it; see ruling 15's entry in `BAR.md`.
- **`ps -E` cannot read another process's environment on this macOS.**
- **Credential seeding on Codex and Qwen is DEFERRED, deliberately.**
- **The LGPL/counsel gate is closed by the owner** (2026-08-20).
- **Ruling 71's cache has no TTL**, for three recorded reasons, and **`run` does not trust it** — ruled
  2026-08-20, with the reason and cost in `DETECTION-CACHE.md`.
- **`process.ppid` DOES re-read `getppid()` on Linux.** MEASURED with `probes/ppid-reread.ts`.
- **`detached: true` is not, on its own, what loses output on Windows.** Neither is the `.cmd` shim.
  The conjunction is, and `bar/lib/proc.ts`'s `DETACH_FOR_GROUP_KILL` is the branch that avoids it.
  **Do not remove `detached` unconditionally** — POSIX `killTree` depends on the group.

### Task 1 — Windows, and it is two named experiments away

Windows is the only leg with structural problems left. **Read the newest run before assuming any of
this**, because the round that just ended changed a great deal of it:

```
gh run list --branch gauntlet/next --limit 5
gh api repos/stephen-golban/brigadier-ai/actions/jobs/<job-id>/logs > /tmp/win.log
```

- **`OWNER-QUESTIONS.md` #13 — a dozen planted-payload NEGATIVE CONTROLS are inert there**, so each
  is a control that cannot control and every guard beside it is unproven on that platform.
  `test/git-payload-shape.test.ts` was pushed to answer it and its matrix is in the newest Windows
  log. **Read the matrix first.** It says which of four payload shapes fires; the fix is then one
  edit to the fixtures rather than three guesses.
- **`OWNER-QUESTIONS.md` #12 — a whole `brigadier run` is 35–160× slower there.** MEASURED: 314–896 ms
  on the POSIX legs against 31,014–51,116 ms on Windows, real durations rather than timeout
  artefacts. No cause is claimed and four candidates are named. This is a **product** property on a
  platform ruling 12 makes first class, and nothing in `BAR.md` measures it. One experiment that
  times the pieces separately would settle it, in the shape #9's 2x2 already proved works.
- **The remaining families**, from the newest triage: the ruling-63 drain and the `setsid`-shaped
  process tests (no Windows mechanism is written — each now fails loudly and names what would have to
  be built, see `bar/lib/platform.ts`), and `ruling 54's arithmetic`.

**What would make this worth having.** Not "CI is green". A CI that is green because a check was
weakened is worse than one that is red honestly. Every fix names what failed, on which platform, why
it failed there and not here, and what it costs. A test you cannot make pass honestly gets said out
loud under `BAR.md`'s *When an item cannot be met* — never `skip`ped, and never with a body-level
early return, which renders as `(pass)` and is now refused by `bar/lib/platform.test.ts`'s tree scan.

### Task 2 — the discriminated union, and it goes FIRST or not at all

`OWNER-QUESTIONS.md` #5 was ruled **deferred to a round that begins with it**, and this is that round
if you want it. `Check` becomes a union whose note arm carries no `ok`, at ~41 call sites inside the
instrument that grades the release. The runtime guard added on 2026-08-20 catches an author who
reaches for `note` while writing a verdict; it does not catch a note whose prose describes a blocking
condition, and only the union can. **If you take it, take it first and verify it alone. Do not start
it late** — amendment §20 records three occasions on which this instrument became the defect.

### Task 3 — what is left open, ranked

1. **`OWNER-QUESTIONS.md` #13**, the planted-payload matrix. Cheapest, and it unblocks a dozen tests.
2. **#12**, the Windows slowdown. A product property nobody has measured.
3. **#5**, the union, if it is taken at all — and only first.
4. **#7**, the `execute` that asked no permission. Settling it costs one more real prompt turn driving
   an operation the mode calls dangerous. That is on the owner's list if it needs metered spend, and
   is not if it runs on the operator's own authenticated session.
5. **#8**, the first verifier's `Authentication required`. Still unexplained, and the bridge has moved
   0.69.0 → 0.70.0 since, so the artifact it drove is not the artifact here.

### Machine discipline — put this block in every builder brief, verbatim

- Never generate load deliberately. Poll `uptime` until load1 < 3.0 before measuring, and **record the load you measured at**. A contended reading is not this artifact's cost.
- **One test process at a time.** Builders run only their own test files by path. No bare `bun test`, no `bun run gates`, no `bun run build`, no `bar/run.ts` — the coordinator runs those alone.
- Never `cmd | head` then read `$?` — that is `head`'s exit code. Redirect to a file, then read the file.
- Never capture multi-line output into a shell variable. Redirect to a file and grep the file.
- Search unconstrained, then filter. `rg` honours ignore files and has silently skipped an entire package in this repository. `scripts/license-gate.ts` contains a NUL byte — plain `grep` reports zero matches on it; use `grep -a`.
- Reap every spawned process, grandchildren included. Before finishing, run `ps -A -o pid=,ppid=,etime=,args= | grep -E "brigadier|marked\.ts|vendor\.ts"`.
- **Do not delete `~/.brigadier-bar*` wholesale.** Do not kill processes matching only the repo path — that is the operator's editor.
- **Never run a probe whose own command line contains `--brigadier-run`** while the bar is running. It contaminates the in-flight marker scan.
- `bar/` must never import from `src/`, type-only imports included; `bar/self-check.test.ts:34-73` enforces both directions. `test/` importing from `bar/` is fine and is now the idiom for fixtures.
- Record every result as **"MEASURED against `<tool> <version>` on `<date>`"**, never present tense. **A negative result is a good result** — report it plainly and never reword a probe until it passes.

### How to run

You are the coordinator. Run the gates alone. Commit per round with the reason, not just the change.

```
cd /Users/stephen/Development/brigadier-v2-gauntlet-build
bun run gates                                   # typecheck && build && test-gate && claims
bun bar/run.ts --binary dist/brigadier --live   # under two minutes, costs nothing
```

`gates.yml` triggers on a `paths` filter. A commit touching only a `.md` file that is not `BAR.md` or
`THIRD-PARTY.md` **starts no CI run** — that is correct, and it is also how you can end a round with
an untested HEAD without noticing. Put code and prose in the same commit, or say which sha CI graded.

### Freeze an artifact for the second verifier, and report its sha

**Freeze at the END of your round, not the start**, and freeze whatever you actually finished:

```
git branch gauntlet/verify-4 <your final sha>
git push origin gauntlet/verify-4
```

Leave `gauntlet/verify-2` and `gauntlet/verify-3` where they are; each is a record of what a round
handed over. **Your report must name the new sha in one line the owner can paste into the brief.** You
do not paste it yourself — that one edit is the owner's hand-off.

### What is genuinely a human's — and it is only this

Do not ask about anything else. Collect these at the end, in one short section of your report.

- **Running the second verifier.** A separate blind session on a different vendor. You cannot start it
  and must not simulate it.
- **Pasting the frozen sha into `VERIFIER-BRIEF-2.md`.** One line, and it is the owner's hand-off.
- **Tagging.** Never yours.
- **Spending real money.** Anything behind `--yes-spend-real-vendor-money`. A single free prompt turn
  on the operator's own authenticated session is normal and is what bar item 14 already does.
- **Reversing something an owner decision already settled** — §22–§31. You may rule on what they left
  open. You may not overturn what they closed. If you think one is wrong, say so with the measurement
  and leave it standing.

The mechanism has cost one verdict and bought seven defects that nine rounds of self-review never
found, five more from asking why CI was red, and — from the round that just ended — three more that
only a Windows leg and a Linux container could show. **The second verifier has still never run**, and
that is the verdict that decides whether any of this holds.
