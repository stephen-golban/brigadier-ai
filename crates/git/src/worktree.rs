use crate::{
    Change, ChangeKind, CollisionKind, CommitOutcome, Error, Oid, PrepareOutcome, RebaseOutcome,
    Repo, Result,
    command::{TempIndex, valid_oid, valid_path},
    parse,
    repo::TreeMerge,
};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// A Brigadier-created task/session checkout. Mutating operations require an idle worker.
#[derive(Debug)]
pub struct Worktree {
    repo: Repo,
    // Preparation stages the merged tree so previously tracked ignored additions stay visible.
    // Retain worker-origin provenance for the litter guard despite the engine's staging.
    prepared: Mutex<Option<Prepared>>,
}

#[derive(Debug)]
struct Prepared {
    head: Oid,
    known: BTreeSet<String>,
    untracked: BTreeSet<String>,
}

impl Worktree {
    pub(crate) fn new(repo: Repo) -> Self {
        Self {
            repo,
            prepared: Mutex::new(None),
        }
    }

    /// Canonical checkout path.
    pub fn path(&self) -> &Path {
        &self.repo.root
    }

    /// Current HEAD commit; an unborn checkout is an error.
    pub fn head(&self) -> Result<Oid> {
        self.repo.resolve("HEAD")
    }

    fn untracked(&self) -> Result<BTreeSet<String>> {
        let mut untracked = self.repo.status(false)?.untracked();
        if let Some(prepared) = &*self.prepared.lock().unwrap_or_else(|e| e.into_inner())
            && prepared.head == self.head()?
        {
            untracked.retain(|p| !prepared.known.contains(p) || prepared.untracked.contains(p));
            untracked.extend(prepared.untracked.iter().cloned());
        }
        Ok(untracked)
    }

    /// All net worker changes against base, including intermediate commits and untracked files.
    pub fn changes(&self, base: &Oid) -> Result<Vec<Change>> {
        valid_oid(base)?;
        let untracked = self.untracked()?;
        let (_, tree) = self.repo.capture()?;
        self.repo.tree_changes(base, &tree, &untracked)
    }

    /// Fold all worker content since base onto onto before inclusion selection and review.
    /// Conflicts are computed with merge-tree first and leave HEAD, index and files untouched.
    /// A snapshot base subtracts the user's original uncommitted content from the worker delta.
    pub fn prepare_candidate(&self, base: &Oid, onto: &Oid) -> Result<PrepareOutcome> {
        valid_oid(base)?;
        valid_oid(onto)?;
        self.ensure_idle()?;
        let original_head = self.head()?;
        let untracked = self.untracked()?;
        let (index, tree) = self.repo.capture()?;
        match self.repo.replay_tree(base, onto, &tree)? {
            TreeMerge::Conflicts(paths) => Ok(PrepareOutcome::Conflicts { paths }),
            TreeMerge::Ready(merged) => {
                let changes = self.repo.tree_changes(onto, &merged, &untracked)?;
                self.install(&index, &tree, &merged, &original_head, onto, &merged)?;
                *self.prepared.lock().unwrap_or_else(|e| e.into_inner()) = Some(Prepared {
                    head: onto.clone(),
                    known: changes.iter().map(|c| c.path.clone()).collect(),
                    untracked,
                });
                Ok(PrepareOutcome::Prepared { changes })
            }
        }
    }

    fn ensure_idle(&self) -> Result<()> {
        if let Some(what) = self.repo.busy()? {
            return Err(Error::Invalid(format!("worktree is busy: {what}")));
        }
        Ok(())
    }

