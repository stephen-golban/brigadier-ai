//! Codex adapter: `codex app-server` over stdio JSON-RPC, one app-server per session.
//!
//! Sessions use `thread/*` and `turn/*` (steer and interrupt included). Approvals are
//! server requests Brigadier answers. A command Codex asks about runs outside its sandbox once
//! approved, so every command and file-change approval is an escalation:
//!
//! - Workspace (and full) access use `on-request`: commands run inside the sandbox without
//!   asking; Codex asks only to leave it, and that goes to the user.
//! - Read-only access uses `untrusted`: Codex asks before every command, and a read-only
//!   session (such as an orchestrator) has all of them declined, so nothing runs.
//!
//! Codex has no per-session way to make an outward action such as `git push` ask while it runs
//! inside the sandbox: its exec-policy rules load only from `~/.codex/rules` or from the
//! `.codex/rules` of a project trusted in `~/.codex/config.toml`.
//!
//! The user's personal Codex setup stays out: plugins, apps, hooks, computer and browser use,
//! memories and `notify` are switched off per process, and the MCP servers from their config are
//! disabled per thread. Starting a thread in a project the user never trusted makes Codex
//! persist a trust entry for it in `~/.codex/config.toml` (the override passed per process does
//! not prevent that), so the entries a thread adds are recorded in the ledger and removed with
//! it, through Codex's own config API. Brigadier writes nothing else there.

pub mod parse;
#[allow(clippy::all, clippy::pedantic, dead_code, unused_imports)]
pub mod protocol;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brigadier_sandbox::Platform;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::cli::{CliEnv, parse_version};
use crate::model::*;
use crate::process::{self, CliProcess};
use crate::record::{self, Direction, Recorder};
use crate::{
    BoxFuture, Error, Ledger, Provider, ProviderSession, Replayer, Result, Started, now_ms,
};
use parse::{Control, Output, Parser, PendingKind};
use protocol as p;

const EVENTS: usize = 512;
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
const START_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_GRACE: Duration = Duration::from_secs(3);

/// Features that bring the user's personal Codex setup (or desktop integrations) into a
/// session.
const DISABLED_FEATURES: &[&str] = &[
    "plugins",
    "apps",
    "hooks",
    "computer_use",
    "browser_use",
    "memories",
];

pub struct Codex {
    platform: Arc<dyn Platform>,
    env: Arc<CliEnv>,
    binary: Option<PathBuf>,
}

impl Codex {
    pub fn new(platform: Arc<dyn Platform>, env: Arc<CliEnv>) -> Self {
        let binary = env.resolve(ProviderKind::Codex);
        Self {
            platform,
            env,
            binary,
        }
    }

    fn binary(&self) -> Result<&Path> {
        self.binary
            .as_deref()
            .ok_or(Error::NotInstalled(ProviderKind::Codex))
    }

    async fn version(&self) -> Option<String> {
        let spec = self.env.spec(self.binary().ok()?).arg("--version");
        let output = process::run(&self.platform, &spec, STATUS_TIMEOUT)
            .await
            .ok()?;
        parse_version(&output.stdout)
    }

    /// Spawns an app-server for `cwd` with the user's personal setup switched off, and
    /// initializes it.
    async fn app_server(
        &self,
        cwd: &Path,
        recorder: Option<Arc<Recorder>>,
    ) -> Result<(Arc<Rpc>, mpsc::Receiver<String>)> {
        let mut spec = self.env.spec(self.binary()?);
        let mut args: Vec<String> = vec!["app-server".into()];
        for feature in DISABLED_FEATURES {
            args.push("--disable".into());
            args.push((*feature).into());
        }
        args.push("-c".into());
        args.push("notify=[]".into());
        args.push("-c".into());
        args.push(format!(
            "projects.{}.trust_level=\"trusted\"",
            toml_string(&cwd.display().to_string())
        ));
        spec.args = args.into_iter().map(Into::into).collect();
        spec.cwd = Some(cwd.to_owned());
        let process::Spawned { process, stdout } =
            process::spawn(self.platform.clone(), &spec, recorder)?;
        Ok((Arc::new(Rpc::new(process)), stdout))
    }

