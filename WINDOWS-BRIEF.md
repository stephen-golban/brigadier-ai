# Windows measurement brief — brigadier-ai

Paste everything below the line into a fresh Claude Code session on the Windows PC.

Before you do, copy two files across from the Mac:

- `brigadier-gauntlet-build.bundle` (1.8 MB) — the branch, transferred without a push
- this brief

---

You are measuring code that **has never executed on any Windows machine, or on any CI runner, ever.**
Nothing here is a regression hunt. Every finding is a first measurement, and a failure is a result,
not a problem to hide. Report what happens, including the boring parts.

## Why this matters more than it looks

`gates.yml` exists in the repository and **has never run**. `origin/main` is 30+ commits behind local,
so every CI run this project has ever had is `portability`, which ruling 62 states is **not** a gate.
"Gates green" has therefore meant *green on one macOS machine* for the entire life of the project.

Ruling 12 makes Windows first class. The Windows process reader (`Get-CimInstance Win32_Process`),
the `taskkill /T /F` escape branch, and the `cmd /c start` escapee fixture are **written and
unmeasured** — deliberately left to fail loudly rather than hide behind a skip. You are the first
execution.

The precedent that justifies the trip: v1's worst defect was a global git-config check that made the
product refuse to run for **every git-lfs user, in every repository**. It survived 740 tests, four
gates, two adversarial review lenses and twenty-two work orders. It was found by pushing to CI. The
author's machine was not broken — it was *normal*. A bar that only runs on normal machines cannot
find that class of defect.

## STOP — read this before running anything

**There is a measured risk that one item writes into your real user profile.**

`bar/lib/proc.ts` plants a scratch `HOME` for the install tests **while passing through your real
`USERPROFILE`**. `src/plugin/install.ts` deliberately prefers `HOME` on every platform. On Windows,
if any path resolves via `USERPROFILE` instead of `HOME` — which is the normal Windows convention and
has never been tested here — **item 10 will install brigadier's plugin into your actual profile**
rather than the scratch directory.

So, in this order:

1. Record what is there first, so you can prove what changed:
   ```powershell
   dir $env:USERPROFILE\.claude, $env:USERPROFILE\.agents, $env:USERPROFILE\.brigadier -ErrorAction SilentlyContinue
   ```
2. Run **task 2 step 1** (the dry run) before any other item-10 work.
3. If anything appears in your real profile, **stop, say so, and do not continue with item 10.** That
   is a genuine finding and it is worth more than the rest of the item.

Nothing else in this brief writes outside the repository and a scratch directory.

## Setup

```powershell
# 1. Get the branch from the bundle — no network, no push involved
git clone brigadier-gauntlet-build.bundle brigadier-v2
cd brigadier-v2
git checkout gauntlet/build
git log --oneline -1        # expect a commit around 40b0439 or later

# 2. Toolchain
bun --version               # a Bun 1.3.x is expected; report what you actually have
git --version               # 2.38.0 is the hard floor (merge-tree --write-tree)
bun install
```

`dist/` is gitignored, so there is no binary in the bundle. You will build one — that is deliberate,
because a Windows-built artifact is the thing worth measuring.

Report the `bun` and `git` versions you actually got. Every claim in this project is written
"MEASURED against `<tool> <version>` on `<date>`", and yours will differ from the Mac's.

---

## Task 1 — run the gates. First execution on any platform.

```powershell
bun run gates
```

That is `typecheck` → **`build`** → `test-gate` → `claims`, and it is expected to take a while.

**`build` is stage 2, not stage 4, as of 2026-08-20**, because a test drives `--binary dist/brigadier`
and `dist/` is gitignored, so the artifact has to exist before the suite runs. The cost lands hardest
on you: **if `build` fails you get no test results at all.** Should that happen, run `bun run
test-gate` on its own afterwards and report it separately — the test signal is the more informative
half and it must not be lost to a build failure.

