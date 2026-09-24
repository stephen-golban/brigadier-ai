//! The files Claude Code keeps for a session, and removing exactly those.
//!
//! Everything is keyed by the session's UUID under Claude's configuration directory:
//! `projects/<encoded cwd>/<id>.jsonl` (the transcript) and `projects/<encoded cwd>/<id>/`,
//! plus `tasks/<id>`, `session-env/<id>`, `file-history/<id>`, `todos/<id>-*.json` and
//! `debug/<id>.txt`. Nothing else is touched.

use std::io;
use std::path::{Path, PathBuf};

use crate::model::Artifact;
use crate::{Error, Result};

/// Per-session directories and files directly under the config directory, by name.
const SESSION_DIRS: &[&str] = &["tasks", "session-env", "file-history"];

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

pub(super) fn remove(config: &Path, artifacts: &[Artifact]) -> Result<()> {
    let mut failures = Vec::new();
    for artifact in artifacts {
        let result = match artifact {
            Artifact::ClaudeSession { session_id } => remove_session(config, session_id),
            Artifact::ClaudeProjectDir { path } => remove_project_dir(config, Path::new(path)),
            _ => Ok(()),
        };
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
