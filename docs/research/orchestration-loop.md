# The orchestration loop — W1-B, designed

Date: 2026-09-04. Status: **design, nothing built, nothing compiled.** Written against `main` at
`a889525`.

This is the design for `docs/plans/phase-4.md`'s **W1-B**, which owns `crates/supervisor/src/` and
which that plan calls *"the loop. This is the product."* It implements `docs/vision.md` §4 step 7:
a lead call emits an action, work orders are dispatched into isolated worktrees, workers return
reports, the gate is a real exit code, green means merge-commit-clean-up-next.

Rules of this document, per `CLAUDE.md` §1 rule 5 and `docs/vision.md`: one line per fact, a path
or a number instead of an adjective, every claim tagged **[measured]** (run on this machine today,
command shown), **[source]** (read in code on this machine, `file:line`), **[documented]** (vendor
docs, URL + date), or **[asserted]** (reasoning, unverified). §14 says what was not checked.

**Nothing here was compiled or run.** Another worker held `cargo` and `npm` for the whole of this
order; `cargo check` was not run, no test was run, no build was run. Every Rust signature, every
module name and every file layout below is written from reading, not from a build — the same
disclaimer `docs/research/intent-records.md` §9 carries, and for the same reason.

---

## 0. Where the loop starts from

**Nothing in the app spawns a child on its own initiative today.** The only production caller of
`Supervisor::start_session` (`crates/supervisor/src/lib.rs:539`) is a Tauri command behind a button
(`src-tauri/src/commands.rs:138`). **[source]** The loop is the thing that changes that, and it is
the reason every rule below about *what must be true before a spawn* is load-bearing rather than
tidy.

W1-B is entirely unstarted: `grep -rn` in `crates/supervisor/src/` returns **0** hits each for
`lead_call`, `work_order`, `fusion` and `verify_command`. **[measured]** 2026-09-04.

What already exists and the loop builds on, all **[source]**:

| capability | where | note |
|---|---|---|
| spawn / resume / kill a child, one worktree each | `crates/supervisor/src/lib.rs:539,624`, `crates/supervisor/src/worktree.rs:232` | branch `brigadier/<8 hex>` off `HEAD` |
| the canonical event stream, one consumer per session | `crates/supervisor/src/lib.rs:1218` (`consume`), `:1277` (`route`) | `route` sees the whole `Envelope`, `raw` included |
| a synthesized exit when a stream closes without one | `crates/supervisor/src/lib.rs:1240-1252` | a dead child always produces a terminal event |
| approvals parked in a real table, answered by `respond` | `crates/supervisor/src/lib.rs:854` | the only pre-effect hook there is (`intent-records.md` §1.1) |
| a git layer that shells out and classifies stderr | `crates/core/src/worktree.rs` | `add_or_rollback`, `dirty_count:719`, `commits_only_here:767` |
| a driver with no child process, scripted from real captures | `crates/supervisor/src/replay.rs:142` | how most of §13's free tests run |
| arbitrary reads inside the writer's transaction | `crates/store/src/writer.rs:80` (`Op::Query`) | lets the loop read W1-A's tables before W1-A ships typed accessors |

What does **not** exist and the loop needs: a way to run a non-`git` command and capture its real
exit code; a way to get a child's *full* final text; a phase-stable base sha; and the plan/progress
store W1-A is building right now.

---

## 1. The state machine

### 1.1 States

One machine per **run** (one brigadier session = one approved goal + one plan), and one nested
machine per **phase**. The run machine is thin:

```
Cold ─▶ AwaitingReconcile ─▶ Running ─┬─▶ Parked(reason)  ─▶ Running
                    │                 ├─▶ Blocked(reason) ─▶ (owner)
                    ▼                 └─▶ Finished
              Blocked(reconcile_failed)
```

The phase machine is where the work is:

| state | left by | next |
|---|---|---|
| `PhaseReady` | the run picks it | `LeadCalling` |
| `LeadCalling` | a validated action arrives, or two malformed ones do | `Dispatching` / `Gating` / `Merging` / `Replanning` / `Blocked` |
| `Dispatching` | every order has a worktree, a base sha and a child | `Working` |
| `Working` | every order settled (report, deadline, or exit) | `Collecting` |
| `Collecting` | every order's claims re-derived from git | `Reviewing` or `Gating` |
| `Reviewing` | the review child returns | `Gating` |
| `Gating` | the verify command exits | `Green` or `Red(rung)` |
| `Red(rung)` | the rung's attempt settles | `Gating` (next attempt) or `Blocked` |
| `Green` | the merge-commit intent closes `done` | `CleaningUp` |
| `CleaningUp` | every removable worktree is gone | `PhaseDone` |
| `Parked(approval\|reserve)` | the approval resolves, or the window resets | back to the state it left |
| `Blocked(reason)` | only the owner | `PhaseReady` or dropped |

`Parked` is per **order**, not per phase, and is the subject of §11. `Blocked` is per phase and is
never left by the loop.

### 1.2 Where each transition is persisted

Two stores, and the split matters:

- **Position** — which phase, which state, which attempt — goes in W1-A's plan/progress tables
  (`phases`, `work_orders`; column names unknown to this document, §12).
- **Effects** — the things that outlive the process — go in `intents`
  (`docs/research/intent-records.md` §2.1), one row committed *before* the effect and closed after.

The rule that keeps them from lying to each other: **a state transition that causes an effect
writes its intent row first, and the position row only after the effect returns.** So a crash
always leaves position *behind* reality, never ahead of it, and the reconciler's job is to close
that one-step gap by reading the world.

`intent_open` is followed by `StoreHandle::flush()`; the position write is not flushed. That is
`intent-records.md` §2.3's ladder verbatim, and the loop must not invent a second ordering.

### 1.3 The failure the persistence prevents

Concretely, and this is the whole reason the machine is durable rather than a `loop { }`:

> The harness dies while phase 3's four workers are mid-order. On restart, an in-memory loop
> re-reads the plan, sees phase 3 not done, and dispatches four **fresh** work orders. Four new
> worktrees appear beside four that already hold commits. The new workers redo the work. The merge
> then takes one set and silently discards the other, and the thread says "Phase 3 green" about a
> phase that ran twice.

The durable machine instead resumes at `Working`, asks the reconciler what each `work_order`
intent's postcondition says, and gets one of two answers per order: `not_done` (provably nothing
moved — safe to re-dispatch) or `unknown` (something moved — **blocks the phase, never repeats
it**, `intent-records.md` §5.1). It never gets `done`, because "the worker committed something" is
not "the worker finished the order" (`intent-records.md` §4.3, `docs/vision.md` §8).

