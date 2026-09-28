//! What the core records about the Project Brain and the context engine: Brain jobs (the
//! skeleton pass, idle-quota enrichment), Chat memories, orchestrator rebirths, and the
//! overview the Inspector reads.

use brigadier_brain::{BrainStats, EmbedderStatus};
use brigadier_index::IndexStatus;
use brigadier_providers::ProviderKind;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::ProjectId;

/// A background job that deepens a project's Brain with a cheap model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BrainJobKind {
    /// On project add: each module's purpose, the stack, conventions, the run/build/verify
    /// recipe.
    Skeleton,
    /// Spare quota before a usage window resets: stale nodes first, then gaps.
    Enrichment,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrainJobState {
    Running,
    Done,
    /// It yielded: the user started work on its provider, the window reset or ran hot, or the
    /// user stopped it.
    Stopped {
        reason: String,
    },
    Failed {
        error: String,
    },
}

/// A Brain job (full snapshot on each change).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainJob {
    pub id: String,
    pub project_id: ProjectId,
    pub kind: BrainJobKind,
    pub state: BrainJobState,
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    /// Nodes it recorded so far.
    pub nodes: u32,
    /// What it worked on, in a few words.
    pub note: String,
}

/// What a Chat's model saved to, or removed from, the Personal Brain in a turn (a Memory chip).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryChange {
    /// The Personal Brain node.
    pub node_id: String,
    pub text: String,
    /// The user removed it again.
    pub forgotten: bool,
    /// The request whose turn saved it.
    pub request_id: Option<String>,
    pub at_ms: i64,
}

/// Why an orchestrator was reborn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RebirthTrigger {
    /// Its context passed the rebirth threshold.
    Threshold,
    /// Its CLI session could not be resumed (lost files, a failed resume).
    Recovery,
}

/// One part of a rebirth briefing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BriefingSection {
    /// `framing`, `handoff`, `decisions`, `state`, `brain`, `recent`, `search`.
    pub name: String,
    /// About four bytes per token.
    pub tokens: u64,
    /// Entries it holds (decisions, messages, nodes, tasks).
    pub items: u32,
    /// It was cut to fit the budget; `note` says how.
    pub truncated: bool,
    pub note: Option<String>,
}

/// An orchestrator rebirth, as the Inspector's rebirth log shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RebirthRecord {
    pub id: String,
    /// 1 for the first rebirth of the conversation.
    pub generation: u32,
    pub trigger: RebirthTrigger,
    pub provider: ProviderKind,
    pub model: Option<String>,
    /// The outgoing CLI's context when the handoff started.
    pub at_tokens: i64,
    pub window_tokens: Option<i64>,
    pub prepare_started_at_ms: i64,
    pub swapped_at_ms: i64,
    /// The outgoing orchestrator's handoff note (blob hash); `None` if it could not write one.
    pub handoff_blob: Option<String>,
    /// The whole briefing (blob hash).
    pub briefing_blob: String,
    pub briefing_tokens: u64,
    pub sections: Vec<BriefingSection>,
    /// Settled decisions of this conversation, all listed in the briefing.
    pub decisions: u32,
    /// Of those, the ones carried with their full text.
    pub decisions_in_full: u32,
    /// Messages carried verbatim.
    pub recent_messages: u32,
    pub old_native_id: Option<String>,
    /// The new CLI session's id, once it started.
    pub new_native_id: Option<String>,
}

/// When an orchestrator's rebirth is prepared and when it must happen, in context tokens, for
/// the model it runs on now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RebirthThresholds {
    /// The handoff note is prepared once the context passes this.
    pub prepare_tokens: i64,
    /// The orchestrator is reborn before its next turn once the context passes this.
    pub swap_tokens: i64,
    pub window_tokens: Option<i64>,
}

/// A project's Brain at a glance (or the Personal Brain's), for the Inspector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BrainOverview {
    /// `None` for the Personal Brain.
    pub project_id: Option<ProjectId>,
    pub stats: BrainStats,
    /// The project's code index (none for the Personal Brain or a project without a repo).
    pub index: Option<IndexStatus>,
    pub embedder: EmbedderStatus,
    /// Its Brain jobs, newest first.
    pub jobs: Vec<BrainJob>,
}

/// What an AGENTS.md export wrote.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConventionsExport {
    pub path: String,
    /// Conventions written.
    pub conventions: u32,
    /// The file did not exist before.
    pub created: bool,
}
