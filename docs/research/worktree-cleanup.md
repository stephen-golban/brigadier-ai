# Worktree teardown and cleanup, end to end

What happens to a session's worktree, its branch, and everything else the session left on disk —
including the states nobody designs for. Companion to `docs/research/worktree-git.md`, which
covers creation; this file covers destruction.

Tags: **[measured]** — run on this machine today, command shown · **[source]** — read in code or
a shipped binary, path given · **[documented]** — vendor docs, URL + date · **[asserted]** —
reasoning, not verified.

Local git: `git version 2.50.1 (Apple Git-155)`, macOS 26.5 (Darwin 25.5.0), APFS
case-insensitive. Claude Code `2.1.258` at
`~/.local/share/claude/versions/2.1.258` (a `bun`-compiled binary; `strings` on it is a primary
source and every **[source]** citation below that names it was read that way). Every
**[measured]** command ran in a throwaway repo under the session scratchpad, with
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null LC_ALL=C`, never in this repository.

## 0. What exists today

- `crates/core/src/worktree.rs` — `add`, `add_or_rollback`, `list`, `remove(force)`, `prune`,
  `delete_branch(force)`, `dirty_count`, `ensure_excluded`, `has_commits`, `check_ref_format`.
- `crates/supervisor/src/worktree.rs` — `prepare`, `Prepared::roll_back`, `cleanup`,
  `prune_project`, `exclude_project`.
- `crates/supervisor/src/lib.rs:894` — `cleanup_worktree(session_id, force)`; `lib.rs:955` —
  `prune_worktrees()` runs `git worktree prune` + `ensure_excluded` per project at launch.
- Nothing runs on `end_session` or `kill` (`lib.rs:855`, `lib.rs:864`). Cleanup is one explicit
  IPC call, wired to a button (`src/bridge.ts:133`).
- Three artifact classes exist per session and **only the first has any cleanup path at all**:
  1. the worktree checkout + branch (has `cleanup_worktree`);
  2. brigadier's own `raw/<session_id>.ndjson`, `pids/<session_id>.json`, and the sqlite rows —
     `~/Library/Application Support/ai.brigadier.app/raw` is **66 MB across 23 sessions**
     (~2.9 MB/session) on this machine, and nothing deletes any of it **[measured]**
     (`du -sh`, `ls | wc -l`);
  3. the provider's transcript directory, `~/.claude/projects/<mangled worktree cwd>/`. One
     exists per worktree — e.g.
     `~/.claude/projects/-Users-stephen-Development-brigadier-ai--brigadier-worktrees-73fb34e3`,
     92 KB **[measured]**. There are 332 such directories on this machine totalling **3.0 GB**
     **[measured]**. Deleting the worktree does not touch it, and it is the only copy of the
     conversation the CLI can `--resume` from.

---

## 1. The failure and edge cases a naive implementation misses

### 1.1 Crash mid-`worktree add` — the worst state, and nothing in git recovers from it

`SIGKILL` to `git worktree add` partway through the checkout, three times, in a 183 MB repo
**[measured]**:

```
$ ( git worktree add -b brigadier/kill1 .brigadier/worktrees/kill1 HEAD ) & P=$!
$ perl -e 'select(undef,undef,undef,0.05)'; kill -9 $P
$ git worktree list --porcelain
worktree …/.brigadier/worktrees/kill1
HEAD c9ffacfb…
branch refs/heads/brigadier/kill1
locked initializing              # ← git's own half-built marker
$ git branch --list 'brigadier/*'
+ brigadier/kill1                # ← '+' = checked out in a worktree
```

Every recovery verb refuses **[measured]**:

| command | result |
| --- | --- |
| `git worktree prune -v` | exit 0, **no output** — a locked entry is skipped, and the directory exists anyway |
| `git worktree remove <path>` | `fatal: cannot remove a locked working tree, lock reason: initializing` / `use 'remove -f -f' to override or unlock first`, exit 128 |
| `git worktree remove --force <path>` | **same fatal, exit 128** — one `--force` is not enough |
| `git branch -D brigadier/kill1` | `error: cannot delete branch 'brigadier/kill1' used by worktree at '…'`, exit 1 |
| `git worktree add -b … <same path>` | `fatal: '…' already exists`, exit 128 — and it **leaks its own new branch** on the way out |
| `git worktree remove --force --force <path>` | **exit 0** — the only escape |
| then `git branch -D brigadier/kill1` | `Deleted branch brigadier/kill1 (was c9ffacf).`, exit 0 |

`git worktree unlock <path>` then `git worktree prune` does **not** work **[measured]**: unlock
exits 0, prune then finds the directory present and prunes nothing.

Consequences for the code as written:

- `worktree::remove` passes at most one `--force` (`crates/core/src/worktree.rs:214`), so it
  cannot clear this state. `classify()` has no arm for `cannot remove a locked working tree`, so
  the operator sees an untyped `WorktreeError::Git` with git's raw stderr.
- `Prepared::roll_back` (`crates/supervisor/src/worktree.rs:100`) calls exactly that `remove` and
  then `delete_branch(force=false)`; against a `locked initializing` residue both fail and it
  logs two warnings and moves on, leaving the state permanently.
- `prune_worktrees()` at launch does nothing about it either.

**[asserted]** The `locked initializing` marker is git's honest signal for "a worktree that was
never finished", and it is exactly the marker a startup sweep should look for. It is also a
transient state during every *successful* add, so a sweep must not act on it for a worktree whose
session is live — the age of `.git/worktrees/<id>` or the absence of a live session row is the
discriminator.

### 1.2 The app is killed while a child holds the worktree as `cwd`

Not a git problem on macOS: `unlink`/`rmdir` of a directory that is a live process's cwd
succeeds, so `worktree remove` is not blocked by the child. This was delegated and measured
separately — see §1.13. The real hazard is ordering: **the process must be dead before the
directory goes**, or the agent writes into a deleted inode and its work is unrecoverable.
`docs/research/orphan-sweep.md` §5 already specifies the sweep that kills the process group; the
only addition this file makes is that worktree removal must be *downstream* of that sweep and
must never run in the same pass — see Hard rules.

### 1.3 The user deletes the worktree directory by hand

Two different states, and only one of them is the one already handled.

**(a) `rm -rf <worktree>`, admin dir intact.** Already recorded in `worktree-git.md` §4: the entry
survives as `prunable gitdir file points to non-existent location`, `git worktree prune` clears
it, and the branch survives. `worktree::cleanup` handles this: `!path.exists()` → prune → report
removed. Correct.

**(b) The admin dir is gone but the checkout is not** — `rm -rf .git/worktrees/<id>`, or, far more
commonly, our own startup prune after the project directory was moved (§1.4). **[measured]**:

```
$ rm -rf .git/worktrees/a1
$ git worktree list --porcelain          # only the main worktree; the checkout is invisible
$ git -C .brigadier/worktrees/a1 status --porcelain
fatal: not a git repository: …/.git/worktrees/a1                       exit=128
$ git worktree remove .brigadier/worktrees/a1
fatal: '.brigadier/worktrees/a1' is not a working tree                 exit=128
$ git worktree prune -v                                                exit=0, no output
$ git branch --list 'brigadier/*'
  brigadier/a1                                                         # branch survives, no worktree
