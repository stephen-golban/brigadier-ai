//! Cross-process cooperative workspace exclusion. External programs do not honor this lock.
//!
//! A refusal names its holder where it can: the kind, id, path, pid and lock file all come from a
//! record the holder writes into the lock file, because `flock` itself will not say who holds it.
//! The registry is swept on every acquisition, because it is one file per directory ever locked
//! and nothing else ever deletes them.
//! see docs/research/workspace-lock-holder-identity-2026-09-11.md
use super::{
    owner::{self, LeaseKind, LockConflict, LockOwner},
    *,
};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
struct RecoveryMarker {
    operation: String,
    root: PathBuf,
    identity: String,
    ancestors: Vec<String>,
    /// Additive: markers written before 2026-09-11 have neither field.
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    started_at: Option<u64>,
}

/// Held for an entire app-owned writer epoch or rewind transaction.
#[derive(Debug)]
pub struct WorkspaceLease {
    /// Each held lock file and whether we hold it exclusively, which is also whether our identity
    /// record is in it and has to come back out before we let go.
    files: Vec<(File, bool)>,
    marker: PathBuf,
    root: PathBuf,
    identity: String,
    ancestors: Vec<String>,
    /// The identity published into every exclusively-held file above, kept so a shared lease can
    /// be re-pointed at a different holder. see [`WorkspaceLease::relabel`].
    owner: std::sync::Mutex<LockOwner>,
}
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Exclusive,
    Writer,
    Terminal,
}
/// The first sweep in a process pays for the backlog; every later one stays out of the way of a
/// session start. see docs/research/workspace-lock-holder-identity-2026-09-11.md §4.
const FIRST_SWEEP: (usize, Duration) = (4096, Duration::from_millis(150));
const LATER_SWEEP: (usize, Duration) = (256, Duration::from_millis(25));
/// The failure-path search for a holder that published its record in some other lock file.
const SEARCH: (usize, Duration) = (2048, Duration::from_millis(50));
/// The recovery-marker branch's own budget, for the *removal* checks only. The read and the
/// overlap test are never skipped: missing one marker lets a turn write into a workspace with an
/// unresolved restore, which is the one thing this registry exists to prevent.
const MARKERS: (usize, Duration) = (512, Duration::from_millis(50));
/// A registry this size can only have come from a leak, so the scan that finds it sweeps hard
/// instead of refusing. A hard error here bricked every acquisition until someone swept by hand.
const FLOOD: (usize, Duration) = (65_536, Duration::from_secs(2));
const FLOOD_AT: usize = 100_000;
/// How long [`take`] keeps re-opening a lock file that the sweep moved under it.
const TAKE_WINDOW: Duration = Duration::from_millis(250);
/// A `block()` that died between create and rename leaves scratch behind.
const SCRATCH_AGE: Duration = Duration::from_secs(3600);
static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

