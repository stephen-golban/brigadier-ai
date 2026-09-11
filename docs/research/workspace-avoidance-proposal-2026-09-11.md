# Avoiding the workspace collision, rather than reporting it better

2026-09-11. Design proposal. No code was written and no gate was run for this file.

**Scope.** The owner's item (c): arrange things so "Work locally" + "Current (main)" on the project's own
checkout does not collide with an open brigadier terminal, instead of explaining the collision more
clearly. Item (b) — naming the holder — is already being built by a concurrent worker
(`docs/research/workspace-lock-holder-identity-2026-09-11.md`) and is assumed below, not re-proposed.

**Hard constraint, from the owner.** Do not weaken the exclusion between two **writers**. The
ancestor/descendant rule that stops two turns writing one tree stays exactly as strong as it is.
Everything below is built to leave the `{key}` locks — the writer locks — untouched.

**Marking.** Every citation is `path:line@462c6bf` and was read at that commit
(`git show 462c6bf:<path>`) unless it says `[working copy]`. **[measured]** appears only for numbers
taken from `docs/research/bb-workspace-model-2026-09-11.md`, which ran bb; nothing here was measured by
me. **[asserted]** is reasoning I did not verify.

`crates/core/src/checkpoint/lease.rs` is being rewritten in this worktree right now. The model in §1 is
HEAD's. Where the in-flight change matters it is called out as `[working copy]`.

---

## 1. Today's leases, precisely

### 1.1 The lock files

`WorkspaceLease::open` canonicalises the root, computes a directory identity per ancestor, and then walks
`ancestors` from the filesystem root **down** to the workspace root (`lease.rs:107@462c6bf`,
`.enumerate().rev()`, so `i == 0` is the workspace root itself). Three lock-file families exist per
ancestor key, all in one per-user registry at `$HOME/.brigadier/workspace-locks-v1`
(`lease.rs:75-82@462c6bf`):

| file | meaning |
|---|---|
| `{key}` | the **writer** key. This is the two-writers exclusion the owner protects. |
| `terminal-root-{key}` | "a shell is rooted here" |
| `terminal-desc-{key}` | "a shell is somewhere at or below here" |

### 1.2 What each mode takes

Read off `lease.rs:127-144@462c6bf`. `X` = exclusive (`try_lock`), `S` = shared (`try_lock_shared`),
`—` = not taken. "own root" is `i == 0`; "ancestors" is every strictly-higher key.

| mode | constructor | `{key}` own root | `{key}` ancestors | `terminal-root` own root | `terminal-root` ancestors | `terminal-desc` own root | `terminal-desc` ancestors |
|---|---|---|---|---|---|---|---|
| `Exclusive` | `acquire` / `recover` `lease.rs:33,37@462c6bf` | **X** | S | S | S | **X** | — |
| `Writer` | `writer` `lease.rs:42@462c6bf` | **X** | S | — | — | — | — |
| `Terminal` | `terminal` `lease.rs:47@462c6bf` | — | — | **X** | — | S | S |

Two consequences fall straight out of that table and are asserted at
`crates/core/tests/checkpoints.rs:446-465@462c6bf`:

- `Terminal` and `Writer` share no file, so **a shell never blocks an AI turn** (`:447-448`). Deliberate:
  `lease.rs:40-41@462c6bf` says shell edits are external activity and capture validates what it reads.
- `Terminal` and `Exclusive` conflict **in both directions and across the hierarchy** (`:449-450`,
  `:456`, `:459-460`, `:464`). A terminal at the root holds `terminal-root-{root}` exclusively; every
  `Exclusive` takes `terminal-root-{key}` **shared at every ancestor including its own root**, so they
  meet at `i == 0`. A terminal *below* an `Exclusive` root meets it on `terminal-desc` instead.

Two terminals at the same canonical root would also collide (`terminal-root` is exclusive), which is why
`src-tauri/src/terminal.rs:108-117@462c6bf` shares one `Arc<WorkspaceLease>` across every tab at that
root rather than taking a second one.

### 1.3 Who holds what, for how long

