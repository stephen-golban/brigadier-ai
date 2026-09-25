//! The work inside a conversation: delegated tasks and their workers, reports, the cards that
//! wait for the user (approvals, questions, plans), the message queue and attachments. Like the
//! catalog, these types are the wire contract and are exported to TypeScript.
//!
//! Each conversation's stream (`conversation:<id>`) holds its messages and snapshots of these
//! objects as they change. `position` fields are the stream sequence of the event that created
//! the object, so messages and cards interleave in one timeline.

use brigadier_providers::{ApprovalRequest, Decider, ProviderEvent, ProviderKind};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use crate::model::{CardId, Mention, TaskId};
use crate::model::{ConversationId, ModelChoice};

/// A file the user attached, kept in the blob store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// Content hash in the blob store.
    pub id: String,
    pub name: String,
    pub mime: String,
    pub bytes: u64,
}

// ----- tasks and workers ------------------------------------------------------------------

/// What a task does (PLAN.md §5).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    /// Looks around the repository and answers a question.
    Scout,
    /// Reads docs and the web.
    Research,
    /// Changes code; its accepted result lands as one commit.
    Implement,
    /// Reviews another task's candidate commit or a plan.
    Review,
    /// Resolves conflicts between a task and its target branch.
    Merge,
    /// Runs the project's checks.
    Verify,
}

impl TaskKind {
    /// Whether the task's result is a change that lands as a commit.
    pub fn writes(self) -> bool {
        matches!(self, Self::Implement | Self::Merge)
    }
}

/// How a worker may touch the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RepoAccess {
    /// No repository checkout (research).
    None,
    /// A detached worktree it can read but not change.
    Read,
    /// Its own worktree on a task branch.
    Write,
}

/// A worker's sandbox, set per task. Every worker also has a writable scratch folder outside
/// the repository, and the outward-command gate at every permission level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerAccess {
    pub repo: RepoAccess,
    pub network: bool,
    /// No OS sandbox (Full access).
    pub unsandboxed: bool,
}

/// The model a task runs on and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub choice: ModelChoice,
    /// Shown on the worker card ("why this model").
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    /// Waiting for an approved plan, a free slot or the task it depends on.
    Queued,
    /// Creating its worktree and starting the worker.
    Starting,
    Running,
    /// The worker asked the orchestrator a question and waits for the answer.
    Blocked,
    /// The user interrupted the worker; it continues on resume.
    Paused,
    /// The worker submitted its report; the orchestrator decides what happens next.
    Reported,
    /// Its candidate commit is being reviewed by another vendor.
    Reviewing,
    /// Ask for approval: the landing waits for the user.
    AwaitingApproval,
    /// Accepted, but it cannot land safely right now (see `blockedReason`). Nothing changed.
    ReadyToLand,
    /// Its commit is on the target branch.
    Landed,
    /// Finished without landing (read-only tasks end here too).
    Done,
    /// The orchestrator or a review turned it down.
    Rejected,
    /// Stopped by the user or the orchestrator.
    Stopped,
    Failed,
}

impl TaskState {
    /// Whether the task is over: its worker is gone and it will not run again.
    pub fn is_final(self) -> bool {
        matches!(
            self,
            Self::Landed | Self::Done | Self::Rejected | Self::Stopped | Self::Failed
        )
    }
}

/// Where a task works.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspace {
    /// Its worktree, in Brigadier's data directory. Absent for tasks without a checkout.
    pub worktree: Option<String>,
    /// Its task branch (write tasks).
    pub branch: Option<String>,
    /// The commit it started from.
    pub base: Option<String>,
    /// `base` is a snapshot of the user's uncommitted changes (they let workers see them).
    /// Those changes are never landed or kept as part of the task's work.
    #[serde(default)]
    pub on_snapshot: bool,
    /// The branch its accepted work lands on.
    pub target: Option<String>,
    /// Its scratch folder outside the repository.
    pub scratch: String,
}

/// A structured report, the only part of a worker's work that enters the orchestrator's
/// context. About 800 tokens at most; details go to artifacts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub summary: String,
    pub changes: Vec<String>,
    pub decisions: Vec<String>,
    /// What the worker verified and how.
    pub verification: Vec<String>,
    pub open_questions: Vec<String>,
    /// For review tasks: the verdict.
    pub verdict: Option<ReviewVerdict>,
    pub artifacts: Vec<ArtifactRef>,
    pub submitted_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    /// The worker's full transcript.
    Transcript,
    Diff,
    CommandOutput,
    Screenshot,
    /// A research or review note.
    Note,
    File,
}

