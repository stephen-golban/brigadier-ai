//! One small JSON file per live session, deleted when the session ends.
//!
//! Shape copied from Claude Code's own `~/.claude/sessions/<pid>.json`
//! (`docs/research/orphan-sweep.md` §4): a kernel-sourced start time beside the wall-clock one, a
//! `pid_domain` so a record written under another kernel can never be matched, and one file per
//! live process rather than an append log. Two departures: the start time is stored as
//! `(sec, usec)` integers instead of a formatted string, so no date parser or timezone is
//! involved; and the owning app's own `(pid, sec, usec)` is recorded too, which is what lets a
//! second app instance leave the first instance's records alone with no lock file.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Namespace for the pids in a record. A record carrying any other value was written under a
/// different kernel — a container, a VM, a restored backup — and its pids mean nothing here.
#[cfg(target_os = "macos")]
pub const PID_DOMAIN: &str = "darwin";

/// Namespace for the pids in a record; see the macOS definition.
#[cfg(not(target_os = "macos"))]
pub const PID_DOMAIN: &str = "unsupported";

/// The durable record of one supervised child, written before the first protocol frame and
/// deleted when the session ends.
///
/// `binary` and `cwd` are for the log line only. Neither is used for matching: `pbi_comm` is the
/// CLI's version-numbered basename rather than `claude` (`docs/research/orphan-sweep.md`
/// measurement 17), and a worktree `cwd` can be deleted under us.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PidRecord {
    /// The harness's session id. Also the file's basename.
    pub session_id: String,
    /// The app launch that spawned this child. A record carrying the current run's id is our own
    /// previous run and is always sweepable.
    pub run_id: String,
    /// The child's pid.
    pub pid: u32,
    /// The child's process-group id. Equal to `pid`, since the child is spawned with
    /// `process_group(0)`, but recorded separately because it is the thing that gets signalled.
    pub pgid: u32,
    /// Kernel start time of the child, whole seconds.
    pub start_tvsec: u64,
    /// Kernel start time of the child, microsecond remainder.
    pub start_tvusec: u64,
    /// [`PID_DOMAIN`] at the time of writing.
    pub pid_domain: String,
    /// Pid of the app process that spawned the child.
    pub owner_pid: u32,
    /// Kernel start time of the owning app, whole seconds.
    pub owner_start_tvsec: u64,
    /// Kernel start time of the owning app, microsecond remainder.
    pub owner_start_tvusec: u64,
    /// The binary that was executed. Diagnostic only.
    pub binary: String,
    /// The working directory it was executed in. Diagnostic only.
    pub cwd: String,
    /// Wall-clock seconds since the epoch when the record was written. Diagnostic only; the
    /// kernel start times are what identity is decided on.
    pub written_at_unix: u64,
}

/// Wall-clock seconds since the epoch, or `0` if the clock is before the epoch.
#[must_use]
pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A directory of [`PidRecord`] files — `app_local_data_dir()/pids/` in the app.
#[derive(Debug, Clone)]
pub struct PidDir {
    dir: PathBuf,
}

