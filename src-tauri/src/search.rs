//! Bounded project search and optimistic-concurrency checked replacement.
use crate::{
    error::AppError,
    state::AppState,
    workspace::{preview, resolve, root},
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::State;
#[derive(Serialize)]
pub(crate) struct FileResults {
    paths: Vec<String>,
    truncated: bool,
}

fn find_files(dir: &Path, query: &str) -> FileResults {
    find_files_with_limits(dir, query, 100_000, Duration::from_secs(2))
}

fn find_files_with_limits(
    dir: &Path,
    query: &str,
    max_entries: usize,
    timeout: Duration,
) -> FileResults {
    let deadline = Instant::now() + timeout;
    let query = query.to_lowercase();
    let mut result = FileResults {
        paths: vec![],
        truncated: false,
    };
    for (visited, entry) in ignore::WalkBuilder::new(dir)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git" && e.file_name() != ".brigadier")
        .build()
        .enumerate()
    {
        if visited >= max_entries || Instant::now() >= deadline {
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
        // The relative path includes the filename; no preview or content reads are needed.
        // An empty query lists all files, subject to the same traversal and result caps.
        if path.to_lowercase().contains(&query) {
            result.paths.push(path);
            if result.paths.len() >= 2000 {
                result.truncated = true;
                break;
            }
        }
    }
    result.paths.sort();
    result
}

#[tauri::command]
pub(crate) async fn workspace_find_files(
    project_id: String,
    session_id: Option<String>,
    query: String,
    state: State<'_, AppState>,
) -> Result<FileResults, AppError> {
    let dir = root(state.inner(), &project_id, session_id.as_deref()).await?;
    tauri::async_runtime::spawn_blocking(move || find_files(&dir, &query))
        .await
        .map_err(|e| AppError::io(e.to_string()))
}

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
    #[serde(default)]
    pub use_ignore_files: Option<bool>,
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    #[serde(default)]
    pub include_all: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hit {
    path: String,
    line: usize,
    column: usize,
    end_column: usize,
    end_line: usize,
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
    // Commas inside brace alternatives or character classes belong to the glob.
    let mut depth = 0usize;
    let parts = value.split(|c| match c {
        '{' | '[' => {
            depth += 1;
            false
        }
        '}' | ']' => {
            depth = depth.saturating_sub(1);
            false
        }
        ',' => depth == 0,
        _ => false,
    });
    for pattern in parts.map(str::trim).filter(|s| !s.is_empty()) {
        let mut variants = vec![pattern.to_owned(), format!("{pattern}/**")];
        if !pattern.contains('/') {
            variants.extend([format!("**/{pattern}"), format!("**/{pattern}/**")]);
        }
        for pattern in variants {
            builder.add(
                globset::GlobBuilder::new(&pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|e| AppError::invalid_argument(e.to_string()))?,
            );
        }
    }
    builder
        .build()
        .map_err(|e| AppError::invalid_argument(e.to_string()))
}
fn search(dir: &Path, q: &Query) -> Result<Results, AppError> {
    search_visited(dir, q).map(|(results, _)| results)
}

/// Runs a search and also reports how many walk entries it visited. Tests assert the
/// count so an explicit-path search cannot silently regress into a full traversal.
fn search_visited(dir: &Path, q: &Query) -> Result<(Results, usize), AppError> {
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
        .multi_line(true)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| {
            AppError::invalid_argument(format!("Unsupported or invalid regular expression: {e}"))
        })?;
    let include = patterns(&q.include)?;
    let include_all = q
        .include_all
        .iter()
        .map(|value| patterns(value))
        .collect::<Result<Vec<_>, _>>()?;
    let exclude = patterns(&q.exclude)?;
    let mut result = Results {
        hits: vec![],
        replacements: vec![],
        truncated: false,
        files: 0,
    };
    let mut total = 0;
    let mut visited = 0usize;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    // `paths` scopes a search to explicit candidates. Prune the walk to those candidates and
    // the directories on the way to them rather than traversing the whole root. The prune
    // reuses the walk itself, so ignore layers, hidden handling, `.git`/`.brigadier` pruning,
    // `follow_links(false)` and iteration order are the walk's own; the membership test below
    // is unchanged, so the prune can only drop entries that post-filter would have dropped.
    // Candidates are compared against the walk's normalization — relative to the root with
    // backslashes rewritten to forward slashes — so `./a.ts`, an absolute path and `src\a.ts`
    // select nothing, exactly as they select nothing in the post-filter. That is deliberate
    // and unchanged: the sole producer (src/vscode-panels/workspace.ts) sends normalized
    // workspace-relative paths.
    let scope = q.paths.as_ref().map(|paths| {
        let candidates: std::collections::HashSet<String> = paths.iter().cloned().collect();
        let ancestors: std::collections::HashSet<String> = paths
            .iter()
            .flat_map(|path| path.match_indices('/').map(|(i, _)| path[..i].to_owned()))
            .collect();
        (candidates, ancestors)
    });
    let scope_root = dir.to_path_buf();
    for entry in ignore::WalkBuilder::new(dir)
        .hidden(false)
        .git_ignore(q.use_ignore_files.unwrap_or(true))
        .git_global(q.use_ignore_files.unwrap_or(true))
        .git_exclude(q.use_ignore_files.unwrap_or(true))
        .ignore(q.use_ignore_files.unwrap_or(true))
        .follow_links(false)
        .filter_entry(move |e| {
            if e.file_name() == ".git" || e.file_name() == ".brigadier" {
                return false;
            }
            let Some((candidates, ancestors)) = &scope else {
                return true;
            };
            let Ok(relative) = e.path().strip_prefix(&scope_root) else {
                return true;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            relative.is_empty()
                || candidates.contains(&relative)
                || ancestors.contains(&relative)
        })
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
        if include_all
            .iter()
            .any(|patterns| !patterns.is_empty() && !patterns.is_match(&path))
        {
            continue;
        }
        if q.paths.as_ref().is_some_and(|paths| !paths.contains(&path)) {
            continue;
        }
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
        let line_starts: Vec<usize> = std::iter::once(0)
            .chain(file.content.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        for found in regex.find_iter(&file.content) {
            if result.hits.len() >= 2000 {
                result.truncated = true;
                break;
            }
            let line = line_starts.partition_point(|start| *start <= found.start());
            let line_start = line_starts[line - 1];
            let end_line = line_starts.partition_point(|start| *start <= found.end());
            let end_start = line_starts[end_line - 1];
            let preview_end = file.content[found.end()..]
                .find('\n')
                .map(|i| i + found.end())
                .unwrap_or(file.content.len());
            result.hits.push(Hit {
                path: path.clone(),
                line,
                column: file.content[line_start..found.start()]
                    .encode_utf16()
                    .count()
                    + 1,
                end_column: file.content[end_start..found.end()].encode_utf16().count(),
                end_line,
                text: file.content[line_start..preview_end].to_owned(),
            });
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
    Ok((result, visited))
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
    fn find_files_discovers_nested_unopened_files_without_previewing_contents() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("src/unopened/deep")).unwrap();
        std::fs::write(d.path().join("src/unopened/deep/App.tsx"), "").unwrap();
        std::fs::write(d.path().join("notes.txt"), "App.tsx").unwrap();
        // Binary files larger than the content-preview limit are still filename matches.
        std::fs::write(d.path().join("App.bin"), vec![0; 512 * 1024 + 1]).unwrap();

        let result = find_files(d.path(), "App.");
        assert_eq!(result.paths, ["App.bin", "src/unopened/deep/App.tsx"]);
        assert!(!result.truncated);
        assert!(find_files(d.path(), "missing").paths.is_empty());
    }

    #[test]
    fn find_files_matches_case_insensitive_filenames_and_relative_paths() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/App.tsx"), "").unwrap();
        std::fs::write(d.path().join("README.md"), "").unwrap();

        assert_eq!(find_files(d.path(), "aPP.TSX").paths, ["src/App.tsx"]);
        assert_eq!(find_files(d.path(), "SRC/aPP").paths, ["src/App.tsx"]);
        assert_eq!(find_files(d.path(), "readME").paths, ["README.md"]);
        let result = find_files(d.path(), "");
        assert_eq!(result.paths, ["README.md", "src/App.tsx"]);
        assert!(!result.truncated);
    }

    #[test]
    fn find_files_respects_ignore_rules_and_skips_internals_but_includes_hidden_files() {
        let d = tempfile::tempdir().unwrap();
        for dir in [
            ".git",
            ".brigadier",
            "ignored",
            "src/.brigadier",
            "src/.git",
        ] {
            std::fs::create_dir_all(d.path().join(dir)).unwrap();
            std::fs::write(d.path().join(dir).join("needle.txt"), "").unwrap();
        }
        std::fs::write(d.path().join(".gitignore"), "ignored/\n*.log\n").unwrap();
        std::fs::write(d.path().join(".ignore"), "needle.tmp\n").unwrap();
        std::fs::write(d.path().join("src/.gitignore"), "needle.local\n").unwrap();
        for path in [
            "needle.log",
            "needle.tmp",
            "src/needle.local",
            ".needle.txt",
            "src/needle.txt",
        ] {
            std::fs::write(d.path().join(path), "").unwrap();
        }

        let result = find_files(d.path(), "needle");
        assert_eq!(result.paths, [".needle.txt", "src/needle.txt"]);
        assert!(!result.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn find_files_skips_file_and_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("real")).unwrap();
        std::fs::write(d.path().join("real/needle.txt"), "").unwrap();
        std::fs::write(outside.path().join("needle.txt"), "").unwrap();
        symlink("real/needle.txt", d.path().join("needle-link.txt")).unwrap();
        symlink("real", d.path().join("linked-dir")).unwrap();
        symlink(outside.path(), d.path().join("outside")).unwrap();
        symlink(
            outside.path().join("needle.txt"),
            d.path().join("needle-outside.txt"),
        )
        .unwrap();
        symlink("missing", d.path().join("needle-dangling.txt")).unwrap();
        symlink(d.path(), d.path().join("real/loop")).unwrap();

        let result = find_files(d.path(), "needle");
        assert_eq!(result.paths, ["real/needle.txt"]);
        assert!(!result.truncated);
    }

    #[test]
    fn find_files_caps_results() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..2001 {
            std::fs::write(d.path().join(format!("file-{i}.txt")), "").unwrap();
        }

        let result = find_files(d.path(), "file-");
        assert_eq!(result.paths.len(), 2000);
        assert!(result.truncated);
    }

    #[test]
    fn find_files_bounds_traversal_even_without_matches() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("a/b/c")).unwrap();

        let result = find_files_with_limits(d.path(), "missing", 2, Duration::from_secs(2));
        assert!(result.paths.is_empty());
        assert!(result.truncated);

        let result = find_files_with_limits(d.path(), "", 100_000, Duration::ZERO);
        assert!(result.paths.is_empty());
        assert!(result.truncated);
    }

    #[test]
    fn replacement_rejects_stale_preview_and_preserves_other_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a"), "one").unwrap();
        std::fs::write(d.path().join("b"), "edited").unwrap();
        assert!(replace(
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
        .is_err());
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
            paths: None,
            include_all: vec![],
            use_ignore_files: None,
        };
        let root = d.path().canonicalize().unwrap();
        let r = search(&root, &q).unwrap();
        assert_eq!(r.hits.len(), 2);
        assert_eq!(r.replacements[0].after, "$literal $literal\n");
        replace(&root, &r.replacements).unwrap();
    }
    #[test]
    fn vscode_search_ranges_use_utf16_and_support_multiline_matches() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "😀hello\nworld\n").unwrap();
        let q = Query {
            text: "hello\nworld".into(),
            regex: false,
            case_sensitive: true,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
            replacement: None,
            use_ignore_files: None,
            paths: None,
            include_all: vec![],
        };
        let result = search(&d.path().canonicalize().unwrap(), &q).unwrap();
        assert_eq!(result.hits.len(), 1);
        let hit = &result.hits[0];
        assert_eq!(
            (hit.line, hit.column, hit.end_line, hit.end_column),
            (1, 3, 2, 5)
        );
        assert_eq!(hit.text, "😀hello\nworld");
    }
    #[test]
    fn vscode_globs_preserve_brace_alternatives_and_folder_boundaries() {
        let globs = patterns("src/*.{ts,tsx}, README.md").unwrap();
        assert!(globs.is_match("src/a.ts"));
        assert!(globs.is_match("src/a.tsx"));
        assert!(globs.is_match("docs/README.md"));
        assert!(!globs.is_match("nested/src/a.ts"));
        assert!(!globs.is_match("src/nested/a.ts"));
        assert!(!globs.is_match("src/a.js"));
    }
    /// A tree that exercises every rule the explicit-path scope has to preserve:
    /// hidden files, ignored files and directories, `.git`/`.brigadier`, a file symlink,
    /// a directory symlink, a non-regular file, an oversized file, a NUL file and a
    /// directory named as a candidate.
    fn parity_fixture() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for dir in [
            "src",
            "src/nested",
            ".hidden-dir",
            "ignored-dir",
            ".git",
            ".brigadier",
            "src/.brigadier",
        ] {
            std::fs::create_dir_all(d.path().join(dir)).unwrap();
        }
        for path in [
            "src/a.ts",
            "src/nested/b.ts",
            "src/.brigadier/hidden-internal.ts",
            ".hidden.ts",
            ".hidden-dir/c.ts",
            "ignored.ts",
            "ignored-dir/d.ts",
            "tmp-ignored.ts",
            ".git/config.ts",
            ".brigadier/state.ts",
            "plain.txt",
        ] {
            std::fs::write(d.path().join(path), "needle here\nneedle again\n").unwrap();
        }
        std::fs::write(d.path().join(".gitignore"), "ignored.ts\nignored-dir/\n").unwrap();
        std::fs::write(d.path().join(".ignore"), "tmp-ignored.ts\n").unwrap();
        std::fs::write(
            d.path().join("big.ts"),
            "needle\n".repeat(512 * 1024 / 7 + 32),
        )
        .unwrap();
        std::fs::write(d.path().join("nul.ts"), b"needle\0more\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("src/a.ts", d.path().join("link.ts")).unwrap();
            symlink("src", d.path().join("linked-dir")).unwrap();
            assert!(
                std::process::Command::new("mkfifo")
                    .arg(d.path().join("fifo.ts"))
                    .status()
                    .unwrap()
                    .success()
            );
        }
        d
    }

    fn parity_candidates(dir: &Path) -> Vec<String> {
        let mut paths: Vec<String> = [
            "src/a.ts",
            "src/a.ts", // duplicate: visited once, reported once
            "src/nested/b.ts",
            "src/.brigadier/hidden-internal.ts",
            ".hidden.ts",
            ".hidden-dir/c.ts",
            "ignored.ts",
            "ignored-dir/d.ts",
            "tmp-ignored.ts",
            ".git/config.ts",
            ".brigadier/state.ts",
            "plain.txt",
            "big.ts",
            "nul.ts",
            "src",   // a directory, not a regular file
            "src/",  // trailing slash never matches a walk path
            "./src/a.ts",
            "../outside.ts",
            "missing.ts",
            "src\\a.ts",
        ]
        .iter()
        .map(|p| (*p).to_owned())
        .collect();
        paths.push(dir.join("src/a.ts").to_string_lossy().into_owned());
        #[cfg(unix)]
        paths.extend(
            ["link.ts", "linked-dir/a.ts", "fifo.ts"]
                .iter()
                .map(|p| (*p).to_owned()),
        );
        paths
    }

    type Shape = (
        Vec<(String, usize, usize, usize, usize, String)>,
        Vec<(String, String, String, usize)>,
        bool,
        usize,
    );

    fn shape(r: &Results) -> Shape {
        (
            r.hits
                .iter()
                .map(|h| {
                    (
                        h.path.clone(),
                        h.line,
                        h.column,
                        h.end_line,
                        h.end_column,
                        h.text.clone(),
                    )
                })
                .collect(),
            r.replacements
                .iter()
                .map(|c| (c.path.clone(), c.before.clone(), c.after.clone(), c.count))
                .collect(),
            r.truncated,
            r.files,
        )
    }

    /// Runs the query twice — scoped to `paths`, and unscoped — and asserts the scoped run
    /// returns exactly the unscoped run filtered by the same membership rule.
    fn assert_scope_parity(dir: &Path, base: &Query, paths: &[String]) {
        let wanted: std::collections::HashSet<&String> = paths.iter().collect();
        let mut unscoped = base.clone();
        unscoped.paths = None;
        let baseline = search(dir, &unscoped).unwrap();
        let (hits, replacements, truncated, files) = shape(&baseline);
        assert!(!truncated, "fixture must not truncate");
        let distinct: std::collections::HashSet<&String> = hits.iter().map(|h| &h.0).collect();
        assert_eq!(files, distinct.len(), "files counts distinct matched files");
        let hits: Vec<_> = hits.into_iter().filter(|h| wanted.contains(&h.0)).collect();
        let replacements: Vec<_> = replacements
            .into_iter()
            .filter(|c| wanted.contains(&c.0))
            .collect();
        let files = hits
            .iter()
            .map(|h| h.0.clone())
            .collect::<std::collections::HashSet<_>>()
            .len();

        let mut scoped = base.clone();
        scoped.paths = Some(paths.to_vec());
        let actual = search(dir, &scoped).unwrap();
        assert_eq!(shape(&actual), (hits, replacements, false, files));
    }

    #[test]
    fn explicit_paths_return_exactly_the_walk_filtered_by_membership() {
        let d = parity_fixture();
        let root = d.path().canonicalize().unwrap();
        let paths = parity_candidates(&root);
        let base = Query {
            text: "needle".into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
            replacement: None,
            use_ignore_files: None,
            paths: None,
            include_all: vec![],
        };
        for use_ignore_files in [Some(true), Some(false), None] {
            let mut q = base.clone();
            q.use_ignore_files = use_ignore_files;
            assert_scope_parity(&root, &q, &paths);

            q.include = "*.ts".into();
            q.exclude = "nested".into();
            assert_scope_parity(&root, &q, &paths);

            q.include = String::new();
            q.exclude = String::new();
            q.include_all = vec!["src".into()];
            assert_scope_parity(&root, &q, &paths);

            q.include_all = vec![];
            q.replacement = Some("pin".into());
            assert_scope_parity(&root, &q, &paths);
        }
        // The scope is not vacuous: the unscoped search does find files the scope drops.
        let mut unscoped = base.clone();
        unscoped.paths = None;
        assert!(search(&root, &unscoped).unwrap().files > 1);
        // And the scoped search does return something.
        let mut scoped = base;
        scoped.paths = Some(paths);
        assert!(search(&root, &scoped).unwrap().files > 0);
    }

    #[test]
    fn explicit_paths_visit_only_the_candidates_and_their_ancestors() {
        let d = parity_fixture();
        std::fs::create_dir_all(d.path().join("bulk/deep")).unwrap();
        for i in 0..300 {
            std::fs::write(d.path().join(format!("bulk/deep/f-{i}.ts")), "needle").unwrap();
        }
        let root = d.path().canonicalize().unwrap();
        let mut q = Query {
            text: "needle".into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
            replacement: None,
            use_ignore_files: Some(true),
            paths: None,
            include_all: vec![],
        };
        let (_, walked) = search_visited(&root, &q).unwrap();
        assert!(walked > 300, "full walk visits the whole tree: {walked}");

        q.paths = Some(vec![
            "src/a.ts".into(),
            "src/a.ts".into(),
            "src/nested/b.ts".into(),
        ]);
        let (result, visited) = search_visited(&root, &q).unwrap();
        assert_eq!(result.files, 2);
        // root + src + src/a.ts + src/nested + src/nested/b.ts
        assert_eq!(visited, 5);

        q.paths = Some(vec![]);
        let (result, visited) = search_visited(&root, &q).unwrap();
        assert_eq!(result.files, 0);
        assert_eq!(visited, 1, "only the root entry");
    }

    #[test]
    fn vscode_ignore_toggle_and_open_file_scope_are_applied() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(d.path().join("ignored.txt"), "needle").unwrap();
        std::fs::write(d.path().join("open.txt"), "needle").unwrap();
        let mut q = Query {
            text: "needle".into(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: String::new(),
            exclude: String::new(),
            replacement: None,
            use_ignore_files: Some(true),
            paths: None,
            include_all: vec![],
        };
        assert_eq!(
            search(&d.path().canonicalize().unwrap(), &q).unwrap().files,
            1
        );
        q.use_ignore_files = Some(false);
        assert_eq!(
            search(&d.path().canonicalize().unwrap(), &q).unwrap().files,
            2
        );
        q.paths = Some(vec!["open.txt".into()]);
        assert_eq!(
            search(&d.path().canonicalize().unwrap(), &q).unwrap().files,
            1
        );
        q.paths = Some(vec![]);
        assert_eq!(
            search(&d.path().canonicalize().unwrap(), &q).unwrap().files,
            0
        );
    }
}
