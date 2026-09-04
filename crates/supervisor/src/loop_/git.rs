//! The git calls the loop needs and `brigadier_core::worktree` does not expose.
//!
//! That module owns worktree creation, removal, `dirty_count` and `commits_only_here`; it has no
//! `rev-parse`, no `merge`, no `log` and no `diff`. Rather than widen a crate this order does not
//! own, the loop keeps its own thin wrappers here — with the **same** environment that module
//! pins on every call (`crates/core/src/worktree.rs`), because the reasons are the same:
//!
//! - `LC_ALL=C` and `LANGUAGE=` so stderr stays parseable under any locale;
//! - `GIT_TERMINAL_PROMPT=0` so a credential prompt can never wedge an unattended run;
//! - `stdin` null, for the same reason the gate's is
//!   (`crates/supervisor/src/verify.rs`) — an interactive prompt must EOF, not hang.
//!
//! **`git`'s `cherry` subcommand appears nowhere in this file and must never be added to it.** It reports three
//! `+` for three commits squashed into one upstream commit and `-` for work that was applied and
//! then reverted (**measured** on git 2.50.1, `docs/research/worktree-cleanup.md` §§2.2–2.4). The
//! only sound signal in this repository is [`rev_list_count`]: *0 means nothing to lose; non-zero
//! proves nothing.*
// see docs/research/orchestration-loop.md §§3.2, 4.1, 8 and §15 item 4.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

/// A git invocation that failed, with enough of git's own words to act on.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// git could not be spawned at all.
    #[error("git: {0}")]
    Io(#[from] std::io::Error),
    /// git ran and refused.
    #[error("git {args} exited {code}: {stderr}")]
    Failed {
        /// The subcommand and its arguments, joined by spaces.
        args: String,
        /// The exit code, or `-1` when the process was signalled.
        code: i32,
        /// git's stderr, trimmed.
        stderr: String,
    },
}

impl GitError {
    /// git's own stderr, for a failure. Empty for an I/O error.
    #[must_use]
    pub fn stderr(&self) -> &str {
        match self {
            Self::Failed { stderr, .. } => stderr,
            Self::Io(_) => "",
        }
    }
}

/// What one git call produced.
#[derive(Clone, Debug)]
pub struct Output {
    /// Exit code, or `-1` when signalled.
    pub code: i32,
    /// stdout, trimmed of the trailing newline git always writes.
    pub stdout: String,
    /// stderr, trimmed.
    pub stderr: String,
}

