//! Read-only cross-session coordination. Waiting holds no lifecycle or store locks.
use crate::{error::AppError, navigation, peers, state::Ready};
use brigadier_core::{
    event::{Envelope, Event, RequestId, SessionId, TurnId},
    session::NativeControl,
};
use brigadier_store::SessionRecord;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::Duration,
};

// ---------------------------------------------------------------------------
// Edges
//
// Three watches, narrowest last. A feed batch bumps none of them by itself: only the signals
// that move something a consumer reads do, through `observe_activity`. Before 2026-09-11 the
// sink bumped `changes()` on every batch, so two always-on tasks woke at batch rate — up to
// 60 times a second while a session streamed — to re-derive state that had not moved.
//
//   `subscribe()`          cross-session waiters (`wait`): peer/composer state, or activity.
//   `subscribe_queue()`    the composer drain loop: everything `composer::drain_one` reads.
//   `subscribe_activity()` keep-awake: the count of working sessions, and a staleness token.
// ---------------------------------------------------------------------------

/// What the activity edge carries.
///
/// **"Activity" means exactly what the provider adapters report as `status == "Working"`:** a
/// turn is open on the session and nothing is blocking it. Both adapters compute that status
/// from two pieces of state, and both emit an event at every mutation of either, so it can be
/// derived from the event stream instead of asked for over an RPC:
///
/// - Claude (`crates/core/src/claude/adapter.rs:1708`) ranks `Rewinding` > `Needs approval` >
///   `Working` > `Idle`. `open_turn` is set only alongside an emitted [`Event::TurnStarted`]
///   (`:1042-1047`, `:2029-2037`) and cleared only alongside [`Event::TurnCompleted`] or
///   [`Event::TurnAborted`] (`:2047-2053`, `:2123`); `open_permissions` is inserted only
///   alongside [`Event::RequestOpened`] (`:1458`, `:1469`) and removed only alongside
///   [`Event::RequestResolved`] (`:1584`, `:2110-2118`). `Rewinding` cannot overlap a turn:
///   every path that sets `rewind_paused` first requires `open_turn.is_none()` (`:1714-1727`,
///   `:1734`, `:1748`, `:1783`), so dropping it from this model loses no case.
/// - Codex (`crates/core/src/codex/adapter.rs:469`) ranks `Needs approval` > `Working` >
///   `Idle`, from the same two pieces.
///
/// Native background work is covered. A Claude `Task` subagent has its own status
/// (`adapter.rs:872` writes `task["status"]`, never the session's), and it runs inside its
/// parent's turn, so the parent's `open_turn` — and this model — stays working until the last
/// of them finishes and the turn completes.
///
/// Not covered, deliberately: a provider that stops emitting turn events altogether. That
/// failure empties the feed as well, so it is not silent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    /// How many sessions are working.
    pub busy: usize,
    /// A staleness token for an answer a consumer cached about **one** session.
    ///
    /// Bumped by every turn/request/session signal, not only by one that moved [`Self::busy`].
    /// Owner A completing in the same batch as B starting holds the count at 1, so a consumer
    /// that keyed its cache off the count alone would never re-ask and would never deliver A's
    /// completion (`peers::OwnerActivity`). Also bumped by a re-decision no session caused at
    /// all, such as the keep-awake preference changing; every consumer re-decides idempotently.
    pub epoch: u64,
}

/// One session's open turns and the requests parked against them.
#[derive(Default)]
struct SessionActivity {
    turns: HashSet<TurnId>,
    blocked: HashSet<RequestId>,
}
impl SessionActivity {
    fn busy(&self) -> bool {
        !self.turns.is_empty() && self.blocked.is_empty()
    }
    fn settled(&self) -> bool {
        self.turns.is_empty() && self.blocked.is_empty()
    }
}
/// Only sessions with something open are held, so the map is empty whenever the app is idle.
#[derive(Default)]
struct Sessions(HashMap<String, SessionActivity>);
impl Sessions {
    fn entry(&mut self, id: &str) -> &mut SessionActivity {
        self.0.entry(id.to_owned()).or_default()
    }
    /// Apply `f` to an existing record, and forget the record once nothing is open on it.
    fn close(&mut self, id: &str, f: impl FnOnce(&mut SessionActivity)) {
        if let Some(entry) = self.0.get_mut(id) {
            f(entry);
            if entry.settled() {
                self.0.remove(id);
            }
        }
    }
    fn busy(&self) -> usize {
        self.0.values().filter(|s| s.busy()).count()
    }
}