impl WorkspaceLease {
    /// Refuse overlapping ancestor, descendant, or identical writers in any app process.
    pub fn acquire(root: &Path) -> Result<Self> {
        Self::open(root, None, Mode::Exclusive, None)
    }
    /// As [`WorkspaceLease::acquire`], naming the session so a later refusal can point at it.
    pub fn acquire_as(root: &Path, session: &str) -> Result<Self> {
        Self::open(root, None, Mode::Exclusive, Some(session))
    }
    /// Reacquire a blocked workspace for its exact recovery operation only.
    pub fn recover(root: &Path, operation: &str) -> Result<Self> {
        Self::open(root, Some(operation), Mode::Exclusive, Some(operation))
    }
    /// Serialize app-owned writers while allowing the user's interactive shells to remain open.
    /// Shell edits are external activity; capture still validates the files it reads.
    pub fn writer(root: &Path) -> Result<Self> {
        Self::open(root, None, Mode::Writer, None)
    }
    /// As [`WorkspaceLease::writer`], naming the session so a later refusal can point at it.
    pub fn writer_as(root: &Path, session: &str) -> Result<Self> {
        Self::open(root, None, Mode::Writer, Some(session))
    }
    /// Protect a shell from destructive restore/removal, without blocking ordinary AI turns.
    /// The terminal registry shares this lease for shells at the same canonical root.
    pub fn terminal(root: &Path) -> Result<Self> {
        Self::open(root, None, Mode::Terminal, None)
    }
    /// As [`WorkspaceLease::terminal`], naming the terminal so a refused turn can say which one
    /// to close. This is the owner's 2026-09-11 failure: a shell held the workspace and the
    /// message said only that something did.
    pub fn terminal_as(root: &Path, terminal: &str) -> Result<Self> {
        Self::open(root, None, Mode::Terminal, Some(terminal))
    }
    /// Sweep the lock registry without taking a lease, for a caller that runs at process start.
    /// Returns how many dead entries it removed; see [`WorkspaceLease::acquire`] for the rule.
    pub fn sweep_registry() -> Result<usize> {
        let dir = registry_dir()?;
        Ok(sweep(&dir, &[], FIRST_SWEEP))
    }
    /// Re-point this lease's published identity at another holder.
    ///
    /// One lease is shared by every terminal tab at the same root, so the tab that opened it is
    /// often closed while the workspace is still held. A refusal that names a tab the user has
    /// already closed sends them looking for something that is not there.
    pub fn relabel(&self, id: &str) {
        let mut owner = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if owner.id.as_deref() == Some(id) {
            return;
        }
        owner.id = Some(id.to_owned());
        for (file, exclusive) in &self.files {
            if *exclusive {
                let _ = owner::publish(file, &owner);
            }
        }
    }
    /// Point the registry at a private per-process directory, once.
    ///
    /// **Test support.** A test binary that does not call this reads *and sweeps* the developer's
    /// real `~/.brigadier/workspace-locks-v1`. Idempotent and cheap; call it before the binary's
    /// first lease, because a lease taken before the first call still uses the real registry.
    pub fn isolate_registry_for_tests() -> PathBuf {
        static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        DIR.get_or_init(|| {
            // Never fight a registry someone else already chose: a binary with two isolation
            // helpers that pick different directories would move the registry under a live lease.
            if let Some(chosen) = std::env::var_os("BRIGADIER_WORKSPACE_LOCK_DIR") {
                return PathBuf::from(chosen);
            }
            let dir =
                std::env::temp_dir().join(format!("brigadier-locks-test-{}", std::process::id()));
            let _ = fs::create_dir_all(&dir);
            std::env::set_var("BRIGADIER_WORKSPACE_LOCK_DIR", &dir);
            dir
        })
        .clone()
    }
    fn open(root: &Path, recovery: Option<&str>, mode: Mode, id: Option<&str>) -> Result<Self> {
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
        let dir = registry_dir()?;
        let marker = dir.join(format!(
            "{}-{name:016x}.recovery",
            identity.replace(':', "-")
        ));
        let kind = match (mode, recovery) {
            (Mode::Exclusive, Some(_)) => LeaseKind::Restore,
            (Mode::Exclusive, None) => LeaseKind::Turn,
            (Mode::Writer, _) => LeaseKind::Writer,
            (Mode::Terminal, _) => LeaseKind::Terminal,
        };
        let me = LockOwner {
            kind,
            id: id.map(str::to_owned),
            root: root.clone(),
            pid: std::process::id(),
            started_at: owner::now(),
        };
        let mut lease = Self {
            files: Vec::new(),
            marker,
            root,
            identity,
            ancestors,
            owner: std::sync::Mutex::new(me.clone()),
        };
        let mut held = Vec::new();
        // Writer locks retain the existing ancestor/descendant exclusion between AI turns.
        // Two separate terminal gates distinguish a shell rooted at an ancestor from a shell
        // below us. Destructive operations conflict in both directions; siblings remain free.
        let keys = lease.ancestors.clone();
        for (i, key) in keys.iter().enumerate().rev() {
            let key = key.replace(':', "-");
            let mut hold = |name: String, exclusive: bool| -> Result<()> {
                let file = take(&dir, &name, exclusive, &me)?;
                lease.files.push((file, exclusive));
                held.push(name);
                Ok(())
            };
            if mode != Mode::Terminal {
                hold(key.clone(), i == 0)?;
            }
            match mode {
                Mode::Exclusive => {
                    hold(format!("terminal-root-{key}"), false)?;
                    if i == 0 {
                        hold(format!("terminal-desc-{key}"), true)?;
                    }
                }
                Mode::Terminal => {
                    hold(format!("terminal-desc-{key}"), false)?;
                    if i == 0 {
                        hold(format!("terminal-root-{key}"), true)?;
                    }
                }
                Mode::Writer => {}
            }
        }
        // Durable blockers outlive their OS locks. Publishing a marker requires the same
        // hierarchy lease, so an overlapping writer cannot race this scan. The same pass sweeps
        // the registry, because this is the only moment we are certain which files are ours.
        let mut budget = Budget::new(if SWEPT.swap(true, std::sync::atomic::Ordering::Relaxed) {
            LATER_SWEEP
        } else {
            FIRST_SWEEP
        });
        let mut markers = Budget::new(MARKERS);
        for (count, entry) in fs::read_dir(&dir)?.enumerate() {
            if count == FLOOD_AT {
                tracing::warn!(
                    entries = count,
                    dir = %dir.display(),
                    "workspace lock registry is flooded; sweeping hard"
                );
                budget = Budget::new(FLOOD);
            }
            let path = entry?.path();
            if path.extension().and_then(|x| x.to_str()) != Some("recovery") {
                collect(&path, &held, &mut budget);
                continue;
            }
            let held_marker = match Self::read_marker(&path) {
                Ok(marker) => marker,
                Err(e) if !path.exists() => {
                    let _ = e;
                    continue;
                } // unrelated sibling resolved
                Err(e) => return Err(e),
            };
            // A marker whose root is gone can never be recovered into and would only refuse a
            // future directory that reuses the path. A marker whose root still exists is never
            // removed, however dead its pid: outliving its process is what it is for.
            if markers.spend() && vanished(&held_marker.root) {
                let _ = fs::remove_file(&path);
                continue;
            }
            let still_same_root =
                scan::root_identity(&held_marker.root).is_ok_and(|id| id == held_marker.identity);
            let overlaps = lease.root.starts_with(&held_marker.root)
                || held_marker.root.starts_with(&lease.root)
                || still_same_root
                    && (held_marker.ancestors.contains(&lease.identity)
                        || lease.ancestors.contains(&held_marker.identity));
            let mine = recovery == Some(held_marker.operation.as_str())
                && held_marker.identity == lease.identity;
            if mine {
                lease.marker = path.clone();
            }
            if overlaps && !mine {
                return Err(unavailable(format!(
                    "Workspace requires recovery {}: an unresolved restore on {} is recorded in {}{}",
                    held_marker.operation,
                    held_marker.root.display(),
                    path.display(),
                    held_marker
                        .pid
                        .map(|pid| format!(" by pid {pid}"))
                        .unwrap_or_default(),
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
            pid: Some(std::process::id()),
            started_at: Some(owner::now()),
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
        for (file, exclusive) in self.files.iter().rev() {
            // Take our identity back out first: a released file must not name us as its holder.
            if *exclusive {
                owner::retract(file);
            }
            let _ = file.unlock();
        }
    }
}

/// Recovery blockers must survive reboot/temp cleanup and coordinate across data directories.
/// Tests may explicitly isolate this registry; app processes must use the same per-user location.
fn registry_dir() -> Result<PathBuf> {
    #[cfg(unix)]
    let owner_uid = nix::unistd::getuid().as_raw();
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
        if !m.is_dir() || m.uid() != owner_uid {
            return Err(unavailable("Unsafe workspace lock directory"));
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn lock_file(path: &Path, create: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// `flock` follows the inode, not the name, so a sweep that unlinks a dead lock file between our
/// open and our lock would leave us holding an orphan while a third process locks a fresh file of
/// the same name. Re-stat after locking and start over when they differ.
/// see docs/research/workspace-lock-holder-identity-2026-09-11.md §3.
fn same_file(file: &File, path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let locked = file.metadata()?;
        match fs::symlink_metadata(path) {
            Ok(named) => Ok(named.dev() == locked.dev() && named.ino() == locked.ino()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (file, path);
        Ok(true)
    }
}

/// Take one lock file, prove it is still the file at that name, and publish our identity into it
/// when we hold it exclusively.
fn take(dir: &Path, name: &str, exclusive: bool, me: &LockOwner) -> Result<File> {
    let path = dir.join(name);
    // Two different retries, on two different clocks: re-opening a file the sweep unlinked costs
    // nothing and is bounded by the window, while an ownerless refusal sleeps and is bounded by a
    // count, so a genuine shared-holder conflict cannot be delayed by more than three sleeps.
    let deadline = Instant::now() + TAKE_WINDOW;
    let mut ownerless = 0u32;
    loop {
        let file = lock_file(&path, true)?;
        let locked = if exclusive {
            file.try_lock()
        } else {
            file.try_lock_shared()
        };
        match locked {
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
            Err(std::fs::TryLockError::WouldBlock) => {
                let holder = owner::read(&path);
                // The sweep holds a dead file exclusively for the instant before it unlinks it,
                // so an ownerless refusal is worth retrying before it is called a conflict.
                if holder.is_some() || ownerless == 3 || Instant::now() >= deadline {
                    return Err(busy(dir, &path, holder, me));
                }
                ownerless += 1;
                std::thread::sleep(Duration::from_millis(3));
            }
            Ok(()) => {
                if same_file(&file, &path)? {
                    if exclusive {
                        let _ = owner::publish(&file, me);
                    }
                    return Ok(file);
                }
                let _ = file.unlock();
                if Instant::now() >= deadline {
                    return Err(busy(dir, &path, None, me));
                }
            }
        }
    }
}

/// Turn a refusal into something the user can act on. A record naming a dead process is reported
/// as stale, and the registry is searched once for a live holder that published elsewhere —
/// a lock taken *shared* carries no record, so the file that refused us is often not the one the
/// holder wrote to. see docs/research/workspace-lock-holder-identity-2026-09-11.md §1.
fn busy(dir: &Path, lock_path: &Path, holder: Option<LockOwner>, me: &LockOwner) -> Error {
    // A record only describes *this* file if it names the directory the file is keyed to. A
    // SIGKILLed exclusive holder leaves its record behind in a file that others may still hold
    // shared, and with pid reuse that record would name an unrelated live process.
    let holder = holder.filter(|held| names_this_lock(held, lock_path));
    let (holder, holder_live) = match holder {
        Some(held) if owner::alive(held.pid) => (Some(held), true),
        held => match search(dir, me) {
            Some(found) => (Some(found), true),
            None => (held, false),
        },
    };
    Error::Busy(Box::new(LockConflict {
        kind: me.kind,
        root: me.root.clone(),
        lock_path: lock_path.to_path_buf(),
        holder,
        holder_live,
    }))
}

/// Whether a record found in a lock file is about the directory that file is keyed to.
fn names_this_lock(holder: &LockOwner, lock_path: &Path) -> bool {
    let Some(name) = lock_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let key = name
        .strip_prefix("terminal-root-")
        .or_else(|| name.strip_prefix("terminal-desc-"))
        .unwrap_or(name);
    scan::root_identity(&holder.root).is_ok_and(|id| id.replace(':', "-") == key)
}

/// Any live record whose root overlaps ours, other than the one this lease just published.
fn search(dir: &Path, me: &LockOwner) -> Option<LockOwner> {
    let mut budget = Budget::new(SEARCH);
    for entry in fs::read_dir(dir).ok()? {
        if !budget.spend() {
            break;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if matches!(
            path.extension().and_then(|x| x.to_str()),
            Some("recovery" | "tmp")
        ) {
            continue;
        }
        let Some(found) = owner::read(&path) else {
            continue;
        };
        if found != *me
            && (found.root.starts_with(&me.root) || me.root.starts_with(&found.root))
            && owner::alive(found.pid)
        {
            return Some(found);
        }
    }
    None
}

/// A probe count and a wall-clock deadline, whichever runs out first.
struct Budget {
    probes: usize,
    deadline: Instant,
}
impl Budget {
    fn new((probes, window): (usize, Duration)) -> Self {
        Self {
            probes,
            deadline: Instant::now() + window,
        }
    }
    fn spend(&mut self) -> bool {
        if self.probes == 0 || Instant::now() >= self.deadline {
            return false;
        }
        self.probes -= 1;
        true
    }
}

/// Whether a recorded root is genuinely gone, as opposed to merely unreachable. Only `NotFound`
/// counts: `EACCES`, `EIO`, `ELOOP` and `ESTALE` all mean "cannot tell", and unlinking a durable
/// recovery blocker on a guess loses an unresolved restore for good. A `NotFound` whose nearest
/// existing ancestor is a mount point is refused too — an unmounted volume makes every path below
/// it vanish without anything having been deleted.
fn vanished(root: &Path) -> bool {
    match fs::symlink_metadata(root) {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => !under_mount_boundary(root),
        Err(_) => false,
    }
}
#[cfg(unix)]
fn under_mount_boundary(root: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Some(existing) = root.ancestors().find(|p| fs::symlink_metadata(p).is_ok()) else {
        return true;
    };
    let Some(parent) = existing.parent() else {
        return false; // the filesystem root is its own parent; nothing was unmounted
    };
    match (fs::symlink_metadata(existing), fs::symlink_metadata(parent)) {
        (Ok(here), Ok(above)) => here.dev() != above.dev(),
        _ => true, // cannot tell: keep the blocker
    }
}
#[cfg(not(unix))]
fn under_mount_boundary(_: &Path) -> bool {
    true
}

/// One registry entry, considered for deletion. A lock file nobody holds is dead the moment we can
/// take it exclusively, and it is unlinked while that lock is still held, so the only process that
/// can be mid-acquisition on the old inode detects the mismatch in [`same_file`] and retries.
fn collect(path: &Path, held: &[String], budget: &mut Budget) -> bool {
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_none_or(|name| held.iter().any(|ours| ours == name))
        || !budget.spend()
    {
        return false;
    }
    if path.extension().and_then(|x| x.to_str()) == Some("tmp") {
        // Scratch from a `block()` that died between create and rename.
        let stale = fs::symlink_metadata(path)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t.elapsed().is_ok_and(|age| age > SCRATCH_AGE));
        return stale && fs::remove_file(path).is_ok();
    }
    let Ok(file) = lock_file(path, false) else {
        return false;
    };
    if file.try_lock().is_err() || !same_file(&file, path).unwrap_or(false) {
        return false;
    }
    let removed = fs::remove_file(path).is_ok();
    let _ = file.unlock();
    removed
}

/// Sweep without holding a lease. Entries this process holds are refused by their own locks.
fn sweep(dir: &Path, held: &[String], bound: (usize, Duration)) -> usize {
    let mut budget = Budget::new(bound);
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for (count, entry) in entries.enumerate() {
        if count >= 100_000 {
            break;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) == Some("recovery") {
            // Same rule as the scan in `open`: a blocker whose root is gone can never be
            // recovered into. Every other marker is left exactly where it is.
            if budget.spend() && WorkspaceLease::read_marker(&path).is_ok_and(|m| vanished(&m.root))
            {
                removed += usize::from(fs::remove_file(&path).is_ok());
            }
            continue;
        }
        removed += usize::from(collect(&path, held, &mut budget));
    }
    removed
}
