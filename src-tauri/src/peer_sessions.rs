//! Read-only cross-session coordination. Waiting holds no lifecycle or store locks.
use crate::{error::AppError, navigation, peers, state::Ready};
use brigadier_core::{event::SessionId, session::NativeControl};
use brigadier_store::SessionRecord;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Duration,
};

static CHANGES: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn changes() -> &'static tokio::sync::watch::Sender<u64> {
    CHANGES.get_or_init(|| tokio::sync::watch::channel(0).0)
}
pub(crate) fn subscribe() -> tokio::sync::watch::Receiver<u64> {
    changes().subscribe()
}
pub(crate) fn notify() {
    changes().send_modify(|v| *v = v.wrapping_add(1));
}

#[derive(Default)]
struct WaitGraph(HashMap<String, Vec<String>>);
impl WaitGraph {
    fn insert(&mut self, caller: &str, targets: &[String]) -> Result<(), AppError> {
        if self.0.contains_key(caller) {
            return Err(AppError::invalid_argument(
                "This session already has an active wait",
            ));
        }
        let mut seen = HashSet::new();
        let mut pending = targets.to_vec();
        while let Some(id) = pending.pop() {
            if id == caller {
                return Err(AppError::invalid_argument(
                    "Circular wait: send a message or continue work instead",
                ));
            }
            if seen.insert(id.clone()) {
                pending.extend(self.0.get(&id).into_iter().flatten().cloned());
            }
        }
        self.0.insert(caller.into(), targets.to_vec());
        Ok(())
    }
}
static WAITS: OnceLock<Mutex<WaitGraph>> = OnceLock::new();
fn waits() -> &'static Mutex<WaitGraph> {
    WAITS.get_or_init(Mutex::default)
}
struct Waiting(String);
impl Drop for Waiting {
    fn drop(&mut self) {
        waits()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .remove(&self.0);
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    session_id: String,
    after_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    session_id: String,
    seq: u64,
    revision: u64,
    status: String,
}
fn cursor(target: &Target) -> Result<Option<Cursor>, AppError> {
    target
        .after_cursor
        .as_deref()
        .map(|s| {
            let c: Cursor = serde_json::from_str(s)
                .map_err(|_| AppError::invalid_argument("Invalid session cursor"))?;
            if c.session_id != target.session_id || c.seq > i64::MAX as u64 {
                return Err(AppError::invalid_argument(
                    "Cursor belongs to another session or is out of range",
                ));
            }
            Ok(c)
        })
        .transpose()
}
pub(crate) fn require_target(ready: &Ready, row: &SessionRecord) -> Result<(), AppError> {
    navigation::require_available(
        &ready.data_dir,
        navigation::Kind::Session,
        row.session_id.as_str(),
    )?;
    if let Some(project) = &row.project_id {
        navigation::require_available(&ready.data_dir, navigation::Kind::Project, project)?;
    }
    ready
        .supervisor
        .require_session_available(&row.session_id)?;
    Ok(())
}
async fn target_row(ready: &Ready, id: &str) -> Result<SessionRecord, AppError> {
    let row = ready
        .supervisor
        .session(&SessionId::new(id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Session no longer exists"))?;
    require_target(ready, &row)?;
    Ok(row)
}

async fn activity(ready: &Ready, row: &SessionRecord) -> Value {
    if !ready.supervisor.is_live(&row.session_id) {
        return json!({"status":row.status.as_str()});
    }
    // This is adapter memory, not a request to the model or a provider network call.
    match tokio::time::timeout(
        Duration::from_secs(1),
        ready
            .supervisor
            .native_control(&row.session_id, NativeControl::Activity),
    )
    .await
    {
        Ok(Ok(value)) => value,
        _ => json!({"status":"unknown"}),
    }
}
// Checkpointing is a transient capture, not completion or a request for attention.
fn terminal(status: &str) -> bool {
    matches!(
        status,
        "Idle" | "Needs approval" | "Rewinding" | "exited" | "failed" | "completed" | "stopped" | "superseded" | "recovery-required"
    )
}
// A retired process may be killed after a successful turn. Keep its contribution status truthful.
fn execution_status<'a>(assignment:Option<&'a str>,process:&'a str,queued:usize)->&'a str {
    if queued>0{return "queued";}
    match assignment {
        Some(state @ ("completed"|"stopped"|"superseded"|"failed"|"recovery-required"))=>state,
        Some(state) if !matches!(process,"failed"|"exited"|"Needs approval"|"Rewinding"|"Checkpointing")=>state,
        _=>process,
    }
}
fn changed(c: Option<&Cursor>, revision: u64, status: &str) -> bool {
    c.is_none_or(|c| c.revision != revision || c.status != status)
}
fn ready_for_wait(previous: Option<&Cursor>, revision: u64, status: &str) -> bool {
    terminal(status) && changed(previous, revision, status)
}
async fn summary(
    ready: &Ready,
    caller: &str,
    target: &Target,
    include_content: bool,
) -> Result<Value, AppError> {
    let previous = cursor(target)?;
    let row = target_row(ready, &target.session_id).await?;
    let data = peers::snapshot()?;
    data.require_coordination(caller, &target.session_id)?;
    let active = activity(ready, &row).await;
    let queued = data
        .messages
        .iter()
        .filter(|m| m.to == target.session_id && m.work && !m.delivered && m.error.is_none())
        .count();
    let process_status=active["status"].as_str().unwrap_or("unknown");
    let assignment=data.assignments.get(&target.session_id);
    let status=execution_status(assignment.map(|a|a.state.as_str()),process_status,queued);
    let mut result = json!({"sessionId":row.session_id,"projectId":row.project_id,"title":data.titles.get(&target.session_id),"provider":row.driver_kind,"model":row.model,"effort":row.effort,"status":status,"processStatus":process_status,"assignment":assignment,"action":active["action"],"queuedMessages":queued,"ready":ready_for_wait(previous.as_ref(), row.last_event_seq, status)});
    if include_content {
        let items = ready
            .store()
            .recent_chat_items(target.session_id.clone(), previous.as_ref().map(|c| c.seq))
            .await?;
        let seq = items
            .last()
            .map(|i| i.seq)
            .unwrap_or(previous.as_ref().map_or(0, |c| c.seq));
        result["messages"] = json!(items.iter().map(|i| json!({"id":i.id,"seq":i.seq,"kind":i.kind,"text":brigadier_core::event::bounded(&i.body, 4000)})).collect::<Vec<_>>());
        result["hasMore"] = json!(items.len() == 20);
        result["cursor"] = json!(serde_json::to_string(&Cursor {
            session_id: target.session_id.clone(),
            seq,
            revision: row.last_event_seq,
            status: status.into()
        })
        .map_err(|e| AppError::io(e.to_string()))?);
    }
    Ok(result)
}
fn targets(v: &Value, caller: &str) -> Result<Vec<Target>, AppError> {
    let targets: Vec<Target> = serde_json::from_value(v["targets"].clone()).map_err(|_| {
        AppError::invalid_argument("Supply targets with sessionId and optional afterCursor")
    })?;
    if targets.is_empty() || targets.len() > 8 {
        return Err(AppError::invalid_argument("Wait on 1–8 sessions"));
    }
    let mut seen = HashSet::new();
    for t in &targets {
        if t.session_id == caller || !seen.insert(&t.session_id) {
            return Err(AppError::invalid_argument(
                "Wait targets must be distinct other sessions",
            ));
        }
        cursor(t)?;
    }
    Ok(targets)
}
async fn wait(ready: &Ready, caller: &str, v: &Value) -> Result<Value, AppError> {
    let targets = targets(v, caller)?;
    let timeout = match v.get("timeoutMs") {
        None => 60000,
        Some(v) => v
            .as_u64()
            .filter(|t| *t <= 60000)
            .ok_or_else(|| AppError::invalid_argument("timeoutMs must be between 0 and 60000"))?,
    };
    waits().lock().unwrap_or_else(|e| e.into_inner()).insert(
        caller,
        &targets
            .iter()
            .map(|t| t.session_id.clone())
            .collect::<Vec<_>>(),
    )?;
    let _waiting = Waiting(caller.into());
    let mut changes = changes().subscribe();
    let inbox = peers::snapshot()?
        .messages
        .into_iter()
        .filter(|m| m.to == caller)
        .map(|m| m.id)
        .collect::<HashSet<_>>();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
    let reason = loop {
        let caller_row = target_row(ready, caller).await?;
        let caller_activity = activity(ready, &caller_row).await;
        if !ready.supervisor.is_live(&caller_row.session_id)
            || matches!(caller_activity["status"].as_str(), Some("Idle"))
        {
            break "interrupted";
        }
        if peers::snapshot()?
            .messages
            .iter()
            .any(|m| m.to == caller && !inbox.contains(&m.id))
        {
            break "message";
        }
        let mut actionable = false;
        for target in &targets {
            match summary(ready, caller, target, false).await {
                Ok(s) if s["ready"] == true => actionable = true,
                Err(_) => actionable = true,
                _ => {}
            }
        }
        if actionable {
            break "ready";
        }
        if tokio::time::Instant::now() >= deadline {
            break "timeout";
        }
        // Feed events wake immediately. A bounded fallback covers persistence lag and process EOF.
        tokio::select! {
            _ = changes.changed() => {},
            _ = tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + Duration::from_secs(1))) => {},
        }
    };
    let mut sessions = Vec::new();
    let mut errors = Vec::new();
    for target in &targets {
        match summary(ready, caller, target, true).await {
            Ok(s) => {
                peers::observed_result(caller, &s)?;
                retire_reported_worker(ready, caller, &target.session_id).await;
                sessions.push(s)
            }
            Err(e) => errors.push(json!({"sessionId":target.session_id,"error":e})),
        }
    }
    Ok(json!({"reason":reason,"sessions":sessions,"errors":errors}))
}

/// Results have been persisted and included in a parent read. Release disposable resources;
/// dirty/unintegrated files remain in place and the retained branch/history are never deleted.
async fn retire_reported_worker(ready: &Ready, caller: &str, target: &str) {
    let _guard = peers::LIFECYCLE.lock().await;
    retire_reported_worker_locked(ready, caller, target).await;
}

pub(crate) async fn retire_reported_worker_locked(ready: &Ready, caller: &str, target: &str) {
    let Ok(data) = peers::snapshot() else {
        return;
    };
    if data.subagents.get(target).map(String::as_str) != Some(caller) {
        return;
    }
    if data
        .messages
        .iter()
        .any(|m| m.to == target && m.work && !m.delivered && m.error.is_none())
    {
        return;
    }
    if crate::composer::has_pending(target) {
        return;
    }
    let id = SessionId::new(target);
    let Ok(turns) = ready.store().chat_turns(target.into()).await else {
        return;
    };
    let Some(turn) = turns.first().filter(|t| t.status == "completed") else {
        return;
    };
    if data
        .retired
        .get(target)
        .is_some_and(|receipt| retirement_settled(receipt, &turn.id))
    {
        return;
    }
    // A worker waiting on active descendants is still responsible for their integration.
    if crate::cleanup::descendants([target.to_owned()].into(), &data.subagents)
        .iter()
        .any(|child| child != target && ready.supervisor.is_live(&SessionId::new(child)))
    {
        return;
    }
    let Ok(Some(row)) = ready.supervisor.session(&id).await else {
        return;
    };
    if ready.supervisor.is_live(&id) {
        let Ok(activity) = ready
            .supervisor
            .native_control(&id, NativeControl::Activity)
            .await
        else {
            return;
        };
        if activity["status"] != "Idle" {
            return;
        }
        if ready.supervisor.kill(&id).await.is_err() {
            return;
        }
    }
    // Kill acknowledges process-stop intent before the consumer persists its exit and
    // leaves the live registry. Never race workspace cleanup against that consumer.
    if tokio::time::timeout(Duration::from_secs(5), async {
        while ready.supervisor.is_live(&id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_err()
    {
        return; // No final receipt: a subsequent read/close can retry safely.
    }
    // Review and handoff may still need the exact candidate, even when its diff is clean.
    // Release the process now, but retain its workspace until the root judges the contribution.
    if data.assignments.get(target).is_some_and(|a| !matches!(a.disposition.as_str(),"accepted"|"integrated"|"rejected")) {
        return;
    }
    let (removed, reason) = if row.worktree_path.is_some() {
        match ready.supervisor.cleanup_worktree(&id, false).await {
            Ok(result) => (
                result.removed,
                if result.removed {
                    None
                } else {
                    Some("Uncommitted work retained in its workspace".into())
                },
            ),
            Err(e) => (false, Some(e.to_string())),
        }
    } else {
        (false, Some("Shared project workspace retained".into()))
    };
    if let Err(e) = peers::record_retired(target, &turn.id, removed, reason) {
        tracing::warn!("Worker retirement receipt: {}", e.message);
    }
}

fn retirement_settled(receipt: &Value, turn: &str) -> bool {
    receipt["turnId"] == turn
        && (receipt["workspaceRemoved"] == true
            || matches!(
                receipt["reason"].as_str(),
                Some(
                    "Uncommitted work retained in its workspace"
                        | "Shared project workspace retained"
                )
            ))
}

pub(crate) async fn dispatch(ready: &Ready, caller: &str, v: &Value) -> Result<Value, AppError> {
    match v["action"].as_str() {
        Some("projects") => {
            let navigation = navigation::read(&ready.data_dir)?;
            let names = crate::workbench_data::read(&ready.data_dir)?.project_names;
            Ok(
                json!({"projects":ready.supervisor.list_projects().await?.iter().filter(|p| !navigation.hidden(&navigation::Kind::Project, &p.id)).map(|p| json!({"id":p.id,"name":names.get(&p.id).unwrap_or(&p.name),"rootPath":p.root_path})).collect::<Vec<_>>()}),
            )
        }
        Some("list" | "subagents") => {
            let project = v.get("projectId").and_then(Value::as_str);
            let data = peers::snapshot()?;
            let mut rows = ready.supervisor.list_sessions().await?;
            rows.sort_by_key(|s| std::cmp::Reverse(s.started_at));
            let root = data.conversation_owner(caller)?;
            let workers = crate::cleanup::descendants([root.to_owned()].into(), &data.subagents);
            let internal = v["action"] == "subagents";
            let sessions = rows.iter().filter(|s| if internal { s.session_id.as_str() != root && workers.iter().any(|id| id == s.session_id.as_str()) } else { !data.subagents.contains_key(s.session_id.as_str()) }).filter(|s| project.is_none_or(|p| s.project_id.as_deref() == Some(p)) && require_target(ready, s).is_ok()).take(200).map(|s| json!({"id":s.session_id,"projectId":s.project_id,"model":s.model,"status":execution_status(data.assignments.get(s.session_id.as_str()).map(|a|a.state.as_str()),s.status.as_str(),0),"processStatus":s.status.as_str(),"assignment":data.assignments.get(s.session_id.as_str()),"live":ready.supervisor.is_live(&s.session_id),"cwd":s.cwd,"startedBy":data.origins.get(s.session_id.as_str()),"owner":data.subagents.get(s.session_id.as_str()),"kind":if data.subagents.contains_key(s.session_id.as_str()) {"subagent"} else {"conversation"},"title":data.titles.get(s.session_id.as_str())})).collect::<Vec<_>>();
            Ok(json!({"self":caller,"sessions":sessions,"limit":200}))
        }
        Some("read") => {
            let id = v["sessionId"]
                .as_str()
                .ok_or_else(|| AppError::invalid_argument("Specify sessionId"))?;
            let result = summary(
                ready,
                caller,
                &Target {
                    session_id: id.into(),
                    after_cursor: v
                        .get("afterCursor")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                },
                true,
            )
            .await?;
            peers::observed_result(caller, &result)?;
            retire_reported_worker(ready, caller, id).await;
            Ok(result)
        }
        Some("wait") => wait(ready, caller, v).await,
        _ => Err(AppError::invalid_argument("Unknown session action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_process_failure_is_not_a_failed_assignment(){
        assert_eq!(execution_status(Some("completed"),"failed",0),"completed");
        assert!(terminal(execution_status(Some("completed"),"failed",0)));
        assert_eq!(execution_status(Some("working"),"failed",0),"failed");
        assert_eq!(execution_status(Some("working"),"Needs approval",0),"Needs approval");
        assert_eq!(execution_status(Some("completed"),"failed",1),"queued");
        assert_eq!(execution_status(None,"exited",0),"exited");
    }
    #[test]
    fn transient_retirement_failures_retry_but_dirty_workspaces_remain_retained() {
        assert!(!retirement_settled(
            &json!({"turnId":"t","workspaceRemoved":false,"reason":"session is still live"}),
            "t"
        ));
        assert!(retirement_settled(
            &json!({"turnId":"t","workspaceRemoved":false,"reason":"Uncommitted work retained in its workspace"}),
            "t"
        ));
        assert!(retirement_settled(
            &json!({"turnId":"t","workspaceRemoved":true}),
            "t"
        ));
        assert!(!retirement_settled(
            &json!({"turnId":"old","workspaceRemoved":true}),
            "t"
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cross_project_reads_and_waits_use_real_store_and_supervisor_without_model_calls() {
        use brigadier_core::{
            driver::{ProviderDriver, StartSession},
            event::{Event, ItemId, ItemKind},
        };
        use brigadier_supervisor::ReplayDriver;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let state = crate::state::AppState::pending();
        state.initialize(Ok(crate::state::build(dir.path().join("data"))
            .await
            .unwrap()));
        let ready = state.get().unwrap();
        // The production singleton is also reached by archive tests running in parallel.
        // Keep its independent directory alive for the test process, beyond this fixture.
        peers::test_service(tempfile::tempdir().unwrap().keep());
        let driver = ReplayDriver::new(vec![Event::item_completed(
            ItemId::new("reply"),
            ItemKind::AssistantText,
            "Finished review",
            None,
        )])
        .with_rate(100.0);
        let kind = driver.kind();
        ready.supervisor.register_driver(Arc::new(driver));
        std::fs::create_dir(dir.path().join("a")).unwrap();
        std::fs::create_dir(dir.path().join("b")).unwrap();
        let a = ready
            .supervisor
            .add_project(dir.path().join("a"))
            .await
            .unwrap();
        let b = ready
            .supervisor
            .add_project(dir.path().join("b"))
            .await
            .unwrap();
        let caller = ready
            .supervisor
            .start_session(&a.id, &kind, StartSession::new(&a.root_path))
            .await
            .unwrap();
        let target = ready
            .supervisor
            .start_session(&b.id, &kind, StartSession::new(&b.root_path))
            .await
            .unwrap();
        let listing = dispatch(ready, caller.as_str(), &json!({"action":"list"}))
            .await
            .unwrap();
        assert_eq!(listing["sessions"].as_array().unwrap().len(), 2);
        let filtered = dispatch(
            ready,
            caller.as_str(),
            &json!({"action":"list","projectId":b.id}),
        )
        .await
        .unwrap();
        assert_eq!(filtered["sessions"].as_array().unwrap().len(), 1);
        let request = json!({"targets":[{"sessionId":target}],"timeoutMs":2000});
        let (result, ()) = tokio::join!(wait(ready, caller.as_str(), &request), async {
            tokio::time::sleep(Duration::from_millis(40)).await;
            ready.supervisor.end_session(&target).await.unwrap();
        });
        let result = result.unwrap();
        assert_eq!(result["reason"], "ready");
        assert_eq!(result["sessions"][0]["status"], "exited");
        assert!(result["sessions"][0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"] == "Finished review"));
        let after = result["sessions"][0]["cursor"].clone();
        let repeated = wait(
            ready,
            caller.as_str(),
            &json!({"targets":[{"sessionId":target,"afterCursor":after}],"timeoutMs":0}),
        )
        .await
        .unwrap();
        assert_eq!(repeated["reason"], "timeout");
        assert!(repeated["sessions"][0]["messages"]
            .as_array()
            .unwrap()
            .is_empty());
        let missing = wait(
            ready,
            caller.as_str(),
            &json!({"targets":[{"sessionId":"missing"}],"timeoutMs":0}),
        )
        .await
        .unwrap();
        assert_eq!(missing["errors"][0]["sessionId"], "missing");
        assert!(!waits().lock().unwrap().0.contains_key(caller.as_str()));
        let request =
            json!({"targets":[{"sessionId":target,"afterCursor":after}],"timeoutMs":2000});
        let (inbox, ()) = tokio::join!(wait(ready, caller.as_str(), &request), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            peers::test_message(target.as_str(), caller.as_str(), false);
        });
        assert_eq!(inbox.unwrap()["reason"], "message");
        peers::test_message(caller.as_str(), target.as_str(), true);
        let queued = wait(
            ready,
            caller.as_str(),
            &json!({"targets":[{"sessionId":target}],"timeoutMs":0}),
        )
        .await
        .unwrap();
        assert_eq!(queued["reason"], "timeout");
        assert_eq!(queued["sessions"][0]["status"], "queued");
        peers::cancel_pending(target.as_str()).unwrap();
        let (cancelled, ()) = tokio::join!(wait(ready, caller.as_str(), &request), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            ready.supervisor.end_session(&caller).await.unwrap();
        });
        assert_eq!(cancelled.unwrap()["reason"], "interrupted");
        // The same provider execution can be persisted as an internal worker without
        // appearing as a user conversation. Fork provenance confers no ownership.
        peers::record_fork(caller.as_str(), "separate-origin").unwrap();
        peers::record_initial(
            &peers::PeerStart {
                baseline: None,
                subagent: true,
                creation_id: uuid::Uuid::new_v4().to_string(),
                from: caller.to_string(),
                title: "Internal review".into(),
                text: "Review the assignment".into(),
                attachments: vec![],
            },
            target.as_str(),
        )
        .unwrap();
        let conversations = dispatch(ready, caller.as_str(), &json!({"action":"list"}))
            .await
            .unwrap();
        assert_eq!(conversations["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(conversations["sessions"][0]["id"], caller.as_str());
        assert_eq!(conversations["sessions"][0]["kind"], "conversation");
        let workers = dispatch(ready, caller.as_str(), &json!({"action":"subagents"}))
            .await
            .unwrap();
        assert_eq!(workers["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(workers["sessions"][0]["id"], target.as_str());
        assert_eq!(workers["sessions"][0]["kind"], "subagent");
        assert!(peers::require_conversation(target.as_str()).is_err());
        assert!(peers::require_response_owner(target.as_str(), None).is_err());
        assert!(peers::require_response_owner(target.as_str(), Some(caller.as_str())).is_ok());
        assert!(dispatch(
            ready,
            "unrelated",
            &json!({"action":"read","sessionId":target})
        )
        .await
        .is_err());
        peers::test_delivery(&state, &a.id, &a.root_path).await;
        ready.supervisor.shutdown().await;
    }
    #[test]
    fn waits_reject_cycles_and_duplicate_waits() {
        let mut graph = WaitGraph::default();
        graph.insert("a", &["b".into()]).unwrap();
        graph.insert("b", &["c".into()]).unwrap();
        assert!(graph.insert("c", &["a".into()]).is_err());
        assert!(graph.insert("a", &["d".into()]).is_err());
        graph.insert("d", &["b".into()]).unwrap();
    }
    #[test]
    fn cursor_is_bound_to_session_and_suppresses_unchanged_completion() {
        let c = Cursor {
            session_id: "s".into(),
            seq: 12,
            revision: 15,
            status: "Idle".into(),
        };
        assert!(!changed(Some(&c), 15, "Idle"));
        assert!(changed(Some(&c), 16, "Idle"));
        assert!(changed(Some(&c), 15, "Needs approval"));
        let target = Target {
            session_id: "other".into(),
            after_cursor: Some(serde_json::to_string(&c).unwrap()),
        };
        assert!(cursor(&target).is_err());
        assert!(!terminal("Working"));
        assert!(!terminal("queued"));
        assert!(terminal("failed"));
    }
    #[test]
    fn completed_turn_waits_through_checkpoint_capture_but_true_rewind_stays_actionable() {
        let mut previous = Cursor {
            session_id: "s".into(),
            seq: 12,
            revision: 15,
            status: "Working".into(),
        };
        // A final message advances the cursor before its post-turn snapshot is complete.
        assert!(!ready_for_wait(Some(&previous), 16, "Checkpointing"));
        assert!(!ready_for_wait(None, 16, "Checkpointing"));
        previous.revision = 16;
        previous.status = "Checkpointing".into();
        assert!(!ready_for_wait(Some(&previous), 16, "Checkpointing"));
        assert!(ready_for_wait(Some(&previous), 16, "Idle"));
        // This transition requires no new chat event: release changes only activity status.
        previous.status = "Idle".into();
        assert!(!ready_for_wait(Some(&previous), 16, "Idle"));
        assert!(ready_for_wait(Some(&previous), 16, "Rewinding"));
    }

    #[test]
    fn wait_targets_are_bounded_and_cannot_include_self() {
        assert!(targets(&json!({"targets":[]}), "a").is_err());
        assert!(targets(&json!({"targets":[{"sessionId":"a"}]}), "a").is_err());
        assert!(targets(
            &json!({"targets":[{"sessionId":"b"},{"sessionId":"b"}]}),
            "a"
        )
        .is_err());
        assert_eq!(
            targets(&json!({"targets":[{"sessionId":"b"}]}), "a")
                .unwrap()
                .len(),
            1
        );
    }
}
