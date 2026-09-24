//! Claude Code adapter.
//!
//! Brigadier runs the user's own, unmodified `claude` binary in print mode with stream-json on
//! both sides, one persistent process per session. It never uses the Agent SDK and never reads
//! or handles OAuth tokens: the CLI keeps its own login. Everything else goes over stdio:
//!
//! - turns and steering are user messages (Claude folds a message sent mid-turn into the
//!   running turn);
//! - `initialize`, `get_usage` and `interrupt` are control requests;
//! - permission prompts arrive as `can_use_tool` control requests (`--permission-prompt-tool
//!   stdio`) and Brigadier answers them.
//!
//! Sessions load only the project's settings plus Brigadier's own (`--setting-sources
//! project`, `--settings`), so the user's personal hooks, plugins and allow rules never apply,
//! and only Brigadier's MCP servers (`--strict-mcp-config`).

mod files;
pub mod parse;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use brigadier_sandbox::Platform;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::cli::{CliEnv, parse_version};
use crate::model::*;
use crate::process::{self, CliProcess};
use crate::record::{self, Recorder};
use crate::{
    BoxFuture, Error, Ledger, Provider, ProviderSession, Replayer, Result, Started, now_ms, policy,
};
use parse::{Control, Output, Parser};

const EVENTS: usize = 512;
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
/// `initialize` loads the CLI, its settings and MCP servers.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_GRACE: Duration = Duration::from_secs(3);

pub struct Claude {
    platform: Arc<dyn Platform>,
    env: Arc<CliEnv>,
    binary: Option<PathBuf>,
}

impl Claude {
    pub fn new(platform: Arc<dyn Platform>, env: Arc<CliEnv>) -> Self {
        let binary = env.resolve(ProviderKind::Claude);
        Self {
            platform,
            env,
            binary,
        }
    }

    fn binary(&self) -> Result<&Path> {
        self.binary
            .as_deref()
            .ok_or(Error::NotInstalled(ProviderKind::Claude))
    }

    /// Claude's configuration directory, where it keeps transcripts and session state.
    fn config_dir(&self) -> Option<PathBuf> {
        match self.env.var("CLAUDE_CONFIG_DIR") {
            Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
            _ => self.env.home().map(|home| home.join(".claude")),
        }
    }

    async fn version(&self) -> Option<String> {
        let spec = self.env.spec(self.binary().ok()?).arg("--version");
        let output = process::run(&self.platform, &spec, STATUS_TIMEOUT)
            .await
            .ok()?;
        parse_version(&output.stdout)
    }

    /// Runs a throwaway process that answers control requests, then exits. It loads no
    /// settings, no MCP servers and writes no session.
    async fn control(&self, requests: Vec<Map<String, Value>>) -> Result<Vec<Value>> {
        let mut spec = self.env.spec(self.binary()?);
        spec.args = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--setting-sources",
            "",
            "--settings",
            r#"{"autoMemoryEnabled":false}"#,
        ]
        .map(Into::into)
        .to_vec();
        spec.cwd = Some(self.platform.paths().data_dir.clone());
        let process::Spawned {
            process,
            mut stdout,
        } = process::spawn(self.platform.clone(), &spec, None)?;

