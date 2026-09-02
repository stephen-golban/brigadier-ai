//! Our own rotating NDJSON sink, one file per session.
//!
//! Size, not time, is the dimension that matters: a burst of provider traffic can put hundreds
//! of megabytes into one hourly file, so `tracing-appender` (time-only rotation) is not usable
//! here and `file-rotate` is.
// see docs/research/persistence.md §4.
//!
//! **fsync policy: none, per line or otherwise.** [`RawLog::append_line`] writes into a
//! `BufWriter`; [`RawLog::flush`] is a `write(2)`, never an `fsync(2)`. NDJSON is self-healing —
//! a torn final line is discarded by the reader — so the only real requirement is ordering:
//! flush this log *before* committing the database transaction that points at it, so the
//! database never claims data the log lacks. The reverse is recoverable. An fsync per line would
//! reintroduce exactly the per-chunk syscall cost that sank t3code, on the same hot path.
// see docs/research/persistence.md §4, last two bullets.

use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use brigadier_core::event::SessionId;
use file_rotate::compression::Compression;
use file_rotate::suffix::AppendCount;
use file_rotate::{ContentLimit, FileRotate};

use crate::Result;

/// Bytes one session's live NDJSON file may reach before it rotates.
pub const DEFAULT_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Rotated files kept per session, beyond the live one.
pub const DEFAULT_KEEP: usize = 4;

/// Bytes of `BufWriter` in front of the rotating file.
const BUFFER_BYTES: usize = 64 * 1024;

/// A newline-delimited JSON sink for one session, rotated by size.
pub struct RawLog {
    out: BufWriter<FileRotate<AppendCount>>,
    path: PathBuf,
}

impl std::fmt::Debug for RawLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawLog").field("path", &self.path).finish()
    }
}

impl RawLog {
    /// Open `<dir>/raw/<session_id>.ndjson` with the default limits
    /// ([`DEFAULT_MAX_BYTES`], [`DEFAULT_KEEP`], gzip on rotate).
    ///
    /// **Appends; never truncates.** A resume reopens the same path for the same session id, and
    /// the old transcript has to survive it.
    // Measured by reading `file-rotate` 0.8.0 (~/.cargo/registry/.../file-rotate-0.8.0/src/lib.rs):
    // `FileRotate::new` calls `ensure_log_directory_exists` → `open_file` (`:477-486`), which uses
    // the `OpenOptions` handed to it verbatim — ours is `read(true).create(true).append(true)`,
    // with no `truncate` — and then seeds the rotation byte `count` from the existing file's
    // `metadata().len()` (`:459-462`), so a reopened file is continued rather than restarted.
    // The library's own default, used when `open_options` is `None`, is the same three flags.
    // see docs/research/resume.md §8 gap 6, which recorded this as unverified.
    pub fn open(dir: &Path, session_id: &SessionId) -> Result<Self> {
        Self::with_limits(dir, session_id, DEFAULT_MAX_BYTES, DEFAULT_KEEP)
    }

    /// Open with explicit limits. `max_bytes` must be non-zero.
    pub fn with_limits(
        dir: &Path,
        session_id: &SessionId,
        max_bytes: usize,
        keep: usize,
    ) -> Result<Self> {
        let raw_dir = dir.join("raw");
        // `FileRotate::new` panics rather than erring if it cannot create the parent directory,
        // so create it here where the failure is still a `Result`.
        std::fs::create_dir_all(&raw_dir)?;
        let path = raw_dir.join(format!("{}.ndjson", safe_stem(session_id.as_str())));
        let mut open_options = OpenOptions::new();
        open_options.read(true).create(true).append(true);
        let rotate = FileRotate::new(
            &path,
            AppendCount::new(keep),
            // `BytesSurpassed`, not `Bytes`: `Bytes` cuts at the exact byte and would split a
            // JSON record across two files. The cost is an overshoot of at most one buffer
            // ([`BUFFER_BYTES`]), because rotation is only considered after a completed write.
            ContentLimit::BytesSurpassed(max_bytes.max(1)),
            // Keep the most recent rotated file readable; gzip everything older.
            Compression::OnRotate(1),
            Some(open_options),
        );
        Ok(Self { out: BufWriter::with_capacity(BUFFER_BYTES, rotate), path })
    }

    /// The live file's path. Rotated siblings are `<path>.1`, `<path>.2.gz`, and so on.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append one record, adding the trailing newline. `line` must not contain one.
    pub fn append_line(&mut self, line: &[u8]) -> Result<()> {
        self.out.write_all(line)?;
        self.out.write_all(b"\n")?;
        Ok(())
    }

    /// Push the buffer into the file. A `write(2)`, not an `fsync(2)`; see the module docs.
    pub fn flush(&mut self) -> Result<()> {
        self.out.flush()?;
        Ok(())
    }
}

impl Drop for RawLog {
    fn drop(&mut self) {
        if let Err(e) = self.flush() {
            tracing::warn!(error = %e, path = %self.path.display(), "raw log flush on drop failed");
        }
    }
}

/// Session ids are opaque strings, so anything that is not obviously filename-safe becomes `-`.
fn safe_stem(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('.').to_owned();
    if cleaned.is_empty() {
        "session".to_owned()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A resume reopens `raw/<session_id>.ndjson` for a session that already has one. If the
    /// second open truncated, the whole pre-resume transcript would vanish the moment the
    /// operator pressed Resume.
    // see docs/research/resume.md §8 gap 6 — recorded there as unverified; this is the check.
    #[test]
    fn reopening_a_session_log_appends_to_it_rather_than_truncating_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let session = SessionId::new("resume-me");

        let mut first = RawLog::open(dir.path(), &session).expect("first open");
        first.append_line(br#"{"seq":1}"#).expect("append");
        first.flush().expect("flush");
        let path = first.path().to_owned();
        drop(first);

        let mut second = RawLog::open(dir.path(), &session).expect("second open");
        assert_eq!(second.path(), path, "the same session reopens the same file");
        second.append_line(br#"{"seq":2}"#).expect("append");
        second.flush().expect("flush");
        drop(second);

        let text = std::fs::read_to_string(&path).expect("read back");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines, [r#"{"seq":1}"#, r#"{"seq":2}"#], "the first open's line must survive");
    }
}
