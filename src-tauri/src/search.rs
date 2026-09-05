//! Bounded project search and optimistic-concurrency checked replacement.
use crate::{
    error::AppError,
    state::AppState,
    workspace::{preview, resolve, root},
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    pub text: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: String,
    pub exclude: String,
    pub replacement: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hit {
    path: String,
    line: usize,
    column: usize,
    text: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replacement {
    pub path: String,
    pub before: String,
    pub after: String,
    pub count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Results {
    hits: Vec<Hit>,
    replacements: Vec<Replacement>,
    truncated: bool,
    files: usize,
}
fn patterns(value: &str) -> Result<globset::GlobSet, AppError> {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        for pattern in [
            pattern.to_owned(),
            format!("**/{pattern}"),
            format!("{pattern}/**"),
            format!("**/{pattern}/**"),
        ] {
            builder.add(
                globset::Glob::new(&pattern)
                    .map_err(|e| AppError::invalid_argument(e.to_string()))?,
            );
        }
    }
    builder
        .build()
        .map_err(|e| AppError::invalid_argument(e.to_string()))
}
fn search(dir: &Path, q: &Query) -> Result<Results, AppError> {
    if q.text.is_empty() || q.text.len() > 4096 {
        return Err(AppError::invalid_argument(
            "Enter a search of 1–4096 characters",
        ));
    }
    let source = if q.regex {
        q.text.clone()
    } else {
        regex::escape(&q.text)
    };
    let source = if q.whole_word {
        format!(r"\b(?:{source})\b")
    } else {
        source
    };
    let regex = regex::RegexBuilder::new(&source)
        .case_insensitive(!q.case_sensitive)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| {
            AppError::invalid_argument(format!("Unsupported or invalid regular expression: {e}"))
        })?;
    let include = patterns(&q.include)?;
    let exclude = patterns(&q.exclude)?;
    let mut result = Results {
        hits: vec![],
        replacements: vec![],
        truncated: false,
        files: 0,
    };
    let mut total = 0;
    let mut visited = 0;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    for entry in ignore::WalkBuilder::new(dir)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != ".brigadier")
        .build()
    {
        visited += 1;
        if visited > 100_000 || std::time::Instant::now() > deadline {
            result.truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry
            .path()
            .strip_prefix(dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if (!include.is_empty() && !include.is_match(&path)) || exclude.is_match(&path) {
            continue;
        }
        let Ok(file) = preview(dir, &path) else {
            continue;
        };
        if file.truncated {
            continue;
        }
        if !regex.is_match(&file.content) {
            continue;
        }
        result.files += 1;
        for (i, line) in file.content.lines().enumerate() {
            for found in regex.find_iter(line) {
                if result.hits.len() >= 2000 {
                    result.truncated = true;
                    break;
                }
                result.hits.push(Hit {
                    path: path.clone(),
                    line: i + 1,
                    column: line[..found.start()].chars().count() + 1,
                    text: line.chars().take(1000).collect(),
                });
            }
        }
        if let Some(replacement) = &q.replacement {
            let after = if q.regex {
                regex
                    .replace_all(&file.content, replacement.as_str())
                    .into_owned()
            } else {
                regex
                    .replace_all(&file.content, regex::NoExpand(replacement))
                    .into_owned()
            };
            total += file.content.len() + after.len();
            if total > 8 * 1024 * 1024 {
                result.truncated = true;
                break;
            }
            let count = regex.find_iter(&file.content).count();
            result.replacements.push(Replacement {
                path,
                before: file.content,
                after,
                count,
            });
        }
        if result.truncated {
            break;
        }
    }
    Ok(result)
}
#[tauri::command]
pub(crate) async fn workspace_search(
    project_id: String,
    session_id: Option<String>,
    query: Query,
    state: State<'_, AppState>,
) -> Result<Results, AppError> {
    let dir = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || search(&dir, &query))
        .await
        .map_err(|e| AppError::io(e.to_string()))?
}
/// Verify every before-image first. A concurrent external edit aborts without overwriting it.
fn replace(dir: &Path, changes: &[Replacement]) -> Result<usize, AppError> {
    if changes.len() > 2000
        || changes
            .iter()
            .map(|c| c.before.len() + c.after.len())
            .sum::<usize>()
            > 8 * 1024 * 1024
    {
        return Err(AppError::invalid_argument("Replacement is too large"));
    }
    let mut paths = std::collections::HashSet::new();
    for c in changes {
        if !paths.insert(&c.path) {
            return Err(AppError::invalid_argument("Duplicate replacement path"));
        }
        if preview(dir, &c.path)?.content != c.before {
            return Err(AppError::new(
                "file_conflict",
                format!("{} changed since the preview. Search again.", c.path),
            ));
        }
    }
    let mut written: Vec<&Replacement> = vec![];
    for c in changes {
        let path = resolve(dir, &c.path)?;
        if let Err(error) = write_checked(&path, &c.before, &c.after) {
            for old in written.iter().rev() {
                let _ = write_checked(&dir.join(&old.path), &old.after, &old.before);
            }
            return Err(error);
        }
        written.push(c);
    }
    Ok(written.len())
}
pub(crate) fn write_checked(path: &Path, before: &str, after: &str) -> Result<(), AppError> {
    if after.len() > 1024 * 1024 {
        return Err(AppError::invalid_argument(
            "File exceeds 1 MiB editor limit",
        ));
    }
    let current = std::fs::read_to_string(path).map_err(|e| AppError::io(e.to_string()))?;
    if current != before {
        return Err(AppError::new(
            "file_conflict",
            "File changed on disk; reload before saving",
        ));
    }
    // Write to a sibling, sync, then atomically replace; preserve executable bits.
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())
        .map_err(|e| AppError::io(e.to_string()))?;
    let permissions = std::fs::metadata(path)
        .map_err(|e| AppError::io(e.to_string()))?
        .permissions();
    temp.as_file()
        .set_permissions(permissions)
        .map_err(|e| AppError::io(e.to_string()))?;
    temp.write_all(after.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| AppError::io(e.to_string()))?;
    // Recheck immediately before replacement, including symlink containment at the caller.
    if std::fs::read_to_string(path).map_err(|e| AppError::io(e.to_string()))? != before {
        return Err(AppError::new("file_conflict", "File changed while saving"));
    }
    temp.persist(path)
        .map_err(|e| AppError::io(e.to_string()))?;
    Ok(())
}
#[tauri::command]
pub(crate) async fn workspace_replace(
    project_id: String,
    session_id: Option<String>,
    changes: Vec<Replacement>,
    state: State<'_, AppState>,
) -> Result<usize, AppError> {
    let dir = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || replace(&dir, &changes))
        .await
        .map_err(|e| AppError::io(e.to_string()))?
}
#[tauri::command]
pub(crate) async fn workspace_save(
    project_id: String,
    session_id: Option<String>,
    path: String,
    content: String,
    before: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let dir = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let relative = Path::new(&path);
        if relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
            || relative.file_name().is_none()
        {
            return Err(AppError::invalid_argument(
                "Save inside the current workspace",
            ));
        }
        if content.len() > 1024 * 1024 {
            return Err(AppError::invalid_argument("File exceeds 1 MiB"));
        }
        if dir.join(relative).exists() {
            let target = resolve(&dir, &path)?;
            write_checked(
                &target,
                before.as_deref().ok_or_else(|| {
                    AppError::new(
                        "file_exists",
                        "File exists. Open it to edit, or choose another name.",
                    )
                })?,
                &content,
            )
        } else {
            let parent = resolve(&dir, relative.parent().unwrap().to_str().unwrap_or(""))?;
            use std::io::Write;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(parent.join(relative.file_name().unwrap()))
                .and_then(|mut f| f.write_all(content.as_bytes()))
                .map_err(|e| AppError::io(e.to_string()))
        }
    })
    .await
    .map_err(|e| AppError::io(e.to_string()))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_rejects_stale_preview_and_preserves_other_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a"), "one").unwrap();
        std::fs::write(d.path().join("b"), "edited").unwrap();
        assert!(
            replace(
                d.path(),
                &[
                    Replacement {
                        path: "a".into(),
                        before: "one".into(),
                        after: "two".into(),
                        count: 1
                    },
                    Replacement {
                        path: "b".into(),
                        before: "one".into(),
                        after: "two".into(),
                        count: 1
                    }
                ]
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(d.path().join("a")).unwrap(), "one");
    }
    #[test]
    fn search_filters_and_literal_replacement() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/a.ts"), "Hello hello\n").unwrap();
        std::fs::write(d.path().join("no.md"), "hello").unwrap();
        let q = Query {
            text: "hello".into(),
            regex: false,
            case_sensitive: false,
            whole_word: true,
            include: "*.ts".into(),
            exclude: "".into(),
            replacement: Some("$literal".into()),
        };
        let root = d.path().canonicalize().unwrap();
        let r = search(&root, &q).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.replacements[0].after, "$literal $literal\n");
        replace(&root, &r.replacements).unwrap();
    }
}