/// Which edges one batch of signals earns. A batch that moves nothing earns none, and then no
/// task wakes at all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Edges {
    /// The number of working sessions changed.
    activity: bool,
    /// Some session's turns or blocking requests moved, whether or not the total did. This is
    /// what invalidates an answer cached about one session; see [`Activity::epoch`].
    status: bool,
    /// Something the composer drain loop reads changed.
    queue: bool,
}

static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();
fn sessions() -> &'static Mutex<Sessions> {
    SESSIONS.get_or_init(Mutex::default)
}
static CHANGES: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn changes() -> &'static tokio::sync::watch::Sender<u64> {
    CHANGES.get_or_init(|| tokio::sync::watch::channel(0).0)
}
static QUEUE: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn queue() -> &'static tokio::sync::watch::Sender<u64> {
    QUEUE.get_or_init(|| tokio::sync::watch::channel(0).0)
}
static ACTIVITY: OnceLock<tokio::sync::watch::Sender<Activity>> = OnceLock::new();
fn activity_edge() -> &'static tokio::sync::watch::Sender<Activity> {
    ACTIVITY.get_or_init(|| tokio::sync::watch::channel(Activity::default()).0)
}

/// Cross-session waiters. Coarse on purpose: [`wait`] re-reads the store and the peer file on
/// every wake, and keeps its own bounded fallback for persistence lag.
pub(crate) fn subscribe() -> tokio::sync::watch::Receiver<u64> {
    changes().subscribe()
}
/// The composer drain loop: queue contents, peer ownership, session activity and observed
/// provider allowance are the whole of what `composer::drain_one` reads.
pub(crate) fn subscribe_queue() -> tokio::sync::watch::Receiver<u64> {
    queue().subscribe()
}
/// Keep-awake, and any consumer caching a per-session answer. The receiver's current value is the
/// live count, so a task that subscribes late still decides correctly on its first pass.
pub(crate) fn subscribe_activity() -> tokio::sync::watch::Receiver<Activity> {
    activity_edge().subscribe()
}

/// Peer or composer state changed: ownership, a message, an assignment, a queue, a draft.
/// Never called per feed batch.
pub(crate) fn notify() {
    changes().send_modify(|v| *v = v.wrapping_add(1));
    queue().send_modify(|v| *v = v.wrapping_add(1));
}
/// The keep-awake preference or shutdown flag changed; its task must re-decide although no
/// session moved.
pub(crate) fn notify_keep_awake() {
    activity_edge().send_modify(|a| a.epoch = a.epoch.wrapping_add(1));
}

/// Fold one feed batch's signals into the activity model and wake only the tasks it concerns.
///
/// Signals are rare — `brigadier_supervisor::batcher::is_signal` admits ten event kinds, none of
/// them the per-token `ContentDelta` — so this walk costs nothing next to the batch it rides on.
pub(crate) fn observe_activity(signals: &[Envelope]) {
    if signals.is_empty() {
        return;
    }
    let edges = {
        let mut model = sessions().lock().unwrap_or_else(|e| e.into_inner());
        fold(&mut model, signals, activity_edge())
    };
    if edges.queue {
        notify();
    }
}

/// Apply one batch and publish the activity edge it earns, both under the caller's model guard.
///
/// Publishing inside the guard is what keeps the watch honest. Two folds racing would otherwise
/// each compute a count under the lock and then publish outside it, in either order, and leave
/// the watch showing a count that no fold ever ended on.
fn fold(
    model: &mut Sessions,
    signals: &[Envelope],
    edge: &tokio::sync::watch::Sender<Activity>,
) -> Edges {
    let edges = apply_signals(model, signals);
    if edges.activity || edges.status {
        let busy = model.busy();
        edge.send_modify(|a| {
            a.busy = busy;
            if edges.status {
                a.epoch = a.epoch.wrapping_add(1);
            }
        });
    }
    edges
}