/// Something stored in the blob store that the orchestrator can read on demand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    /// Content hash in the blob store.
    pub id: String,
    pub title: String,
    pub kind: ArtifactKind,
    pub mime: String,
    pub bytes: u64,
    /// The name to save it under (a worker's file keeps its own name).
    #[serde(default)]
    pub file_name: Option<String>,
}

/// Lines added and removed, per file and in total.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub files: Vec<FileStat>,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
    /// Binary files have no line counts.
    pub binary: bool,
}

/// A write task's result as one commit on the current target tip: what is reviewed, verified
/// and landed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub commit: String,
    /// The target tip it was built on.
    pub onto: String,
    pub message: String,
    pub diff_stat: DiffStat,
    /// Files the litter guard left out, with why.
    pub excluded: Vec<ExcludedFile>,
    /// The full diff, for reviewers and the UI.
    pub diff: Option<ArtifactRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedFile {
    pub path: String,
    pub reason: String,
}

/// The mandatory cross-vendor review of a write task's candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    /// The review task.
    pub task_id: TaskId,
    /// The candidate commit it reviewed.
    pub commit: String,
    pub verdict: Option<ReviewVerdict>,
    /// False when only one vendor was available and another model of it reviewed.
    pub cross_vendor: bool,
}

/// A delegated unit of work and its worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    pub conversation_id: ConversationId,
    /// Shown as `task-N` and used for @-mentions; unique within the conversation.
    pub number: u32,
    pub position: i64,
    pub title: String,
    pub kind: TaskKind,
    /// The task spec the worker got.
    pub spec: String,
    pub access: WorkerAccess,
    pub route: Route,
    pub state: TaskState,
    /// The task this one reviews or merges.
    pub subject: Option<TaskId>,
    /// The plan this one reviews.
    pub plan: Option<CardId>,
    pub attachments: Vec<AttachmentRef>,
    pub workspace: Option<TaskWorkspace>,
    pub report: Option<Report>,
    pub candidate: Option<Candidate>,
    pub review: Option<ReviewRecord>,
    /// The landed commit.
    pub landed: Option<String>,
    /// Why it is blocked, paused or cannot land yet.
    pub blocked_reason: Option<String>,
    pub error: Option<String>,
    /// Unfinished changes kept when the task was stopped or archived.
    pub kept: Option<KeptWork>,
    /// The files the worker left in its outputs folder, stored when it reported and again
    /// when the task ended: deliverables the user saves from the task card.
    #[serde(default)]
    pub outputs: Vec<ArtifactRef>,
    /// The user request it was delegated for.
    #[serde(default)]
    pub request_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// What happened to a task's unfinished changes when its worktree was removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KeptWork {
    /// Committed as a work-in-progress commit on the task branch, which is kept.
    Branch { branch: String, commit: String },
    /// Stored as a diff artifact, when it could not be kept as a clean commit on the target
    /// (for example because it overlaps uncommitted changes the user let workers see). The
    /// task branch is gone; the patch can be restored as a new branch.
    Diff {
        artifact: ArtifactRef,
        /// The branch the patch was restored as.
        #[serde(default)]
        restored: Option<String>,
    },
}

/// What restoring a kept patch as a branch did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestoreOutcome {
    /// A new branch with one commit of the patch on the target branch's current tip.
    Restored { branch: String, commit: String },
    /// The patch conflicts with the target branch now; nothing was created.
    Conflicts { paths: Vec<String> },
    /// The patch no longer applies at all; nothing was created.
    Failed { reason: String },
}

// ----- cards -------------------------------------------------------------------------------

/// Whether a card still waits for an answer, and the answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CardState {
    Pending,
    Allowed {
        by: Decider,
        /// The CLI keeps allowing the request's session grant (similar commands).
        #[serde(default)]
        similar: bool,
    },
    Denied {
        by: Decider,
        message: Option<String>,
    },
    /// Nobody answered in time, or what it asked about went away.
    Expired {
        reason: String,
    },
}