Report, for each of the four stages: pass or fail, and **the actual error text** on failure — not a
summary of it. Failures here are the point of the exercise. If `build` succeeds you have
`dist/brigadier.exe` (or `dist/brigadier` — report which), and everything below needs it.

On the name: `bun build --compile` appends `.exe` for a Windows target whatever `--outfile` it is
handed — MEASURED against `bun 1.3.14` on `darwin 25.5.0` on 2026-08-20 by cross-compiling with
`--target=bun-windows-x64`. `scripts/build.ts` used to ask for `dist/brigadier` and then refuse
because `dist/brigadier` was absent, so **`bun run build` could not succeed on Windows at all**, and
ruling 47's licence gate never ran there. Both it and `scripts/license-gate.ts` now stat both names
and use whichever the compiler actually wrote. **That fix has never executed on Windows — you are its
first test.** If `BUILD REFUSED` still appears, paste the whole message: it names every candidate it
looked under.

Specifically worth watching, none of it ever exercised:

- Does `test-gate` parse `bun test` output the same way on Windows? It writes output to a file, reads
  it back, and fails on any `skip` or `todo`.
- Does `claims` traverse paths correctly? It greps the tree and checks BAR.md's coverage table.
- Does `build` produce a working `.exe`, and what does it weigh? The 63 MiB budget is a **macOS**
  measurement. Measure the Windows artifact; do not assume it carries over.

## Task 2 — item 10, the artifact ships

**Step 1, the dry run, before anything else.** Confirm the scratch-`HOME` mechanism actually contains
the install on Windows:

```powershell
bun bar/run.ts --binary dist/brigadier.exe --only 10
```

Then immediately re-run the profile listing from the STOP section above and diff it against what you
recorded. **Report whether your real profile changed.** If it did, stop item 10 here.

If it is clean, answer these. Each is a branch that has never run:

1. **Node stripping.** `pathWithout`/`resolveNode` carry a `cmd /c where node` plus `node.exe/.cmd/.bat`
   branch, never once executed. Does the strip genuinely remove `node`, and does `brigadier licenses`
   still run with it gone? BAR item 10 promises the binary runs with node absent from `PATH`.
2. **Can Bun drive `claude.cmd`?** Does `Bun.which("claude")` find it, and can `Bun.spawn` execute a
   `.cmd` shim? If not, the host half of the hook check silently becomes a "host not consulted" note
   on Windows — and that note is currently being changed to a **blocking** failure precisely because
   it was passing vacuously. Tell me which way it goes here.
3. **Path separators.** `listTree` normalises to `/` and the hook lookup matches `hooks/hooks.json`.
   Confirm that holds with backslashes in play.
4. **`MAX_PATH`.** The install home nests to
   `.../10/hooks-home/.claude/skills/brigadier/hooks/hooks.json`. Ticket #5 measured a clone failing at
   **198 characters**. Report the full resolved length and whether it survives. Also report whether
   long-path support is enabled on this machine
   (`Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled`) —
   the answer changes how to read every other path result here.
5. **Uninstall under file locking.** Windows holds locks Unix does not. Does removal actually complete,
   and is the directory listing empty afterwards?
6. **Do not reinstate a cold-start budget.** The `≤70 ms` cold-start clause was struck by the owner on
   2026-08-19 — it was never measured and is unreachable. Its stated *reason* is macOS's XProtect, but
   **the withdrawal is global.** If you measure Windows SmartScreen or Mark-of-the-Web numbers, record
   them as interesting; they do not reopen the budget. No budget in this project is ever adjusted to
   fit a measurement, in either direction.

## Task 3 — item 7, interruption and the escapee

This is the item with the most never-executed Windows code. It **spends no vendor money** — it plants
fixture agents, and is gated behind `--live` only because it SIGKILLs runs and leaks a descendant
deliberately.

```powershell
bun bar/run.ts --binary dist/brigadier.exe --only 7 --live
```

