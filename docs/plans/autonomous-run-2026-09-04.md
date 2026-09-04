# Autonomous run — 2026-09-04, unattended

The owner is away for 3–5 hours and will not answer anything. **You take every decision.** This
file is the go for commits on `main`.

Read `CLAUDE.md`, then `docs/vision.md`, then `docs/STATUS.md`, then this file. `docs/vision.md` is
the product; where this file and the vision disagree, the vision wins and you say so in one line.

---

## 1. What "done" means for this run

The owner's words: *"I need the full brigadier app so that i can give it a try to use it in a real
project and hand it some tasks."*

Concretely, at the end of this run he must be able to:

1. Launch the app, click **Add project**, and pick a folder in a **native directory picker** — not
   type an absolute path into a text field.
2. State a goal in plain English.
3. Watch the harness plan it, dispatch work to isolated worktrees, gate on a **real exit code**,
   commit per phase, and keep going without him.
4. See what it is doing without reading a terminal.

`docs/plans/phase-4.md`'s definition of done for the phase is the same sentence in other words, and
it is the bar: *"A session started from the UI can take a goal, grill the owner, plan, dispatch work
orders to isolated worktrees, gate on a real exit code, commit per phase, and survive the owner
going to bed."*

**Explicitly NOT this run:** UI polish, restyling, animation, a design system, W4-E settings,
anything in Wave 4 beyond what function requires. The owner said *"do not focus on ui polish, rather
make it work exactly as i visioned it."* Use the 18 existing tokens in `src/index.css`, dark only,
and add the smallest surface that makes a feature usable.

---

## 2. Standing instructions

**Decide everything yourself.** Do not end a turn waiting for the owner. When a call is genuinely
balanced, take the reversible option, write one line saying what you chose and why, and move on. A
decision recorded in the report is worth more than a question nobody is there to answer.

**Commit policy — this file is the authorization.** One commit per finished item, on `main`, no
push, ever. Prefix `phase 4.<n>:`. All six gates green **before** each commit, run by you, exit
codes captured on the command itself and not through a pipe. A commit whose gates you did not run
yourself is a lie in the log.

**Never `git push`. Never `gh auth switch`. Never force-push. Never rewrite history.**

**Thermal and concurrency budget — the owner asked for this explicitly.** Two other Claude sessions
are live on this Mac (`ibeep-8f`, 24 h old, driving iOS simulators and an Android emulator;
`freelogo-79`). They are not yours; do not touch, kill or message them except as §7 allows.

- **At most 2 concurrent subagents.** Not four, not ten.
- **Exactly one worker may hold the build system at a time.** `cargo` and `npm` contend on
  `target/` and `dist/`. Partition by build system, not just by path — see the memory note
  `brigadier-worker-partition`.
- **`npm run tauri build` is yours alone.** Forbid it in every work order. A `src/**` worker gets
  `npm test` + `npx tsc --noEmit` + `npm run dev`; a `crates/**` worker gets
  `cargo test`/`clippy`/`doc`.
- Do not launch simulators, emulators, or anything else that pins the CPU. If the machine is
  already loaded, run one worker, not two.

**Live model spend.** Default is **zero**. The only authorized live spend is what the owner already
capped: ITEM 6 (steps-to-completion, cap **$5.00**) and ITEM 7 (per-step cache_read vs input, cap
**$0.25**), both **`claude-haiku-4-5` only**, plus the five existing `#[ignore]`d live tests
(~$0.16 total). Read every cost from the **store row**, never by summing `result` frames —
`total_cost_usd` is cumulative and summing double-counts. Report spend as a number.
**Do not run the five paid ignored tests casually.** The sixth,
`eight_ordinary_one_flood_one_approval_across_three_projects`
(`crates/supervisor/tests/flood_baseline.rs:137`), spawns no `claude` and is free.

**Never touch the owner's real database** at
`~/Library/Application Support/ai.brigadier.app/brigadier.sqlite` except read-only, and say when you
did. It sits at `user_version` 3; the first launch after this run's store work takes it to 5. Point
every test and every burn at a scratch data directory.