/// What an approval card asks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalSubject {
    /// A worker's CLI asks for a permission Brigadier may not grant on the user's behalf.
    Cli { request: ApprovalRequest },
    /// An outward command stopped by the command gate, bound to exactly this argv and cwd.
    OutwardCommand { argv: Vec<String>, cwd: String },
    /// Ask for approval: land a reviewed task on its branch.
    Landing {
        task_id: TaskId,
        branch: String,
        diff_stat: DiffStat,
    },
    /// Merge the session branch into its base.
    FinishSession {
        branch: String,
        base: String,
        commits: u32,
        diff_stat: DiffStat,
    },
    /// An action the orchestrator asked the user to approve.
    Action { action: String, details: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: CardId,
    pub conversation_id: ConversationId,
    pub task_id: Option<TaskId>,
    /// The user request it belongs to.
    #[serde(default)]
    pub request_id: Option<String>,
    pub position: i64,
    pub subject: ApprovalSubject,
    pub state: CardState,
    pub created_at_ms: i64,
    pub resolved_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QuestionKind {
    /// The orchestrator asks something only the user can answer (`ask_user`).
    Orchestrator,
    /// Local checkout with uncommitted changes: should workers start from them?
    UncommittedChanges { files: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: CardId,
    pub conversation_id: ConversationId,
    /// The task that waits for the answer, if any.
    pub task_id: Option<TaskId>,
    /// The user request it belongs to.
    #[serde(default)]
    pub request_id: Option<String>,
    pub position: i64,
    pub kind: QuestionKind,
    pub text: String,
    /// Suggested answers; the user may also type one.
    pub options: Vec<String>,
    /// The suggested answer the asker recommends, by its index in `options`.
    #[serde(default)]
    pub recommended: Option<u32>,
    pub answer: Option<String>,
    pub created_at_ms: i64,
    pub answered_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub title: String,
    pub detail: Option<String>,
    /// The task carrying out this step, once delegated.
    pub task_id: Option<TaskId>,
}

/// Who approved a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PlanApprover {
    User,
    /// Approve for me, a plan the orchestrator did not mark risky: approved without review,
    /// and marked as such on the card.
    Brigadier,
    /// Approve for me, a risky plan: approved after a cross-vendor plan review.
    Review,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlanState {
    Proposed,
    /// A reviewer from another vendor is checking it.
    InReview {
        task_id: TaskId,
    },
    Approved {
        by: PlanApprover,
    },
    Rejected {
        message: Option<String>,
    },
    /// A newer plan replaced it.
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: CardId,
    pub conversation_id: ConversationId,
    /// The user request it belongs to.
    #[serde(default)]
    pub request_id: Option<String>,
    pub position: i64,
    pub title: String,
    pub steps: Vec<PlanStep>,
    /// Big, risky or architectural, as the orchestrator judged it.
    pub risky: bool,
    pub state: PlanState,
    pub created_at_ms: i64,
    pub decided_at_ms: Option<i64>,
}

// ----- the message queue --------------------------------------------------------------------

/// A message waiting for the running turn to end.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    pub attachments: Vec<AttachmentRef>,
    pub mentions: Vec<Mention>,
    pub queued_at_ms: i64,
    pub edited_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageQueue {
    /// In the order they will be sent.
    pub items: Vec<QueuedMessage>,
    /// The user interrupted the turn; nothing is sent until they resume.
    pub paused: bool,
}

// ----- the conversation's live state --------------------------------------------------------

/// What a conversation's model (the orchestrator, or a Chat's model) is doing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    /// Not running (no CLI process, or between turns).
    #[default]
    Idle,
    /// Setting up the environment or starting the CLI.
    Starting,
    /// A turn is running.
    Running,
    /// Its CLI stopped; the next message resumes it.
    Hibernated,
    Failed,
}

/// What the sidebar shows about a conversation: whether it runs, and what waits for the user.
/// The UI keeps it current from the same events as the board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationActivity {
    pub conversation_id: ConversationId,
    pub run: RunState,
    /// Its tasks that are not over, with their state.
    pub tasks: Vec<(TaskId, TaskState)>,
    /// Approvals and plans waiting for the user's decision.
    pub approvals: Vec<CardId>,
    /// Questions not answered yet.
    pub questions: Vec<CardId>,
}

// ----- worker steps -----------------------------------------------------------------------

/// A turn in a worker's life, as the thread tells it ("task-2 finished").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum WorkerStepKind {
    Started,
    /// Its change waits for the user's approval, or for a landing the user can unblock.
    Waiting,
    /// The user interrupted it.
    Paused,
    /// Working again after waiting, a pause or its report.
    Resumed,
    /// It reported (or ended without anything to land).
    Finished,
    Landed,
    /// The orchestrator or a review turned it down.
    Rejected,
    Stopped,
    Failed,
}