| # | holder | mode | site | duration | does it write the tree? |
|---|---|---|---|---|---|
| S | **session start, "Work locally"** | `Exclusive` | `composer_workspaces.rs:192@462c6bf` | the body of `prepare_checkout`; dropped at return | **no** — with `base` and `new_branch` both `None`, `checkout` returns at `composer_workspaces.rs:202-204@462c6bf` before any git call |
| W | **session start, branch switch** | `Exclusive` | same lease, then `composer_workspaces.rs:278-291@462c6bf` | same | yes, one `git checkout` |
| T | **AI turn** | `Writer` | `crates/supervisor/src/checkpoints.rs:171@462c6bf` | stored in `Active` at `:194-200`, released in `finish_epoch` at `:231-247` — one turn | yes (the agent writes) |
| T2 | **child lifetime writer** | `Writer` | `crates/supervisor/src/lib.rs:1103-1110@462c6bf` → `Install.writer_lease` → `LiveSession._writer_lease` at `:1590` | the whole child process | taken only when the start request still carries a prompt. The composer path empties it first (`src-tauri/src/commands.rs:497-500@462c6bf`), so in the app this is `None` there; `src-tauri/src/peers.rs:313@462c6bf` and `src-tauri/src/commit_message.rs:149@462c6bf` do carry one |
| G | **loop git mutation** | `Exclusive` | `crates/supervisor/src/loop_/git.rs:96-108@462c6bf` | one git command | for `merge/checkout/reset/restore` yes; for `commit/add/worktree` it writes `.git`, not the worktree |
| V | **verify gate** | `Exclusive` | `crates/supervisor/src/verify.rs:301@462c6bf` | the **entire gate run** | build artifacts only |
| R | **rewind / restore / apply** | `Exclusive` + `.recovery` marker | `checkpoints.rs:261,421,1205,1344@462c6bf`, recovery at `:622` | the transaction; the marker outlives the process | yes, destructively |
| X | **worktree removal** | `Exclusive` | `crates/supervisor/src/lib.rs:1912,2028@462c6bf` | the removal | deletes the directory |
| M | **source-control file-replacing action** | `Exclusive` | `src-tauri/src/source_control.rs:68-70@462c6bf` | the action. Index- and ref-only actions take `Writer` instead (`:65-67`) | yes |
| K | **terminal** | `Terminal` | `src-tauri/src/terminal.rs:114@462c6bf` | until the **last** tab at that canonical root closes — minutes to days | the user does |
| F | **fork source** | `Writer` | `crates/supervisor/src/fork.rs:88@462c6bf` | while the transcript is copied | no |

Note rows **V** and **G**: the verify gate and the loop's own `git commit` both take `Exclusive`, so at
HEAD **an open terminal on a session's worktree also blocks that session's gate and its commit**, not
only a session start. `[asserted]` from the table in §1.2 plus those two line citations; not reproduced.
That is what makes this a systemic routing fault rather than one bad call site.

### 1.4 Two guards that are not leases, and matter to every design below

- **Path admission.** `composer_workspaces.rs:183-190@462c6bf` refuses a start whose target checkout is
  already the `cwd` of a live session, by path, before any lock is touched, with a sentence that names
  the remedy. `crates/supervisor/src/lib.rs:749-760@462c6bf` repeats it with `is_engaged`. The picker
  pre-marks those rows unavailable (`composer_workspaces.rs:109-127@462c6bf`, rendered at
  `src/components/composer/TaskSetupRail.tsx:93-94@462c6bf`).
- **Store-backed writability.** `Supervisor::workspace_writable`
  (`crates/supervisor/src/checkpoints.rs:114-135@462c6bf`) refuses any write on a root with an unresolved
  rewind row, from the database, not from a file. It is called at `composer_workspaces.rs:191@462c6bf`
  **before** the lease, and again at `lib.rs:761,924,1102@462c6bf`.

Both survive every design below. They are the writer-vs-writer product rule, and they are strictly better
instruments than a lock: they know the session's title, and they answer before anything is acquired.

---

## 2. The collision matrix at HEAD

Rows are the **holder**; columns are what is **being started**. Cell = whether the OS lock refuses, and
whether that refusal is right. All cells at the same canonical root unless the row says otherwise.