A second failure the same persistence prevents: a crash between the merge into base and the
progress write. Without the `phase_commit` intent row the loop cannot tell "merged, ack lost" from
"never merged", and re-merging an already-merged phase is how a run produces a duplicate commit.

---

## 2. The lead call

### 2.1 What goes into the window

A lead call is a **fresh child, one turn, thrown away.** `ThinkingPolicy::Inherit` — the judgement
lane is what opts back into thinking (`crates/core/src/driver.rs:275-307`, whose own doc says the
default is `Off` and "the judgement lane is what opts back in, per spawn"). **[source]**

The harness assembles the whole prompt. Nothing a model wrote in a previous call is carried
forward except as harness-normalised data:

1. **The goal**, verbatim, as the owner approved it. Immutable for the run (§10).
2. **The plan**: one line per phase — index, title, state, definition of done, verify command.
3. **Progress**: for each finished phase, the merge sha and its subject. Never a diff.
4. **The last outcome**: what the previous action produced. For a red gate this is the command, the
   exit code, the reason slug and the log **path** — never the log's contents (§6.4).
5. **The recon brief** — the ~1,500-token git brief W1-C owns (`docs/vision.md` §7). No index; the
   brief is content-addressed with blob OIDs, because mtime keying misses on 100% of files in a
   fresh worktree and every worker runs in a worktree (`docs/research/codebase-index.md`).
6. **The open unknowns**: grill questions the owner waved off with "just go" (`docs/vision.md` §4.5
   requires that skipping be recorded so a later failure can name which one), and any `unknown`
   intent attached to this phase.

Budget: **≤ 6,000 prompt tokens**, **[asserted]** and unmeasured. What would settle it: assemble
the six parts for this repository and count. Nothing in the tree counts prompt tokens today.

What is deliberately absent: the thread, any earlier lead call's prose, any worker transcript, any
verify output. Those are the things that make a window accumulate, and `docs/vision.md` §1 is the
product statement that they do not.

### 2.2 How an action comes back, and why not the obvious way

