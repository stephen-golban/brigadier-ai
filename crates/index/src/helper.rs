//! Scans in a process of their own. A full scan of a large repository churns through hundreds
//! of megabytes (paths, file contents, parse trees, batches), and an allocator keeps most of
//! that resident after it is freed: in a long-lived process it would stay there. With a
//! [`ScanHelper`], [`CodeIndex::scan`] runs `<program> <args…> <db> <root> <threads>
//! [--rebuild]` ([`scan_helper_main`]) and reads its progress and result from its output; the
//! calling process only keeps its SQLite readers.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{CodeIndex, Error, FileChange, IndexConfig, IndexState, Result, ScanStats};

/// The program that runs scans (see the module docs).
#[derive(Debug, Clone)]
pub struct ScanHelper {
    pub program: PathBuf,
    /// Arguments before the scan's own, e.g. a subcommand.
    pub args: Vec<OsString>,
}

/// One line of the helper's output.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Line {
    Progress {
        done: u64,
        total: u64,
    },
    /// Some of the changed files; the result follows the last of them.
    Changed {
        files: Vec<FileChange>,
    },
    Done {
        stats: ScanStats,
    },
    Failed {
        error: String,
    },
}

/// How often the helper reports progress.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// A scan that takes longer is stopped (a stalled file system, a hung helper).
const SCAN_DEADLINE: Duration = Duration::from_secs(20 * 60);
/// Changed files per line of output, and per call of a scan's change sink.
pub(crate) const CHANGED_PER_SLICE: usize = 2_000;

impl CodeIndex {
    /// Runs one scan in `helper`, under the caller's scan lock, passing the changed files to
    /// `changed` as they arrive.
    pub(crate) fn scan_in_helper(
        &self,
        helper: &ScanHelper,
        clear: bool,
        changed: &mut dyn FnMut(Vec<FileChange>),
    ) -> Result<ScanStats> {
        let program = helper.program.display().to_string();
        let mut command = Command::new(&helper.program);
        command
            .args(&helper.args)
            .arg(&self.inner.db_path)
            .arg(&self.inner.root)
            .arg(self.inner.threads.to_string());
        if clear {
            command.arg("--rebuild");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Io {
                path: program.clone(),
                message: e.to_string(),
            })?;
        // The helper stops when this closes, so it never outlives this process.
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or(Error::Closed)?;
        // Ends the helper past the deadline; its output then closes and the loop below ends.
        let watchdog = thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return Ok(status),
                    Ok(None) if start.elapsed() > SCAN_DEADLINE => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(std::io::Error::other("stopped after the scan deadline"));
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                    Err(err) => return Err(err),
                }
            }
        });
        let mut outcome = None;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            match serde_json::from_str::<Line>(&line) {
                Ok(Line::Progress { done, total }) => {
                    if let Ok(mut status) = self.inner.status.lock() {
                        status.state = IndexState::Scanning { done, total };
                    }
                }
                Ok(Line::Changed { files }) => changed(files),
                Ok(Line::Done { stats }) => outcome = Some(Ok(stats)),
                Ok(Line::Failed { error }) => outcome = Some(Err(Error::Invalid(error))),
                Err(_) => {}
            }
        }
        drop(stdin);
        let exit = watchdog
            .join()
            .unwrap_or_else(|_| Err(std::io::Error::other("the scan watchdog failed")));
        let stats = outcome.unwrap_or_else(|| {
            Err(Error::Invalid(format!(
                "the scan in {program} ended without a result ({})",
                exit.map_or_else(|e| e.to_string(), |status| status.to_string())
            )))
        })?;
        self.refresh_status()?;
        let mut status = self.inner.status.lock().map_err(|_| Error::Closed)?;
        status.state = IndexState::Ready;
        status.last_scan_at_ms = Some(crate::now_ms());
        status.last_scan_ms = Some(stats.duration_ms);
        status.last_scan_parsed = Some(stats.parsed);
        status.updated_at_ms = Some(crate::now_ms());
        Ok(stats)
    }
}

/// The helper's side: `<db> <root> <threads> [--rebuild]`. Scans in this process, prints its
/// progress and result as JSON lines, and returns the exit code. It exits early when its
/// standard input closes (whoever started it went away).
pub fn scan_helper_main(args: impl Iterator<Item = OsString>) -> i32 {
    let args: Vec<OsString> = args.collect();
    let (Some(db_path), Some(root), Some(threads)) = (args.first(), args.get(1), args.get(2))
    else {
        eprintln!("usage: index-scan <db> <root> <threads> [--rebuild]");
        return 2;
    };
    let threads = threads.to_str().and_then(|t| t.parse().ok()).unwrap_or(0);
    let rebuild = args.get(3).is_some_and(|arg| arg == "--rebuild");
    thread::spawn(|| {
        let mut buffer = [0u8; 64];
        loop {
            match std::io::stdin().read(&mut buffer) {
                Ok(0) | Err(_) => std::process::exit(3),
                Ok(_) => {}
            }
        }
    });
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let say = {
        let output = output.clone();
        move |line: &Line| {
            if let (Ok(json), Ok(mut out)) = (serde_json::to_string(line), output.lock()) {
                let _ = writeln!(out, "{json}");
                let _ = out.flush();
            }
        }
    };
    let index = match CodeIndex::open(IndexConfig {
        db_path: db_path.into(),
        root: root.into(),
        threads,
        scan_helper: None,
    }) {
        Ok(index) => index,
        Err(err) => {
            say(&Line::Failed {
                error: err.to_string(),
            });
            return 1;
        }
    };
    let finished = Arc::new(AtomicBool::new(false));
    let progress = {
        let (index, finished, say) = (index.clone(), finished.clone(), say.clone());
        thread::spawn(move || {
            while !finished.load(Ordering::Acquire) {
                thread::sleep(PROGRESS_EVERY);
                if let IndexState::Scanning { done, total } = index.status().state {
                    say(&Line::Progress { done, total });
                }
            }
        })
    };
    let scanned = index.scan_into(rebuild, &mut |files| say(&Line::Changed { files }));
    finished.store(true, Ordering::Release);
    let _ = progress.join();
    match scanned {
        Ok(stats) => {
            say(&Line::Done { stats });
            0
        }
        Err(err) => {
            say(&Line::Failed {
                error: err.to_string(),
            });
            1
        }
    }
}
