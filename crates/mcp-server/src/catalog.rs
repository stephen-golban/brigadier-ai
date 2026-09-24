//! The tools each role sees, their descriptions (the models' manual), and the mapping from an
//! MCP `tools/call` onto [`ToolCall`].

use std::sync::{Arc, OnceLock};

use brigadier_core::tools::{
    AcceptTask, AskOrchestrator, AskUser, DelegateTask, FinishSession, MessageWorker,
    OrchestratorCall, ProposePlan, QueryBrain, ReadArtifact, RequestApproval, Role, SubmitReport,
    TaskRef, ToolCall, WorkerCall,
};
use rmcp::model::{JsonObject, Tool};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::schema::{input_schema, no_arguments};

const DELEGATE_TASK: &str = "Start a worker on one task. Returns at once with the task id \
(e.g. \"task-3\"); the worker runs in the background and its final report arrives later as a \
message in this conversation. Never wait, sleep or poll for it: end your turn, and carry on \
when the report or the user's next message arrives. You can delegate several independent tasks \
at once. The worker sees nothing of this conversation but `spec` (and the listed attachments), \
so make the spec self-contained. `implement` and `merge` tasks change code in their own git \
worktree and land only through accept_task; the other kinds only read and report.";

const MESSAGE_WORKER: &str = "Send text to a running worker: the answer to the question it \
asked you (it is waiting for it), or an instruction that steers its current work. Returns once \
delivered.";

const STOP_WORKER: &str = "Stop a running worker, e.g. when its task is no longer needed or \
went wrong. Nothing of it lands.";

const ASK_USER: &str = "Ask the user a question only they can answer (a product choice, an \
unclear requirement). Returns at once; the answer arrives later as a message. Name the task that \
waits for the answer in `task` so other work continues; `options` become answer buttons (the \
user can always type their own answer).";

const READ_REPORT: &str = "Read a task's final report again: summary, changes, decisions, \
verification, open questions and artifact ids.";

const READ_ARTIFACT: &str = "Read part of an artifact named in a report (full transcript, \
diff, command output, note) by its id. At most 16000 bytes per call, starting at `offset`; the \
reply gives the total size so you can page. Read only what you need: everything you read enters \
your context.";

const QUERY_BRAIN: &str = "Ask the Project Brain, the project's stored knowledge. Not \
available in this version yet: it returns a notice.";

const PROPOSE_PLAN: &str = "Show the user a plan card for multi-step work: a title and the \
steps. Returns at once; the decision arrives later as a message. Under \"Ask for approval\" no \
write task may start until the user approved a plan. Set `risky` for big, risky or \
architectural plans.";

const REQUEST_APPROVAL: &str = "Ask the user to approve an action Brigadier cannot see on its \
own. Returns at once; the decision arrives later as a message.";

const ACCEPT_TASK: &str = "Land a finished `implement` or `merge` task as one commit on the \
session's branch, with your commit message. Call it after reading the task's report. Brigadier \
first has the change reviewed by another vendor and checks that it can land safely; what happens \
arrives as a message.";

const FINISH_SESSION: &str = "New-worktree sessions only: when all the work has landed, ask \
the user to merge the session branch into its base branch (one click on a card). Returns at \
once; the outcome arrives later as a message.";

const LIST_TASKS: &str = "List this session's tasks: id, title, kind, status and model.";

const ASK_ORCHESTRATOR: &str = "Ask the orchestrator (who gave you this task) a question you \
cannot settle yourself, such as an unclear requirement or a choice outside your task. The call \
blocks until the answer comes back, which can take minutes. Ask only when you cannot sensibly \
go on without the answer.";

const SUBMIT_REPORT: &str = "Submit your final structured report. Call it exactly once, as \
your last action, when the task is done or cannot be done. It is final and capped at about 800 \
tokens: keep every field short, and put long material (logs, full command output, notes) in \
files in your scratch folder, listed under `artifacts`. List every file you changed, created or \
deleted under `changes`: new files that are not listed are not kept.";

/// The tools `role` may call, in a stable order. The gate role gets none.
pub fn tools_for(role: &Role) -> &'static [Tool] {
    static ORCHESTRATOR: OnceLock<Vec<Tool>> = OnceLock::new();
    static WORKER: OnceLock<Vec<Tool>> = OnceLock::new();
    match role {
        Role::Orchestrator { .. } => ORCHESTRATOR.get_or_init(orchestrator_tools),
        Role::Worker { .. } => WORKER.get_or_init(worker_tools),
        Role::Gate { .. } => &[],
    }
}