    /// Runs `work` against a throwaway app-server, then shuts it down.
    async fn control<T>(&self, work: impl AsyncFnOnce(&Rpc) -> Result<T>) -> Result<T> {
        let cwd = self.platform.paths().data_dir.clone();
        let (rpc, stdout) = self.app_server(&cwd, None).await?;
        let reader = tokio::spawn(control_reader(rpc.clone(), stdout));
        let result = async {
            rpc.initialize().await?;
            work(&rpc).await
        }
        .await;
        rpc.process.shutdown(EXIT_GRACE).await;
        reader.abort();
        result
    }
}

/// Serves a control app-server's output: only responses matter.
async fn control_reader(rpc: Arc<Rpc>, mut stdout: mpsc::Receiver<String>) {
    let mut parser = Parser::live();
    while let Some(line) = stdout.recv().await {
        for output in parser.feed(&line) {
            match output {
                Output::Control(Control::Response { id, result }) => rpc.resolve(id, result),
                Output::Control(
                    Control::Approval { rpc_id, .. } | Control::Unsupported { rpc_id, .. },
                ) => {
                    rpc.reject(rpc_id, "not served by a control connection")
                        .await;
                }
                Output::Event(_) => {}
            }
        }
    }
    rpc.fail_all();
}

impl Provider for Codex {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn status(&self) -> BoxFuture<'_, ProviderStatus> {
        Box::pin(async move {
            let mut status = ProviderStatus {
                provider: ProviderKind::Codex,
                path: self.binary.as_ref().map(|path| path.display().to_string()),
                version: None,
                logged_in: false,
                auth_method: None,
                plan: None,
                guidance: None,
            };
            let Ok(binary) = self.binary() else {
                status.guidance = Some(
                    "Install Codex (https://developers.openai.com/codex) so `codex` is on your \
                     login shell's PATH, then refresh."
                        .into(),
                );
                return status;
            };
            status.version = self.version().await;
            let spec = self.env.spec(binary).arg("login").arg("status");
            match process::run(&self.platform, &spec, STATUS_TIMEOUT).await {
                Ok(output) => {
                    // `codex login status` prints to stderr on some versions.
                    let text = format!("{}\n{}", output.stdout, output.stderr);
                    let line = text
                        .lines()
                        .map(str::trim)
                        .find(|line| line.starts_with("Logged in"));
                    status.logged_in = output.code == Some(0) && line.is_some();
                    status.auth_method = line
                        .and_then(|line| line.split_once(" using "))
                        .map(|(_, method)| method.trim().to_owned());
                }
                Err(err) => status.guidance = Some(format!("Could not ask Codex: {err}")),
            }
            if !status.logged_in && status.guidance.is_none() {
                status.guidance =
                    Some("Log in to Codex: run `codex login` in a terminal, then refresh.".into());
            }
            status
        })
    }

    fn models(&self) -> BoxFuture<'_, Result<ModelCatalog>> {
        Box::pin(async move {
            let version = self.version().await;
            let models = self
                .control(async |rpc: &Rpc| {
                    let mut models = Vec::new();
                    let mut cursor = None;
                    loop {
                        let page: p::ModelListResponse = rpc
                            .call(
                                "model/list",
                                &p::ModelListParams {
                                    cursor: cursor.take(),
                                    ..Default::default()
                                },
                            )
                            .await?;
                        models.extend(page.data);
                        match page.next_cursor {
                            Some(next) if !next.is_empty() => cursor = Some(next),
                            _ => break Ok(models),
                        }
                    }
                })
                .await?;
            Ok(ModelCatalog {
                provider: ProviderKind::Codex,
                models: models
                    .into_iter()
                    .filter(|model| !model.hidden)
                    .map(model_info)
                    .collect(),
                cli_version: version,
                fetched_at_ms: now_ms(),
            })
        })
    }

    fn quota(&self) -> BoxFuture<'_, Result<QuotaSnapshot>> {
        Box::pin(async move {
            let limits: p::GetAccountRateLimitsResponse = self
                .control(async |rpc: &Rpc| rpc.call("account/rateLimits/read", &Value::Null).await)
                .await?;
            Ok(parse::quota_snapshot(&limits.rate_limits))
        })
    }

    fn start(&self, spec: SessionSpec, ledger: Arc<dyn Ledger>) -> BoxFuture<'_, Result<Started>> {
        Box::pin(async move {
            let cwd = spec.cwd.canonicalize().map_err(|err| {
                Error::Invalid(format!("working directory {}: {err}", spec.cwd.display()))
            })?;
            let version = self.version().await;
            let recorder = match &spec.record_to {
                Some(path) => Some(Arc::new(Recorder::create(
                    path,
                    &record::Header {
                        fixture: record::FORMAT,
                        provider: ProviderKind::Codex,
                        cli_version: version.clone(),
                        recorded_at_ms: now_ms(),
                        title: "Codex session".into(),
                    },
                )?)),
                None => None,
            };
            let (rpc, stdout) = self.app_server(&cwd, recorder).await?;
            ledger
                .record(Artifact::Process {
                    pid: rpc.process.pid(),
                    started_at_ms: rpc.process.started_at_ms(),
                })
                .await?;

            let (events_tx, events) = mpsc::channel(EVENTS);
            let shared = Arc::new(Shared {
                approvals: Mutex::new(HashMap::new()),
                turn_id: Mutex::new(None),
                events: events_tx,
            });
            tokio::spawn(read_loop(rpc.clone(), stdout, shared.clone()));

            let started = tokio::time::timeout(
                START_TIMEOUT,
                open_thread(&rpc, &spec, &cwd, ledger.as_ref()),
            )
            .await
            .map_err(|_| Error::Timeout("Codex to start the thread"))
            .and_then(|result| result);
            let (thread, model) = match started {
                Ok(started) => started,
                Err(err) => {
                    rpc.process.shutdown(EXIT_GRACE).await;
                    return Err(err);
                }
            };

            let session = Arc::new(CodexSession {
                thread_id: thread.id.clone(),
                rpc,
                shared,
                access: spec.access.clone(),
                effort: spec.effort.clone(),
            });
            session
                .emit(ProviderEvent::SessionStarted {
                    native_id: thread.id,
                    model: Some(model),
                    cwd: Some(thread.cwd.to_string()),
                    cli_version: Some(thread.cli_version.clone()),
                })
                .await;
            if thread.cli_version != p::SCHEMA_VERSION {
                session
                    .emit(ProviderEvent::Notice {
                        level: NoticeLevel::Warning,
                        message: format!(
                            "Codex {} is running; Brigadier's bindings were generated from {}. \
                             Unknown fields are ignored; regenerate them with gen-codex.",
                            thread.cli_version,
                            p::SCHEMA_VERSION
                        ),
                    })
                    .await;
            }
            Ok(Started { session, events })
        })
    }

    fn remove(&self, artifacts: Vec<Artifact>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut threads = Vec::new();
            let mut trusts = Vec::new();
            for artifact in artifacts {
                match artifact {
                    Artifact::CodexThread { thread_id } => threads.push(thread_id),
                    Artifact::CodexProjectTrust { path } => trusts.push(path),
                    _ => {}
                }
            }
            if threads.is_empty() && trusts.is_empty() {
                return Ok(());
            }
            self.control(async |rpc: &Rpc| {
                for path in trusts {
                    remove_project_trust(rpc, &path).await?;
                }
                for thread_id in threads {
                    let deleted: Result<Value> = rpc
                        .call(
                            "thread/delete",
                            &p::ThreadDeleteParams {
                                thread_id: thread_id.clone(),
                            },
                        )
                        .await;
                    match deleted {
                        Ok(_) => {}
                        // Already gone: never persisted (no turn ran), or deleted before.
                        Err(Error::Rejected(message))
                            if message.contains("not found")
                                || message.contains("no rollout found") => {}
                        Err(err) => return Err(err),
                    }
                }
                Ok(())
            })
            .await
        })
    }

    fn replayer(&self) -> Box<dyn Replayer> {
        Box::new(CodexReplayer {
            parser: Parser::replay(),
            asked: HashSet::new(),
        })
    }
}