**`codex-cli` is authorized as a second-vendor reviewer — see §9.** Use it for judgement, never for actions.

**Label every subagent when you launch it** — what it answers, what it owns, whether it spends
money. The owner stops work he cannot identify.

---

## 3. State, verified 2026-09-04 by the previous lead

`main` at `a889525`. **There is uncommitted work in the tree** — W1-A, the plan/progress store plus
intent records, ~1,100 insertions across `crates/store/`. It is good work. Do not revert it, do not
`git stash` it, and note there is no other copy.

```
 M crates/store/src/lib.rs        M crates/store/src/schema.rs
 M crates/store/src/writer.rs     M crates/store/tests/schema.rs
 M docs/research/intent-records.md
?? crates/store/src/intents.rs    ?? crates/store/src/plan.rs
?? crates/store/tests/intents.rs  ?? crates/store/tests/plan.rs
?? docs/research/orchestration-loop.md
```

Six gates re-run by the previous lead on this exact tree, exit codes on the command **[measured]**:

```
cargo test --workspace                                exit 0   340 passed / 0 failed / 6 ignored
cargo clippy --workspace --all-targets -- -D warnings exit 0   0 warnings
cargo doc --workspace --no-deps                       exit 0   0 warnings
npm test                                              exit 0   137 passed / 7 files
npx tsc --noEmit                                      exit 0
npm run tauri build                                   exit 0   .app + .dmg
```

Bundle **274.87 kB JS + 1.38 kB chunk / 27.11 kB CSS** — byte-identical to `a889525`, which is what
a pure-Rust change should look like.

**What exists:** real `claude` children over the stdio control protocol, approvals end to end, one
worktree per session, resume, two concurrent sessions, the sqlite store (`user_version` 5 in the
tree, 3 on disk), the virtualized feed, the shell, and now the plan/progress + intents store.

**What does not exist:** the loop. `grep` for `lead_call`, `work_order`, `fusion`, `verify_command`
in `crates/supervisor/src/` returns 0 hits each. The only production caller of
`Supervisor::start_session` is a Tauri command behind a button (`src-tauri/src/commands.rs:138`).
**Nothing in the app spawns a child on its own initiative.** That is the whole gap.

`docs/research/orchestration-loop.md` (921 lines, untracked) is the finished design for it and cuts
it into ten orders B1–B10. Read it before writing any supervisor code. It was written without a
compiler — treat its signatures as intent, not as fact.

---

## 4. Decisions already taken. Do not reopen them; implement them.

The previous lead took these so you would not have to. Each cost real reasoning.

1. **Approvals are never optimistic, and the current code violates that.**
   `crates/core/src/claude/adapter.rs` warns on a failed `write_frame` and then **unconditionally**
   emits `Event::RequestResolved`. The decision never reached the child, but the store marks the
   approval resolved and the dock shows it as landed. **Fix:** on write failure do **not** emit a
   resolved decision. Emit an explicit *delivery-unknown* outcome, render it in the dock as neither
   allowed nor denied, and let it expire honestly. `docs/vision.md` §9 is the authority: *"a panel
   that shows 'denied' for a deny that did not land — or 'allowed' for something that never ran —
   breaks the one screen the owner has to be able to trust."* Compounding it,
   `expire_pending_approvals` (`crates/store/src/schema.rs:671`) writes an unconditional **denial**
   for every pending row at startup, so after a crash the dock can say "denied" for a tool that ran.
2. **`work_order` intents settle `unknown` only** — already implemented and enforced. Keep it.
3. **`respond` gets a pre-record** — the intent row opens before the frame is written. Not yet
   wired; `crates/core` was outside the store worker's paths. A pre-record is a durability fix and
   **not** licence to paint a decision before it is real.
4. **Project open uses a native directory picker.** Today `Sidebar.tsx:257` calls
   `onAddProject(trimmed)` from a **typed text field** — the owner has to paste an absolute path.
   Add `tauri-plugin-dialog`, wire a folder picker to Add project, and keep the typed path as a
   fallback for tests and the mock bridge. Research its current API before writing against it;
   do not code from memory.
