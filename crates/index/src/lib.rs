//! Static code index: the file tree, tree-sitter symbols and cross-references, package
//! manifests, scripts and the service map of one repository (PLAN.md §6 Phase 4). No model is
//! involved.
//!
//! One [`CodeIndex`] per project repository, stored in its own SQLite file under Brigadier's
//! data directory (never in the repository). It is a derived cache: a schema change rebuilds it
//! from the files.
//!
//! Threads: every method here blocks (SQLite, the file system, parsing). The index runs its own
//! writer thread, a bounded parse pool during [`CodeIndex::scan`] and the watcher's threads;
//! callers on an async runtime use a dedicated thread for `scan` and `spawn_blocking` for the
//! reads, which answer in milliseconds.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("code index database: {0}")]
    Db(String),
    #[error("reading {path}: {message}")]
    Io { path: String, message: String },
    #[error("file watcher: {0}")]
    Watch(String),
    #[error("{0}")]
    Invalid(String),
    /// The index was closed.
    #[error("the code index is closed")]
    Closed,
}

/// Where an index lives and what it covers.
#[derive(Debug, Clone)]
pub struct IndexConfig {
    /// The index's SQLite file, e.g. `<data>/brains/<project>/index.sqlite`.
    pub db_path: PathBuf,
    /// The repository's top-level directory.
    pub root: PathBuf,
    /// Parse threads for a scan; 0 means one less than the machine's cores (at least 1).
    pub threads: usize,
}

/// A file whose content changed since the index last saw it, as the watcher and scans report
/// it to the Brain (which marks the nodes that depend on it stale).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Repository-relative path, `/`-separated.
    pub path: String,
    /// The new content's BLAKE3 hash (hex); `None` when the file was deleted.
    pub hash: Option<String>,
}

/// Called with each batch of changed files, from the index's own threads.
pub type ChangeSink = Arc<dyn Fn(Vec<FileChange>) + Send + Sync>;

/// What the index is doing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IndexState {
    /// Opened, never scanned.
    New,
    Scanning {
        done: u64,
        /// Files found so far (the walk and the parse overlap, so it can grow).
        total: u64,
    },
    Ready,
    Failed {
        error: String,
    },
}

/// Files of one language.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LanguageCount {
    /// `rust`, `typescript`, `tsx`, `javascript`, `python`, `go`, `java`, `c`, `cpp`,
    /// `csharp`, `ruby`, `php`, `swift`, `kotlin`, or `other`.
    pub language: String,
    pub files: u64,
}

/// The index at a glance (Inspector, budgets).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub root: String,
    pub state: IndexState,
    pub files: u64,
    /// Definitions.
    pub symbols: u64,
    pub references: u64,
    pub languages: Vec<LanguageCount>,
    /// The watcher is running.
    pub watching: bool,
    pub last_scan_at_ms: Option<i64>,
    /// How long the last full scan took (walk, hash, parse, store).
    pub last_scan_ms: Option<u64>,
    /// Files that scan re-parsed (the rest were unchanged).
    pub last_scan_parsed: Option<u64>,
    /// Last time the watcher applied a change.
    pub updated_at_ms: Option<i64>,
}

/// What a scan did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub files: u64,
    /// Re-parsed because new or changed.
    pub parsed: u64,
    pub removed: u64,
    /// Skipped: too large, binary, minified or generated.
    pub skipped: u64,
    pub symbols: u64,
    pub references: u64,
    pub duration_ms: u64,
    /// The files whose content changed (for the Brain's staleness).
    #[ts(skip)]
    #[serde(skip)]
    pub changed: Vec<FileChange>,
}

/// What a search looks for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SearchKind {
    /// Symbol definitions by name.
    Symbol,
    /// Files by path.
    File,
    /// Both.
    #[default]
    Any,
}

/// A `code_search` query.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CodeQuery {
    /// Name or path fragment; matched as a substring, best matches first (exact, prefix,
    /// substring, then fuzzy).
    pub query: String,
    #[serde(default)]
    pub kind: SearchKind,
    /// Only this language (see [`LanguageCount::language`]).
    #[serde(default)]
    pub language: Option<String>,
    /// Only under this repository-relative folder.
    #[serde(default)]
    pub path: Option<String>,
    /// At most this many hits (default 30, at most 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// A symbol definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub name: String,
    /// The tags query's kind: `function`, `method`, `class`, `interface`, `module`, `macro`,
    /// `constant`, `type`, …
    pub kind: String,
    pub path: String,
    /// 1-based.
    pub line: u32,
    pub end_line: u32,
    /// The definition's first line, trimmed (at most 200 characters).
    pub signature: String,
    /// Its doc comment, when the grammar's tags query captures one (at most 300 characters).
    pub doc: Option<String>,
}

/// One `code_search` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CodeHit {
    Symbol {
        symbol: SymbolHit,
    },
    File {
        path: String,
        language: String,
        bytes: u64,
    },
}

