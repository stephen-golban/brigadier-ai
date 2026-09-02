# One git worktree per session

Brief for the build order: a new session gets branch `brigadier/<short-id>` and a worktree at
`<project>/.brigadier/worktrees/<short-id>/`; the child's `cwd` is that path; the sidebar shows the
branch; end/kill offers cleanup.

Local git: **`git version 2.50.1 (Apple Git-155)`** (measured). Every `measured` line ran on that
binary in throwaway scratchpad repos. Claude Code here is `2.1.258`.

## Sources

- `git-worktree(1)`, https://git-scm.com/docs/git-worktree — fetched 2026-09-02. **documented**
- `gitignore(5)`, https://git-scm.com/docs/gitignore — fetched 2026-09-02. **documented**
- `crates/core/src/worktree.rs` — built, tested, currently called by nothing.
- `crates/store/src/schema.rs`, `crates/store/src/writer.rs:529-557`, `crates/supervisor/src/lib.rs:284-356`,
  `crates/core/src/driver.rs:157-172`, `docs/plans/ipc-contract.md:86-89`, `src/components/Sidebar.tsx`.

Not checked: Windows, submodules, `core.worktree`/`GIT_WORK_TREE` overrides, sparse checkout,
repos where `.git` is already a file (a worktree inside a worktree), git older than 2.50.

## 1. A worktree nested inside the main working tree

**measured** — `git worktree add -b brigadier/abc123 .brigadier/worktrees/abc123 HEAD` creates the
intermediate directories and writes a `.git` **file** holding
`gitdir: /…/proj/.git/worktrees/abc123` (**documented**: "These settings are made in a `.git` file
located at the top directory of the linked worktree"). Git treats it as a nested repository and
stops at the boundary — `git status --porcelain` in the main tree reports `?? .brigadier/`, and
`-uall` reports `?? .brigadier/worktrees/abc123/` without recursing.

The hazard is `git add -A` in the main tree, which an agent runs constantly (**measured**):

```
$ git add -A
warning: adding embedded git repository: .brigadier/worktrees/abc123
$ git ls-files -s | grep brigadier
160000 d7496b85fac3ad58a83d28a0db026836b98aa6e6 0	.brigadier/worktrees/abc123
```

Mode `160000` is a gitlink — a bogus submodule entry that would get committed. An ignore rule is
therefore **required**, not cosmetic.

### Ignore-rule decision: `.git/info/exclude`

Both **measured**: with `.brigadier/` in `.git/info/exclude`, `git status --porcelain` is empty and
`git add -A` leaves the tree clean. With a `.gitignore` instead, status reports `?? .gitignore` —
the harness has dirtied a file under the user's version control, and where `.gitignore` is already
tracked it would be editing a committed file behind their back.

**documented** (gitignore): patterns "specific to a particular repository but which do not need to be
shared … should go into the `$GIT_COMMON_DIR/info/exclude` file." `$GIT_COMMON_DIR` resolves to the
*main* `.git` from inside a linked worktree, so one line covers every worktree.

**Decision: append `.brigadier/` to `$GIT_COMMON_DIR/info/exclude`, idempotently, at project-add
time.** The trailing slash matters: **documented**, "If there is a separator at the end of the
pattern then the pattern will only match directories." The exclude file is local and never cloned,
which is correct — a clone has no `.brigadier/` either.

## 2. What the new worktree contains

**measured** — main tree carried `M README.md`, `?? .env`, `?? node_modules/`,
`?? .claude/settings.local.json`, `?? NOTES.md`. After `worktree add`, `find . -not -path './.git*'`
in the worktree lists exactly `./.claude/settings.json`, `./CLAUDE.md`, `./README.md`;
`git status --porcelain` there is empty; and `README.md` holds the committed text, not the main
tree's edit. Committed files only. A session in a fresh worktree is missing, in rough order of pain:

| missing | consequence | mitigation and its cost |
| --- | --- | --- |
| `.env`, gitignored secrets | app/tests cannot run | copy a configured allow-list after `add`: one config field + a copy loop |
| `node_modules/`, `target/`, `.venv/` | first build is a cold install | symlink from the main tree: cheap, but two worktrees sharing one `target/` fight over the cargo lock |
| `.claude/settings.local.json` | local allow-list lost, so more approval prompts | copy the one file: trivial, and arguably correct *not* to in a supervised harness |
| uncommitted `CLAUDE.md`, work in progress | agent works from a stale spec | none — say so in the UI, or offer "commit first" |

Recommendation for the first build order: **copy nothing, surface it.** The New Session UI says the
worktree starts from `HEAD` and lists the main tree's dirty paths. Add the allow-list copy later.

## 3. `add`: base ref, dirty main tree, unborn HEAD

- **Base should be `HEAD`.** **measured** — with the main tree detached, `add -b brigadier/d1 … HEAD`
  succeeds; both worktrees report the same sha and the new one is on `refs/heads/brigadier/d1`. A
  named base works too, but only because `-b` makes a *new* branch: **measured**,
  `git worktree add <path> main` with `main` checked out fails with
  `fatal: 'main' is already used by worktree at '…'`. `HEAD` sidesteps that and is what the operator
  means by "branch off what I am looking at".
- **Uncommitted changes are not carried over.** **measured**, §2 above.
- **Unborn HEAD (`git init`, zero commits): `add … HEAD` fails.** **measured**:

  `fatal: invalid reference: HEAD`, exit 128; `git branch -a` is empty afterwards, so nothing leaks
  and no directory is created. Omitting the base succeeds instead: **measured**,
  `No possible source branch, inferring '--orphan'` → exit 0, empty worktree. **documented**: with no
  `<commit-ish>` and no valid local branches "the new worktree is associated with a new unborn
  branch … as if `--orphan` was passed." An orphan worktree shares no history with the project.
  **Recommendation: detect the unborn case up front (`git rev-parse --verify HEAD`) and refuse with
  "commit something first" rather than silently orphaning.**

## 4. Cleanup

All **measured** in one repo:

| action | result |
| --- | --- |
| `worktree remove <path>`, untracked file present | `fatal: '…' contains modified or untracked files, use --force to delete it`, exit 128 |
| `worktree remove <path>`, modified tracked file | same fatal, exit 128 |
| `worktree remove <path>`, clean tree, **unmerged commits on the branch** | **exit 0, silent** — worktree gone, branch kept |
| `git branch -d brigadier/r1` (unmerged) | `error: the branch 'brigadier/r1' is not fully merged`, exit 1 |
| `git branch -D brigadier/r1` | `Deleted branch brigadier/r1 (was 3668b60).`, exit 0 |
| `rm -rf <path>` then `git worktree list --porcelain` | entry still listed, `prunable gitdir file points to non-existent location` |
| `git worktree prune -v` | `Removing worktrees/p1: …`, exit 0; **branch survives the prune** |

**documented** (git-worktree): "Only clean worktrees (no untracked files and no modification in
tracked files) can be removed."