5. **Use the opener plugin that is already there.** `tauri_plugin_opener::init()` is registered at
   `src-tauri/src/lib.rs:109` and **nothing in `src/` ever calls it** — a dead dependency. Give it
   the job it is for: *reveal the project root in Finder*, and *reveal a session's worktree*. That
   is the "project opener plugin" the owner asked to see integrated. Two menu items, no polish.
6. **`bounded()` must never be applied to a JSON column.** It appends `…`, which produces invalid
   JSON. JSON columns get the oversized-placeholder treatment
   (`{"type":"oversized","bytes":N,"head":…}`) that `kind_json` already uses.
7. **An unknown intent kind must not bypass the settleable check.** `hold_to_settleable` currently
   passes an unnameable kind through untouched, so `IntentKind::new("work_oder")` — a typo — can be
   closed as `not_done` and authorize a repeat. The restrictive reading applies to kinds too:
   an unknown kind settles `unknown`.
8. **No second SQLite connection, no cache, no codebase index, no warm pool.** All measured dead
   ends; `docs/research/perceived-performance.md` §2.3 and `codebase-index.md`.

---

## 5. The work, in order

Rank is deliberate. Do not start further down while something above is unfinished, except where
this file says two orders are concurrent.

### Order 0 — the store defects. Do this first; everything else builds on this store.

A blind adversarial review (different vendor, did not watch the code being written) found these in
the uncommitted W1-A work. The previous lead confirmed the four `WRONG` ones in source. Owned path:
`crates/store/**`.

- **`writer.rs:1120` — `upsert_work_order` regresses terminal state.** Its `ON CONFLICT`
  unconditionally assigns `state = excluded.state` even when `finished_at` is set, so a stale
  upsert turns a *finished* order back into a dispatched one → **the same work runs twice**. This is
  the failure the whole intents table exists to prevent, reintroduced one table over. Guard it.
- **`writer.rs:981` and following — most caller-supplied text is unbounded.** Plan goals, phase
  titles, definitions of done, verify commands, revision reasons, questions, work-order titles,
  intent subjects, baselines, paths and branches are inserted **raw**, while `schema.rs:203-204`
  claims every free-text column is bounded. That is the t3code growth path (282 KB → 218 MB in
  25 h). Bound them at the write and make the comment true.
- **`writer.rs:1017` — `change_json` and `owned_paths_json` are truncated into invalid JSON.**
  See decision 6. `owned_paths_json` is what stops two workers writing the same file; corrupting it
  is a correctness bug, not a cosmetic one.
- **`schema.rs:243` — the "required" revision reason accepts `""`.** `TEXT NOT NULL` does not mean
  non-empty. Reject or normalize at the write.
- **`intents.rs:404` — unknown kinds bypass the settlement policy.** Decision 7.
- **`lib.rs:276` — `close()` removes the join handle before `flush().await?`.** On a flush failure
  `Drop` then has no handle, cannot send `Shutdown`, and cannot join, so a live writer can outlast
  the store while cloned handles keep it reachable. Reorder.
- **`writer.rs:310` — `intent_open` has no latency bound.** It awaits a oneshot behind an unbounded
  queue with no timeout; a stuck filesystem stalls the orchestration loop indefinitely. Give it a
  deadline and a typed timeout error, and decide — and record — what the loop does on that error.
  (Safe answer: treat a timeout exactly like a failed open. Do not attempt the effect.)
- **Three tests are decorative and must be strengthened or deleted, never left as they are:**
  - `tests/intents.rs:108`, the barrier test — no timing assertion, so a reply sent *before* commit
    still passes when the writer happens to commit before the child exits.
  - `schema.rs:885`, the migration crash test — its forced failure lands inside `execute_batch`,
    before the version bump, so it still passes if the bump is moved back outside the transaction,
    which is the exact regression it names.
  - `tests/intents.rs:202`, the unknown-state test — it never inserts an unknown state slug, so
    reverting the restrictive fallback to a permissive one would not fail it.
  - `tests/plan.rs:301` covers only `report` for bounded text; add oversized cases for every column
    in the second bullet, and **parse the JSON columns back** to prove they are still valid.

