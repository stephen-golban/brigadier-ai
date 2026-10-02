//! Overnight runs (PLAN.md §10): a plan the user hands over with an optional deadline, worked
//! through phase by phase while they are away. These records are the run's durable truth and
//! the wire contract the plan card shows; the conductor (`manager::overnight`) changes them.
//!
//! A run is stored as full snapshots (`DomainEvent::OvernightUpdated`) on its conversation's
//! stream, like plans and tasks. Its phases, criteria and the user's words are fixed once
//! proposed; only the user's later words change its restrictions, each change a new revision.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{CardId, ConversationId, OvernightRunId};

/// Where a run is. `Proposed` waits for the user's Start; everything after it is the run's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum OvernightState {
    /// Shown on the card with one Start. Nothing runs yet.
    Proposed,
    /// A newer proposal replaced it before it started.
    Superseded,
    /// Started: its branch and worktree are being made, earlier work is settling.
    Preparing,
    /// Phase 0: writing and reviewing the plan for a bare goal.
    Planning,
    Running,
    /// A phase's work settled and its whole result is being checked.
    PhaseGate,
    /// No eligible model until a usage window resets.
    WaitingQuota,
    /// Stop, the deadline or a block: no new work, live work hands off.
    WindingDown,
    Reporting,
    Finished,
}

impl OvernightState {
    /// Started and not yet finished: the run owns its session and keeps the daemon up.
    pub fn is_active(self) -> bool {
        !matches!(self, Self::Proposed | Self::Superseded | Self::Finished)
    }

    /// No further change of state can happen.
    pub fn is_final(self) -> bool {
        matches!(self, Self::Superseded | Self::Finished)
    }
}

/// How a phase ended up, or where it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PhaseState {
    Pending,
    Running,
    /// Its whole result is being verified, reviewed and judged.
    Checking,
    Verified,
    /// Some criteria met, the rest wait on the user or were not reached.
    Partial,
    Blocked,
    /// Not selected by the user's restrictions, or left out by a stop.
    Skipped,
}

/// One "done when" criterion. Its id never changes, so evidence and verdicts name it exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Criterion {
    /// `p<phase number>-c<n>`.
    pub id: String,
    pub text: String,
}

/// A phase of the plan, as the user's plan numbers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OvernightPhase {
    /// `phase-<number>`, the same in every segment of the run.
    pub id: String,
    /// The source plan's own number, which the user's restrictions refer to.
    pub number: u32,
    pub name: String,
    /// What the phase covers, exactly as the plan says.
    pub scope: String,
    pub done_when: Vec<Criterion>,
    /// Numbers of the phases it builds on.
    pub depends_on: Vec<u32>,
    pub state: PhaseState,
}

/// A file the plan was read from, as it was when proposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    /// As the user named it (relative to the repository, or absolute).
    pub path: String,
    /// The parts of it the plan uses ("phases 3–5"), as given.
    pub sections: Option<String>,
    /// Its contents in the blob store; absent when it couldn't be read (the run asks for it).
    pub blob: Option<String>,
    pub bytes: Option<u64>,
}

/// A wall-clock time the report is due, resolved once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTime {
    /// The instant, in ms since the Unix epoch. Later clock or time-zone changes don't move it.
    pub at_ms: i64,
    /// The local date it falls on, `2026-10-03`.
    pub local_date: String,
    /// The local time, `07:30`.
    pub local_time: String,
    /// The local date in words, `Sat 3 Oct`, so a misread day shows.
    pub day: String,
    /// The UTC offset at that time, `+03:00`.
    pub offset: String,
    /// The time zone it was resolved in (an IANA name where known).
    pub time_zone: String,
}

/// When the report should be ready.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Deadline {
    /// Until done: the run ends when its phases are done, it is blocked, or the user stops it.
    UntilDone,
    /// A time of day or a date and time.
    At { time: ResolvedTime },
    /// A duration from Start (`for 3 hours`); Start turns it into `At`.
    For { minutes: u32 },
}

/// "Stop after …".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StopAfter {
    /// After the phase with this number settles.
    Phase { number: u32 },
    /// After the phase that was running when the user said "this phase" (its id).
    Current { phase_id: String },
}

/// Which kind of restriction a piece of the user's words set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DirectiveKind {
    Deadline,
    StopAfter,
    Only,
    Skip,
    MaxWorkers,
    /// A quality setting Brigadier decides itself (effort, a model family, hand-off size).
    Ignored,
}

/// Where in the user's words a restriction came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectiveSpan {
    pub kind: DirectiveKind,
    /// The words, as typed.
    pub text: String,
    /// Byte offsets in the text they were read from.
    pub start: u32,
    pub end: u32,
}