The dangerous asymmetry: `remove` protects *working-tree* dirt but **not commits**. An agent that
committed its work leaves a clean worktree whose deletion is silent, and all the value is in the
branch.

### Cleanup policy (recommendation)

**Default on end/kill: remove the worktree directory, keep the branch. Never delete a branch without
an explicit click.** The worktree is a reconstructible checkout; the branch is the only copy of the
agent's work. If `remove` returns `Dirty`, do **not** auto-`--force` — offer "discard N uncommitted
changes and remove", with N from `git -C <worktree> status --porcelain`, and leave the worktree
alone until the operator answers. Offer branch deletion only from a separate affordance, trying
`-d` first: exit 1 with `not fully merged` is the cue for a second confirmation before `-D`.

At app start, `git worktree prune` per project (safe — never touches branches), then reconcile
`git worktree list --porcelain` against `sessions.worktree_path` and mark orphans in the UI.

## 5. Failure atomicity and concurrency

**The branch leak is real on 2.50.1.** **measured**:

```
$ mkdir -p .brigadier/worktrees/leak && echo occupied > .brigadier/worktrees/leak/x
$ git worktree add -b brigadier/leak .brigadier/worktrees/leak HEAD
Preparing worktree (new branch 'brigadier/leak')
fatal: '.brigadier/worktrees/leak' already exists
exit=128
$ git branch --list 'brigadier/*'
  brigadier/leak          # leaked
```

Git prints "Preparing worktree (new branch …)" *before* it validates the path. An existing but
**empty** directory is fine (**measured**, exit 0).

Cheapest recovery: in `worktree::add`, on any error from the `add` invocation, fire
`delete_branch(git, repo, &spec.branch, /*force=*/true)`, ignore its result, and return the original
error. `-D` is safe because the branch was created microseconds earlier by this same call and points
at `base`. Skip it for `BranchExists`, where the branch was not ours.

The unborn-HEAD failure (`fatal: invalid reference: HEAD`) matches none of `classify()`'s substrings
and degrades to `WorktreeError::Git` — correct, but unhelpful as a UI message.

**No lock contention.** **measured** — 8 `git worktree add` processes in parallel against one repo:
all 8 exit 0; `worktree list` shows 9 rows, 8 branches, 8 directories. A second round of 8 run
concurrently with three `worktree list --porcelain -z` calls: no failures, 17 rows. Two sessions per
project is far inside this.

One real collision remains: **D/F conflict on the ref namespace.** **measured** — with a branch
literally named `brigadier`, `git worktree add -b brigadier/x …` fails with
`fatal: cannot lock ref 'refs/heads/brigadier/x': 'refs/heads/brigadier' exists`. Detect and report;
do not retry.

## 6. Claude Code with `cwd` = worktree

- `CLAUDE.md` and `.claude/` are **committed**, so both are present in the worktree (**measured**,
  §2). An *uncommitted* `CLAUDE.md` is not, and `.claude/settings.local.json` is gitignored in most
  repos and so is not either.