The same review independently confirmed **clean**: the migration transaction mechanics (0→5 and
3→5, and an older three-rung binary correctly rejects version 5), all six cascades, and all five
restrictive slug mappers. Do not re-audit those.

**Commit as `phase 4.1: the store defects a blind review found in W1-A`.**

### Orders B1–B4 — concurrent, two at a time. `docs/research/orchestration-loop.md` §14.

- **B1** command runner and gate — `crates/supervisor/src/verify.rs` (new).
- **B2** action/report schema and validator — `crates/supervisor/src/action.rs` (new).
- **B3** full-assistant-text seam — `crates/core/src/driver.rs`, `crates/core/src/claude/adapter.rs`.
- **B4** phase base sha — `crates/supervisor/src/worktree.rs`.

B3 must not run beside anything else in `crates/core/src/claude/`. **Fold decision 1 and decision 3
into B3** — it already owns `adapter.rs`, and the approvals defect is the highest-value single fix
in this list.

### B5 — alone. State machine, store reads, event tap.

`crates/supervisor/src/lib.rs`, `loop_/mod.rs`, `loop_/state.rs`. It is the only order touching
`lib.rs`, and it lands the module stubs so no later order has to.

### B6–B9 — the loop proper.

B6 reconciliation barrier · B7 dispatch and collection · B8 the red-gate ladder · B9 green: merge,
commit, cleanup. B6+B7 concurrent, then B8+B9 concurrent.

**The reconciler is in B6 and its spec is `docs/research/intent-records.md` §4**, with two
corrections already recorded in that file's 2026-09-04 amendment: `work_order` settles `unknown`
only, and `phase_commit` must compare the **first** parent (`git rev-parse <BR>^1`), because `%P`
lists every parent and a `--no-ff` phase merge has two — proven on git 2.50.1. **Do not use
`git cherry` anywhere**; it reports squash-merged work as unmerged and reverted work as merged
(measured, `docs/research/worktree-cleanup.md` §§2.1–2.4). The only sound signal is
`git rev-list --count base..branch == 0`.

### Order P — the project-open flow. Decisions 4 and 5. Owns `src/**` and `src-tauri/**`.

Runs concurrently with any `crates/**` order, never with another `src/**` order.

### B10 — the surfaces.