impl Output {
    /// Whether git exited 0.
    #[must_use]
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// Run `git -C <cwd> <args…>` and hand back the exit code and both streams.
///
/// Never an error for a non-zero exit: several callers here ask git a **question** whose answer
/// is the exit code (`merge-base --is-ancestor`, `merge`), and folding that into `Err` would make
/// "the answer is no" indistinguishable from "git is not installed".
pub async fn run(git: &Path, cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let out = Command::new(git)
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANGUAGE", "")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    Ok(Output {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    })
}

/// [`run`], with a non-zero exit turned into [`GitError::Failed`].
pub async fn checked(git: &Path, cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = run(git, cwd, args).await?;
    if out.ok() {
        return Ok(out.stdout);
    }
    Err(GitError::Failed { args: args.join(" "), code: out.code, stderr: out.stderr })
}

/// `git rev-parse --verify <rev>^{commit}`: one commit sha, or the reason there is none.
///
/// `^{commit}` rather than the bare revision, so an annotated tag resolves to the commit it names
/// and anything that is not a commit is refused here rather than three calls later.
pub async fn rev_parse(git: &Path, cwd: &Path, rev: &str) -> Result<String, GitError> {
    let arg = format!("{rev}^{{commit}}");
    let sha = checked(git, cwd, &["rev-parse", "--verify", &arg]).await?;
    if sha.is_empty() {
        return Err(GitError::Failed {
            args: format!("rev-parse --verify {arg}"),
            code: 0,
            stderr: "rev-parse printed nothing".to_owned(),
        });
    }
    Ok(sha)
}

/// The **first** parent of `rev`, or `None` when it is a root commit.
///
/// First, not `%P`, and the difference is the whole of this function. `%P` lists **every** parent
/// and a `--no-ff` phase merge has two, so a postcondition comparing the whole `%P` string reads
/// `unknown` on every phase this loop ever commits (**measured** on git 2.50.1,
/// `docs/research/intent-records.md` §10.2b).
pub async fn first_parent(
    git: &Path,
    cwd: &Path,
    rev: &str,
) -> Result<Option<String>, GitError> {
    let arg = format!("{rev}^1");
    let out = run(git, cwd, &["rev-parse", "--verify", "--quiet", &arg]).await?;
    if out.ok() && !out.stdout.is_empty() {
        return Ok(Some(out.stdout));
    }
    // `--quiet` makes a root commit exit 1 with nothing on either stream, which is the answer
    // "there is no first parent" and not a failure.
    if out.stderr.is_empty() {
        return Ok(None);
    }
    Err(GitError::Failed { args: format!("rev-parse {arg}"), code: out.code, stderr: out.stderr })
}

/// `git log -1 --format=%s <rev>`: the top commit's subject.
pub async fn subject(git: &Path, cwd: &Path, rev: &str) -> Result<String, GitError> {
    checked(git, cwd, &["log", "-1", "--format=%s", rev]).await
}

/// `git rev-list --count <base>..<tip>`.
///
/// **The only sound merge signal in this repository.** Zero means the branch holds nothing the
/// base does not, so nothing is lost by deleting it. Non-zero proves nothing at all: a
/// squash-merged branch and a never-merged branch both count non-zero
/// (`docs/research/worktree-cleanup.md` §2.1, **measured**).
pub async fn rev_list_count(
    git: &Path,
    cwd: &Path,
    base: &str,
    tip: &str,
) -> Result<u32, GitError> {
    let range = format!("{base}..{tip}");
    let out = checked(git, cwd, &["rev-list", "--count", &range]).await?;
    out.trim().parse::<u32>().map_err(|e| GitError::Failed {
        args: format!("rev-list --count {range}"),
        code: 0,
        stderr: format!("could not read a count from {out:?}: {e}"),
    })
}

/// One commit in a range, as re-derived from git rather than as a worker claimed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    /// Full sha.
    pub sha: String,
    /// Subject line.
    pub subject: String,
}

/// `git log --format=%H%x00%s <base>..<tip>`, newest first.
pub async fn commits(
    git: &Path,
    cwd: &Path,
    base: &str,
    tip: &str,
) -> Result<Vec<Commit>, GitError> {
    let range = format!("{base}..{tip}");
    let out = checked(git, cwd, &["log", "--format=%H%x00%s", &range]).await?;
    Ok(out
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (sha, subject) = l.split_once('\0').unwrap_or((l, ""));
            Commit { sha: sha.to_owned(), subject: subject.to_owned() }
        })
        .collect())
}