impl WorkerStepKind {
    /// The step a task takes when its state goes from `was` (absent: it was just created) to
    /// `now`, if the thread shows one.
    pub fn between(was: Option<TaskState>, now: TaskState) -> Option<Self> {
        use TaskState as S;
        let waiting = |state: S| matches!(state, S::AwaitingApproval | S::ReadyToLand);
        // A review of its commit is not the worker working again.
        let working = |state: S| matches!(state, S::Queued | S::Starting | S::Running | S::Blocked);
        let Some(was) = was else {
            return Some(Self::Started);
        };
        if was == now {
            return None;
        }
        match now {
            S::Landed => Some(Self::Landed),
            S::Rejected => Some(Self::Rejected),
            S::Stopped => Some(Self::Stopped),
            S::Failed => Some(Self::Failed),
            // Back from a review, the reviewer's own row tells it.
            S::Reported | S::Done if !matches!(was, S::Reported | S::Done | S::Reviewing) => {
                Some(Self::Finished)
            }
            S::Paused => Some(Self::Paused),
            _ if waiting(now) && !waiting(was) => Some(Self::Waiting),
            _ if working(now) && (waiting(was) || matches!(was, S::Paused | S::Reported)) => {
                Some(Self::Resumed)
            }
            _ => None,
        }
    }
}

/// One step of a worker, where it happened in the conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStep {
    pub task_id: TaskId,
    /// The user request the task belongs to.
    #[serde(default)]
    pub request_id: Option<String>,
    pub kind: WorkerStepKind,
    pub at_ms: i64,
    /// Where it happened in the conversation's stream (set when the board reads it).
    #[serde(default)]
    pub position: i64,
}

// ----- orchestrator steps -----------------------------------------------------------------

/// What the orchestrator (or a Chat's model) did that the thread tells as a grey row, in
/// ChatGPT's words. What already shows by itself (a worker's own row, a card) has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrchestratorStepKind {
    /// "Sent message to {worker}".
    Messaged { task_id: TaskId },
    /// "Read {worker}'s report".
    ReadReport { task_id: TaskId },
    /// "Read {artifact}".
    ReadArtifact { name: String },
    /// "Accepted {worker}'s change".
    Accepted { task_id: TaskId },
    /// "Searched the web for {query}" (a Chat).
    SearchedWeb { query: String },
    /// "Read {page}" (a Chat).
    ReadPage { url: String },
}

/// One step of the orchestrator, where it happened in the conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStep {
    /// The user request the turn served.
    #[serde(default)]
    pub request_id: Option<String>,
    pub kind: OrchestratorStepKind,
    pub at_ms: i64,
    /// Where it happened in the conversation's stream (set when the board reads it).
    #[serde(default)]
    pub position: i64,
}

// ----- compactions -----------------------------------------------------------------------

/// Where a compaction stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompactionState {
    Running,
    Done,
    Failed { error: String },
}

/// A Chat's model compacting its context: ChatGPT's "Compacting context" row, then "Context
/// compacted". A session's orchestrator never compacts (it starts afresh instead).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    pub id: String,
    /// The request whose turn it happened in (the model compacted on its own mid-turn);
    /// absent when the user asked for it between turns.
    #[serde(default)]
    pub request_id: Option<String>,
    /// The last message of the branch shown when it began: it shows after that message's
    /// answer, on that branch only.
    #[serde(default)]
    pub after: Option<String>,
    /// The model compacted on its own as its context filled up.
    pub automatic: bool,
    pub state: CompactionState,
    /// The context before and after, when the CLI says.
    pub tokens_before: Option<i64>,
    pub tokens_after: Option<i64>,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    /// Where it happened in the conversation's stream (set when the board reads it).
    #[serde(default)]
    pub position: i64,
}

// ----- user requests ----------------------------------------------------------------------

/// Where a user's request stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RequestState {
    /// The orchestrator (or a Chat's model) is on it, or a worker it started is.
    Working,
    /// Nothing runs: it waits for the user (a card, a paused worker, a landing on hold).
    Waiting,
    Done,
    /// The user stopped the reply.
    Stopped,
    Failed {
        error: String,
    },
}

/// What one user message set in motion. The message starts it; the model's replies, the tasks
/// delegated and the cards opened while serving it carry its id (`request_id`), so a thread
/// shows one block per request whatever order things finished in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserRequest {
    /// The id of the user message that started it.
    pub id: String,
    pub conversation_id: ConversationId,
    /// The start of the user's message, on one line.
    pub preview: String,
    pub state: RequestState,
    pub started_at_ms: i64,
    /// When it last stopped working; absent while it works.
    pub ended_at_ms: Option<i64>,
    /// The request whose running turn its message was steered into: the thread shows it
    /// inside that request's block.
    #[serde(default)]
    pub steered_into: Option<String>,
    /// The reply that was streaming when it was steered in: its bubble shows after it.
    #[serde(default)]
    pub steered_after: Option<String>,
    /// The user's Undo of what its workers landed, once they used it.
    #[serde(default)]
    pub undo: Option<RequestUndo>,
}

