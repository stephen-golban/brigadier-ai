//! Project Brain: the knowledge graph, its retrieval (SQLite FTS5 plus local embeddings),
//! staleness by file content hashes, the Personal Brain, and the full-transcript index rebirth
//! searches (PLAN.md §6 Phase 4).
//!
//! One [`Brain`] per project (`<data>/brains/<project>/brain.sqlite`) and one Personal Brain
//! (`<data>/brains/personal.sqlite`), never in a repository. Every node records its
//! [`Provenance`].
//!
//! Retrieval merges FTS5 (bm25) with embedding similarity by reciprocal-rank fusion, then adds
//! the decisions and conventions linked to what matched. Embeddings come from a local static
//! model ([`Embedder`]); until it is downloaded and loaded, retrieval is FTS5 plus the graph.
//! There is no cloud embedder: Brigadier holds no API keys (a plan note in the README).
//!
//! Threads: every method blocks (SQLite, vector scoring, model loading, downloads). A Brain
//! runs one writer thread and keeps a few read connections; callers on an async runtime use
//! `spawn_blocking` (reads, writes) or a dedicated thread (downloads, backfills). A query never
//! waits for the embedding model to load.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("brain database: {0}")]
    Db(String),
    #[error("embedding model: {0}")]
    Model(String),
    #[error("downloading the embedding model: {0}")]
    Download(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    /// The Brain was closed.
    #[error("the brain is closed")]
    Closed,
}

/// Whose knowledge a Brain holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Project,
    /// The user's global preferences (the Personal Brain).
    Personal,
}

/// The node types of PLAN.md §6 Phase 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Module,
    Service,
    FileSummary,
    Decision,
    Convention,
    Preference,
    Task,
    Report,
    /// Dated research (freshness): expires after its TTL.
    Research,
    Contract,
}

/// Whether a node can be trusted as it stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NodeState {
    Fresh,
    /// A file it describes changed (or its TTL passed) since it was recorded.
    Stale {
        reason: String,
        since_ms: i64,
    },
    /// A newer node replaces it.
    Superseded {
        by: String,
    },
}

/// Where a node's knowledge came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// The static code index (no model).
    Index,
    /// The skeleton pass on project add.
    Skeleton,
    /// Idle-quota enrichment.
    Enrichment,
    /// A worker's report.
    Report,
    /// The orchestrator (`remember`).
    Orchestrator,
    /// The user: a card they answered, or a Chat memory.
    User,
}

/// The CLI model that produced a node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRef {
    /// `claude` or `codex`.
    pub provider: String,
    pub model: Option<String>,
}

/// Which worker, which session, which commit (PLAN.md: every node records its provenance).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub origin: Origin,
    /// The conversation (session or Chat) it was learned in.
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    /// The Brain job (skeleton pass, enrichment) that wrote it.
    pub job_id: Option<String>,
    pub worker: Option<WorkerRef>,
    /// The repository commit the knowledge was read at, or landed as.
    pub commit: Option<String>,
    pub recorded_at_ms: i64,
}

/// A file a node describes, with its content hash when the node was recorded. A different
/// hash later makes the node stale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    /// Repository-relative, `/`-separated.
    pub path: String,
    /// BLAKE3 hex of the content; `None` if unknown (never marked stale by content).
    pub hash: Option<String>,
}

/// A stored node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    /// A stable identity for nodes that are updated in place (`module:crates/core`,
    /// `file:src/main.rs`, `skeleton:stack`); `None` for one-off nodes.
    pub key: Option<String>,
    pub title: String,
    pub body: String,
    pub state: NodeState,
    pub provenance: Provenance,
    pub files: Vec<FileRef>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// Research nodes: when it goes stale by age.
    pub expires_at_ms: Option<i64>,
    /// It has an embedding (from the current model).
    pub embedded: bool,
}

/// A node to record. With a `key`, an existing node of that key and kind is updated in place
/// (and becomes fresh again); without one, a new node is created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NewNode {
    pub kind: NodeKind,
    pub key: Option<String>,
    pub title: String,
    pub body: String,
    pub provenance: Provenance,
    #[serde(default)]
    pub files: Vec<FileRef>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// A module contains a file summary, a service contains a module.
    Contains,
    DependsOn,
    /// A decision, report or convention is about this module or file summary.
    About,
    /// A decision was made in this task or report.
    DecidedIn,
    Supersedes,
    Implements,
    /// A service consumes this contract.
    Consumes,
    Relates,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

/// An edge to record, by node id or by node key (`key:module:crates/core`).
pub type NewEdge = Edge;