    // Install only paths changed by the replay. read-tree's two-tree checkout protects against
    // edits since capture. Hold the real index lock across the checkout/ref/index transaction;
    // build both indexes first and use CAS for HEAD. Ignored files receive explicit protection.
    fn install(
        &self,
        index: &TempIndex,
        old_tree: &Oid,
        new_tree: &Oid,
        old_head: &Oid,
        new_head: &Oid,
        index_tree: &Oid,
    ) -> Result<()> {
        let changed = self.repo.changed_paths(old_tree, new_tree)?;
        for (path, kind) in self.repo.status(true)?.entries {
            if kind == CollisionKind::Ignored && changed.iter().any(|p| parse::overlaps(p, &path)) {
                return Err(Error::Invalid(format!(
                    "replay would overwrite ignored path {path:?}"
                )));
            }
        }
        let next_index = TempIndex::new()?;
        self.repo
            .index_cmd(&next_index, &["read-tree", &index_tree.0])?;
        let index_path = self.repo.git_path("index")?;
        let lock_path = index_path.with_file_name("index.lock");
        let mut lock_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)?;
        let lock = IndexLock::new(lock_path);
        lock_file.write_all(&fs::read(&next_index.path)?)?;
        lock_file.sync_all()?;
        drop(lock_file);
        if self.head()? != *old_head {
            return Err(Error::Invalid(
                "worker HEAD moved during preparation".into(),
            ));
        }
        self.repo
            .index_cmd(index, &["read-tree", "-m", "-u", &old_tree.0, &new_tree.0])?;
        let update = self.repo.cmd(
            &[
                "update-ref",
                "-m",
                "Brigadier candidate preparation",
                "HEAD",
                &new_head.0,
                &old_head.0,
            ],
            false,
        );
        if let Err(error) = update {
            self.repo
                .index_cmd(index, &["read-tree", "-m", "-u", &new_tree.0, &old_tree.0])?;
            return Err(error);
        }
        if let Err(error) = lock.publish(&index_path) {
            self.repo
                .cmd(&["update-ref", "HEAD", &old_head.0, &new_head.0], false)?;
            self.repo
                .index_cmd(index, &["read-tree", "-m", "-u", &new_tree.0, &old_tree.0])?;
            return Err(error.into());
        }
        Ok(())
    }

    /// Stage exactly the selected changes and run a normal commit, using repository hooks and
    /// git-config identity. Selecting a rename includes its source deletion. Exclusions remain
    /// uncommitted; hook failures return output and never claim a candidate was committed.
    pub fn commit_candidate(&self, include: &[String], message: &str) -> Result<CommitOutcome> {
        self.ensure_idle()?;
        let parent = self.head()?;
        let changes = self.changes(&parent)?;
        let mut paths = BTreeSet::new();
        for path in include {
            valid_path(path)?;
            let change = changes.iter().find(|c| &c.path == path).ok_or_else(|| {
                Error::Invalid(format!("included path is not a current change: {path:?}"))
            })?;
            paths.insert(path.clone());
            if let ChangeKind::Renamed { from } = &change.kind {
                paths.insert(from.clone());
            }
        }
        // Start with the target index, not the worker's previous staging choices.
        let index = TempIndex::new()?;
        self.repo.index_cmd(&index, &["read-tree", &parent.0])?;
        if !paths.is_empty() {
            let mut input = Vec::new();
            for path in &paths {
                input.extend_from_slice(path.as_bytes());
                input.push(0);
            }
            self.repo.git.checked(
                Some(self.path()),
                &[
                    "add",
                    "-A",
                    "--force",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                false,
                &index.env(),
                Some(&input),
            )?;
        }
        let selected = parse::oid(&self.repo.index_cmd(&index, &["write-tree"])?)?;
        let empty = self.repo.changed_paths(&parent, &selected)?.is_empty();
        // Install the selected index before invoking normal git commit: hooks see the same index
        // and worktree as git, and may perform their normal formatting/staging behavior.
        let index_path = self.repo.git_path("index")?;
        let lock_path = index_path.with_file_name("index.lock");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)?;
        let lock = IndexLock::new(lock_path);
        file.write_all(&fs::read(&index.path)?)?;
        file.sync_all()?;
        drop(file);
        if self.head()? != parent {
            return Err(Error::Invalid("worker HEAD moved before commit".into()));
        }
        lock.publish(&index_path)?;
        if empty {
            return Ok(CommitOutcome::Empty);
        }
        let args = ["commit", "--file=-", "--cleanup=verbatim"];
        let out = self.repo.git.run(
            Some(self.path()),
            &args,
            false,
            &[],
            Some(message.as_bytes()),
        )?;
        let commit = self.head()?;
        if commit == parent {
            let mut output = String::from_utf8_lossy(&out.stdout).into_owned();
            output.push_str(&String::from_utf8_lossy(&out.stderr));
            if out.status.success() {
                return Err(Error::Invalid(
                    "git commit succeeded without advancing HEAD".into(),
                ));
            }
            return Ok(CommitOutcome::HookFailed {
                output: output.trim().to_owned(),
            });
        }
        // Post-commit hooks may fail after the commit was successfully created.
        let diff_stat = self.repo.diff_stat(&parent, &commit)?;
        *self.prepared.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(CommitOutcome::Committed { commit, diff_stat })
    }

    /// Replay a single candidate onto a newer target using a tree-only merge. Preserve excluded
    /// local files, use a CAS ref update, and report clean_fast only for disjoint changed paths.
    /// The caller must re-review overlapping successful replays before landing.
    pub fn rebase_candidate(
        &self,
        candidate: &Oid,
        old_onto: &Oid,
        new_onto: &Oid,
    ) -> Result<RebaseOutcome> {
        valid_oid(candidate)?;
        valid_oid(old_onto)?;
        valid_oid(new_onto)?;
        self.ensure_idle()?;
        if self.head()? != *candidate {
            return Err(Error::Invalid(
                "candidate is not this worktree's HEAD".into(),
            ));
        }
        let parents = self
            .repo
            .cmd(&["rev-list", "--parents", "-n", "1", &candidate.0], true)?;
        let parents = parse::line(&parents)?;
        let parents: Vec<_> = parents.split_whitespace().collect();
        if parents.len() != 2 || parents[1] != old_onto.0 {
            return Err(Error::Invalid(
                "candidate must have exactly old_onto as its parent".into(),
            ));
        }
        let paths = self.repo.changed_paths(old_onto, candidate)?;
        let target_paths = self.repo.changed_paths(old_onto, new_onto)?;
        let clean_fast = !paths
            .iter()
            .any(|p| target_paths.iter().any(|t| parse::overlaps(p, t)));
        match self.repo.replay_tree(old_onto, new_onto, candidate)? {
            TreeMerge::Conflicts(paths) => Ok(RebaseOutcome::Conflicts { paths }),
            TreeMerge::Ready(tree) => {
                let message = self
                    .repo
                    .cmd(&["show", "-s", "--format=%B", &candidate.0], true)?;
                let commit =
                    self.repo
                        .commit_tree(&tree, &[new_onto], parse::text(&message)?, false)?;
                // Local exclusions must not become part of the rebased candidate. Replay them
                // separately into the checkout's final content, keeping the commit tree exact.
                let (index, content) = self.repo.capture()?;
                match self.repo.replay_tree(candidate, &commit, &content)? {
                    TreeMerge::Conflicts(paths) => Ok(RebaseOutcome::Conflicts { paths }),
                    TreeMerge::Ready(working_tree) => {
                        self.install(&index, &content, &working_tree, candidate, &commit, &commit)?;
                        *self.prepared.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        Ok(RebaseOutcome::Rebased { commit, clean_fast })
                    }
                }
            }
        }
    }

    /// Preserve all remaining tracked/untracked non-ignored work as one WIP commit. Plumbing
    /// intentionally avoids validation hooks so unfinished work can survive worktree removal.
    /// Identity comes from git config. Nothing is created for a clean checkout.
    pub fn commit_wip(&self, message: &str) -> Result<Option<Oid>> {
        self.ensure_idle()?;
        if self.repo.symbolic_head()?.is_none() {
            return Err(Error::Invalid(
                "WIP requires a branch so it survives worktree removal".into(),
            ));
        }
        if self.repo.status(false)?.dirty().is_empty() {
            return Ok(None);
        }
        let head = self.head()?;
        let (index, tree) = self.repo.capture()?;
        if self.repo.changed_paths(&head, &tree)?.is_empty() {
            return Ok(None);
        }
        let commit = self.repo.commit_tree(&tree, &[&head], message, false)?;
        self.install(&index, &tree, &tree, &head, &commit, &commit)?;
        *self.prepared.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(Some(commit))
    }

    /// Kept work must not carry the user's uncommitted changes the worker started from: replace
    /// the branch's commits since `snapshot` with one commit of the same changes on the
    /// snapshot's parent (the user's HEAD). Returns the new tip, or the conflicting paths when
    /// the work overlaps the uncommitted changes (the branch is then left as it is).
    pub fn drop_snapshot(
        &self,
        snapshot: &Oid,
        message: &str,
    ) -> Result<std::result::Result<Oid, Vec<String>>> {
        valid_oid(snapshot)?;
        self.ensure_idle()?;
        let branch = self
            .repo
            .symbolic_head()?
            .ok_or_else(|| Error::Invalid("kept work needs a branch".into()))?;
        let head = self.head()?;
        let parent = self.repo.resolve(&format!("{}^", snapshot.0))?;
        let tree = parse::oid(&self.repo.cmd(
            &["rev-parse", "--verify", &format!("{}^{{tree}}", head.0)],
            true,
        )?)?;
        match self.repo.replay_tree(snapshot, &parent, &tree)? {
            TreeMerge::Conflicts(paths) => Ok(Err(paths)),
            TreeMerge::Ready(tree) => {
                let commit = self.repo.commit_tree(&tree, &[&parent], message, false)?;
                let name = format!("refs/heads/{branch}");
                self.repo.cmd(
                    &[
                        "update-ref",
                        "-m",
                        "Brigadier kept work without the uncommitted snapshot",
                        &name,
                        &commit.0,
                        &head.0,
                    ],
                    false,
                )?;
                Ok(Ok(commit))
            }
        }
    }

    /// Full final-content patch against base, including non-ignored untracked files.
    pub fn diff_from(&self, base: &Oid) -> Result<String> {
        valid_oid(base)?;
        let (_, tree) = self.repo.capture()?;
        self.repo.diff(base, &tree)
    }
}

struct IndexLock {
    path: PathBuf,
    held: bool,
}
impl IndexLock {
    fn new(path: PathBuf) -> Self {
        Self { path, held: true }
    }
    fn publish(mut self, index: &Path) -> std::io::Result<()> {
        fs::rename(&self.path, index)?;
        // The lock name is available again: never remove a new lock another git command
        // acquired after our rename (including the upcoming git commit's own lock).
        self.held = false;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if self.held {
            let _ = fs::remove_file(&self.path);
        }
    }
}
