//! Connections from CLI sessions, which carry a grant instead of the UI token.
//!
//! - [`serve_mcp`]: after `ClientFrame::Mcp`, the connection is raw MCP, served in-process by
//!   `brigadier_mcp_server` against the session manager.
//! - [`serve_gate`]: after `ClientFrame::Gate`, one outward-command question, one verdict.
//!
//! Both run as tracked connections, so an orderly quit closes them. Grants and command lines
//! are never logged.

use std::sync::Arc;

use brigadier_core::tools::{GateAnswer, Role, ToolHost};
use brigadier_ipc::protocol::GateVerdict;
use brigadier_ipc::{GateCheck, RawStream};

use crate::server::Daemon;

fn role_name(role: &Role) -> &'static str {
    match role {
        Role::Orchestrator { .. } => "orchestrator",
        Role::Worker { .. } => "worker",
        Role::Gate { .. } => "gate",
    }
}

/// Serves the Brigadier MCP tools on `stream` for an orchestrator or worker grant; any other
/// grant closes the connection at once.
pub async fn serve_mcp(daemon: Arc<Daemon>, grant: String, stream: RawStream) {
    let host: Arc<dyn ToolHost> = daemon.sessions.clone();
    let role = match host.role(&grant) {
        Some(role @ (Role::Orchestrator { .. } | Role::Worker { .. })) => role,
        other => {
            let role = other.as_ref().map_or("unknown", role_name);
            tracing::warn!(
                role,
                "refused an MCP connection: not an orchestrator or worker grant"
            );
            return;
        }
    };
    let role = role_name(&role);
    tracing::debug!(role, "MCP connection opened");
    match brigadier_mcp_server::serve(host, grant, stream, daemon.closing.child_token()).await {
        Ok(()) => tracing::debug!(role, "MCP connection closed"),
        Err(err) => tracing::warn!(role, error = %err, "MCP connection failed"),
    }
}

/// Answers one outward-command question from the gate. Only a gate grant may ask; the
/// question is withdrawn (the host's future dropped) if the asking program goes away.
pub async fn serve_gate(
    daemon: Arc<Daemon>,
    grant: String,
    argv: Vec<String>,
    cwd: String,
    mut check: GateCheck,
) {
    let program = argv
        .first()
        .map(|arg0| arg0.rsplit('/').next().unwrap_or(arg0).to_owned())
        .unwrap_or_default();
    let host: Arc<dyn ToolHost> = daemon.sessions.clone();
    let verdict = match host.role(&grant) {
        Some(Role::Gate { .. }) => {
            tokio::select! {
                answer = host.ask_outward(&grant, argv, cwd) => match answer {
                    GateAnswer::Allow => GateVerdict { allow: true, message: None },
                    GateAnswer::Deny { message } => GateVerdict {
                        allow: false,
                        message: Some(message),
                    },
                },
                _ = check.closed() => {
                    tracing::debug!(%program, "gate question withdrawn: the program went away");
                    return;
                }
                _ = daemon.closing.cancelled() => GateVerdict {
                    allow: false,
                    message: Some("Brigadier is shutting down".into()),
                },
            }
        }
        other => {
            let role = other.as_ref().map_or("unknown", role_name);
            tracing::warn!(role, %program, "refused a gate question: not a gate grant");
            GateVerdict {
                allow: false,
                message: Some("this session may not ask for outward commands".into()),
            }
        }
    };
    tracing::info!(%program, allow = verdict.allow, "gate answered");
    if let Err(err) = check.answer(&verdict).await {
        tracing::debug!(error = %err, "could not deliver the gate verdict");
    }
}
