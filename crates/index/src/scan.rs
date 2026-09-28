use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Instant, UNIX_EPOCH};

use crate::db::{self, FileRow};
use crate::parse::{self, Parser};
use crate::{CodeIndex, Error, FileChange, IndexState, Result, ScanStats};
use ignore::{WalkBuilder, WalkState};

fn metadata(path: &Path) -> Option<(u64, i64)> {
    let m = fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    let ns = m
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .min(i64::MAX as u128) as i64;
    Some((m.len(), ns))
}

fn skip_name(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.ends_with(".lock")
        || matches!(
            name,
            "Cargo.lock" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock"
        )
        || name.contains(".min.")
        || name.ends_with(".map")
}

fn acceptable(content: &[u8]) -> bool {
    if content.iter().take(8192).any(|b| *b == 0) {
        return false;
    }
    !content
        .split(|b| *b == b'\n')
        .any(|line| line.len() > 20_000)
}

struct Job {
    path: String,
    absolute: PathBuf,
    size: u64,
    mtime_ns: i64,
    old_hash: Option<String>,
    is_new: bool,
}
struct Outcome {
    row: Option<FileRow>,
    changed: Option<FileChange>,
    skipped: bool,
}

impl CodeIndex {
    pub(crate) fn scan_impl(&self) -> Result<ScanStats> {
        let _guard = self.inner.scan_lock.lock().map_err(|_| Error::Closed)?;
        let start = Instant::now();
        let root = &self.inner.root;
        {
            let mut status = self.inner.status.lock().map_err(|_| Error::Closed)?;
            status.state = IndexState::Scanning { done: 0, total: 0 };
        }
        let result = self.run_scan(start, root);
        if let Err(error) = &result
            && let Ok(mut status) = self.inner.status.lock()
        {
            status.state = IndexState::Failed {
                error: error.to_string(),
            };
        }
        result
    }

