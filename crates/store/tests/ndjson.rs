//! The raw log: where it lands, that it rotates by size, and that it never fsyncs per line.

use brigadier_core::event::SessionId;
use brigadier_store::ndjson::RawLog;

#[test]
fn lines_land_in_raw_and_rotate_by_size() {
    let dir = tempfile::tempdir().expect("tempdir");
    let id = SessionId::new("9f1c-session");
    let mut log = RawLog::with_limits(dir.path(), &id, 4 * 1024, 2).expect("open");
    assert_eq!(log.path(), dir.path().join("raw").join("9f1c-session.ndjson"));

    let record = serde_json::json!({ "type": "assistant", "text": "x".repeat(200) }).to_string();
    // Flush on a tick, the way the writer does: `ContentLimit::BytesSurpassed` only rotates on a
    // completed write, so the live file can overshoot by at most one buffer.
    for n in 0..200 {
        log.append_line(record.as_bytes()).expect("append");
        if n % 10 == 0 {
            log.flush().expect("flush");
        }
    }
    log.flush().expect("flush");

    let live = std::fs::read_to_string(log.path()).expect("read");
    assert!(live.ends_with('\n'), "every record is newline-terminated");
    assert!(live.lines().all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));

    let siblings: Vec<String> = std::fs::read_dir(dir.path().join("raw"))
        .expect("read_dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "9f1c-session.ndjson")
        .collect();
    assert!(!siblings.is_empty(), "40 KB through a 4 KB limit must have rotated");
    assert!(siblings.len() <= 3, "kept {siblings:?}");
}

#[test]
fn an_awkward_session_id_still_produces_one_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let id = SessionId::new("../../etc/passwd");
    let mut log = RawLog::open(dir.path(), &id).expect("open");
    log.append_line(b"{}").expect("append");
    log.flush().expect("flush");
    assert_eq!(log.path().parent(), Some(dir.path().join("raw").as_path()));
    assert!(log.path().is_file());
}
