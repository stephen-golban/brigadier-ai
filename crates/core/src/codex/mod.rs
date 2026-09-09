//! Codex local CLI provider, using its versioned app-server JSON-lines protocol.
//!
//! Verified against `codex-cli 0.153.4` generated protocol and official docs:
//! <https://learn.chatgpt.com/docs/app-server>. No API gateway or shared app daemon.
mod adapter;
pub mod capabilities;
mod rpc;

use crate::{
    driver::{
        BoxFuture, DriverError, DriverInfo, DriverKind, McpPolicy, PermissionMode, ProviderDriver,
        ResumeSession, Resumed, StartSession,
    },
    event::InstanceId,
    session::SessionHandle,
};
use rpc::{protocol, Rpc};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
/// Provider registry key.
pub const CODEX: &str = "codex";
/// One locally authenticated Codex account instance.
#[derive(Clone, Debug)]
pub struct CodexDriverConfig {
    /// Stable account instance id.
    pub instance_id: InstanceId,
    /// Explicit binary; otherwise search PATH and standard user/system install locations.
    pub binary: Option<PathBuf>,
    /// App-owned durable source cache; retained for native resume.
    pub attachment_dir: Option<PathBuf>,
}
impl CodexDriverConfig {
    /// Configure the local default Codex account.
    pub fn new(instance: impl Into<InstanceId>) -> Self {
        Self {
            instance_id: instance.into(),
            binary: None,
            attachment_dir: None,
        }
    }
}
/// Materialized Codex provider with a verified local app-server and signed-in account.
#[derive(Clone, Debug)]
pub struct CodexDriver {
    config: CodexDriverConfig,
    binary: PathBuf,
    version: String,
}
impl CodexDriver {
    /// Probe the installed CLI, authenticated account and live model discovery.
    pub async fn probe(config: CodexDriverConfig) -> Result<Self, DriverError> {
        let binary = crate::binary::resolve(CODEX, config.binary.as_deref()).ok_or_else(|| {
            DriverError::BinaryNotFound(
                "codex was not found on PATH or in standard install locations".into(),
            )
        })?;
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new(&binary)
                .arg("--version")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| protocol("Codex version probe timed out"))?
        .map_err(|e| protocol(e.to_string()))?;
        if !output.status.success() {
            return Err(protocol("Codex version probe failed"));
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let mut rpc = Rpc::spawn(&binary, &std::env::temp_dir(), &BTreeMap::new()).await?;
        let result = async {
            rpc.initialize().await?;
            let auth = rpc
                .request("account/read", json!({"refreshToken":false}))
                .await?;
            if auth["account"].is_null() && auth["requiresOpenaiAuth"] != false {
                return Err(protocol("Sign in with codex login before connecting Codex"));
            }
            capabilities::discover(&mut rpc, config.instance_id.as_str()).await?;
            if let Ok(usage) = rpc.request("account/rateLimits/read", json!({})).await {
                capabilities::record_usage(config.instance_id.as_str(), usage);
            }
            Ok(())
        }
        .await;
        rpc.kill().await;
        result?;
        Ok(Self {
            config,
            binary,
            version,
        })
    }
    /// Build from a previously checked binary. Intended for embedding and deterministic tests.
    pub fn with_version(
        config: CodexDriverConfig,
        binary: impl Into<PathBuf>,
        version: impl Into<String>,
    ) -> Self {
        Self {
            config,
            binary: binary.into(),
            version: version.into(),
        }
    }
    async fn open(
        &self,
        req: StartSession,
        resume: Option<(String, bool)>,
        resumed: Option<Resumed>,
    ) -> Result<SessionHandle, DriverError> {
        let (approval, sandbox) = permission(&req.permission_mode)?;
        let mut rpc = Rpc::spawn(&self.binary, &req.cwd, &req.env_overrides).await?;
        let preparation=async {
            rpc.initialize().await?;
            let rows=capabilities::discover(&mut rpc,self.config.instance_id.as_str()).await?;
            let config=rpc.request("config/read",json!({"includeLayers":false,"cwd":req.cwd})).await?;
            let configured_model=config["config"]["model"].as_str();
            capabilities::validate(&rows,req.model.as_deref().or(configured_model),req.effort.as_deref())?;
            let overrides=thread_config(&req,&config);
            let mut params=json!({"cwd":req.cwd,"approvalPolicy":approval,"approvalsReviewer":"user","sandbox":sandbox,"config":overrides});
            if let Some(model)=&req.model{params["model"]=json!(model);}
            let method=if let Some((token,fork))=&resume{params["threadId"]=json!(token);params["excludeTurns"]=json!(true);if *fork{"thread/fork"}else{"thread/resume"}}else{"thread/start"};
            let result=rpc.request(method,params).await?;
            let thread=result["thread"]["id"].as_str().ok_or_else(||protocol("Codex start omitted thread id"))?.to_owned();
            let model=result["model"].as_str().ok_or_else(||protocol("Codex start omitted model"))?.to_owned();
            if req.model.as_ref().is_some_and(|expected|expected!=&model){return Err(protocol("Codex did not retain the explicitly selected model"));}
            if let Some(effort)=&req.effort{if result["reasoningEffort"].as_str()!=Some(effort){return Err(protocol("Codex did not retain the explicitly selected effort"));}}
            Ok((thread,model))
        }.await;
        match preparation {
            Ok((thread, model)) => {
                adapter::connect(
                    rpc,
                    self.config.instance_id.clone(),
                    req,
                    resumed,
                    thread,
                    model,
                    self.config.attachment_dir.clone(),
                )
                .await
            }
            Err(error) => {
                rpc.kill().await;
                Err(error)
            }
        }
    }
}
impl ProviderDriver for CodexDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::new(CODEX)
    }
    fn instance_id(&self) -> &InstanceId {
        &self.config.instance_id
    }
    fn describe(&self) -> DriverInfo {
        DriverInfo {
            display_name: "Codex".into(),
            binary_path: Some(self.binary.clone()),
            version: Some(self.version.clone()),
            account_label: Some("default".into()),
        }
    }
    fn start_session(
        &self,
        req: StartSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(self.open(req, None, None))
    }
    fn resume_session(
        &self,
        req: ResumeSession,
    ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
        Box::pin(async move {
            let mut start = StartSession::new(req.cwd);
            start.prompt = req.prompt;
            start.model = req.model;
            start.effort = req.effort;
            start.permission_mode = req.permission_mode;
            start.env_overrides = req.env_overrides;
            start.mcp = req.mcp;
            start.thinking = req.thinking;
            start.event_buffer = req.event_buffer;
            start.hook_policy = req.hook_policy;
            self.open(start, Some((req.token, req.fork)), req.resumed)
                .await
        })
    }
}
pub(crate) fn permission(
    mode: &PermissionMode,
) -> Result<(&'static str, &'static str), DriverError> {
    Ok(match mode {
        PermissionMode::Default | PermissionMode::Manual => ("untrusted", "read-only"),
        PermissionMode::AcceptEdits => ("on-request", "workspace-write"),
        PermissionMode::Plan => ("never", "read-only"),
        PermissionMode::DontAsk => ("never", "workspace-write"),
        PermissionMode::BypassPermissions => ("never", "danger-full-access"),
        _ => {
            return Err(protocol(format!(
                "Permission mode {mode} has no supported Codex equivalent"
            )))
        }
    })
}
fn thread_config(req: &StartSession, config: &Value) -> Value {
    let mut overrides = json!({"features.multi_agent":false,"features.multi_agent_v2":false});
    // All delegation goes through Brigadier peers, so root ownership and shared limits apply.
    let mut servers = config["config"]["mcp_servers"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if req.mcp == McpPolicy::Off {
        for server in servers.values_mut() {
            server["enabled"] = json!(false);
        }
        overrides["apps._default.enabled"] = json!(false);
    }
    if let Some(executable) = req
        .env_overrides
        .get("BRIGADIER_EXECUTABLE")
        .filter(|_| req.env_overrides.contains_key("BRIGADIER_PEER_TOKEN"))
    {
        servers.insert("brigadier".into(), json!({"command":executable,"args":["--peer-mcp"],"env_vars":["BRIGADIER_PEER_TOKEN","BRIGADIER_PEER_ENDPOINT","BRIGADIER_EXECUTABLE"],"enabled":true,"required":true}));
    }
    overrides["mcp_servers"] = without_nulls(Value::Object(servers));
    if let Some(effort) = &req.effort {
        overrides["model_reasoning_effort"] = json!(effort);
    }
    // Refuse writes outside cwd unless the owner chose full access. Avoid shared /tmp writes.
    overrides["sandbox_workspace_write.exclude_tmpdir_env_var"] = json!(true);
    overrides["sandbox_workspace_write.exclude_slash_tmp"] = json!(true);
    overrides["sandbox_workspace_write.writable_roots"] = json!([]);
    overrides
}

// config/read emits typed optional fields as null. Codex's JSON→TOML override
// conversion represents null as an empty string, which is invalid for numeric fields.
fn without_nulls(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                *v = without_nulls(std::mem::take(v));
            }
        }
        Value::Array(values) => {
            for v in values {
                *v = without_nulls(std::mem::take(v));
            }
        }
        _ => {}
    }
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mcp_off_handles_literal_names_and_null_optional_fields() {
        let req = StartSession::new("/tmp");
        let config = json!({"config":{"mcp_servers":{"dotted.name":{"command":"server","tool_timeout_sec":null,"enabled":true}}}});
        let overrides = thread_config(&req, &config);
        assert_eq!(overrides["mcp_servers"]["dotted.name"]["enabled"], false);
        assert_eq!(overrides["mcp_servers"]["dotted.name"]["command"], "server");
        assert!(overrides["mcp_servers"]["dotted.name"]
            .get("tool_timeout_sec")
            .is_none());
    }
}
