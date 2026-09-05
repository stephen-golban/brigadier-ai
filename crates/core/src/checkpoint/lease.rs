//! Cross-process cooperative workspace exclusion. External programs do not honor this lock.
use super::*;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct RecoveryMarker {
    operation: String,
    root: PathBuf,
    identity: String,
    ancestors: Vec<String>,
}

/// Held for an entire app-owned writer epoch or rewind transaction.
#[derive(Debug)]
pub struct WorkspaceLease {
    files: Vec<File>,
    marker: PathBuf,
    root: PathBuf,
    identity: String,
    ancestors: Vec<String>,
}
impl WorkspaceLease {
    /// Refuse overlapping ancestor, descendant, or identical writers in any app process.
    pub fn acquire(root: &Path) -> Result<Self> {
        Self::open(root, None)
    }
    /// Reacquire a blocked workspace for its exact recovery operation only.
    pub fn recover(root: &Path, operation: &str) -> Result<Self> {
        Self::open(root, Some(operation))
    }
    fn open(root: &Path, recovery: Option<&str>) -> Result<Self> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(unavailable("Workspace is not a directory"));
        }
        let identity = scan::root_identity(&root)?;
        let ancestors = root
            .ancestors()
            .map(scan::root_identity)
            .collect::<Result<Vec<_>>>()?;
        // Lock keys use only directory identity, so aliases cannot bypass exclusion. The
        // marker also includes the canonical name to distinguish recycled directory inodes.
        let name = root
            .to_string_lossy()
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
            });
        #[cfg(unix)]
        let owner = nix::unistd::getuid().as_raw();
        #[cfg(not(unix))]
        let owner = 0;
        // Recovery blockers must survive reboot/temp cleanup and coordinate across data
        // directories. Tests may explicitly isolate this registry; app processes must use
        // the same per-user location.
        let dir = if let Some(path) = std::env::var_os("BRIGADIER_WORKSPACE_LOCK_DIR") {
            PathBuf::from(path)
        } else {
            PathBuf::from(std::env::var_os("HOME").ok_or_else(|| {
                unavailable("HOME is required for the persistent workspace lock registry")
            })?)
            .join(".brigadier/workspace-locks-v1")
        };
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let m = fs::symlink_metadata(&dir)?;
            if !m.is_dir() || m.uid() != owner {
                return Err(unavailable("Unsafe workspace lock directory"));
            }
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        let marker = dir.join(format!(
            "{}-{name:016x}.recovery",
            identity.replace(':', "-")
        ));
        let mut lease = Self {
            files: Vec::new(),
            marker,
            root,
            identity,
            ancestors,
        };
        // Shared ancestors allow siblings; exclusive root excludes both directions of
        // nesting. Each descriptor is independently opened and guarded immediately.
        for (i, key) in lease.ancestors.iter().enumerate().rev() {
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
            }
            let file = options.open(dir.join(key.replace(':', "-")))?;
            let locked = if i == 0 {
                file.try_lock()
            } else {
                file.try_lock_shared()
            };
            locked.map_err(|e| {
                unavailable(format!(
                    "Workspace overlaps another running turn, terminal, or restore operation: {e}"
                ))
            })?;
            lease.files.push(file);
        }
        // Durable blockers outlive their OS locks. Publishing a marker requires the same
        // hierarchy lease, so an overlapping writer cannot race this scan.
        for (count, entry) in fs::read_dir(&dir)?.enumerate() {
            if count >= 100_000 {
                return Err(unavailable(
                    "Workspace lock registry exceeds its scan limit",
                ));
            }
            let path = entry?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("recovery") {
                continue;
            }
            let held = match Self::read_marker(&path) {
                Ok(marker) => marker,
                Err(e) if !path.exists() => {
                    let _ = e;
                    continue;
                } // unrelated sibling resolved
                Err(e) => return Err(e),
            };
            let still_same_root =
                scan::root_identity(&held.root).is_ok_and(|id| id == held.identity);
            let overlaps = lease.root.starts_with(&held.root)
                || held.root.starts_with(&lease.root)
                || still_same_root
                    && (held.ancestors.contains(&lease.identity)
                        || lease.ancestors.contains(&held.identity));
            if recovery == Some(held.operation.as_str()) && held.identity == lease.identity {
                lease.marker = path.clone();
            }
            if overlaps
                && !(recovery == Some(held.operation.as_str()) && held.identity == lease.identity)
            {
                return Err(unavailable(format!(
                    "Workspace requires recovery {}",
                    held.operation
                )));
            }
        }
        // Detect cooperative-root relocation during acquisition; external hostile renames
        // remain outside the supported quiescent workspace contract.
        if scan::root_identity(&lease.root)? != lease.identity {
            return Err(unavailable("Workspace moved while acquiring ownership"));
        }
        Ok(lease)
    }
    fn read_marker(path: &Path) -> Result<RecoveryMarker> {
        let m = fs::symlink_metadata(path)?;
        if !m.is_file() || m.len() > 64 * 1024 {
            return Err(unavailable("Invalid workspace recovery marker"));
        }
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    }
    /// Persist the recovery blocker before the first workspace mutation.
    pub fn block(&self, operation: &str) -> Result<()> {
        use std::io::Write;
        if uuid::Uuid::parse_str(operation).is_err() {
            return Err(unavailable("Invalid recovery identity"));
        }
        if self.marker.exists() {
            let held = Self::read_marker(&self.marker)?;
            if held.operation == operation && held.identity == self.identity {
                return Ok(());
            }
            return Err(unavailable("Workspace already has a recovery marker"));
        }
        let temporary = self
            .marker
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&RecoveryMarker {
            operation: operation.into(),
            root: self.root.clone(),
            identity: self.identity.clone(),
            ancestors: self.ancestors.clone(),
        })?)?;
        file.sync_all()?;
        fs::rename(temporary, &self.marker)?;
        File::open(self.marker.parent().unwrap())?.sync_all()?;
        Ok(())
    }
    /// Release only this transaction's persisted blocker after durable resolution.
    pub fn resolve(&self, operation: &str) -> Result<()> {
        match Self::read_marker(&self.marker) {
            Ok(held) if held.operation == operation && held.identity == self.identity => {
                fs::remove_file(&self.marker)?
            }
            Err(_) if !self.marker.exists() => return Ok(()),
            _ => return Err(unavailable("Recovery marker changed")),
        }
        File::open(self.marker.parent().unwrap())?.sync_all()?;
        Ok(())
    }
}

impl Drop for WorkspaceLease {
    fn drop(&mut self) {
        // A concurrent fork can transiently inherit CLOEXEC descriptors. Close alone leaves
        // flock held until every inherited copy execs/closes; explicitly release ownership.
        for file in self.files.iter().rev() {
            let _ = file.unlock();
        }
    }
}