/// Starts, resumes or forks the session's thread, recording it in the ledger.
async fn open_thread(
    rpc: &Rpc,
    spec: &SessionSpec,
    cwd: &Path,
    ledger: &dyn Ledger,
) -> Result<(p::Thread, String)> {
    rpc.initialize().await?;
    let config = thread_config(rpc, spec, cwd).await?;
    let trusted_before = trusted_projects(rpc, cwd).await?;
    let cwd_text = Some(cwd.display().to_string());
    let sandbox = Some(sandbox_mode(&spec.access));
    let approval = Some(approval_policy(&spec.access));
    let instructions = spec.append_system_prompt.clone();
    let (thread, model) = match &spec.origin {
        Origin::New => {
            let started: p::ThreadStartResponse = rpc
                .call(
                    "thread/start",
                    &p::ThreadStartParams {
                        cwd: cwd_text,
                        model: spec.model.clone(),
                        sandbox,
                        approval_policy: approval,
                        developer_instructions: instructions,
                        config: Some(config),
                        ..Default::default()
                    },
                )
                .await?;
            (started.thread, started.model)
        }
        Origin::Resume { native_id } => {
            let resumed: p::ThreadResumeResponse = rpc
                .call(
                    "thread/resume",
                    &p::ThreadResumeParams {
                        thread_id: native_id.clone(),
                        cwd: cwd_text,
                        model: spec.model.clone(),
                        sandbox,
                        approval_policy: approval,
                        developer_instructions: instructions,
                        config: Some(config),
                        exclude_turns: Some(true),
                        ..Default::default()
                    },
                )
                .await?;
            (resumed.thread, resumed.model)
        }
        Origin::Fork { native_id } => {
            let forked: p::ThreadForkResponse = rpc
                .call(
                    "thread/fork",
                    &p::ThreadForkParams {
                        thread_id: native_id.clone(),
                        cwd: cwd_text,
                        model: spec.model.clone(),
                        sandbox,
                        approval_policy: approval,
                        developer_instructions: instructions,
                        config: Some(config),
                        exclude_turns: Some(true),
                        ..Default::default()
                    },
                )
                .await?;
            (forked.thread, forked.model)
        }
    };
    ledger
        .record(Artifact::CodexThread {
            thread_id: thread.id.clone(),
        })
        .await?;
    for (path, _) in trusted_projects(rpc, cwd).await? {
        if !trusted_before.contains_key(&path) {
            ledger.record(Artifact::CodexProjectTrust { path }).await?;
        }
    }
    Ok((thread, model))
}

