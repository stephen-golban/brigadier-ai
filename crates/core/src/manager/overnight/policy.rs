//! What an overnight run may do on the user's behalf (PLAN.md §10.8), enforced in code.
//!
//! While a run is active its session works under sandboxed **Approve for me**, whatever the
//! user saved: plans are decided for them, nothing runs unsandboxed, and anything only the
//! user may do (an outward command, leaving the sandbox, landing despite failed checks) is
//! refused at once and listed under "Waiting on you" instead of waiting on an approval card
//! nobody will answer. Run tasks don't see credentials: their usual locations are unreadable,
//! the project's secret files aren't copied in, and credential variables are taken out of the
//! worker's environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::model::{ConversationId, OvernightRunId};
use crate::overnight::{OvernightRun, RunRole, RunTaskContext, RunWorkspace};
use crate::work::Task;

/// A session's active run, as task code needs it without reading the board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ActiveRun {
    pub id: OvernightRunId,
    pub segment: u32,
    pub generation: u32,
    pub rules_hash: String,
    pub workspace: Option<RunWorkspace>,
}

/// The active run of each session that has one. Kept in step with every recorded run, and
/// rebuilt from the boards at startup.
#[derive(Default)]
pub(crate) struct ActiveRuns(std::sync::Mutex<HashMap<ConversationId, ActiveRun>>);

impl ActiveRuns {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ConversationId, ActiveRun>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get(&self, id: &ConversationId) -> Option<ActiveRun> {
        self.lock().get(id).cloned()
    }

    /// Takes in a run as just recorded: an active one is the session's run, one that ended
    /// no longer is.
    pub fn note(&self, run: &OvernightRun) {
        let mut active = self.lock();
        if run.state.is_active() {
            active.insert(
                run.conversation_id.clone(),
                ActiveRun {
                    id: run.id.clone(),
                    segment: run.segment,
                    generation: run.generation,
                    rules_hash: rules_hash(&run.rules),
                    workspace: run.workspace.clone(),
                },
            );
        } else if active
            .get(&run.conversation_id)
            .is_some_and(|now| now.id == run.id)
        {
            active.remove(&run.conversation_id);
        }
    }
}

impl ActiveRun {
    /// The context a task made now gets: a check of another task's change inherits that
    /// task's run (or none: checks of work from before the run stay the session's), anything
    /// else works for the run.
    pub fn context_for(active: Option<&Self>, subject: Option<&Task>) -> Option<RunTaskContext> {
        match subject {
            Some(subject) => subject.run.clone().map(|run| RunTaskContext {
                role: RunRole::Check,
                ..run
            }),
            None => active.map(|active| RunTaskContext {
                run_id: active.id.clone(),
                segment: active.segment,
                phase_id: None,
                generation: active.generation,
                role: RunRole::Worker,
                rules_hash: active.rules_hash.clone(),
            }),
        }
    }
}

/// A short, stable hash of the run's Rules, so a task's briefing can be matched to them.
pub(crate) fn rules_hash(rules: &str) -> String {
    blake3::hash(rules.as_bytes()).to_hex()[..16].to_owned()
}

/// Where credentials usually live under `home`: unreadable for run tasks.
pub(crate) fn credential_paths(home: &Path) -> Vec<PathBuf> {
    [
        ".ssh",
        ".gnupg",
        ".config/gh",
        ".config/hub",
        ".config/gcloud",
        ".config/op",
        ".config/doctl",
        ".git-credentials",
        ".config/git/credentials",
        ".netrc",
        ".npmrc",
        ".yarnrc.yml",
        ".pypirc",
        ".gem/credentials",
        ".cargo/credentials",
        ".cargo/credentials.toml",
        ".aws",
        ".azure",
        ".kube",
        ".docker/config.json",
        ".terraform.d/credentials.tfrc.json",
        ".fly",
        ".vercel",
        ".netlify",
        ".wrangler",
        ".railway",
        "Library/Keychains",
        "Library/Application Support/gh",
    ]
    .iter()
    .map(|rest| home.join(rest))
    .collect()
}

/// Environment variables taken out of a run worker's environment: agent sockets, askpass
/// helpers and tokens, which commands could use to act as the user. The CLI's own sign-in
/// stays (it can't work without it).
pub(crate) fn scrubbed_env(names: impl IntoIterator<Item = String>) -> Vec<String> {
    const KEEP: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "BRIGADIER_GATE",
    ];
    const EXACT: &[&str] = &[
        "SSH_AUTH_SOCK",
        "SSH_ASKPASS",
        "GIT_ASKPASS",
        "SUDO_ASKPASS",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GITLAB_TOKEN",
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "CARGO_REGISTRY_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AZURE_CLIENT_SECRET",
        "DOCKER_AUTH_CONFIG",
        "KUBECONFIG",
        "HOMEBREW_GITHUB_API_TOKEN",
        "VERCEL_TOKEN",
        "NETLIFY_AUTH_TOKEN",
        "FLY_API_TOKEN",
        "CLOUDFLARE_API_TOKEN",
        "RAILWAY_TOKEN",
        "OP_SESSION",
    ];
    const SUFFIXES: &[&str] = &[
        "_TOKEN",
        "_SECRET",
        "_SECRET_KEY",
        "_PASSWORD",
        "_API_KEY",
        "_ACCESS_KEY",
        "_PRIVATE_KEY",
        "_CREDENTIALS",
        "_ASKPASS",
    ];
    let mut scrubbed: Vec<String> = EXACT.iter().map(|name| (*name).to_owned()).collect();
    for name in names {
        let upper = name.to_ascii_uppercase();
        if KEEP.contains(&upper.as_str()) || scrubbed.contains(&name) {
            continue;
        }
        if SUFFIXES.iter().any(|suffix| upper.ends_with(suffix)) || upper.starts_with("OP_SESSION")
        {
            scrubbed.push(name);
        }
    }
    scrubbed
}

