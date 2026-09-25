//! The Brigadier MCP tools as the core sees them: who may call them, their arguments, and the
//! host that answers them.
//!
//! Every CLI session Brigadier starts gets its own random **grant**, scoped to one role in one
//! conversation. The grant is the only credential a session holds: it lives in daemon memory,
//! is checked on every call (so revoking it also cuts off connections that are already open),
//! and is revoked when the session ends. A grant never reaches UI-only requests such as
//! answering approval cards.
//!
//! - [`Role::Orchestrator`] may call the orchestrator tools ([`OrchestratorCall`]).
//! - [`Role::Worker`] may call the worker tools ([`WorkerCall`]) for its own task.
//! - [`Role::Gate`] may only ask whether an outward command may run ([`ToolHost::ask_outward`]).
//!
//! The MCP server (`crates/mcp-server`) maps MCP tool calls onto these types; the session
//! manager implements [`ToolHost`].

use std::collections::HashMap;
use std::sync::Mutex;

use brigadier_providers::BoxFuture;
use schemars::JsonSchema;
use serde::Deserialize;

use crate::model::{ConversationId, TaskId};
use crate::work::{ReviewVerdict, TaskKind};

/// What a grant allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    /// The orchestrator of a session.
    Orchestrator { conversation_id: ConversationId },
    /// The worker running one task.
    Worker {
        conversation_id: ConversationId,
        task_id: TaskId,
    },
    /// The outward-command gate of a CLI session: it can only ask.
    Gate {
        conversation_id: ConversationId,
        task_id: Option<TaskId>,
    },
}

/// Live grants, keyed by their secret value. Each belongs to a cleanup-ledger owner
/// (`orch:<id>`, `task:<id>`, …) so ending the owner revokes all of its grants.
#[derive(Default)]
pub struct Grants {
    inner: Mutex<HashMap<String, (String, Role)>>,
}

impl Grants {
    /// Issues a fresh grant for `role`, owned by `owner`.
    pub fn issue(&self, owner: &str, role: Role) -> String {
        let secret = format!(
            "brg_{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.lock().insert(secret.clone(), (owner.to_owned(), role));
        secret
    }

    /// The role of a live grant.
    pub fn resolve(&self, grant: &str) -> Option<Role> {
        self.lock().get(grant).map(|(_, role)| role.clone())
    }

    /// Revokes every grant `owner` holds.
    pub fn revoke_owner(&self, owner: &str) {
        self.lock().retain(|_, (held_by, _)| held_by != owner);
    }

    /// Every live grant value, for scrubbing them out of logs and recordings.
    pub fn secrets(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, Role)>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

// ----- orchestrator tools ----------------------------------------------------------------

/// `delegate_task`: start a worker. Returns at once with the task's number; the report arrives
/// later as a message.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DelegateTask {
    /// A short title for the task card, e.g. "Add the --json flag to `list`".
    pub title: String,
    /// What the task does. `implement` and `merge` tasks change code and land as one commit
    /// each; the others only read and report.
    pub kind: TaskKind,
    /// The full task spec for the worker: goal, context, constraints, what "done" means and how
    /// to verify it. The worker sees nothing else of the conversation.
    pub spec: String,
    /// Optional provider override: "claude" or "codex". Leave it out to let Brigadier route.
    #[serde(default)]
    pub provider: Option<String>,
    /// Optional model id override (from that provider's model list).
    #[serde(default)]
    pub model: Option<String>,
    /// Optional reasoning effort override: "low", "medium" or "high".
    #[serde(default)]
    pub effort: Option<String>,
    /// For `review` tasks: the task whose candidate commit is reviewed, e.g. "task-2".
    #[serde(default)]
    pub subject: Option<String>,
    /// Ids of the user's attachments the worker should get as files.
    #[serde(default)]
    pub attachments: Vec<String>,
}

/// `message_worker`: answer a worker's blocking question, or steer a running worker.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MessageWorker {
    /// The task, e.g. "task-3".
    pub task: String,
    /// The answer or instruction.
    pub text: String,
}

/// A task reference only (`stop_worker`, `read_report`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TaskRef {
    /// The task, e.g. "task-3".
    pub task: String,
}

/// `ask_user`: a question only the user can answer (a product choice, an unclear requirement).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskUser {
    /// The question, self-contained: the user may read it later, out of context.
    pub question: String,
    /// Suggested answers shown as buttons; the user can always type their own.
    #[serde(default)]
    pub options: Vec<String>,
    /// The option you recommend, by its 0-based index in `options` (shown as "Recommended").
    #[serde(default)]
    pub recommended: Option<u32>,
    /// The task that waits for the answer, if any (other tasks continue).
    #[serde(default)]
    pub task: Option<String>,
}

/// `read_artifact`: page through a stored artifact (transcript, diff, command output, note).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadArtifact {
    /// The artifact id from a report.
    pub id: String,
    /// Byte offset to start at.
    #[serde(default)]
    pub offset: Option<u64>,
    /// Bytes to read (at most 16000).
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `query_brain`: ask the Project Brain.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QueryBrain {
    /// What you want to know about the project.
    pub query: String,
}

/// One step of a proposed plan.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PlanStepInput {
    /// The step, in a few words.
    pub title: String,
    /// What it involves, if the title is not enough.
    #[serde(default)]
    pub detail: Option<String>,
}