/// The `projects` table of the user's own `config.toml`, by project path.
async fn trusted_projects(rpc: &Rpc, cwd: &Path) -> Result<Map<String, Value>> {
    let read: Value = rpc
        .call(
            "config/read",
            &json!({ "includeLayers": true, "cwd": cwd.display().to_string() }),
        )
        .await?;
    let projects = read
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|layer| layer.pointer("/name/type").and_then(Value::as_str) == Some("user"))
        .and_then(|layer| layer.pointer("/config/projects"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(projects)
}

/// Removes a trust entry a thread added, unless it changed since (the user decided on it).
async fn remove_project_trust(rpc: &Rpc, path: &str) -> Result<()> {
    let projects = trusted_projects(rpc, Path::new(path)).await?;
    if projects.get(path) != Some(&json!({ "trust_level": "trusted" })) {
        return Ok(());
    }
    let _: Value = rpc
        .call(
            "config/value/write",
            &json!({
                "keyPath": format!("projects.{}", toml_string(path)),
                "value": null,
                "mergeStrategy": "replace",
            }),
        )
        .await?;
    Ok(())
}

/// Per-thread config: the user's MCP servers off, Brigadier's on, and the workspace sandbox
/// with network access.
async fn thread_config(rpc: &Rpc, spec: &SessionSpec, cwd: &Path) -> Result<Map<String, Value>> {
    let effective: Value = rpc
        .call(
            "config/read",
            &json!({ "includeLayers": false, "cwd": cwd.display().to_string() }),
        )
        .await?;
    let mut servers: Map<String, Value> = effective
        .pointer("/config/mcp_servers")
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .keys()
                .map(|name| (name.clone(), json!({ "enabled": false })))
                .collect()
        })
        .unwrap_or_default();
    servers.extend(spec.mcp_servers.clone());

    let mut config = Map::new();
    config.insert("mcp_servers".into(), Value::Object(servers));
    if let Access::Workspace { extra_roots } = &spec.access {
        config.insert(
            "sandbox_workspace_write".into(),
            json!({
                "network_access": true,
                "writable_roots": extra_roots
                    .iter()
                    .map(|root| root.display().to_string())
                    .collect::<Vec<_>>(),
            }),
        );
    }
    Ok(config)
}