/// The restrictions Brigadier enforces in code. Everything else the user wrote is Rules,
/// passed word for word to every phase lead, verifier and judge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Directives {
    pub deadline: Deadline,
    pub stop_after: Option<StopAfter>,
    /// Only phases `from..=to`.
    pub only: Option<PhaseRange>,
    pub skip: Vec<u32>,
    /// Brigadier workers of this run executing at once.
    pub max_workers: Option<u32>,
    /// One line per quality setting the user asked for and Brigadier won't apply.
    pub ignored: Vec<String>,
    pub spans: Vec<DirectiveSpan>,
}

impl Default for Directives {
    fn default() -> Self {
        Self {
            deadline: Deadline::UntilDone,
            stop_after: None,
            only: None,
            skip: Vec::new(),
            max_workers: None,
            ignored: Vec::new(),
            spans: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PhaseRange {
    pub from: u32,
    pub to: u32,
}

/// Something in the restrictions that stops Start until the user says it differently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectiveProblem {
    pub kind: DirectiveKind,
    /// What's wrong and how to say it instead, in plain words.
    pub message: String,
}

/// Why a run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StopReason {
    /// Every selected phase settled.
    Done,
    /// The user's Stop.
    Stopped,
    Deadline,
    /// A later phase needs what a blocked one couldn't finish.
    Blocked {
        phase_id: String,
    },
    /// "Stop after phase N" was reached.
    StopDirective,
    /// It couldn't be prepared (its branch or worktree couldn't be made).
    Failed {
        message: String,
    },
}

/// A user command the run applied, kept so a repeated one changes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppliedCommand {
    pub id: String,
    pub at_ms: i64,
}

/// One segment of an overnight run: Start to its report. Continue proposes the next segment
/// on the same branch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OvernightRun {
    pub id: OvernightRunId,
    pub conversation_id: ConversationId,
    /// 1 for the first segment, one more for each Continue.
    pub segment: u32,
    /// The segment this one continues.
    pub predecessor: Option<OvernightRunId>,
    /// The plan card it is shown with, when the plan came from one.
    pub plan_id: Option<CardId>,
    /// The plan's own name ("Windows support"), shown on the card.
    pub name: String,
    /// The user's words that asked for the run, verbatim.
    pub words: String,
    /// The goal: the plan's own statement of it, or the user's words.
    pub goal: String,
    /// Rules and settled decisions every lead, verifier and judge gets verbatim.
    pub rules: String,
    pub sources: Vec<SourceSnapshot>,
    /// Empty for a bare goal until Phase 0 writes the plan.
    pub phases: Vec<OvernightPhase>,
    pub directives: Directives,
    /// What stops Start until the user words it differently.
    pub problems: Vec<DirectiveProblem>,
    /// Bumped by every change of what the user agreed to (the proposal, its restrictions).
    /// Start must name the revision the user saw.
    pub revision: u32,
    /// Bumped each time the run is (re)claimed: results from an older generation are history.
    pub generation: u32,
    pub state: OvernightState,
    /// When wind-down starts; set at Start for a deadline.
    pub wind_down_at_ms: Option<i64>,
    pub stop: Option<StopReason>,
    /// The last commands applied, newest last.
    pub commands: Vec<AppliedCommand>,
    pub created_at_ms: i64,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
}

impl OvernightRun {
    /// Whether the user's restrictions select the phase with this number.
    pub fn selects(&self, number: u32) -> bool {
        self.directives
            .only
            .is_none_or(|range| (range.from..=range.to).contains(&number))
            && !self.directives.skip.contains(&number)
    }

    pub fn phase(&self, id: &str) -> Option<&OvernightPhase> {
        self.phases.iter().find(|phase| phase.id == id)
    }
}

/// A plan for an overnight run, as the orchestrator read it from the user's words and files
/// (or an IPC script gives it). Phase numbers are the source plan's own; criteria get their
/// ids when the run is proposed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposedPlan {
    pub name: String,
    /// The plan's statement of the goal; the user's words when absent.
    pub goal: Option<String>,
    /// Rules and settled decisions from the plan's sources, verbatim.
    pub rules: Option<String>,
    pub phases: Vec<ProposedPhase>,
    pub sources: Vec<ProposedSource>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposedPhase {
    /// Its number in the source plan; its place in the list when absent.
    pub number: Option<u32>,
    pub name: String,
    pub scope: String,
    pub done_when: Vec<String>,
    pub depends_on: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposedSource {
    pub path: String,
    pub sections: Option<String>,
}
