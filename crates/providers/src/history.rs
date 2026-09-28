//! Where the user's own CLI sessions ran: the working folders of their past sessions, read from
//! each CLI's session files, so the first run can offer those folders as projects. Only the
//! first lines of each file are read, and nothing is changed.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

/// A folder the user's sessions of one CLI ran in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastFolder {
    pub cwd: PathBuf,
    pub sessions: u32,
    pub last_active_ms: i64,
}

/// Lines of a Claude transcript read to find its working folder (the first few are metadata).
const CLAUDE_LINES: usize = 64;
/// Transcripts of one Claude project folder tried before giving up on its working folder.
const CLAUDE_FILES: usize = 3;
/// A line longer than this is not read on (Codex's first line carries its instructions).
const LINE_LIMIT: u64 = 4 * 1024 * 1024;

/// Claude Code keeps each working folder's transcripts in `<config>/projects/<encoded cwd>/`.
/// The folder name is lossy, so the working folder comes from the transcripts' `cwd` field.
pub(crate) fn claude(config: &Path) -> Vec<PastFolder> {
    let Ok(entries) = fs::read_dir(config.join("projects")) else {
        return Vec::new();
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        let mut transcripts: Vec<(PathBuf, i64)> = fs::read_dir(entry.path())
            .into_iter()
            .flatten()
            .flatten()
            .map(|file| file.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .filter_map(|path| {
                let ms = modified_ms(&path)?;
                Some((path, ms))
            })
            .collect();
        if transcripts.is_empty() {
            continue;
        }
        transcripts.sort_by_key(|(_, ms)| std::cmp::Reverse(*ms));
        let cwd = transcripts
            .iter()
            .take(CLAUDE_FILES)
            .find_map(|(path, _)| claude_cwd(path));
        if let Some(cwd) = cwd {
            folders.push(PastFolder {
                cwd,
                sessions: u32::try_from(transcripts.len()).unwrap_or(u32::MAX),
                last_active_ms: transcripts[0].1,
            });
        }
    }
    merge(folders)
}

fn claude_cwd(path: &Path) -> Option<PathBuf> {
    let mut reader = BufReader::new(File::open(path).ok()?);
    for _ in 0..CLAUDE_LINES {
        let line = read_line(&mut reader)?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            return Some(PathBuf::from(cwd));
        }
    }
    None
}

/// Codex keeps one rollout per thread in `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`,
/// its first line the thread's `session_meta` with the working folder.
pub(crate) fn codex(home: &Path) -> Vec<PastFolder> {
    let mut rollouts = Vec::new();
    collect_rollouts(&home.join("sessions"), 0, &mut rollouts);
    let folders = rollouts
        .into_iter()
        .filter_map(|path| {
            let last_active_ms = modified_ms(&path)?;
            let mut reader = BufReader::new(File::open(&path).ok()?);
            let meta: Value = serde_json::from_str(&read_line(&mut reader)?).ok()?;
            let cwd = meta.pointer("/payload/cwd").and_then(Value::as_str)?;
            Some(PastFolder {
                cwd: PathBuf::from(cwd),
                sessions: 1,
                last_active_ms,
            })
        })
        .collect();
    merge(folders)
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth < 3 {
            collect_rollouts(&path, depth + 1, out);
        } else if kind.is_file()
            && path.extension().is_some_and(|ext| ext == "jsonl")
            && entry.file_name().to_string_lossy().starts_with("rollout-")
        {
            out.push(path);
        }
    }
}

/// One entry per folder, most recent first.
fn merge(folders: Vec<PastFolder>) -> Vec<PastFolder> {
    let mut by_cwd: HashMap<PathBuf, PastFolder> = HashMap::new();
    for folder in folders {
        match by_cwd.get_mut(&folder.cwd) {
            Some(known) => {
                known.sessions = known.sessions.saturating_add(folder.sessions);
                known.last_active_ms = known.last_active_ms.max(folder.last_active_ms);
            }
            None => {
                by_cwd.insert(folder.cwd.clone(), folder);
            }
        }
    }
    let mut merged: Vec<_> = by_cwd.into_values().collect();
    merged.sort_by(|a, b| {
        b.last_active_ms
            .cmp(&a.last_active_ms)
            .then_with(|| a.cwd.cmp(&b.cwd))
    });
    merged
}

fn read_line(reader: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    let read = reader.take(LINE_LIMIT).read_line(&mut line).ok()?;
    (read > 0).then_some(line)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(ms).ok()
}
