use super::*;
use std::{collections::BTreeSet, fs, io::Read, path::Path};

/// Explicit v1 source-file scope. Policy changes invalidate existing epochs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Coverage {
    /// Wire/coverage rules version.
    pub version: u32,
    /// Explicit workspace-relative ignored paths to include.
    pub include_ignored: BTreeSet<String>,
}
impl Default for Coverage {
    fn default() -> Self {
        Self {
            version: 1,
            include_ignored: BTreeSet::new(),
        }
    }
}
/// Hard bounds; exceeding them makes capture unavailable, never silently partial.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Maximum covered entries.
    pub files: usize,
    /// Maximum bytes in one file.
    pub file_bytes: u64,
    /// Maximum covered raw bytes.
    pub snapshot_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            files: 10_000,
            file_bytes: 32 * 1024 * 1024,
            snapshot_bytes: 512 * 1024 * 1024,
        }
    }
}

pub(crate) fn excluded(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(
            part,
            ".git"
                | ".brigadier"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".cache"
                | ".venv"
                | "venv"
                | "__pycache__"
        ) || part == ".env"
            || part.starts_with(".env.") && !part.ends_with(".example")
            || part.ends_with(".pem")
            || part.ends_with(".key")
    })
}
pub(crate) fn root_identity(root: &Path) -> Result<String> {
    let m = fs::metadata(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        Err(unavailable(
            "Workspace checkpoints require Unix filesystem identity support",
        ))
    }
}
impl SnapshotStore {
    fn source(&self, root: &Path, args: &[&str]) -> Result<Vec<u8>> {
        let mut cmd = self.command(Some(root));
        cmd.env_remove("GIT_CONFIG_GLOBAL");
        cmd.env_remove("GIT_CONFIG_NOSYSTEM");
        cmd.args(args);
        super::git::output(cmd, None)
    }
    pub(crate) fn scan(
        &self,
        root: &Path,
        coverage: &Coverage,
        contents: &mut BTreeMap<String, (Vec<u8>, String)>,
        remember: bool,
    ) -> Result<(Manifest, GitState)> {
        if coverage.version != 1 {
            return Err(unavailable("Unsupported checkpoint coverage version"));
        }
        let mut policy = Vec::new();
        let mut candidates = BTreeSet::new();
        let probe = self.source(root, &["rev-parse", "--show-toplevel"]);
        if let Err(e) = &probe {
            if root
                .ancestors()
                .any(|p| fs::symlink_metadata(p.join(".git")).is_ok())
                || !e.to_string().contains("not a git repository")
            {
                return Err(unavailable(format!(
                    "Cannot inspect source repository: {e}"
                )));
            }
        }
        let git = if let Ok(top) = probe {
            let top = PathBuf::from(String::from_utf8_lossy(&top).trim());
            if fs::canonicalize(top)? != root {
                return Err(unavailable(
                    "Checkpoint workspace must be the repository root",
                ));
            }
            let mut head = self
                .source(root, &["symbolic-ref", "-q", "HEAD"])
                .unwrap_or_default();
            head.extend(
                self.source(root, &["rev-parse", "--verify", "HEAD"])
                    .unwrap_or_else(|_| b"unborn".to_vec()),
            );
            let index = self.source(root, &["ls-files", "--stage", "-v", "-z"])?;
            if index
                .split(|b| *b == 0)
                .any(|r| r.get(2..8) == Some(b"160000"))
            {
                return Err(unavailable("Submodule checkpoints are not supported"));
            }
            let names = self.source(
                root,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
            )?;
            for bytes in names.split(|b| *b == 0).filter(|n| !n.is_empty()) {
                let path = std::str::from_utf8(bytes)
                    .map_err(|_| unavailable("Non-UTF-8 workspace paths are not supported"))?;
                if !excluded(path) {
                    candidates.insert(path.to_owned());
                }
            }
            // Source inventory honors the user's ignore configuration, with hooks/fsmonitor disabled.
            policy.extend(self.source(root, &["rev-parse", "--absolute-git-dir"])?);
            let common = self.source(
                root,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )?;
            let common = PathBuf::from(String::from_utf8_lossy(&common).trim());
            let global = self
                .source(root, &["config", "--path", "--get", "core.excludesFile"])
                .unwrap_or_default();
            let global = if global.is_empty() {
                std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
                    .map(|p| p.join("git/ignore"))
            } else {
                Some(PathBuf::from(
                    String::from_utf8_lossy(&global).trim_end_matches('\n'),
                ))
            };
            for path in std::iter::once(common.join("info/exclude")).chain(global) {
                policy.extend(path.to_string_lossy().as_bytes());
                policy.push(0);
                match fs::read(&path) {
                    Ok(bytes) => {
                        if bytes.len() > 1024 * 1024 {
                            return Err(unavailable("Ignore policy exceeds checkpoint limit"));
                        }
                        policy.extend(bytes)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
                policy.push(0);
            }
            let gitdir = self.source(root, &["rev-parse", "--absolute-git-dir"])?;
            let gitdir = PathBuf::from(String::from_utf8_lossy(&gitdir).trim());
            for name in [
                "MERGE_HEAD",
                "rebase-merge",
                "rebase-apply",
                "CHERRY_PICK_HEAD",
                "REVERT_HEAD",
            ] {
                if gitdir.join(name).exists() {
                    return Err(unavailable(
                        "Git operation in progress; checkpoint unavailable",
                    ));
                }
            }
            // Conflicted/sparse indexes are outside v1's restore contract.
            if !self
                .source(root, &["ls-files", "--unmerged", "-z"])?
                .is_empty()
                || self
                    .source(root, &["config", "--bool", "core.sparseCheckout"])
                    .unwrap_or_default()
                    == b"true\n"
            {
                return Err(unavailable("Sparse or conflicted index is unsupported"));
            }
            GitState {
                head: String::from_utf8_lossy(&head).into_owned(),
                index,
                policy: Vec::new(),
            }
        } else {
            self.walk(root, root, &mut candidates)?;
            GitState {
                head: "non-git".into(),
                index: Vec::new(),
                policy: Vec::new(),
            }
        };
        candidates.extend(coverage.include_ignored.iter().cloned());
        if candidates.len() > self.limits.files {
            return Err(unavailable("Workspace has too many checkpointed files"));
        }
        let mut files = Manifest::new();
        let mut total = 0u64;
        let mut metadata_bytes = 0usize;
        for path in candidates {
            if !valid_path(&path) {
                return Err(unavailable("Invalid workspace path"));
            }
            if excluded(&path) {
                continue;
            }
            let full = root.join(&path);
            // Resolve every parent without following symbolic directory entries.
            let mut parent = root.to_path_buf();
            for part in Path::new(&path)
                .parent()
                .unwrap_or(Path::new(""))
                .components()
            {
                parent.push(part);
                match fs::symlink_metadata(&parent) {
                    Ok(m) if m.file_type().is_symlink() => {
                        return Err(unavailable("Symlink directory in checkpoint path"))
                    }
                    Ok(m) if !m.is_dir() => {
                        return Err(unavailable("Checkpoint parent is not a directory"))
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                    Err(e) => return Err(e.into()),
                    _ => {}
                }
                if parent.join(".git").exists() {
                    return Err(unavailable("Nested repositories are unsupported"));
                }
            }
            let meta = match fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            if meta.is_dir() {
                return Err(unavailable(
                    "Nested directory/gitlink in checkpoint inventory",
                ));
            }
            let mut metadata = None;
            let (mode, bytes) = if meta.file_type().is_symlink() {
                let link = fs::read_link(&full)?;
                #[cfg(unix)]
                {
                    use std::os::unix::ffi::OsStrExt;
                    ("120000", link.as_os_str().as_bytes().to_vec())
                }
                #[cfg(not(unix))]
                {
                    let _ = link;
                    return Err(unavailable("Symlink capture unavailable"));
                }
            } else if meta.is_file() {
                if meta.len() > self.limits.file_bytes {
                    return Err(unavailable(format!(
                        "File exceeds checkpoint size limit: {path}"
                    )));
                }
                #[cfg(unix)]
                use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
                let mut opts = fs::OpenOptions::new();
                opts.read(true);
                #[cfg(unix)]
                opts.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
                let mut file = opts.open(&full)?;
                let opened = file.metadata()?;
                #[cfg(unix)]
                {
                    metadata = Some(super::restore::capture_metadata(&file, &full)?);
                }
                #[cfg(not(unix))]
                return Err(unavailable(
                    "Checkpoint metadata unsupported on this platform",
                ));
                #[cfg(unix)]
                if (meta.dev(), meta.ino()) != (opened.dev(), opened.ino()) {
                    return Err(unavailable("File changed while opening checkpoint"));
                }
                let mut bytes = Vec::new();
                (&mut file)
                    .take(self.limits.file_bytes + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > self.limits.file_bytes {
                    return Err(unavailable("File grew beyond checkpoint limit"));
                }
                #[cfg(unix)]
                let executable = meta.mode() & 0o111 != 0;
                #[cfg(not(unix))]
                let executable = false;
                (if executable { "100755" } else { "100644" }, bytes)
            } else {
                return Err(unavailable(format!("Unsupported special file: {path}")));
            };
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| unavailable("Snapshot size overflow"))?;
            if total > self.limits.snapshot_bytes {
                return Err(unavailable("Workspace exceeds checkpoint size limit"));
            }
            if path.ends_with(".gitignore") {
                policy.extend(path.as_bytes());
                policy.push(0);
                policy.extend(&bytes);
                policy.push(0);
            }
            metadata_bytes += metadata.as_ref().map_or(0, |m| {
                m.attributes
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>()
            });
            if metadata_bytes > 16 * 1024 * 1024 {
                return Err(unavailable("Workspace metadata exceeds checkpoint limit"));
            }
            let oid = match contents.remove(&path) {
                Some((previous, oid)) if previous == bytes => oid,
                _ if remember => String::new(),
                _ => self.hash(&bytes)?,
            };
            let length = bytes.len() as u64;
            if remember {
                contents.insert(path.clone(), (bytes, oid.clone()));
            }
            files.insert(
                path,
                PathState {
                    oid,
                    mode: mode.into(),
                    bytes: length,
                    metadata,
                },
            );
        }
        let mut git = git;
        git.policy = policy;
        Ok((files, git))
    }
    fn walk(&self, root: &Path, dir: &Path, names: &mut BTreeSet<String>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .ok_or_else(|| unavailable("Non-UTF-8 path"))?
                .to_owned();
            if excluded(&rel) {
                continue;
            }
            let ty = entry.file_type()?;
            if ty.is_dir() {
                if path.join(".git").exists() {
                    return Err(unavailable("Nested repository unsupported"));
                }
                self.walk(root, &path, names)?;
            } else {
                names.insert(rel);
            }
            if names.len() > self.limits.files {
                return Err(unavailable("Workspace exceeds checkpoint file limit"));
            }
        }
        Ok(())
    }
}