The action is a single fenced ` ```json ` block in the child's final assistant text.

**Three channels were checked; two are unusable, and the measurement is the argument.**

- **`Event::ItemCompleted.summary` cannot carry it.** `summarize` takes *the first non-empty line*
  and bounds it to `SUMMARY_LIMIT = 240` (`crates/core/src/claude/adapter.rs:1278-1281`,
  `crates/core/src/event.rs:23`). **[source]** A JSON block would arrive on the event stream as the
  single character `{`. Any design that reads the action off the canonical event stream is wrong at
  the first brace.
- **The store cannot carry it either.** `feed` holds `(session_id, seq, at, line)` plus migration
  1's `kind` — one pre-rendered terse line and no body (`crates/store/src/schema.rs:89-95`).
  **[source]**
- **`Envelope.raw` carries the whole provider frame and reaches `route`**
  (`crates/supervisor/src/lib.rs:1277-1296`) **[source]**; it is stripped only for the wire (the
  8 KB `eval` cliff, `docs/STATUS.md` landmines). So the bytes exist in-process. They are the
  provider's own JSON, which `crates/supervisor` must not parse — that would put a Claude wire shape
  in a provider-agnostic crate.

**Decision: a new `ProviderDriver` accessor for a turn's full final assistant text**, implemented in
`crates/core/src/claude/` where the frame is already decoded, consumed by the loop through the
trait. It is a change to `crates/core/`, which W1-B does not own, so it is its own order (§13, B3).

**Two rejected alternatives, with the reason:**

- *The child writes `action.json` and the harness reads the file.* Exact bytes, no parsing, survives
  a crash — but `Write` is in `GATED_TOOLS`
  (`crates/core/src/claude/hook.rs:42` — `["Bash","Write","Edit","MultiEdit","NotebookEdit"]`,
  **[source]**), so it prompts, and pre-authorization is W3-A and **unbuilt**. A control plane that
  cannot run until the wall is wired is a control plane that blocks the loop. Revisit once W3-A
  lands; a file is strictly better than a parse.
- *Let the child call a designated tool and harvest `input_excerpt` from the parked permission, then
  deny it.* It works — that excerpt is capped at `INPUT_EXCERPT_LIMIT = 8 KiB`
  (`crates/core/src/event.rs:20`, **[source]**) — but it spends the approval machinery, which is the
  safety boundary (`docs/vision.md` §9), on a control-plane trick. Refused.

### 2.3 The action set

A closed set, read **strictly** — the opposite of the store's lossy slug convention
(`crates/core/src/driver.rs:230` `from_slug_lossy`), because an unrecognised *stored* value must
degrade safely while an unrecognised *action* must never be executed.

| action | payload | effect |
|---|---|---|
| `dispatch` | `orders: [{ id, title, instructions, owns: [path…], model_tier }]` | §4 |
| `review` | `focus`, `orders: [id…]` | one adversarial child over the collected diffs |
| `verify` | `phase_id` | run the phase's **stored** verify command (§6) |
| `merge` | `phase_id` | §8 |
| `replan` | `add / edit / drop`, each with a `reason` | §10 |
| `ask_owner` | `question`, `why_blocked` | phase → `Blocked`, plan card entry |

### 2.4 Rejecting a malformed or hallucinated action

Five gates, cheapest first, all in the harness:

1. **Exactly one** fenced `json` block in the final text. Zero or two → malformed.
2. Parses as JSON, and `action` is in the closed set above.
3. Schema-valid for that action; unknown fields are an error, not ignored.
4. **Semantic validation against the world** — this is the half that catches hallucination, and it
   is the half that is easy to omit:
   - every `owns` path is project-relative, contains no `..`, and resolves inside the project root
     after symlink resolution;
   - `owns` sets are pairwise disjoint **by path component**, never by string prefix — `src/a` and
     `src/ab` do not collide and a `starts_with` on strings says they do;
   - every order owns at least one path;
   - the named phase exists and is the phase the loop is on;
   - a `verify` action names the phase's stored verify command **verbatim**. The lead may not invent
     one. Wanting a different verify command is a `replan`, and a `replan` that moves a verify
     command is a definition-of-done change (§10);
   - a `merge` names only branches this phase's orders are on.
5. **Reserve** (`docs/vision.md` §6): a `dispatch` whose order count would take utilization past
   the owner's line is not malformed — it parks (§11).

**On malformed: kill the child and spawn a fresh one.** Do not send a follow-up turn. The window
that produced a malformed answer is already polluted, and rung 1 of the red-gate ladder exists on
exactly this reasoning (`docs/vision.md` §5: *"fixes the common case where a worker's window got
polluted early and it spent the rest of the order defending a misreading"*). The retry's context
gains one line: the validation failure, quoted. The cost is one spawn — **643.5 ms** median to
`system/init` with `--strict-mcp-config`, which harness children get by default
(`docs/research/spawn-split.md`, via `docs/vision.md` §3). **[measured]**

**On the second consecutive malformed action for the same phase: stop.** The phase goes to
`Blocked(malformed_action)`, one `RuntimeWarning` feed row is emitted, and the plan card carries
both rejected payloads (bounded) and both validation failures. Two independent fresh windows
failing the same schema is evidence about the prompt or the plan, not about the window, and a third
spawn buys the same answer at the same price. **[asserted]**, and it is the same shape as rung 3.

A child that ends its turn with prose and no block at all is malformed #1, not a special case.

### 2.5 Deadlines

A lead call gets a wall-clock deadline; on expiry the loop calls `interrupt`, then `kill` after a
grace, then treats it as malformed. Default **120 s**, **[asserted]** — nothing in this repo has
measured a lead-call turn, because no lead call has ever run.

---

## 3. Dispatch: partitioning

### 3.1 The partition is proposed by the lead and validated by the harness

`owns` is a set of write-owned paths per order. Reads are unrestricted; ownership is about writes,
because the waste `docs/vision.md` §6 names — *"four workers each reading the same five files"* — is
a partitioning failure to be avoided, not a rule to be enforced.

**An overlapping partition is refused, never repaired.** The loop does not de-overlap it itself: a
harness that reassigns files is making a plan decision with neither a model nor the owner behind it.
The fresh lead child is told which two orders collide on which path.

### 3.2 Ownership is advisory going in, and enforced coming out

Nothing stops a worker writing outside its `owns` set. The wall says so itself: *"This module
answers what a command does, never where it does it … 'below the worktree root' is not a question
this file can answer"* (`crates/core/src/wall/mod.rs:26-33`). **[source]**

So ownership is enforced **post hoc, at the merge**, and it is cheap:

```
git -C <worktree> diff --name-only <base_sha>..<branch>
```

Any path outside the order's `owns` set **blocks the merge** for that phase and goes to the owner.
It never authorizes the merge; a subset check that passes proves only that this particular failure
did not happen. One subprocess per order.

### 3.3 The base sha, and a hazard that exists today

`worktree::prepare` branches from the constant `BASE = "HEAD"`
(`crates/supervisor/src/worktree.rs:50`) and `Prepared` carries only `{ git, repo, path, branch }`
(`:157-164`). **[source]** Two consequences, both real:

1. **`work_order`'s intent baseline needs the base sha**, and `Prepared` does not have one
   (`intent-records.md` §4.3: baseline is *"`git rev-parse <BR>` at dispatch, and `dirty_count` at
   dispatch"*). It must be captured before the `add`, not read back after.
2. **`HEAD` moves once the loop starts committing.** Today nothing moves the project's `HEAD` while
   sessions run; the loop is precisely the thing that will. Two orders dispatched either side of a
   phase commit would branch from different commits, and the merge would then be against two
   different bases. **Remedy: resolve the base sha once per phase and pass it explicitly.**
   `WorktreeSpec.base` is already a `String` (`crates/core/src/worktree.rs:18`), so this is a
   parameter change, not a new mechanism. **[source]**

### 3.4 How many workers run at once

Four bounds, in the order they bite:

1. **The reserve** — `docs/vision.md` §6. Checked before every spawn, never mid-flight, because the
   gauge cannot be sampled mid-flight: exactly **one** `rate_limit_event` fires per session, at
   **804–984 ms**, reporting utilization *before* that session's own spend, at **1%** resolution
   (`docs/research/fanout-vs-children.md`, via `docs/vision.md` §6). **[measured]** Every dispatch
   yields a fresh reading, which is what makes a per-dispatch gate sufficient.
2. **A hard cap, default 4.** **[asserted]**, and it should be read as a guess: `intent-records.md`
   §6 assumes four orders per phase and `docs/vision.md` §9's mock shows three, and neither is a
   measurement. It is not a cost control — *"Parallelism is token-neutral"* (`docs/vision.md` §6) —
   it is a bound on how far the reserve can be drawn down between two samples, and on how many
   concurrent builds the machine will take. Neither has been measured.
3. **The partition** — N orders means N disjoint parts, and the lead found them.
4. **Parked orders do not count** against the cap (§11).

Startup cost, so nobody is surprised: N spawns cost N × 643.5 ms of pure startup even when
concurrent-scheduled, and a ten-step phase pays ~6.5 s (`docs/vision.md` §3). **[measured]** A warm
pool and multi-turn children are the named mitigations and **neither is built or measured**
(`docs/plans/phase-4.md`, "Research owed"). Nothing in this design assumes either.

---

## 4. Collecting reports

### 4.1 A report's shape

The same fenced-JSON channel as §2.2:

```json
{ "order_id": "…",
  "status": "done" | "blocked" | "partial",
  "summary": "one paragraph, <= 400 chars",
  "files_changed": ["src/a.rs"],
  "commits": ["<sha> <subject>"],
  "blocked_on": null,
  "notes_for_review": null }
```

**A report is a claim, never evidence.** Every field is re-derived before it is used:

| claimed | re-derived by |
|---|---|
| `commits` | `git log --format=%H%x00%s <base_sha>..<branch>` |
| `files_changed` | `git diff --name-only <base_sha>..<branch>`, plus `dirty_count` for the uncommitted remainder (`crates/core/src/worktree.rs:719`) |
| `status: "done"` | **nothing.** It is stored as the worker's claim and never settles anything |

The last row is `docs/vision.md` §8's named failure mode — *agents declaring done prematurely and
marking features complete without end-to-end tests* — turned into a rule: an order is complete only
when its report arrived **and** the phase's gate exited 0. Neither alone, ever.

### 4.2 A worker that returns nothing

Turn completed with no fenced block, or the session exited without a `TurnCompleted`. The harness
does not guess: it runs `work_order`'s postcondition, which is the same function the reconciler runs
(`intent-records.md` §4.3) — **one implementation, called from two places**, because a second copy
is how the live path and the restart path drift into disagreeing about the same repository.

- nothing moved (`rev-list --count` and `dirty_count` both at baseline) → `not_done` → the order may
  be re-dispatched, once;
- anything moved → `unknown` → **the phase blocks** (`intent-records.md` §5.1). Not repeated.

One detail that is load-bearing and easy to get wrong: `dirty_count` passes `--ignored=matching`
and `--untracked-files=all` (`crates/core/src/worktree.rs:719-733`, **[source]**), and
`.brigadier/` is excluded through `$GIT_COMMON_DIR/info/exclude`
(`crates/supervisor/src/worktree.rs:37`, **[source]**) — which is the *common* dir, so the exclusion
is in force inside every linked worktree. Therefore **any harness file placed inside a worker's
worktree counts toward `dirty_count`.** The rule: every such file (§6.4's gate log, and the report
file once W3-A allows one) is created **before** the baseline is captured, so its presence is in
both numbers and only its *content* changes.

### 4.3 A worker that never exits

Two clocks, both needed, and one suspension rule:

- **Turn deadline** — no `TurnCompleted` within T. Escalates `interrupt` → grace → `kill`.
- **Quiet deadline** — no envelope of any kind within Q. Catches a child that is alive and wedged,
  which the turn deadline sees only at its end.
- **Both are suspended while the order is parked on an approval** (§11). Without this the harness
  kills the exact worker the owner is about to unblock, which is the overnight run failing in the
  one way `docs/vision.md` §8 says it must not.

T and Q are **[asserted]** defaults with no measurement behind them. The existing backstop covers
only the dead-child case: `consume` synthesizes a `SessionExited` when a stream closes without one
(`crates/supervisor/src/lib.rs:1240-1252`, **[source]**), so a corpse always produces a terminal
event; a live silent child produces nothing, and Q is the only thing that sees it.

---

## 5. Review, where it is earned

Between `Collecting` and `Gating`, and only when the lead's action asked for it. One fresh child,
handed the combined diff (`git diff <phase_base>..<integration>`) and the phase's definition of
done, returning a fenced block of `{ blockers: [...], notes: [...] }`.

A blocker does **not** stop the gate — the gate is objective and cheaper than an argument. A blocker
that survives a green gate is surfaced on the plan card as a note, because a reviewer's objection to
code that passes its own verify command is exactly the kind of judgement the owner should see and
the harness should not act on alone. **[asserted]**

`docs/vision.md` §5's argument for review is that *"a differently-trained model has different blind
spots"*. With **Claude Code only for v1** (`CLAUDE.md` §2) there is no differently-trained model, so
v1's review is Claude reviewing Claude and must be reported as the weaker thing it is.

---

## 6. The gate

### 6.1 Where it runs

In a **per-phase integration worktree**, at `.brigadier/worktrees/<integration-id>`, on a branch cut
from the phase base sha, into which each order's branch is merged. Never in the project root, and
never in a live worker's worktree.

Two reasons, and the first is the point of the gate:

- The verify command has to run against the **combination**. Four orders that each pass alone can
  fail together, and catching that is what the gate is for.
- A worker's own worktree carries that worker's uncommitted dirt, so a gate run there is testing
  something that is about to be discarded.

So the order is **collect → merge each order into the integration branch → gate**. A merge conflict
at that step is a red gate with its own reason slug (`merge_conflict`), diagnosed as a partitioning
failure rather than as a test failure.

### 6.2 The environment

Explicit and minimal, following the convention `crates/core/src/worktree.rs:900-925` already sets
for every git call **[source]**:

| setting | why |
|---|---|
| `cwd` = the integration worktree | never the project root |
| `stdin` = `Stdio::null()` | the single most important line: an interactive prompt must EOF, not wedge the run |
| `LC_ALL=C`, `LANGUAGE=` | stderr stays parseable under any locale |
| `GIT_TERMINAL_PROMPT=0` | a verify command that touches git must not open a credential prompt |
| `CI=1` | **[asserted]** convention; makes many runners non-interactive and uncoloured. Unverified for the runners this repo uses |
| no `MAX_THINKING_TOKENS`, no MCP flags | this is not a model call |
| `PATH` inherited | **open, and it needs research** — see below |

**The `PATH` question is open and must not be guessed at.** A harness launched from Finder has a
different environment from one launched in a terminal, and this repo has already been bitten by the
class: launchd hands a GUI launch `RLIMIT_NOFILE` **256** (`docs/STATUS.md` §2, **[measured]**). A
verify command like `cargo test` may resolve in one launch and not the other, and the failure would
read as a red gate rather than as a missing tool. `CLAUDE.md` §1 rule 1 applies: research before
implementing, write the finding to `docs/research/`.

### 6.3 Capturing the real exit code

Measured on this machine, 2026-09-04, each command run directly with `$?` read on the command
itself:

| command | exit | **[measured]** |
|---|---|---|
| `/bin/sh -c 'exit 7'` | **7** | the baseline |
| `/bin/sh -c 'false \| true'` | **0** | a pipeline reports the **last** command — this is the `tail` trap |
| `/bin/sh -c 'set -o pipefail; false \| true'` | **1** | `/bin/sh` here is GNU bash 3.2.57(1) in sh mode |
| `/bin/dash -c 'set -o pipefail; false\|true'` | **2**, `set: Illegal option -o pipefail` | a blanket prefix turns a green gate red under a dash `sh` |
| `/bin/sh -c 'kill -9 $$'` | **137** | signalled |
| `/bin/sh -c 'nosuchprogram_xyz'` | **127** | command not found |

The rules that follow:

1. Run as `sh -c "<command>"` with **stdout and stderr redirected to a file**, never through a pipe
   the harness then reads with a second program. Read `ExitStatus` from the `Child`. This is how the
   repo's own six gates are already run — *"exit codes captured on the command itself and not
   through a pipe"* (`docs/STATUS.md` §3). **[source]**
2. **`ExitStatus::code() == None` is red, never green.** A test run killed by the OOM killer has no
   code. Record the signal from `ExitStatusExt::signal()` and use reason slug `signalled`.
3. **`pipefail` is probed, never assumed.** Once per launch: run `sh -c 'set -o pipefail'` and check
   for exit 0; prefix the verify command only if it succeeded. The dash row above is why. As a
   belt-and-braces, the plan card warns when a phase's verify command contains `|`.
4. **127 gets its own reason slug** (`command_not_found`). The plan named a command this machine
   does not have; that is a plan defect and must not read as "the code is broken".
5. **Timeout kills the process group, not the pid.** `cargo test` spawns children; `crates/proc/`
   exists for exactly this problem and already does process-group kill (`crates/proc/tests/`,
   `docs/STATUS.md` §2). Reason slug `timed_out`. The per-phase deadline is stored with the verify
   command; the default is **[asserted]**.
6. The gate result is written to the phase's row before the loop acts on it, so the thread can state
   it without re-running the command.

### 6.4 Where the output goes

`docs/vision.md` §4.7.5: *its output goes to a worker's window, never into the thread.*

- **The file.** stdout and stderr are interleaved into one file at
  `<data_dir>/gates/<phase_id>/<attempt>.log`, so ordering survives.
- **The thread** gets exactly one harness-derived line, `docs/vision.md` §9's shape:
  `Phase 3 red — cargo test --workspace exited 101.` No tail, no excerpt.
- **The lead call** gets the command, the exit code and the reason slug. **Not the output.**
- **The rung-1 fixer worker** gets the output in full — as a **file it can read with its own tools**,
  hard-linked or copied into its worktree at `.brigadier/gate-<attempt>.log` before its baseline
  `dirty_count` is captured (§4.2). That costs the harness zero tokens and costs the worker only
  what it chooses to read.

A bounded tail into the lead call was considered and rejected: it is the beginning of the thread
accumulating output, and the fixer — the one window that actually needs it — can read the file.

---

## 7. The red-gate ladder

`docs/vision.md` §5, in order, with attempt counts.

### Rung 1 — fresh worker, same order, told what failed. **One attempt.**

Entered by: a non-zero (or `None`) exit from a gate that ran on a clean merge.

The child gets the original order verbatim, plus the verify command, the exit code, the reason slug
and the log path in its own tree. It works **in the integration worktree**, so there is nothing to
re-merge and the gate re-runs in place. The loop records the integration branch's sha first, so
`git reset --hard <sha>` undoes a fixer that made things worse.

### Rung 2 — two arms, the exit code as judge. **One round of two.**

Entered by: rung 1's gate still non-zero.

**What fusion degrades to with one provider, stated plainly.** `CLAUDE.md` §2 settles **Claude Code
only for v1**, and `docs/vision.md` §10 draws the consequence: deferring Codex defers cross-vendor
work. `docs/vision.md` §5's whole argument for fusion is that *"a differently-trained model has
different blind spots"* — and two Claude children do not have different blind spots.

So v1's rung 2 is honestly **"a second, differently-framed attempt with the exit code as judge"**,
not fusion. The harness can vary three things and only three:

- the **model** (`StartSession.model` already exists, `crates/core/src/driver.rs:319`);
- **thinking** — `ThinkingPolicy::Off` vs `Inherit` (`crates/core/src/driver.rs:275-307`), so one arm
  reasons and one does not;
- the **framing** — e.g. arm A "fix the failure", arm B "the approach may be wrong; consider
  reverting the order's diff and redoing it".

Two fresh worktrees, both cut from the pre-fix integration sha. **The harness runs the gate in each
arm's worktree** — a model reporting its own exit code is the thing the gate exists to replace.
Winner: the arm that exits 0. Both green: take the smaller `git diff --shortstat` and **record that
the tiebreak was arbitrary**. Both red: rung 3.

Whether rung 2 beats a second rung 1 is **[asserted]** and unmeasured. What would settle it: replay
N recorded red gates through both shapes and count how often arm B goes green where arm A did not.

The reserve applies here as everywhere: below the line, rung 2 does not spawn two children — the
phase parks and resumes at the `resetsAt` epoch the event already carries (`docs/vision.md` §6,
**[measured]** field).

### Rung 3 — stop and ask the owner, with a real diagnosis.

Cost ceiling for a red phase, stated so it can be checked: **N + 3 children** — N workers, one rung-1
fixer, two rung-2 arms.

What the owner actually sees:

- **One thread line**: `Phase 3 blocked — cargo test --workspace exited 101 after 4 attempts.`
- **A pinned plan-card entry**, because `docs/vision.md` §9 requires that nothing the owner steers
  with ever scrolls away. It carries: the phase and its definition of done; the verify command
  verbatim; every attempt with exit code, reason slug, duration and log path; the branches still
  holding each attempt's work (nothing is deleted); and the first failing assertion **if the harness
  can extract one** — and if it cannot, the card says it could not, rather than guessing.
- **Four actions**: retry this phase · edit the plan · skip and record it skipped · stop the run.
- **No dollar figure anywhere** (`docs/vision.md` §6).

Rung 3 is not the approvals dock. That dock is the safety boundary and its two words mean one thing
each; a blocked phase is not an allow/deny question. This is `intent-records.md` §5.3's reasoning
applied to a different surface.

---

## 8. Green

In order. The one step that must be intent-recorded is named at the end.

1. **Gate green** in the integration worktree. Not an effect; write the result to the phase row.
2. **Ownership post-check** (§3.2). A path outside the union of `owns` blocks the merge and goes to
   the owner.
3. **Merge into base — the phase commit.** `--no-ff`, one merge commit, harness-authored message
   naming the phase. **This is the step that must be intent-recorded**, kind `phase_commit`, opened
   and flushed before the merge is attempted, baseline = the base branch's sha plus the intended
   message. Everything before it is confined to worktrees the loop can throw away; everything after
   it is bookkeeping the reconciler can re-derive. A crash here is the only place the loop could
   otherwise repeat an effect that is already in the repository.

   **A correction owed to `intent-records.md` §4.3.** That table's `phase_commit` postcondition is
   *"top commit's parent == baseline and subject == intended message"*, written for a single-parent
   commit. A `--no-ff` merge has two parents and `%P` lists both, so the test must be **the first
   parent equals the baseline**. A postcondition that compares the whole `%P` string, or the second
   parent, reads `unknown` on every phase this loop ever commits. This document does not edit that
   file; the implementer's order must.

4. **Cleanup**, snapshot-then-remove (`docs/vision.md` §8, W3-B). Commit anything uncommitted in each
   worker worktree to a ref *before* deleting anything, then auto-remove only where
   `git rev-list --count <base>..<branch> == 0`. Each removal takes a `worktree_remove` intent row.
   **`git cherry` appears nowhere**: it reports work unmerged after a squash-merge and after a
   conflict-resolved rebase, and reports it *merged* when it was applied upstream and then reverted
   (`docs/research/worktree-cleanup.md` §§2.1–2.4, **[measured]** on git 2.50.1). The only sound
   signal is the `rev-list` count, and *0 ⇒ nothing to lose, always; non-zero proves nothing*.
   Branch deletion is `-d`, never `-D` (`worktree-cleanup.md` §2.6 rung 3).
   **Never before the merge lands** — the same ordering hazard `intent-records.md` §4.2 step 3 names
   for the reconciler.
5. **Progress updated** — the phase row moves to `done` with the merge sha. After the intent closes,
   so a crash between them leaves the intent `open` and the reconciler reads the world.
6. **Next phase.**

Accounting note, so nobody reintroduces the bug: `result.total_cost_usd` is **cumulative**, and
summing per-frame double-counts by 13.5%–54.3% on the captures that caught it (`docs/STATUS.md` §5
item 9, **[measured]**). Anything the loop reports about spend reads the store row. And it reports
none of it in dollars (`docs/vision.md` §6).

---

## 9. The reconciliation barrier

`docs/research/intent-records.md` §4.1 states the constraint in as many words: *the orchestration
loop must not dispatch its first work order until reconciliation has completed.*

### 9.1 The type, and where it is awaited

**`tokio::sync::watch::Receiver<Option<ReconcileOutcome>>`**, held by the loop.

`intent-records.md` §4.1 offers `tokio::sync::Notify` or an awaited `JoinHandle`; both satisfy the
constraint and `watch` has one property they lack. `Notify` is edge-triggered — a `notified()`
awaited *after* the notification fired can miss it — and the launch order is not guaranteed:
reconciliation is spawned off the setup thread the way `prune_worktrees` is
(`src-tauri/src/lib.rs:173-175`, **[source]**), so it may well finish before the loop exists. A
`watch` is level-triggered: a late reader sees the value immediately. A `JoinHandle` can be awaited
once, which is fine for one consumer and wrong the moment the UI's `unsettled_intents` command wants
the same answer. **[asserted]**

Awaited at the **top of the loop's first tick**, before the plan is read and before the first
`worktree::prepare` — because a `worktree_add` into a repository that has not been
`git worktree repair`ed is the failure `intent-records.md` §4.2 step 1 calls *"the single largest
correctness landmine in the reconciler"*.

### 9.2 What the loop does when reconciliation fails rather than completes

Three sub-cases, and collapsing them is the bug:

1. **The reconciler panicked, or its task was cancelled** — the sender drops and the channel closes.
   The loop **parks in `Blocked(reconcile_failed)` and dispatches nothing.** The whole point of the
   barrier is that dispatching unreconciled is the failure; a reconciler that did not run is
   strictly worse than one that is slow.
2. **Reconciliation completed with some rows at `unknown`.** Per `intent-records.md` §5.1 an
   `unknown` on a `work_order` or `phase_commit` **blocks its phase, not the run.** So the loop
   starts, and skips exactly the phases carrying an unknown. This is the same rule as §11.
3. **Reconciliation completed but `git worktree repair` failed for a project.** This one is an
   addition beyond what `intent-records.md` says, and it matters: that file's §7 records that a
   renamed project plus a failed repair *"leaves every path-based postcondition reading `not_done`
   for worktrees that exist"* — and `not_done` is the one outcome that authorizes a re-dispatch. So
   a `not_done` derived from a broken repair is a licence to redo work that already ran. **The loop
   must refuse to dispatch in a project whose repair failed** and say so, rather than trusting the
   answers.

**A barrier timeout never falls through.** If reconciliation has not completed within the bound, the
loop reports *still reconciling* and dispatches nothing. A timeout that proceeds is the most
tempting wrong implementation of this whole section.

---

## 10. Re-planning

`docs/vision.md` §8: brigadier may rewrite, add or drop phases inside the goal the owner approved,
recording what changed and why.

- The mechanism is a `replan` action (§2.3) carrying `add` / `edit` / `drop` with a reason each.
- It lands as a **new plan revision, never an in-place edit** — W1-A's `plan_revisions` table — so
  the thread can say what changed, when, and on whose lead call. Column names unknown (§12).
- Recorded per revision: the action payload verbatim (bounded), the phases affected, the reason, the
  lead call's session id, and whether it escalated and how that resolved.

**Invariants the harness enforces, not the model:**

1. The **goal text is immutable** for the run. A `replan` that would change it is refused and
   escalated to the owner.
2. A phase already `done` may not be edited or dropped. Its commit is in base; it can only be
   followed by a new phase.
3. **A change that would move a definition of done escalates** — first to a second opinion, and on
   disagreement to the owner. In v1 the "second opinion" is a second, differently-framed lead call,
   with exactly the degradation §7 rung 2 records: one provider means no differently-trained blind
   spots.
4. **A change to a verify command is a definition-of-done change.** Say it out loud, because it is
   the most likely way an agent lowers the bar, and *agents declaring done prematurely and marking
   features complete without end-to-end tests* is the failure mode `docs/vision.md` §8 names as the
   one being guarded against.
5. **"Just go" does not cover this.** That click governs the grill (`docs/vision.md` §4.5); it is
   not consent to a mid-run definition-of-done change.
6. A `replan` naming the **current** phase is refused until that phase settles, and a `replan` never
   touches an in-flight order. Otherwise the harness would be moving the goalposts of work that is
   already running.

---

## 11. Parking, not hanging

`docs/vision.md` §8: *a queued approval parks one work order, never the run.* Without it the
overnight run does not fail, it hangs.

**Mechanics.** A worker's `can_use_tool` opens a `RequestOpened` and the child blocks until
`respond` writes the answer (`intent-records.md` §1.1, `crates/supervisor/src/lib.rs:854`).
**[source]** That child is one order. The loop marks the order `Parked(approval, request_id)` and:

- it **does not count against the concurrency cap**, so a further order may dispatch in its place;
- its **turn and quiet deadlines are suspended** (§4.3);
- the phase's **other orders continue** untouched;
- but the phase's **gate cannot run**, because the gate runs on the merge of every order. So the
  *phase* waits.

**Which is where the honest limit lives.** For the run to continue, the loop must move to another
phase, and that needs a dependency edge between phases. The sound test that needs no extra model
call is: **two phases are independent when their `owns` unions are disjoint and neither's definition
of done names the other.** Whether the plan store carries the data to compute that is an open
question for W1-A (§12). **If it does not, the conservative default is phases in order** — and then
"park one order, not the run" delivers concurrency *within* a phase and not across phases, which is
less than the sentence in `docs/vision.md` §8 promises. That gap should be closed by a plan-store
column, not by a guess at runtime.

Three further parking facts:

- **The reserve parks too.** Below the owner's line, no spawn; resume at `resetsAt`
  (`docs/vision.md` §6, **[measured]** field).
- **Approvals expire across a restart.** `expire_pending_approvals` runs at `Store::open`
  (`crates/store/src/schema.rs:671`, **[source]**) and denies rows from a previous run; the worker
  died with the process, so the order is re-derived from its `work_order` postcondition like any
  other. (`intent-records.md` cites this as `schema.rs:526`; the line has since moved.)
- **Approvals are never optimistic** (`docs/vision.md` §9). The loop must never proceed on an
  assumed allow.

**Named dependency: the Bash classifier is built and unwired.** `crates/core/src/wall/` is committed
at `21d2375` and nothing in the production path calls it; the live gate is the static tool-name set
`AskGatedTools` (`crates/core/src/claude/hook.rs:42,91`). **[source]** Until W3-A wires it, every
`Bash`, `Write`, `Edit`, `MultiEdit` and `NotebookEdit` a worker attempts prompts the owner, so an
unattended run parks on its first edit. **The loop is not blocked on W3-A — it is useless overnight
without it**, and the design says so rather than assuming the wall is there.

---

## 12. Open questions that depend on the store schema still being written

A concurrent worker is adding two migration rungs to `crates/store/` right now: an `intents` table
(`intent-records.md` §2.1) and a plan/progress group — `plans`, `phases`, `plan_revisions`,
`unknowns`, `work_orders`. `crates/store/src/intents.rs` exists as an untracked 449-line file in the
tree as of this writing **[measured]** (`git status --porcelain`), and the schema is at
`user_version` 3 (`crates/store/src/schema.rs:622`). **[source]** **The final column names are not
known to this document and are not invented here.** Each item below names the responsibility and
what to confirm against `crates/store/src/schema.rs` when it lands.

1. **The phase's persisted loop state.** This design needs a column for the phase-machine state of
   §1.1 and one for the current attempt index. Confirm the spelling and the slug set; the slugs
   should be read lossily with an unknown value degrading to something that **blocks**, never to
   something that dispatches — the restrictive direction, as `intent-records.md` §2.1 argues for
   `state`.
2. **The base sha per phase.** §3.3 needs it stored, not recomputed, or two orders either side of a
   commit branch from different bases. Confirm there is a column for it on `phases`.
3. **The verify command, its timeout and its last result.** §6 needs the command verbatim, a
   per-phase deadline, and the last `(exit_code, reason, log_path, duration)`. Confirm whether the
   result lives on `phases` or in its own table.
4. **`work_orders.owns`.** §3 needs the owned path set per order, durably, because the post-hoc
   subset check at merge time (§3.2) runs after the child that proposed it is gone.
5. **Phase dependency data.** §11's independence test needs either a dependency edge or the union of
   `owns` per phase. If neither exists, "park one order, not the run" is weaker than
   `docs/vision.md` §8 promises, and the fix belongs in the schema.
6. **What "skipped" records.** `docs/vision.md` §4.5 requires that a waved-off grill question be
   recoverable when a later phase fails on it. Confirm where that lives so §2.1 item 6 can read it.
7. **Whether `Op::Query` is the loop's read path or W1-A ships typed accessors.**
   `crates/store/src/writer.rs:80` **[source]** makes the loop buildable either way, but two
   readers of the same tables with different SQL is how a store drifts out of true.
8. **The `phase_commit` first-parent correction** (§8 step 3) has to reach the reconciler's
   postcondition table, which lives in the same worker's change.

---

## 13. Test plan

Split the way `intent-records.md` §8 splits its: what this tree can prove for free, and what needs a
live `claude` child and therefore costs the owner money.

### 13.1 Provable in this tree, for free

1. **Action parsing and validation** — the §2.4 table as a case list: zero blocks, two blocks,
   unknown slug, unknown field, absolute path, `..`, symlink escape, overlapping `owns`, and the
   component-vs-string prefix case (`src/a` against `src/ab` must **not** collide). Pure, no I/O.
2. **Two consecutive malformed actions block the phase and spawn no third child.** `ReplayDriver`,
   whose script is real adapter output over a captured fixture
   (`crates/supervisor/src/replay.rs:142`), with a spawn counter.
3. **The state machine, crash by crash** — one test per state of §1.1, driving the store to that
   point and asserting where a restart resumes. The shape of `intent-records.md` §8.1 item 4.
4. **Exit-code capture** — the six rows of §6.3 against `sh` scripts in a tempdir. `exit 7` → 7;
   `false | true` → 0; `kill -9 $$` → `None`, red; `nosuchprogram` → 127, red with
   `command_not_found`; a script that sleeps past the deadline → group killed, red with `timed_out`;
   a script that spawns a child that outlives it → the child is dead after the kill. **No `cargo`
   and no `npm` in any of these** — they are the tests that pin §6's whole argument and they must
   not need a build system to run.
5. **The `pipefail` probe** — point the runner at a stub `sh` that rejects `-o pipefail` (the dash
   behaviour, **[measured]** exit 2) and assert no prefix is applied and the gate is not reddened.
6. **Gate output never reaches the feed** — a gate whose script prints 10 MB; assert the session's
   `feed` rows contain none of it and the log file contains all of it.
7. **Ownership post-check** — throwaway repo in the style of `crates/core/tests/worktree.rs`: a
   branch touching a path outside `owns` blocks the merge; a branch inside it does not.
8. **Merge postcondition** — a `--no-ff` merge commit's **first** parent equals the baseline and its
   subject matches; and the fast-forward case, which produces no merge commit at all, is handled
   rather than read as a failure. This is the test that pins §8's correction.
9. **`rev-list --count` gates auto-remove** — a squash-merged branch reads non-zero and is **not**
   auto-removed. The mirror of `intent-records.md` §8.1 item 5, and the one that stops a future
   simplification back to `git cherry`.
10. **The barrier** — a loop whose watch never resolves dispatches nothing and spawns no `git`; a
    closed channel parks in `Blocked(reconcile_failed)` rather than proceeding; a project whose
    repair failed gets no dispatch.
11. **Parking** — `ReplayDriver::with_approval` (`crates/supervisor/src/replay.rs:198`) parks a real
    request in the real `ApprovalTable`; assert the order does not count against the cap, its
    deadlines do not fire, and a sibling order still finishes.
12. **`unknown` never dispatches** — `intent-records.md` §8.1 item 8, applied to the loop rather than
    the reconciler.
13. **Reserve and cap** — with a stubbed window reading above the reserve line, zero spawns; with a
    cap of 2 and 4 orders, exactly 2 children at a time.
14. **A grep gate**: `git cherry` appears nowhere in `crates/supervisor/src/`.

### 13.2 Needs a live `claude` child — **money, owner-gated, DO NOT RUN**

These belong beside the five existing `--ignored` live tests in `crates/supervisor/tests/` and
`crates/core/tests/`, and their cost belongs in `docs/STATUS.md` §3. **None was run for this order.**

- `live_lead_call_returns_an_action` — one real child, one real goal; assert the fenced block
  validates. The only test that proves the control plane of §2 exists at all, and the cheapest.
- `live_worker_report_round_trip` — one work order in a throwaway repo; assert the report validates
  and `git log` corroborates its `commits` field.
- `live_red_gate_rung_1` — a deliberately failing verify command, one real fixer child; assert the
  gate goes green and that **the exit code, not the model's claim, settled it**.
- `live_two_workers_disjoint` — two real children, two worktrees; assert each branch touches only
  its own `owns` paths.
- `live_park_on_approval` — a worker whose order needs an action outside its worktree; assert the
  order parks and a sibling order continues. **Needs W3-A.**

Cost: `docs/STATUS.md` §3 records comparable live tests at **$0.030–$0.053** each from the store row.
Extrapolating, this set is roughly **$0.15–$0.30** — **[asserted]** arithmetic on measured
neighbours, not a measurement. That figure is for the owner's test budget; **the product never shows
a dollar figure** (`docs/vision.md` §6).

---

## 14. Decomposition into implementable orders

Ranked. One worker per order, and **no two orders own the same file.**

**The one contention point, handled up front:** every order that adds a module would otherwise touch
`crates/supervisor/src/lib.rs`. **B5 lands that file's `pub mod loop_;`, the `route` tap, and
`loop_/mod.rs` with empty stub submodules**, so every later order owns only its own new file.

| # | order | owns | definition of done |
|---|---|---|---|
| 1 | **B1 — the command runner and the gate** | `crates/supervisor/src/verify.rs` (new) | `sh -c`, null stdin, output to a file, group kill on timeout, `pipefail` probe; §13.1 items 4 and 5 pass with no `cargo`/`npm` in any test |
| 2 | **B2 — action and report schema + validator** | `crates/supervisor/src/action.rs` (new) | pure parse/validate; §13.1 item 1's full case list passes, component-prefix case included |
| 3 | **B3 — the full-assistant-text seam** | `crates/core/src/driver.rs`, `crates/core/src/claude/adapter.rs` | a caller can get a turn's whole final text while `feed` still stores the 240-char summary; fixture test proves both |
| 4 | **B4 — the phase base sha** | `crates/supervisor/src/worktree.rs` | `prepare` takes an explicit base sha and `Prepared` carries it; two worktrees prepared either side of a commit to `HEAD` branch from the same sha, in a throwaway repo |
| 5 | **B5 — the state machine, the store reads, the tap** | `crates/supervisor/src/lib.rs`, `crates/supervisor/src/loop_/mod.rs`, `loop_/state.rs` (new) | no spawning, no git: the transition function plus persistence; §13.1 item 3's crash-per-state table passes |
| 6 | **B6 — the reconciliation barrier** | `crates/supervisor/src/loop_/barrier.rs` (new) | the `watch` type, the three failure sub-cases of §9.2, no fall-through on timeout; §13.1 item 10 passes |
| 7 | **B7 — dispatch and collection** | `crates/supervisor/src/loop_/dispatch.rs` (new) | worktree + spawn per order, both deadlines with the parking suspension, every reported field re-derived from git; §13.1 items 7 and 11 pass |
| 8 | **B8 — the ladder** | `crates/supervisor/src/loop_/ladder.rs` (new) | rungs 1–3 and the rung-3 payload; a scripted red gate advances 1 → 2 → 3 and spawns at most N+3 children |
| 9 | **B9 — green: merge, phase commit, cleanup** | `crates/supervisor/src/loop_/green.rs` (new), `crates/core/src/worktree.rs` | merge/commit helpers, snapshot-then-remove, `rev-list` gate; §13.1 items 8, 9 and 14 pass |
| 10 | **B10 — the surfaces** | `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `docs/plans/ipc-contract.md` | the loop's commands and error codes written into the contract and wired, barrier spawned beside `prune_worktrees` |

**Concurrency.** B1, B2, B3, B4 are mutually disjoint and have no dependency between them — run all
four at once. Then B5 alone (it touches `lib.rs`). Then B6 and B7 together. Then B8 and B9 together.
Then B10.

**Cross-cutting constraints for every order:** none of them may run concurrently with the
`crates/store/` worker (§12), because a `cargo` build fights for the `target/` lock; B3 must not run
concurrently with anything else touching `crates/core/src/claude/`.

---

## 15. What the loop must never do

1. Never retry an `unknown` intent — not on restart, not in-run (`intent-records.md` §5.1). A
   `work_order` or `phase_commit` at `unknown` blocks its phase.
2. Never treat "the worker committed something" as "the worker finished the order"
   (`docs/vision.md` §8, `intent-records.md` §4.3: `work_order` can never read `done`).
3. Never put the verify command's output in the thread (`docs/vision.md` §4.7.5). One
   harness-derived line (§6.4).
4. Never use `git cherry`, or `worktree-cleanup.md` §2.2's synthetic-squash trick, to decide
   anything. Both have measured false answers in both directions (§§2.2–2.4).
5. Never `git branch -D` a branch the loop did not just create and prove empty. `-d` only.
6. Never show a dollar figure on any surface (`docs/vision.md` §6).
7. Never spawn a child before the reconciliation barrier resolves (`intent-records.md` §4.1).
8. Never sum `result.total_cost_usd` across frames — it is cumulative (`docs/STATUS.md` §5 item 9).
9. Never let a model's self-reported success settle a phase. Only the exit code does.
10. Never repair an overlapping partition itself — refuse and re-ask (§3.1).
11. Never `chdir` the harness process; `StartSession.cwd` is the mechanism
    (`crates/core/src/driver.rs:313`, *"never `chdir` the host"*). **[source]**
12. Never write into the project root's working tree, and never run the verify command there.
13. Never resume a lead call. Lead calls are one turn and disposable; a resumed lead call is an
    accumulating session, which is the product being refused (`docs/vision.md` §1).
14. Never kill a worker whose order is parked on an approval (§4.3).
15. Never proceed past a barrier timeout (§9.2).

---

## 16. Not checked, and the weakest claims

Not checked:

- **Nothing was compiled or run.** `cargo check`, `cargo test`, `cargo clippy` and `npm test` were
  all forbidden for this order because another worker held the build system. Every type, module path
  and signature above comes from reading the tree.
- **No live `claude` child was spawned** and no test in §13.2 was run.
- The **prompt budget** in §2.1 (≤ 6,000 tokens) is an assumption; nothing counts prompt tokens.
- The **concurrency cap** of 4, and every deadline in §2.5, §4.3 and §6.3, are assumptions with no
  measurement behind them.
- The **`PATH` question** in §6.2 is open and needs research before B1 is implemented.
- `CI=1` was not verified against any runner this project uses.
- The `pipefail` and exit-code figures in §6.3 were measured on **macOS 26.5 / Darwin 25.5.0** with
  `/bin/sh` as GNU bash 3.2.57(1). No Linux, no Windows, no other shell.
- Whether the **integration worktree** is cheaper than re-merging into each worker's tree was
  reasoned, never measured.
- The **spawn cost** figures are quoted from `docs/research/spawn-split.md`; they were not re-run.

**The weakest claim in this document** is §7 rung 2: that two same-provider arms with different
model, thinking policy and framing are worth spawning, given that `docs/vision.md` §5's entire
argument for fusion is *differently-trained models have different blind spots* and v1 has one
vendor. If that is wrong, rung 2 is two spawns of pure cost and the ladder should be rung 1 → owner.
Nothing measured says otherwise in either direction, and the experiment that would settle it is in
§7. **[asserted]**

**The second weakest** is §11's phase-independence rule. It is stated as a sound test, but its
soundness rests on `owns` being a complete description of what a phase writes — and §3.2 already
records that `owns` is advisory going in and only checkable coming out. A phase that writes outside
its declared set breaks the independence test the same way it breaks the merge check, except that
this one is consulted *before* the work runs, where there is nothing yet to check it against.
**[asserted]**
