//! Git actions operate on the resolved workspace; patches are derived from a fresh diff.
use crate::{
    error::AppError,
    state::AppState,
    workspace::{git, parse_status, root},
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use tauri::State;
use tokio::io::AsyncWriteExt;
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitAction {
    pub action: String,
    pub path: Option<String>,
    pub message: Option<String>,
    pub reference: Option<String>,
    pub expected_diff: Option<String>,
    pub lines: Option<Vec<usize>>,
}
fn path_arg(path: &str) -> Result<(), AppError> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path.split('/').any(|x| x == ".git")
    {
        return Err(AppError::invalid_argument("Invalid repository path"));
    }
    Ok(())
}
fn reference(value: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.starts_with('-')
        || value.len() > 512
        || value.contains(['\n', '\0'])
    {
        return Err(AppError::invalid_argument("Invalid Git reference"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn workspace_git_action(
    project_id: String,
    session_id: Option<String>,
    request: GitAction,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    let _guard = MUTATION.lock().await;
    state.get()?.supervisor.workspace_writable(&root).await?;
    execute(&root, request).await
}
pub(crate) async fn execute(root: &Path, r: GitAction) -> Result<String, AppError> {
    let root = root.to_path_buf();
    tokio::spawn(async move { execute_owned(&root, r).await })
        .await
        .map_err(|e| AppError::io(e.to_string()))?
}
async fn execute_owned(root: &Path, r: GitAction) -> Result<String, AppError> {
    let _lease = brigadier_core::checkpoint::WorkspaceLease::acquire(root)
        .map_err(|e| AppError::invalid_argument(e.to_string()))?;
    if let Some(path) = &r.path {
        path_arg(path)?;
    }
    let path = r.path.as_deref().unwrap_or(".");
    let rename = if matches!(r.action.as_str(), "stage" | "unstage") && r.path.is_some() {
        parse_status(&git(root, &["status", "--porcelain=v1", "-z"]).await?)
            .into_iter()
            .find(|c| c.path == path)
            .and_then(|c| c.original)
    } else {
        None
    };
    let paths = |prefix: &[&str]| {
        let mut args = prefix.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        args.push(path.into());
        if let Some(original) = &rename {
            args.push(original.clone());
        }
        args
    };
    let output = match r.action.as_str() {
        "stage" => {
            git(
                root,
                &paths(&["add", "--"])
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            )
            .await?
        }
        "unstage" => {
            if git(root, &["rev-parse", "--verify", "HEAD"]).await.is_ok() {
                git(
                    root,
                    &paths(&["restore", "--staged", "--"])
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                )
                .await?
            } else {
                git(root, &["rm", "--cached", "-r", "--", path]).await?
            }
        }
        "discard" => {
            if r.path.is_none() {
                return Err(AppError::invalid_argument("Select a file to discard"));
            }
            let changes =
                parse_status(&git(root, &["status", "--porcelain=v1", "-z", "--", path]).await?);
            if changes.iter().any(|c| c.index == "?") {
                // Preserve untracked contents in the OS trash, just like VS Code.
                let target = root.join(path);
                let parent = target
                    .parent()
                    .ok_or_else(|| AppError::invalid_argument("Invalid path"))?
                    .canonicalize()
                    .map_err(|e| AppError::io(e.to_string()))?;
                if !parent.starts_with(
                    root.canonicalize()
                        .map_err(|e| AppError::io(e.to_string()))?,
                ) {
                    return Err(AppError::invalid_argument("Path escapes workspace"));
                }
                trash::delete(target).map_err(|e| AppError::io(e.to_string()))?;
                Vec::new()
            } else {
                // Preserve the current file for recovery before replacing its worktree contents.
                let target = root.join(path);
                if std::fs::symlink_metadata(&target).is_ok() {
                    let backup = tempfile::Builder::new()
                        .prefix("brigadier-discard-")
                        .tempdir()
                        .map_err(|e| AppError::io(e.to_string()))?;
                    let copy = backup.path().join(target.file_name().unwrap());
                    #[cfg(unix)]
                    if target.is_symlink() {
                        std::os::unix::fs::symlink(
                            std::fs::read_link(&target).map_err(|e| AppError::io(e.to_string()))?,
                            &copy,
                        )
                        .map_err(|e| AppError::io(e.to_string()))?;
                    } else {
                        std::fs::copy(&target, &copy).map_err(|e| AppError::io(e.to_string()))?;
                    }
                    #[cfg(not(unix))]
                    std::fs::copy(&target, &copy).map_err(|e| AppError::io(e.to_string()))?;
                    trash::delete(&copy).map_err(|e| AppError::io(e.to_string()))?;
                }
                git(root, &["restore", "--worktree", "--", path]).await?
            }
        }
        "stage_lines" | "unstage_lines" => {
            if r.path.is_none() {
                return Err(AppError::invalid_argument("Select a file"));
            }
            let staged = r.action == "unstage_lines";
            let diff = crate::workspace::change_diff(root, path, staged).await?;
            if r.expected_diff.as_deref() != Some(diff.as_str()) {
                return Err(AppError::new(
                    "stale_diff",
                    "The diff changed. Refresh and select the changes again.",
                ));
            }
            let patch = selected_patch(&diff, r.lines.as_deref().unwrap_or(&[]), staged)?;
            apply(root, patch).await?;
            Vec::new()
        }
        "commit" | "commit_all" | "amend" => {
            let message = r.message.as_deref().unwrap_or("").trim();
            if message.is_empty() || message.len() > 64000 {
                return Err(AppError::invalid_argument(
                    "Enter a commit message (up to 64 KiB)",
                ));
            }
            if r.action == "commit_all" {
                git(root, &["add", "-A", "--", "."]).await?;
            }
            let mut args = vec!["commit", "-m", message];
            if r.action == "amend" {
                args.push("--amend");
            }
            git(root, &args).await?
        }
        "undo_commit" => git(root, &["reset", "--soft", "HEAD~1"]).await?,
        "fetch" => git(root, &["fetch", "--all", "--prune"]).await?,
        "pull" => git(root, &["pull"]).await?,
        "push" => git(root, &["push"]).await?,
        "sync" => {
            git(root, &["pull"]).await?;
            git(root, &["push"]).await?
        }
        "publish" => {
            let branch = git(root, &["symbolic-ref", "--short", "HEAD"]).await?;
            let branch = String::from_utf8_lossy(&branch);
            reference(branch.trim())?;
            let remote = r.reference.as_deref().unwrap_or("origin");
            reference(remote)?;
            git(root, &["push", "--set-upstream", remote, branch.trim()]).await?
        }
        "checkout" | "branch" | "merge" | "rebase" | "stash_pop" | "stash_apply" | "stash_drop" => {
            let value = r.reference.as_deref().unwrap_or("");
            reference(value)?;
            match r.action.as_str() {
                "checkout" => git(root, &["checkout", value]).await?,
                "branch" => {
                    git(root, &["check-ref-format", "--branch", value]).await?;
                    git(root, &["checkout", "-b", value]).await?
                }
                "merge" => git(root, &["merge", value]).await?,
                "rebase" => git(root, &["rebase", value]).await?,
                "stash_pop" => git(root, &["stash", "pop", value]).await?,
                "stash_apply" => git(root, &["stash", "apply", value]).await?,
                _ => git(root, &["stash", "drop", value]).await?,
            }
        }
        "stash" => {
            git(
                root,
                &[
                    "stash",
                    "push",
                    "--include-untracked",
                    "-m",
                    r.message.as_deref().unwrap_or("Brigadier stash"),
                ],
            )
            .await?
        }
        "merge_abort" => git(root, &["merge", "--abort"]).await?,
        "rebase_abort" => git(root, &["rebase", "--abort"]).await?,
        "rebase_continue" => git(root, &["-c", "core.editor=true", "rebase", "--continue"]).await?,
        _ => return Err(AppError::invalid_argument("Unknown Git action")),
    };
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

/// Build a patch containing selected additions/deletions. Unselected lines remain context.
/// For unstage, reverse the source first so the patch applies to the current index.
fn selected_patch(diff: &str, selected: &[usize], reverse: bool) -> Result<String, AppError> {
    if diff.lines().any(|l| {
        l.starts_with("rename from ") || l.starts_with("rename to ") || l.contains("mode 120000")
    }) {
        return Err(AppError::invalid_argument(
            "Stage or unstage renamed files and symbolic links as a whole",
        ));
    }
    use std::collections::HashSet;
    let selected: HashSet<usize> = selected.iter().copied().collect();
    let lines: Vec<&str> = diff.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.starts_with("@@ "))
        .ok_or_else(|| AppError::invalid_argument("No text changes to stage"))?;
    let original_new = lines.iter().any(|l| l.starts_with("new file mode "));
    let original_deleted = lines.iter().any(|l| l.starts_with("deleted file mode "));
    let source_missing = if reverse {
        original_deleted
    } else {
        original_new
    };
    let can_delete = if reverse {
        original_new
    } else {
        original_deleted
    };
    let old_path = lines
        .iter()
        .find_map(|l| l.strip_prefix("--- "))
        .ok_or_else(|| AppError::invalid_argument("Missing diff path"))?;
    let new_path = lines
        .iter()
        .find_map(|l| l.strip_prefix("+++ "))
        .ok_or_else(|| AppError::invalid_argument("Missing diff path"))?;
    let a_path = if old_path == "/dev/null" {
        new_path.replacen("b/", "a/", 1)
    } else {
        old_path.to_owned()
    };
    let b_path = if new_path == "/dev/null" {
        old_path.replacen("a/", "b/", 1)
    } else {
        new_path.to_owned()
    };
    let mode = lines
        .iter()
        .find_map(|l| {
            l.strip_prefix("new file mode ")
                .or_else(|| l.strip_prefix("deleted file mode "))
        })
        .unwrap_or("100644");
    let mut result = String::new();
    let mut remaining = 0;
    let mut i = start;
    let mut offset: isize = 0;
    let mut any = false;
    let header = regex::Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap();
    while i < lines.len() {
        let caps = header
            .captures(lines[i])
            .ok_or_else(|| AppError::invalid_argument("Unsupported diff"))?;
        let base: isize = caps[if reverse { 2 } else { 1 }].parse().unwrap();
        i += 1;
        let mut body = String::new();
        let mut old = 0;
        let mut new = 0;
        let mut changed = false;
        let mut emitted = false;
        while i < lines.len() && !lines[i].starts_with("@@ ") {
            let line = lines[i];
            let chosen = selected.contains(&(i + 1));
            let sign = match (line.as_bytes().first(), reverse) {
                (Some(b'+'), true) => '-',
                (Some(b'-'), true) => '+',
                (Some(x), _) => *x as char,
                _ => ' ',
            };
            if sign != '\\' {
                emitted = matches!(sign, ' ' | '-') || (sign == '+' && chosen);
            }
            match sign {
                '+' if chosen => {
                    body.push('+');
                    body.push_str(&line[1..]);
                    body.push('\n');
                    new += 1;
                    changed = true;
                }
                '-' if chosen => {
                    body.push('-');
                    body.push_str(&line[1..]);
                    body.push('\n');
                    old += 1;
                    changed = true;
                }
                '-' => {
                    body.push(' ');
                    body.push_str(&line[1..]);
                    body.push('\n');
                    old += 1;
                    new += 1;
                }
                ' ' => {
                    body.push_str(line);
                    body.push('\n');
                    old += 1;
                    new += 1;
                }
                '\\' if emitted => {
                    body.push_str(line);
                    body.push('\n');
                }
                _ => {}
            }
            i += 1;
        }
        if changed {
            let old_start = if old == 0 { 0 } else { base.max(1) };
            let new_start = if new == 0 {
                (base + offset - 1).max(0)
            } else {
                (base + offset).max(1)
            };
            result.push_str(&format!(
                "@@ -{old_start},{old} +{new_start},{new} @@\n{body}"
            ));
            remaining += new;
            offset += new as isize - old as isize;
            any = true;
        }
    }
    if !any {
        return Err(AppError::invalid_argument("Select added or removed lines"));
    }
    let deleting = can_delete && remaining == 0;
    let mut prefix = String::new();
    for line in &lines[..start] {
        if line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("new file mode ")
            || line.starts_with("deleted file mode ")
        {
            continue;
        }
        prefix.push_str(line);
        prefix.push('\n');
    }
    if source_missing {
        prefix.push_str(&format!("new file mode {mode}\n"));
    } else if deleting {
        prefix.push_str(&format!("deleted file mode {mode}\n"));
    }
    prefix.push_str(&format!(
        "--- {}\n+++ {}\n",
        if source_missing { "/dev/null" } else { &a_path },
        if deleting { "/dev/null" } else { &b_path }
    ));
    Ok(prefix + &result)
}
async fn apply(root: &Path, patch: String) -> Result<(), AppError> {
    let mut child = tokio::process::Command::new("/usr/bin/git")
        .current_dir(root)
        .args(["apply", "--cached", "--recount", "--whitespace=nowarn", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::io(e.to_string()))?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch.as_bytes())
        .await
        .map_err(|e| AppError::io(e.to_string()))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| AppError::io("Staging timed out"))?
        .map_err(|e| AppError::io(e.to_string()))?;
    if !output.status.success() {
        return Err(AppError::io(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }
    Ok(())
}
#[derive(Serialize)]
pub(crate) struct GitDetails {
    branches: Vec<String>,
    remotes: Vec<String>,
    history: String,
    stashes: Vec<String>,
}
#[tauri::command]
pub(crate) async fn workspace_git_details(
    project_id: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitDetails, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    let lines = |b: Vec<u8>| {
        String::from_utf8_lossy(&b)
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    Ok(GitDetails {
        branches: lines(git(&root, &["branch", "--all", "--format=%(refname:short)"]).await?),
        remotes: lines(git(&root, &["remote"]).await?),
        history: String::from_utf8_lossy(
            &git(
                &root,
                &[
                    "log",
                    "-40",
                    "--graph",
                    "--decorate",
                    "--format=%h %s (%an)",
                ],
            )
            .await
            .unwrap_or_default(),
        )
        .into_owned(),
        stashes: lines(git(&root, &["stash", "list"]).await?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn action(action: &str, path: Option<&str>) -> GitAction {
        GitAction {
            action: action.into(),
            path: path.map(str::to_owned),
            message: None,
            reference: None,
            expected_diff: None,
            lines: None,
        }
    }
    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]).await.unwrap();
        git(
            dir.path(),
            &["config", "user.email", "test@example.invalid"],
        )
        .await
        .unwrap();
        git(dir.path(), &["config", "user.name", "Test"])
            .await
            .unwrap();
        dir
    }
    async fn seed(root: &Path, text: &str) {
        std::fs::write(root.join("file"), text).unwrap();
        git(root, &["add", "--", "file"]).await.unwrap();
        git(root, &["commit", "-m", "seed"]).await.unwrap();
    }
    async fn diff(root: &Path, staged: bool) -> String {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", "file"]);
        String::from_utf8(git(root, &args).await.unwrap()).unwrap()
    }
    #[tokio::test]
    async fn partial_new_and_deleted_files_roundtrip() {
        let dir = repo().await;
        let root = dir.path();
        std::fs::write(root.join("file"), "one\ntwo\n").unwrap();
        let d = crate::workspace::change_diff(root, "file", false)
            .await
            .unwrap();
        let line = d.lines().position(|l| l == "+two").unwrap() + 1;
        let mut a = action("stage_lines", Some("file"));
        a.expected_diff = Some(d);
        a.lines = Some(vec![line]);
        execute(root, a).await.unwrap();
        assert_eq!(git(root, &["show", ":file"]).await.unwrap(), b"two\n");
        let d = crate::workspace::change_diff(root, "file", true)
            .await
            .unwrap();
        let lines = d
            .lines()
            .enumerate()
            .filter(|(_, l)| *l == "+two")
            .map(|(i, _)| i + 1)
            .collect();
        let mut a = action("unstage_lines", Some("file"));
        a.expected_diff = Some(d);
        a.lines = Some(lines);
        execute(root, a).await.unwrap();
        assert!(git(root, &["ls-files"]).await.unwrap().is_empty());
        git(root, &["add", "file"]).await.unwrap();
        git(root, &["commit", "-m", "seed"]).await.unwrap();
        std::fs::remove_file(root.join("file")).unwrap();
        let d = crate::workspace::change_diff(root, "file", false)
            .await
            .unwrap();
        let line = d.lines().position(|l| l == "-one").unwrap() + 1;
        let mut a = action("stage_lines", Some("file"));
        a.expected_diff = Some(d);
        a.lines = Some(vec![line]);
        execute(root, a).await.unwrap();
        assert_eq!(git(root, &["show", ":file"]).await.unwrap(), b"two\n");
    }
    #[tokio::test]
    async fn unstage_rename_restores_both_index_paths() {
        let dir = repo().await;
        let root = dir.path();
        seed(root, "content\n").await;
        git(root, &["mv", "--", "file", "renamed"]).await.unwrap();
        execute(root, action("unstage", Some("renamed")))
            .await
            .unwrap();
        assert_eq!(git(root, &["ls-files"]).await.unwrap(), b"file\n");
        assert!(root.join("renamed").exists());
    }
    #[tokio::test]
    async fn stage_and_unstage_selected_replacements() {
        let dir = repo().await;
        let r = dir.path();
        seed(r, "one\ntwo\nthree\nfour\n").await;
        std::fs::write(r.join("file"), "ONE\ntwo\nthree\nFOUR\n").unwrap();
        let d = diff(r, false).await;
        let lines = d
            .lines()
            .enumerate()
            .filter(|(_, l)| matches!(*l, "-one" | "+ONE"))
            .map(|(i, _)| i + 1)
            .collect();
        let mut a = action("stage_lines", Some("file"));
        a.expected_diff = Some(d);
        a.lines = Some(lines);
        execute(r, a).await.unwrap();
        assert_eq!(
            git(r, &["show", ":file"]).await.unwrap(),
            b"ONE\ntwo\nthree\nfour\n"
        );
        let d = diff(r, true).await;
        let lines = d
            .lines()
            .enumerate()
            .filter(|(_, l)| matches!(*l, "-one" | "+ONE"))
            .map(|(i, _)| i + 1)
            .collect();
        let mut a = action("unstage_lines", Some("file"));
        a.expected_diff = Some(d);
        a.lines = Some(lines);
        execute(r, a).await.unwrap();
        assert_eq!(
            git(r, &["show", ":file"]).await.unwrap(),
            b"one\ntwo\nthree\nfour\n"
        );
        assert_eq!(
            std::fs::read(r.join("file")).unwrap(),
            b"ONE\ntwo\nthree\nFOUR\n"
        );
    }
    #[tokio::test]
    async fn stale_diff_refuses_to_mutate_index() {
        let dir = repo().await;
        let r = dir.path();
        seed(r, "old\n").await;
        std::fs::write(r.join("file"), "new\n").unwrap();
        let mut a = action("stage_lines", Some("file"));
        a.expected_diff = Some(diff(r, false).await);
        a.lines = Some(vec![6, 7]);
        std::fs::write(r.join("file"), "newer\n").unwrap();
        assert_eq!(execute(r, a).await.unwrap_err().code, "stale_diff");
        assert!(diff(r, true).await.is_empty());
    }
    #[tokio::test]
    async fn literal_names_and_unborn_unstage() {
        let dir = repo().await;
        let r = dir.path();
        std::fs::write(r.join(":(glob)*"), "literal").unwrap();
        std::fs::write(r.join("other"), "other").unwrap();
        execute(r, action("stage", Some(":(glob)*"))).await.unwrap();
        assert_eq!(git(r, &["ls-files"]).await.unwrap(), b":(glob)*\n");
        execute(r, action("unstage", Some(":(glob)*")))
            .await
            .unwrap();
        assert!(git(r, &["ls-files"]).await.unwrap().is_empty());
        assert!(r.join(":(glob)*").exists());
    }
}
