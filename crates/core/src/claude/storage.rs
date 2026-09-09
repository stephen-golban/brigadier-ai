//! Local Claude session disposal. Matches the SDK's transcript + sibling-subagents
//! layout: https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/session_mutations.py
//! Only exact provider UUIDs are removed; project folders and account settings survive.
use crate::driver::DriverError;
use std::path::Path;

fn remove(path: &Path) -> Result<(), DriverError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub(super) fn delete(config: &Path, id: &str) -> Result<(), DriverError> {
    if uuid::Uuid::parse_str(id).is_err() || id.contains(['/', '\\']) {
        return Err(DriverError::Protocol(
            "Invalid provider session UUID for cleanup".into(),
        ));
    }
    let projects = config.join("projects");
    match std::fs::read_dir(&projects) {
        Ok(dirs) => {
            for directory in dirs {
                let directory = directory?;
                if !directory.file_type()?.is_dir() {
                    continue;
                }
                let path = directory.path();
                // Remove children first so a failed unlink can be retried by the same ID.
                remove(&path.join(id))?;
                remove(&path.join(format!("{id}.jsonl")))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // Session-scoped recovery and debug files use the same provider UUID.
    for kind in ["file-history", "session-env", "tasks"] {
        let base = config.join(kind);
        if base.is_symlink() {
            return Err(DriverError::Protocol(
                "Session storage directory is a symlink".into(),
            ));
        }
        remove(&base.join(id))?;
    }
    let debug = config.join("debug");
    if !debug.is_symlink() {
        remove(&debug.join(format!("{id}.txt")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_only_the_requested_transcript_and_children_and_is_retryable() {
        let temp = tempfile::tempdir().unwrap();
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let project = temp.path().join("projects/repo");
        std::fs::create_dir_all(project.join(id).join("subagents")).unwrap();
        std::fs::write(project.join(format!("{id}.jsonl")), "chat").unwrap();
        std::fs::write(project.join(id).join("subagents/agent.jsonl"), "child").unwrap();
        std::fs::write(project.join("other.jsonl"), "keep").unwrap();
        std::fs::write(temp.path().join("settings.json"), "keep").unwrap();
        delete(temp.path(), id).unwrap();
        delete(temp.path(), id).unwrap();
        assert!(!project.join(id).exists());
        assert!(!project.join(format!("{id}.jsonl")).exists());
        assert!(project.join("other.jsonl").exists());
        assert!(temp.path().join("settings.json").exists());
        assert!(delete(temp.path(), "../other").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_project_or_subagent_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let outside = temp.path().join("outside");
        let project = temp.path().join("config/projects/repo");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(outside.join("precious"), "keep").unwrap();
        symlink(&outside, project.join(id)).unwrap();
        symlink(&outside, project.parent().unwrap().join("linked")).unwrap();
        delete(&temp.path().join("config"), id).unwrap();
        assert!(outside.join("precious").exists());
    }
}