fn approval_policy(access: &Access) -> p::AskForApproval {
    match access {
        Access::ReadOnly => p::AskForApproval::Untrusted,
        Access::Workspace { .. } | Access::Full => p::AskForApproval::OnRequest,
    }
}

fn sandbox_mode(access: &Access) -> p::SandboxMode {
    match access {
        Access::Workspace { .. } => p::SandboxMode::WorkspaceWrite,
        Access::ReadOnly => p::SandboxMode::ReadOnly,
        Access::Full => p::SandboxMode::DangerFullAccess,
    }
}

fn sandbox_policy(access: &Access) -> p::SandboxPolicy {
    match access {
        Access::Workspace { extra_roots } => p::SandboxPolicy::WorkspaceWrite {
            exclude_slash_tmp: false,
            exclude_tmpdir_env_var: false,
            network_access: true,
            writable_roots: extra_roots
                .iter()
                .map(|root| p::AbsolutePathBuf(root.display().to_string()))
                .collect(),
        },
        Access::ReadOnly => p::SandboxPolicy::ReadOnly {
            network_access: false,
        },
        Access::Full => p::SandboxPolicy::DangerFullAccess,
    }
}

fn model_info(model: p::Model) -> ModelInfo {
    ModelInfo {
        id: model.model,
        display_name: model.display_name,
        description: model.description,
        resolved: None,
        efforts: model
            .supported_reasoning_efforts
            .into_iter()
            .map(|option| String::from(option.reasoning_effort))
            .collect(),
        default_effort: Some(String::from(model.default_reasoning_effort)),
        is_default: model.is_default,
        input_modalities: model
            .input_modalities
            .iter()
            .filter_map(|modality| serde_json::to_value(modality).ok())
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect(),
    }
}

