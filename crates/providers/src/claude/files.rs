//! The files Claude Code keeps for a session, and removing exactly those.
//!
//! Everything is keyed by the session's UUID under Claude's configuration directory:
//! `projects/<encoded cwd>/<id>.jsonl` (the transcript) and `projects/<encoded cwd>/<id>/`,
//! plus `tasks/<id>`, `session-env/<id>`, `file-history/<id>`, `todos/<id>-*.json` and
//! `debug/<id>.txt`. Nothing else is touched.
//!
//! In the working directory, Claude Code stages its writes in `.claude/.cc-writes`; the part of
//! that path which did not exist before the session is removed with it, while it holds no files.

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

/// Claude Code's write-staging directory under `cwd`, or its `.claude` parent, whichever the
/// session would create. `None` when both already exist.
pub(super) fn new_staging_dir(cwd: &Path) -> Option<PathBuf> {
    let claude = cwd.join(".claude");
    let staging = claude.join(STAGING_DIR);
    if !claude.exists() {
        Some(claude)
    } else if !staging.exists() {
        Some(staging)
    } else {
        None
    }
}

pub(super) fn remove(config: &Path, artifacts: &[Artifact]) -> Result<()> {
    let mut failures = Vec::new();
    // Sessions first: a project directory can only go once the sessions in it are gone.
    let sessions = artifacts.iter().filter_map(|artifact| match artifact {
        Artifact::ClaudeSession { session_id } => Some(remove_session(config, session_id)),
        _ => None,
    });
    let dirs = artifacts.iter().filter_map(|artifact| match artifact {
        Artifact::ClaudeProjectDir { path } => Some(remove_project_dir(config, Path::new(path))),
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
