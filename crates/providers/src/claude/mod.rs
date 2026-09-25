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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use brigadier_sandbox::Platform;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::cli::{CliEnv, parse_version};
use crate::events::Events;
use crate::model::*;
use crate::process::{self, CliProcess};
use crate::record::{self, Direction, Recorder};
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
        } = process::spawn(self.platform.clone(), &spec, process::Options::default())?;

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

    fn session_args(&self, spec: &SessionSpec, cwd: &Path, native_id: &str) -> Result<Vec<String>> {
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
            // Thinking otherwise streams empty; its summaries are the reasoning Brigadier
            // shows. (The `showThinkingSummaries` setting is not read in print mode.)
            "--thinking-display",
            "summarized",
        ]
        .map(str::to_owned)
        .to_vec();
        args.push("--mcp-config".into());
        args.push(mcp_config(&spec.mcp_servers).to_string());
        match spec.tools {
            ToolSet::Default => {}
            ToolSet::None => {
                args.push("--tools".into());
                args.push(String::new());
            }
            ToolSet::Web => {
                args.push("--tools".into());
                args.push("WebSearch,WebFetch".into());
            }
        }
        args.push("--settings".into());
        args.push(settings(spec, cwd).to_string());
        args.push("--permission-mode".into());
        args.push(
            match spec.access {
                Access::ReadOnly
                | Access::Scoped {
                    write_cwd: false, ..
                } => "default",
                Access::Workspace { .. } | Access::Full | Access::Scoped { .. } => "acceptEdits",
            }
            .into(),
        );
        for root in spec.access.writable_roots() {
            args.push("--add-dir".into());
            args.push(root.display().to_string());
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

/// Claude's `--mcp-config` for the session's servers.
///
/// The config is on Claude's command line, which any process of the user can read, so a
/// server's environment values (such as a grant) are not in it: they are in Claude's own
/// environment, and the config names them (`${NAME}`, expanded by Claude).
fn mcp_config(servers: &[McpServer]) -> Value {
    let servers: Map<String, Value> = servers
        .iter()
        .map(|server| {
            let env: Map<String, Value> = server
                .env
                .iter()
                .map(|(name, _)| (name.clone(), Value::String(format!("${{{name}}}"))))
                .collect();
            (server.name.clone(), {
                let mut config = json!({
                    "type": "stdio",
                    "command": server.command.display().to_string(),
                    "args": server.args,
                    "env": env,
                });
                if let Some(secs) = server.tool_timeout_secs {
                    config["timeout"] = json!(secs * 1000);
                }
                config
            })
        })
        .collect();
    json!({ "mcpServers": servers })
}

/// A permission rule path for an absolute path (`//abs/path/**`).
fn rule_path(path: &Path) -> String {
    format!("/{}/**", path.display())
}

/// Brigadier's settings layer for a session, passed with `--settings` (above project settings).
fn settings(spec: &SessionSpec, cwd: &Path) -> Value {
    let mut ask = policy::claude_ask_rules();
    // Leaving the sandbox always goes through the permission prompt, even if a project rule
    // would allow the command.
    ask.push("Bash(dangerouslyDisableSandbox:true)".into());
    let mut allow: Vec<String> = spec
        .mcp_servers
        .iter()
        .filter(|server| server.trusted)
        .map(|server| format!("mcp__{}", server.name))
        .collect();
    let mut deny: Vec<String> = Vec::new();
    let sandbox = match &spec.access {
        Access::Workspace { extra_roots } => json!({
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": true,
            "allowUnsandboxedCommands": true,
            "network": { "allowedDomains": ["*"] },
            "filesystem": {
                "allowWrite": paths(extra_roots),
            },
        }),
        Access::Scoped {
            write_cwd,
            writable_roots,
            network,
            deny_read,
            unix_sockets,
        } => {
            if !write_cwd {
                for tool in ["Edit", "Write", "NotebookEdit"] {
                    deny.push(format!("{tool}({})", rule_path(cwd)));
                }
            }
            for path in deny_read {
                // Permission rules match the path as the tool was given it: deny both spellings.
                deny.push(format!("Read({})", rule_path(path)));
                let real = resolved(path);
                if real != *path {
                    deny.push(format!("Read({})", rule_path(&real)));
                }
            }
            let mut filesystem = json!({
                "allowWrite": paths(writable_roots),
                "denyRead": paths(deny_read),
            });
            if !write_cwd {
                filesystem["denyWrite"] = json!(paths(&[cwd.to_owned()]));
            }
            json!({
                "enabled": true,
                "failIfUnavailable": true,
                "autoAllowBashIfSandboxed": true,
                "allowUnsandboxedCommands": true,
                "network": {
                    "allowedDomains": if *network { json!(["*"]) } else { json!([]) },
                    "allowUnixSockets": paths(unix_sockets),
                },
                "filesystem": filesystem,
            })
        }
        Access::ReadOnly => json!({
            "enabled": true,
            "failIfUnavailable": true,
            "autoAllowBashIfSandboxed": false,
            "allowUnsandboxedCommands": false,
        }),
        Access::Full => {
            allow.extend(["Bash".to_owned(), "WebFetch".to_owned()]);
            json!({ "enabled": false })
        }
    };
    if spec.tools == ToolSet::Web {
        allow.extend(["WebSearch".to_owned(), "WebFetch".to_owned()]);
    }
    let mut permissions = json!({
        "ask": ask,
        "disableBypassPermissionsMode": "disable",
    });
    if !allow.is_empty() {
        permissions["allow"] = json!(allow);
    }
    if !deny.is_empty() {
        permissions["deny"] = json!(deny);
    }
    json!({
        // The Project Brain is Brigadier's memory; workers do not write Claude's.
        "autoMemoryEnabled": false,
        "permissions": permissions,
        "sandbox": sandbox,
        // A repository's `AGENTS.md` files load next to its `CLAUDE.md` files (by default
        // Claude reads them only where there is no `CLAUDE.md`), nested ones included once
        // Claude reads a file in their directory.
        "pluginConfigs": {
            "agents-md@builtin": {
                "options": { "instructionFiles": "claude-md-and-agents-md" },
            },
        },
    })
}

/// Sandbox paths as Seatbelt matches them: resolved through symlinks (`/tmp` and
/// `/var/folders` are `/private/…` on macOS). A unix-socket rule on the unresolved path never
/// matches, so the connection is refused.
fn paths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| resolved(path).display().to_string())
        .collect()
}