fn apply_signals(model: &mut Sessions, signals: &[Envelope]) -> Edges {
    let before = model.busy();
    let mut edges = Edges::default();
    for env in signals {
        let id = env.session_id.as_str();
        match &env.event {
            // A start is a fresh provider execution on the same identity, an exit is the end of
            // one: either way nothing that was open on the old process is open any more.
            Event::SessionStarted { .. } | Event::SessionExited { .. } => {
                model.0.remove(id);
                edges.status = true;
            }
            Event::TurnStarted { turn_id } => {
                model.entry(id).turns.insert(turn_id.clone());
                edges.status = true;
            }
            Event::TurnCompleted { turn_id, .. } | Event::TurnAborted { turn_id, .. } => {
                model.close(id, |s| {
                    s.turns.remove(turn_id);
                });
                edges.status = true;
            }
            Event::RequestOpened { request_id, .. } => {
                model.entry(id).blocked.insert(request_id.clone());
                edges.status = true;
            }
            Event::RequestResolved { request_id, .. } => {
                model.close(id, |s| {
                    s.blocked.remove(request_id);
                });
                edges.status = true;
            }
            // An observed usage window is the only thing that releases a queue parked on an
            // exhausted account before its reported reset.
            Event::UsageWindows { .. } => edges.queue = true,
            _ => {}
        }
    }
    // Everything that moves a session also moves what the composer drain loop reads.
    edges.queue |= edges.status;
    edges.activity = model.busy() != before;
    edges
}

/// The sessions this model believes are working.
fn busy_sessions() -> Vec<String> {
    sessions()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .0
        .iter()
        .filter(|(_, s)| s.busy())
        .map(|(id, _)| id.clone())
        .collect()
}

/// Correct the model for one session against what the provider actually reports.
///
/// The model is fed by a lossy transport: `brigadier_supervisor::batcher` drops the **oldest**
/// signal once a project's buffer is full (`PROJECT_SIGNAL_CAP`), so a dropped `TurnCompleted`
/// would otherwise leave a session working for the rest of the process's life — and the machine
/// awake with it. `working == true` is not acted on: a session the model already counts is
/// already right, and a record dropped here is rebuilt by the next `TurnStarted`.
pub(crate) fn reconcile(session_id: &str, working: bool) {
    if working {
        return;
    }
    let mut model = sessions().lock().unwrap_or_else(|e| e.into_inner());
    let before = model.busy();
    if model.0.remove(session_id).is_none() {
        return;
    }
    let busy = model.busy();
    if busy != before {
        // Inside the guard, for the reason [`fold`] gives.
        activity_edge().send_modify(|a| a.busy = busy);
    }
}

/// Ask the provider about every session the model believes is working, and forget the record of
/// any that is not.
///
/// One `NativeControl::Activity` round trip per believed-busy session — adapter memory, not a
/// model call or a network call. The caller is [`crate::keep_awake`], which runs this **only**
/// while it is actually holding a power assertion and at most once per 45 s renewal, so an idle
/// app pays nothing at all and a working one pays a handful of round trips a minute.
pub(crate) async fn verify_busy(ready: &Ready) {
    for id in busy_sessions() {
        let session = SessionId::new(&id);
        if !ready.supervisor.is_live(&session) {
            reconcile(&id, false);
            continue;
        }
        match tokio::time::timeout(
            Duration::from_secs(1),
            ready
                .supervisor
                .native_control(&session, NativeControl::Activity),
        )
        .await
        {
            // `"Working"` is the adapters' own word for it; see [`Activity`].
            Ok(Ok(value)) => reconcile(&id, value["status"] == "Working"),
            // No answer is not an answer. Leave the record alone and ask again next renewal.
            _ => continue,
        }
    }
}