$ git worktree add -b brigadier/a1b .brigadier/worktrees/a1 HEAD
fatal: '.brigadier/worktrees/a1' already exists                        exit=128
```

So: a directory full of files that git will neither describe, remove, nor reuse, plus a dangling
branch. The only cleanup is `rm -rf` by the harness, and the only way to know it is safe is that
the harness put it there. Claude Code has a message for precisely this state —
`worktree directory left at ${_} (git no longer recognized it)` **[source]**, strings in the
2.1.258 binary — which is evidence it happens in the field, not just in a lab.

`worktree::cleanup` gets this wrong today: `path.exists()` is true, so it calls `dirty_count`,
which shells `git -C <path> status` into that `fatal: not a git repository` and returns
`WorktreeError::Git`. The operator gets an opaque git error and no button that helps.

### 1.4 The user moves or renames the project directory — and our startup prune makes it permanent

This is the highest-severity finding in this file, because brigadier's own launch path causes the
damage.

A worktree records two absolute paths: `.git/worktrees/<id>/gitdir` points at the checkout's
`.git` file, and the checkout's `.git` file points back at the admin dir **[measured]**. Moving
the project invalidates both. Because our worktrees are *nested inside* the project, one `mv`
breaks every one of them at once.

**[measured]**, `mv repo repo2` with an uncommitted `NOTES.md` in the worktree:

```
$ git worktree list --porcelain
worktree …/edge8/repo2                          # main worktree: new path, fine
…
worktree …/edge8/repo/.brigadier/worktrees/m1   # OLD path
branch refs/heads/brigadier/m1
prunable gitdir file points to non-existent location
```

The two possible orders diverge completely:

| order | outcome |
| --- | --- |
| `git worktree repair <new path>` **first** | `repair: gitdir incorrect: …` exit 0; `gitdir` rewritten to the new path, the checkout's `.git` file rewritten too, `git -C <wt> status --porcelain` → `?? NOTES.md` exit 0. **Fully recovered.** |
| `git worktree prune` first (**what `prune_worktrees()` does today**) | `Removing worktrees/m1: gitdir file points to non-existent location`, exit 0. `.git/worktrees` is now gone. `git worktree repair <path>` → `error: unable to locate repository; .git file does not reference a repository`, **exit 1**, and there is no way back: the state is exactly §1.3(b). |

Two further details, both **[measured]**:

- **Bare `git worktree repair` does not fix a nested worktree.** From the moved main tree it exits
  0, prints nothing, and leaves `gitdir` stale. The new path must be passed explicitly:
  `git worktree repair .brigadier/worktrees/m1`. **[documented]** `git-worktree(1)`,
  https://git-scm.com/docs/git-worktree (fetched 2026-09-02): repair "adjust[s] the `gitdir` file
  in each linked worktree" and, with paths, "adjust[s] the `.git` file … if it is broken". The
  no-argument form only covers worktrees still findable at their recorded locations.
- **In the broken state, `git worktree remove` exits 0 and does nothing useful.** With the
  worktree holding `NOTES.md` and `.env`: `git -c status.showUntrackedFiles=normal worktree
  remove -- .brigadier/worktrees/d1` → **exit 0**, the registry entry gone, and the directory and
  both files still on disk. `worktree::cleanup` would return `removed: true` and the UI would say
  the worktree is gone while it sits there. **The dirty-file safety net is bypassed entirely**,
  because git cannot run `status` against an unreachable admin dir.

**Remedy:** at project open, run `git worktree repair <each path under .brigadier/worktrees/>`
**before** `git worktree prune`, then prune. The paths are knowable two ways — the session rows
and a `read_dir` of `.brigadier/worktrees/` — and passing them is cheap. Doing this in the other
order, which is what ships today, converts a recoverable state into an unrecoverable one on every
launch after the user renames a folder.

### 1.5 The user checks out the brigadier branch in their own terminal

**[measured]**, all four states:

| state | command | result |
| --- | --- | --- |
| worktree live | `git checkout brigadier/b1` in the main tree | `fatal: 'brigadier/b1' is already used by worktree at '…'`, exit 128 — git protects us |
| worktree removed, user checks it out | `git checkout brigadier/b1` | exit 0 |
| …then we clean up | `git branch -d brigadier/b1` | `error: cannot delete branch 'brigadier/b1' used by worktree at '<main tree>'`, exit 1 |
| user leaves it | `git branch -D` after `git checkout main` | exit 0 |

So git refuses branch deletion while a branch is checked out anywhere, main tree included, and
the error names the worktree that holds it. That message is the one to surface verbatim; it tells
the operator exactly where to go. `classify()` has no arm for it today (`cannot delete branch
'…' used by worktree at '…'`).

The inverse also holds and is nastier: **an agent that detaches HEAD inside its own worktree
removes that protection.** **[measured]**: after `git -C <wt> checkout --detach HEAD`, the entry
reads `detached` with no `branch` line, and `git branch -d brigadier/f1` succeeds **exit 0** even
though the worktree still exists. And after `git -C <wt> checkout -b agents-own-branch` plus a
commit, the entry's `branch` is `refs/heads/agents-own-branch` — the session's real work is on a
branch whose name is nowhere in our database, and our "we always keep the branch" guarantee
protects the wrong (empty) ref.

**[measured]** a third variant: `git branch -m brigadier/g1 renamed-by-user` — `git worktree list`
follows the rename automatically (the admin `HEAD` is a symref), and `git branch -d brigadier/g1`
then answers `error: branch 'brigadier/g1' not found`, exit 1.

**Conclusion: every safety decision must read the live `branch` field from
`git worktree list --porcelain`, never the `sessions.branch` column.** The column is a label for
the UI; the porcelain is the fact. Where the two disagree, the worktree is not in the state we
recorded and cleanup should stop and say so.

### 1.6 A worktree nested inside another worktree

Reachable the moment a user points the app at a session worktree as a project — the app permits
it, because `rev-parse --show-toplevel` inside a linked worktree returns that worktree's own root,
so `prepare`'s `NotRepositoryRoot` guard passes. **[measured]**:

```
$ git -C .brigadier/worktrees/outer worktree add -b brigadier/inner .brigadier/worktrees/inner HEAD
exit=0                       # nests at outer/.brigadier/worktrees/inner
$ git worktree remove -- .brigadier/worktrees/outer
exit=0                       # UNFORCED, silent
$ ls .brigadier/worktrees/outer
ls: No such file or directory          # the inner worktree's files went with it
$ git branch --list 'brigadier/*'
+ brigadier/inner                      # still registered, still 'checked out'
```

The inner worktree is a nested repository boundary and `.brigadier/` is in `info/exclude`, so
`status --porcelain --ignored=matching --untracked-files=all` in the outer reports **nothing** —
`dirty_count` returns 0, the harness says "clean, safe to remove", and an unforced removal
destroys another session's uncommitted work in silence.

**Remedy:** refuse to add a project whose root is a linked worktree of a repository brigadier
already manages, or whose path is under any `.brigadier/worktrees/`. Cheap test: compare
`rev-parse --show-toplevel` against `rev-parse --git-common-dir`'s parent — they differ only for
a linked worktree.

### 1.7 Editor and OS artifacts inflate the dirty count

**[measured]** with a `.gitignore` of `node_modules/` and `.DS_Store`:

```
$ git -c status.showUntrackedFiles=normal -C <wt> status --porcelain --ignored=matching -uall
?? .#README.md            # emacs lock symlink
?? .idea/workspace.xml    # JetBrains
!! .DS_Store              # Finder
!! node_modules/
```

Four "changes" and none is work. `dirty_count`'s decision to count ignored entries is right —
`.env` lives there — but the number shown to an operator is not a count of their work. Two of
those four appear merely because a Finder window or an IDE was pointed at the directory, which is
exactly what a user does before deciding whether to keep the worktree.

**Remedy:** report the count in two parts, tracked-modified + untracked, versus ignored, and list
the paths (capped). `git -C <wt> status --porcelain -uno` gives the first for free **[measured]**;
`--ignored=matching -uall` gives the total. A "3 ignored files (node_modules/, .DS_Store) and 0
changes" reads completely differently from "4 files".

### 1.8 A worktree locked by someone else

`git worktree lock` is a public verb and other tools use it — Claude Code locks its own worktrees
with `git worktree lock --reason <…> <path>` and matches the reason against its own process
(`"worktree","lock","--reason"` and the message ` but no worktree lock names this process`
**[source]**, 2.1.258 strings). **[measured]** on a worktree locked with
`--reason "operator is using it"`:

```
$ git worktree remove -- <path>            fatal: cannot remove a locked working tree, lock reason: operator is using it
                                           use 'remove -f -f' to override or unlock first        exit=128