- **Transcript directory** (**measured** by static inspection of the shipped 2.1.258 binary): the
  project key is `cwd.replace(/[^a-zA-Z0-9]/g, "-")`, truncated at 200 chars with a `-<hash>` suffix
  beyond that, under `<configHome>/projects`. Cross-checked against the live directory: 316 entries,
  all of the form `-Users-stephen-Development-…`. So `<project>/.brigadier/worktrees/abc123` gets a
  **different** key from the project root (the leading `.` becomes `-`): a worktree session has its
  own transcript directory, and resuming it from the repo root would not find it. Flagged only;
  resume is another worker's brief.

## 7. Short-id safety

**Nothing mints a short id today** — `worktree.rs` takes `WorktreeSpec { branch, path }` as caller
strings, and `session_id` is a full `Uuid::new_v4()` string (`crates/core/src/session.rs:161`). A raw
v4 UUID is ref-legal but makes a 36-char branch name and an ugly path.

**measured** with `git check-ref-format refs/heads/brigadier/<id>`:

| id | verdict |
| --- | --- |
| `abc123`, `3f9a2b1c`, `01K5X7`, `9f8e7d6c5b4a`, `AbCdEf`, `u_1`, `sess-2026-09-02` | OK |
| `a.lock`, `.hidden`, `a..b`, `trail.`, `with space`, empty | REJECTED (exit 1) |

Recommendation: the **first 8 lowercase hex chars of the session UUID** (`[0-9a-f]{8}`). Ref-safe by
construction, filesystem-safe on case-insensitive APFS/HFS+ (which is why lowercase-only), and short
enough to read in a sidebar. Still call `check-ref-format` before `add` as a cheap assertion, and
treat an already-existing directory as the collision signal.

## Gaps — one line each, by file

- `crates/core/src/worktree.rs` — add: `delete_branch` on any `add` failure except `BranchExists`;
  an `ensure_excluded(repo, pattern)` helper writing `$GIT_COMMON_DIR/info/exclude` idempotently; a
  `has_commits(repo)` check so unborn HEAD is a typed error, not `WorktreeError::Git`; a short-id
  minter + `check-ref-format` guard. Signatures otherwise stand.
- `crates/core/src/driver.rs:157-172` — `StartSession` carries only `cwd`; the supervisor computes
  the worktree, so no change is strictly required.
- `crates/supervisor/src/lib.rs:284-356` — `start_session` sets `cwd = req.cwd` and never touches
  git; needs worktree creation before `driver.start_session`, `row.worktree_path`/`row.branch`
  populated, and rollback of the worktree if the driver fails to start.
- `crates/supervisor/src/lib.rs` (teardown path) — nothing offers cleanup on `end_session`/`kill`;
  needs a `cleanup_worktree(session_id, force)` API returning the dirty-file count.
- `crates/store/src/schema.rs` — **no change**: `sessions.worktree_path` and `sessions.branch`
  already exist in migration 0, and `SessionRow`/`SessionRecord` already carry them. No migration.
- `crates/store/src/writer.rs:529-557` — **no change**: the upsert already COALESCEs both columns.
- `src-tauri/src/views.rs:84-113` — `SessionView` drops `worktree_path`/`branch`; add both fields.
- `src-tauri/src/commands.rs` — add a `cleanup_worktree` command; `start_session` needs no new args.
- `docs/plans/ipc-contract.md:86-89` — `SessionView` line lacks `branch`/`worktree_path`; the
  command table lacks `cleanup_worktree`.
- `src/wire.ts:228-241` — mirror the two new `SessionView` fields.
- `src/feedStore.ts:50,191,438` — `SessionRuntime` tracks `cwd` only; add `branch`.
- `src/mock.ts:138` — the browser mock must return the new fields or the contract diverges.
- `src/components/Sidebar.tsx:96-100` — the session row renders id + cost; add the branch.
- `src/components/NewSession.tsx` — surface "starts from HEAD; N uncommitted files stay behind".

## Risks

1. **Silent data loss.** `worktree remove` on a clean tree with unmerged commits exits 0 without a
   word. Any UI that says "cleanup" must not reach `git branch -D` on the same click.
2. **The gitlink.** Without the exclude rule, one `git add -A` by an agent in the main tree commits
   a 160000 entry that is hard to explain and annoying to unpick.
3. **Branch leak on failed `add`** — reproduced above; leaves one dead branch per failed start
   until `add` rolls back.
4. **Shared build artifacts.** Symlinking `target/` or `node_modules/` across worktrees is the
   obvious speedup and the obvious source of two agents corrupting one cargo lock. Do not do it in
   the first build order.
5. **Transcript directory diverges from the project root** (§6), so anything keyed on
   `~/.claude/projects/<key>` must be keyed on the *worktree* cwd once this lands.
6. **The exclude file is a shared resource.** Appending to `$GIT_COMMON_DIR/info/exclude` from two
   concurrent session starts can interleave; do it once at project-add time, under a lock, and
   read-before-write.