        let result = async {
            let mut answers = Vec::with_capacity(requests.len());
            for (index, request) in requests.into_iter().enumerate() {
                let id = format!("control-{index}");
                process
                    .write_line(&parse::control_request(&id, request))
                    .await?;
                let answer = tokio::time::timeout(CONTROL_TIMEOUT, async {
                    let mut parser = Parser::live();
                    while let Some(line) = stdout.recv().await {
                        for output in parser.feed(&line) {
                            if let Output::Control(Control::Response { request_id, result }) =
                                output
                                && request_id == id
                            {
                                return result.map_err(Error::Rejected);
                            }
                        }
                    }
                    Err(Error::Protocol(process_failure(&process)))
                })
                .await
                .map_err(|_| Error::Timeout("Claude to answer"))??;
                answers.push(answer);
            }
            Ok(answers)
        }
        .await;
        process.shutdown(EXIT_GRACE).await;
        result
    }

    fn session_args(&self, spec: &SessionSpec, native_id: &str) -> Result<Vec<String>> {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--replay-user-messages",
            "--permission-prompt-tool",
            "stdio",
            "--strict-mcp-config",
            "--setting-sources",
            "project",
        ]
        .map(str::to_owned)
        .to_vec();
        args.push("--mcp-config".into());
        args.push(json!({ "mcpServers": spec.mcp_servers }).to_string());
        args.push("--settings".into());
        args.push(settings(&spec.access).to_string());
        args.push("--permission-mode".into());
        args.push(
            match spec.access {
                Access::ReadOnly => "default",
                Access::Workspace { .. } | Access::Full => "acceptEdits",
            }
            .into(),
        );
        if let Access::Workspace { extra_roots } = &spec.access {
            for root in extra_roots {
                args.push("--add-dir".into());
                args.push(root.display().to_string());
            }
        }
        if let Some(model) = &spec.model {
            args.push("--model".into());
            args.push(model.clone());
        }
        if let Some(effort) = &spec.effort {
            args.push("--effort".into());
            args.push(effort.clone());
        }
        if let Some(prompt) = &spec.append_system_prompt {
            args.push("--append-system-prompt".into());
            args.push(prompt.clone());
        }
        match &spec.origin {
            Origin::New => {
                args.push("--session-id".into());
                args.push(native_id.into());
            }
            Origin::Resume { native_id: resumed } => {
                files::check_session_id(resumed)?;
                args.push("--resume".into());
                args.push(resumed.clone());
            }
            Origin::Fork { native_id: parent } => {
                files::check_session_id(parent)?;
                args.push("--resume".into());
                args.push(parent.clone());
                args.push("--fork-session".into());
                args.push("--session-id".into());
                args.push(native_id.into());
            }
        }
        Ok(args)
    }
}

/// Brigadier's settings layer for a session, passed with `--settings` (above project settings).
fn settings(access: &Access) -> Value {
    let mut ask = policy::claude_ask_rules();
    // Leaving the sandbox always goes through the permission prompt, even if a project rule
    // would allow the command.
    ask.push("Bash(dangerouslyDisableSandbox:true)".into());
    let mut permissions = json!({
        "ask": ask,
        "disableBypassPermissionsMode": "disable",
    });
    let sandbox = match access {
        Access::Workspace { extra_roots } => json!({
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": true,
            "allowUnsandboxedCommands": true,
            "network": { "allowedDomains": ["*"] },
            "filesystem": {
                "allowWrite": extra_roots
                    .iter()
                    .map(|root| root.display().to_string())
                    .collect::<Vec<_>>(),
            },
        }),
        Access::ReadOnly => json!({
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": false,
            "allowUnsandboxedCommands": false,
        }),
        Access::Full => {
            permissions["allow"] = json!(["Bash", "WebFetch"]);
            json!({ "enabled": false })
        }
    };
    json!({
        // The Project Brain is Brigadier's memory; workers do not write Claude's.
        "autoMemoryEnabled": false,
        "permissions": permissions,
        "sandbox": sandbox,
    })
}