| holder \ newcomer | start-attach (S) | AI turn (T) | branch switch (W) | restore (R) | verify gate (V) | worktree removal (X) |
|---|---|---|---|---|---|---|
| **AI turn** (`Writer`) | refused — **redundant**: §1.4 path admission already refused it, with a better message | refused — **real hazard**, two writers | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** |
| **terminal of the same session** (`Terminal`) | refused — **false positive**, the owner's bug: S writes nothing | allowed — **correct**, by design | refused — **false positive**: the switch is already refused on a dirty tree at `composer_workspaces.rs:233-239@462c6bf`, so the shell's uncommitted work is never at risk | refused — **real hazard**: R rewrites tracked files under a live shell | refused — **false positive**: a gate runs the project's test command | refused — **real hazard** |
| **terminal of another session** | refused — **false positive** (same reason) | allowed — **acceptable**: interleaving with the user's own shell is the standing model | refused — **false positive** | refused — **real hazard** | refused — **false positive** | refused — **real hazard** |
| **restore** (`Exclusive` + marker) | refused — **real hazard** while live; **false positive** once the process is gone and the marker is orphaned (§5) | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** |
| **second session on the same tree** | refused twice — by §1.4 and by the lock. The rule is **real**; the lock is **redundant** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** |
| **session on an ancestor or descendant** | refused — **false positive** for S; the ancestor rule is right, the operation is a no-op | refused — **real hazard**, this is the rule the owner is protecting | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** | refused — **real hazard** |

Counting: every cell in the **turn**, **restore** and **second-session** rows is either a real hazard or a
redundant duplicate of a check that already fired. Every false positive in the table sits in a
**terminal** row, or in the **start-attach** column, or both. That is the whole defect surface.

Two cells deserve their own line:

- **terminal × start-attach** is the reported failure. `Mode::Exclusive` was chosen by the code path
  (`prepare_checkout` always calls `acquire`) and not by the work (none).
- **terminal × verify gate** and **terminal × loop commit** are the same fault reached from the loop
  instead of from setup, and nobody has reported them yet because the loop has not run with a terminal
  open on a worktree. `[asserted]`

Ancestor/descendant collisions are rarer in practice than the table suggests: session worktrees are
created as siblings of the project (`/Users/stephen/Development/brigadier-ai.worktrees/…` on this
machine), not nested under it, and a project root that is itself a linked worktree is refused outright
(`crates/core/src/worktree.rs:106-120@462c6bf`). They bite when one project sits inside another.
`[asserted]` — I did not enumerate the user's projects.

---

## 3. Candidate designs

### A. Mutation-scoped leases

**Change.** `prepare_checkout` stops calling `WorkspaceLease::acquire` unconditionally
(`composer_workspaces.rs:192@462c6bf`). The lease moves into `checkout`, taken after the
`base.is_none() && new_branch.is_none()` early return at `:202-204` — that is, only on a code path that
is about to run `git checkout`. It covers the dirty check at `:233-239` and the write at `:278-291`, so
there is no TOCTOU between "the tree is clean" and "switch it".

**Keeps.** Every `{key}` lock. Both guards in §1.4. The terminal gate on every genuinely destructive
operation. `Mode` is untouched, so the lock-file layout does not change.

**What still protects a turn from another turn on the same tree** — the owner's question, answered in
four layers, none of which is the lease being removed:

1. `composer_workspaces.rs:183-190@462c6bf` refuses the start outright if a live session already owns
   that cwd.
2. `crates/supervisor/src/lib.rs:749-760@462c6bf` repeats it inside the supervisor.
3. `protect_workspace` at `lib.rs:768-771@462c6bf` records the claim in the store.
4. The turn itself still takes `Mode::Writer` at `checkpoints.rs:171@462c6bf`, which is exclusive at its
   own root and shared at every ancestor — so two turns on one tree, or on an ancestor/descendant pair,
   still collide at the `{key}` file. **The exclusion the owner named is in the turn's lease, not in
   setup's.** Removing setup's lease removes a duplicate, not the rule.

**Migration.** Nothing. No lock-file format change, no marker change, and setup's lease was never held
past `prepare_checkout`'s return, so no running session holds one across an upgrade. One behaviour
change to state out loud: a `.recovery` marker no longer blocks *starting* a local session, because
attach reads no registry. The store-backed `workspace_writable` at `composer_workspaces.rs:191@462c6bf`
still does, for rewinds recorded on that root. Markers written by an **apply** rather than a rewind are
covered by `discard_checkpoints` (`checkpoints.rs:63-82@462c6bf`) and not by `workspace_writable`;
**I did not check** whether an orphaned apply marker can exist without a matching rewind row.

**Cost.** `src-tauri/src/composer_workspaces.rs`: about −4 / +8 lines, plus two tests in its own `mod
tests` (a terminal lease held at the root, then `prepare_checkout` succeeds for current-branch and still
fails for a switch). Risk: low. Test burden: 2 new tests, 0 existing tests broken
(`crates/core/tests/checkpoints.rs` does not exercise `prepare_checkout`).

