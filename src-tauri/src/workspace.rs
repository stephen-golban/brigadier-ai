//! Local workspace inspection. Roots come from registered rows, never arbitrary UI paths.
use crate::{error::AppError, state::AppState};
use brigadier_core::event::SessionId;
use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
pub(crate) struct Entry {
    name: String,
    path: String,
    directory: bool,
}
#[derive(Serialize)]
pub(crate) struct FilePreview {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}
#[derive(Serialize)]
pub(crate) struct Change {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub original: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct GitStatus {
    branch: String,
    changes: Vec<Change>,
    additions: usize,
    deletions: usize,
    ahead: usize,
    behind: usize,
}

pub(crate) async fn root(
    state: &AppState,
    project_id: &str,
    session_id: Option<&str>,
) -> Result<PathBuf, AppError> {
    let supervisor = &state.get()?.supervisor;
    let project = supervisor
        .project(project_id)
        .await?
        .ok_or_else(|| AppError::new("no_such_project", "Project no longer exists"))?;
    let path = if let Some(id) = session_id {
        let session = state
            .get()?
            .store()
            .session(SessionId::new(id))
            .await?
            .ok_or_else(|| AppError::new("no_such_session", "Session no longer exists"))?;
        if session.project_id.as_deref() != Some(project_id) {
            return Err(AppError::invalid_argument(
                "Session does not belong to this project",
            ));
        }
        session.cwd.unwrap_or(project.root_path)
    } else {
        project.root_path
    };
    path.canonicalize()
        .map_err(|e| AppError::io(format!("Workspace unavailable: {e}")))
}

pub(crate) fn resolve(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(AppError::invalid_argument(
            "Use a path inside this workspace",
        ));
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| AppError::io(e.to_string()))?;
    if !path.starts_with(root) {
        return Err(AppError::invalid_argument(
            "Path points outside this workspace",
        ));
    }
    Ok(path)
}