/// A TOML basic string, for `-c` override keys.
fn toml_string(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if c.is_control() => quoted.push_str(&format!("\\u{:04X}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

struct CodexReplayer {
    parser: Parser,
    /// Approval requests not answered yet.
    asked: HashSet<String>,
}

impl Replayer for CodexReplayer {
    fn feed(&mut self, dir: Direction, line: &str) -> Vec<ProviderEvent> {
        if dir == Direction::In {
            // The only thing Brigadier sends that the output does not show is an approval's
            // answer: a response to Codex's request.
            let sent: Value = serde_json::from_str(line).unwrap_or_default();
            let answered = format!("codex-{}", sent["id"]);
            let result = &sent["result"];
            if sent.get("method").is_some() || result.is_null() || !self.asked.remove(&answered) {
                return Vec::new();
            }
            let allowed = match result.get("decision") {
                Some(decision) => decision.as_str().is_some_and(|d| d.starts_with("accept")),
                None => result["permissions"]
                    .as_object()
                    .is_some_and(|permissions| !permissions.is_empty()),
            };
            let decision = if allowed {
                ApprovalDecision::Allow
            } else {
                ApprovalDecision::Deny {
                    message: String::new(),
                }
            };
            return vec![ProviderEvent::ApprovalResolved {
                id: answered,
                decision,
                decided_by: Decider::Recorded,
            }];
        }
        let events: Vec<ProviderEvent> = self
            .parser
            .feed(line)
            .into_iter()
            .filter_map(|output| match output {
                Output::Event(event) => Some(event),
                Output::Control(_) => None,
            })
            .collect();
        for event in &events {
            if let ProviderEvent::ApprovalRequested { request } = event {
                self.asked.insert(request.id.clone());
            }
        }
        events
    }
}

/// JSON-RPC over the app-server's stdio.
struct Rpc {
    process: Arc<CliProcess>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, String>>>>,
}

impl Rpc {
    fn new(process: Arc<CliProcess>) -> Self {
        Self {
            process,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    async fn initialize(&self) -> Result<()> {
        let _: Value = self
            .call(
                "initialize",
                &p::InitializeParams {
                    client_info: p::ClientInfo {
                        name: "brigadier".into(),
                        title: Some("Brigadier".into()),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    capabilities: None,
                },
            )
            .await?;
        self.notify("initialized").await
    }

    async fn call<P: Serialize, R: DeserializeOwned>(&self, method: &str, params: &P) -> Result<R> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id, tx);
        let mut message = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        let params =
            serde_json::to_value(params).map_err(|err| Error::Protocol(err.to_string()))?;
        if !params.is_null() {
            message["params"] = params;
        }
        if let Err(err) = self.process.write_line(&message.to_string()).await {
            lock(&self.pending).remove(&id);
            return Err(err);
        }
        let result = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result.map_err(Error::Rejected)?,
            Ok(Err(_)) => return Err(Error::Protocol(exit_message(&self.process))),
            Err(_) => {
                lock(&self.pending).remove(&id);
                return Err(Error::Timeout("Codex to answer"));
            }
        };
        serde_json::from_value(result)
            .map_err(|err| Error::Protocol(format!("unexpected {method} response: {err}")))
    }

    async fn notify(&self, method: &str) -> Result<()> {
        self.process
            .write_line(&json!({ "jsonrpc": "2.0", "method": method }).to_string())
            .await
    }

    async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.process
            .write_line(&json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
            .await
    }

    async fn reject(&self, id: Value, message: &str) {
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": message },
        });
        let _ = self.process.write_line(&line.to_string()).await;
    }

    fn resolve(&self, id: i64, result: std::result::Result<Value, String>) {
        if let Some(reply) = lock(&self.pending).remove(&id) {
            let _ = reply.send(result);
        }
    }

    /// Fails every waiting call (the process is gone).
    fn fail_all(&self) {
        lock(&self.pending).clear();
    }
}

struct Shared {
    /// Unanswered approvals: approval id → JSON-RPC request id and answer shape.
    approvals: Mutex<HashMap<String, (Value, PendingKind)>>,
    turn_id: Mutex<Option<String>>,
    events: mpsc::Sender<ProviderEvent>,
}

pub struct CodexSession {
    thread_id: String,
    rpc: Arc<Rpc>,
    shared: Arc<Shared>,
    access: Access,
    effort: Option<String>,
}

impl CodexSession {
    async fn emit(&self, event: ProviderEvent) {
        let _ = self.shared.events.send(event).await;
    }

    fn turn_id(&self) -> Option<String> {
        lock(&self.shared.turn_id).clone()
    }

    fn input(input: &TurnInput) -> Result<Vec<p::UserInput>> {
        if input.is_empty() {
            return Err(Error::Invalid("the message is empty".into()));
        }
        let mut items: Vec<p::UserInput> = input
            .files
            .iter()
            .filter(|file| file.is_image())
            .map(|file| p::UserInput::LocalImageUserInput {
                detail: None,
                path: file.path.display().to_string(),
                type_: p::LocalImageUserInputType::LocalImage,
            })
            .collect();
        let text = input.text_with_file_notes();
        if !text.trim().is_empty() {
            items.push(p::UserInput::TextUserInput {
                text,
                text_elements: Vec::new(),
                type_: p::TextUserInputType::Text,
            });
        }
        Ok(items)
    }

    async fn start_turn(&self, input: &TurnInput) -> Result<()> {
        let effort = match &self.effort {
            Some(effort) => Some(
                p::ReasoningEffort::try_from(effort.as_str())
                    .map_err(|err| Error::Invalid(format!("effort {effort}: {err}")))?,
            ),
            None => None,
        };
        let started: p::TurnStartResponse = self
            .rpc
            .call(
                "turn/start",
                &p::TurnStartParams {
                    thread_id: self.thread_id.clone(),
                    input: Self::input(input)?,
                    effort,
                    sandbox_policy: Some(sandbox_policy(&self.access)),
                    approval_policy: Some(approval_policy(&self.access)),
                    ..Default::default()
                },
            )
            .await?;
        tracing::debug!(turn = %started.turn.id, "codex turn started");
        Ok(())
    }

    async fn steer_turn(&self, turn_id: String, input: &TurnInput) -> Result<()> {
        let _: p::TurnSteerResponse = self
            .rpc
            .call(
                "turn/steer",
                &p::TurnSteerParams {
                    thread_id: self.thread_id.clone(),
                    expected_turn_id: turn_id,
                    input: Self::input(input)?,
                    ..Default::default()
                },
            )
            .await?;
        Ok(())
    }
}

impl ProviderSession for CodexSession {
    fn native_id(&self) -> String {
        self.thread_id.clone()
    }

    fn send(&self, input: TurnInput) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            match self.turn_id() {
                // A message sent during a turn goes into it, as with Claude.
                Some(turn_id) => self.steer_turn(turn_id, &input).await,
                None => self.start_turn(&input).await,
            }
        })
    }

    fn steer(&self, input: TurnInput) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let Some(turn_id) = self.turn_id() else {
                // The turn already ended: the message starts the next one.
                return self.start_turn(&input).await;
            };
            match self.steer_turn(turn_id, &input).await {
                Err(Error::Rejected(_)) if self.turn_id().is_none() => {
                    self.start_turn(&input).await
                }
                other => other,
            }
        })
    }

    fn interrupt(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let Some(turn_id) = self.turn_id() else {
                return Ok(());
            };
            let _: Value = self
                .rpc
                .call(
                    "turn/interrupt",
                    &p::TurnInterruptParams {
                        thread_id: self.thread_id.clone(),
                        turn_id,
                    },
                )
                .await?;
            Ok(())
        })
    }

    fn answer(&self, approval_id: String, decision: ApprovalDecision) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let (rpc_id, kind) = lock(&self.shared.approvals)
                .remove(&approval_id)
                .ok_or_else(|| Error::Invalid(format!("no pending approval {approval_id}")))?;
            let allow = decision == ApprovalDecision::Allow;
            let result = match kind {
                PendingKind::Command | PendingKind::FileChange => {
                    json!({ "decision": if allow { "accept" } else { "decline" } })
                }
                PendingKind::Permissions(requested) => json!({
                    "permissions": if allow { requested } else { json!({}) },
                    "scope": "turn",
                }),
            };
            self.rpc.respond(rpc_id, result).await
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.rpc.process.shutdown(EXIT_GRACE).await;
        })
    }

    fn is_running(&self) -> bool {
        self.rpc.process.is_running()
    }
}

