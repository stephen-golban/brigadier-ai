use super::*;
use std::{
    fs,
    io::{Read, Write},
    process::{Command, Stdio},
};

/// Independent bare object store. It never writes source Git objects, refs or index.
#[derive(Clone, Debug)]
pub struct SnapshotStore {
    pub(crate) dir: PathBuf,
    pub(crate) binary: PathBuf,
    pub(crate) limits: Limits,
}
impl SnapshotStore {
    /// Open/create a private store outside the workspace. No remotes or alternates.
    pub fn open(dir: PathBuf, binary: PathBuf, limits: Limits) -> Result<Self> {
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        let store = Self {
            dir: fs::canonicalize(dir)?,
            binary,
            limits,
        };
        fs::create_dir_all(store.dir.join("hooks-empty"))?;
        if !store.dir.join("objects.git/HEAD").exists() {
            store.run(
                &["init", "--bare", "--template=", "objects.git"],
                None,
                None,
            )?;
        }
        if store
            .dir
            .join("objects.git/objects/info/alternates")
            .exists()
        {
            return Err(unavailable(
                "Checkpoint store must not use object alternates",
            ));
        }
        Ok(store)
    }
    pub(crate) fn command(&self, source: Option<&std::path::Path>) -> Command {
        let mut cmd = Command::new(&self.binary);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                cmd.env_remove(key);
            }
        }
        cmd.env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("LC_ALL", "C")
            .current_dir(source.unwrap_or(&self.dir))
            .args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath="])
            .arg("-c")
            .arg(format!(
                "core.hooksPath={}",
                self.dir.join("hooks-empty").display()
            ))
            .args([
                "-c",
                "gc.auto=0",
                "-c",
                "maintenance.auto=false",
                "-c",
                "core.fsync=all",
                "-c",
                "core.fsyncMethod=fsync",
            ]);
        cmd
    }
    pub(crate) fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        index: Option<&std::path::Path>,
    ) -> Result<Vec<u8>> {
        let mut cmd = self.command(None);
        if args.first() != Some(&"init") {
            cmd.arg(format!(
                "--git-dir={}",
                self.dir.join("objects.git").display()
            ));
        }
        if let Some(index) = index {
            cmd.env("GIT_INDEX_FILE", index);
        }
        cmd.args(args);
        output(cmd, input)
    }
    fn check_quota(&self) -> Result<()> {
        fn usage(path: &std::path::Path, total: &mut u64, entries: &mut usize) -> Result<()> {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let meta = entry.metadata()?;
                *entries += 1;
                if *entries > 250_000 {
                    return Err(unavailable("Checkpoint object store has too many entries"));
                }
                if meta.is_dir() {
                    usage(&entry.path(), total, entries)?;
                } else {
                    *total = total.saturating_add(meta.len());
                }
            }
            Ok(())
        }
        let mut total = 0;
        let mut entries = 0;
        usage(&self.dir.join("objects.git"), &mut total, &mut entries)?;
        if total.saturating_add(self.limits.snapshot_bytes) > 5 * 1024 * 1024 * 1024 {
            return Err(unavailable("Checkpoint store reached its 5 GiB quota; archived checkpoints must expire before new capture"));
        }
        Ok(())
    }
    /// Drop only unretained checkpoint refs. Objects are pruned only while the supervisor holds
    /// its capture coordinator; no source repository is involved.
    pub fn retain(&self, keep: &std::collections::BTreeSet<String>) -> Result<()> {
        let refs = self.run(
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/checkpoints/",
            ],
            None,
            None,
        )?;
        let mut changed = false;
        for line in String::from_utf8_lossy(&refs).lines() {
            let Some((reference, oid)) = line.split_once(' ') else {
                return Err(unavailable("Invalid checkpoint retention ref"));
            };
            let id = reference
                .strip_prefix("refs/checkpoints/")
                .ok_or_else(|| unavailable("Invalid retention namespace"))?;
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(unavailable("Unexpected checkpoint ref"));
            }
            if !keep.contains(id) {
                self.run(&["update-ref", "-d", reference, oid], None, None)?;
                changed = true;
            }
        }
        if changed {
            self.run(&["gc", "--prune=now"], None, None)?;
        }
        Ok(())
    }
    /// Counts from raw retained trees, with rename inference and external diff drivers disabled.
    pub fn changes(&self, before: &str, after: &str) -> Result<Vec<(String, u64, u64, bool)>> {
        validate_oid(before)?;
        validate_oid(after)?;
        let bytes = self.run(
            &[
                "diff",
                "--numstat",
                "-z",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                before,
                after,
                "--",
            ],
            None,
            None,
        )?;
        bytes
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|row| {
                let mut fields = row.splitn(3, |b| *b == b'\t');
                let added = fields
                    .next()
                    .ok_or_else(|| unavailable("Invalid diff counts"))?;
                let deleted = fields
                    .next()
                    .ok_or_else(|| unavailable("Invalid diff counts"))?;
                let path = std::str::from_utf8(
                    fields
                        .next()
                        .ok_or_else(|| unavailable("Missing diff path"))?,
                )
                .map_err(|_| unavailable("Invalid diff path"))?
                .to_owned();
                let number = |value: &[u8]| -> Result<u64> {
                    if value == b"-" {
                        Ok(0)
                    } else {
                        std::str::from_utf8(value)
                            .ok()
                            .and_then(|s| s.parse().ok())
                            .ok_or_else(|| unavailable("Invalid diff count"))
                    }
                };
                Ok((path, number(added)?, number(deleted)?, added == b"-"))
            })
            .collect()
    }
    /// Text diff for a selected path in the session's saved delta.
    pub fn diff(&self, before: &str, after: &str, path: &str) -> Result<String> {
        validate_oid(before)?;
        validate_oid(after)?;
        if !valid_path(path) {
            return Err(unavailable("Invalid diff path"));
        }
        let out = self.run(
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                before,
                after,
                "--",
                path,
            ],
            None,
            None,
        )?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
    /// Read a raw blob; no filters, text conversion or network fetches.
    pub fn blob(&self, oid: &str) -> Result<Vec<u8>> {
        validate_oid(oid)?;
        let size = self.run(&["cat-file", "-s", oid], None, None)?;
        let size = String::from_utf8_lossy(&size)
            .trim()
            .parse::<u64>()
            .map_err(|_| unavailable("Invalid checkpoint blob size"))?;
        if size > self.limits.file_bytes {
            return Err(unavailable("Checkpoint blob exceeds size limit"));
        }
        let bytes = self.run(&["cat-file", "blob", oid], None, None)?;
        if bytes.len() as u64 > self.limits.file_bytes {
            return Err(unavailable("Checkpoint blob exceeds size limit"));
        }
        Ok(bytes)
    }
    pub(crate) fn hash(&self, bytes: &[u8]) -> Result<String> {
        let out = self.run(
            &["hash-object", "-w", "--stdin", "--no-filters"],
            Some(bytes),
            None,
        )?;
        let oid = String::from_utf8_lossy(&out).trim().to_owned();
        validate_oid(&oid)?;
        Ok(oid)
    }
    // Blob-only import streams captured bytes without paths, filters, or a second payload copy.
    fn hash_many(&self, contents: &BTreeMap<String, (Vec<u8>, String)>) -> Result<Vec<String>> {
        if contents.is_empty() {
            return Ok(Vec::new());
        }
        let mut cmd = self.command(None);
        cmd.arg(format!(
            "--git-dir={}",
            self.dir.join("objects.git").display()
        ))
        .args(["fast-import", "--quiet", "--done"]);
        let out = output_with(cmd, |stdin| {
            for (index, (bytes, _)) in contents.values().enumerate() {
                writeln!(stdin, "blob\nmark :{}\ndata {}", index + 1, bytes.len())?;
                stdin.write_all(bytes)?;
                writeln!(stdin)?;
            }
            for index in 1..=contents.len() {
                writeln!(stdin, "get-mark :{index}")?;
            }
            writeln!(stdin, "done")
        })?;
        let text =
            String::from_utf8(out).map_err(|_| unavailable("Invalid imported object IDs"))?;
        let oids: Vec<String> = text.lines().map(str::to_owned).collect();
        if oids.len() != contents.len() {
            return Err(unavailable("Checkpoint import object count mismatch"));
        }
        for oid in &oids {
            validate_oid(oid)?;
        }
        Ok(oids)
    }
    /// Capture twice and require identical observations. This detects races, not write attribution.
    pub fn capture(&self, root: &std::path::Path, coverage: Coverage) -> Result<Snapshot> {
        let root = fs::canonicalize(root)?;
        if self.dir.starts_with(&root) {
            return Err(unavailable(
                "Checkpoint store must be outside the workspace",
            ));
        }
        self.check_quota()?;
        let identity = scan::root_identity(&root)?;
        // Re-read every raw byte for race detection, but avoid a second Git process for an
        // identical file. The transient cache is bounded by snapshot_bytes and never persisted.
        let mut contents = BTreeMap::new();
        let (mut first, git) = self.scan(&root, &coverage, &mut contents, true)?;
        let oids = self.hash_many(&contents)?;
        for ((path, (_, oid)), imported) in contents.iter_mut().zip(oids) {
            *oid = imported.clone();
            first.get_mut(path).expect("captured path").oid = imported;
        }
        let (files, after) = self.scan(&root, &coverage, &mut contents, false)?;
        if first != files || git != after || identity != scan::root_identity(&root)? {
            return Err(unavailable(
                "Workspace changed while checkpointing; try again after writers settle",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let tree = self.publish(&files, &id)?;
        Ok(Snapshot {
            id,
            root,
            identity,
            tree,
            files,
            git,
            coverage,
        })
    }
    /// Ensure a recovery snapshot retained by an in-memory preview still has its tree ref.
    pub fn retain_snapshot(&self, snapshot: &Snapshot) -> Result<()> {
        let reference = format!("refs/checkpoints/{}", snapshot.id);
        if let Ok(existing) = self.run(&["rev-parse", "--verify", &reference], None, None) {
            if String::from_utf8_lossy(&existing).trim() != snapshot.tree {
                return Err(unavailable("Checkpoint retention ref changed"));
            }
        } else if self.publish(&snapshot.files, &snapshot.id)? != snapshot.tree {
            return Err(unavailable("Checkpoint manifest does not match tree"));
        }
        Ok(())
    }
    /// Persist a supplied complete manifest as an independently retained tree.
    pub fn publish(&self, files: &Manifest, id: &str) -> Result<String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(unavailable("Invalid checkpoint ID"));
        }
        let index = self.dir.join(format!("{id}.index"));
        let result = (|| {
            self.run(&["read-tree", "--empty"], None, Some(&index))?;
            let mut records = Vec::new();
            for (path, state) in files {
                if !valid_path(path)
                    || !["100644", "100755", "120000"].contains(&state.mode.as_str())
                {
                    return Err(unavailable("Invalid checkpoint entry"));
                }
                validate_oid(&state.oid)?;
                records.extend_from_slice(
                    format!("{} {}\t{}\0", state.mode, state.oid, path).as_bytes(),
                );
            }
            self.run(
                &["update-index", "-z", "--index-info"],
                Some(&records),
                Some(&index),
            )?;
            let out = self.run(&["write-tree"], None, Some(&index))?;
            let tree = String::from_utf8_lossy(&out).trim().to_owned();
            validate_oid(&tree)?;
            let reference = format!("refs/checkpoints/{id}");
            let zeros = "0".repeat(tree.len());
            self.run(&["update-ref", &reference, &tree, &zeros], None, None)?;
            fs::File::open(self.dir.join("objects.git"))?.sync_all()?;
            Ok(tree)
        })();
        let _ = fs::remove_file(index);
        result
    }
}
pub(crate) fn validate_oid(oid: &str) -> Result<()> {
    if ![40, 64].contains(&oid.len()) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(unavailable("Invalid checkpoint object ID"));
    }
    Ok(())
}
pub(crate) fn output(cmd: Command, input: Option<&[u8]>) -> Result<Vec<u8>> {
    output_with(cmd, |stdin| stdin.write_all(input.unwrap_or_default()))
}
fn output_with(
    mut cmd: Command,
    write: impl FnOnce(&mut std::process::ChildStdin) -> std::io::Result<()> + Send,
) -> Result<Vec<u8>> {
    std::thread::scope(|scope| {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        // Drain output concurrently with bounded input to avoid pipe deadlocks.
        let writer = scope.spawn(move || write(&mut stdin));
        fn bounded_read(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            (&mut pipe)
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err(std::io::Error::other(
                    "Checkpoint Git output exceeded limit",
                ));
            }
            Ok(bytes)
        }
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdout = scope.spawn(move || bounded_read(stdout));
        let stderr = scope.spawn(move || bounded_read(stderr));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unavailable("Checkpoint Git operation timed out"));
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        let out = stdout
            .join()
            .map_err(|_| unavailable("Git output worker failed"))??;
        let stderr = stderr
            .join()
            .map_err(|_| unavailable("Git error worker failed"))??;
        let wrote = writer
            .join()
            .map_err(|_| unavailable("Git input worker failed"))?;
        if !status.success() {
            return Err(unavailable(format!(
                "Checkpoint Git operation failed: {}",
                String::from_utf8_lossy(&stderr)
                    .chars()
                    .take(500)
                    .collect::<String>()
            )));
        }
        wrote?;
        Ok(out)
    })
}
