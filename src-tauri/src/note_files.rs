//! Markdown is the content authority; app metadata retains stable mention IDs and revisions.
use crate::{
    error::AppError,
    workbench_data::{Data, Note},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub path: String,
    pub identity: String,
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::invalid_argument("Missing parent folder"))?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|e| AppError::io(e.to_string()))?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}
fn folder(dir: &Path, data: &Data) -> PathBuf {
    data.notes_folder
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("notes"))
}
fn identity(path: &Path) -> Result<String, AppError> {
    let m = std::fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() {
        return Err(AppError::invalid_argument(
            "Notes must be regular Markdown files",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(path.to_string_lossy().into_owned())
    }
}
fn resolve(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    if Path::new(relative)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::invalid_argument("Invalid note path"));
    }
    let path = root.join(relative);
    let parent = path.parent().unwrap().canonicalize()?;
    if !parent.starts_with(root.canonicalize()?) {
        return Err(AppError::invalid_argument(
            "Note is outside the notes folder",
        ));
    }
    if let Ok(m) = std::fs::symlink_metadata(&path) {
        if !m.is_file() || m.file_type().is_symlink() {
            return Err(AppError::invalid_argument("Note is not a regular file"));
        }
    }
    Ok(path)
}
fn available_path(root: &Path, title: &str) -> PathBuf {
    let stem: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim().trim_matches('.');
    let stem = if stem.is_empty() { "Untitled" } else { stem };
    let mut path = root.join(format!("{stem}.md"));
    let mut suffix = 2;
    while path.exists() {
        path = root.join(format!("{stem} ({suffix}).md"));
        suffix += 1;
    }
    path
}
pub(crate) fn save(dir: &Path, data: &mut Data, note: &Note) -> Result<(), AppError> {
    let root = folder(dir, data);
    let old = data
        .note_files
        .get(&note.id)
        .map(|e| resolve(&root, &e.path))
        .transpose()?;
    let renamed = data
        .notes
        .iter()
        .any(|n| n.id == note.id && n.title != note.title);
    let path = if old.is_none() || renamed {
        available_path(&root, &note.title)
    } else {
        old.clone().unwrap()
    };
    if let (Some(old_path), Some(previous)) = (&old, data.notes.iter().find(|n| n.id == note.id)) {
        if std::fs::read(old_path)? != previous.content.as_bytes() {
            return Err(AppError::new(
                "note_conflict",
                "This note changed elsewhere. Reopen it before saving.",
            ));
        }
    }
    atomic_write(&path, note.content.as_bytes())?;
    if let Some(old) = old {
        if old != path {
            std::fs::remove_file(old)?;
        }
    }
    data.note_files.insert(
        note.id.clone(),
        Entry {
            path: path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            identity: identity(&path)?,
        },
    );
    Ok(())
}
pub(crate) fn delete(dir: &Path, data: &mut Data, id: &str) -> Result<(), AppError> {
    if let Some(error) = &data.notes_error {
        return Err(AppError::io(error));
    }
    if let Some(entry) = data.note_files.get(id) {
        std::fs::remove_file(resolve(&folder(dir, data), &entry.path)?)?;
    }
    data.note_files.remove(id);
    Ok(())
}
fn scan(root: &Path, at: &Path, files: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in std::fs::read_dir(at)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            if !entry.file_name().to_string_lossy().starts_with('.') {
                scan(root, &entry.path(), files)?;
            }
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        {
            if files.len() >= 500 {
                return Err(AppError::invalid_argument(
                    "Notes folder exceeds 500 Markdown files",
                ));
            }
            files.push(entry.path().strip_prefix(root).unwrap().to_owned());
        }
    }
    Ok(())
}
pub(crate) fn refresh(dir: &Path, data: &mut Data) -> Result<(), AppError> {
    let root = folder(dir, data);
    // A selected external folder must remain available; never recreate a disconnected mount.
    if data.notes_folder.is_none() {
        std::fs::create_dir_all(&root)?;
    }
    if !root.is_dir() {
        return Err(AppError::io(
            "Notes folder is unavailable. Reconnect it or choose another folder in Settings.",
        ));
    }
    if !data.notes_migrated {
        for note in data.notes.clone() {
            save(dir, data, &note)?;
        }
        data.notes_migrated = true;
    }
    let mut paths = Vec::new();
    scan(&root, &root, &mut paths)?;
    paths.sort();
    let mut entries = BTreeMap::new();
    let mut notes = Vec::new();
    for relative in paths {
        let path = root.join(&relative);
        if std::fs::metadata(&path)?.len() > 128 * 1024 {
            return Err(AppError::invalid_argument(format!(
                "Note {} exceeds 128 KiB",
                relative.display()
            )));
        }
        let content = std::fs::read_to_string(&path)?;
        let key = relative.to_string_lossy().into_owned();
        let identity = identity(&path)?;
        // Paths survive editor atomic saves; inode identity preserves external renames on macOS.
        let existing = data
            .note_files
            .iter()
            .find(|(_, e)| e.path == key)
            .or_else(|| {
                data.note_files
                    .iter()
                    .find(|(_, e)| e.identity == identity && !root.join(&e.path).exists())
            });
        let mut note = existing
            .and_then(|(id, _)| data.notes.iter().find(|n| &n.id == id))
            .cloned()
            .unwrap_or_else(|| Note {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 0,
                language: "markdown".into(),
                ..Note::default()
            });
        let title = path.file_stem().unwrap().to_string_lossy().into_owned();
        if note.content != content || note.title != title || note.revision == 0 {
            note.revision += 1;
        }
        note.title = title;
        note.content = content;
        entries.insert(
            note.id.clone(),
            Entry {
                path: key,
                identity,
            },
        );
        notes.push(note);
    }
    data.notes = notes;
    data.note_files = entries;
    data.notes_error = None;
    Ok(())
}
pub(crate) fn change_folder(dir: &Path, data: &mut Data, selected: &str) -> Result<(), AppError> {
    let selected = Path::new(selected).canonicalize()?;
    if !selected.is_dir() {
        return Err(AppError::invalid_argument("Choose a notes folder"));
    }
    if folder(dir, data).canonicalize().ok().as_ref() == Some(&selected) {
        return Ok(());
    }
    let mut next = data.clone();
    next.notes_folder = Some(selected.to_string_lossy().into_owned());
    next.note_files.clear();
    next.notes_migrated = false;
    next.notes_error = None;
    refresh(dir, &mut next)?;
    *data = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_external_edit_rename_delete_keep_references() {
        let dir = tempfile::tempdir().unwrap();
        let mut data = Data::default();
        data.notes.push(Note {
            id: "stable-reference".into(),
            title: "Ideas".into(),
            content: "hello".into(),
            revision: 4,
            ..Note::default()
        });
        refresh(dir.path(), &mut data).unwrap();
        let path = dir.path().join("notes/Ideas.md");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
        std::fs::write(&path, "external edit").unwrap();
        refresh(dir.path(), &mut data).unwrap();
        assert_eq!(data.notes[0].revision, 5);
        std::fs::rename(path, dir.path().join("notes/Renamed.md")).unwrap();
        refresh(dir.path(), &mut data).unwrap();
        assert_eq!(data.notes[0].id, "stable-reference");
        assert_eq!(data.notes[0].title, "Renamed");
        std::fs::remove_file(dir.path().join("notes/Renamed.md")).unwrap();
        refresh(dir.path(), &mut data).unwrap();
        assert!(data.notes.is_empty());
    }
    #[test]
    fn folder_change_preserves_existing_files_and_ids() {
        let dir = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let mut data = Data::default();
        data.notes.push(Note {
            id: "stable".into(),
            title: "Ideas".into(),
            content: "mine".into(),
            revision: 1,
            ..Note::default()
        });
        refresh(dir.path(), &mut data).unwrap();
        std::fs::write(external.path().join("Ideas.md"), "existing").unwrap();
        change_folder(dir.path(), &mut data, external.path().to_str().unwrap()).unwrap();
        assert_eq!(data.notes.len(), 2);
        assert!(data
            .notes
            .iter()
            .any(|n| n.id == "stable" && n.content == "mine"));
        assert_eq!(
            std::fs::read_to_string(external.path().join("Ideas.md")).unwrap(),
            "existing"
        );
    }
}