impl PidDir {
    /// Opens `dir`, creating it and its parents if they do not exist.
    ///
    /// # Errors
    /// Whatever `create_dir_all` returns: a permissions failure, or a non-directory in the path.
    pub fn open(dir: impl Into<PathBuf>) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// The directory being managed.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// The file a session's record lives at.
    ///
    /// # Errors
    /// [`io::ErrorKind::InvalidInput`] if `session_id` is empty or contains a path separator —
    /// the id becomes a filename, so it must not be able to escape the directory.
    pub fn file_for(&self, session_id: &str) -> io::Result<PathBuf> {
        if session_id.is_empty()
            || session_id == "."
            || session_id == ".."
            || session_id.contains(['/', '\\'])
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("session id {session_id:?} is not usable as a filename"),
            ));
        }
        Ok(self.dir.join(format!("{session_id}.json")))
    }

    /// Writes `rec` atomically: temp file, `sync_all`, `rename`.
    ///
    /// `rename(2)` within a directory is atomic on APFS, so a reader never sees a half-written
    /// record. The directory itself is not fsynced: the worst case is a record lost for a session
    /// started in the last few hundred ms before a power cut, and that child died with the
    /// machine anyway (`docs/research/orphan-sweep.md` §4).
    ///
    /// # Errors
    /// Serialisation failure, or any of the create/write/sync/rename steps.
    pub fn write(&self, rec: &PidRecord) -> io::Result<()> {
        let final_path = self.file_for(&rec.session_id)?;
        let tmp_path = final_path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(rec).map_err(io::Error::other)?;
        {
            let mut file = fs::File::create(&tmp_path)?;
            io::Write::write_all(&mut file, &bytes)?;
            file.sync_all()?;
        }
        match fs::rename(&tmp_path, &final_path) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                Err(e)
            }
        }
    }

    /// Deletes a session's record. A missing file is success — deletion is idempotent and is
    /// called from several terminal paths.
    ///
    /// # Errors
    /// An unusable `session_id`, or a removal failure other than `ENOENT`.
    pub fn remove(&self, session_id: &str) -> io::Result<()> {
        let path = self.file_for(session_id)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Every `*.json` in the directory, parsed. A corrupt file comes back as its path plus the
    /// parse error rather than being skipped, because the sweep has to delete it.
    ///
    /// Leftover `*.json.tmp` files from an interrupted write are ignored, not reported. An
    /// unreadable directory yields an empty vector and a `tracing::warn`.
    #[must_use]
    pub fn read_all(&self) -> Vec<(PathBuf, Result<PidRecord, io::Error>)> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) => {
                tracing::warn!(dir = %self.dir.display(), error = %e, "pid directory unreadable");
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let parsed = fs::read(&path)
                .and_then(|bytes| serde_json::from_slice::<PidRecord>(&bytes).map_err(io::Error::other));
            out.push((path, parsed));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(session_id: &str) -> PidRecord {
        PidRecord {
            session_id: session_id.to_string(),
            run_id: "run-1".into(),
            pid: 4242,
            pgid: 4242,
            start_tvsec: 1_788_330_210,
            start_tvusec: 704_445,
            pid_domain: PID_DOMAIN.into(),
            owner_pid: std::process::id(),
            owner_start_tvsec: 1_788_330_200,
            owner_start_tvusec: 1,
            binary: "/usr/local/bin/claude".into(),
            cwd: "/tmp/work".into(),
            written_at_unix: now_unix(),
        }
    }

    #[test]
    fn write_then_read_all_round_trips() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = PidDir::open(tmp.path().join("pids")).expect("open");
        let rec = sample("s-1");
        dir.write(&rec).expect("write");

        let all = dir.read_all();
        assert_eq!(all.len(), 1, "expected one record, got {all:?}");
        let (path, parsed) = &all[0];
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("s-1.json"));
        assert_eq!(parsed.as_ref().map_err(ToString::to_string), Ok(&rec));
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = PidDir::open(tmp.path()).expect("open");
        dir.write(&sample("s-2")).expect("write");
        let names: Vec<String> = fs::read_dir(tmp.path())
            .expect("read_dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["s-2.json".to_string()]);
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = PidDir::open(tmp.path()).expect("open");
        dir.write(&sample("s-3")).expect("write");
        dir.remove("s-3").expect("first remove");
        dir.remove("s-3").expect("second remove must also be Ok");
        assert!(dir.read_all().is_empty());
    }

    #[test]
    fn a_corrupt_file_is_reported_not_skipped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = PidDir::open(tmp.path()).expect("open");
        fs::write(tmp.path().join("bad.json"), b"{not json").expect("write junk");
        let all = dir.read_all();
        assert_eq!(all.len(), 1);
        assert!(all[0].1.is_err(), "corrupt file parsed as {:?}", all[0].1);
    }

    #[test]
    fn a_session_id_cannot_escape_the_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = PidDir::open(tmp.path()).expect("open");
        for bad in ["", ".", "..", "../evil", "a/b"] {
            assert!(dir.file_for(bad).is_err(), "{bad:?} was accepted as a filename");
        }
    }
}