**Fixes.** The whole **start-attach** column: terminal-of-same-session, terminal-of-another-session, and
ancestor/descendant against S. Does not touch the verify-gate or loop-commit columns.

### B. Session-owned workspace

**Change.** Ownership becomes an attribute of the lease, so a session's own terminal and its own turn are
the same owner. The concurrent worker has already built the identity half: `LockOwner { kind, id, root,
pid, started_at }` is written into every exclusively-held lock file, and `acquire_as` / `writer_as` /
`terminal_as` take a session or terminal id (`crates/core/src/checkpoint/owner.rs:63-73`,
`lease.rs:64,77,88` `[working copy]`). What B adds is making that id *participate in exclusion*.

**How the lease records ownership, and how adopt works.** `flock(2)` cannot help here: two file
descriptors in one process conflict with each other, and the API has no query interface
(`owner.rs:3-6` `[working copy]` says exactly this). So adoption has to sit **in front of** the
filesystem layer, as a process-local registry — the pattern
`src-tauri/src/terminal.rs:108-117@462c6bf` already uses to share one `Arc<WorkspaceLease>` across
terminal tabs at one root, generalised from "same root" to "same root **and** same owner id".

An owner's entry holds the **union** of the lock files any of its leases needs, taken once, upgraded on
demand: the session's first terminal takes `terminal-root`/`terminal-desc`; the same session's later
`Exclusive` finds the entry, opens only the `{key}` files it is missing, and shares the terminal files it
already holds. Two properties have to hold or B is unsafe:

- An adopt may only **add** locks, never let a stronger mode borrow a weaker lease. A turn that adopted a
  terminal's entry without taking `{key}` would stop excluding other writers — the exact thing the owner
  forbade.
- Release is refcounted per lock file, not per lease, and the `Drop` at `lease.rs:248-255@462c6bf`
  already has to unlock explicitly because of inherited descriptors; that code becomes "decrement, unlock
  at zero".

A **foreign** terminal still blocks, and the error names it: `LeaseKind::Terminal`, the id, the pid and
the remedy are already formatted at `owner.rs:100-116` `[working copy]`.

**Keeps.** Every `{key}` lock and the full ancestor/descendant rule, unchanged. The terminal gate against
*other* owners.

**Migration.** Lock-file bytes are unchanged (B is in-process bookkeeping over the same files), so an old
and a new build interoperate: the old one simply never adopts. `.recovery` markers are untouched. A
running session across an upgrade holds ordinary flocks either way. The one real migration cost is that
every call site that wants adoption must thread a session id, and today most do not — `verify.rs:301`,
`loop_/git.rs:103`, `source_control.rs:68`, `composer_workspaces.rs:192` all call the id-less
constructors.

**Cost.** `crates/core/src/checkpoint/lease.rs` +120/−40 (the registry, refcounted release, upgrade
path); `crates/core/src/checkpoint/owner.rs` +20; call-site threading across
`crates/supervisor/src/{verify.rs, loop_/git.rs, checkpoints.rs, lib.rs}` and
`src-tauri/src/{composer_workspaces.rs, source_control.rs, terminal.rs}`, roughly +5 each; new tests in
`crates/core/tests/checkpoints.rs` and the new `crates/core/tests/lock_registry.rs`. Eight to ten files.
Risk: **high** — refcounted cross-mode lock ownership is the kind of code that is correct in the test and
wrong under `Drop` ordering, and it lands on a file another worker is rewriting this week.

**Fixes.** The terminal-of-the-**same**-session row entirely, including the verify-gate and loop-commit
cells that A leaves. Leaves the terminal-of-another-session row refusing, with a name.

### C. Bounded wait instead of refuse

**Change.** `try_lock` / `try_lock_shared` at `lease.rs:118-122@462c6bf` become a poll-with-ceiling. bb's
numbers, **[measured]** in `docs/research/bb-workspace-model-2026-09-11.md` §2.2: a process-local queue
with a **5-minute** timeout, and one durable `mkdir` lock polled every **100 ms** that **force-removes a
holder older than 10 minutes**. On expiry we fail with the holder named, which is B's error path.

**Keeps.** Everything. This changes when a refusal happens, never whether contention is allowed.