/// `git diff --name-only <base>..<tip>`, as project-relative paths.
pub async fn changed_paths(
    git: &Path,
    cwd: &Path,
    base: &str,
    tip: &str,
) -> Result<Vec<String>, GitError> {
    let range = format!("{base}..{tip}");
    let out = checked(git, cwd, &["diff", "--name-only", &range]).await?;
    Ok(out.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

/// What a merge did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merged {
    /// A merge commit was written.
    Commit,
    /// The base already contained the branch; nothing was written.
    AlreadyUpToDate,
    /// git refused: a conflict, or a dirty tree.
    Conflict,
}

/// `git merge --no-ff --no-edit -m <message> <rev>` in `cwd`.
///
/// `--no-ff` because a phase's commit must be one identifiable commit whatever the shape of the
/// history under it. The distinction [`Merged::AlreadyUpToDate`] draws is load-bearing: it is the
/// one case that produces **no commit at all**, and reading it as a failure would block a phase
/// whose work is already in the base.
pub async fn merge_no_ff(
    git: &Path,
    cwd: &Path,
    rev: &str,
    message: &str,
) -> Result<Merged, GitError> {
    let out = run(git, cwd, &["merge", "--no-ff", "--no-edit", "-m", message, rev]).await?;
    if out.ok() {
        if out.stdout.contains("Already up to date") {
            return Ok(Merged::AlreadyUpToDate);
        }
        return Ok(Merged::Commit);
    }
    // Leave nothing half-merged behind: an aborted merge is a clean tree the caller can act on.
    let _ = run(git, cwd, &["merge", "--abort"]).await;
    Ok(Merged::Conflict)
}

/// `git checkout -b <branch> <base>` in `cwd`.
pub async fn checkout_new_branch(
    git: &Path,
    cwd: &Path,
    branch: &str,
    base: &str,
) -> Result<(), GitError> {
    checked(git, cwd, &["checkout", "-b", branch, base]).await.map(|_| ())
}

/// `git reset --hard <rev>`, the undo for a fixer that made things worse.
pub async fn reset_hard(git: &Path, cwd: &Path, rev: &str) -> Result<(), GitError> {
    checked(git, cwd, &["reset", "--hard", rev]).await.map(|_| ())
}

/// `git merge-base --is-ancestor <a> <b>`: whether `a` is contained in `b`.
pub async fn is_ancestor(git: &Path, cwd: &Path, a: &str, b: &str) -> Result<bool, GitError> {
    Ok(run(git, cwd, &["merge-base", "--is-ancestor", a, b]).await?.ok())
}

/// The branch `HEAD` is on in `cwd`, or `None` when it is detached.
pub async fn current_branch(git: &Path, cwd: &Path) -> Result<Option<String>, GitError> {
    let out = run(git, cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await?;
    if out.ok() && !out.stdout.is_empty() {
        Ok(Some(out.stdout))
    } else {
        Ok(None)
    }
}

/// Where a repository keeps its worktrees, canonicalised the way git reports it.
#[must_use]
pub fn worktree_dir(project_root: &Path, id: &str) -> PathBuf {
    project_root.join(crate::worktree::WORKTREES_SUBDIR).join(id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A throwaway repository with one commit, in the style of `crates/core/tests/worktree.rs`.
    pub(crate) struct Repo {
        pub git: PathBuf,
        pub dir: tempfile::TempDir,
    }

    impl Repo {
        pub async fn new() -> Option<Self> {
            let git = brigadier_core::worktree::resolve_git()?;
            let dir = tempfile::tempdir().ok()?;
            let root = dir.path().to_path_buf();
            for args in [
                vec!["init", "-q", "-b", "main"],
                vec!["config", "user.email", "t@example.com"],
                vec!["config", "user.name", "t"],
                vec!["config", "commit.gpgsign", "false"],
            ] {
                checked(&git, &root, &args).await.expect("git setup");
            }
            let me = Self { git, dir };
            me.write("README", "one\n");
            me.commit("one").await;
            Some(me)
        }

        pub fn root(&self) -> &Path {
            self.dir.path()
        }

        pub fn write(&self, rel: &str, body: &str) {
            let p = self.dir.path().join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(p, body).expect("write");
        }

        pub async fn commit(&self, message: &str) -> String {
            checked(&self.git, self.root(), &["add", "-A"]).await.expect("add");
            checked(&self.git, self.root(), &["commit", "-q", "-m", message])
                .await
                .expect("commit");
            rev_parse(&self.git, self.root(), "HEAD").await.expect("head")
        }

        pub async fn git(&self, args: &[&str]) -> Output {
            run(&self.git, self.root(), args).await.expect("git")
        }
    }

    #[tokio::test]
    async fn a_no_ff_merges_first_parent_is_the_base_and_p_is_not() {
        let Some(repo) = Repo::new().await else { return };
        let base = rev_parse(&repo.git, repo.root(), "HEAD").await.expect("base");
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("a.txt", "a\n");
        repo.commit("side work").await;
        repo.git(&["checkout", "-q", "main"]).await;

        let merged =
            merge_no_ff(&repo.git, repo.root(), "side", "phase 1").await.expect("merge");
        assert_eq!(merged, Merged::Commit);

        let first = first_parent(&repo.git, repo.root(), "HEAD").await.expect("first parent");
        assert_eq!(first.as_deref(), Some(base.as_str()), "the first parent is the baseline");

        // The claim the postcondition rests on: `%P` is not the baseline, so a comparison of the
        // whole field reads `unknown` on a merge this loop just made.
        let all_parents =
            checked(&repo.git, repo.root(), &["log", "-1", "--format=%P"]).await.expect("%P");
        assert_ne!(all_parents, base, "%P lists both parents; comparing it whole is the bug");
        assert!(all_parents.starts_with(&base));
        assert_eq!(
            subject(&repo.git, repo.root(), "HEAD").await.expect("subject"),
            "phase 1"
        );
    }

    #[tokio::test]
    async fn a_root_commit_has_no_first_parent_and_that_is_not_an_error() {
        let Some(repo) = Repo::new().await else { return };
        let root = rev_parse(&repo.git, repo.root(), "HEAD").await.expect("head");
        assert_eq!(first_parent(&repo.git, repo.root(), &root).await.expect("ok"), None);
    }

    #[tokio::test]
    async fn a_fast_forward_writes_no_commit_and_is_not_a_conflict() {
        let Some(repo) = Repo::new().await else { return };
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("a.txt", "a\n");
        let tip = repo.commit("side work").await;
        repo.git(&["checkout", "-q", "main"]).await;
        // Land it, then try to land it again: the second is the already-up-to-date case.
        assert_eq!(
            merge_no_ff(&repo.git, repo.root(), "side", "phase 1").await.expect("merge"),
            Merged::Commit
        );
        assert_eq!(
            merge_no_ff(&repo.git, repo.root(), "side", "phase 1 again").await.expect("merge"),
            Merged::AlreadyUpToDate
        );
        assert!(is_ancestor(&repo.git, repo.root(), &tip, "HEAD").await.expect("ancestor"));
    }

    #[tokio::test]
    async fn a_conflict_leaves_a_clean_tree_rather_than_a_half_merge() {
        let Some(repo) = Repo::new().await else { return };
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("README", "side\n");
        repo.commit("side").await;
        repo.git(&["checkout", "-q", "main"]).await;
        repo.write("README", "main\n");
        repo.commit("main").await;

        assert_eq!(
            merge_no_ff(&repo.git, repo.root(), "side", "phase 1").await.expect("merge"),
            Merged::Conflict
        );
        let status = repo.git(&["status", "--porcelain"]).await;
        assert!(status.stdout.is_empty(), "the merge was aborted: {status:?}");
    }

    #[tokio::test]
    async fn rev_list_counts_the_range_and_reads_zero_only_when_nothing_is_left() {
        let Some(repo) = Repo::new().await else { return };
        let base = rev_parse(&repo.git, repo.root(), "HEAD").await.expect("base");
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("a.txt", "a\n");
        repo.commit("side").await;
        assert_eq!(rev_list_count(&repo.git, repo.root(), &base, "side").await.expect("n"), 1);
        assert_eq!(rev_list_count(&repo.git, repo.root(), "side", "side").await.expect("n"), 0);
    }

    #[tokio::test]
    async fn commits_and_paths_come_back_re_derived() {
        let Some(repo) = Repo::new().await else { return };
        let base = rev_parse(&repo.git, repo.root(), "HEAD").await.expect("base");
        repo.git(&["checkout", "-q", "-b", "side"]).await;
        repo.write("src/a.rs", "a\n");
        repo.commit("added a").await;
        let got = commits(&repo.git, repo.root(), &base, "side").await.expect("commits");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].subject, "added a");
        assert_eq!(
            changed_paths(&repo.git, repo.root(), &base, "side").await.expect("paths"),
            vec!["src/a.rs".to_owned()]
        );
    }
}