    fn run_scan(&self, start: Instant, root: &Path) -> Result<ScanStats> {
        let previous: HashMap<String, (u64, i64, String)> = self.with_read(|conn| {
            let mut stmt = conn
                .prepare("SELECT path,size,mtime_ns,hash FROM files")
                .map_err(|e| Error::Db(e.to_string()))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)? as u64,
                        r.get::<_, i64>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| Error::Db(e.to_string()))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map(|v| v.into_iter().map(|(p, s, m, h)| (p, (s, m, h))).collect())
                .map_err(|e| Error::Db(e.to_string()))
        })?;
        let entries = Arc::new(Mutex::new(Vec::<(String, PathBuf, u64, i64)>::new()));
        let total = Arc::new(AtomicU64::new(0));
        let skipped = Arc::new(AtomicU64::new(0));
        let mut builder = WalkBuilder::new(root);
        builder
            .hidden(false)
            .threads(self.inner.threads)
            .filter_entry(|entry| entry.file_name() != ".git");
        let walk = builder.build_parallel();
        walk.run(|| {
            let entries = entries.clone();
            let total = total.clone();
            let root = root.to_path_buf();
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let Ok(relative) = entry.path().strip_prefix(&root) else {
                    return WalkState::Continue;
                };
                let path = relative.to_string_lossy().replace('\\', "/");
                total.fetch_add(1, Ordering::Relaxed);
                if let Some((size, mtime)) = metadata(entry.path())
                    && let Ok(mut list) = entries.lock()
                {
                    list.push((path, entry.path().to_path_buf(), size, mtime));
                }
                WalkState::Continue
            })
        });
        let mut entries = Arc::try_unwrap(entries)
            .map_err(|_| Error::Closed)?
            .into_inner()
            .map_err(|_| Error::Closed)?;
        entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let seen: HashSet<&str> = entries.iter().map(|e| e.0.as_str()).collect();
        let mut removed: Vec<String> = previous
            .keys()
            .filter(|p| !seen.contains(p.as_str()))
            .cloned()
            .collect();
        removed.sort();
        let mut changed: Vec<FileChange> = removed
            .iter()
            .map(|path| FileChange {
                path: path.clone(),
                hash: None,
            })
            .collect();
        let mut jobs = VecDeque::new();
        let mut done = 0u64;
        for (path, absolute, size, mtime_ns) in &entries {
            match previous.get(path) {
                Some((s, m, hash)) if s == size && m == mtime_ns => {
                    done += 1;
                    if hash.is_empty() {
                        skipped.fetch_add(1, Ordering::Relaxed);
                    }
                }
                old => jobs.push_back(Job {
                    path: path.clone(),
                    absolute: absolute.clone(),
                    size: *size,
                    mtime_ns: *mtime_ns,
                    old_hash: old.map(|x| x.2.clone()),
                    is_new: old.is_none(),
                }),
            }
        }
        {
            let mut status = self.inner.status.lock().map_err(|_| Error::Closed)?;
            status.state = IndexState::Scanning {
                done,
                total: total.load(Ordering::Relaxed),
            };
        }
        let job_count = jobs.len();
        let queue = Arc::new(Mutex::new(jobs));
        let (tx, rx) = mpsc::sync_channel::<Outcome>(512);
        let threads = self.inner.threads.min(job_count.max(1));
        thread::scope(|scope| {
            for _ in 0..threads {
                let queue = queue.clone();
                let tx = tx.clone();
                scope.spawn(move || {
                    let mut parser = Parser::new();
                    while let Some(job) = queue.lock().ok().and_then(|mut q| q.pop_front()) {
                        let excluded = job.size > 1_048_576 || skip_name(&job.path);
                        let bytes = if excluded {
                            None
                        } else {
                            fs::read(&job.absolute).ok()
                        };
                        let outcome = match bytes {
                            Some(bytes) if acceptable(&bytes) => {
                                let hash = blake3::hash(&bytes).to_hex().to_string();
                                if job.old_hash.as_deref() == Some(hash.as_str()) {
                                    Outcome {
                                        row: None,
                                        changed: None,
                                        skipped: false,
                                    }
                                } else {
                                    let detected = parse::language(&job.path);
                                    let parsed = parser.parse(detected, &bytes);
                                    let lang = if parsed.is_some() { detected } else { "other" };
                                    let symbols = parsed.unwrap_or_default();
                                    let change = FileChange {
                                        path: job.path.clone(),
                                        hash: Some(hash.clone()),
                                    };
                                    Outcome {
                                        row: Some(FileRow {
                                            path: job.path,
                                            lang: lang.into(),
                                            size: job.size,
                                            mtime_ns: job.mtime_ns,
                                            hash,
                                            symbols,
                                            is_new: job.is_new,
                                        }),
                                        changed: Some(change),
                                        skipped: false,
                                    }
                                }
                            }
                            _ => {
                                let changed =
                                    job.old_hash.as_ref().filter(|h| !h.is_empty()).map(|_| {
                                        FileChange {
                                            path: job.path.clone(),
                                            hash: None,
                                        }
                                    });
                                Outcome {
                                    row: Some(FileRow {
                                        path: job.path,
                                        lang: "other".into(),
                                        size: job.size,
                                        mtime_ns: job.mtime_ns,
                                        hash: String::new(),
                                        symbols: Vec::new(),
                                        is_new: job.is_new,
                                    }),
                                    changed,
                                    skipped: true,
                                }
                            }
                        };
                        if tx.send(outcome).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);
            let mut batch = Vec::with_capacity(256);
            for outcome in rx {
                done += 1;
                if outcome.skipped {
                    skipped.fetch_add(1, Ordering::Relaxed);
                }
                if let Some(change) = outcome.changed {
                    changed.push(change);
                }
                if let Some(row) = outcome.row {
                    batch.push(row);
                }
                if batch.len() >= 256 {
                    db::send_apply(&self.inner.writer, std::mem::take(&mut batch), Vec::new())?;
                }
                if done.is_multiple_of(256)
                    && let Ok(mut status) = self.inner.status.lock()
                {
                    status.state = IndexState::Scanning {
                        done,
                        total: total.load(Ordering::Relaxed),
                    };
                }
            }
            db::send_apply(&self.inner.writer, batch, removed.clone())
        })?;
        self.refresh_metadata(&entries)?;
        if !changed.is_empty() {
            db::send_popular(&self.inner.writer)?;
        }
        self.refresh_status()?;
        let elapsed = start.elapsed().as_millis() as u64;
        let mut status = self.inner.status.lock().map_err(|_| Error::Closed)?;
        status.state = IndexState::Ready;
        status.last_scan_at_ms = Some(crate::now_ms());
        status.last_scan_ms = Some(elapsed);
        status.last_scan_parsed = Some(changed.iter().filter(|c| c.hash.is_some()).count() as u64);
        status.updated_at_ms = Some(crate::now_ms());
        let stats = ScanStats {
            files: status.files,
            parsed: status.last_scan_parsed.unwrap_or(0),
            removed: removed.len() as u64,
            skipped: skipped.load(Ordering::Relaxed),
            symbols: status.symbols,
            references: status.references,
            duration_ms: elapsed,
            changed,
        };
        Ok(stats)
    }

    fn refresh_metadata(&self, entries: &[(String, PathBuf, u64, i64)]) -> Result<()> {
        let mut manifests = Vec::new();
        let mut scripts = Vec::new();
        let mut services = Vec::new();
        for (path, absolute, _, _) in entries {
            if !super::is_metadata_path(path) {
                continue;
            }
            let Ok(text) = fs::read_to_string(absolute) else {
                continue;
            };
            let (m, ss, sv) = crate::manifests::extract(path, &text);
            if let Some(m) = m {
                if let Ok(json) = serde_json::to_string(&m) {
                    manifests.push((path.clone(), json));
                }
            } else if matches!(
                path.rsplit('/').next().unwrap_or(path),
                "Cargo.toml"
                    | "package.json"
                    | "pnpm-workspace.yaml"
                    | "pyproject.toml"
                    | "composer.json"
            ) {
                tracing::debug!(path, "manifest could not be parsed");
            }
            scripts.extend(ss.into_iter().map(|s| (s.name, s.command, s.source)));
            services.extend(
                sv.into_iter()
                    .filter_map(|s| serde_json::to_string(&s).ok().map(|j| (s.name, j))),
            );
        }
        db::send_metadata(&self.inner.writer, manifests, scripts, services)
    }
}