/// A retrieval request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainQuery {
    pub text: String,
    /// Only these kinds (all when empty).
    #[serde(default)]
    pub kinds: Vec<NodeKind>,
    /// At most this many nodes (default 12).
    #[serde(default)]
    pub limit: Option<u32>,
    /// The answer text's budget in tokens, about 4 bytes each (default 1500).
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// One retrieved node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainHit {
    pub node: Node,
    /// Fused score, higher is better.
    pub score: f64,
    /// Found through a link from another hit, not by the query itself.
    pub linked: bool,
}

/// What a query found, with the text the orchestrator reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainAnswer {
    pub hits: Vec<BrainHit>,
    /// The hits formatted for a model within the token budget: each with its kind, title,
    /// state (stale ones say so), body and a provenance line.
    pub text: String,
    /// Embeddings took part (the model was loaded).
    pub semantic: bool,
    /// Microseconds the query took inside the Brain.
    pub took_us: u64,
}

/// Which nodes to list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeFilter {
    #[serde(default)]
    pub kinds: Vec<NodeKind>,
    /// Only nodes learned in this conversation.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Leave out superseded nodes.
    #[serde(default)]
    pub current_only: bool,
    /// Title/body substring.
    #[serde(default)]
    pub text: Option<String>,
    /// Newest first; at most this many (default 200).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Nodes and the edges among them, for the Inspector's graph viewer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainGraph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// More nodes match than were returned.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub kind: NodeKind,
    pub nodes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainStats {
    pub nodes: u64,
    pub edges: u64,
    pub stale: u64,
    /// Nodes without an embedding from the current model.
    pub unembedded: u64,
    pub kinds: Vec<KindCount>,
    /// Transcript entries indexed.
    pub transcript_entries: u64,
    pub bytes_on_disk: u64,
}

/// A line of a conversation's transcript, for full-transcript search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    pub conversation_id: String,
    /// The event store sequence it came from (entries are idempotent by conversation and seq).
    pub seq: i64,
    /// `user`, `assistant`, `report`, `decision`, `brigadier`.
    pub role: String,
    pub request_id: Option<String>,
    pub at_ms: i64,
    pub text: String,
}

/// A transcript search result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub seq: i64,
    pub role: String,
    pub request_id: Option<String>,
    pub at_ms: i64,
    /// The matching passage, with some context (at most about 600 bytes).
    pub snippet: String,
}

/// The local embedding model's state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EmbedderState {
    NotInstalled,
    Downloading {
        received: u64,
        total: u64,
    },
    /// Downloaded and checked, not in memory.
    Installed,
    Loading,
    Loaded,
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EmbedderStatus {
    /// `minishlab/potion-retrieval-32M@<revision>`.
    pub model: String,
    pub model_bytes: u64,
    pub dimensions: u32,
    pub state: EmbedderState,
}

/// The local embedding model (Model2Vec static embeddings), shared by every Brain. Loaded on
/// demand, quantized in memory, and unloaded when idle.
pub struct Embedder {
    _private: (),
}

impl Embedder {
    /// An embedder whose model files live in `models_dir` (e.g. `<data>/models/embeddings`).
    /// Does no I/O.
    pub fn new(models_dir: PathBuf) -> Arc<Self> {
        let _ = models_dir;
        Arc::new(Self { _private: () })
    }

    pub fn status(&self) -> EmbedderStatus {
        EmbedderStatus {
            model: String::new(),
            model_bytes: 0,
            dimensions: 0,
            state: EmbedderState::NotInstalled,
        }
    }

    /// Downloads the pinned model and checks its SHA-256 (resuming a partial download).
    /// Blocks; `cancel` stops it and keeps the partial file.
    pub fn download(&self, cancel: &AtomicBool) -> Result<()> {
        let _ = cancel;
        Err(Error::Model("the embedder is not built yet".into()))
    }

    /// Loads the model if it is installed and not loaded yet, on the embedder's own thread;
    /// returns at once.
    pub fn request_load(&self) {}

    /// Embeds `texts` if the model is loaded (normalized vectors); `None` otherwise.
    pub fn embed(&self, texts: &[&str]) -> Option<Vec<Vec<f32>>> {
        let _ = texts;
        None
    }

    /// Frees the model if it has not been used for `idle`.
    pub fn unload_if_idle(&self, idle: std::time::Duration) {
        let _ = idle;
    }
}

/// A Brain: the project's (or the user's) knowledge graph. Cheap to clone (a handle).
#[derive(Clone)]
pub struct Brain {
    _private: Arc<()>,
}