/// `propose_plan`: show a plan card. Under "Ask for approval" the user approves it before any
/// write task starts.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposePlan {
    /// What the plan achieves.
    pub title: String,
    /// The steps, in order.
    pub steps: Vec<PlanStepInput>,
    /// True for big, risky or architectural plans: they get a cross-vendor review before
    /// Brigadier approves them on the user's behalf.
    #[serde(default)]
    pub risky: bool,
}

/// `request_approval`: ask the user to approve an action Brigadier cannot see otherwise.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequestApproval {
    /// What would happen, in one line.
    pub action: String,
    /// Why, and what exactly.
    pub details: String,
}

/// `accept_task`: land a reported write task as one reviewed commit.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AcceptTask {
    /// The task, e.g. "task-3".
    pub task: String,
    /// The commit message: a short subject line, a blank line, then the body.
    pub commit_message: String,
}

/// `finish_session`: merge the session branch into its base (new-worktree sessions), behind the
/// user's one-click approval.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FinishSession {
    /// The merge commit message, when a merge commit is needed.
    #[serde(default)]
    pub message: Option<String>,
}

/// A tool call from an orchestrator.
#[derive(Debug, Clone)]
pub enum OrchestratorCall {
    DelegateTask(DelegateTask),
    MessageWorker(MessageWorker),
    StopWorker(TaskRef),
    AskUser(AskUser),
    ReadReport(TaskRef),
    ReadArtifact(ReadArtifact),
    QueryBrain(QueryBrain),
    ProposePlan(ProposePlan),
    RequestApproval(RequestApproval),
    AcceptTask(AcceptTask),
    FinishSession(FinishSession),
    ListTasks,
}

impl OrchestratorCall {
    /// The MCP tool name.
    pub fn name(&self) -> &'static str {
        match self {
            Self::DelegateTask(_) => "delegate_task",
            Self::MessageWorker(_) => "message_worker",
            Self::StopWorker(_) => "stop_worker",
            Self::AskUser(_) => "ask_user",
            Self::ReadReport(_) => "read_report",
            Self::ReadArtifact(_) => "read_artifact",
            Self::QueryBrain(_) => "query_brain",
            Self::ProposePlan(_) => "propose_plan",
            Self::RequestApproval(_) => "request_approval",
            Self::AcceptTask(_) => "accept_task",
            Self::FinishSession(_) => "finish_session",
            Self::ListTasks => "list_tasks",
        }
    }
}

// ----- worker tools ----------------------------------------------------------------------

/// `ask_orchestrator`: a blocking question. The call returns the orchestrator's answer.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AskOrchestrator {
    /// The question, with the context the orchestrator needs to answer it.
    pub question: String,
}

/// A file the worker saved in its scratch folder, attached to its report.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInput {
    /// Path of the file, inside the worker's scratch folder (absolute, or relative to it).
    pub path: String,
    /// What the file holds, in a few words.
    pub title: String,
}

/// `submit_report`: the worker's final structured report (about 800 tokens at most; details go
/// into artifacts). Call it exactly once, at the end.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SubmitReport {
    /// What was done, in a few sentences.
    pub summary: String,
    /// Repo-relative paths changed, created or deleted (every new file you want kept must be
    /// listed).
    #[serde(default)]
    pub changes: Vec<String>,
    /// Decisions made and why.
    #[serde(default)]
    pub decisions: Vec<String>,
    /// Exactly what was verified and how (commands run and their results).
    #[serde(default)]
    pub verification: Vec<String>,
    /// Questions left open, or (for reviews) the exact issues to fix.
    #[serde(default)]
    pub open_questions: Vec<String>,
    /// Review tasks only: the verdict on the reviewed change.
    #[serde(default)]
    pub verdict: Option<ReviewVerdict>,
    /// Files from your scratch folder with details the report leaves out.
    #[serde(default)]
    pub artifacts: Vec<ArtifactInput>,
}

/// A tool call from a worker.
#[derive(Debug, Clone)]
pub enum WorkerCall {
    AskOrchestrator(AskOrchestrator),
    SubmitReport(SubmitReport),
}

impl WorkerCall {
    /// The MCP tool name.
    pub fn name(&self) -> &'static str {
        match self {
            Self::AskOrchestrator(_) => "ask_orchestrator",
            Self::SubmitReport(_) => "submit_report",
        }
    }
}

/// A tool call, for either role.
#[derive(Debug, Clone)]
pub enum ToolCall {
    Orchestrator(OrchestratorCall),
    Worker(WorkerCall),
}

/// What a tool call returns to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolReply {
    pub text: String,
    /// The call failed or was refused; `text` says why.
    pub is_error: bool,
}

impl ToolReply {
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
        }
    }
}

/// The user's decision on an outward command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateAnswer {
    Allow,
    Deny { message: String },
}

/// Answers tool calls and gate questions. Implemented by the session manager.
pub trait ToolHost: Send + Sync {
    /// The role of a live grant; `None` for an unknown or revoked grant.
    fn role(&self, grant: &str) -> Option<Role>;

    /// Runs a tool call. The host re-checks the grant and that its role may make this call.
    fn call(&self, grant: &str, call: ToolCall) -> BoxFuture<'_, ToolReply>;

    /// Asks the user whether an outward command (PLAN §5 always-ask list) may run, and waits
    /// for the answer. `argv` is the full command line as the program received it, `cwd` the
    /// directory it runs in; an approval is bound to exactly these.
    fn ask_outward(&self, grant: &str, argv: Vec<String>, cwd: String)
    -> BoxFuture<'_, GateAnswer>;
}
