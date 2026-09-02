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

## Measured 2026-09-02

Everything below ran on `git version 2.50.1 (Apple Git-155)` and Claude Code `2.1.258` while
building the feature. It corrects three things this brief got wrong and settles one open question.

### The open question from §6 is answered: `--resume` works from a worktree cwd

**measured**, one live run of `crates/supervisor/tests/live_worktree.rs` (exit 0, 9.96 s,
`cost_usd_cumulative = 0.003210`). A session started in
`<project>/.brigadier/worktrees/8f9ee795`, completed a turn, was ended, and was resumed with the
same `cwd`. The resumed child came back on the **same** provider session id
(`4f79997c-27c5-4528-8692-18de83629af9`, reported by both children's `session-started`) and
completed a second turn. So the different transcript directory §6 predicts does not break the
resume — the CLI finds the conversation.

**Not checked**: whether the resumed child can still *recall* turn-1 content from a worktree cwd.
The second prompt was `Reply with only the word OK again.`, which does not test recall.
`live_resume.rs` proves recall, but from a project root, not a worktree. The two have not been
combined.

### Corrections

- §7 records `check-ref-format` exiting **1** on a rejected name. That is the
  `git check-ref-format refs/heads/<name>` spelling. With `--branch`, which is what the code uses,
  a rejected name exits **128**: `fatal: 'brigadier/a.lock' is not a valid branch name`
  (**measured**). Nothing reads the code — only success — so this is a documentation fix.
- §3 says an unborn HEAD makes `add … HEAD` fail with `fatal: invalid reference: HEAD`. The
  up-front check this brief recommends, `git rev-parse --verify HEAD`, fails differently:
  `fatal: Needed a single revision`, exit 128 (**measured**). Both are true; they are different
  commands.
- `git rev-parse --git-common-dir` returns a path **relative to the directory `-C` names**, not to
  the repository root: `.git` from the root, `../../.git` from two levels down (**measured**). It
  is only meaningful joined back onto that directory. A plain directory answers
  `fatal: not a git repository (or any of the parent directories): .git`, exit 128, which is what
  `is_repo` reads.

### Decisions taken while building, where this brief was silent

- **The short id is not derived from the session UUID.** It cannot be: the session UUID is minted
  *inside* `ProviderDriver::start_session` (`crates/core/src/claude/driver.rs:164`), which is
  handed the `cwd` — so the worktree must exist before the id does. The supervisor mints its own
  `Uuid::new_v4()` for the worktree and takes its first eight lowercase hex characters. The
  property §7 asks for (ref-safe, case-insensitive-filesystem-safe, eight characters) holds; the
  correspondence to the session id does not.
- **The branch rollback lives in `add_or_rollback`, not in `add`.** `crates/core/tests/worktree.rs`
  pins git's leak as observed behaviour, and that file is worth keeping honest. `add` stays raw;
  `add_or_rollback` is what callers use.
- **Cleanup is explicit only** — nothing on `end_session` or `kill` — which is stricter than §4's
  "default on end/kill: remove the worktree, keep the branch". Reason: resume landed first, and a
  resumed session needs its worktree as `cwd`. §4's branch-keeping rule is kept exactly.
- **The exclude write is guarded by a process-wide `Mutex`, not a lock file.** Two brigadier
  processes opening the same project at the same instant can still interleave. **Not checked**;
  judged acceptable because the read-before-write makes a duplicated line the worst case.
- **A project nested inside someone else's repository attaches to that repository.**
  `rev-parse --git-common-dir` walks up, so `.brigadier/` is excluded in the enclosing repo and
  worktrees are branched off it. **Not checked** against a real nested layout.

### Review round 2 — what §4's cleanup table missed

Four measurements taken while answering a blind review. All on `git 2.50.1 (Apple Git-155)`.

**`git worktree remove` without `--force` deletes ignored files.** §4's table records that an
untracked or a modified tracked file makes the unforced remove refuse, and the man page's "only
clean worktrees (no untracked files and no modification in tracked files) can be removed" reads
like a complete guarantee. It is not: **measured**, a worktree whose only extra content was a
`.env` and a `node_modules/` — both matched by the repository's own `.gitignore` — was removed by
`git worktree remove <path>` with **exit 0, no warning**, and both were deleted.
`git status --porcelain` in that worktree printed nothing, while
`status --porcelain --ignored=matching --untracked-files=all` printed `!! .env` and
`!! node_modules/`. So the harness counts ignored entries as dirt; a count that did not would show
"0 files, safe to remove" over the operator's secrets.

**`status.showUntrackedFiles=no` blinds `--porcelain` *and* git's own remove safety net.**
**measured**, with that config set: a worktree holding a brand-new untracked `NOTES.md` reported
an empty `status --porcelain`, and `git worktree remove` without `--force` exited **0** and
deleted the file. With `-c status.showUntrackedFiles=normal` on the same remove, git refuses —
`fatal: '…' contains modified or untracked files, use --force to delete it`, exit 128 — and the
file survives. The flag is now passed on both the status call and the remove call. A setting in
someone's `~/.gitconfig` is not permission to delete their work.

**`git branch -d` is the right rollback verb, not `-D`.** **measured**: `-d` on a branch created at
`HEAD` and never committed to deletes it (`Deleted branch brigadier/fresh (was 91a9aa2).`, exit 0),
while `-d` on a branch carrying one commit refuses (`error: the branch 'brigadier/work' is not
fully merged`, exit 1) and the branch survives. That is exactly the discrimination the rollback
wants, and it holds even if the `BranchExists` stderr classification ever misses — which it can,
because those matches are substrings of English text. Both rollback paths now use `-d`, and every
git invocation runs under `LC_ALL=C` so a translated gettext build cannot defeat `classify`.

**A project root below the repository root produces a whole-repo checkout.** **measured**:
`git worktree add` run against `<repo>/apps/web` creates a checkout of the entire repository whose
**top level is the new path**, so a session that was meant to run in `apps/web` runs at the
repository root instead, two levels away, with nothing saying so. `git rev-parse --show-toplevel`
distinguishes the two cases, and `prepare` now refuses with a message naming the repository root.

`--` before a path argument parses fine in `worktree add`, `worktree remove` and `status`
(**measured**, including `worktree add -b dash -- -weird HEAD`, which creates `./-weird` and still
reads the base after it), and is now passed so a checkout directory beginning with a dash cannot be
read as a flag.