fn resolved(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_owned())
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
            let args = self.session_args(&spec, &cwd, &native_id)?;

            // Recorded before the CLI can create them.
            if let Some(config) = self.config_dir() {
                let project = files::project_dir(&config, &cwd);
                let artifact = Artifact::ClaudeProjectDir {
                    path: project.display().to_string(),
                };
                if !project.exists() || ledger.holds(&artifact) {
                    ledger.record(artifact).await?;
                }
            }
            ledger
                .record(Artifact::ClaudeSession {
                    session_id: native_id.clone(),
                })
                .await?;
            for path in files::staging_dirs(&cwd) {
                let artifact = Artifact::ClaudeStagingDir {
                    path: path.display().to_string(),
                };
                if !path.exists() || ledger.holds(&artifact) {
                    ledger.record(artifact).await?;
                    // Its parent is either ours as well, or was there before.
                    break;
                }
            }

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
                    spec.redactor.clone(),
                )?)),
                None => None,
            };
            let mut process_spec = self.env.spec(&binary);
            process_spec.args = args.into_iter().map(Into::into).collect();
            process_spec.cwd = Some(cwd.clone());
            let mut env = spec.env.clone();
            // What the MCP config refers to by name.
            for server in &spec.mcp_servers {
                env.extend(server.env.iter().cloned());
            }
            if let Some(secs) = spec
                .mcp_servers
                .iter()
                .filter_map(|server| server.tool_timeout_secs)
                .max()
            {
                // The overall limit, and the limit on a stdio call that sends nothing back
                // while it waits (30 minutes by default), which a blocking question can exceed.
                let ms = (secs * 1000).to_string();
                env.push(("MCP_TOOL_TIMEOUT".into(), ms.clone()));
                env.push(("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT".into(), ms));
            }
            // Claude keeps its own temp files, and points sandboxed commands' TMPDIR, under
            // `CLAUDE_CODE_TMPDIR` (`/tmp` by default). A session with a TMPDIR of its own
            // gets a short folder of its own there, removed with it.
            if let Some((_, tmp)) = spec.env.iter().find(|(name, _)| name == "TMPDIR")
                && !spec
                    .env
                    .iter()
                    .any(|(name, _)| name == "CLAUDE_CODE_TMPDIR")
            {
                let dir = match files::temp_dir_path() {
                    Some(dir) => {
                        let path = dir.display().to_string();
                        ledger
                            .record(Artifact::ClaudeTempDir { path: path.clone() })
                            .await?;
                        ledger
                            .record(Artifact::ProcessesIn { dir: path.clone() })
                            .await?;
                        files::create_temp_dir(&dir)?;
                        path
                    }
                    None => tmp.clone(),
                };
                env.push(("CLAUDE_CODE_TMPDIR".into(), dir));
            }
            crate::cli::apply_session_env(&mut process_spec, &env, &spec.path_prepend);
            let process::Spawned { process, stdout } = process::spawn(
                self.platform.clone(),
                &process_spec,
                process::Options {
                    recorder,
                    redactor: spec.redactor.clone(),
                    ledger: Some(ledger.clone()),
                    owned_dir: spec.owned_cwd.then(|| cwd.clone()),
                },
            )?;
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
                events: Events::new(events_tx, spec.redactor.clone()),
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
        Box::new(ClaudeReplayer {
            parser: Parser::replay(),
            asked: HashSet::new(),
        })
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