impl Brain {
    /// Opens (creating and migrating) the Brain database at `path` and starts its writer
    /// thread.
    pub fn open(path: &Path, scope: Scope, embedder: Arc<Embedder>) -> Result<Self> {
        let _ = (path, scope, embedder);
        Err(Error::Invalid("the brain is not built yet".into()))
    }

    /// Records a node (see [`NewNode`] for updates by key) and returns its id. It is embedded
    /// now if the model is loaded, later by [`Self::embed_pending`] otherwise.
    pub fn record(&self, node: NewNode) -> Result<String> {
        let _ = node;
        Err(Error::Closed)
    }

    /// Records edges; an endpoint may be a node id or `key:<node key>`. Unknown endpoints are
    /// an error; an edge that exists already is kept once.
    pub fn link(&self, edges: Vec<NewEdge>) -> Result<()> {
        let _ = edges;
        Err(Error::Closed)
    }

    /// Marks `old` superseded by `new` (and links them).
    pub fn supersede(&self, old: &str, new: &str) -> Result<()> {
        let _ = (old, new);
        Err(Error::Closed)
    }

    /// Deletes a node and its edges.
    pub fn delete(&self, id: &str) -> Result<()> {
        let _ = id;
        Err(Error::Closed)
    }

    /// Deletes every node learned in `session_id`, and its transcript ("forget what the Brain
    /// learned from this session" on delete). Returns how many nodes went.
    pub fn forget_session(&self, session_id: &str) -> Result<u64> {
        let _ = session_id;
        Err(Error::Closed)
    }

    /// Files changed (each with its new content hash, `None` when deleted): every fresh node
    /// recorded against another hash of one of them goes stale. Returns the ids of the nodes
    /// that went stale.
    pub fn files_changed(&self, changes: &[FileRef]) -> Result<Vec<String>> {
        let _ = changes;
        Err(Error::Closed)
    }

    /// Research nodes past their TTL go stale. Returns how many.
    pub fn expire(&self, now_ms: i64) -> Result<u64> {
        let _ = now_ms;
        Err(Error::Closed)
    }

    /// Embeds up to `limit` nodes that have no embedding from the current model (the model must
    /// be loaded). Returns how many were embedded.
    pub fn embed_pending(&self, limit: u32) -> Result<u32> {
        let _ = limit;
        Err(Error::Closed)
    }

    /// Hybrid retrieval: FTS5 and embeddings fused, plus linked decisions and conventions.
    /// Stale nodes are included and marked.
    pub fn query(&self, query: &BrainQuery) -> Result<BrainAnswer> {
        let _ = query;
        Err(Error::Closed)
    }

    pub fn node(&self, id: &str) -> Result<Option<Node>> {
        let _ = id;
        Err(Error::Closed)
    }

    /// The node with this key and kind.
    pub fn node_by_key(&self, kind: NodeKind, key: &str) -> Result<Option<Node>> {
        let _ = (kind, key);
        Err(Error::Closed)
    }

    pub fn nodes(&self, filter: &NodeFilter) -> Result<Vec<Node>> {
        let _ = filter;
        Err(Error::Closed)
    }

    /// Edges touching any of `ids`.
    pub fn edges(&self, ids: &[String]) -> Result<Vec<Edge>> {
        let _ = ids;
        Err(Error::Closed)
    }

    /// Nodes matching `filter` and the edges among them.
    pub fn graph(&self, filter: &NodeFilter) -> Result<BrainGraph> {
        let _ = filter;
        Err(Error::Closed)
    }

    pub fn stats(&self) -> Result<BrainStats> {
        Err(Error::Closed)
    }

    /// Adds transcript entries (idempotent by conversation and seq).
    pub fn index_transcript(&self, entries: Vec<TranscriptEntry>) -> Result<()> {
        let _ = entries;
        Err(Error::Closed)
    }

    /// The highest seq indexed for a conversation, to resume a backfill.
    pub fn transcript_watermark(&self, conversation_id: &str) -> Result<Option<i64>> {
        let _ = conversation_id;
        Err(Error::Closed)
    }

    /// Full-text search over one conversation's transcript, best matches first.
    pub fn search_transcript(
        &self,
        conversation_id: &str,
        query: &str,
        limit: u32,
    ) -> Result<Vec<TranscriptHit>> {
        let _ = (conversation_id, query, limit);
        Err(Error::Closed)
    }

    /// Drops a conversation's transcript entries.
    pub fn forget_transcript(&self, conversation_id: &str) -> Result<()> {
        let _ = conversation_id;
        Err(Error::Closed)
    }
}