impl Provider for Claude {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Claude
    }

    fn status(&self) -> BoxFuture<'_, ProviderStatus> {
        Box::pin(async move {
            let mut status = ProviderStatus {
                provider: ProviderKind::Claude,
                path: self.binary.as_ref().map(|path| path.display().to_string()),
                version: None,
                logged_in: false,
                auth_method: None,
                plan: None,
                guidance: None,
            };
            let Ok(binary) = self.binary() else {
                status.guidance = Some(
                    "Install Claude Code (https://code.claude.com) so `claude` is on your login \
                     shell's PATH, then refresh."
                        .into(),
                );
                return status;
            };
            status.version = self.version().await;
            let spec = self
                .env
                .spec(binary)
                .arg("auth")
                .arg("status")
                .arg("--json");
            match process::run(&self.platform, &spec, STATUS_TIMEOUT).await {
                Ok(output) => match serde_json::from_str::<Value>(output.stdout.trim()) {
                    Ok(auth) => {
                        status.logged_in =
                            auth.get("loggedIn").and_then(Value::as_bool) == Some(true);
                        status.auth_method = auth
                            .get("authMethod")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        status.plan = auth
                            .get("subscriptionType")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                    }
                    Err(_) => {
                        status.guidance = Some(format!(
                            "`claude auth status --json` gave no status: {}",
                            output.stderr.trim()
                        ));
                    }
                },
                Err(err) => status.guidance = Some(format!("Could not ask Claude Code: {err}")),
            }
            if !status.logged_in && status.guidance.is_none() {
                status.guidance = Some(
                    "Log in to Claude: run `claude auth login` in a terminal (or start `claude` \
                     and use /login), then refresh."
                        .into(),
                );
            }
            status
        })
    }

    fn models(&self) -> BoxFuture<'_, Result<ModelCatalog>> {
        Box::pin(async move {
            let version = self.version().await;
            let mut initialize = Map::new();
            initialize.insert("subtype".into(), "initialize".into());
            let answers = self.control(vec![initialize]).await?;
            let models = answers
                .first()
                .and_then(|answer| answer.get("models"))
                .and_then(Value::as_array)
                .ok_or_else(|| Error::Protocol("initialize returned no models".into()))?;
            Ok(ModelCatalog {
                provider: ProviderKind::Claude,
                models: models.iter().filter_map(model_info).collect(),
                cli_version: version,
                fetched_at_ms: now_ms(),
            })
        })
    }

    fn quota(&self) -> BoxFuture<'_, Result<QuotaSnapshot>> {
        Box::pin(async move {
            let mut usage = Map::new();
            usage.insert("subtype".into(), "get_usage".into());
            usage.insert("skip_behaviors".into(), true.into());
            let answers = self.control(vec![usage]).await?;
            let answer = answers.first().cloned().unwrap_or(Value::Null);
            let limits = answer
                .get("rate_limits")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut windows: Vec<QuotaWindow> = limits
                .iter()
                .filter(|(_, window)| window.get("utilization").is_some_and(|u| !u.is_null()))
                .map(|(id, window)| QuotaWindow {
                    id: id.clone(),
                    label: parse::window_label(id),
                    used_percent: window
                        .get("utilization")
                        .and_then(Value::as_f64)
                        .unwrap_or_default(),
                    resets_at_ms: window
                        .get("resets_at")
                        .and_then(Value::as_str)
                        .and_then(crate::time::parse_rfc3339_ms),
                    window_minutes: parse::window_minutes(id),
                })
                .collect();
            windows.sort_by_key(|window| window.window_minutes.unwrap_or(i64::MAX));
            let limit = windows
                .iter()
                .find(|window| window.used_percent >= 100.0)
                .map(|window| LimitHit {
                    window: Some(window.id.clone()),
                    resets_at_ms: window.resets_at_ms,
                });
            Ok(QuotaSnapshot {
                provider: ProviderKind::Claude,
                windows,
                limit,
                observed_at_ms: now_ms(),
            })
        })
    }

    fn start(&self, spec: SessionSpec, ledger: Arc<dyn Ledger>) -> BoxFuture<'_, Result<Started>> {
        Box::pin(async move {
            let binary = self.binary()?.to_owned();
            let cwd = spec.cwd.canonicalize().map_err(|err| {
                Error::Invalid(format!("working directory {}: {err}", spec.cwd.display()))
            })?;
            let native_id = match &spec.origin {
                Origin::Resume { native_id } => native_id.clone(),
                Origin::New | Origin::Fork { .. } => uuid::Uuid::new_v4().to_string(),
            };
            let args = self.session_args(&spec, &native_id)?;

            // Recorded before the CLI can create them.
            if let Some(config) = self.config_dir() {
                let project = files::project_dir(&config, &cwd);
                if !project.exists() {
                    ledger
                        .record(Artifact::ClaudeProjectDir {
                            path: project.display().to_string(),
                        })
                        .await?;
                }
            }
            ledger
                .record(Artifact::ClaudeSession {
                    session_id: native_id.clone(),
                })
                .await?;

            let recorder = match &spec.record_to {
                Some(path) => Some(Arc::new(Recorder::create(
                    path,
                    &record::Header {
                        fixture: record::FORMAT,
                        provider: ProviderKind::Claude,
                        cli_version: self.version().await,
                        recorded_at_ms: now_ms(),
                        title: "Claude session".into(),
                    },
                )?)),
                None => None,
            };
            let mut process_spec = self.env.spec(&binary);
            process_spec.args = args.into_iter().map(Into::into).collect();
            process_spec.cwd = Some(cwd.clone());
            let process::Spawned { process, stdout } =
                process::spawn(self.platform.clone(), &process_spec, recorder)?;
            ledger
                .record(Artifact::Process {
                    pid: process.pid(),
                    started_at_ms: process.started_at_ms(),
                })
                .await?;

            let (events_tx, events) = mpsc::channel(EVENTS);
            let shared = Arc::new(Shared {
                pending: Mutex::new(HashMap::new()),
                approvals: Mutex::new(HashMap::new()),
                events: events_tx,
                turn_active: AtomicBool::new(false),
                next_request: AtomicU64::new(1),
            });
            let (parser_tx, parser_rx) = mpsc::unbounded_channel();
            tokio::spawn(read_loop(
                process.clone(),
                stdout,
                shared.clone(),
                parser_rx,
            ));
            let session = Arc::new(ClaudeSession {
                native_id: native_id.clone(),
                process,
                shared,
                parser: parser_tx,
            });

            let mut initialize = Map::new();
            initialize.insert("subtype".into(), "initialize".into());
            let answer = match session.request(initialize, INITIALIZE_TIMEOUT).await {
                Ok(answer) => answer,
                Err(err) => {
                    session.close().await;
                    return Err(err);
                }
            };
            let model = spec.model.clone().or_else(|| {
                answer
                    .get("models")
                    .and_then(Value::as_array)
                    .and_then(|models| models.first())
                    .and_then(|model| model.get("value"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            session
                .emit(ProviderEvent::SessionStarted {
                    native_id,
                    model,
                    cwd: Some(cwd.display().to_string()),
                    cli_version: self.version().await,
                })
                .await;
            Ok(Started { session, events })
        })
    }

    fn remove(&self, artifacts: Vec<Artifact>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let Some(config) = self.config_dir() else {
                return Ok(());
            };
            tokio::task::spawn_blocking(move || files::remove(&config, &artifacts))
                .await
                .map_err(|err| Error::Io(std::io::Error::other(err)))?
        })
    }

    fn replayer(&self) -> Box<dyn Replayer> {
        Box::new(ClaudeReplayer(Parser::replay()))
    }
}

