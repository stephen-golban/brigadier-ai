//! Disposable checkpoint timing; never reads the owner's workspace or launches a provider.
use brigadier_core::checkpoint::{Coverage, Limits, SnapshotStore};
use std::{fs, process::Command, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for count in [100, 1000] {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("workspace");
        fs::create_dir(&root)?;
        let status = Command::new("git")
            .args(["init", "-q"])
            .arg(&root)
            .status()?;
        assert!(status.success());
        let mut raw = 0usize;
        for n in 0..count {
            let bytes = format!("// file {n}\n{}", "let value = 42;\n".repeat(20));
            raw += bytes.len();
            fs::write(root.join(format!("file-{n}.ts")), bytes)?;
        }
        let snapshots =
            SnapshotStore::open(dir.path().join("private"), "git".into(), Limits::default())?;
        let first = Instant::now();
        snapshots.capture(&root, Coverage::default())?;
        let first = first.elapsed().as_millis();
        let second = Instant::now();
        snapshots.capture(&root, Coverage::default())?;
        let second = second.elapsed().as_millis();
        println!(
            "{{\"files\":{count},\"rawBytes\":{raw},\"firstMs\":{first},\"secondMs\":{second}}}"
        );
    }
    Ok(())
}
