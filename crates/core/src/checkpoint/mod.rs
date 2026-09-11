//! App-owned raw Git checkpoints. See docs/research/git-message-checkpoints-2026-09-05.md.
//! No provider or database dependencies; source Git state is read-only.

mod git;
mod plan;
#[cfg(unix)]
mod restore;
mod scan;
pub use git::SnapshotStore;
pub use plan::{plan_apply, plan_restore};
pub use scan::{Coverage, Limits};

use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

/// Failure always means unavailable/incomplete, never an empty snapshot.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Filesystem operation failed.
    #[error("checkpoint I/O: {0}")]
    Io(#[from] std::io::Error),
    /// Git or an invariant rejected the operation.
    #[error("{0}")]
    Unavailable(String),
    /// Invalid persisted metadata.
    #[error("checkpoint metadata: {0}")]
    Json(#[from] serde_json::Error),
    /// An overlapping lease already owns the workspace, with whatever could be proven about it.
    /// Additive: [`Error::Unavailable`] keeps its shape, so callers that only print compile and
    /// read unchanged. see docs/research/workspace-lock-holder-identity-2026-09-11.md
    #[error("{0}")]
    Busy(Box<LockConflict>),
}
/// Checkpoint operation result.
pub type Result<T> = std::result::Result<T, Error>;

/// Raw working-file identity. Missing entries mean absent, not empty.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PathState {
    /// Raw blob object ID in the independent store.
    pub oid: String,
    /// Git mode: regular, executable, or symbolic link.
    pub mode: String,
    /// Raw byte length (link target length for symlinks).
    pub bytes: u64,
    /// Regular-file metadata preserved across replacement; ACL files are unsupported.
    #[serde(default)]
    pub metadata: Option<FileMetadata>,
}
/// Bounded metadata on regular files, captured through an open descriptor.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMetadata {
    /// Full permission mode, excluding file-type bits.
    pub permissions: u32,
    /// File owner.
    pub uid: u32,
    /// File group.
    pub gid: u32,
    /// Restorable extended attributes; macOS owns provenance independently of file contents.
    #[serde(deserialize_with = "deserialize_attributes")]
    pub attributes: BTreeMap<String, Vec<u8>>,
}

pub(crate) fn restorable_attribute(name: &str) -> bool {
    // macOS can accept fsetxattr yet rewrite this value. Copying it causes the metadata
    // round-trip check to fail; leave its creation and maintenance to the OS. Quarantine
    // and every other attribute remain covered and must still round-trip exactly.
    name != "com.apple.provenance"
}

fn deserialize_attributes<'de, D>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Old snapshots and recovery plans also contain provenance. Normalize on read so
    // their equality/conflict checks use the same metadata scope as fresh captures.
    let mut attributes = BTreeMap::<String, Vec<u8>>::deserialize(deserializer)?;
    attributes.retain(|name, _| restorable_attribute(name));
    Ok(attributes)
}
/// Covered paths, validated workspace-relative UTF-8 names.
pub type Manifest = BTreeMap<String, PathState>;

/// Source repository guard, deliberately distinct from working files.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitState {
    /// Relevant HEAD and symbolic branch, or unborn/non-repository markers.
    pub head: String,
    /// Semantic index entries including flags, stages and modes.
    pub index: Vec<u8>,
    /// Frozen ignore-source fingerprint and repository identity.
    pub policy: Vec<u8>,
}
/// A durably retained raw tree and its coverage/identity guards.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    /// Generated ID, also the retention ref suffix.
    pub id: String,
    /// Canonical root.
    pub root: PathBuf,
    /// Device/inode identity, not just the root string.
    pub identity: String,
    /// Raw tree object ID.
    pub tree: String,
    /// Included file states.
    pub files: Manifest,
    /// Source Git state, when present.
    pub git: GitState,
    /// Scope version; incompatible scopes cannot compose.
    pub coverage: Coverage,
}
/// Before/after snapshots for one settled human writing epoch.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Epoch {
    /// Reserved local turn ID, also sent as the native human UUID.
    pub turn_id: String,
    /// State durably recorded before dispatch.
    pub pre: Snapshot,
    /// State after verified settling; absent means incomplete.
    pub post: Option<Snapshot>,
    /// A failed/ambiguous lifecycle must never become a clean epoch.
    pub error: Option<String>,
}
/// One exact restore operation. No fuzzy patch or inferred rename.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Change {
    /// Validated relative path.
    pub path: String,
    /// Expected current state; checked immediately before writing.
    pub before: Option<PathState>,
    /// Desired state; None deletes only this entry.
    pub after: Option<PathState>,
}
/// Immutable preview; conflicts prevent any application.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RestorePlan {
    /// Current snapshot doubles as retained recovery state.
    pub current: Snapshot,
    /// Final composed state, after cancelling continuous net-zero segments.
    pub target: Manifest,
    /// Only operations that actually change current files.
    pub changes: Vec<Change>,
    /// Divergent paths or topology collisions; never silently skipped.
    pub conflicts: Vec<String>,
}

pub(crate) fn unavailable(message: impl Into<String>) -> Error {
    Error::Unavailable(message.into())
}

pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && std::path::Path::new(path)
            .components()
            .all(|p| matches!(p, std::path::Component::Normal(_)))
        && !path.split('/').any(|p| p.eq_ignore_ascii_case(".git"))
        && !path.contains('\0')
}

mod lease;
mod owner;
pub use lease::WorkspaceLease;
pub use owner::{LeaseKind, LockConflict, LockOwner};

#[cfg(not(unix))]
mod unsupported_restore {
    use super::*;
    impl SnapshotStore {
        /// Restoration has no verified implementation on this platform.
        pub fn validate_restore(&self, _: &RestorePlan) -> Result<()> {
            Err(unavailable(
                "Workspace restore is unsupported on this platform",
            ))
        }
        /// Restoration has no verified implementation on this platform.
        pub fn validate_support(&self, _: &RestorePlan) -> Result<()> {
            Err(unavailable(
                "Workspace restore is unsupported on this platform",
            ))
        }
        /// Restoration has no verified implementation on this platform.
        pub fn apply_change(&self, _: &std::path::Path, _: &str, _: &Change) -> Result<()> {
            Err(unavailable(
                "Workspace restore is unsupported on this platform",
            ))
        }
    }
}