fn model_info(model: &Value) -> Option<ModelInfo> {
    let id = model.get("value")?.as_str()?.to_owned();
    let text = |key: &str| {
        model
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Some(ModelInfo {
        is_default: id == "default",
        display_name: text("displayName"),
        description: text("description"),
        resolved: model
            .get("resolvedModel")
            .and_then(Value::as_str)
            .map(str::to_owned),
        efforts: model
            .get("supportedEffortLevels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        default_effort: None,
        input_modalities: vec!["text".into(), "image".into()],
        id,
    })
}

struct ClaudeReplayer(Parser);

impl Replayer for ClaudeReplayer {
    fn feed(&mut self, line: &str) -> Vec<ProviderEvent> {
        self.0
            .feed(line)
            .into_iter()
            .filter_map(|output| match output {
                Output::Event(event) => Some(event),
                Output::Control(_) => None,
            })
            .collect()
    }
}

/// State shared by the session handle and its reader.
struct Shared {
    pending: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// Tool inputs of unanswered permission requests, by request id.
    approvals: Mutex<HashMap<String, Value>>,
    events: mpsc::Sender<ProviderEvent>,
    turn_active: AtomicBool,
    next_request: AtomicU64,
}

enum ParserCommand {
    Interrupting,
}

pub struct ClaudeSession {
    native_id: String,
    process: Arc<CliProcess>,
    shared: Arc<Shared>,
    parser: mpsc::UnboundedSender<ParserCommand>,
}

impl ClaudeSession {
    async fn emit(&self, event: ProviderEvent) {
        let _ = self.shared.events.send(event).await;
    }

    async fn request(&self, mut request: Map<String, Value>, timeout: Duration) -> Result<Value> {
        let id = format!(
            "brigadier-{}",
            self.shared.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        lock(&self.shared.pending).insert(id.clone(), tx);
        let subtype = request
            .remove("subtype")
            .unwrap_or_else(|| Value::String(String::new()));
        let mut body = Map::new();
        body.insert("subtype".into(), subtype);
        body.extend(request);
        if let Err(err) = self
            .process
            .write_line(&parse::control_request(&id, body))
            .await
        {
            lock(&self.shared.pending).remove(&id);
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result.map_err(Error::Rejected),
            Ok(Err(_)) => Err(Error::Protocol(process_failure(&self.process))),
            Err(_) => {
                lock(&self.shared.pending).remove(&id);
                Err(Error::Timeout("Claude to answer"))
            }
        }
    }

    async fn write_message(&self, text: String) -> Result<()> {
        if text.trim().is_empty() {
            return Err(Error::Invalid("the message is empty".into()));
        }
        self.process.write_line(&parse::user_message(&text)).await
    }
}

impl ProviderSession for ClaudeSession {
    fn native_id(&self) -> String {
        self.native_id.clone()
    }

    fn send(&self, text: String) -> BoxFuture<'_, Result<()>> {
        // A message sent during a turn is folded into it, exactly like a steer.
        Box::pin(self.write_message(text))
    }

    fn steer(&self, text: String) -> BoxFuture<'_, Result<()>> {
        // Claude takes a message sent mid-turn at its next step; when the turn already ended,
        // the message starts the next one.
        Box::pin(self.write_message(text))
    }

    fn interrupt(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if !self.shared.turn_active.load(Ordering::Acquire) {
                return Ok(());
            }
            let _ = self.parser.send(ParserCommand::Interrupting);
            let mut request = Map::new();
            request.insert("subtype".into(), "interrupt".into());
            self.request(request, CONTROL_TIMEOUT).await.map(drop)
        })
    }

    fn answer(&self, approval_id: String, decision: ApprovalDecision) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let input = lock(&self.shared.approvals)
                .remove(&approval_id)
                .ok_or_else(|| Error::Invalid(format!("no pending approval {approval_id}")))?;
            let response = match &decision {
                ApprovalDecision::Allow => json!({ "behavior": "allow", "updatedInput": input }),
                ApprovalDecision::Deny { message } => {
                    json!({ "behavior": "deny", "message": message })
                }
            };
            let line = json!({
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": approval_id,
                    "response": response,
                },
            });
            self.process.write_line(&line.to_string()).await
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            self.process.shutdown(EXIT_GRACE).await;
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }
}