/// A place a symbol is referenced (a call, a type use).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceHit {
    pub path: String,
    pub line: u32,
    /// `call`, `type`, `implementation`, …, from the tags query.
    pub kind: String,
    /// The referencing line, trimmed (at most 200 characters).
    pub context: String,
}

/// `code_refs`: where a name is defined and referenced. References are matched to definitions
/// by name only (tags carry no type information), so an overloaded name lists them all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SymbolRefs {
    pub name: String,
    pub definitions: Vec<SymbolHit>,
    pub references: Vec<ReferenceHit>,
    /// More references exist than were returned.
    pub truncated: bool,
}

/// A package manifest the index understood.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub path: String,
    /// `cargo`, `npm`, `pnpmWorkspace`, `python`, `go`, `ruby`, `composer`, `maven`,
    /// `gradle`.
    pub kind: String,
    /// The package or module name, when it has one.
    pub name: Option<String>,
    pub version: Option<String>,
    /// Workspace members / packages it declares.
    pub members: Vec<String>,
    /// Direct dependency names with their version requirements.
    pub dependencies: Vec<Dependency>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    pub requirement: Option<String>,
    /// A development-only dependency.
    pub dev: bool,
}

/// A runnable command the repository defines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub name: String,
    pub command: String,
    /// Where it is defined: `package.json`, `Makefile`, `justfile`, a workflow file, …
    pub source: String,
}

/// A service of the service map (compose files, Dockerfiles, Procfiles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub name: String,
    /// The file that defines it.
    pub source: String,
    /// Its build context or working folder, repository-relative, when known.
    pub path: Option<String>,
    pub image: Option<String>,
    /// Published ports as written (`"8080:80"`).
    pub ports: Vec<String>,
    pub depends_on: Vec<String>,
}

/// A module: a workspace member or package folder, with what it depends on inside the repo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub name: String,
    pub path: String,
    /// The manifest that makes it a module.
    pub manifest: String,
    /// Other modules of this repository it depends on, by name.
    pub depends_on: Vec<String>,
    pub files: u64,
    pub languages: Vec<LanguageCount>,
}

/// `project_map`: the repository's structure.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMap {
    pub modules: Vec<Module>,
    pub manifests: Vec<Manifest>,
    pub scripts: Vec<Script>,
    pub services: Vec<Service>,
    /// Top-level folders with their file counts.
    pub folders: Vec<FolderCount>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FolderCount {
    pub path: String,
    pub files: u64,
}

/// A running watcher; dropping it stops watching.
pub struct Watcher {
    _private: (),
}

/// The code index of one repository. Cheap to clone (a handle).
#[derive(Clone)]
pub struct CodeIndex {
    _private: Arc<()>,
}

impl CodeIndex {
    /// Opens (creating or rebuilding) the index database and starts its writer thread. Does not
    /// scan.
    pub fn open(config: IndexConfig) -> Result<Self> {
        let _ = config;
        Err(Error::Invalid("the code index is not built yet".into()))
    }

    /// Brings the index up to date with the files: walks the repository (honouring its
    /// ignore files), re-parses what is new or changed (mtime and size first, then the content
    /// hash) and drops what is gone. Blocks until done; progress shows in [`Self::status`].
    pub fn scan(&self) -> Result<ScanStats> {
        Err(Error::Closed)
    }

    /// Watches the repository and keeps the index current. `sink` gets each batch of changed
    /// files after they were re-indexed. Events the platform dropped trigger a rescan.
    pub fn watch(&self, sink: ChangeSink) -> Result<Watcher> {
        let _ = sink;
        Err(Error::Closed)
    }

    /// The index at a glance; cheap (no I/O).
    pub fn status(&self) -> IndexStatus {
        IndexStatus {
            root: String::new(),
            state: IndexState::New,
            files: 0,
            symbols: 0,
            references: 0,
            languages: Vec::new(),
            watching: false,
            last_scan_at_ms: None,
            last_scan_ms: None,
            last_scan_parsed: None,
            updated_at_ms: None,
        }
    }

    /// Symbols and files matching `query`.
    pub fn search(&self, query: &CodeQuery) -> Result<Vec<CodeHit>> {
        let _ = query;
        Err(Error::Closed)
    }

    /// Where `name` is defined and referenced (at most `limit` references).
    pub fn refs(&self, name: &str, limit: u32) -> Result<SymbolRefs> {
        let _ = (name, limit);
        Err(Error::Closed)
    }

    /// Modules, manifests, scripts, services and top-level folders.
    pub fn project_map(&self) -> Result<ProjectMap> {
        Err(Error::Closed)
    }

    /// The indexed content hash of each path (`None`: not indexed), for node provenance.
    pub fn file_hashes(&self, paths: &[String]) -> Result<Vec<(String, Option<String>)>> {
        let _ = paths;
        Err(Error::Closed)
    }

    /// A compact text overview for a model (folders, modules, manifests, scripts, services and
    /// the most referenced symbols per module), at most `max_bytes`.
    pub fn digest(&self, max_bytes: usize) -> Result<String> {
        let _ = max_bytes;
        Err(Error::Closed)
    }
}
