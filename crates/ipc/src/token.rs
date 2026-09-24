//! The per-launch secret. The daemon writes it to a file only the current user can read; any
//! client must present it in its first frame.

use std::io::{self, Read, Write};
use std::path::Path;

use brigadier_sandbox::Platform;

use crate::Error;

const TOKEN_BYTES: usize = 32;

/// A 256-bit secret, hex encoded.
#[derive(Clone)]
pub struct Token(String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

impl Token {
    pub fn generate() -> Result<Self, Error> {
        let mut bytes = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|err| Error::Io(io::Error::other(err.to_string())))?;
        Ok(Self(
            bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        ))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Constant-time comparison, so response timing reveals nothing about the secret.
    pub fn matches(&self, candidate: &str) -> bool {
        let (a, b) = (self.0.as_bytes(), candidate.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    /// Writes the token to a new private file, replacing a stale one from an earlier launch.
    /// The caller must hold the instance lock, which guarantees any existing file is stale.
    pub fn publish(&self, platform: &dyn Platform, path: &Path) -> Result<(), Error> {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        let mut file = platform.private_fs().create_private_file(path)?;
        file.write_all(self.0.as_bytes())?;
        file.sync_all()?;
        Ok(())
    }

    /// Reads a published token.
    pub fn read(path: &Path) -> Result<Self, Error> {
        let mut token = String::new();
        std::fs::File::open(path)?
            .take((TOKEN_BYTES * 2 + 1) as u64)
            .read_to_string(&mut token)?;
        let token = token.trim();
        if token.len() != TOKEN_BYTES * 2 {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "malformed IPC token file",
            )));
        }
        Ok(Self(token.to_owned()))
    }
}
