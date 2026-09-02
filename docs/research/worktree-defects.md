# Worktree defects: what re-measuring changed

Companion to `docs/research/worktree-cleanup.md`. That file is the survey; this one records only
what I ran myself while fixing `docs/STATUS.md` §5 items 1–5 and 7, and it exists because three of
its measurements **contradict the record**.

Tags as in `worktree-cleanup.md`: **[measured]** — run on this machine today, command shown ·
**[documented]** — vendor docs, URL + date · **[asserted]** — reasoning, not verified.

Local git: `git version 2.50.1 (Apple Git-155)`, macOS 26.5 (Darwin 25.5.0), APFS
case-insensitive. Every command ran in a throwaway repository under the session scratchpad with
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null LC_ALL=C GIT_TERMINAL_PROMPT=0`, never in
this repository. Each claim below is also pinned by a test in `crates/core/tests/worktree.rs` or
`crates/supervisor/src/worktree.rs` unless it says otherwise.

---

## 1. Corrections to the record

### 1.1 `git worktree remove` exits 0 over files it left behind **only for a relative argument**

`worktree-cleanup.md` §1.4 and `STATUS.md` §5 item 3 say that in the moved-project state
`git worktree remove` exits 0, unregisters the entry and leaves every file on disk. That is true,
and it is **spelling-dependent**. Same state, four spellings, **[measured]**:

| argument | cwd | result |
| --- | --- | --- |
| `.brigadier/worktrees/w1` (relative) | `-C <moved repo>` | **exit 0**, entry unregistered, `NOTES.md` and `f.txt` still on disk |
| `.brigadier/worktrees/w1` (relative) | `cd <moved repo>` | **exit 0**, same |
| `/private/…/repoJ2/.brigadier/worktrees/w1` (absolute, canonical) | `-C <moved repo>` | `fatal: '…' is not a working tree`, exit 128, nothing touched |
| same absolute path | `cd <moved repo>` | same fatal, exit 128 |

`crates/core/src/worktree.rs::remove` always passes an **absolute** path — the row stores git's own
canonicalised `made.path` — so **brigadier's own call shape does not reach the exit-0 lie by this
route on 2.50.1.** The earlier report did not say which spelling it used. The defence still ships
(the path is `stat`ed after a successful remove, and a `prunable` entry is refused before any
remove is attempted), because the property is a git implementation detail, not a contract, and
because §1.2 below is a second route to the same disagreement.

Also **[measured]**, worth knowing while reading that table: a `/var/folders/…` path and the
`/private/var/folders/…` path it symlinks to are **not** interchangeable here —
`worktree remove` answers `is not a working tree` for the uncanonicalised spelling of a perfectly
healthy worktree. Comparing git's answer to a caller's path is a canonicalisation problem, always.

### 1.2 `remove -f -f` on a real killed `add` can exit **255**, not 0

`worktree-cleanup.md` §1.1 records `git worktree remove -f -f` as "**exit 0** — the only escape"
against a `locked initializing` residue. On a 300-directory / 12,000-file repository, killing the
`git worktree add` **process itself** (not the subshell around it) 80 ms in, **[measured]**:

```
$ git worktree remove --force --force -- wt1
error: failed to delete '…/repoF/wt1': Directory not empty
exit=255
$ git worktree list --porcelain      # the entry is GONE anyway
$ ls wt1                              # d1 d10 d100 … the files are not
$ git branch -D kill1
Deleted branch kill1 (was fce565a).   exit=0
```

So the escape is real but partial: the registry entry and the branch are freed, the directory is
not. Callers must not read exit 0 as "the directory is gone" **or** read a non-zero exit as
"nothing happened". `Prepared::roll_back` deletes the branch regardless of what `remove` answered
for exactly this reason.

The earlier 183 MB run presumably got a fully written index and so a complete delete; the
difference was not investigated. **Not checked**: which of repository size, file count or timing
decides it.

### 1.3 `--exclude=<ref>` for `rev-list --branches` takes the **short** name

Not in the record at all, and the failure is silent and in the unsafe direction. **[measured]**, a
worktree on `brigadier/aaaa1111` holding two commits nothing else reaches:

```
$ git rev-list --count HEAD --not --exclude=refs/heads/brigadier/aaaa1111 --branches --tags --remotes
0            # WRONG — reads as "nothing to lose"
$ git rev-list --count HEAD --not --exclude=brigadier/aaaa1111 --branches --tags --remotes
2            # right
$ git rev-list --count HEAD --not --exclude=refs/heads/brigadier/aaaa1111 --glob=refs/heads --glob=refs/tags --glob=refs/remotes
2            # the full-refname form needs --glob
```

`--exclude` is matched against the name the *next* ref-listing option produces, so `--branches`
wants `refs/heads/` stripped. A wrong prefix does not error; it just stops excluding, and the
branch's own tip then makes the count 0. `commits_only_here_counts_what_no_other_ref_keeps`
(`crates/core/tests/worktree.rs`) pins both spellings so a future edit cannot reintroduce it.

Related and **[measured]**: `--all` is the wrong ref set. An agent that runs `git stash` before it
stops leaves a stash commit whose parent is `HEAD`, so `--all` (which includes `refs/stash`)
reports **0** over work that exists only in a stash. `--branches --tags --remotes` reports 2.
This is `worktree-cleanup.md` §1.17's "stashing removes the dirty-tree guard" appearing a second
time, in the commit count.

---

## 2. New measurements the fix depends on

### 2.1 `repair` before `prune`, in the shape we actually call it

**[measured]**, nested worktree at `<repo>/.brigadier/worktrees/w1`, `mv repo repo2`:

- `git -C repo2 worktree repair` (no paths) → exit 0, **prints nothing**, `gitdir` still stale,
  the entry still `prunable`. The argument-less form is useless for nested worktrees.
- `git -C repo2 worktree repair -- <abs path>` → `repair: gitdir incorrect: …`, exit 0; the entry
  loses `prunable`, and `git -C <wt> status --porcelain` reports the uncommitted `NOTES.md`.
- `--` is accepted, so a checkout directory beginning with a dash is a path and not a flag.
- Mixed batch, one good path and one non-worktree directory → the good one is repaired, then
  `error: not a valid path: …`, **exit 1**. So a batch failure is information, not a stop, and the
  caller must not abandon the prune because of it.
- A path that exists but is not a worktree → `error: unable to locate repository; .git file
  broken`, exit 1. A path that does not exist → `error: not a valid path`, exit 1.
- `repair` on a **healthy** worktree → exit 0, silent. Safe to run unconditionally.

### 2.2 The half-built state, reproduced

Killing the `git worktree add` **process** (`kill -9 $!` on the git pid, not on a wrapping
subshell — kill the subshell and git keeps writing, which produces a different and misleading
result) leaves, **[measured]**:

```
worktree …/wt1
HEAD fce565a…
branch refs/heads/kill1
locked initializing
```

and then `prune -v` → exit 0 silent; `remove` → exit 128 `cannot remove a locked working tree,
lock reason: initializing`; `remove --force` → the same exit 128; `branch -D` → exit 1
`cannot delete branch 'kill1' used by worktree at '…'`. Confirms §1.1 of the survey, except for
the `-f -f` exit code (§1.2 above).

The reasonless form matters too, because the message shape differs: `git worktree lock <path>`
with no `--reason` gives `fatal: cannot remove a locked working tree;` — no `lock reason:` clause
at all. `classify` parses the reason as optional for that.

### 2.3 Submodules

**[measured]**, `git -c protocol.file.allow=always submodule add <local repo> sub`:

| step | result |
| --- | --- |
| `git submodule status` in the main tree | ` 4f87355… sub (heads/main)` — one line; a repo with none prints nothing, exit 0 |
| `git worktree add -b b1 wt1 HEAD` | exit 0 |
| `ls -a wt1/sub` | `.` `..` — **empty** |
| `git -C wt1 status --porcelain` | nothing: the incomplete checkout reads clean |
| `git -C wt1 submodule status` | `-4f87355… sub` (leading `-` = uninitialised) |
| `worktree remove -- wt1` (still uninitialised) | **exit 0** |
| after `submodule update --init`, `worktree remove -- wt1` | `fatal: working trees containing submodules cannot be moved or removed`, exit 128 |
| `worktree remove --force -- wt1` | exit 0 |

`git submodule status` on the main worktree is therefore a sound, cheap detector, and the refusal
after `--init` is categorical rather than a dirtiness check — a clean tree, `dirty_count` 0, and
git still refuses.

### 2.4 Telling a linked worktree from a main one

**[measured]**:

```
main:   rev-parse --show-toplevel = /…/repoI          --git-common-dir = .git
linked: rev-parse --show-toplevel = /…/repoI/wt1      --git-common-dir = /…/repoI/.git
```

`--git-common-dir` is relative from the main tree and absolute from a linked one; joined back onto
the queried directory, its parent equals the toplevel for a main worktree and differs for a linked
one. `--show-toplevel` alone cannot tell them apart, which is precisely why `prepare`'s
`NotRepositoryRoot` guard waved a linked worktree through.

### 2.5 States where `remove` refuses rather than lying

Two states adjacent to §1.1 that git 2.50.1 **validates**, both **[measured]**, both with the
directory present and the absolute path passed:

- worktree directory renamed and a fresh directory put back at the old path →
  `fatal: validation failed, cannot remove working tree: '…/wt1/.git' does not exist`, exit 128;
- the worktree's own `.git` file deleted → the same fatal, exit 128.

So the "exit 0 over a directory it did not touch" behaviour needs the `.git` file to *exist and be
broken*, not to be absent.

---

## What was not checked

- **Windows, and git other than 2.50.1 (Apple Git-155).** Every line above is macOS/APFS on one
  git build. `--exclude`'s prefix rule and the relative-vs-absolute `remove` asymmetry are the two
  most likely to move between versions, and both are pinned by tests that will fail loudly.
- **Why a relative `remove` argument resolves where an absolute one refuses.** Observed, not
  explained; I did not read git's source.
- **What decides whether `remove -f -f` completes or exits 255** on a killed `add` (§1.2).
- **Git LFS**, still not installed on this machine (`command -v git-lfs` → exit 1), so
  `worktree-cleanup.md` §1.16 stands unanswered.
- **Concurrency.** Nothing here measured two processes running `repair`, `prune` or `remove` on one
  repository at once.
- **How long a normal `worktree add` holds `locked initializing`.** Only killed runs were observed,
  so nothing here licenses a sweep that uses the age of that lock as a discriminator.
- **`git worktree repair` when the *checkout* moved but the repository did not** — the survey did
  not measure it and neither did I; ours is the repository-moves-with-worktree case.