/// Reads Claude's output until it exits: forwards events, pairs control responses, keeps
/// permission requests until they are answered.
async fn read_loop(
    process: Arc<CliProcess>,
    mut stdout: mpsc::Receiver<String>,
    shared: Arc<Shared>,
    mut commands: mpsc::UnboundedReceiver<ParserCommand>,
) {
    let mut parser = Parser::live();
    while let Some(line) = stdout.recv().await {
        while let Ok(command) = commands.try_recv() {
            match command {
                ParserCommand::Interrupting => parser.interrupt_requested(),
            }
        }
        for output in parser.feed(&line) {
            match output {
                Output::Event(event) => {
                    if shared.events.send(event).await.is_err() {
                        // Nobody listens any more; keep draining so the CLI never blocks.
                    }
                }
                Output::Control(Control::Response { request_id, result }) => {
                    if let Some(reply) = lock(&shared.pending).remove(&request_id) {
                        let _ = reply.send(result);
                    }
                }
                Output::Control(Control::Approval { request_id, input }) => {
                    lock(&shared.approvals).insert(request_id, input);
                }
                Output::Control(Control::Cancelled { request_id }) => {
                    if lock(&shared.approvals).remove(&request_id).is_some() {
                        let _ = shared
                            .events
                            .send(ProviderEvent::ApprovalResolved {
                                id: request_id,
                                decision: ApprovalDecision::Deny {
                                    message: "withdrawn by Claude".into(),
                                },
                                decided_by: Decider::Policy,
                            })
                            .await;
                    }
                }
                Output::Control(Control::Unsupported {
                    request_id,
                    subtype,
                }) => {
                    let line = json!({
                        "type": "control_response",
                        "response": {
                            "subtype": "error",
                            "request_id": request_id,
                            "error": format!("Brigadier does not handle {subtype}"),
                        },
                    });
                    let _ = process.write_line(&line.to_string()).await;
                }
            }
        }
        shared
            .turn_active
            .store(parser.turn_active(), Ordering::Release);
    }

    let exit = process.exited().await;
    lock(&shared.pending).clear();
    shared.turn_active.store(false, Ordering::Release);
    let _ = shared
        .events
        .send(ProviderEvent::Exited {
            code: exit.code,
            stderr_tail: (exit.code != Some(0))
                .then(|| process.stderr_tail())
                .flatten(),
        })
        .await;
}

fn process_failure(process: &CliProcess) -> String {
    match process.stderr_tail() {
        Some(tail) => format!("Claude exited: {tail}"),
        None => "Claude exited".into(),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}
