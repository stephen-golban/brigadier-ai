//! The session manager: live sessions, Chats and their workers.
//!
//! It turns the conversation log into running CLI sessions and back:
//!
//! - one orchestrator CLI session per Brigadier session, which only talks and calls the
//!   Brigadier MCP tools;
//! - workers, one CLI session per task, in their own worktrees;
//! - one CLI session per Chat;
//! - the grants those sessions hold, and the cleanup of everything they create.

use std::sync::Arc;

use brigadier_providers::BoxFuture;

use crate::runtime::Runtime;
use crate::tools::{GateAnswer, Grants, Role, ToolCall, ToolHost, ToolReply};
use crate::{Core, Result};

pub struct SessionManager {
    core: Arc<Core>,
    runtime: Arc<Runtime>,
    grants: Grants,
}

impl SessionManager {
    pub async fn start(core: Arc<Core>, runtime: Arc<Runtime>) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            core,
            runtime,
            grants: Grants::default(),
        }))
    }

    /// Grants held by live CLI sessions.
    pub fn grants(&self) -> &Grants {
        &self.grants
    }

    pub fn core(&self) -> &Arc<Core> {
        &self.core
    }

    pub fn runtime(&self) -> &Arc<Runtime> {
        &self.runtime
    }
}

impl ToolHost for SessionManager {
    fn role(&self, grant: &str) -> Option<Role> {
        self.grants.resolve(grant)
    }

    fn call(&self, grant: &str, call: ToolCall) -> BoxFuture<'_, ToolReply> {
        let role = self.grants.resolve(grant);
        Box::pin(async move {
            let Some(role) = role else {
                return ToolReply::error("This grant is not valid (the session ended).");
            };
            match (role, call) {
                (Role::Orchestrator { .. }, ToolCall::Orchestrator(call)) => {
                    ToolReply::error(format!("{} is not wired up yet.", call.name()))
                }
                (Role::Worker { .. }, ToolCall::Worker(call)) => {
                    ToolReply::error(format!("{} is not wired up yet.", call.name()))
                }
                _ => ToolReply::error("This tool is not available to this session."),
            }
        })
    }

    fn ask_outward(
        &self,
        grant: &str,
        _argv: Vec<String>,
        _cwd: String,
    ) -> BoxFuture<'_, GateAnswer> {
        let role = self.grants.resolve(grant);
        Box::pin(async move {
            match role {
                None => GateAnswer::Deny {
                    message: "Brigadier does not know this session.".into(),
                },
                Some(_) => GateAnswer::Deny {
                    message: "Brigadier could not ask you.".into(),
                },
            }
        })
    }
}
