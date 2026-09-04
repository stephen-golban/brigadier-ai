# W1-B — the loop, as ordered

Written by the lead on 2026-09-04, during the unattended run
(`docs/plans/autonomous-run-2026-09-04.md`). It is the work order for the orchestration loop, and
it is also the record of eight decisions the lead took so a worker would not have to.

The design is `docs/research/orchestration-loop.md`, 921 lines, and it is the authority on
everything this file does not contradict. **Read it before writing any supervisor code.** It was
written without a compiler: treat its signatures as intent, not as fact.

Rules of this document, per `CLAUDE.md` §5: one line per fact, a path or a number instead of an
adjective, every claim tagged **[measured]**, **[source]**, **[documented]** or **[asserted]**.

---

## 1. Eight decisions the lead took

Each of these resolves something the design left open or scoped down. They are decisions, not
suggestions. Where one contradicts `docs/research/orchestration-loop.md`, this file wins and says
so on the line.

**D1 — the planner call, which the design does not have.**
`orchestration-loop.md` starts from *"one brigadier session = one approved goal + one plan"* and
never says who makes the plan. `docs/vision.md` §4 step 6 requires one, and the owner's sentence
for this run requires it out loud: *hand it a task in plain English* → *it plans*. So there is a
**planner call**: the same disposable-child, fenced-JSON, strictly-validated machinery as the lead
call, run when a plan has a goal and zero phases. It returns one action:

```json
{ "action": "plan",
  "phases": [ { "title": "…", "definition_of_done": "…", "verify_command": "…" } ] }
```

`verify_command` is **required and non-empty for every phase**. `PhaseRow::verify_command` is an
`Option` (`crates/store/src/plan.rs`) precisely so the loop can *see* a phase that cannot go green
through a gate rather than fabricate a command for it — but a planner that returns no verify
command has not produced a plan this loop can run, and that is a validation failure, not a phase.
2 ≤ phases ≤ 8. **[asserted]**, a bound on scope, not a measurement.

