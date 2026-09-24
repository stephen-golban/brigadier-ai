use std::fmt;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

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
#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("tmp"))?;
        // Leftovers from a crash mid-write are never referenced; remove them.
        for entry in fs::read_dir(root.join("tmp"))? {
            let _ = fs::remove_file(entry?.path());
        }
        Ok(Self { root })
    }

    fn path(&self, hash: &BlobHash) -> PathBuf {
        self.root.join(&hash.0[..2]).join(&hash.0)
    }

    pub fn put_blocking(&self, bytes: &[u8]) -> Result<BlobHash> {
        let hash = BlobHash(blake3::hash(bytes).to_hex().to_string());
        let path = self.path(&hash);
        if path.exists() {
            return Ok(hash);
        }
        let tmp = self.root.join("tmp").join(uuid::Uuid::now_v7().to_string());
        let result = (|| -> io::Result<()> {
            let mut file = File::create(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::create_dir_all(path.parent().unwrap_or(Path::new(&self.root)))?;
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
}