$ git worktree remove --force -- <path>    same fatal                                            exit=128
$ git worktree remove -f -f -- <path>      exit=0
```

`git worktree prune` also skips locked entries **[measured]**, §1.1.

So a single `--force` is not "the answer" the code's doc comment claims it is — there are two
distinct refusals (dirty, locked) and `force=true` only clears the first. And `-f -f` must never
be automatic: the lock is another process's claim on the directory.

### 1.9 An in-progress merge or rebase inside the worktree

**[measured]**: mid-conflict, the admin dir holds `MERGE_HEAD MERGE_MODE MERGE_MSG AUTO_MERGE
ORIG_HEAD`, `status --porcelain` reports `UU README.md`, the unforced remove refuses with
`contains modified or untracked files` exit 128, and `--force` takes it. Safe by accident: the
conflict shows up as dirt. Worth surfacing as its own state though — "this worktree is mid-merge"
is a better sentence than "1 modified file", and `MERGE_HEAD`/`rebase-merge/` in
`.git/worktrees/<id>/` is a one-`stat` test.

### 1.10 A stale `index.lock`

**[measured]**: `touch .git/worktrees/<id>/index.lock` — `status --porcelain` still exits 0, and
`git worktree remove` still exits 0. A killed git leaves this behind and it does not block
teardown. No action needed.

### 1.11 What is left behind after a successful removal

**[measured]** after `git worktree remove --force`:

- `.git/worktrees/<id>/` is fully deleted, and `.git/worktrees/` itself disappears once the last
  linked worktree goes (Claude Code has a message for that moment too: ` after removing its last
  linked worktree` **[source]**).
- `<project>/.brigadier/worktrees/` remains as an empty directory. Cosmetic, but it is inside the
  user's project and it is what they see in Finder. Removing the empty `<id>` parent when it is
  the last one is a two-line `remove_dir` that fails harmlessly if non-empty.
- **The branch's reflog survives the worktree removal** — `git reflog show brigadier/i1` still
  lists `commit: the only copy` and `branch: Created from HEAD` **[measured]**.

### 1.12 What `git branch -D` actually destroys

**[measured]**, the full recovery picture after deleting a branch carrying the only copy of a
commit:

```
$ git branch -D brigadier/i1
Deleted branch brigadier/i1 (was 01b8a80).
$ ls .git/logs/refs/heads/brigadier/     # the branch's reflog file is gone too
$ git reflog | head                      # the MAIN tree's HEAD reflog never mentions it
13d0368 HEAD@{0}: commit (initial): init
$ git cat-file -t 01b8a80                commit          # still there, by sha only
$ git fsck --unreachable                 unreachable commit 01b8a80…
```

So after `-D` there is **no reflog trail at all**: the branch's own reflog is deleted with it, and
the main worktree's HEAD reflog never saw those commits because they were made in another
worktree. Recovery is `git fsck --unreachable` or a sha you wrote down.

The window is bounded and the user controls it. **[documented]** `git-config(5)` (`man git-config`
on this machine, 2026-09-02): `gc.pruneExpire` — `git gc` "will call `prune --expire
2.weeks.ago`"; `gc.reflogExpireUnreachable` "defaults to 30 days"; and `gc.worktreePruneExpire` —
`git gc` "calls `git worktree prune --expire 3.months.ago`". A user who runs `git gc --prune=now`
closes it immediately.

**Remedy, and it costs one column:** record the branch tip sha on the session row before any
branch deletion, and print it in the confirmation and the log line. `Deleted brigadier/abc12345
(was 01b8a80) — recover with git branch <name> 01b8a80` turns an irreversible action into a
reversible one for two weeks, for free.

### 1.13 Submodules

**[measured]**, verified twice (once by a delegated agent, once by me):

```
$ git worktree add -b brigadier/s1 wt1        exit=0
$ ls -a wt1/sub                               .  ..              # EMPTY
$ git -C wt1 status --short                   (nothing)          # and status says clean
$ git -C wt1 submodule status                 -2d3335a5… sub     # leading '-' = uninitialised
```

So a worktree of a repo with submodules is **checked out incomplete and reports clean**. The
agent's build fails for a reason nothing in the UI explains, and `dirty_count` says 0.

Once the agent (or the harness) runs `submodule update --init`, teardown changes shape
**[measured]**:

```
$ git worktree remove -- wt1
fatal: working trees containing submodules cannot be moved or removed     exit=128
$ git worktree remove --force -- wt1                                      exit=0
```

That refusal is **categorical, not a dirtiness check** — it fires on a perfectly clean worktree.
So `worktree::cleanup` would report `dirty_files: 0` and then get an unclassified
`WorktreeError::Git`, i.e. "nothing is wrong and it will not delete". A third `classify()` arm and
a distinct UI sentence ("this worktree has initialised submodules; removing it discards them")
are needed, and `force` here is genuinely just a confirmation.

### 1.14 Sparse checkout

**[measured]** by the delegated agent: a worktree added from a sparse main tree **inherits the
sparsity** — `core.sparseCheckout` is shared repo config and the pattern file is *copied* into
`.git/worktrees/<id>/info/sparse-checkout`. Removal behaves normally. The trap is the same as
submodules: a sparse worktree is missing files and still reports clean, so "clean" is not
"complete", and an agent told to edit a file outside the cone will create it rather than edit it.

### 1.15 Case-insensitive macOS filesystems

Our ids are `[0-9a-f]{8}` (`crates/core/src/worktree.rs:485`), chosen for exactly this reason, so
we are immune — but the failure mode is worth recording because it is much worse than expected and
it constrains any future id scheme.

**[measured]** (mine, confirming a delegated result with one correction):

```
$ git branch brigadier/ABC                    exit=0
$ git branch brigadier/abc
fatal: a branch named 'brigadier/abc' already exists      exit=128   # loose ref file = the guard
$ git pack-refs --all                         # the guard is now a line in packed-refs
$ git branch brigadier/AbC                    exit=0     # ← ACCEPTED
$ git for-each-ref refs/heads --format='%(refname) %(objectname:short)'
refs/heads/brigadier/ABC 0dfcb4b
refs/heads/brigadier/AbC 0dfcb4b              # two refs listed
$ git rev-parse brigadier/ABC brigadier/abc brigadier/AbC
0dfcb4b… 0dfcb4b… 0dfcb4b…                    # every casing resolves to the loose one
$ git branch -d brigadier/ABC
Deleted branch brigadier/ABC (was 0dfcb4b).   exit=0
$ git for-each-ref refs/heads --format='%(refname)'
refs/heads/main                               # BOTH names gone from one delete
```

The loose ref *file* is the only collision guard on APFS, and `git pack-refs` (which `git gc` runs)
removes it. After packing, two branch names differing only in case can coexist in
`for-each-ref`, resolve to one object, and one `-d` deletes both. The delegated agent additionally
reported the two names showing *different* SHAs after packing; I reproduced that only when a
commit landed between the two creations, so state it as: after packing, `for-each-ref` can report
a tip for the packed name that `rev-parse` disagrees with. Either way, **a merged-check computed
from `for-each-ref` on a case-colliding name is a verdict about the wrong commit.**

Worktree *directories* collide the honest way: `git worktree add … N-ABC123` when `N-abc123`
exists fails with `fatal: '…/N-ABC123' already exists`, exit 128, and does not create its branch
**[measured]**, delegated.

### 1.16 `.gitattributes` and LFS — not checked

`git lfs version` → `git: 'lfs' is not a git command`, exit 1; `command -v git-lfs` → exit 1
**[measured]**. git-lfs is not installed on this machine, so **no claim is made** about whether
`git worktree add` succeeds against LFS-tracked files, whether a smudge filter failure leaves a
half-built worktree, or whether LFS pointer files count as dirt. **[asserted]** The shape of the
risk is the same as §1.1: a checkout filter that fails or hangs leaves a `locked initializing`
entry, so the §1.1 remedy covers it whatever the answer. This needs measuring on a machine with
LFS before anyone relies on it.

### 1.17 Stashes made inside a worktree

**[measured]**, delegated: `refs/stash` lives in the **shared** common dir, so a stash pushed
inside a worktree is visible from the main tree, and it survives both `worktree remove` and
`git branch -d` (a stash commit pins its own parents, so the objects stay reachable). `git
worktree remove` issues **no warning** about it.

The sharp edge is the interaction with the safety net: **stashing makes the tree clean, so it
also removes the dirty-tree guard.** An agent that runs `git stash` before it stops leaves a
worktree that `dirty_count` reports as 0, that removes without `--force`, and whose actual work is
in a stash labelled `On brigadier/abc12345` — a branch name that will mean nothing to the operator
a week later. `git -C <wt> stash list` is one cheap call and belongs in the pre-cleanup summary.

### 1.18 Files open in the user's editor, and a live process holding the cwd

**[measured]**, delegated: macOS unlinks a directory that is a live process's cwd.
`git worktree remove` exits **0** while a `sleep` is `cd`'d into the worktree; the process keeps
running with a dangling cwd, and `lsof -a -p <pid> -d cwd` keeps printing the deleted path. There
is no OS-level protection, unlike Windows.

So git will not stop us from deleting the floor under a running agent — the harness is the only
thing that can, and `is_engaged` (`crates/supervisor/src/lib.rs:902`) is currently that check. It
covers *our* children. It does not cover the operator's editor, their shell, or a `cargo watch`
they started by hand, and nothing can. Editor artifacts are the visible symptom (§1.7); the
unrecoverable case is a background build writing into the deleted tree.

---

## 2. Deciding "this work is merged, so it is safe to delete"

All of §2 is **[measured]** by a delegated agent in throwaway repos on git 2.50.1; the
commands and outputs below were reported with exit codes, and I re-derived the C2 and E cases
against my own reading of `git-cherry(1)`. Where I did not personally re-run a case it is marked.

### 2.1 What each command actually proves

| test | proves | lies when |
| --- | --- | --- |
| `git merge-base --is-ancestor <branch> <target>` (exit 0/1) | **exact ancestry**: every commit of `<branch>` is reachable from `<target>` | never in the unsafe direction; says "no" for squash and rebase merges |
| `git branch --merged <target>` | the same ancestry test, as a listing | same blind spots; **and with no argument it silently means `HEAD`** — whatever branch happens to be checked out |
| `git rev-list --count <target>..<branch>` | how many commits the branch has that the target does not | `0` ⇒ safe, always. Non-zero proves nothing |
| `git cherry <target> <branch>` | per-commit **patch-id** was applied on the upstream side at some point | both directions — see §2.3 |
| `git branch -d` | re-runs the ancestry test **at delete time** and refuses if it fails | same blind spots, but it is a refusal, not a deletion |
| `git for-each-ref --contains=<branch>` | which refs contain the branch tip | pure ancestry again |

Measured evidence for the blind spot, a squash merge of one commit:

```
$ git branch --merged main            * main            # branch absent
$ git merge-base --is-ancestor brigadier/abc12345 main  exit=1
$ git rev-list --count main..brigadier/abc12345         1
```

### 2.2 Squash-merge detection

`git branch --merged` never detects a squash merge (measured for both the 1-commit and the
3-commits-into-1 case). `git cherry` gets the one-commit case right (`- 5a36d74 feat one`) and
**gets the important case wrong**: three commits squashed into one upstream commit report

```
$ git cherry -v main brigadier/abc12345
+ 5a36d74b… feat one
+ 1946e921… feat two
+ 09254b55… feat three
```

— three `+`, i.e. "not merged", for work that is entirely in `main`. Patch-id is per-commit, and
an N→1 squash produces no commit with a matching patch-id.

**The test that works** is to collapse the branch to one synthetic commit and then ask `cherry`:

```
MB=$(git merge-base <target> <branch>)
T=$(git rev-parse <branch>^{tree})
FAKE=$(git commit-tree "$T" -p "$MB" -m _)
git cherry <target> "$FAKE"     # '-' = the squash is upstream, '+' = it is not
```

Measured right on all three squash shapes, including when `<target>` has advanced with unrelated
work (where the naive `git diff --quiet <target> <branch>` gives exit 1 and is useless). It
inherits the §2.3 false positive.

`git range-diff <target>...<branch>` is **not** usable as a machine test: the squash case prints
`<` and `>` lines with no pairing, and raising `--creation-factor` makes it pair unrelated
commits (measured: `1: 5b21b3f ! 1: ef270cd` pairing two commits that are not the same change).

### 2.3 Rebase-merge detection, and where patch-id breaks

- **Clean rebase**: patch-ids survive 1:1. `git cherry` reports every commit `-`, `range-diff`
  shows `=`. Ancestry still says "not merged". So `cherry` is right and `--merged` is wrong.
- **Rebase whose conflict was resolved to different content** (or any amend that changed the
  patch): `git cherry` reports `+` — a **false "not merged"**. Every signal fails; the content is
  in `<target>` under a different patch. Nothing detects this, and it is common: a conflicted
  rebase is exactly when the resolution differs.

### 2.4 `git cherry`'s false positive — the case that must never authorize a delete

Upstream applied a change and then reverted it. Measured:

```
$ git cherry -v main brigadier/abc12345
- a46e3665… branch: a=v2 (REAL unmerged work)          exit=0     # '-' = "already upstream"
$ git show main:a.txt                  v1
$ git show brigadier/abc12345:a.txt    v2                          # the work is NOT upstream
```

`git cherry` answers *"was a patch with this patch-id ever applied on the upstream side"*, not
*"is this content in upstream now"*. The synthetic-squash trick of §2.2 inherits the same flaw
(measured: it also reports `-` here). Only a content comparison (`git diff <target> <branch>`)
sees it, and that over-reports whenever `<target>` has unrelated later work.

### 2.5 The integration target is not knowable from git alone

Measured: `git branch --merged main` says not-merged while `git branch --merged develop` lists the
branch. `git branch --merged` with **no argument means `HEAD`** — which, run from a linked
worktree, is that worktree's own branch, so the answer is nonsense. "Merged into anything at all"
is asked the other way round:

```
$ git for-each-ref --contains=brigadier/abc12345 --format='%(refname)' refs/
refs/heads/brigadier/abc12345      # a branch always contains itself
refs/heads/develop
refs/remotes/origin/develop
```

so the test is `count > 1`. Still pure ancestry: it detects neither squash nor rebase.

**[asserted]** This is why "merged" cannot be inferred silently. The harness knows the base ref it
branched from (`BASE` is `HEAD` at creation time, `crates/supervisor/src/worktree.rs:50`) but it
does not know where the operator intends the work to land, and the operator can change their mind.
Record the base sha at creation, ask about the target explicitly, and default the target to the
project's current `HEAD` branch rather than a hardcoded `main`.

### 2.6 The recommended ladder

Cheapest-first, and each rung is a *refusal* rather than an authorization:

1. `git rev-list --count <base>..<branch>` — `0` means the branch has nothing of its own.
   **Sound**: 0 ⇒ nothing to lose, always. Guard the unborn-HEAD exit 128.
2. `git merge-base --is-ancestor <branch> <target>` — exit 0 is proof of a real or ff merge.
3. `git branch -d` (never `-D`) — re-runs (2) at delete time, so a race between the check and the
   delete cannot lose work. **This is the actual safety net**; treat 1 and 2 as UI hints.
4. Only when `-d` refuses: run the synthetic-squash test to say *"this looks squash-merged into
   `<target>`"* in the confirmation dialog, and require the operator to confirm before `-D`.
5. Never conclude "merged" from `git cherry` alone (§2.4).

**[asserted]** Rung 4 is a sentence for a human, not a decision procedure. Given §2.3's
conflicted-rebase false negative and §2.4's false positive, no automatic classifier is correct,
and the cost of being wrong is asymmetric: a leftover branch costs a line in a list, a deleted
branch costs the session.

---

## 3. Detecting and reclaiming orphans

Four disjoint states, each needing a different verb. `git worktree list --porcelain -z` plus the
session rows plus a `read_dir` of `.brigadier/worktrees/` is the full input; each on its own is
blind to at least one state.

| state | how to detect | verb |
| --- | --- | --- |
| **Registered, directory gone** (`rm -rf`, §1.3a) | porcelain says `prunable` | `git worktree prune`, then the branch is deletable |
| **Directory present, admin gone** (§1.3b, §1.4-after-prune) | on disk under `.brigadier/worktrees/` but absent from porcelain | `rm -rf` by the harness; git has no verb |
| **Half-built** (§1.1) | porcelain says `locked initializing` and no session is live | `git worktree remove -f -f`, then `git branch -d` |
| **Registered and healthy, session row gone** (crash between `add` and the row write) | in porcelain with a `brigadier/*` branch, no matching `sessions` row | never automatic — list it, offer cleanup |
| **Branch with no worktree** | `git branch --list 'brigadier/*'` minus porcelain branches | never automatic — list it, offer `-d` |
| **Worktree whose child died** | `pids/<session_id>.json` + the `(pid, pgid, start-time)` match from `orphan-sweep.md` §5 | kill the group, then leave the worktree alone |

### 3.1 What `git worktree prune` does and does not do

**[measured]** (mine and delegated, in agreement):

- It removes **admin entries only**. It never deletes a branch, and it never deletes files: after
  pruning an entry whose `.git` file was deleted, the working directory and its content are still
  on disk with no git registration at all.
- It **skips locked entries silently — with no message even under `-v`**. A worktree that is both
  locked and broken keeps its branch undeleteable forever.
- `--expire` gates on the **mtime of the admin entry**, not on how long the directory has been
  missing. A bare `prune` removes a broken entry immediately regardless of age;
  `--expire=3.months.ago` deliberately skips a seconds-old one. **[documented]** `git-config(5)`:
  `git gc` "calls `git worktree prune --expire 3.months.ago`" via `gc.worktreePruneExpire`.
- While a stale admin entry exists, **`git branch -D` is refused**: `error: cannot delete branch
  '…' used by worktree at '…'`, exit 1. So prune-then-delete is a forced order, not a preference.

### 3.2 The reconciliation pass, and where it must run

`prune_worktrees()` (`crates/supervisor/src/lib.rs:955`) is the right hook and the wrong body. It
should become, per project, in this order:

1. `git worktree repair <each dir under .brigadier/worktrees/>` — §1.4; must be **before** prune
   or the state becomes unrecoverable.
2. `git worktree prune`.
3. `ensure_excluded` (unchanged).
4. Read `git worktree list --porcelain -z`, the session rows, and `read_dir(.brigadier/worktrees)`,
   and classify every discrepancy into the table above. **Report; do not act.**

**[asserted]** Step 4 producing a UI list is the whole design. Every automatic verb in the table
above has a case where it destroys work, and the ones that do not (repair, prune) are exactly the
two that touch no files.

### 3.3 The other two artifact classes

Nothing reclaims them today (§0).

- **`raw/<session_id>.ndjson`**, ~2.9 MB/session **[measured]**. Deletable with the session row,
  and only then. Age-based expiry is the obvious policy and needs an owner decision.
- **`~/.claude/projects/<mangled worktree cwd>/`** — the provider's transcript, and the only thing
  `--resume` can read (`worktree-git.md`, "Measured 2026-09-02"). Deleting the worktree does not
  delete it; deleting *it* silently makes a session unresumable. **[asserted]** It must never be
  automatic, and arguably brigadier should not delete it at all: it is Claude Code's directory,
  keyed on a path we chose, and 3.0 GB of it already exists on this machine from sessions
  brigadier never created.

---

## 4. Prior art

Everything below is **[documented]** (vendor docs/changelog, URL given) or **[source]** (code read
at a named SHA). URLs fetched 2026-09-02. I re-fetched
https://code.claude.com/docs/en/worktrees.md and
https://raw.githubusercontent.com/git-town/git-town/8c5aa88…/internal/git/commands.go myself and
confirmed the quotes; the rest was read by a delegated agent and is cited as it reported.

### 4.1 Claude Code `--worktree` — the closest prior art, and it does not match our provisional decision

Two independent reads agree: the shipped 2.1.258 binary's own strings, and the docs.

**Layout** **[documented]**: `.claude/worktrees/<name>/` at the repository root, branch
`worktree-<name>`; docs recommend adding `.claude/worktrees/` to `.gitignore` (we use
`info/exclude` instead, `worktree-git.md` §1, and that is the better call). Base is
`worktree.baseRef`: `"fresh"` = `origin/<default>` (**the default**), `"head"` = local HEAD. We
use `HEAD` unconditionally.

**Exit-time cleanup** **[documented]**, verbatim from the "Clean up worktrees" section:

> When you exit an interactive worktree session, Claude checks the worktree for work that removal
> would delete: changed or untracked files, and new commits.
>
> - **The worktree is clean**: for an unnamed session, Claude removes the worktree and its branch
>   automatically. A named session prompts you first so you can keep the worktree for later
> - **The worktree has work in it**: Claude prompts you to keep or remove the worktree. Keeping
>   preserves the directory and branch so you can return later. Removing deletes the worktree
>   directory and its branch, along with all the work in them

So the *automatic* delete is gated on **clean + unnamed**, and "clean" explicitly includes **new
commits**, not just working-tree dirt. The tool's own parameter documentation says the same
**[source]** (2.1.258 strings):

> `discard_changes` (optional, default false): only meaningful with `action: "remove"`. If the
> worktree has uncommitted files **or commits not on the original branch**, the tool will REFUSE
> to remove it unless this is set to `true`.

and it counts those commits with `rev-list --count <base>..HEAD` **[source]** — §2.6 rung 1.
Disposition is a two-value enum **[source]**: `"keep"` — "leave the worktree directory and branch
intact on disk"; `"remove"` — "delete the worktree directory and its branch".

**The periodic sweep** **[documented]** is the reference design for §3. It removes worktrees
Claude created for subagents and background sessions once older than `cleanupPeriodDays`
(default 30), and leaves one in place when:

> - The worktree still holds work: changed or untracked files, or unpushed commits.
> - Claude Code can't determine which filter drivers the repository config defines […]
> - The worktree belongs to a `--worktree` session you haven't backgrounded, whatever its age.
> - You created the worktree yourself with `git worktree add` […]

and, critically:

> Claude Code writes a marker into the git metadata of every worktree it creates with git, and the
> sweep keeps any worktree without one […] Before v2.1.246, the sweep didn't check for the marker,
> and could remove a worktree you created yourself when an old background-session record pointed
> at one.

> While an agent is running, Claude Code holds a `git worktree lock` on its worktree so that
> concurrent cleanup can't remove it, and releases the lock when the agent finishes. […] The sweep
> also releases a lock Claude Code set for a session whose process has exited […] **The sweep never
> releases a lock you set yourself with `git worktree lock`.**

Corroborated in the binary **[source]**: `["worktree","lock","--reason",…]`,
`["worktree","unlock",…]`, and the message ` but no worktree lock names this process` — the lock
reason carries the owning process identity, which is how a lock is told from a human's lock.

**`claude rm` / agent view** **[documented]**, https://code.claude.com/docs/en/agent-view — a
deliberate interactive/scripted split:

> - Agent view removes it, including uncommitted changes, so commit what you want to keep first.
> - `claude rm` keeps it, along with the session row, when it has uncommitted changes.
> - Neither […] removes a worktree with **commits Claude Code can't confirm are saved elsewhere**,
>   or one that another running session is using or has locked. Claude Code keeps the worktree and
>   the session, and names the kept directory and the reason.
> - A worktree git no longer recognizes, for example after `git worktree prune`, doesn't block the
>   delete. Claude Code deletes the session and leaves the directory on disk.

That last line is §1.3(b) again, and it is the same resolution I would reach: the directory stays,
the session row goes, and the message says so. The binary carries the matching string
**[source]**: `worktree directory left at ${_} (git no longer recognized it)`.

**Squash detection** **[documented]**, "Reuse a worktree name":

> Claude Code detects the merged case from git state alone: the remote branch the worktree pushed
> to no longer exists, and every commit in the worktree is already on the default branch.

A **two-clause conjunction** — upstream-branch-gone **and** reachability — not a patch-id or tree
comparison. Deliberately conservative: it never guesses "merged" from content.

**Changelog, i.e. the bugs they already paid for** **[documented]**,
https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md:

- **v2.1.143 — "Worktree cleanup no longer falls back to `rm -rf` when `git worktree remove`
  fails, preventing loss of gitignored or in-progress files."** They shipped the obvious fallback
  and it destroyed data.
- v2.1.105 — stale cleanup now removes worktrees whose PR was **squash-merged** instead of keeping
  them indefinitely.
- v2.1.98 — stale cleanup was removing worktrees containing untracked files.
- v2.1.77 — a race where cleanup deleted a worktree just resumed from a crash.
- v2.1.157 / v2.1.187 / v2.1.210 / v2.1.248 — four separate fixes to the lock lifecycle (leaked
  locked `.git/worktrees/` entries from killed agents; locks left by killed sessions; a
  backgrounded session releasing its lock so cleanup deleted the checkout underneath it).
- v2.1.101 — `claude -w <name>` failing with "already exists" after a previous cleanup left a
  stale directory. That is §1.3(b) as a user-visible bug.
- v2.1.208 — Ctrl+X "never destroys unpushed commits, keeps the session row when a worktree is
  kept, and reused worktree names reset to the current base".

**Hooks** **[documented]**, https://code.claude.com/docs/en/hooks. `WorktreeCreate` and
`WorktreeRemove` exist (added v2.1.50). The asymmetry matters: `WorktreeCreate` **replaces** git —
it must print an absolute path, and any non-zero exit aborts creation — while `WorktreeRemove`
**cannot block removal**, has no output contract, and its failures are logged in debug mode only.
Input is `{session_id, transcript_path, cwd, hook_event_name, name}` for create and
`{…, worktree_path}` for remove. Neither carries a branch.

**One landmine we had not considered, and it is a security one** **[documented]**, same page:

> Claude Code skips the repository's own filter drivers when it creates a worktree because a
> filter driver is a shell command, and anything that can write to the repository, including
> Claude, could have put one there. Before v2.1.247, Claude Code ran those drivers during worktree
> creation.

So `git worktree add` executes `.gitattributes` clean/smudge filters defined in the repository's
**own** `.git/config` — arbitrary shell, from a file an agent in a previous session could have
written. The consequence they accept is that LFS files arrive as pointer files
(`git lfs install --local` writes the filter into the repo config), and the cure is `git lfs pull`
inside the worktree. **[asserted]** brigadier runs `git worktree add` with the repo's own config
live, so we inherit this exactly. It also answers §1.16 in part: LFS content will be missing, and
that is a *feature* of neutralizing filters, not a bug to fix.

### 4.2 Conductor — archive as the default verb, snapshot before delete

**[documented]**, https://www.conductor.build/docs and its changelog.

- Archiving **deletes the workspace directory** (archived docs, verbatim via web.archive.org
  2026-04-06: "When you archive a workspace, Conductor deletes the workspace directory").
- **Archive is reversible**: v0.33.5 — "Conductor now automatically saves your git state when you
  archive, including uncommitted files", and "You can now always unarchive a workspace, even if
  the original branch has changed". v0.44.0/v0.49.0 — "Archiving a workspace now saves uncommitted
  changes as a commit."
- **Branch deletion is opt-in and separate**: `git.delete_branch_on_archive`, boolean, in the
  published schema at https://conductor.build/schemas/settings.repo.schema.json. Its default is
  **not verified** (the schema declares none).
- `git.archive_on_merge` — "Archive a workspace automatically when its pull request merges."
- **Delete is an escape hatch, not a peer of archive**: v0.35.3 added "an option to delete
  workspaces that can't be archived. (This can happen if something outside the app renames or
  deletes a workspace's directory or worktree.)" — §1.3/§1.4 again.
- Workspaces live **outside** the repo, at `~/conductor/workspaces/<repo>/<workspace>`; the legacy
  in-repo `.conductor/` layout was abandoned.
- **No `git worktree prune` anywhere in the docs** (25 doc pages + 20 changelog pages grepped,
  zero hits). Orphan recovery is manual: "If restore fails, create a new workspace from the branch
  or pull request."

### 4.3 Crystal — the anti-pattern, and worth reading for that

**[source]**, `stravu/crystal` at SHA `1e18e0bc981225f75b5226f82a300fa741970c6f` (tag 0.3.5).

- Removal is **always `--force` on the first try**, one call site,
  `main/src/services/worktreeManager.ts:178-207`:
  `git worktree remove "${worktreePath}" --force`.
- Creation begins with an **unguarded destructive pre-clean** — `git worktree remove … --force` on
  the target path, errors swallowed (`worktreeManager.ts:90-99`).
- **No git-state check at all**: no `status --porcelain`, no dirty check, no ahead/merged check.
  The only guard is a DB column (`main/src/ipc/session.ts:216-250`).
- **`git worktree prune`: zero hits repo-wide. Branch deletion: zero hits repo-wide.** Every
  archived session leaks its branch permanently.
- The confirmation dialog (`frontend/src/components/SessionListItem.tsx:580-589`) promises
  "Preserve all session history and outputs" and never mentions uncommitted changes or unmerged
  commits.
- One thing it gets right: **no `rm -rf` fallback** when remove fails — it warns
  "⚠ Failed to remove worktree (manual cleanup may be needed)" and stops.

### 4.4 git-town — tree comparison, and pre-sync as the trick that makes it valid

**[source]**, SHA `8c5aa8834c22db5beb0ddb16fe5aa224bdd1bccf`; I re-fetched and confirmed
`internal/git/commands.go:74-77`:

```go
func (self *Commands) BranchHasUnmergedChanges(querier subshelldomain.Querier, branch, parent gitdomain.LocalBranchName) (bool, error) {
	out, err := querier.QueryTrim("git", "diff", "--shortstat", parent.String(), branch.String(), "--")
	return len(out) > 0, gohacks.WrapIfError(err, messages.BranchDiffProblem, branch)
}
```

That is the *whole* predicate. **No `git cherry`, no `patch-id`, no `merge-base --is-ancestor`**
anywhere in the tree. It works because of three surrounding decisions:

1. The parent comes from git-town's **own lineage config**
   (`git config git-town-branch.<name>.parent`), not from git history; no parent ⇒ never delete.
2. **The branch is synced first** — the prune opcode is appended *after* the merge/rebase opcodes
   (`internal/cmd/sync/sync_feature_branch.go:34-58`). This is load-bearing: the parent's commits
   must already be in the branch or the two-dot diff is non-empty for unrelated reasons.
3. It is a **two-dot** diff, i.e. tip-tree vs tip-tree, so it is SHA-agnostic and squash- and
   rebase-merges read as empty. The accepted false positive: a branch that adds X while the parent
   independently removed X also reads empty.

Other details worth stealing: `git town delete` refuses on a **branch checked out in another
worktree** (`internal/cmd/delete.go:245-246`), and on a dirty tree it **commits** rather than
refusing (`ChangesStage` + `CommitWithMessage{"Committing open changes on deleted branch"}`,
`:381-389`) with an `UndoLastCommit` registered in its undo program. Multi-worktree awareness is
one call: `git for-each-ref … worktreepath:%(worktreepath)` (`commands.go:945-960`). **git-town
never removes a worktree directory** — no `git worktree remove` exists in the codebase.

### 4.5 `gh` — no local heuristic, and the best worktree-aware delete path

**[source]**, `cli/cli` at SHA `71eac351e185b08ed5ac679a65bff4a654fae6cd`.

- **There is no `merged` field** in `gh pr view --json` (verified live:
  `Unknown JSON field: "merged"`). Merged-ness is `state == "MERGED"` or `mergedAt != null`.
  `mergeStateStatus` is `UNKNOWN` once merged, so it is **not** a merged-ness signal.
- **Local-branch delete is unconditional `-D`** (`git/client.go:667-678`,
  `["branch","-D",name]`), called from `pkg/cmd/pr/merge/merge.go:504`. Git's `-d` safety is
  deliberately bypassed, precisely because a squash or rebase merge leaves the local head
  un-ancestral. The server's word replaces the heuristic entirely.
- **The worktree handling is the best in this survey** (`merge.go:402-501`) and is directly worth
  copying: it runs `git worktree list --porcelain` plus `git rev-parse --show-toplevel`, then
  branches on *where* the head branch is checked out — current main worktree (switch to base, ff
  pull, delete), current *linked* worktree (**skip**, and print the exact
  `git worktree remove … && git branch -D …` for the user to run), base checked out elsewhere
  (skip with instructions), head in another linked worktree (`git worktree remove -- <path>`
  first, then delete), stale entries `git worktree prune`d along the way, and any inspection error
  → warn and skip.

### 4.6 The rest, briefly

- **git-branchless** **[source]**, SHA `03d6ab8dc1a2ff8a2bc44709b93ea6a9038147eb`. Two stacked
  detectors: libgit2 `git_diff_patchid` over `dag.query_range(merge_bases, dests)`
  (`plan.rs:1324-1392`), pre-filtered by an exact touched-path-set match; then an
  **empty-commit fallback** — after an in-memory apply, `rebased_commit.is_empty()` maps the commit
  to the zero OID (`execute.rs:697-706`), which is what catches the squash merges patch-id misses.
  Remote-tracking refs are refused (`warn!("Not deleting non-local-branch reference")`); the main
  branch is special-cased. Safety comes from an **event log** and `git undo`, not from prediction.
- **git-machete** **[source]**, SHA `c643dc26b94a0cf63fbf124d2a2f1fbff1a3d9bf`. A three-tier
  cascade in `client/base.py:585-613`, mode from `machete.squashMergeDetection` (default `SIMPLE`):
  ancestry + a **filtered reflog** (strips `branch: Created from`, `reset: moving to`, no-op
  rebases, so a non-empty reflog proves the branch actually moved); then **tree hash** — `%T` of
  the tip searched in `git log --format=%T ^<branch> <parent>` (`git.py:1182-1217`); then
  **patch-id**, capped at `MAX_COMMITS_FOR_SQUASH_MERGE_DETECTION = 1000`. Never uses `git cherry`.
- **gh poi** **[source]**, SHA `b2a7d90d32877f9893fbc8636fbe7f9c1e0e429d`. Asks GitHub, then
  checks the local tip is inside the PR: `slices.Contains(pr.Commits, branch.Commits[0])`
  (`cmd/root.go:611-628`) — simultaneously a squash-merge detector and a "no unpushed local work"
  guard. `getDeleteStatus` (`:576-609`) is a **veto chain**: protected branch; worktree locked;
  main worktree while not HEAD; linked worktree that is HEAD; linked worktree with untracked
  files; tracked changes; no associated PRs; any PR still open.
- **git-delete-merged-branches** **[source]**, SHA `dd0c46c7a8842e8f20a8809116b6f1c6163c9087`. The
  cleanest explicit confidence ladder, `--effort 1..3` (default 2, `_cli.py:80-95`): L1
  `git branch --merged` only; L2 adds `git cherry`; L3 adds `git cherry` **on a temporary squashed
  copy** — `git commit-tree -m … -p <merge-base> <topic>^{tree}` (`_git.py:300-311`), i.e. §2.2's
  synthetic-squash trick, found independently. It is the only tool in this survey that **splits
  the delete verb by confidence** (`_engine.py:379-382`): `truly_merged` → `git branch --delete`,
  `defacto_merged` → `--delete --force`.
- **VS Code** **[source]**, `extensions/git/src/{git,commands}.ts`, main branch fetched
  2026-09-02 (no pinned SHA). **No bulk "delete merged branches" command exists** and no
  heuristic: `Git.deleteBranch` is `['branch', force ? '-D' : '-d', name]` (`git.ts:2183-2186`),
  called unforced, and only on `GitErrorCodes.BranchNotFullyMerged` does it prompt "not fully
  merged. Delete anyway?" and retry with force. The entire safety question is delegated to `-d`.
- **JetBrains** **[documented]**, https://www.jetbrains.com/help/idea/manage-branches.html. No
  merged check; deletion is unconditional force. The safety story is **undo, not prediction**:
  "After you have deleted a branch, a notification will be displayed … from which you can restore
  the deleted branch."
- **Graphite** **[documented]**, https://graphite.com/docs/command-reference. `gt sync` prompts to
  delete branches for merged/closed PRs; `-d` skips the prompt. Criterion is PR state from
  Graphite's server-side model; **mechanism not verified** — the CLI is not open source.

### 4.7 What the survey converges on

Three independent "merged" signals, three failure modes:

| signal | mechanism | survives | misses |
| --- | --- | --- | --- |
| reachability | `--merged`, `--is-ancestor` | exact, cheap | any rewrite (squash, rebase, amend) |
| patch id | `git cherry`, `patch-id` | rebase, cherry-pick | N→1 squash; conflict-resolved rebase; §2.4 revert trap |
| tree | `%T` equality, two-dot `diff`, `commit-tree` of `branch^{tree}` | squash merges | partial landings; parent independently reverted |

Machete (SIMPLE→EXACT), gdmb (L1→L2→L3) and branchless (patch-id→empty-commit) each independently
stack them. **Everyone who acts on a content heuristic pairs it with orthogonal state vetoes** —
checked out in any worktree, uncommitted or untracked changes, protected branch, open PR, a live
process — rather than trusting the heuristic. **Nobody solves the branch side well**: Crystal
leaks one per session, `gh` and JetBrains force-delete on the server's word, Conductor makes it
opt-in with an undocumented default, and Claude Code deletes it with the worktree but only when
clean or after an explicit prompt.

And the reversibility point is the strongest single lesson: **Conductor snapshots uncommitted work
to a commit before deleting the directory, and branchless keeps an event log.** A cleanup you can
undo does not need to predict correctly.

---

## 5. Hard rules — what must never be automatic

1. **Never `rm -rf` a worktree because `git worktree remove` failed.** Claude Code shipped that
   fallback and removed it in v2.1.143 for destroying gitignored and in-progress files
   **[documented]**. The one exception is §1.3(b) — a directory git does not recognise at all,
   which brigadier itself created and recorded — and even that should be an explicit click.
2. **Never delete a branch as a side effect of removing a worktree.** They are two decisions, two
   verbs and two confirmations. `git worktree remove` never deletes a branch and neither should we
   **[measured]**.
3. **Never use `git branch -D` without an explicit, specific confirmation that names the tip sha.**
   After `-D` there is no reflog trail at all — the branch's own reflog goes with it and the main
   tree's HEAD reflog never saw those commits **[measured]** §1.12. `-d` first, always.
4. **Never `git worktree remove -f -f` automatically.** The second `--force` overrides a *lock*,
   which is another process's or another person's claim. Claude Code's own sweep "never releases a
   lock you set yourself" **[documented]**.
5. **Never remove a worktree whose session is live, or whose child process is still running.**
   macOS will let us delete the floor under a running agent with exit 0 **[measured]** §1.18; git
   will not stop us and the OS will not either.
6. **Never conclude "merged" from `git cherry` alone.** It reports `+` for an N→1 squash and for a
   conflict-resolved rebase, and `-` for work that upstream applied and then reverted
   **[measured]** §2.2-2.4.
7. **Never run `git worktree prune` before `git worktree repair`.** Prune-first converts a
   recoverable moved-project state into a permanently unrecoverable one **[measured]** §1.4. This
   is a bug in `prune_worktrees()` today.
8. **Never delete `~/.claude/projects/<key>/`.** It is the provider's transcript directory, the
   only thing `--resume` can read, and it is keyed on a path we chose inside a directory we do not
   own. 3.0 GB of it on this machine predates brigadier **[measured]**.
9. **Never act on a worktree brigadier cannot prove it created.** Claude Code deleted users'
   hand-made worktrees until v2.1.246 because a stale session record pointed at one
   **[documented]**. A DB row is not proof; a marker inside `.git/worktrees/<id>/` is.
10. **Never touch a worktree or branch whose live `git worktree list` state disagrees with the
    session row** — a detached HEAD, a different branch, a renamed branch **[measured]** §1.5. Stop
    and report; the state is not the one we recorded.
11. **Never report `removed: true` without confirming the directory is gone.** After a project
    move, `git worktree remove` exits 0, unregisters the entry, and leaves every file in place
    **[measured]** §1.4.
12. **Never write to `.gitignore`, and never `git add`, `git commit`, `git stash` or `git checkout`
    in the operator's main worktree** as part of cleanup. git-town commits open changes before
    deleting a branch; it can, because it owns an undo log and the user typed `git town delete`.
    We have neither.

---

## 6. What this changes about our provisional decision

The provisional decision was: *auto-remove a worktree only after its work is merged and committed;
never on failure or abandonment; anything unmerged survives and is listed in the UI for one-click
cleanup.*

**What survives, strengthened.** The listing-plus-one-click half is right and is what every tool
that has been in the field converges on. So is "never on failure or abandonment": a killed session
is the one most likely to be resumed (`crates/supervisor/src/lib.rs:864` already says so), and
Claude Code's v2.1.77 changelog entry is the bug that follows from getting it wrong. Keeping the
branch unconditionally is right and is *more* conservative than Claude Code, which deletes the
branch with the worktree.

**What changes.**

1. **"Merged" cannot carry the weight the decision puts on it.** §2 shows there is no sound
   automatic classifier: ancestry misses every squash and rebase, patch-id lies in both
   directions, tree comparison false-positives on independent reverts. The honest formulation is
   not "auto-remove when merged" but **"auto-remove only when there is nothing to lose"** —
   `git rev-list --count <base>..<branch> == 0` **and** a clean tree — which is a sound test, is
   one cheap command, and covers the real case (a session that read code and changed nothing).
   Everything else is a listed row with a button. Claude Code reaches the same place by a
   different route: its automatic delete is gated on clean-and-unnamed, and its "merged" heuristic
   is used only to decide whether to *reset* a reused worktree, never to delete work.

2. **"Committed" is not a safe synonym for "saved".** Our unforced remove checks the working tree
   only, so a clean worktree carrying five unpushed commits removes with exit 0 in silence
   (`worktree-git.md` §4 already calls this "the dangerous asymmetry"). Claude Code counts commits
   as work — `rev-list --count <base>..HEAD`, and refuses without `discard_changes` **[source]**.
   `dirty_count` should become a `WorktreeState` carrying tracked-modified, untracked, ignored,
   **commits ahead of base**, stash entries, submodule-initialised, and in-progress-merge — and
   the refusal should name which of them fired.

3. **A third state is needed between "keep" and "remove": snapshot-then-remove.** Conductor's
   archive commits uncommitted work to a ref before deleting the directory and can unarchive it.
   That converts every one of §1's judgement calls into a recoverable action, and it is cheap:
   `git -C <wt> stash create` or a `commit-tree` against the tree, stored under
   `refs/brigadier/archive/<id>`. **[asserted]** This is the single highest-value addition, because
   it makes being wrong survivable — which is the only property that lets anything be automatic.

4. **Cleanup is not one operation, it is a reconciliation pass.** §3's table has six states and
   `cleanup_worktree` addresses one and a half. The launch path needs `repair` → `prune` →
   classify → *report*, and `prune_worktrees()` is actively harmful in its current order (§1.4).

5. **Two safety mechanisms are missing entirely and both are cheap.** A **`git worktree lock`
   with a reason naming our process** for the life of the session — which is both the "don't
   delete a live worktree" guard and the crash marker, and is what Claude Code does **[source]**
   — and an **ownership marker written into `.git/worktrees/<id>/`**, so a stale row can never
   authorize deleting a directory a human made **[documented]**. Note the cost: a lock makes an
   entry invisible to `prune` with no diagnostic even under `-v` **[measured]** §3.1, so taking
   locks obliges us to sweep our own stale ones.

6. **The scope was too narrow.** The decision talks about worktrees and branches. Two other
   artifact classes exist, both unbounded, and neither has any policy: `raw/*.ndjson` at
   ~2.9 MB/session (66 MB already) and the provider transcript directories (3.0 GB on this
   machine) **[measured]** §0, §3.3. The second must never be automatic (Hard rule 8); the first
   needs an owner decision on retention.

7. **`prepare` should refuse two more inputs**: a project root that is itself a linked worktree
   (§1.6 — removing the outer worktree silently destroys the inner session's work while
   `dirty_count` reports 0), and, at minimum with a warning, a repository with submodules (§1.13 —
   the worktree is checked out incomplete, reports clean, and then refuses to be removed).

## What was not checked

- **Git LFS and `.gitattributes` filter drivers, empirically.** git-lfs is not installed here
  **[measured]**. The docs answer the *policy* question (Claude Code neutralizes repo-local filter
  drivers, so LFS content arrives as pointers, §4.1) but I did not run `git worktree add` against
  an LFS repo, did not measure whether a failing smudge filter leaves a `locked initializing`
  entry, and did not check whether brigadier's `worktree add` runs those filters (it does not
  neutralize them, so **[asserted]** it does).
- **Windows.** Every measurement is macOS/APFS. `git worktree remove` while a process holds the
  cwd behaves differently there, and Claude Code has two NTFS-junction bugs on record
  (v2.1.147, v2.1.205).
- **Whether `git worktree repair` fixes a worktree whose *checkout* moved but whose repo did not**
  — I measured only the repo-moves-with-worktree case, which is ours.
- **Two brigadier processes racing on the same repository.** `worktree-git.md` §5 measured 8
  concurrent `worktree add`s with no contention, but nothing here measured concurrent
  `remove`/`prune`/`repair`, and `EXCLUDE_LOCK` is process-wide only
  (`crates/core/src/worktree.rs:396`).
- **Conductor's `git.delete_branch_on_archive` default** — the published schema declares none, and
  no doc states it.
- **Graphite's merged-detection mechanism** — the CLI is not open source.
- **The `locked initializing` window's duration** in a normal, uninterrupted `worktree add`. I
  observed it only in killed runs, so a sweep keyed on it needs a real measurement of how long it
  is held on a large repo before it can safely use age as a discriminator.
- **Whether `claude --resume` survives its transcript directory being deleted**, which is the
  question that decides whether §3.3's retention policy is even possible.