`src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `docs/plans/ipc-contract.md`. Includes
`unsettled_intents` and `settle_intent` (`intent-records.md` §5 specifies both), and the
**pinned plan card** — `docs/vision.md` §9 requires that nothing the owner steers with ever scrolls
away. `CoworkTodoPanel` in `docs/research/jan.md` is the prior art; port, do not paste. Function
only; no polish.

### Last — prove it live, once.

One real run on a **scratch repository you create**, not on brigadier itself and not on any of the
owner's projects. A goal small enough to finish: two or three phases with a real verify command.
`claude-haiku-4-5`. Record the cost from the store row. If it fails, that failure is the most
valuable line in your report — write it down exactly, do not paper over it.

---

## 6. Landmines. Read `docs/STATUS.md`'s own list too; this is what it does not say.

- `npm run tauri build` fails from a non-interactive shell unless you prefix
  `export PATH="$HOME/.cargo/bin:$PATH"`.
- Capture exit codes **on the command**. Piping to `tail` reports `tail`'s status.
- `feed`'s insert is `ON CONFLICT(session_id, seq) DO UPDATE`. Any second writer on a session must
  start past `sessions.last_event_seq` or it **silently rewrites history**. The reconciler's `warn`
  row is exactly this hazard.
- **The Bash classifier is built but unwired** (`crates/core/src/wall/`, `21d2375`). The live gate
  is a static tool-name set, `AskGatedTools` at `crates/core/src/claude/hook.rs:79`. This bites the
  moment the loop dispatches workers that need pre-authorization (`docs/vision.md` §8). Wiring it
  is W3-A and is **not** in this run unless the loop is blocked without it — if it is, wire it and
  say so.
- **`intent-records.md` §1.1 is wrong** and the previous lead verified it: it claims `can_use_tool`
  is the *only* pre-effect hook. `crates/core/src/claude/mod.rs:20-23` describes the `PreToolUse`
  seam as seeing *every* tool call, and `adapter.rs:337-341` registers it with `matcher: ""`
  precisely so it fires for every tool. A second pre-effect seam exists. Whether to record on it is
  a **cost** question — a row plus a commit per tool call is the per-chunk write pattern
  `persistence.md` §3 forbids — not a constraint. Decide, measure if you can, and record.
- `intent-records.md` §2.3 still documents a five-step lifecycle. Fix 1 collapsed it to four:
  `intent_open` now awaits the commit itself, so the caller cannot forget the barrier. Update it.
- `docs/STATUS.md` records `user_version` 3 and is now stale; the store is 5 in the tree.
- `crates/claude-spike` builds its own `Command` (`session.rs:114`) and does **not** pick up the
  thinking-off default, so any rig built on it measures a child the app no longer spawns.
- `MAX_THINKING_TOKENS=0` silencing thinking is **not proven** — read from the 2.1.260 binary and
  the vendor docs, never from a live run.
- Every burn number in this repo is a debug-build number, and every 2026-09-04 launch number was
  taken with the display locked.

---

## 7. If something goes wrong

- **A subagent dies to a network error.** It happened twice today; `ibeep-8f` takes the host WiFi
  down with `networksetup -setairportpower en0 off` for ~2 minutes at a time to test offline states.
  Check the tree, and if it left no partial edits, relaunch with a fresh worker rather than reviving
  a large context. If it happens repeatedly and blocks the run, message `ibeep-8f` once, politely,
  asking it to stop taking the host adapter down — the owner has already told it to. Do not kill it
  and do not kill the `sleep 240; networksetup ... on` process, which is what restores the WiFi.
- **A worker's report conflicts with the code.** The code wins. Verify every `file:line` before
  acting on it. A substantively correct review can carry fabricated paths, and a builder can
  correctly reject a review finding.
- **You cannot finish an order.** Finish everything that does not depend on it, commit that, and
  write down exactly what is left and why. Scaling the work down is the owner's call, but he is not
  here — so deliver the rest in full and be precise about the hole.
- **The gates go red and you cannot see why in 20 minutes.** Stop, commit nothing, and write the
  failing output verbatim into the report. A red gate you do not understand is not a gate you may
  work around.

---

## 8. What the owner reads when he gets back

Write `docs/plans/report-2026-09-04.md`, and update `docs/STATUS.md` §§1–3 to match the tree you
leave behind.

Rules, from `CLAUDE.md` §5, and they are not decoration:

- One line per fact. A path or a number instead of an adjective. The remedy on the same line as the
  problem.
- Tag every claim **[measured]** / **[source]** / **[documented]** / **[asserted]**.
- **No invented progress.** A feature works only after it has been run. Report a weaker result as
  weaker.
- **Say what you did not check.**
- Spend as a number, from the store row.
- Lead with the one sentence that answers his actual question: *can he open the app, point it at a
  real project, hand it a task, and walk away?* If the answer is no, say no in the first line and
  then say exactly what is missing.

---

## 9. `codex-cli` is available, and the owner has authorized it

**This overrides the global rule against nested CLIs.** `~/.claude/CLAUDE.md` says *"Never shell out
to `claude -p`, `claude --print`, or any nested CLI to get a second worker"* — the owner lifted that
for `codex` specifically, on 2026-09-04, in as many words: *"you can use the installed codex-cli as
your slave to hand it work to help you deliver faster and better."*

The rationale matters, because it bounds what codex is for. The global rule exists because an
`Agent` subagent is the same model — same training, same blind spots — so a nested `claude` buys
nothing an `Agent` call does not. **`codex` is a different vendor**, which is exactly
`docs/vision.md` §5's argument for fusion: *"A differently-trained model has different blind spots,
which is strictly better than Claude reviewing Claude."*

So the rule for this run is the product's own rule:

> **Fusion for judgement. Single owner for actions.**

Use `codex` for review, critique and second opinions. Do **not** hand it file writes — the harness
worker owning a path stays the single owner of it.

### Verified on this machine, 2026-09-04 [measured]

```
codex --version        codex-cli 0.150.1
codex login status     Logged in using ChatGPT          <- the owner's ChatGPT plan, not an API key
model                  gpt-5.6-sol, reasoning effort high
```

Cost: it consumes the owner's **ChatGPT plan usage**, not Anthropic tokens and not per-token
billing. There is no dollar figure to report, but it is not free — it is consumption on an account
he also uses himself. Do not spray it at trivia. Two or three high-value passes across this run is
right; twenty is not.

### The invocation that works, and why it is safe beside a build

```
codex exec -s read-only -C /Users/stephen/Development/brigadier-ai - < /path/to/prompt.md \
  > /path/to/findings.txt 2> /path/to/stderr.txt