async fn read_loop(rpc: Arc<Rpc>, mut stdout: mpsc::Receiver<String>, shared: Arc<Shared>) {
    let mut parser = Parser::live();
    while let Some(line) = stdout.recv().await {
        for output in parser.feed(&line) {
            match output {
                Output::Event(event) => {
                    let _ = shared.events.send(event).await;
                }
                Output::Control(Control::Response { id, result }) => rpc.resolve(id, result),
                Output::Control(Control::Approval {
                    approval_id,
                    rpc_id,
                    kind,
                }) => {
                    lock(&shared.approvals).insert(approval_id, (rpc_id, kind));
                }
                Output::Control(Control::Unsupported { rpc_id, method }) => {
                    rpc.reject(rpc_id, &format!("Brigadier does not handle {method}"))
                        .await;
                }
            }
        }
        *lock(&shared.turn_id) = parser.turn_id().map(str::to_owned);
    }

    let exit = rpc.process.exited().await;
    rpc.fail_all();
    lock(&shared.turn_id).take();
    let _ = shared
        .events
        .send(ProviderEvent::Exited {
            code: exit.code,
            stderr_tail: (exit.code != Some(0))
                .then(|| rpc.process.stderr_tail())
                .flatten(),
        })
        .await;
}

fn exit_message(process: &CliProcess) -> String {
    match process.stderr_tail() {
        Some(tail) => format!("Codex exited: {tail}"),
        None => "Codex exited".into(),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
