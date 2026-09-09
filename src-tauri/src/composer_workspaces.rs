//! Read-only setup discovery and first-Send checkout validation.
use crate::{error::AppError, state::AppState, workspace::git};
use brigadier_core::worktree;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceOption {
    path: PathBuf,
    branch: Option<String>,
    active_task_id: Option<String>,
    active_task_title: Option<String>,
    available: bool,
    reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchOption {
    name: String,
    remote: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceOptions {
    worktrees: Vec<WorkspaceOption>,
    branches: Vec<BranchOption>,
    current_branch: Option<String>,
    is_git: bool,
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::invalid_argument(message)
}
fn canonical(path: &Path) -> Result<PathBuf, AppError> {
    path.canonicalize().map_err(Into::into)
}
async fn current(path: &Path) -> Option<String> {
    git(path, &["symbolic-ref", "--quiet", "HEAD"])
        .await
        .ok()
        .and_then(|v| {
            String::from_utf8_lossy(&v)
                .trim()
                .strip_prefix("refs/heads/")
                .map(str::to_owned)
        })
}
async fn setup_git(root: &Path, args: &[&str]) -> Result<Vec<u8>, AppError> {
    let executable = worktree::resolve_git().ok_or_else(|| invalid("Git is unavailable"))?;
    worktree::setup_command(&executable, root, args)
        .await
        .map_err(|e| invalid(e.to_string()))
}
async fn members(root: &Path) -> Result<Vec<worktree::Worktree>, AppError> {
    let executable = worktree::resolve_git().ok_or_else(|| invalid("Git is unavailable"))?;
    worktree::list(&executable, root)
        .await
        .map_err(|e| invalid(e.to_string()))
}
async fn validate_member(root: &Path, selected: &Path) -> Result<PathBuf, AppError> {
    let selected = canonical(selected)?;
    let listed = members(root).await?;
    let row = listed
        .iter()
        .find(|w| canonical(&w.path).ok().as_ref() == Some(&selected))
        .ok_or_else(|| invalid("Choose an existing worktree belonging to this project"))?;
    if let Some(reason) = &row.locked {
        return Err(invalid(format!("Worktree is locked: {reason}")));
    }
    let executable = worktree::resolve_git().ok_or_else(|| invalid("Git is unavailable"))?;
    let expected = worktree::git_common_dir(&executable, root)
        .await
        .map_err(|e| invalid(e.to_string()))?;
    let actual = worktree::git_common_dir(&executable, &selected)
        .await
        .map_err(|e| invalid(e.to_string()))?;
    if canonical(&expected)? != canonical(&actual)? {
        return Err(invalid(
            "The selected checkout belongs to another repository",
        ));
    }
    Ok(selected)
}
#[tauri::command]
pub(crate) async fn composer_workspace_options(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceOptions, AppError> {
    let supervisor = &state.get()?.supervisor;
    let project = supervisor
        .project(&project_id)
        .await?
        .ok_or_else(|| invalid("Project no longer exists"))?;
    let root = &project.root_path;
    if git(root, &["rev-parse", "--git-dir"]).await.is_err() {
        return Ok(WorkspaceOptions {
            worktrees: vec![],
            branches: vec![],
            current_branch: None,
            is_git: false,
        });
    }
    let sessions = supervisor.list_sessions().await?;
    let titles = crate::peers::snapshot()?.titles;
    let mut worktrees = vec![];
    for row in members(root).await? {
        let path = canonical(&row.path).unwrap_or(row.path);
        let active = sessions.iter().find(|s| {
            supervisor.is_live(&s.session_id)
                && s.cwd.as_deref().and_then(|p| canonical(p).ok()).as_ref() == Some(&path)
        });
        let reason = if active.is_some() {
            Some("Another active task is using this checkout".into())
        } else if !path.is_dir() {
            Some("Checkout directory is unavailable".into())
        } else {
            row.locked.map(|r| format!("Worktree is locked: {r}"))
        };
        worktrees.push(WorkspaceOption {
            path,
            branch: row.branch,
            active_task_id: active.map(|s| s.session_id.to_string()),
            active_task_title: active.and_then(|s| titles.get(s.session_id.as_str()).cloned()),
            available: reason.is_none(),
            reason,
        });
    }
    let output = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )
    .await?;
    let branches = String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|reference| {
            if let Some(name) = reference.strip_prefix("refs/heads/") {
                Some(BranchOption {
                    name: name.into(),
                    remote: false,
                })
            } else {
                reference
                    .strip_prefix("refs/remotes/")
                    .filter(|name| !name.ends_with("/HEAD"))
                    .map(|name| BranchOption {
                        name: format!("refs/remotes/{name}"),
                        remote: true,
                    })
            }
        })
        .collect();
    Ok(WorkspaceOptions {
        worktrees,
        branches,
        current_branch: current(root).await,
        is_git: true,
    })
}
/// Caller holds both creation and lifecycle locks until the initial provider dispatch completes.
pub(crate) async fn prepare_checkout(
    state: &AppState,
    project: &str,
    selected: Option<&str>,
    base: Option<&str>,
    new_branch: Option<&str>,
) -> Result<(PathBuf, Option<String>), AppError> {
    let supervisor = &state.get()?.supervisor;
    let project = supervisor
        .project(project)
        .await?
        .ok_or_else(|| invalid("Project no longer exists"))?;
    let root = canonical(&project.root_path)?;
    let path = match selected {
        Some(path) => validate_member(&root, Path::new(path)).await?,
        None => root,
    };
    if supervisor.list_sessions().await?.iter().any(|s| {
        supervisor.is_live(&s.session_id)
            && s.cwd.as_deref().and_then(|p| canonical(p).ok()).as_ref() == Some(&path)
    }) {
        return Err(invalid(
            "Another active task is using this checkout. Stop it or choose a different worktree.",
        ));
    }
    supervisor.workspace_writable(&path).await?;
    let _lease = brigadier_core::checkpoint::WorkspaceLease::acquire(&path)
        .map_err(|e| invalid(e.to_string()))?;
    let branch = checkout(&path, base, new_branch).await?;
    Ok((path, branch))
}
pub(crate) async fn checkout(
    path: &Path,
    base: Option<&str>,
    new_branch: Option<&str>,
) -> Result<Option<String>, AppError> {
    if base.is_none() && new_branch.is_none() {
        return Ok(current(path).await);
    }
    let live = current(path).await;
    let mut reference = None;
    if let Some(base) = base {
        let candidates = if base.starts_with("refs/heads/") || base.starts_with("refs/remotes/") {
            vec![base.to_owned()]
        } else {
            vec![format!("refs/heads/{base}"), format!("refs/remotes/{base}")]
        };
        for candidate in candidates {
            if git(path, &["show-ref", "--verify", "--quiet", &candidate])
                .await
                .is_ok()
            {
                reference = Some(candidate);
                break;
            }
        }
        if reference.is_none() {
            return Err(invalid("Choose an existing local or remote branch"));
        }
    }
    let same = reference.as_deref().is_none_or(|r| {
        live.as_deref()
            .is_some_and(|b| r == format!("refs/heads/{b}"))
    });
    if same && new_branch.is_none() {
        return Ok(live);
    }
    if !same
        && !setup_git(path, &["status", "--porcelain", "--untracked-files=all"])
            .await?
            .is_empty()
    {
        return Err(invalid("This checkout has local changes. Commit or stash them before switching to another branch, or start a new isolated worktree."));
    }
    let source = reference.as_deref().unwrap_or("HEAD");
    let oid = git(
        path,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{source}^{{commit}}"),
        ],
    )
    .await?;
    let oid = String::from_utf8_lossy(&oid).trim().to_owned();
    let remote = reference
        .as_deref()
        .and_then(|r| r.strip_prefix("refs/remotes/"));
    let tracking_name = remote.and_then(|r| r.split_once('/').map(|(_, b)| b));
    let create = new_branch.or(tracking_name);
    if let Some(name) = create {
        if name.starts_with('-') || name.starts_with("refs/") {
            return Err(invalid("Choose a plain local branch name"));
        }
        git(path, &["check-ref-format", &format!("refs/heads/{name}")]).await?;
        if git(
            path,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )
        .await
        .is_ok()
        {
            return Err(invalid(format!(
                "Branch {name} already exists. Choose that local branch or a different new name."
            )));
        }
        setup_git(
            path,
            &["checkout", "--no-overwrite-ignore", "-b", name, &oid],
        )
        .await?;
        if new_branch.is_none() {
            git(path, &["branch", "--set-upstream-to", source, name]).await?;
        }
    } else if let Some(name) = reference
        .as_deref()
        .and_then(|r| r.strip_prefix("refs/heads/"))
    {
        setup_git(path, &["checkout", "--no-overwrite-ignore", name, "--"]).await?;
    }
    Ok(current(path).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"])
            .await
            .unwrap();
        git(dir.path(), &["config", "user.name", "Test"])
            .await
            .unwrap();
        git(dir.path(), &["config", "user.email", "test@example.test"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("file"), "original").unwrap();
        git(dir.path(), &["add", "file"]).await.unwrap();
        git(dir.path(), &["commit", "-qm", "initial"])
            .await
            .unwrap();
        dir
    }
    #[tokio::test]
    async fn current_and_new_local_preserve_dirty_but_alternate_refuses_it() {
        let dir = repo().await;
        git(dir.path(), &["branch", "alternate"]).await.unwrap();
        std::fs::write(dir.path().join("file"), "owner edits").unwrap();
        std::fs::write(dir.path().join("draft"), "untracked").unwrap();
        assert_eq!(
            checkout(dir.path(), Some("main"), None)
                .await
                .unwrap()
                .as_deref(),
            Some("main")
        );
        assert!(checkout(dir.path(), Some("alternate"), None).await.is_err());
        assert_eq!(
            checkout(dir.path(), None, Some("proposal"))
                .await
                .unwrap()
                .as_deref(),
            Some("proposal")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file")).unwrap(),
            "owner edits"
        );
        assert!(dir.path().join("draft").exists());
        assert!(checkout(dir.path(), None, Some("proposal")).await.is_err());
        assert_eq!(current(dir.path()).await.as_deref(), Some("proposal"));
    }
    #[tokio::test]
    async fn branch_tag_ambiguity_keeps_current_dirty_checkout_and_setup_runs_no_hooks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = repo().await;
        git(dir.path(), &["tag", "main"]).await.unwrap();
        std::fs::write(dir.path().join("file"), "dirty").unwrap();
        assert_eq!(
            checkout(dir.path(), Some("main"), None)
                .await
                .unwrap()
                .as_deref(),
            Some("main")
        );
        let hook = dir.path().join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\ntouch hook-ran\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        checkout(dir.path(), None, Some("clean-new")).await.unwrap();
        assert!(!dir.path().join("hook-ran").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file")).unwrap(),
            "dirty"
        );
    }
    #[tokio::test]
    async fn remote_checkout_tracks_without_repointing_existing_branch() {
        let dir = repo().await;
        git(
            dir.path(),
            &["remote", "add", "origin", "https://example.test/repo"],
        )
        .await
        .unwrap();
        git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/topic", "HEAD"],
        )
        .await
        .unwrap();
        assert_eq!(
            checkout(dir.path(), Some("refs/remotes/origin/topic"), None)
                .await
                .unwrap()
                .as_deref(),
            Some("topic")
        );
        assert_eq!(
            String::from_utf8_lossy(
                &git(dir.path(), &["rev-parse", "--abbrev-ref", "@{upstream}"])
                    .await
                    .unwrap()
            )
            .trim(),
            "origin/topic"
        );
        checkout(dir.path(), Some("main"), None).await.unwrap();
        assert!(
            checkout(dir.path(), Some("refs/remotes/origin/topic"), None)
                .await
                .is_err()
        );
        assert_eq!(current(dir.path()).await.as_deref(), Some("main"));
    }
    #[tokio::test]
    async fn validates_external_worktrees_and_rejects_foreign_and_nested_paths() {
        let dir = repo().await;
        let external = tempfile::tempdir().unwrap();
        let linked = external.path().join("linked\nworktree");
        git(
            dir.path(),
            &[
                "worktree",
                "add",
                "-b",
                "external",
                linked.to_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            validate_member(dir.path(), &linked).await.unwrap(),
            linked.canonicalize().unwrap()
        );
        git(dir.path(), &["worktree", "lock", linked.to_str().unwrap()])
            .await
            .unwrap();
        assert!(validate_member(dir.path(), &linked).await.is_err());
        git(
            dir.path(),
            &["worktree", "unlock", linked.to_str().unwrap()],
        )
        .await
        .unwrap();
        let foreign = repo().await;
        assert!(validate_member(dir.path(), foreign.path()).await.is_err());
        let nested = linked.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_member(dir.path(), &nested).await.is_err());
        assert!(checkout(dir.path(), Some("external"), None).await.is_err());
        assert_eq!(current(dir.path()).await.as_deref(), Some("main"));
    }
}