struct ClaudeReplayer {
    parser: Parser,
    /// Approval requests not answered yet.
    asked: HashSet<String>,
}

impl Replayer for ClaudeReplayer {
    fn feed(&mut self, dir: Direction, line: &str) -> Vec<ProviderEvent> {
        if dir == Direction::In {
            let sent: Value = serde_json::from_str(line).unwrap_or_default();
            if sent["type"] == "control_request" && sent["request"]["subtype"] == "interrupt" {
                self.parser.interrupt_requested();
            }
            let answered = sent["response"]["request_id"].as_str().unwrap_or_default();
            if sent["type"] != "control_response" || !self.asked.remove(answered) {
                return Vec::new();
            }
            let answer = &sent["response"]["response"];
            let decision = if answer["behavior"] == "allow" {
                ApprovalDecision::Allow
            } else {
                ApprovalDecision::Deny {
                    message: answer["message"].as_str().unwrap_or_default().to_owned(),
                }
            };
            return vec![ProviderEvent::ApprovalResolved {
                id: answered.to_owned(),
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

/// State shared by the session handle and its reader.
struct Shared {
    pending: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    /// Tool inputs of unanswered permission requests, by request id.
    approvals: Mutex<HashMap<String, Value>>,
    events: Events,
    turn_active: AtomicBool,
    next_request: AtomicU64,
}

enum ParserCommand {
    Interrupting,
    WroteMessage,
    WriteFailed,
}

pub struct ClaudeSession {
    native_id: String,
    process: Arc<CliProcess>,
    shared: Arc<Shared>,
    parser: mpsc::UnboundedSender<ParserCommand>,
}

impl ClaudeSession {
    async fn emit(&self, event: ProviderEvent) {
        self.shared.events.send(event).await;
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

    async fn write_message(&self, input: TurnInput) -> Result<()> {
        if input.is_empty() {
            return Err(Error::Invalid("the message is empty".into()));
        }
        let mut content = Vec::with_capacity(input.files.len() + 1);
        for file in input.files.iter().filter(|file| file.is_image()) {
            let bytes = tokio::fs::read(&file.path).await.map_err(|err| {
                Error::Invalid(format!("attachment {}: {err}", file.path.display()))
            })?;
            content.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": file.mime,
                    "data": BASE64.encode(bytes),
                },
            }));
        }
        let text = input.text_with_file_notes();
        if !text.trim().is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
        // Told before writing, so the parser knows of it before Claude can answer.
        let _ = self.parser.send(ParserCommand::WroteMessage);
        let written = self.process.write_line(&parse::user_message(content)).await;
        if written.is_err() {
            let _ = self.parser.send(ParserCommand::WriteFailed);
        }
        written
    }
}

impl ProviderSession for ClaudeSession {
    fn native_id(&self) -> String {
        self.native_id.clone()
    }

    fn send(&self, input: TurnInput) -> BoxFuture<'_, Result<()>> {
        // A message sent during a turn is folded into it, exactly like a steer.
        Box::pin(self.write_message(input))
    }

    fn steer(&self, input: TurnInput) -> BoxFuture<'_, Result<()>> {
        // Claude takes a message sent mid-turn at its next step; when the turn already ended,
        // the message starts the next one.
        Box::pin(self.write_message(input))
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
                ParserCommand::WroteMessage => parser.wrote_message(),
                ParserCommand::WriteFailed => parser.write_failed(),
            }
        }
        for output in parser.feed(&line) {
            match output {
                Output::Event(event) => {
                    // When nobody listens any more, keep draining so the CLI never blocks.
                    shared.events.send(event).await;
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
                        shared
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
    shared
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