fn orchestrator_tools() -> Vec<Tool> {
    vec![
        tool(
            "delegate_task",
            DELEGATE_TASK,
            input_schema::<DelegateTask>(),
        ),
        tool(
            "message_worker",
            MESSAGE_WORKER,
            input_schema::<MessageWorker>(),
        ),
        tool("stop_worker", STOP_WORKER, input_schema::<TaskRef>()),
        tool("ask_user", ASK_USER, input_schema::<AskUser>()),
        tool("read_report", READ_REPORT, input_schema::<TaskRef>()),
        tool(
            "read_artifact",
            READ_ARTIFACT,
            input_schema::<ReadArtifact>(),
        ),
        tool("query_brain", QUERY_BRAIN, input_schema::<QueryBrain>()),
        tool("propose_plan", PROPOSE_PLAN, input_schema::<ProposePlan>()),
        tool(
            "request_approval",
            REQUEST_APPROVAL,
            input_schema::<RequestApproval>(),
        ),
        tool("accept_task", ACCEPT_TASK, input_schema::<AcceptTask>()),
        tool(
            "finish_session",
            FINISH_SESSION,
            input_schema::<FinishSession>(),
        ),
        tool("list_tasks", LIST_TASKS, no_arguments()),
    ]
}

fn worker_tools() -> Vec<Tool> {
    vec![
        tool(
            "ask_orchestrator",
            ASK_ORCHESTRATOR,
            input_schema::<AskOrchestrator>(),
        ),
        tool(
            "submit_report",
            SUBMIT_REPORT,
            input_schema::<SubmitReport>(),
        ),
    ]
}

fn tool(name: &'static str, description: &'static str, schema: JsonObject) -> Tool {
    Tool::new(name, description, Arc::new(schema))
}

/// Why a `tools/call` could not become a [`ToolCall`]; shown to the model as a tool error.
#[derive(Debug)]
pub enum ParseError {
    /// Not one of this role's tools.
    UnknownTool(String),
    /// The arguments do not match the tool's schema.
    BadArguments { tool: String, reason: String },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownTool(name) => write!(f, "There is no tool named {name:?} for you."),
            Self::BadArguments { tool, reason } => {
                write!(f, "Invalid arguments for {tool}: {reason}")
            }
        }
    }
}

/// Maps a call of tool `name` with `arguments` onto the core's [`ToolCall`], for `role`.
pub fn parse_call(
    role: &Role,
    name: &str,
    arguments: Option<JsonObject>,
) -> Result<ToolCall, ParseError> {
    let mut arguments = arguments.unwrap_or_default();
    // Models sometimes send `null` for an optional argument; it means "left out".
    arguments.retain(|_, value| !value.is_null());
    let arguments = Value::Object(arguments);
    let unknown = || ParseError::UnknownTool(name.to_owned());
    match role {
        Role::Orchestrator { .. } => {
            let call = match name {
                "delegate_task" => OrchestratorCall::DelegateTask(args(name, arguments)?),
                "message_worker" => OrchestratorCall::MessageWorker(args(name, arguments)?),
                "stop_worker" => OrchestratorCall::StopWorker(args(name, arguments)?),
                "ask_user" => OrchestratorCall::AskUser(args(name, arguments)?),
                "read_report" => OrchestratorCall::ReadReport(args(name, arguments)?),
                "read_artifact" => OrchestratorCall::ReadArtifact(args(name, arguments)?),
                "query_brain" => OrchestratorCall::QueryBrain(args(name, arguments)?),
                "propose_plan" => OrchestratorCall::ProposePlan(args(name, arguments)?),
                "request_approval" => OrchestratorCall::RequestApproval(args(name, arguments)?),
                "accept_task" => OrchestratorCall::AcceptTask(args(name, arguments)?),
                "finish_session" => OrchestratorCall::FinishSession(args(name, arguments)?),
                "list_tasks" => OrchestratorCall::ListTasks,
                _ => return Err(unknown()),
            };
            Ok(ToolCall::Orchestrator(call))
        }
        Role::Worker { .. } => {
            let call = match name {
                "ask_orchestrator" => {
                    WorkerCall::AskOrchestrator(args::<AskOrchestrator>(name, arguments)?)
                }
                "submit_report" => WorkerCall::SubmitReport(args::<SubmitReport>(name, arguments)?),
                _ => return Err(unknown()),
            };
            Ok(ToolCall::Worker(call))
        }
        Role::Gate { .. } => Err(unknown()),
    }
}

fn args<T: DeserializeOwned>(tool: &str, arguments: Value) -> Result<T, ParseError> {
    serde_json::from_value(arguments).map_err(|err| ParseError::BadArguments {
        tool: tool.to_owned(),
        reason: err.to_string(),
    })
}