**How it interacts with a permanently held terminal lock: it does not solve it.** A terminal lease lives
until the last tab at that root closes (`terminal.rs:108-117@462c6bf`) — minutes to days. Waiting five
minutes and *then* failing turns a one-second error into a five-minute hang followed by the same error,
which is strictly worse for a session start. C is only useful for contention that clears on its own: a
turn's `Writer` epoch, a loop `git commit`, a running gate. Ceilings must therefore differ by call site:
a user-visible setup step gets a few seconds at most; a background mutation can afford minutes.

**Migration.** None to the files. The UI needs a "waiting for <holder>" state or the app looks hung,
which means `src/sessionStartup.ts` and the composer's progress channel
(`src-tauri/src/commands.rs:554-566@462c6bf`) both change.

**Cost.** `lease.rs` +40 (a deadline parameter threaded through `open` and the `take` closure), plus
per-call-site ceilings, plus front-end feedback: 5-6 files. Risk: medium — a blocking poll inside
`WorkspaceLease::open` runs on whatever thread called it, and several call sites are on the async
runtime without `spawn_blocking` (`composer_workspaces.rs:192@462c6bf` among them). Test burden:
timing tests, which are the flaky kind.

**Fixes.** No cell outright. It converts transient real-hazard refusals (turn × turn, gate × turn) from
errors into waits. It fixes **none** of the terminal false positives.

### D. Prefer a worktree when the local tree is busy

**Change.** At setup, if the chosen local checkout is held by a terminal or another session, the
environment picker defaults to "New worktree" and says why in one line. Today the picker computes
availability from live sessions and `git worktree lock` only (`composer_workspaces.rs:113-119@462c6bf`)
and knows nothing about terminal leases, so the owner's dialog offered "Work locally" with no warning at
all.

**UI default or policy?** **UI default, and only a default.** Making it policy — silently redirecting a
"Work locally" request into a worktree — would change the directory the agent writes to without the user
asking, which breaks the one thing "Work locally" means. The correct shape is: the picker still offers
"Work locally", marked with its holder, and the pre-selected row is the worktree.

**Keeps.** Everything.

**Migration.** `WorkspaceOption` gains a field, which is additive on the Serde side; the front end reads
it or ignores it.

**Cost.** `src-tauri/src/composer_workspaces.rs` +25 (ask the terminal registry which roots it holds);
`src-tauri/src/terminal.rs` +10 (expose that list — a `pub(crate) fn roots()` over the map at
`terminal.rs:61-66@462c6bf`); `src/bridge.ts` +2; `src/components/composer/TaskSetupRail.tsx` +10;
`src/components/composer/TaskSetupRail.test.tsx` +1 test. Five files, all small. Risk: low.

**Fixes.** No cell. D removes the *surprise*, not the collision, and on its own it makes "Work locally"
harder to reach rather than possible. It is worth building only **after** A, where it stops being an
apology and becomes a hint.

### E. Split `Mode::Exclusive` into "mutates the tree" and "destroys what a shell is looking at"

This is the generalisation of A, and the reason I recommend the pair rather than A alone.

**Change.** A fourth mode — `Mode::Mutate` — takes the `{key}` locks exactly as `Exclusive` does
(**X** at own root, **S** at ancestors: the writer rule, unchanged) and takes **no** `terminal-*` lock.
`Mode::Exclusive` stays as it is and keeps the terminal gate. Then each existing `Exclusive` call site is
re-sorted by what it actually does to the tree:

| stays `Exclusive` (terminal gate is a real hazard) | becomes `Mutate` (gate is a false positive) | becomes `Writer` (reads only) |
|---|---|---|
| restore / rewind / apply — `checkpoints.rs:421,1205@462c6bf` | verify gate — `verify.rs:301@462c6bf` | `checkpoint_preview` — `checkpoints.rs:261@462c6bf` |
| recovery — `checkpoints.rs:622@462c6bf` | loop `commit`/`add`/`worktree` — `loop_/git.rs:96-108@462c6bf` | `preview_undo` — `checkpoints.rs:1344@462c6bf` |
| worktree removal — `lib.rs:1912,2028@462c6bf` | setup branch switch — `composer_workspaces.rs` (A's new site) | |
| source-control file-replacing actions — `source_control.rs:68-70@462c6bf` | loop `merge`/`checkout`/`reset`/`restore` — **judgment call, see below** | |

The single judgment call is the loop's own `git checkout`/`reset`. It rewrites tracked files under a
shell. I would leave those on `Exclusive`: the loop owns a worktree the user is not normally sitting in,
so the gate costs nothing there, and on a shared tree it is the right refusal. The setup branch switch
goes to `Mutate` because the dirty check at `composer_workspaces.rs:233-239@462c6bf` already refuses on
any uncommitted file, so there is nothing of the shell's to lose — the worst case is that the shell's
`ls` shows a different branch, which is what happens when the user types `git checkout` themselves.

**Keeps.** `{key}` semantics byte-for-byte. The terminal gate on every destructive operation.

**Migration.** New lock files: none — `Mutate` uses the existing `{key}` names, so an old build and a new
build still exclude each other correctly on the writer keys. The old build would additionally gate
terminals where the new one does not; that is a superset, so mixed versions are safe in the direction
that matters. `.recovery` markers unchanged. No running-session migration.

**Cost.** `crates/core/src/checkpoint/lease.rs` +12 (`Mode::Mutate`, one `match` arm, one constructor);
`crates/core/src/checkpoint/mod.rs` +1 (re-export nothing new; the constructor is a method);
`crates/supervisor/src/verify.rs` +1; `crates/supervisor/src/loop_/git.rs` +6;
`crates/supervisor/src/checkpoints.rs` +2; `src-tauri/src/composer_workspaces.rs` +1;
`crates/core/tests/checkpoints.rs` +1 test asserting a terminal at the root permits `mutate` and still
refuses `acquire`. Seven files. Risk: medium-low — the risk is entirely in the sorting table above, not
in the mechanism.

**Fixes.** The terminal rows against the **verify gate**, the **loop commit** and the **branch switch**
columns, for both same-session and foreign terminals. Combined with A it clears every false-positive cell
in §2.

---

## 4. Recommendation

**A + E, then D. Not B. Not C for now.**

The matrix in §2 makes the case on its own: every false positive is a `Terminal` row meeting an
`Exclusive` column, and every one of those columns is an operation that either writes nothing (attach,
preview) or writes something a shell has no stake in (a gate's build output, a `git commit`, a
branch switch already refused on a dirty tree). None of them is a second writer. The writer rule the
owner is protecting lives in the `{key}` locks, and A and E leave those untouched — A deletes a lease
that guarded a function which returns at its first statement, and E gives the non-destructive mutations a
mode that takes the same `{key}` locks and drops only the shell gate. B is the theoretically better
answer, because ownership is genuinely the right concept and the identity plumbing for it is landing this
week; I am not recommending it now because refcounted cross-mode adoption over `flock` is the highest-risk
change in this list, it lands on a file a concurrent worker is rewriting, and after A and E the only cell
it still buys is *foreign* terminal versus a destructive operation — which is a refusal we want. C buys
nothing against a terminal lease, which can be held for a day; it is worth revisiting once A and E have
removed the false positives and the only remaining contention is transient turn-versus-turn, where a
few-second wait would genuinely help. D is real but cosmetic until A exists, so it goes last.

### Build plan

**Slice 1 — attach takes nothing.** Move the lease out of `prepare_checkout` and into `checkout`, after
the current-branch early return. Add two tests in the file's own `mod tests`: with
`WorkspaceLease::terminal(root)` held, current-branch setup succeeds and a branch switch still refuses.
Files: `src-tauri/src/composer_workspaces.rs`. **1 file.** This alone closes the owner's report.

**Slice 2 — `Mode::Mutate` and the re-sort.** Add the mode and its constructor; re-route the call sites
per E's table; add the lease test. Files: `crates/core/src/checkpoint/lease.rs`,
`crates/core/src/checkpoint/mod.rs`, `crates/core/tests/checkpoints.rs`, `crates/supervisor/src/verify.rs`,
`crates/supervisor/src/loop_/git.rs`, `crates/supervisor/src/checkpoints.rs`,
`src-tauri/src/composer_workspaces.rs`. **7 files.** Must land after the holder-identity rewrite of
`lease.rs` is committed, or the two conflict on the same file.

**Slice 3 — marker retention (§5).** Files: `crates/core/src/checkpoint/lease.rs`,
`crates/core/src/checkpoint/owner.rs`, `crates/core/tests/lock_registry.rs`,
`crates/supervisor/src/checkpoints.rs`. **4 files.**

**Slice 4 — the picker knows about terminals (D).** Files: `src-tauri/src/composer_workspaces.rs`,
`src-tauri/src/terminal.rs`, `src/bridge.ts`, `src/components/composer/TaskSetupRail.tsx`,
`src/components/composer/TaskSetupRail.test.tsx`. **5 files.** Touches the render path, so it owes the
burn (`VITE_BURN=1`, CLAUDE.md §4).

**Slice 5 — optional, only if measured need.** Bounded wait (C) on `Mutate` and `Writer` only, never on a
user-visible attach, with a ceiling in seconds and progress text. Files: `crates/core/src/checkpoint/lease.rs`,
`crates/supervisor/src/{verify.rs, loop_/git.rs}`, `src-tauri/src/commands.rs`, `src/sessionStartup.ts`.
**5 files.**

### What the recommendation does not protect against

- **A shell and an agent interleaving writes in one tree.** `Writer` has never gated terminals
  (`lease.rs:143@462c6bf`, asserted at `crates/core/tests/checkpoints.rs:447-448@462c6bf`), and nothing
  here changes that.
  It is acceptable under `docs/vision.md` §7-§8: safety comes from **disjoint path ownership per work
  order** among harness-dispatched workers, validated in `crates/supervisor/src/action.rs:568@462c6bf`,
  not from locking the user out of their own directory. bb has no answer to this either — two of its
  threads in one checkout run turns concurrently, **[measured]**, `bb-workspace-model-2026-09-11.md` §2.2.
- **Anything outside brigadier.** `lease.rs:1@462c6bf` says it: external programs do not honour this lock.
- **A foreign terminal against a destructive operation.** Still refused, now by name. That is the
  intended behaviour, not a gap.
- **Pid reuse.** `LockOwner.started_at` is recorded for a future start-time check and not yet used
  (`owner.rs:72-73` `[working copy]`).

### The residual cases where "work locally on the current branch" still cannot start

After A + E, exactly two, both from §1.4 and both correct:

1. **Another live session already owns this checkout.** Refused at
   `composer_workspaces.rs:183-190@462c6bf` before any lock. The message the user should see:

   > Another task, "<title>", is already working in /Users/stephen/Development/brigadier-ai. Open that
   > task, or start this one in a new worktree.

   The title is already in hand at `composer_workspaces.rs:124@462c6bf`; the current string at `:188`
   does not use it.

2. **An unresolved rewind is recorded on this root.** Refused by `workspace_writable`
   (`checkpoints.rs:114-135@462c6bf`). The message:

   > A rewind on /Users/stephen/Development/brigadier-ai did not finish. Review it in that task's
   > history before working here, or start this one in a new worktree.

No terminal, no lock file and no pid appears in either sentence, because after A + E neither case is a
lock conflict.

---

## 5. Retention of `.recovery` markers

**Today.** `block()` writes the marker before the first mutation and refuses a second operation id on the
same root (`lease.rs:200-233@462c6bf`). Any overlapping root — ancestor, descendant or identical — is
then refused with "Workspace requires recovery {uuid}" (`lease.rs:166-183@462c6bf`). Only
`recover(root, same-uuid)` followed by `resolve(same-uuid)` clears it (`:37-39`, `:235-245`). It is
deliberately durable across reboot and temp cleanup (`lease.rs:72-74@462c6bf`). Two app paths clear one:
`checkpoint_recover` (`checkpoints.rs:622@462c6bf`) and `discard_checkpoints`
(`checkpoints.rs:63-82@462c6bf`). The in-flight rewrite adds one expiry — a marker whose recorded root no
longer exists on disk is deleted — and records `pid` and `started_at` additively, with the explicit rule
that a marker whose root still exists is never removed however dead its pid
(`lease.rs:405-409`, `:23-27` `[working copy]`).

**bb's answer, for contrast.** bb's only durable lock is a `mkdir` inside the repo's git common dir, and
anyone who finds it older than **10 minutes** force-removes it (`GIT_REF_FS_LOCK_STALE_MS`, **[measured]**
at read level, `bb-workspace-model-2026-09-11.md` §2.2). bb has no durable blocker at all: a failed
attempt is retried onto a *new* path key, `${threadId}-${attempt}`, so nothing has to be cleaned up before
the retry (§2.5, **[measured]** `thr_j6qnfzkwhz-1`).

**What should survive, and what should expire.**

- **Survive, forever, with no clock:** a marker whose operation still has a non-terminal row in the store
  (`workspace_rewinds` / `workspace_applies`). That marker records a **half-applied file tree**. A
  wall-clock expiry there would silently unblock a directory whose files are in a state nobody has
  reconciled, which is the one outcome worse than an outage. bb's 10-minute rule is not a precedent for
  it: bb's lock guards a *ref* mutation, ours guards *file content*. Adopt bb's principle — "a durable
  blocker must carry its own expiry" (§5.4) — but implement the expiry as **provenance**, not as age.
- **Expire:** a marker whose recorded pid is dead **and** whose operation has no non-terminal row in the
  store. That marker can never be recovered into, because `checkpoint_recover` looks the operation up and
  errors with "Unknown recovery operation" (`checkpoints.rs:623-630@462c6bf`) — so it is pure debris
  blocking a directory forever. Today nothing removes it.
- **Expire:** a marker whose recorded root no longer exists. Already in the in-flight change.
- **Expire:** `*.tmp` scratch from a `block()` that died between create and rename
  (`lease.rs:212-230@462c6bf`). The in-flight change gives this a one-hour age
  (`SCRATCH_AGE`, `lease.rs:243` `[working copy]`); an hour is fine, the file is never load-bearing.
- **Never expire by age alone.** No timeout on the marker itself, at any duration.

The provenance sweep needs the store, which `crates/core` does not have. The clean seam is a supervisor
call at startup — `crates/supervisor` already owns both `workspace_rewinds` and
`WorkspaceLease::recover` — reusing the `sweep_registry()` entry point the in-flight change exposes
(`lease.rs:93-96` `[working copy]`) with a predicate supplied by the caller. That is slice 3.

**One consequence of design A worth restating here:** after A, a marker no longer blocks a session
*start*, because attach acquires nothing. The block moves to `workspace_writable`
(`composer_workspaces.rs:191@462c6bf`), which is store-backed, names the root, and is the same check that
already runs. That is a strict improvement in message quality and an equal guarantee for rewinds. For
**applies**, see the unchecked item below.

---

## 6. Not checked

- **I ran nothing.** No `cargo`, no `npm`, no `tauri`, no app, per the work order. Every claim in §1 and
  §2 is read off the cited lines; the failure itself was not reproduced.
- **The verify-gate and loop-commit collisions (§2) are derived, not observed.** They follow from the
  mode table plus `verify.rs:301@462c6bf` and `loop_/git.rs:96-108@462c6bf`. Nobody has run the loop with
  a terminal open on the worktree.
- **Whether an orphaned apply marker can exist with no matching rewind row.** `workspace_writable` reads
  `workspace_rewinds` only (`checkpoints.rs:114-135@462c6bf`); `block()` is called for applies too. If it
  can, design A opens a narrow window where an apply marker stops blocking a start. §5's provenance sweep
  is the remedy, but the window is unmeasured.
- **The in-flight `lease.rs` rewrite is not final.** I read the working copy at one moment; its line
  numbers and possibly its API will move. Every `[working copy]` citation is provisional. `Mode::Mutate`
  assumes the `take` closure and the ancestor walk survive that rewrite in recognisable form.
- **Cost estimates are line-count guesses**, not diffs. The B estimate in particular is the least
  reliable, because refcounted release interacts with the `Drop` at `lease.rs:248-255@462c6bf` in ways I
  did not work through.
- **Whether `Mode::Mutate` needs the `terminal-desc` exclusive at its own root.** `Exclusive` takes it
  (`lease.rs:134@462c6bf`) to stop a shell opening *below* a running restore. A `Mutate` operation has no
  such claim, so I propose dropping it, but I did not trace whether anything depends on that lock being
  held by a non-destructive writer.
- **Whether two brigadier processes can run at once.** The whole registry is cross-process
  (`lease.rs:1@462c6bf`), and terminal-tab sharing is per-process (`terminal.rs:108-117@462c6bf`), so a
  second app instance would collide with the first's terminals. I did not check whether a second instance
  is possible.
- **bb numbers are second-hand.** Every `[measured]` here is from
  `docs/research/bb-workspace-model-2026-09-11.md`, which ran bb at `fa1f44e`. I re-ran none of it.
- **No UI copy was tested.** The two sentences in §4 are proposals; `src/sessionStartup.ts` is being
  edited by the concurrent worker and I did not read its current shape.