/// The user's Undo and Reapply of what a request's workers landed (ChatGPT's turn diff card).
/// Each is a new commit, never a history rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RequestUndo {
    /// Its changes are reverted now: true after Undo, false after Reapply.
    pub reverted: bool,
    /// The commits Undo and Reapply landed, oldest first; each reverts the one before it, the
    /// first the request's own landings.
    pub commits: Vec<String>,
}

/// A session checkout's state for the pinned card's Git actions and commit popover.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    /// The branch checked out; absent on a detached HEAD.
    pub branch: Option<String>,
    /// What is staged.
    pub staged: DiffStat,
    /// Everything not committed yet, untracked files included.
    pub uncommitted: DiffStat,
    /// The remote the branch pushes to, if any.
    pub remote: Option<String>,
    pub upstream: Option<String>,
    /// Commits not pushed yet.
    pub ahead: u32,
}

/// The GitHub pull request of a session's branch (the pinned card's row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: PullRequestState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

/// The user's commit, as made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub commit: String,
    pub message: String,
    pub branch: String,
    pub pushed: bool,
}

/// What the side panel's Review tab compares (ChatGPT's scope picker).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReviewScope {
    /// What one request's workers landed. Absent: the latest request that landed anything.
    LastTurn { request_id: Option<String> },
    /// Everything not committed yet, untracked files included.
    Uncommitted,
    /// What is not staged yet, untracked files included.
    Unstaged,
    /// What is staged.
    Staged,
    /// One commit.
    Commit { commit: String },
    /// The session's branch since it left its base.
    Branch,
}

/// How a file changed, for the Review tab's badge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReviewFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    /// New and not tracked by git yet.
    Untracked,
}

/// One file of a review.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    /// A renamed file's old path.
    pub from: Option<String>,
    pub status: ReviewFileStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// A commit the Review tab offers under "Committed".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommit {
    pub commit: String,
    pub subject: String,
    pub at_ms: i64,
}

/// The Review tab's diff: its files and their unified patch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    /// The scope shown; "Last Turn" names the request it found.
    pub scope: ReviewScope,
    pub files: Vec<ReviewFile>,
    pub insertions: u32,
    pub deletions: u32,
    /// The unified text patch of every file, in `files`' order.
    pub patch: String,
    /// The patch carries whole files, so unchanged lines can be expanded.
    pub full_files: bool,
    /// The branch's latest commits, newest first.
    pub commits: Vec<ReviewCommit>,
    /// The branch compared ("Branch") and the one it left.
    pub branch: Option<String>,
    pub base: Option<String>,
}

/// A file of a session's checkout, as the Files tab shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutFile {
    /// Relative to the checkout's root.
    pub path: String,
    /// Its size in bytes.
    pub size: u64,
    /// Its text; absent for a binary file.
    pub text: Option<String>,
    /// Only the file's start was read.
    pub truncated: bool,
}

/// Why something entered the orchestrator's context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InjectionKind {
    /// Brigadier's role instructions, once per CLI session.
    Instructions,
    UserMessage,
    Report,
    WorkerQuestion,
    /// A card was answered (approval, question, plan).
    Decision,
    TaskFailed,
    /// A tool's result (a task id, a short status).
    ToolResult,
    /// An artifact it asked to read.
    Artifact,
    /// The transcript a new orchestrator CLI session is seeded with.
    Reseed,
    /// The user resumed a request they had stopped.
    Resume,
}

/// One thing Brigadier put into the orchestrator's context, for the Inspector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextInjection {
    pub kind: InjectionKind,
    pub bytes: u64,
    /// About four bytes per token.
    pub tokens_estimate: u64,
    /// A short description (`report task-3`, the first words of a message).
    pub label: String,
    pub task_id: Option<TaskId>,
}

/// One entry of the orchestrator log shown in the Inspector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OrchestratorEntry {
    Injection {
        injection: ContextInjection,
    },
    /// What the orchestrator's CLI reported.
    Provider {
        provider: ProviderKind,
        event: ProviderEvent,
    },
}