**D2 — the grill is out of scope for this run, and the skip is recorded.**
`docs/vision.md` §4 step 5 sorts unknowns into owner-answerable and research-answerable bins. The
owner is away and *"just go"* is the only answer available, so the loop does not grill. The
planner is asked to list what it does not know; each item is written to `unknowns` with
`bin = owner`, `state = skipped` and `skipped_for_just_go = true`. That is what the column is for
(`docs/vision.md` §4.5: *"when a phase later fails on a question that was waved off, the thread can
say which one"*). This is a scope cut and the report says so.

**D3 — the ladder ships as rung 1 → rung 3. Rung 2 is not implemented.**
`orchestration-loop.md` §16 names rung 2 **"the weakest claim in this document"** in as many
words, and its reasoning is `docs/vision.md` §10's: with **Claude Code only for v1** there is no
differently-trained model, so two Claude arms do not have different blind spots, and rung 2 is
"two spawns of pure cost" if the claim is wrong. Nothing measured says otherwise in either
direction. So the ladder is: **rung 1** (one fresh fixer in the integration worktree, told what
failed) → **rung 3** (block the phase and hand the owner a real diagnosis). Leave a one-line
comment at the rung-1/rung-3 seam naming rung 2 as deliberately absent and citing §16, so the next
reader does not think it was forgotten.

**D4 — the persisted phase state is the store's four-value `PhaseState`, and nothing more.**
`orchestration-loop.md` §1.1 draws a twelve-state phase machine; `crates/store/src/plan.rs`'s
`PhaseState` has four — `Pending`, `Running`, `Green`, `Blocked` — with `from_slug_lossy` falling
back to `Blocked`, the restrictive reading. The finer states live in memory inside one tick and are
**re-derived from `intents` on restart**, which is the entire purpose of the intents table
(`docs/research/intent-records.md`). **No schema change for this.** A twelve-value column would be
a second source of truth for something the intent rows already answer, and the two would drift.

**D5 — phases run in order. Cross-phase concurrency is not implemented.**
`orchestration-loop.md` §11 already names this as the conservative default *"if the plan store does
not carry the data to compute [phase independence]"* — and it does not: there is no dependency edge
and no per-phase `owns` union in `crates/store/src/plan.rs`. **[source]** So *"park one order, not
the run"* delivers concurrency **within** a phase and not across phases, which is less than
`docs/vision.md` §8 promises. Say that in the report as the weaker thing it is; do not close the
gap with a runtime guess.

**D6 — the wall is wired for worker children, because the loop is useless without it.**
`docs/plans/autonomous-run-2026-09-04.md` §6 says W3-A is out of this run *"unless the loop is
blocked without it — if it is, wire it and say so."* It is. The live gate is the static tool-name
set `GATED_TOOLS = ["Bash","Write","Edit","MultiEdit","NotebookEdit"]`
(`crates/core/src/claude/hook.rs:42`) **[source]**, so an unattended worker parks on its **first
edit** and the overnight run hangs rather than fails — the exact failure `docs/vision.md` §8 exists
to prevent. The Bash classifier is built and unwired (`crates/core/src/wall/`, committed at
`21d2375`). §4 below is the policy. **This is a scope addition and the report names it as one.**

**D7 — the base sha is stored on the phase.** `phases.base_sha` was added to the store in the same
run (Order 0, migration rung 6). `worktree::prepare` branches from the constant `HEAD`
(`crates/supervisor/src/worktree.rs:50`) **[source]**, and once the loop starts committing per
phase, two orders dispatched either side of a phase commit branch from different commits and the
merge is then against two different bases. Resolve the base once per phase, store it, pass it
explicitly.

**D8 — the loop's read path is the store's typed accessors, never raw `Op::Query`.**
`orchestration-loop.md` §12 item 7 leaves this open. W1-A shipped typed accessors — `current_plan`,
`plan`, `phases`, `plan_revisions`, `unknowns`, `work_orders`, `unsettled_intents`
(`crates/store/src/writer.rs`) **[source]** — so the loop uses them. Two readers of the same tables
with different SQL is how a store drifts out of true.

---

## 2. Module layout

Everything new lives under `crates/supervisor/src/loop_/`. One worker owns the whole directory, so
the "one order per file" partition of `orchestration-loop.md` §14 is not needed here.

| file | holds |
|---|---|
| `loop_/mod.rs` | `pub mod` lines, the `Run` handle, the tick driver, the public entry points |
| `loop_/state.rs` | the phase machine of §1.1, pure: `(state, event) -> (state, effects)`, no I/O |
| `loop_/barrier.rs` | the reconciliation barrier of §9, and the three failure sub-cases of §9.2 |
| `loop_/plan.rs` | the planner call of D1 and the lead call of §2 |
| `loop_/dispatch.rs` | worktree + spawn per order, both deadlines, collection, re-derivation |
| `loop_/ladder.rs` | rung 1 and rung 3 (D3) |
| `loop_/green.rs` | integration merge, the `phase_commit` intent, cleanup |

`crates/supervisor/src/verify.rs` (the command runner and gate) and
`crates/supervisor/src/action.rs` (the action/report schema and validator) are **separate orders
and already exist by the time this one runs**. Use them; do not reimplement them, and do not edit
them except to add a function you need, in which case say so in the report.

---

## 3. What the loop must never do

`orchestration-loop.md` §15 lists fifteen. All fifteen hold. The five that are easiest to violate
by accident, restated:

1. Never treat *"the worker committed something"* as *"the worker finished the order"*. A
   `work_order` intent can never read `done` — only `not_done` or `unknown`, and an `unknown`
   **blocks its phase and is never repeated**.
2. Never let a model's self-reported success settle a phase. Only the exit code does.
3. Never put the verify command's output in the thread. One harness-derived line; the output goes
   to a file and, for the rung-1 fixer, into that worker's own worktree.
4. Never use `git cherry`. It reports squash-merged work as unmerged and reverted work as merged
   (**[measured]**, `docs/research/worktree-cleanup.md` §§2.1–2.4). The only sound signal is
   `git rev-list --count base..branch == 0`. Add the grep gate: `git cherry` appears nowhere in
   `crates/supervisor/src/`.
5. Never spawn a child before the reconciliation barrier resolves, and **never fall through a
   barrier timeout**. A timeout reports *still reconciling* and dispatches nothing.

And one correction the design owes `docs/research/intent-records.md`, already recorded in that
file's 2026-09-04 amendment: `phase_commit`'s postcondition must compare the **first** parent
(`git rev-parse <BR>^1`). `%P` lists every parent and a `--no-ff` phase merge has two, so a
postcondition comparing the whole `%P` string reads `unknown` on every phase this loop ever
commits. **[measured]** on git 2.50.1.

---

## 4. The worker wall — D6's policy

> **SUPERSEDED IN PART BY §7.1 AND §7.2. Read those before implementing anything in this section.**
> The table below sends `Bash` classified `Mutate` to *allow* and `Unknown` to *ask*. That is
> **wrong**: `cargo test` and `npm test` classify `Unknown` (`crates/core/src/wall/bash.rs:487,817`),
> so this table parks every worker on its first verification command. It also cites
> `GIT_REMOTE_MUTATE_SUBCOMMANDS`, which does not contain `push`. §7 carries the corrected
> allowlist, which is what shipped in `crates/core/src/claude/hook.rs` as `WorkerWall`.
> The section is kept rather than rewritten so the mistake and its correction both stay on the
> record.


A new `HookPolicy` implementation. It is used **only** for loop-dispatched worker children; the
operator's own hand-started sessions keep `AskGatedTools` and are not touched by this order.

It is constructed with the worker's **worktree root**, because the axis
`crates/core/src/wall/mod.rs:26-33` says the classifier cannot answer — *"below the worktree root"*
— is one the harness can answer, from a path it already holds.

| tool | decision |
|---|---|
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `file_path` resolves inside the worktree root → allow. Outside, absent, or unresolvable → `ask`. |
| `Bash`, classified `Inspect` or `Read` | `{}` — no opinion, the CLI's own flow decides. |
| `Bash`, classified `Mutate` | allow, **except** the escapes below. `docs/vision.md` §8 pre-authorizes builds, tests and writes below the worktree root, and the worker's cwd is a throwaway worktree. |
| `Bash`, a `Mutate` segment naming a remote git subcommand (`tables::GIT_REMOTE_MUTATE_SUBCOMMANDS`) or a package-manager mutation (`tables::PACKAGE_MUTATE_SUBCOMMANDS`) | `ask`. These are `docs/vision.md` §8's named escapes: `git push`, package installs with side effects. |
| `Bash`, classified `Unknown` | `ask`. *"I could not classify this" must never be delivered as "this is fine"* (`crates/core/src/wall/mod.rs`). |
| `Bash`, classified `NestedClaude` | **deny**. The wall's own words: refused whoever asks. |
| anything else | `{}`. |

Three limits that must be in the rustdoc, because a reader will otherwise mistake this for a
sandbox:

- The classifier **tokenises but does not evaluate**: no variable expansion, no `$(…)`, no
  subshells (`crates/core/src/wall/mod.rs`). A worker that writes a shell script and runs it is
  past this policy.
- **This is not a security boundary.** `docs/vision.md` §11: the isolation is a git worktree, and
  the blast radius of a bad worker is work brigadier can throw away — a containment property, not
  a sandbox.
- The wall **fails open**, so a bug in it shows up as an *absent* refusal, which is silent.

An `ask` here is not a failure: it parks **one work order**, never the run
(`docs/vision.md` §8), and §5 below is what that costs.

---

## 5. Parking, and the honest limit

A parked order does not count against the concurrency cap, its turn and quiet deadlines are
**suspended** (otherwise the harness kills the exact worker the owner is about to unblock), and the
phase's other orders continue. The phase's **gate** cannot run, because the gate runs on the merge
of every order — so the phase waits, and by D5 the run waits with it. That is the honest limit and
the report states it.

---

## 6. Definition of done

The loop can take a goal and a project and, with no human present:

1. plan it (D1),
2. dispatch work orders to isolated worktrees with disjoint declared ownership,
3. merge each order's branch into a per-phase integration worktree,
4. run the phase's stored verify command there and read its **real exit code**,
5. on green, merge to base with a `--no-ff` phase commit recorded as a `phase_commit` intent, clean
   up, and move to the next phase,
6. on red, run rung 1 once and then block the phase with a diagnosis (D3),
7. and survive being killed at any point, because position is always written *behind* reality and
   the reconciler closes the gap by reading the world.

Every one of those is provable in this tree with no live `claude` child and therefore for free —
`orchestration-loop.md` §13.1 is the case list, and it is a checklist, not a suggestion. The live
tests of §13.2 cost money, belong beside the five existing `#[ignore]`d ones, and **are not run by
the worker that builds this.**

---

## 7. Amendment — what a second-vendor review found, verified in source by the lead

A `codex` pass (`gpt-5.6-sol`, read-only, 2026-09-04) reviewed §1's eight decisions against the
tree and asked the question `docs/plans/autonomous-run-2026-09-04.md` §9 recommends: not *"is this
a good decision"* but *"does this decision have consequences elsewhere that the design does not
account for"*. It returned 18 findings. **Every claim below was re-checked against the source by
the lead before being written here**, per the standing rule that a substantively correct reviewer
can still cite a line that does not exist.

### 7.1 The one that would have shipped a loop that hangs

**`cargo test` and `npm test` classify `Unknown`, not `Mutate`.** §4's original table sent `Mutate`
to allow and `Unknown` to `ask`, so **every worker would have parked on its first verification
command** — defeating the entire reason for wiring the wall.

**[source]** `crates/core/src/wall/bash.rs:487`: `package_manager_class` returns
`(BashClass::Unknown, "a build or test run, contents unknown")` for any package-manager command
whose subcommand is not a mutation. `crates/core/src/wall/bash.rs:817` asserts
`class("RUST_LOG=debug cargo test") == BashClass::Unknown`. The doc comment at `:485` says it in as
many words: *"`npm test` must not come back `Mutate`."*

**§4's table is superseded by an allowlist**, sent to the implementing worker: allow package-manager
commands that came back `Unknown`; allow `git` subcommands in `GIT_MUTATE_SUBCOMMANDS` that are not
in `GIT_REMOTE_SUBCOMMANDS`; `{}` for `Read`/`Inspect`; **deny** `NestedClaude`; **`ask` for
everything else**, `Mutate` included. The direction is the point: the wall *fails open*
(`crates/core/src/wall/mod.rs`), so a blocklist's bug is a silent missing refusal, while an
allowlist's bug is a parked order — which costs one work order and is honest.

### 7.2 The escape check missed the escape it was named for

§4 said to `ask` on `tables::GIT_REMOTE_MUTATE_SUBCOMMANDS`. That constant is the subcommands of
`git remote` — `add`, `remove`, `rm`, `rename`, `set-url`, … (`tables.rs:208`). **Top-level `push`
is not in it**; it is in `GIT_MUTATE_SUBCOMMANDS` (`tables.rs:175`). **[source]** The correct set is
`GIT_REMOTE_SUBCOMMANDS` (`tables.rs:205`) = `clone`, `fetch`, `pull`, `push`, `remote`,
`send-email`, `submodule`, whose own doc comment calls it *"that line drawn over `git`'s
subcommands"*.

Relatedly `MUTATE_COMMANDS` (`tables.rs:52`) contains `rm`, `ssh`, `scp`, `sftp`, `rsync`,
`launchctl`, `kill`, `mount`, `dd`. A blanket allow on `Mutate` authorizes `rm -rf /anything` and
`ssh host …` with nobody watching.

Two guards were added, each turning an allow into an `ask`: a `git` line carrying `-C`,
`--git-dir` or `--work-tree` (those three are the only way git leaves its cwd, and `git_class`
skips global flags so `git -C /elsewhere reset --hard` otherwise classifies as a local reset); and
any absolute or `~`-rooted word that does not resolve inside the worktree root.

### 7.3 The hook policy is per **driver**, not per session — so D6 had nowhere to live

**[source]** `hook_policy: SharedHookPolicy` is a field on `ClaudeDriver`
(`crates/core/src/claude/driver.rs:81`), set by the builder `with_hook_policy` (`:128`) and handed
to the adapter at `:184`. `StartSession` (`crates/core/src/driver.rs:312`) has no policy field, and
the Supervisor registers **one driver per kind**. Installing a worktree-bound policy on the driver
would therefore change it for the operator's own hand-started sessions too, and two concurrent
workers with two different worktree roots could not both be served.

**An optional per-session hook policy on `StartSession`/`ResumeSession` is now part of the core
order**, `None` meaning "use the driver's" so every existing caller is behaviourally unchanged.

### 7.4 A `work_order` intent can never settle `not_done` — so the loop has no re-dispatch branch

**[source]** `crates/store/src/intents.rs:176`: `Self::WorkOrder => &[Unknown]`. The doc above it
records this as an **owner decision of 2026-09-04**, with the reasoning: `rev-list --count` plus a
dirty count is not a sufficient test for *"nothing happened"* — a worker that ran `npm install`,
wrote above the worktree root, or made and reverted its own changes leaves both at baseline and
would read `not_done`, authorizing a re-dispatch of an order that already had effects. *"The
accepted cost is a re-dispatch we could otherwise have made safely."* It is enforced at the write,
not merely documented: `hold_to_settleable` downgrades anything outside the set to `unknown`.

**Three documents are stale against it** and the loop must follow the code, not them:
`docs/research/orchestration-loop.md` §1.3 and §4.2, `docs/research/intent-records.md` §4.3, and
§3 item 1 of this file all describe a `not_done` → safe-to-re-dispatch path.

**The consequence, and it is the honest limit on unattended crash recovery: a crash with work
orders in flight leaves every one of those phases blocked**, pending the owner marking each intent
done or not-done by hand. The loop must contain no branch keyed on a `work_order` reading
`not_done`, because it cannot. Report it as the weaker thing it is.

### 7.5 Rung 1 has no spawn path, and a non-repository project must be refused

**[source]** `Supervisor::start_session` (`crates/supervisor/src/lib.rs:556`) **always** calls
`worktree::prepare` and overwrites `req.cwd` with the new worktree. There is therefore no supervised
way to run a child in an **already-prepared** directory — which is exactly what rung 1 requires,
since it works in the per-phase integration worktree so the gate can re-run in place with nothing
to re-merge. The loop order must add that path.

And `prepare` returns `Ok(None)` when git is missing or the project is not a repository
(`crates/supervisor/src/worktree.rs:232`), in which case `req.cwd` is left as given — **the project
root**. Combined with §4's pre-authorization that would hand a worker unattended write access to the
owner's own checkout. **The loop must refuse to dispatch into a project with no worktree**, rather
than inheriting the single-session fallback.

### 7.6 Gaps accepted, and stated rather than closed

- **No per-attempt gate history.** `PhaseRow` (`crates/store/src/plan.rs:295`) stores one
  `last_exit_code` and one `last_evidence`, and has no verify timeout, reason slug, duration or log
  path. So the rung-3 plan card cannot reconstruct *every* attempt after a restart — only the last.
  Accepted for this run; closing it is a schema change, not a runtime guess.
- **No `intent(id)` reader.** `unsettled_intents` (`crates/store/src/writer.rs:546`) returns only
  `open` and `unknown` rows. A second crash after reconciliation wrote `phase_commit = done` but
  before the phase row advanced hides the proof on the next launch. Accepted; the cost is one
  re-derivation, not a wrong answer.
- **The design's own §13.1 tests 8, 9 and 14 are decorative as worded** — 8 may assert raw git
  facts without invoking the production postcondition; 9's squash case is refused by `git cherry`
  and by `rev-list` alike, so it does not separate them (the case that does is *applied upstream
  then reverted*, where `git cherry` falsely authorizes removal); 14 greps for a string, which also
  passes if the auto-remove implementation is deleted. Each needs a positive behavioural assertion.
- **`docs/research/orchestration-loop.md` §14 still mandates rung `1 → 2 → 3` and an `N + 3` child
  ceiling.** D3 drops rung 2, so the real ceiling is **`N + 1`** and two gate executions. The
  subordinate order and its tests must not reintroduce rung 2 from the stale line.
- **`docs/research/intent-records.md` §2.3 still documents a five-step lifecycle** with a separate
  `flush()` at step C. `intent_open` now awaits the commit itself, so it is four steps and the
  caller can no longer forget the barrier. Fix the file in the same change.

### 7.7 What the review confirmed clean, so it is not re-audited

D5's cross-phase reasoning is internally consistent with no silent dependency left. D3 has no
rung-2-specific store field — `phases.attempts` is a generic counter. D7's once-per-phase base sha
is the right granularity: initial orders, re-dispatches and rung 1 all want one phase base, and no
same-phase path needs a later commit. And canonicalizing both root and target handles symlinks,
relative paths, `..` and the macOS `/tmp` versus `/private/tmp` alias, which is therefore not a
separate defect.

### 7.8 A latent trap in the final-text seam, bounded by a rule and not by the code

**[source]** `crates/core/src/claude/adapter.rs:1286` stores a completed turn's accumulated text
under the id of *whichever turn is closing*. `:1050-1070`'s own comment records that attribution is
**approximate across a pre-emption**: when an operator turn pre-empts a minted continuation turn,
the continuation's in-flight `result` closes the operator's turn early. The text accumulated for
the continuation is then filed under the operator's turn id, and a caller asking for the turn it
sent gets **the wrong text, silently** — the `FinalTextError::NotHeld` guard does not fire, because
the id matches.

**It is not reachable by this loop.** A pre-emption needs a second `SendTurn` while a turn is open,
and every child the loop spawns is **one turn and disposable** — which is also
`docs/research/orchestration-loop.md` §15 item 13, *"Never resume a lead call… a resumed lead call
is an accumulating session, which is the product being refused."*

So the seam is safe here because of a rule, not because of the code. Two consequences worth stating
rather than discovering: the moment anyone makes a lead call multi-turn, this becomes a live defect
in the control plane, silently substituting one window's prose for another's; and a lead or planner
child that uses the `Task` tool mints a continuation turn on its own initiative
(`docs/STATUS.md` §5 item 9), which puts one half of the pre-emption in place without anybody
choosing it. Neither has been observed. **[asserted]**

The cheap fix, if it is ever wanted: file the accumulated text under the turn whose text it is at
the moment the text is accumulated, rather than at the moment a turn closes.