/// Environment a run worker gets on top: git never prompts for or looks up credentials, and
/// no credential helper (Keychain included) runs on its behalf.
pub(crate) fn run_env() -> Vec<(String, String)> {
    [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "never"),
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "credential.helper"),
        ("GIT_CONFIG_VALUE_0", ""),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect()
}

impl super::super::SessionManager {
    /// A run worker's approval request, under [`ApprovalMode::Unattended`]: what stays in
    /// its sandbox is allowed, anything else is declined at once and, when only the user
    /// could have allowed it, listed under "Waiting on you" for the morning.
    pub(crate) async fn route_unattended(
        &self,
        live: &std::sync::Arc<super::super::workers::TaskLive>,
        cli: &std::sync::Arc<super::super::conversation::Cli>,
        request: brigadier_providers::ApprovalRequest,
        access: &brigadier_providers::Access,
        task: &Task,
        run: &RunTaskContext,
    ) {
        use brigadier_providers::policy::{self, ApprovalMode, Route};
        use brigadier_providers::{ApprovalDecision, Decider};
        let route = policy::route(&request, access, ApprovalMode::Unattended);
        let what = request
            .command
            .clone()
            .unwrap_or_else(|| request.tool.clone());
        let outward = request.command.as_deref().is_some_and(policy::is_outward);
        let decision = match route {
            Route::Allow => ApprovalDecision::Allow,
            Route::Deny | Route::AskUser => ApprovalDecision::Deny {
                message: if outward {
                    "Declined by Brigadier: this overnight run never acts outside this machine for the user (push, publish, deploy, remote changes). Leave it for the user: say what it needs under needs_user in your report, and finish the rest.".into()
                } else {
                    "Declined by Brigadier: stay inside your sandbox (your worktree and scratch folder). Nobody can approve more during this overnight run; if the task truly needs it, say so under needs_user in your report and finish the rest.".into()
                },
            },
        };
        if let Err(err) = cli
            .session
            .answer(request.id.clone(), decision.clone())
            .await
        {
            tracing::warn!(task = %live.id, error = %err, "could not answer an approval");
            return;
        }
        let allowed = decision == ApprovalDecision::Allow;
        self.record_worker_resolution(&live.id, request.id.clone(), decision, Decider::Policy)
            .await;
        if allowed {
            return;
        }
        let why = if outward {
            "to act outside this machine"
        } else if request.escalation {
            "to run outside its sandbox"
        } else {
            "to reach outside its sandbox"
        };
        let line = format!(
            "task-{} wanted {why}: `{}`. The overnight run declined it; do it yourself if it's needed, or tell the run how to go on.",
            task.number,
            one_line(&what)
        );
        if let Err(err) = self
            .wait_on_user(
                &task.conversation_id,
                task.request_id.clone(),
                crate::work::WaitingSource::Run {
                    run_id: run.run_id.clone(),
                    task_id: Some(task.id.clone()),
                },
                &line,
            )
            .await
        {
            tracing::warn!(task = %task.id, error = %err, "could not list a declined request");
        }
    }

    /// The command gate during an overnight run: an outward command is refused at once and
    /// listed for the user. `None` when the session has no active run.
    pub(crate) async fn unattended_outward(
        &self,
        conversation_id: &ConversationId,
        task_id: Option<&crate::model::TaskId>,
        argv: &[String],
    ) -> Option<String> {
        let task = match task_id {
            Some(id) => self.task_by_id(conversation_id, id).await.ok(),
            None => None,
        };
        let run_id = match task.as_ref().and_then(|task| task.run.as_ref()) {
            Some(run) => run.run_id.clone(),
            None => self.overnight.active.get(conversation_id)?.id,
        };
        let who = task
            .as_ref()
            .map(|task| format!("task-{}", task.number))
            .unwrap_or_else(|| "The orchestrator".into());
        let line = format!(
            "{who} wanted to run `{}`, which acts outside this machine. The overnight run declined it; run it yourself if it's needed.",
            one_line(&argv.join(" "))
        );
        if let Err(err) = self
            .wait_on_user(
                conversation_id,
                task.as_ref().and_then(|task| task.request_id.clone()),
                crate::work::WaitingSource::Run {
                    run_id,
                    task_id: task.as_ref().map(|task| task.id.clone()),
                },
                &line,
            )
            .await
        {
            tracing::warn!(conversation = %conversation_id, error = %err, "could not list a declined command");
        }
        Some(
            "this overnight run never acts outside this machine for the user; it is listed for them. Say what it needs under needs_user and finish the rest.".into(),
        )
    }
}

/// A command shortened to one line for the user's list.
fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match line.char_indices().nth(160) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line,
    }
}
