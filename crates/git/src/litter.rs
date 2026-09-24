//! Deterministic pre-commit litter guard; no model or filesystem access.
//!
//! Always exclude `*.log`, `.DS_Store`, `*.tmp`, `*.swp` and `*~`. For untracked files also
//! exclude `scratch*`, `notes*.md`, `NOTES*.md`, `TODO*.md`, `debug_*`, `tmp_*`, `test_output*`,
//! and anything under `__pycache__`, `node_modules`, `.pytest_cache` or `target` at any depth.
//! Other untracked files are kept only when the report lists that file or an ancestor directory.
//! Tracked changes are kept unless an always-excluded pattern matches. The fixed Keep/Exclude
//! API has no warning variant: callers should flag unreported tracked changes to the reviewer
//! by comparing retained changes with the report, without excluding them.

use crate::Change;

/// Whether a worker's change should be included in its candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Keep this path in the candidate.
    Keep,
    /// Leave this path out of the candidate.
    Exclude {
        /// Exact deterministic rule that excluded it.
        reason: String,
    },
}

/// Classify changes in input order. Reported entries are repo-relative file or parent directory
/// paths; separators are `/`. Reporting a litter path never overrides an exclusion rule.
pub fn classify(changes: &[Change], reported: &[String]) -> Vec<(Change, Verdict)> {
    changes.iter().map(|change| {
        let verdict = if let Some(pattern) = litter_pattern(change) {
            Verdict::Exclude { reason: format!("matches litter pattern {pattern}") }
        } else if change.untracked && !reported.iter().any(|p| reported_contains(p, &change.path)) {
            Verdict::Exclude { reason: "untracked path is not listed in the worker report (or a reported parent directory)".into() }
        } else { Verdict::Keep };
        (change.clone(), verdict)
    }).collect()
}

fn reported_contains(reported: &str, path: &str) -> bool {
    let reported = reported
        .strip_prefix("./")
        .unwrap_or(reported)
        .trim_end_matches('/');
    reported == "."
        || (!reported.is_empty()
            && (path == reported
                || path
                    .strip_prefix(reported)
                    .is_some_and(|tail| tail.starts_with('/'))))
}

fn litter_pattern(change: &Change) -> Option<&'static str> {
    let name = change.path.rsplit('/').next().unwrap_or(&change.path);
    for (suffix, pattern) in [
        (".log", "*.log"),
        (".tmp", "*.tmp"),
        (".swp", "*.swp"),
        ("~", "*~"),
    ] {
        if name.ends_with(suffix) {
            return Some(pattern);
        }
    }
    if name == ".DS_Store" {
        return Some(".DS_Store");
    }
    if change.untracked {
        for component in change
            .path
            .split('/')
            .take(change.path.split('/').count().saturating_sub(1))
        {
            match component {
                "__pycache__" => return Some("__pycache__/"),
                "node_modules" => return Some("node_modules/"),
                ".pytest_cache" => return Some(".pytest_cache/"),
                "target" => return Some("target/"),
                _ => {}
            }
        }
        for (prefix, pattern) in [
            ("scratch", "scratch*"),
            ("debug_", "debug_*"),
            ("tmp_", "tmp_*"),
            ("test_output", "test_output*"),
        ] {
            if name.starts_with(prefix) {
                return Some(pattern);
            }
        }
        if name.ends_with(".md") {
            for (prefix, pattern) in [
                ("notes", "notes*.md"),
                ("NOTES", "NOTES*.md"),
                ("TODO", "TODO*.md"),
            ] {
                if name.starts_with(prefix) {
                    return Some(pattern);
                }
            }
        }
    }
    None
}
