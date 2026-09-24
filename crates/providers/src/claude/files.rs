//! The files Claude Code keeps for a session, and removing exactly those.
//!
//! Everything is keyed by the session's UUID under Claude's configuration directory:
//! `projects/<encoded cwd>/<id>.jsonl` (the transcript) and `projects/<encoded cwd>/<id>/`,
//! plus `tasks/<id>`, `session-env/<id>`, `file-history/<id>`, `todos/<id>-*.json` and
//! `debug/<id>.txt`. Nothing else is touched.
//!
//! In the working directory, Claude Code stages its writes in `.claude/.cc-writes`; the part of
//! that path which did not exist before the session is removed with it, while it holds no files.
//!
//! Claude also keeps per-session temp files in `<temp>/claude-<uid>/<encoded cwd>/<id>/`
//! (`<temp>` is `CLAUDE_CODE_TMPDIR`, else `/tmp` on macOS and the system temp directory
//! elsewhere). A session started with a TMPDIR of its own gets `CLAUDE_CODE_TMPDIR` pointed
//! there and leaves nothing in the shared location; for the others the session's folder is
//! removed with it, and the per-cwd folder too when it is empty and belonged to a project
//! directory the session created.

use std::io;
use std::path::{Path, PathBuf};

use crate::model::Artifact;
use crate::{Error, Result};

/// Per-session directories and files directly under the config directory, by name.
const SESSION_DIRS: &[&str] = &["tasks", "session-env", "file-history"];
/// Where Claude Code stages atomic writes, under `<cwd>/.claude`.
const STAGING_DIR: &str = ".cc-writes";

pub(super) fn check_session_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(drop)
        .map_err(|_| Error::Invalid(format!("{id} is not a Claude session id")))
}

/// Where Claude keeps a working directory's sessions: every character that is not an ASCII
/// letter or digit becomes `-`.
pub(super) fn project_dir(config: &Path, cwd: &Path) -> PathBuf {
    let encoded: String = cwd
        .display()
        .to_string()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    config.join("projects").join(encoded)
}

/// The directories Claude Code creates under `cwd` to stage writes, outermost first:
/// `.claude`, then `.claude/.cc-writes`.
pub(super) fn staging_dirs(cwd: &Path) -> [PathBuf; 2] {
    let claude = cwd.join(".claude");
    let staging = claude.join(STAGING_DIR);
    [claude, staging]
}

pub(super) fn remove(config: &Path, artifacts: &[Artifact]) -> Result<()> {
    let mut failures = Vec::new();
    // Sessions first: a project directory can only go once the sessions in it are gone.
    let sessions = artifacts.iter().filter_map(|artifact| match artifact {
        Artifact::ClaudeSession { session_id } => Some(remove_session(config, session_id)),
        _ => None,
    });
    let dirs = artifacts.iter().filter_map(|artifact| match artifact {
        Artifact::ClaudeProjectDir { path } => Some(
            remove_project_dir(config, Path::new(path))
                .and_then(|()| remove_temp_project_dir(config, Path::new(path))),
        ),
        _ => None,
    });
    let staging = artifacts.iter().filter_map(|artifact| match artifact {
        Artifact::ClaudeStagingDir { path } => Some(remove_staging_dir(Path::new(path))),
        _ => None,
    });
    for result in sessions
        .collect::<Vec<_>>()
        .into_iter()
        .chain(dirs)
        .chain(staging)
    {
        if let Err(err) = result {
            failures.push(err.to_string());
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(Error::Io(io::Error::other(failures.join("; "))))
    }
}

fn remove_session(config: &Path, id: &str) -> Result<()> {
    check_session_id(id)?;
    let projects = config.join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let dir = entry.path();
            remove_path(&dir.join(format!("{id}.jsonl")))?;
            remove_path(&dir.join(id))?;
        }
    }
    for name in SESSION_DIRS {
        remove_path(&config.join(name).join(id))?;
    }
    remove_path(&config.join("debug").join(format!("{id}.txt")))?;
    if let Some(temp) = temp_root(config)
        && let Ok(entries) = std::fs::read_dir(&temp)
    {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                remove_path(&entry.path().join(id))?;
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(config.join("todos")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(&format!("{id}-")) {
                remove_path(&entry.path())?;
            }
        }
    }
    Ok(())
}

/// Removes a project directory the session created, but only if nothing else lives in it now
/// (the user may have started their own session there meanwhile).
fn remove_project_dir(config: &Path, dir: &Path) -> Result<()> {
    if dir.parent() != Some(config.join("projects").as_path()) {
        return Err(Error::Invalid(format!(
            "{} is not a Claude project directory",
            dir.display()
        )));
    }
    let memory = dir.join("memory");
    if is_empty_dir(&memory) {
        std::fs::remove_dir(&memory)?;
    }
    if is_empty_dir(dir) {
        std::fs::remove_dir(dir)?;
    }
    Ok(())
}

/// Claude's shared temp folder for this user (see the module docs).
fn temp_root(config: &Path) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The configuration directory is the user's own, so its owner is the uid Claude uses.
        let uid = std::fs::metadata(config).ok()?.uid();
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/tmp")
        } else {
            std::env::temp_dir()
        };
        Some(base.join(format!("claude-{uid}")))
    }
    #[cfg(not(unix))]
    {
        let _ = config;
        Some(std::env::temp_dir().join("claude"))
    }
}

/// Removes the per-cwd temp folder of a project directory the session created, while empty.
fn remove_temp_project_dir(config: &Path, project: &Path) -> Result<()> {
    let (Some(temp), Some(name)) = (temp_root(config), project.file_name()) else {
        return Ok(());
    };
    let dir = temp.join(name);
    if is_empty_dir(&dir) {
        std::fs::remove_dir(&dir)?;
    }
    Ok(())
}

/// Removes a staging directory the session created, unless it holds a file: then someone put
/// something there that is not Claude's scratch, and it stays.
fn remove_staging_dir(dir: &Path) -> Result<()> {
    let is_staging = match dir.file_name().and_then(|name| name.to_str()) {
        Some(".claude") => true,
        Some(STAGING_DIR) => dir.parent().and_then(Path::file_name) == Some(".claude".as_ref()),
        _ => false,
    };
    if !is_staging {
        return Err(Error::Invalid(format!(
            "{} is not a Claude staging directory",
            dir.display()
        )));
    }
    if holds_only_dirs(dir) {
        remove_path(dir)?;
    }
    Ok(())
}

/// Whether `dir` is a directory tree with no files (or symlinks) anywhere in it.
fn holds_only_dirs(dir: &Path) -> bool {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() => std::fs::read_dir(dir).is_ok_and(|entries| {
            entries
                .into_iter()
                .all(|entry| entry.is_ok_and(|entry| holds_only_dirs(&entry.path())))
        }),
        _ => false,
    }
}

fn is_empty_dir(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
}

fn remove_path(path: &Path) -> Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => Err(err),
    };
    match result {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::Io(io::Error::new(
            err.kind(),
            format!("{}: {err}", path.display()),
        ))),
    }
}