Answer these five:

1. **Does the process reader return usable rows?**
   ```powershell
   Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }
   ```
   Specifically: is `CommandLine` **non-null for a Bun-spawned child**? It is null for protected
   processes. If it comes back null, both the stray scan and ruling 38's command-line marker go blind
   on Windows, and that is a major finding — the marker is the entire basis of the sweep.
2. **Orphan detection.** `pgid` is 0 on Windows by construction, so the escape check falls back to
   "parent absent from the table". Does Windows leave the dead parent's pid in `ParentProcessId` after
   the parent dies? If it reuses or zeroes it, the fallback misfires.
3. **Does the escapee actually escape?** The fixture uses `cmd /c start /b`. Does that child survive a
   SIGKILL of the orchestrator, and does its `for /l` loop's working directory sit **inside the clone**?
   That cwd is ruling 38's third link and the only thing that reclaims a process whose command line
   cannot be marked.
4. **Does `taskkill /T /F` reach a `start`-detached grandchild at all?** Ticket #43 measured Bun's job
   object carrying both `BREAKAWAY_OK` and `SILENT_BREAKAWAY_OK`, which is why the sweep exists. If
   `taskkill /T` cannot reach it either, say so — that is the finding.
5. **`MAX_PATH` again**, on a different shape: `<workroot>/07/runs/r/<run-id>/<n>` plus a clone tree.

**Before you finish this task**, list anything still running and kill it:
```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "brigadier|vendor.ts|marked.ts" } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```
Report what you found, **including "nothing"**. On the Mac an escapee once survived 2h20m at 100% CPU.

## Task 4 — the hostile-but-legal leg

BAR.md requires one CI leg configured hostile-but-legal, because v1's defect was found by a *normal*
machine. Reproduce two findings from ticket #5 that are **invisible on macOS**:

1. **`core.autocrlf`.** #5 measured `core.autocrlf=false` turning a one-line edit into a **six-line
   whole-file diff**. Set it both ways, make a one-line change in a clone, and report the diff size
   each way. This matters because ruling 51 gates ownership on `git diff --name-only <base>..work` —
   if line endings inflate a diff, an item's ownership check sees files it should not.
2. **`git-lfs` filters in the global config.** This is the shape of v1's worst defect. Install the
   filters globally (`git lfs install`), then run task 1's gates and item 10 again. Does anything
   refuse to start?

Also report, since they feed the hostile leg: does a v1 `brigadier` already exist on this machine's
`PATH` (ruling 46 records v1 shipped one on a Homebrew tap — probably not on Windows, but confirm),
and what does `git config --global --list` show that a clean machine would not?

---

## Discipline — these are not optional

- **NEVER generate load deliberately.** To distinguish contention from a real failure, run the test
  **alone** on an otherwise quiet machine. On the Mac an agent ran 16 busy-wait subshells plus two
  concurrent suites to test whether failures were load-related and drove the machine to **load average
  146 on 14 cores**. Do not repeat it.
- **One test process at a time.** No background suites. Run `bun run gates` once.
- **Every spawned process must be reaped, including grandchildren.**
- **Cleanup must never sit downstream of an unbounded wait** — if the awaited thing wedges, the cleanup
  line is never reached.
- **Do not delete `~/.brigadier-bar*` wholesale.**
- **Do not push anything.** The branch is not on `origin` and the owner has not authorised a push.

## What to send back

Plain text, negatives included, verbatim rather than summarised. For each task: what you ran, what you
observed, and pass/fail/couldn't-run. **A "couldn't run" is a result** — under this project's rules a
check that did not run is not a check that passed, and a `SKIPPED` item blocks a release exactly as a
`FAIL` does. Do not tidy anything up, do not fix the product to make a check pass, and do not soften a
failure. Include your `bun` and `git` versions and the Windows build number, because every claim here
is recorded as measured against a named version on a named date.