pub(crate) fn preview(root: &Path, relative: &str) -> Result<FilePreview, AppError> {
    let path = resolve(root, relative)?;
    let metadata = path.metadata().map_err(|e| AppError::io(e.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::invalid_argument(
            "Only regular files can be previewed",
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(512 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|e| AppError::io(e.to_string()))?;
    if bytes.contains(&0) {
        return Err(AppError::invalid_argument(
            "Binary file; use Reveal in Finder to open it",
        ));
    }
    let truncated = bytes.len() > 512 * 1024;
    bytes.truncate(512 * 1024);
    Ok(FilePreview {
        path: relative.to_owned(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

#[tauri::command]
pub(crate) async fn workspace_entries(
    project_id: String,
    session_id: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Entry>, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve(&root, &path)?;
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(dir)
            .map_err(|e| AppError::io(e.to_string()))?
            .take(2001)
        {
            let entry = entry.map_err(|e| AppError::io(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            if entries.len() == 2000 {
                return Err(AppError::invalid_argument(
                    "Directory exceeds 2,000 entries",
                ));
            }
            let relative = if path.is_empty() {
                name.clone()
            } else {
                format!("{path}/{name}")
            };
            // Listing a symlink is safe; opening it rechecks the canonical containment boundary.
            let directory = entry
                .file_type()
                .map_err(|e| AppError::io(e.to_string()))?
                .is_dir();
            entries.push(Entry {
                name,
                path: relative,
                directory,
            });
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
    .map_err(|e| AppError::io(e.to_string()))?
}

#[tauri::command]
pub(crate) async fn workspace_file(
    project_id: String,
    session_id: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> Result<FilePreview, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || preview(&root, &path))
        .await
        .map_err(|e| AppError::io(e.to_string()))?
}

pub(crate) async fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, AppError> {
    let mut cmd = tokio::process::Command::new("/usr/bin/git");
    cmd.current_dir(root)
        .args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    use tokio::io::AsyncReadExt;
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::io(e.to_string()))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    async fn bounded_read(
        reader: impl tokio::io::AsyncRead + Unpin,
        limit: usize,
    ) -> Result<Vec<u8>, AppError> {
        let mut bytes = Vec::new();
        reader
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| AppError::io(e.to_string()))?;
        if bytes.len() > limit {
            return Err(AppError::invalid_argument(
                "Git output exceeds the preview limit; inspect it in a terminal",
            ));
        }
        Ok(bytes)
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        tokio::try_join!(
            bounded_read(stdout, 2 * 1024 * 1024),
            bounded_read(stderr, 64 * 1024),
            async { child.wait().await.map_err(|e| AppError::io(e.to_string())) }
        )
    })
    .await
    .map_err(|_| AppError::io("Git inspection timed out"));
    let (stdout, stderr, status) = match result.and_then(|r| r) {
        Ok(out) => out,
        Err(e) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(e);
        }
    };
    if !status.success() && !(args.contains(&"--no-index") && status.code() == Some(1)) {
        return Err(AppError::io(
            String::from_utf8_lossy(&stderr).trim().to_owned(),
        ));
    }
    Ok(stdout)
}

pub(crate) fn parse_status(bytes: &[u8]) -> Vec<Change> {
    let mut records = bytes.split(|b| *b == 0).filter(|s| !s.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        changes.push(Change {
            path: String::from_utf8_lossy(&record[3..]).into_owned(),
            index: (record[0] as char).to_string(),
            worktree: (record[1] as char).to_string(),
            original: None,
        });
        if record[0] == b'R' || record[0] == b'C' || record[1] == b'R' || record[1] == b'C' {
            changes.last_mut().unwrap().original = records
                .next()
                .map(|r| String::from_utf8_lossy(r).into_owned());
        }
    }
    changes
}

#[tauri::command]
pub(crate) async fn workspace_git(
    project_id: String,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<GitStatus, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    let bytes = git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let branch = git(&root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .unwrap_or_else(|_| b"Detached HEAD".to_vec());
    let mut additions = 0;
    let mut deletions = 0;
    for args in [
        vec!["diff", "--numstat", "--no-ext-diff", "--no-textconv"],
        vec![
            "diff",
            "--cached",
            "--numstat",
            "--no-ext-diff",
            "--no-textconv",
        ],
    ] {
        if let Ok(bytes) = git(&root, &args).await {
            for line in String::from_utf8_lossy(&bytes).lines() {
                let mut cols = line.split('\t');
                additions += cols
                    .next()
                    .and_then(|x| x.parse::<usize>().ok())
                    .unwrap_or(0);
                deletions += cols
                    .next()
                    .and_then(|x| x.parse::<usize>().ok())
                    .unwrap_or(0);
            }
        }
    }
    let divergence = git(
        &root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .await
    .unwrap_or_default();
    let divergence = String::from_utf8_lossy(&divergence);
    let mut counts = divergence.split_whitespace();
    let ahead = counts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let behind = counts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    Ok(GitStatus {
        additions,
        deletions,
        ahead,
        behind,
        branch: String::from_utf8_lossy(&branch).trim().to_owned(),
        changes: parse_status(&bytes),
    })
}

#[tauri::command]
pub(crate) async fn workspace_diff(
    project_id: String,
    session_id: Option<String>,
    path: String,
    staged: bool,
    state: State<'_, AppState>,
) -> Result<FilePreview, AppError> {
    let root = root(state.inner(), &project_id, session_id.as_deref()).await?;
    // Deleted paths need not exist, but may never escape the root or become a pathspec expression.
    if Path::new(&path)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || path.is_empty()
    {
        return Err(AppError::invalid_argument("Invalid change path"));
    }
    let content = change_diff(&root, &path, staged).await?;
    Ok(FilePreview {
        path,
        content,
        truncated: false,
    })
}

pub(crate) async fn change_diff(root: &Path, path: &str, staged: bool) -> Result<String, AppError> {
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let mut bytes = git(root, &args).await?;
    if bytes.is_empty()
        && !staged
        && git(root, &["status", "--porcelain=v1", "-z", "--", path])
            .await?
            .starts_with(b"?? ")
    {
        // no-index describes a new file without modifying the real index.
        bytes = git(
            root,
            &[
                "diff",
                "--no-index",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                "/dev/null",
                path,
            ],
        )
        .await?;
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_escape_and_binary_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(resolve(&root, "../escape").is_err());
        assert!(resolve(&root, "/etc/passwd").is_err());
        std::fs::write(root.join("binary"), b"a\0b").unwrap();
        assert!(preview(&root, "binary").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();
            assert!(preview(&root, "link").is_err());
        }
    }
    #[test]
    fn rename_consumes_original_path_and_keeps_unusual_names() {
        let changes = parse_status(b"R  new name\0old name\0 M another\nfile\0?? :literal\0");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "new name");
        assert_eq!(changes[1].path, "another\nfile");
        assert_eq!(changes[2].path, ":literal");
    }
}
