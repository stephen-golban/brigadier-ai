use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

/// BLAKE3 hash identifying a blob, as 64 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct BlobHash(String);

impl BlobHash {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BlobHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for BlobHash {
    type Err = Error;
    fn from_str(value: &str) -> Result<Self> {
        let valid = value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        if valid {
            Ok(Self(value.to_owned()))
        } else {
            Err(Error::InvalidBlobHash)
        }
    }
}

impl TryFrom<String> for BlobHash {
    type Error = Error;
    fn try_from(value: String) -> Result<Self> {
        value.parse()
    }
}

impl From<BlobHash> for String {
    fn from(hash: BlobHash) -> Self {
        hash.0
    }
}

/// Content-addressed blob store: `<root>/<first two hex chars>/<hash>`.
///
/// Writes go to a temp file in the same volume, are fsynced, then renamed into place, so a
/// blob is either absent or complete. Identical content is stored once. All methods do
/// blocking I/O; the async wrappers run them on Tokio's blocking pool.
///
/// **Collection rule** (see [`crate::Store::gc_blobs`]): a blob is deleted only when no stored
/// event mentions its hash and it was last put or [touched](BlobStore::touch) more than the
/// grace period ago. Putting content that is already stored, or touching it, restarts its
/// grace period. So whoever puts a blob must append the event that references it within
/// [`crate::BLOB_GC_GRACE`], or touch it again first (e.g. a composer attachment that is sent
/// much later); a blob only referenced from outside the event store is not kept.
#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
    /// Held while a blob is checked-and-refreshed by a put and while GC checks-and-deletes one,
    /// so a put can never refresh a file GC is about to delete.
    gc_lock: Arc<Mutex<()>>,
}

/// One stored blob, as listed for collection.
#[derive(Debug, Clone)]
pub(crate) struct BlobEntry {
    pub(crate) hash: BlobHash,
    pub(crate) modified: SystemTime,
}

/// What [`BlobStore::remove_if_stale_blocking`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Removal {
    Removed {
        bytes: u64,
    },
    /// Put or touched after the cutoff: kept.
    Recent,
    /// Already gone.
    Missing,
}

impl BlobStore {
    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("tmp"))?;
        // Leftovers from a crash mid-write are never referenced; remove them.
        for entry in fs::read_dir(root.join("tmp"))? {
            let _ = fs::remove_file(entry?.path());
        }
        Ok(Self {
            root,
            gc_lock: Arc::default(),
        })
    }

    fn path(&self, hash: &BlobHash) -> PathBuf {
        self.root.join(&hash.0[..2]).join(&hash.0)
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        // The guarded state is the filesystem, which a panic cannot leave half-updated.
        self.gc_lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stores `bytes` and returns their hash. Storing content that already exists only
    /// restarts its GC grace period.
    pub fn put_blocking(&self, bytes: &[u8]) -> Result<BlobHash> {
        let hash = BlobHash(blake3::hash(bytes).to_hex().to_string());
        let path = self.path(&hash);
        if self.refresh(&path)? {
            return Ok(hash);
        }
        let tmp = self.root.join("tmp").join(uuid::Uuid::now_v7().to_string());
        let result = (|| -> io::Result<()> {
            let mut file = File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::create_dir_all(path.parent().unwrap_or(Path::new(&self.root)))?;
            let _guard = self.lock();
            fs::rename(&tmp, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result?;
        Ok(hash)
    }

    pub fn get_blocking(&self, hash: &BlobHash) -> Result<Option<Vec<u8>>> {
        match fs::read(self.path(hash)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Restarts a blob's GC grace period. Returns whether the blob exists; a `false` means it
    /// was never stored or has been collected, and must be put again.
    pub fn touch_blocking(&self, hash: &BlobHash) -> Result<bool> {
        self.refresh(&self.path(hash))
    }

    /// Sets the file's modification time to now if it exists, under the GC lock.
    fn refresh(&self, path: &Path) -> Result<bool> {
        let _guard = self.lock();
        match File::options().write(true).open(path) {
            Ok(file) => {
                file.set_modified(SystemTime::now())?;
                Ok(true)
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(err.into()),
        }
    }

    /// Every blob file, with its modification time. Files that are not blobs are ignored.
    pub(crate) fn list_blocking(&self) -> Result<Vec<BlobEntry>> {
        let mut blobs = Vec::new();
        for shard in fs::read_dir(&self.root)? {
            let shard = shard?;
            let shard_name = shard.file_name();
            let Some(shard_name) = shard_name.to_str() else {
                continue;
            };
            if shard_name.len() != 2 || !shard.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(shard.path())? {
                let entry = entry?;
                let Some(Ok(hash)) = entry.file_name().to_str().map(str::parse::<BlobHash>) else {
                    continue;
                };
                if !hash.0.starts_with(shard_name) {
                    continue;
                }
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    // Collected or replaced since the directory was read.
                    Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                    Err(err) => return Err(err.into()),
                };
                if metadata.is_file() {
                    blobs.push(BlobEntry {
                        hash,
                        modified: metadata.modified()?,
                    });
                }
            }
        }
        Ok(blobs)
    }

    /// Deletes a blob unless it was put or touched after `cutoff`. The caller has already
    /// established that no event references it.
    pub(crate) fn remove_if_stale_blocking(
        &self,
        hash: &BlobHash,
        cutoff: SystemTime,
    ) -> io::Result<Removal> {
        let path = self.path(hash);
        let _guard = self.lock();
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Removal::Missing),
            Err(err) => return Err(err),
        };
        if metadata.modified()? > cutoff {
            return Ok(Removal::Recent);
        }
        match fs::remove_file(&path) {
            Ok(()) => Ok(Removal::Removed {
                bytes: metadata.len(),
            }),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Removal::Missing),
            Err(err) => Err(err),
        }
    }

    pub async fn put(&self, bytes: Vec<u8>) -> Result<BlobHash> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.put_blocking(&bytes))
            .await
            .map_err(|err| Error::Io(io::Error::other(err)))?
    }

    pub async fn get(&self, hash: BlobHash) -> Result<Option<Vec<u8>>> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.get_blocking(&hash))
            .await
            .map_err(|err| Error::Io(io::Error::other(err)))?
    }

    /// Async [`BlobStore::touch_blocking`].
    pub async fn touch(&self, hash: BlobHash) -> Result<bool> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.touch_blocking(&hash))
            .await
            .map_err(|err| Error::Io(io::Error::other(err)))?
    }
}
