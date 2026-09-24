use crate::{
    Branch, Change, ChangeKind, CollidingPath, DiffStat, Environment, Error, Git, LandBlock,
    LandOutcome, LandRequest, MergeOutcome, Oid, PatchOutcome, RepoState, Result, Snapshot,
    Worktree, WorktreeInfo, WorktreeSpec,
    command::{TempIndex, check, failure, valid_oid, valid_path},
    parse,
};
use std::{
    collections::{BTreeSet, HashMap},
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Output,
    sync::{Arc, Mutex, OnceLock, Weak},
};

/// A repository rooted at the user's supplied checkout, with shared worktree metadata.
#[derive(Debug, Clone)]
pub struct Repo {
    pub(crate) git: Git,
    pub(crate) root: PathBuf,
    pub(crate) common_dir: PathBuf,
}

pub(crate) enum TreeMerge {
    Ready(Oid),
    Conflicts(Vec<String>),
}

impl Repo {
    /// The canonical top-level path of this checkout.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn run<S: AsRef<OsStr>>(&self, args: &[S], read_only: bool) -> Result<Output> {
        self.git.run(Some(&self.root), args, read_only, &[], None)
    }
    pub(crate) fn cmd<S: AsRef<OsStr>>(&self, args: &[S], read_only: bool) -> Result<Vec<u8>> {
        check(args, self.run(args, read_only)?)
    }
    pub(crate) fn index_cmd(&self, index: &TempIndex, args: &[&str]) -> Result<Vec<u8>> {
        let mut command = vec!["-c", "core.splitIndex=false"];
        command.extend_from_slice(args);
        self.git
            .checked(Some(&self.root), &command, false, &index.env(), None)
    }
    pub(crate) fn status(&self, ignored: bool) -> Result<parse::Status> {
        let mut args = vec![
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ];
        if ignored {
            args.push("--ignored=matching");
        }
        parse::status(&self.cmd(&args, true)?)
    }

    /// Query checkout status and local branches with one status and one for-each-ref process.
    pub fn state(&self) -> Result<RepoState> {
        let status = self.status(false)?;
        let bytes = self.cmd(
            &[
                "for-each-ref",
                "--sort=refname",
                "--format=%(refname)%00%(objectname)%00%(worktreepath)%00",
                "refs/heads/",
            ],
            true,
        )?;
        let mut fields = parse::fields(&bytes);
        let mut branches = Vec::new();
        while let Some(name) = fields.next() {
            let name = name.strip_prefix(b"\n").unwrap_or(name);
            if name.is_empty() {
                continue;
            }
            let name = parse::text(name)?
                .strip_prefix("refs/heads/")
                .ok_or_else(|| Error::Parse("unexpected branch ref".into()))?
                .to_owned();
            let commit = parse::oid(
                fields
                    .next()
                    .ok_or_else(|| Error::Parse("missing branch oid".into()))?,
            )?;
            let path = fields
                .next()
                .ok_or_else(|| Error::Parse("missing branch worktree".into()))?;
            let checked_out_at = if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(parse::text(path)?))
            };
            branches.push(Branch {
                name,
                commit,
                checked_out_at,
            });
        }
        Ok(RepoState {
            current_branch: status.branch.clone(),
            head: status.head.clone(),
            branches,
            dirty_files: status.dirty(),
        })
    }

    /// Resolve a revision as a commit, rejecting option injection and non-commit objects.
    pub fn resolve(&self, rev: &str) -> Result<Oid> {
        parse::oid(&self.cmd(
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{rev}^{{commit}}"),
            ],
            true,
        )?)
    }

    pub(crate) fn validate_branch(&self, name: &str) -> Result<()> {
        if name.starts_with('-') || name.contains('\0') {
            return Err(Error::Invalid("invalid branch name".into()));
        }
        let args = ["check-ref-format", "--branch", name];
        let out = self.run(&args, true)?;
        if !out.status.success() || parse::line(&out.stdout)? != name {
            return Err(Error::Invalid(format!(
                "invalid literal branch name: {name:?}"
            )));
        }
        Ok(())
    }

    /// Return a local branch's commit, or None if the branch does not exist.
    pub fn branch_tip(&self, branch: &str) -> Result<Option<Oid>> {
        self.validate_branch(branch)?;
        let name = format!("refs/heads/{branch}");
        let args = [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &name,
        ];
        let out = self.run(&args, true)?;
        match out.status.code() {
            Some(0) => Ok(Some(parse::oid(&out.stdout)?)),
            Some(1) => Ok(None),
            _ => Err(failure(&args, &out)),
        }
    }

    /// A local branch's commit, which must exist. Unlike `resolve`, a tag or other ref with the
    /// same name is never picked instead.
    pub fn branch_commit(&self, branch: &str) -> Result<Oid> {
        self.branch_tip(branch)?
            .ok_or_else(|| Error::Invalid(format!("there is no branch {branch:?}")))
    }

    /// Create a validated new branch at a commit; never replace an existing branch.
    pub fn create_branch(&self, name: &str, start: &Oid) -> Result<()> {
        self.validate_branch(name)?;
        valid_oid(start)?;
        self.cmd(&["branch", "--no-track", "--", name, &start.0], false)?;
        Ok(())
    }

    /// Delete a branch, refusing any branch currently held by a worktree, even with force.
    pub fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        self.validate_branch(name)?;
        let lock = self.landing_lock();
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if self
            .worktrees()?
            .iter()
            .any(|w| w.branch.as_deref() == Some(name))
        {
            return Err(Error::Invalid(format!("branch {name:?} is checked out")));
        }
        self.cmd(
            &["branch", if force { "-D" } else { "-d" }, "--", name],
            false,
        )?;
        Ok(())
    }

    /// Delete a branch only while it still points at `expected`, refusing any branch a
    /// worktree holds.
    pub fn delete_branch_at(&self, name: &str, expected: &Oid) -> Result<()> {
        self.validate_branch(name)?;
        valid_oid(expected)?;
        let lock = self.landing_lock();
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if self
            .worktrees()?
            .iter()
            .any(|w| w.branch.as_deref() == Some(name))
        {
            return Err(Error::Invalid(format!("branch {name:?} is checked out")));
        }
        self.cmd(
            &[
                "update-ref",
                "-m",
                "Brigadier removed a task branch",
                "-d",
                &format!("refs/heads/{name}"),
                &expected.0,
            ],
            false,
        )?;
        Ok(())
    }

    /// Create the new branch `name` at one commit of `patch` on `start` (three-way where the
    /// patch's original files are known), with the user's identity. The patch is applied in a
    /// private index: no checkout changes, and nothing is created unless all of it applies.
    pub fn branch_from_patch(
        &self,
        name: &str,
        start: &Oid,
        patch: &[u8],
        message: &str,
    ) -> Result<PatchOutcome> {
        self.validate_branch(name)?;
        valid_oid(start)?;
        if self.branch_tip(name)?.is_some() {
            return Err(Error::Invalid(format!("branch {name:?} already exists")));
        }
        let index = TempIndex::new()?;
        self.index_cmd(&index, &["read-tree", &start.0])?;
        let args = [
            "-c",
            "core.splitIndex=false",
            "apply",
            "--cached",
            "--3way",
            "--whitespace=nowarn",
            "-",
        ];
        let out = self
            .git
            .run(Some(&self.root), &args, false, &index.env(), Some(patch))?;
        if !out.status.success() {
            let unmerged = self.index_cmd(&index, &["ls-files", "--unmerged", "-z"])?;
            let paths = parse::fields(&unmerged)
                .filter_map(|entry| entry.splitn(2, |&c| c == b'\t').nth(1))
                .map(|path| parse::text(path).map(str::to_owned))
                .collect::<Result<BTreeSet<_>>>()?;
            if paths.is_empty() {
                return Ok(PatchOutcome::Failed {
                    reason: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
                });
            }
            return Ok(PatchOutcome::Conflicts {
                paths: paths.into_iter().collect(),
            });
        }
        let tree = parse::oid(&self.index_cmd(&index, &["write-tree"])?)?;
        let commit = self.commit_tree(&tree, &[start], message, false)?;
        self.create_branch(name, &commit)?;
        Ok(PatchOutcome::Applied { commit })
    }

    /// Whether all commits reachable from local branch `branch` are also reachable from local
    /// branch `into`.
    pub fn is_merged(&self, branch: &str, into: &str) -> Result<bool> {
        self.ancestor(&self.branch_commit(branch)?, &self.branch_commit(into)?)
    }
    pub(crate) fn ancestor(&self, from: &Oid, to: &Oid) -> Result<bool> {
        valid_oid(from)?;
        valid_oid(to)?;
        let args = ["merge-base", "--is-ancestor", &from.0, &to.0];
        let out = self.run(&args, true)?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(failure(&args, &out)),
        }
    }

    /// Capture tracked and non-ignored untracked content in an unreferenced snapshot commit.
    /// The real index, working tree, stash and all refs remain untouched. An unborn dirty
    /// repository cannot supply Snapshot.head and returns Invalid.
    pub fn snapshot_uncommitted(&self) -> Result<Option<Snapshot>> {
        let status = self.status(false)?;
        let files = status.dirty();
        if files.is_empty() {
            return Ok(None);
        }
        let head = status
            .head
            .ok_or_else(|| Error::Invalid("cannot snapshot an unborn repository".into()))?;
        let (_, tree) = self.capture()?;
        let commit = self.commit_tree(&tree, &[&head], "Brigadier uncommitted snapshot", true)?;
        Ok(Some(Snapshot {
            commit,
            head,
            files,
        }))
    }

    pub(crate) fn git_path(&self, name: &str) -> Result<PathBuf> {
        parse::path_line(&self.cmd(
            &["rev-parse", "--path-format=absolute", "--git-path", name],
            true,
        )?)
    }

    pub(crate) fn capture(&self) -> Result<(TempIndex, Oid)> {
        let status = self.status(false)?;
        if status.dirty_submodule {
            return Err(Error::Invalid("commit or discard changes inside submodules before capturing the parent repository".into()));
        }
        if status.unmerged {
            return Err(Error::Invalid(
                "checkout has unresolved index entries".into(),
            ));
        }
        let temp = TempIndex::new()?;
        let index = self.git_path("index")?;
        if index.exists() {
            fs::copy(index, &temp.path)?;
        } else {
            self.index_cmd(&temp, &["read-tree", "--empty"])?;
        }
        // Copying the real index retains staged additions even if they are now ignored.
        // Disable split-index for the private copy so no shared-index files are leaked.
        self.index_cmd(
            &temp,
            &[
                "-c",
                "core.splitIndex=false",
                "update-index",
                "--no-split-index",
            ],
        )?;
        self.index_cmd(
            &temp,
            &["-c", "core.splitIndex=false", "add", "-A", "--", "."],
        )?;
        let tree = parse::oid(&self.index_cmd(&temp, &["write-tree"])?)?;
        Ok((temp, tree))
    }

    pub(crate) fn commit_tree(
        &self,
        tree: &Oid,
        parents: &[&Oid],
        message: &str,
        internal: bool,
    ) -> Result<Oid> {
        valid_oid(tree)?;
        let mut args = vec!["commit-tree", &tree.0];
        for parent in parents {
            valid_oid(parent)?;
            args.extend(["-p", &parent.0]);
        }
        args.extend(["-F", "-"]);
        let env: Environment = if internal {
            ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]
                .map(|key| (key.into(), "Brigadier".into()))
                .into_iter()
                .chain(
                    ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]
                        .map(|key| (key.into(), "brigadier@localhost".into())),
                )
                .collect()
        } else {
            vec![]
        };
        parse::oid(&self.git.checked(
            Some(&self.root),
            &args,
            false,
            &env,
            Some(message.as_bytes()),
        )?)
    }

    /// Create a worktree at the supplied path using a new branch, existing branch or detached HEAD.
    pub fn add_worktree(&self, path: &Path, spec: WorktreeSpec) -> Result<Worktree> {
        let path = absolute(path)?;
        let mut args: Vec<OsString> = vec!["worktree".into(), "add".into()];
        match spec {
            WorktreeSpec::NewBranch { name, start } => {
                self.validate_branch(&name)?;
                valid_oid(&start)?;
                args.extend([
                    "-b".into(),
                    name.into(),
                    "--".into(),
                    path.as_os_str().to_owned(),
                    start.0.into(),
                ]);
            }
            WorktreeSpec::Branch { name } => {
                self.validate_branch(&name)?;
                if self.branch_tip(&name)?.is_none() {
                    return Err(Error::Invalid(format!("branch {name:?} does not exist")));
                }
                args.extend(["--".into(), path.as_os_str().to_owned(), name.into()]);
            }
            WorktreeSpec::Detached { at } => {
                valid_oid(&at)?;
                args.extend([
                    "--detach".into(),
                    "--".into(),
                    path.as_os_str().to_owned(),
                    at.0.into(),
                ]);
            }
        }
        self.cmd(&args, false)?;
        self.git.open_worktree(&path)
    }

    /// Remove a supplied linked worktree and prune stale metadata. Missing paths are idempotent.
    /// The caller must pass only paths in its cleanup ledger. The main checkout is never removed.
    pub fn remove_worktree(&self, path: &Path, force: bool) -> Result<()> {
        let path = absolute(path)?;
        if path == self.root || fs::canonicalize(&path).is_ok_and(|p| p == self.root) {
            return Err(Error::Invalid(
                "cannot remove the repository's own checkout".into(),
            ));
        }
        if path.try_exists()? {
            let registered = self.worktrees()?.iter().any(|w| {
                w.path == path || fs::canonicalize(&w.path).ok() == fs::canonicalize(&path).ok()
            });
            if !registered {
                return Err(Error::Invalid("path is not a registered worktree".into()));
            }
            let mut args: Vec<OsString> = vec!["worktree".into(), "remove".into()];
            if force {
                args.push("--force".into());
            }
            args.extend(["--".into(), path.into_os_string()]);
            self.cmd(&args, false)?;
        }
        self.cmd(&["worktree", "prune", "--expire=now"], false)?;
        Ok(())
    }

    /// List registered worktrees using NUL-delimited porcelain metadata.
    pub fn worktrees(&self) -> Result<Vec<WorktreeInfo>> {
        parse::worktrees(&self.cmd(&["worktree", "list", "--porcelain", "-z"], true)?)
    }

    /// Whether a repo-relative file is ignored (tracked files are not ignored).
    pub fn is_ignored(&self, path: &str) -> Result<bool> {
        valid_path(path)?;
        let args = ["check-ignore", "-q", "--stdin", "-z"];
        let mut input = path.as_bytes().to_vec();
        input.push(0);
        // check-ignore consumes literal paths, not pathspecs, and rejects literal magic.
        let out = self.git.run(
            Some(&self.root),
            &args,
            true,
            &[("GIT_LITERAL_PATHSPECS".into(), "0".into())],
            Some(&input),
        )?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(failure(&args, &out)),
        }
    }

    /// A binary-capable patch between two commits or trees, without external diff programs.
    pub fn diff(&self, from: &Oid, to: &Oid) -> Result<String> {
        valid_oid(from)?;
        valid_oid(to)?;
        Ok(parse::text(&self.cmd(
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--binary",
                "--full-index",
                "--find-renames",
                &from.0,
                &to.0,
                "--",
            ],
            true,
        )?)?
        .to_owned())
    }

    /// Git's per-path numstat, including binary and renamed files.
    pub fn diff_stat(&self, from: &Oid, to: &Oid) -> Result<DiffStat> {
        valid_oid(from)?;
        valid_oid(to)?;
        parse::stat(&self.cmd(
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "-z",
                "--find-renames",
                &from.0,
                &to.0,
                "--",
            ],
            true,
        )?)
    }

    /// Count commits reachable from to but not from from.
    pub fn count_commits(&self, from: &Oid, to: &Oid) -> Result<u32> {
        valid_oid(from)?;
        valid_oid(to)?;
        parse::line(&self.cmd(
            &[
                "rev-list",
                "--count",
                &format!("{}..{}", from.0, to.0),
                "--",
            ],
            true,
        )?)?
        .parse()
        .map_err(|_| Error::Parse("invalid commit count".into()))
    }

    pub(crate) fn tree_changes(
        &self,
        from: &Oid,
        to: &Oid,
        untracked: &BTreeSet<String>,
    ) -> Result<Vec<Change>> {
        valid_oid(from)?;
        valid_oid(to)?;
        parse::changes(
            &self.cmd(
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-status",
                    "-z",
                    "--find-renames",
                    &from.0,
                    &to.0,
                    "--",
                ],
                true,
            )?,
            untracked,
        )
    }
    pub(crate) fn changed_paths(&self, from: &Oid, to: &Oid) -> Result<Vec<String>> {
        let mut paths = BTreeSet::new();
        for change in self.tree_changes(from, to, &BTreeSet::new())? {
            paths.insert(change.path);
            if let ChangeKind::Renamed { from } = change.kind {
                paths.insert(from);
            }
        }
        Ok(paths.into_iter().collect())
    }

    pub(crate) fn symbolic_head(&self) -> Result<Option<String>> {
        let args = ["symbolic-ref", "-q", "HEAD"];
        let out = self.run(&args, true)?;
        match out.status.code() {
            Some(0) => Ok(Some(
                parse::line(&out.stdout)?
                    .strip_prefix("refs/heads/")
                    .ok_or_else(|| Error::Parse("HEAD is not a local branch".into()))?
                    .to_owned(),
            )),
            Some(1) => Ok(None),
            _ => Err(failure(&args, &out)),
        }
    }

    pub(crate) fn busy(&self) -> Result<Option<String>> {
        let dir = parse::path_line(&self.cmd(&["rev-parse", "--absolute-git-dir"], true)?)?;
        for name in [
            "index.lock",
            "HEAD.lock",
            "MERGE_HEAD",
            "rebase-merge",
            "rebase-apply",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
            "BISECT_START",
            "sequencer",
        ] {
            if dir.join(name).try_exists()? {
                return Ok(Some(name.to_owned()));
            }
        }
        Ok(None)
    }

    pub(crate) fn landing_lock(&self) -> Arc<Mutex<()>> {
        static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&self.common_dir).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(self.common_dir.clone(), Arc::downgrade(&lock));
        lock
    }

    /// Land only a fast-forward of the expected tip, serializing landings per common git dir.
    /// Checked-out branches use merge --ff-only --no-autostash --no-overwrite-ignore after
    /// collision/busy checks. Unchecked-out branches use compare-and-swap update-ref.
    pub fn land(&self, request: &LandRequest) -> Result<LandOutcome> {
        self.validate_branch(&request.branch)?;
        valid_oid(&request.expected_tip)?;
        valid_oid(&request.commit)?;
        let lock = self.landing_lock();
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let tip = || {
            self.branch_tip(&request.branch)?
                .ok_or_else(|| Error::Invalid("landing branch no longer exists".into()))
        };
        let actual = tip()?;
        if actual != request.expected_tip {
            return Ok(LandOutcome::Blocked(LandBlock::TipMoved { actual }));
        }
        if !self.ancestor(&request.expected_tip, &request.commit)? {
            return Ok(LandOutcome::Blocked(LandBlock::NotFastForward));
        }
        let holding = self
            .worktrees()?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(&request.branch));
        if let Some(holding) = holding {
            let checkout = Repo {
                root: holding.path.clone(),
                ..self.clone()
            };
            let busy = |what| {
                LandOutcome::Blocked(LandBlock::CheckoutBusy {
                    worktree: holding.path.clone(),
                    what,
                })
            };
            if let Some(what) = checkout.busy()? {
                return Ok(busy(what));
            }
            let changed = self.changed_paths(&request.expected_tip, &request.commit)?;
            let status = checkout.status(true)?;
            let mut paths = Vec::new();
            for (path, kind) in status.entries {
                if changed.iter().any(|p| parse::overlaps(p, &path)) {
                    paths.push(CollidingPath { path, kind });
                }
            }
            paths.sort_by(|a, b| a.path.cmp(&b.path));
            paths.dedup();
            if !paths.is_empty() {
                return Ok(LandOutcome::Blocked(LandBlock::Collisions {
                    worktree: holding.path,
                    paths,
                }));
            }
            if status.unmerged {
                return Ok(busy("unmerged index entries".into()));
            }
            let now = checkout.symbolic_head()?;
            if now.as_deref() != Some(&request.branch) {
                return Ok(LandOutcome::Blocked(LandBlock::BranchSwitched {
                    worktree: holding.path,
                    now,
                }));
            }
            let actual = tip()?;
            if actual != request.expected_tip {
                return Ok(LandOutcome::Blocked(LandBlock::TipMoved { actual }));
            }
            let args = [
                "-c",
                "merge.autoStash=false",
                "merge",
                "--ff-only",
                "--no-autostash",
                "--no-overwrite-ignore",
                "--no-edit",
                &request.commit.0,
            ];
            let out = checkout.run(&args, false)?;
            if !out.status.success() {
                // A post-merge hook can exit nonzero after a successful fast-forward.
                // Never misreport an already-landed commit as a block.
                let actual = tip()?;
                if actual == request.commit {
                    return Ok(LandOutcome::Landed { new_tip: actual });
                }
                if actual != request.expected_tip {
                    return Ok(LandOutcome::Blocked(LandBlock::TipMoved { actual }));
                }
                return Ok(busy(failure(&args, &out).to_string()));
            }
        } else {
            let actual = tip()?;
            if actual != request.expected_tip {
                return Ok(LandOutcome::Blocked(LandBlock::TipMoved { actual }));
            }
            let name = format!("refs/heads/{}", request.branch);
            let args = [
                "update-ref",
                "-m",
                "Brigadier reviewed landing",
                &name,
                &request.commit.0,
                &request.expected_tip.0,
            ];
            let out = self.run(&args, false)?;
            if !out.status.success() {
                let actual = tip()?;
                if actual != request.expected_tip {
                    return Ok(LandOutcome::Blocked(LandBlock::TipMoved { actual }));
                }
                return Ok(LandOutcome::Blocked(LandBlock::CheckoutBusy {
                    worktree: self.root.clone(),
                    what: failure(&args, &out).to_string(),
                }));
            }
        }
        Ok(LandOutcome::Landed {
            new_tip: request.commit.clone(),
        })
    }

    pub(crate) fn merge_tree(&self, left: &Oid, right: &Oid) -> Result<TreeMerge> {
        valid_oid(left)?;
        valid_oid(right)?;
        let args = [
            "merge-tree",
            "--write-tree",
            "--name-only",
            "-z",
            &left.0,
            &right.0,
        ];
        let out = self.run(&args, false)?;
        if !matches!(out.status.code(), Some(0 | 1)) {
            return Err(failure(&args, &out));
        }
        let mut fields = parse::fields(&out.stdout);
        let tree = parse::oid(
            fields
                .next()
                .ok_or_else(|| Error::Parse("merge-tree omitted tree".into()))?,
        )?;
        if out.status.success() {
            Ok(TreeMerge::Ready(tree))
        } else {
            let paths = fields
                .take_while(|s| !s.is_empty())
                .map(|s| parse::text(s).map(str::to_owned))
                .collect::<Result<BTreeSet<_>>>()?;
            Ok(TreeMerge::Conflicts(paths.into_iter().collect()))
        }
    }

    pub(crate) fn replay_tree(&self, base: &Oid, onto: &Oid, tree: &Oid) -> Result<TreeMerge> {
        // Explicit merge-base was added after 2.38. Give two synthetic commits the exact
        // common parent instead, so snapshot-only content is excluded from the worker delta.
        let onto_tree = parse::oid(&self.cmd(
            &["rev-parse", "--verify", &format!("{}^{{tree}}", onto.0)],
            true,
        )?)?;
        let left = self.commit_tree(&onto_tree, &[base], "Brigadier replay target", true)?;
        let source_tree = parse::oid(&self.cmd(
            &["rev-parse", "--verify", &format!("{}^{{tree}}", tree.0)],
            true,
        )?)?;
        let right = self.commit_tree(&source_tree, &[base], "Brigadier replay source", true)?;
        self.merge_tree(&left, &right)
    }

    /// Prepare a fast-forward or a two-parent session merge without touching any checkout/ref.
    /// A separate land call performs the guarded update after approval.
    pub fn prepare_merge(&self, base: &str, branch: &str, message: &str) -> Result<MergeOutcome> {
        let base_tip = self
            .branch_tip(base)?
            .ok_or_else(|| Error::Invalid("base branch does not exist".into()))?;
        let tip = self
            .branch_tip(branch)?
            .ok_or_else(|| Error::Invalid("session branch does not exist".into()))?;
        if self.ancestor(&base_tip, &tip)? {
            return Ok(MergeOutcome::Ready {
                commit: tip,
                base_tip,
                fast_forward: true,
            });
        }
        if self.ancestor(&tip, &base_tip)? {
            return Ok(MergeOutcome::Ready {
                commit: base_tip.clone(),
                base_tip,
                fast_forward: true,
            });
        }
        match self.merge_tree(&base_tip, &tip)? {
            TreeMerge::Conflicts(paths) => Ok(MergeOutcome::Conflicts { paths }),
            TreeMerge::Ready(tree) => {
                let commit = self.commit_tree(&tree, &[&base_tip, &tip], message, false)?;
                Ok(MergeOutcome::Ready {
                    commit,
                    base_tip,
                    fast_forward: false,
                })
            }
        }
    }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    if path
        .components()
        .any(|p| matches!(p, std::path::Component::ParentDir))
    {
        return Err(Error::Invalid("worktree path must not contain ..".into()));
    }
    Ok(path)
}