```

- `-s read-only` is what makes it **safe to run concurrently with a `cargo` build**: it cannot write,
  so it cannot touch `target/`, and it therefore does not contend for the build system the way a
  second Claude worker would. It is the one job you may run beside a build without breaking §2's
  concurrency budget.
- Feed the prompt on **stdin** (`-` reads it) rather than as an argument — the prompts worth writing
  are 60+ lines and shell-quoting them is a trap.
- Redirect stdout to a file and read the file. Do not let a long review land in your context raw.
- `codex review --uncommitted` also exists and reviews staged + unstaged + untracked changes; it
  takes no `-s` flag, so pass `-c sandbox_mode="read-only"` if you use it.
- Run it in the background and wait for the notification; do not poll.

### What it is worth, measured today rather than asserted

Two passes were run on 2026-09-04 and both found things Claude had missed:

1. **Against `docs/research/intent-records.md`** (a 583-line design whose own §9 admits *"Nothing
   here was compiled or run"*): 10 `WRONG`, including that `flush()` was **not** the durability
   barrier the entire design rested on — `apply_batch` logs and skips a failed op, then commits and
   answers every flush waiter with success. That defect had survived a full design review and an
   implementation.
2. **Against the uncommitted W1-A diff**: the four `WRONG` findings that became §5's Order 0,
   including the stale-upsert bug that runs a finished work order twice — plus it correctly called
   **three of the new tests decorative**, which is the finding a builder almost never produces about
   its own suite.

It also confirmed clean what was clean (migration transaction mechanics, all six cascades, all five
slug mappers), which is worth as much as the defects: it stops you re-auditing settled ground.

### How to brief it

The same way you brief any stranger, plus three things that made today's passes work:

- **Tell it what it may not run.** `cargo`, `npm`, `npx` — say another process holds the build
  system. Otherwise it will try, fail confusingly under the read-only sandbox, and waste the pass.
- **Give it a severity vocabulary and a one-line-per-finding output shape.** Today's used
  `WRONG` / `RISK` / `WEAK` / `GAP` / `NIT` with `file:line | claim | what the code says | consequence`.
  Unstructured review prose is much harder to act on and much easier to overtrust.
- **Name the decisions it may not reopen**, and ask it instead whether those decisions have
  consequences elsewhere that the design does not account for. That question produced real findings
  today; "review this" would not have.
- **Ask it explicitly which tests would still pass if the code they name were reverted.** That
  single question found three decorative tests.

### The standing rule

**Verify before acting.** A reviewer that is substantively right can still cite a line that does not
exist — one of today's citations was 145 lines off, and a second named a range that omitted the
operation the claim depended on. Confirm every `file:line` yourself before you hand a finding to a
worker, and evaluate the claim separately from its footnote. Treat neither builder nor reviewer as
authoritative; the code decides.