/// Test hook: raise the activity edge a provider status change raises.
///
/// A fake driver in a test flips its reported status behind the event stream's back, and every
/// consumer here is entitled to keep its cached answer until an edge says otherwise
/// ([`Activity::epoch`]). Never called by the app.
#[cfg(test)]
pub(crate) fn test_activity_edge() {
    activity_edge().send_modify(|a| a.epoch = a.epoch.wrapping_add(1));
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
    // The only consumer of the general edge, and the only loop that still re-reads rather than
    // being told what changed. It keeps its own bounded fallback below for persistence lag.
    let mut changes = subscribe();
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
    use brigadier_core::event::{AbortReason, InstanceId, StopReason, Usage};

    fn env(session: &str, event: Event) -> Envelope {
        Envelope::new(1, InstanceId::new("i"), SessionId::new(session), event)
    }
    fn started(turn: &str) -> Event {
        Event::TurnStarted {
            turn_id: TurnId::new(turn),
        }
    }
    fn completed(turn: &str) -> Event {
        Event::TurnCompleted {
            turn_id: TurnId::new(turn),
            stop_reason: StopReason::EndTurn,
            usage: Usage::default(),
            cost_usd_cumulative: 0.0,
        }
    }
    fn opened(request: &str) -> Event {
        Event::RequestOpened {
            request_id: RequestId::new(request),
            kind: brigadier_core::event::RequestKind::UserInput {
                prompt: "?".into(),
                options: vec![],
            },
            turn_id: None,
        }
    }
    fn resolved(request: &str) -> Event {
        Event::RequestResolved {
            request_id: RequestId::new(request),
            decision: brigadier_core::session::Decision::deny("no"),
        }
    }

    /// The edge a feed batch earns is the whole of what wakes keep-awake and the composer, so
    /// this is the boundary the batch-rate wake was removed at.
    #[test]
    fn only_signals_that_move_a_session_earn_an_edge() {
        let mut model = Sessions::default();
        // Rows, counters and content deltas carry no signal at all; these do carry one and
        // still move nothing either consumer reads.
        for quiet in [
            Event::RuntimeWarning {
                message: "slow".into(),
            },
            Event::SessionCompacting,
        ] {
            assert_eq!(
                apply_signals(&mut model, &[env("s", quiet)]),
                Edges::default(),
                "a signal that moves nothing must wake nothing"
            );
        }
        assert_eq!(model.busy(), 0);

        // A turn opens: both edges, because keep-awake must assert and the composer must stop
        // trying to send into a busy session.
        assert_eq!(
            apply_signals(&mut model, &[env("s", started("t1"))]),
            Edges {
                activity: true,
                status: true,
                queue: true
            }
        );
        assert_eq!(model.busy(), 1);
        // A second turn on a second session is an activity edge (the count moved) ...
        assert!(apply_signals(&mut model, &[env("other", started("t2"))]).activity);
        assert_eq!(model.busy(), 2);
        // ... and a usage window is a queue edge only: it can release a parked queue, but no
        // session started or stopped working.
        assert_eq!(
            apply_signals(
                &mut model,
                &[env(
                    "s",
                    Event::UsageWindows {
                        status: "allowed".into(),
                        windows: vec![]
                    }
                )]
            ),
            Edges {
                activity: false,
                status: false,
                queue: true
            }
        );

        // An approval parks the turn: the adapter reports "Needs approval", not "Working", so
        // the lease is released exactly as it was before this was derived from events.
        assert!(apply_signals(&mut model, &[env("s", opened("r1"))]).activity);
        assert_eq!(model.busy(), 1);
        assert!(apply_signals(&mut model, &[env("s", resolved("r1"))]).activity);
        assert_eq!(model.busy(), 2);

        // One batch can hold both halves of a transition and then net to nothing.
        assert_eq!(
            apply_signals(
                &mut model,
                &[env("s", opened("r2")), env("s", resolved("r2"))]
            ),
            Edges {
                activity: false,
                status: true,
                queue: true
            }
        );
        assert_eq!(model.busy(), 2);

        assert!(apply_signals(&mut model, &[env("s", completed("t1"))]).activity);
        assert_eq!(model.busy(), 1);
        // An aborted turn and an exited session both settle; nothing is retained for either.
        assert!(apply_signals(
            &mut model,
            &[env(
                "other",
                Event::TurnAborted {
                    turn_id: TurnId::new("t2"),
                    reason: AbortReason::Killed
                }
            )]
        )
        .activity);
        assert_eq!(model.busy(), 0);
        assert!(model.0.is_empty(), "an idle app retains no activity records");
    }

    #[test]
    fn a_session_that_dies_mid_turn_is_forgotten_and_a_restart_starts_clean() {
        let mut model = Sessions::default();
        apply_signals(&mut model, &[env("s", started("t1"))]);
        assert_eq!(model.busy(), 1);
        // No TurnCompleted: the adapter synthesises one on exit, but a lost stream must not
        // leave a phantom working session holding the machine awake either.
        assert!(apply_signals(
            &mut model,
            &[env(
                "s",
                Event::SessionExited {
                    reason: brigadier_core::event::ExitReason::Crashed,
                    exit_code: Some(1)
                }
            )]
        )
        .activity);
        assert_eq!(model.busy(), 0);
        assert!(model.0.is_empty());

        apply_signals(&mut model, &[env("s", started("t1"))]);
        apply_signals(
            &mut model,
            &[env(
                "s",
                Event::SessionStarted {
                    provider_session_id: "p".into(),
                    model: "m".into(),
                    cwd: std::path::PathBuf::from("/tmp"),
                    capabilities: vec![],
                    resume_token: None,
                },
            )],
        );
        assert_eq!(model.busy(), 0, "a fresh execution inherits no open turn");
    }

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

    /// The bug this is the regression test for: a consumer's cached "this owner is still
    /// working" answer is invalidated by the edge, and the edge used to fire only when the
    /// **total** moved. A completing in the same batch as B starting holds the total at 1, so
    /// `peers::OwnerActivity` never re-asked and the completion was never delivered.
    #[test]
    fn a_completion_and_a_start_in_one_batch_still_invalidate_a_cached_answer() {
        let (tx, mut rx) = tokio::sync::watch::channel(Activity::default());
        let mut model = Sessions::default();
        assert!(fold(&mut model, &[env("a", started("t1"))], &tx).activity);
        rx.borrow_and_update();
        assert_eq!(tx.borrow().busy, 1);

        let edges = fold(
            &mut model,
            &[env("a", completed("t1")), env("b", started("t2"))],
            &tx,
        );
        assert!(
            !edges.activity,
            "one session was working before and one after: the count did not move"
        );
        assert!(edges.status, "but two sessions moved, so a cached answer is stale");
        assert_eq!(tx.borrow().busy, 1);
        assert!(
            rx.has_changed().unwrap(),
            "the waiter must be told to ask again"
        );

        // A batch that moves no session at all still wakes nobody.
        rx.borrow_and_update();
        fold(&mut model, &[env("a", Event::SessionCompacting)], &tx);
        assert!(!rx.has_changed().unwrap());
    }

    /// Publishing outside the model guard lets two folds publish out of order and strand the
    /// watch on a count neither of them ended on. The invariant is global, so other tests
    /// folding concurrently cannot make this one lie.
    #[test]
    fn concurrent_folds_leave_the_watch_agreeing_with_the_model() {
        std::thread::scope(|scope| {
            for thread in 0..8 {
                scope.spawn(move || {
                    for i in 0..200 {
                        let id = format!("race-{thread}-{i}");
                        observe_activity(&[env(&id, started("t"))]);
                        observe_activity(&[env(&id, completed("t"))]);
                    }
                });
            }
        });
        let model = sessions().lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            activity_edge().borrow().busy,
            model.busy(),
            "the published count is the count the last fold ended on"
        );
        assert!(!model.0.keys().any(|id| id.starts_with("race-")));
    }

    /// A `TurnCompleted` the transport dropped leaves the model working for ever. The provider
    /// is the authority, and the record it does not back is forgotten.
    #[test]
    fn a_record_the_provider_does_not_back_is_dropped_and_republished() {
        let id = format!("stuck-{}", uuid::Uuid::new_v4());
        observe_activity(&[env(&id, started("t"))]);
        assert!(busy_sessions().contains(&id));

        reconcile(&id, true);
        assert!(
            busy_sessions().contains(&id),
            "a session the provider confirms is working keeps its record"
        );

        reconcile(&id, false);
        assert!(!busy_sessions().contains(&id));
        let model = sessions().lock().unwrap_or_else(|e| e.into_inner());
        assert!(!model.0.contains_key(&id));
        assert_eq!(activity_edge().borrow().busy, model.busy());
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
