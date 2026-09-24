//! The provider runtime: live CLI sessions, their event streams, approvals, the cleanup ledger
//! and what Brigadier knows about each provider.
//!
//! In Phase 2 its sessions are "raw" sessions driven from the Inspector. Each one:
//!
//! - streams its normalized events into `raw:<id>`, with text deltas merged over
//!   [`DELTA_WINDOW`] so the store is not hit on every token;
//! - has its approvals routed by [`policy::route`]: Brigadier answers what stays inside the
//!   session's access, the user the rest;
//! - records every artifact its CLI creates in the cleanup ledger before relying on it, and
//!   removes exactly those when it is closed, when it fails to start, or in the crash sweep.
//!
//! A stopped session keeps its CLI session so it can be resumed; closing it removes everything.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use brigadier_providers::claude::Claude;
use brigadier_providers::cli::CliEnv;
use brigadier_providers::codex::Codex;
use brigadier_providers::policy::{self, ApprovalMode, Route};
use brigadier_providers::record::{self, Recording};
use brigadier_providers::{
    Access, ApprovalDecision, Artifact, Decider, Ledger, ModelCatalog, Origin, Provider,
    ProviderEvent, ProviderKind, ProviderSession, SessionSpec, Started, cleanup, fixtures,
    simulate,
};
use brigadier_sandbox::Platform;
use brigadier_store::{NewEvent, Retention, StreamPage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::model::{
    DomainEvent, Fixture, ProviderOverview, ProvidersView, RawApprovals, RawEntry, RawPage,
    RawSession, RawSessionId, RawSource, RawState, streams,
};
use crate::{Core, Error, Result, now_ms};

/// Text deltas arriving within this window are stored as one event.
const DELTA_WINDOW: Duration = Duration::from_millis(30);
/// How long a quit waits for sessions to end and their last events to be stored.
const SHUTDOWN_PUMPS: Duration = Duration::from_secs(3);
/// Live quota updates are stored as provider overviews at most this often.
const QUOTA_RECORD_INTERVAL_MS: i64 = 10_000;
/// Longest pause kept between lines when replaying a recording.
const REPLAY_MAX_GAP: Duration = Duration::from_millis(250);
const PROVIDER_CHECKS_KEPT: u32 = 100;
const STREAM_PAGE: u32 = 1_000;

/// Runs a task on the daemon's instrumented runtime.
pub type Spawner = Arc<dyn Fn(Pin<Box<dyn Future<Output = ()> + Send>>) + Send + Sync>;

/// What the Inspector asks for when it starts a raw session.
#[derive(Debug, Clone)]
pub struct StartRaw {
    pub provider: ProviderKind,
    pub cwd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub access: Access,
    pub approvals: RawApprovals,
    pub record: bool,
}

struct Live {
    session: Arc<dyn ProviderSession>,
    /// Approvals waiting for the user.
    pending: HashSet<String>,
    /// Cancelled once the session's event pump has stored its last event.
    ended: CancellationToken,
}

#[derive(Default)]
struct State {
    sessions: HashMap<RawSessionId, RawSession>,
    live: HashMap<RawSessionId, Live>,
    /// Artifacts not yet removed, by owning session.
    ledger: HashMap<RawSessionId, Vec<Artifact>>,
    overviews: HashMap<ProviderKind, ProviderOverview>,
    quota_recorded_ms: HashMap<ProviderKind, i64>,
    refreshing: bool,
}

pub struct Runtime {
    core: Arc<Core>,
    platform: Arc<dyn Platform>,
    claude: Arc<Claude>,
    codex: Arc<Codex>,
    spawner: Spawner,
    state: Mutex<State>,
    admitting: AtomicBool,
    pumps: TaskTracker,
    cache_dir: PathBuf,
    recordings_dir: PathBuf,
}

impl Runtime {
    /// Loads raw sessions and the ledger, sweeps what a crashed daemon left behind, and starts
    /// checking the providers.
    pub async fn start(
        core: Arc<Core>,
        platform: Arc<dyn Platform>,
        spawner: Spawner,
    ) -> Result<Arc<Self>> {
        let env = {
            let platform = platform.clone();
            tokio::task::spawn_blocking(move || CliEnv::capture(&platform))
                .await
                .map_err(|err| Error::Invalid(format!("capturing the login environment: {err}")))?
        };
        let env = Arc::new(env);
        let data_dir = platform.paths().data_dir.clone();
        let runtime = Arc::new(Self {
            claude: Arc::new(Claude::new(platform.clone(), env.clone())),
            codex: Arc::new(Codex::new(platform.clone(), env)),
            core,
            platform,
            spawner,
            state: Mutex::new(State::default()),
            admitting: AtomicBool::new(true),
            pumps: TaskTracker::new(),
            cache_dir: data_dir.join("cache"),
            recordings_dir: record::recordings_dir(&data_dir),
        });
        runtime.load().await?;
        runtime.sweep().await;
        runtime.refresh_providers();
        Ok(runtime)
    }

    fn provider(&self, kind: ProviderKind) -> Arc<dyn Provider> {
        match kind {
            ProviderKind::Claude => self.claude.clone(),
            ProviderKind::Codex => self.codex.clone(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        (self.spawner)(Box::pin(task));
    }

    fn admit(&self) -> Result<()> {
        if self.admitting.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(Error::Invalid("Brigadier is shutting down".into()))
        }
    }

    async fn load(&self) -> Result<()> {
        let mut sessions: HashMap<RawSessionId, RawSession> = HashMap::new();
        for event in self.read_all(streams::RAW).await? {
            match event {
                DomainEvent::RawSessionCreated { session } => {
                    sessions.insert(session.id.clone(), session);
                }
                DomainEvent::RawSessionUpdated {
                    id,
                    state,
                    native_id,
                    error,
                } => {
                    if let Some(session) = sessions.get_mut(&id) {
                        apply_update(session, state, native_id, error);
                    }
                }
                _ => {}
            }
        }
        let mut ledger: HashMap<RawSessionId, Vec<Artifact>> = HashMap::new();
        for event in self.read_all(streams::CLEANUP).await? {
            match event {
                DomainEvent::CleanupRecorded { owner, artifact } => {
                    let artifacts = ledger.entry(owner).or_default();
                    if !artifacts.contains(&artifact) {
                        artifacts.push(artifact);
                    }
                }
                DomainEvent::CleanupCompleted { owner, .. } => {
                    ledger.remove(&owner);
                }
                _ => {}
            }
        }
        let cached = {
            let dir = self.cache_dir.clone();
            tokio::task::spawn_blocking(move || read_model_cache(&dir))
                .await
                .unwrap_or_default()
        };
        let mut state = self.state();
        state.sessions = sessions;
        state.ledger = ledger;
        for kind in ProviderKind::ALL {
            state.overviews.insert(
                kind,
                ProviderOverview {
                    provider: kind,
                    status: None,
                    models: cached
                        .iter()
                        .find(|catalog| catalog.provider == kind)
                        .cloned(),
                    quota: None,
                    error: None,
                    checked_at_ms: None,
                },
            );
        }
        Ok(())
    }

    async fn read_all(&self, stream: &str) -> Result<Vec<DomainEvent>> {
        let mut events = Vec::new();
        let mut after = 0;
        loop {
            let page = self
                .core
                .store()
                .read_stream_since(stream.into(), after, STREAM_PAGE)
                .await?;
            for event in &page {
                after = event.stream_seq;
                events.push(crate::sessions::decode(event)?);
            }
            if page.len() < STREAM_PAGE as usize {
                return Ok(events);
            }
        }
    }

    /// Crash sweep: whatever the previous daemon left running is ended; sessions that were
    /// running become stopped (resumable); sessions that never started, or were being closed,
    /// have their artifacts removed.
    async fn sweep(self: &Arc<Self>) {
        let (processes, sessions) = {
            let state = self.state();
            let processes: Vec<Artifact> = state
                .ledger
                .values()
                .flatten()
                .filter(|artifact| matches!(artifact, Artifact::Process { .. }))
                .cloned()
                .collect();
            (
                processes,
                state.sessions.values().cloned().collect::<Vec<_>>(),
            )
        };
        let platform = self.platform.clone();
        let ended = tokio::task::spawn_blocking(move || {
            processes
                .iter()
                .filter(|artifact| match artifact {
                    Artifact::Process { pid, started_at_ms } => {
                        cleanup::end_process(&*platform, *pid, *started_at_ms)
                    }
                    _ => false,
                })
                .count()
        })
        .await
        .unwrap_or_default();
        if ended > 0 {
            tracing::info!(ended, "ended CLI processes left by a previous daemon");
        }

        for session in sessions {
            match session.state {
                RawState::Running => {
                    self.set_state(&session.id, RawState::Stopped, None, None)
                        .await;
                }
                RawState::Starting => {
                    let resumable = session.native_id.is_some();
                    if resumable {
                        self.set_state(&session.id, RawState::Stopped, None, None)
                            .await;
                    } else {
                        self.set_state(
                            &session.id,
                            RawState::Failed,
                            None,
                            Some("Brigadier quit while it was starting".into()),
                        )
                        .await;
                        let runtime = self.clone();
                        self.spawn(async move { runtime.remove_artifacts(&session.id).await });
                    }
                }
                RawState::Closing => {
                    let runtime = self.clone();
                    self.spawn(async move {
                        runtime.remove_artifacts(&session.id).await;
                        runtime
                            .set_state(&session.id, RawState::Closed, None, None)
                            .await;
                    });
                }
                RawState::Stopped | RawState::Failed | RawState::Closed => {}
            }
        }
    }

    /// Stops admitting work, ends every live session (bounded) and waits for their last
    /// events to be stored. Call before the store shuts down.
    pub async fn shutdown(&self) {
        self.admitting.store(false, Ordering::Release);
        let sessions: Vec<Arc<dyn ProviderSession>> = self
            .state()
            .live
            .values()
            .map(|live| live.session.clone())
            .collect();
        if !sessions.is_empty() {
            tracing::info!(count = sessions.len(), "ending CLI sessions");
        }
        let closing = TaskTracker::new();
        for session in sessions {
            closing.spawn(async move { session.close().await });
        }
        closing.close();
        closing.wait().await;
        self.pumps.close();
        if tokio::time::timeout(SHUTDOWN_PUMPS, self.pumps.wait())
            .await
            .is_err()
        {
            tracing::warn!("CLI session events were still being stored at shutdown");
        }
    }

    // ----- providers -------------------------------------------------------------------

    pub async fn view(&self) -> ProvidersView {
        let fixtures = {
            let dir = self.recordings_dir.clone();
            tokio::task::spawn_blocking(move || list_fixtures(&dir))
                .await
                .unwrap_or_default()
        };
        let state = self.state();
        let mut sessions: Vec<RawSession> = state.sessions.values().cloned().collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.created_at_ms));
        ProvidersView {
            providers: ProviderKind::ALL
                .iter()
                .filter_map(|kind| state.overviews.get(kind).cloned())
                .collect(),
            sessions,
            fixtures,
        }
    }

    /// Checks every provider in the background: login, live models (cached on disk) and
    /// quota. Results arrive as `providerChecked` events.
    pub fn refresh_providers(self: &Arc<Self>) {
        {
            let mut state = self.state();
            if state.refreshing {
                return;
            }
            state.refreshing = true;
        }
        let runtime = self.clone();
        self.spawn(async move {
            let (claude, codex) = tokio::join!(
                runtime.check(ProviderKind::Claude),
                runtime.check(ProviderKind::Codex)
            );
            for overview in [claude, codex] {
                runtime.record_overview(overview).await;
            }
            runtime.state().refreshing = false;
        });
    }

    async fn check(&self, kind: ProviderKind) -> ProviderOverview {
        let provider = self.provider(kind);
        let previous = self.state().overviews.get(&kind).cloned();
        let status = provider.status().await;
        let mut overview = ProviderOverview {
            provider: kind,
            models: previous
                .as_ref()
                .and_then(|overview| overview.models.clone()),
            quota: previous.and_then(|overview| overview.quota),
            status: Some(status.clone()),
            error: None,
            checked_at_ms: Some(now_ms()),
        };
        if !status.logged_in {
            return overview;
        }
        let (models, quota) = tokio::join!(provider.models(), provider.quota());
        let mut errors = Vec::new();
        match models {
            Ok(catalog) => {
                let dir = self.cache_dir.clone();
                let cached = catalog.clone();
                let _ = tokio::task::spawn_blocking(move || write_model_cache(&dir, &cached)).await;
                overview.models = Some(catalog);
            }
            Err(err) => errors.push(format!("models: {err}")),
        }
        match quota {
            Ok(quota) => overview.quota = Some(quota),
            Err(err) => errors.push(format!("quota: {err}")),
        }
        overview.error = (!errors.is_empty()).then(|| errors.join("; "));
        overview
    }

    async fn record_overview(&self, overview: ProviderOverview) {
        self.state()
            .overviews
            .insert(overview.provider, overview.clone());
        let event = DomainEvent::ProviderChecked { overview };
        let result = async {
            let new = new_event(streams::PROVIDERS, &event)?;
            self.core
                .store()
                .append_with(
                    vec![new],
                    Some(Retention {
                        keep_last: PROVIDER_CHECKS_KEPT,
                    }),
                )
                .await?;
            Ok::<_, Error>(())
        }
        .await;
        if let Err(err) = result {
            tracing::warn!(error = %err, "could not record a provider check");
        }
    }

    // ----- raw sessions ----------------------------------------------------------------

    pub async fn start_session(self: &Arc<Self>, request: StartRaw) -> Result<RawSession> {
        self.admit()?;
        let cwd = PathBuf::from(request.cwd.trim());
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(Error::Invalid(format!(
                "{} is not an existing absolute directory",
                cwd.display()
            )));
        }
        let id = RawSessionId::generate();
        let recording = request.record.then(|| {
            self.recordings_dir
                .join(format!("{}-{id}.jsonl", request.provider))
        });
        let now = now_ms();
        let session = RawSession {
            id: id.clone(),
            provider: request.provider,
            source: RawSource::Live,
            cwd: Some(cwd.display().to_string()),
            model: request.model.clone().filter(|model| !model.is_empty()),
            effort: request.effort.clone().filter(|effort| !effort.is_empty()),
            access: request.access.clone(),
            approvals: request.approvals,
            native_id: None,
            parent_id: None,
            state: RawState::Starting,
            error: None,
            recording: recording.as_ref().map(|path| path.display().to_string()),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.create(session.clone()).await?;
        let spec = spec_for(&session, Origin::New, recording);
        self.launch(id, spec, true);
        Ok(session)
    }

    /// Starts the stopped session's CLI session again, under the same raw session.
    pub async fn resume_session(self: &Arc<Self>, id: RawSessionId) -> Result<RawSession> {
        self.admit()?;
        let session = self.session(&id)?;
        let native_id = match (&session.source, session.state, &session.native_id) {
            (RawSource::Live, RawState::Stopped, Some(native_id)) => native_id.clone(),
            _ => {
                return Err(Error::Invalid(
                    "only a stopped live session can be resumed".into(),
                ));
            }
        };
        self.set_state(&id, RawState::Starting, None, None).await;
        let spec = spec_for(&session, Origin::Resume { native_id }, None);
        self.launch(id.clone(), spec, false);
        self.session(&id)
    }

    /// Branches a new raw session off this one's CLI session.
    pub async fn fork_session(self: &Arc<Self>, id: RawSessionId) -> Result<RawSession> {
        self.admit()?;
        let parent = self.session(&id)?;
        let native_id = match (&parent.source, &parent.native_id, parent.state) {
            (RawSource::Live, Some(native_id), RawState::Running | RawState::Stopped) => {
                native_id.clone()
            }
            _ => {
                return Err(Error::Invalid(
                    "only a started live session that is not closed can be forked".into(),
                ));
            }
        };
        let now = now_ms();
        let fork = RawSession {
            id: RawSessionId::generate(),
            parent_id: Some(parent.id.clone()),
            native_id: None,
            state: RawState::Starting,
            error: None,
            recording: None,
            created_at_ms: now,
            updated_at_ms: now,
            ..parent
        };
        self.create(fork.clone()).await?;
        let spec = spec_for(&fork, Origin::Fork { native_id }, None);
        self.launch(fork.id.clone(), spec, true);
        Ok(fork)
    }

    pub async fn send(&self, id: &RawSessionId, text: String, steer: bool) -> Result<()> {
        let session = self.live(id)?;
        let result = if steer {
            session.steer(text).await
        } else {
            session.send(text).await
        };
        result.map_err(provider_error)
    }

    pub async fn interrupt(&self, id: &RawSessionId) -> Result<()> {
        self.live(id)?.interrupt().await.map_err(provider_error)
    }

    /// The user's answer to an approval Brigadier could not answer on its own.
    pub async fn answer(
        &self,
        id: &RawSessionId,
        approval_id: String,
        decision: ApprovalDecision,
    ) -> Result<()> {
        let session = {
            let mut state = self.state();
            let live = state
                .live
                .get_mut(id)
                .ok_or_else(|| Error::Invalid("the session is not running".into()))?;
            if !live.pending.remove(&approval_id) {
                return Err(Error::NotFound(format!("approval {approval_id}")));
            }
            live.session.clone()
        };
        session
            .answer(approval_id.clone(), decision.clone())
            .await
            .map_err(provider_error)?;
        self.record_raw(
            id,
            vec![ProviderEvent::ApprovalResolved {
                id: approval_id,
                decision,
                decided_by: Decider::User,
            }],
        )
        .await;
        Ok(())
    }

    /// Ends the CLI process, keeping its CLI session for a later resume.
    pub async fn stop_session(&self, id: &RawSessionId) -> Result<()> {
        let session = self.live(id)?;
        session.close().await;
        Ok(())
    }

    /// Disposes of a session: ends its process and removes everything its CLI created. The
    /// transcript stays in Brigadier.
    pub async fn close_session(self: &Arc<Self>, id: RawSessionId) -> Result<RawSession> {
        let session = self.session(&id)?;
        if matches!(session.state, RawState::Closing | RawState::Closed) {
            return Ok(session);
        }
        self.set_state(&id, RawState::Closing, None, None).await;
        let runtime = self.clone();
        let closing = id.clone();
        self.spawn(async move {
            let live = runtime
                .state()
                .live
                .get(&closing)
                .map(|live| (live.session.clone(), live.ended.clone()));
            if let Some((session, ended)) = live {
                session.close().await;
                if tokio::time::timeout(SHUTDOWN_PUMPS, ended.cancelled())
                    .await
                    .is_err()
                {
                    tracing::warn!(session = %closing, "session events still pending at close");
                }
            }
            runtime.remove_artifacts(&closing).await;
            runtime
                .set_state(&closing, RawState::Closed, None, None)
                .await;
        });
        self.session(&id)
    }

    pub async fn transcript(
        &self,
        id: &RawSessionId,
        before: Option<i64>,
        limit: u32,
    ) -> Result<RawPage> {
        self.session(id)?;
        let limit = limit.clamp(1, brigadier_store::MAX_PAGE - 1);
        let mut events = self
            .core
            .store()
            .read_stream(
                streams::raw_session(id),
                StreamPage {
                    before,
                    kinds: Vec::new(),
                    limit: limit + 1,
                },
            )
            .await?;
        let has_more = events.len() > limit as usize;
        events.truncate(limit as usize);
        events.reverse();
        let entries = events
            .iter()
            .filter_map(|stored| match crate::sessions::decode(stored) {
                Ok(DomainEvent::RawEvent { event, .. }) => Some(Ok(RawEntry {
                    stream_seq: stored.stream_seq,
                    at_ms: stored.at_ms,
                    event,
                })),
                Ok(_) => None,
                Err(err) => Some(Err(err)),
            })
            .collect::<Result<_>>()?;
        Ok(RawPage { entries, has_more })
    }

    /// Replays a recording through a fresh parser into a new, isolated session.
    pub async fn replay(self: &Arc<Self>, fixture_id: &str) -> Result<RawSession> {
        self.admit()?;
        let text = load_fixture(&self.recordings_dir, fixture_id).await?;
        let recording = Recording::parse(&text).map_err(Error::Invalid)?;
        let lines: Vec<(u64, String)> = recording
            .lines
            .into_iter()
            .filter(|line| line.dir == record::Direction::Out)
            .map(|line| (line.t, line.line))
            .collect();
        let source = RawSource::Replay {
            title: recording.header.title,
        };
        self.feed_parser(recording.header.provider, source, lines, true)
            .await
    }

    /// Feeds a simulated usage-limit turn, in the CLI's real format, through a fresh parser
    /// in an isolated session, to show how it is detected and classified.
    pub async fn simulate_usage_limit(
        self: &Arc<Self>,
        provider: ProviderKind,
    ) -> Result<RawSession> {
        self.admit()?;
        let lines = simulate::usage_limit(provider)
            .into_iter()
            .map(|line| (0, line))
            .collect();
        let source = RawSource::Simulation {
            title: format!("{} usage limit", provider.label()),
        };
        self.feed_parser(provider, source, lines, false).await
    }

    async fn feed_parser(
        self: &Arc<Self>,
        provider: ProviderKind,
        source: RawSource,
        lines: Vec<(u64, String)>,
        paced: bool,
    ) -> Result<RawSession> {
        let now = now_ms();
        let session = RawSession {
            id: RawSessionId::generate(),
            provider,
            source,
            cwd: None,
            model: None,
            effort: None,
            access: Access::ReadOnly,
            approvals: RawApprovals::DeclineAll,
            native_id: None,
            parent_id: None,
            state: RawState::Running,
            error: None,
            recording: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.create(session.clone()).await?;
        let (events_tx, events) = mpsc::channel(512);
        let mut replayer = self.provider(provider).replayer();
        self.spawn(async move {
            let mut last = 0;
            for (t, line) in lines {
                if paced {
                    let gap = Duration::from_millis(t.saturating_sub(last)).min(REPLAY_MAX_GAP);
                    tokio::time::sleep(gap).await;
                    last = t;
                }
                for event in replayer.feed(&line) {
                    if events_tx.send(event).await.is_err() {
                        return;
                    }
                }
            }
        });
        let ended = CancellationToken::new();
        let runtime = self.clone();
        let id = session.id.clone();
        self.pumps
            .spawn(async move { runtime.pump(id, events, ended).await });
        Ok(session)
    }

    // ----- internals -------------------------------------------------------------------

    fn session(&self, id: &RawSessionId) -> Result<RawSession> {
        self.state()
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("raw session {id}")))
    }

    fn live(&self, id: &RawSessionId) -> Result<Arc<dyn ProviderSession>> {
        self.state()
            .live
            .get(id)
            .map(|live| live.session.clone())
            .ok_or_else(|| Error::Invalid("the session is not running".into()))
    }

    async fn create(&self, session: RawSession) -> Result<()> {
        let event = DomainEvent::RawSessionCreated {
            session: session.clone(),
        };
        self.core
            .store()
            .append(vec![new_event(streams::RAW, &event)?])
            .await?;
        self.state().sessions.insert(session.id.clone(), session);
        Ok(())
    }

    async fn set_state(
        &self,
        id: &RawSessionId,
        state: RawState,
        native_id: Option<String>,
        error: Option<String>,
    ) {
        let event = DomainEvent::RawSessionUpdated {
            id: id.clone(),
            state,
            native_id: native_id.clone(),
            error: error.clone(),
        };
        let stored = async {
            self.core
                .store()
                .append(vec![new_event(streams::RAW, &event)?])
                .await?;
            Ok::<_, Error>(())
        }
        .await;
        if let Err(err) = stored {
            tracing::warn!(session = %id, error = %err, "could not record a session state");
        }
        if let Some(session) = self.state().sessions.get_mut(id) {
            apply_update(session, state, native_id, error);
        }
    }

    /// Starts the CLI in the background. A failed fresh start removes whatever it created; a
    /// failed resume keeps the CLI session.
    fn launch(self: &Arc<Self>, id: RawSessionId, spec: SessionSpec, fresh: bool) {
        let runtime = self.clone();
        self.spawn(async move {
            let kind = match runtime.session(&id) {
                Ok(session) => session.provider,
                Err(_) => return,
            };
            let ledger: Arc<dyn Ledger> = Arc::new(RuntimeLedger {
                runtime: runtime.clone(),
                owner: id.clone(),
            });
            match runtime.provider(kind).start(spec, ledger).await {
                Ok(Started { session, events }) => {
                    if !runtime.admitting.load(Ordering::Acquire) {
                        session.close().await;
                    }
                    let ended = CancellationToken::new();
                    runtime.state().live.insert(
                        id.clone(),
                        Live {
                            session,
                            pending: HashSet::new(),
                            ended: ended.clone(),
                        },
                    );
                    let pump = runtime.clone();
                    runtime
                        .pumps
                        .spawn(async move { pump.pump(id, events, ended).await });
                }
                Err(err) => {
                    let message = err.to_string();
                    tracing::warn!(session = %id, error = %message, "CLI session did not start");
                    if fresh {
                        runtime
                            .set_state(&id, RawState::Failed, None, Some(message))
                            .await;
                        runtime.remove_artifacts(&id).await;
                    } else {
                        runtime
                            .set_state(&id, RawState::Stopped, None, Some(message))
                            .await;
                    }
                }
            }
        });
    }

    /// Stores a session's events as they come, answering approvals on the way.
    async fn pump(
        self: Arc<Self>,
        id: RawSessionId,
        mut events: mpsc::Receiver<ProviderEvent>,
        ended: CancellationToken,
    ) {
        let mut deltas: Vec<ProviderEvent> = Vec::new();
        let mut deadline: Option<tokio::time::Instant> = None;
        loop {
            let flush_at = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                event = events.recv() => match event {
                    Some(event) if is_delta(&event) => {
                        merge_delta(&mut deltas, event);
                        deadline.get_or_insert_with(|| tokio::time::Instant::now() + DELTA_WINDOW);
                    }
                    Some(event) => {
                        deadline = None;
                        self.record_raw(&id, std::mem::take(&mut deltas)).await;
                        // The live session keeps its sender open; its exit ends the stream.
                        let exited = matches!(event, ProviderEvent::Exited { .. });
                        self.handle(&id, event).await;
                        if exited {
                            break;
                        }
                    }
                    None => break,
                },
                () = flush_at => {
                    deadline = None;
                    self.record_raw(&id, std::mem::take(&mut deltas)).await;
                }
            }
        }
        self.record_raw(&id, deltas).await;

        let closing = {
            let mut state = self.state();
            state.live.remove(&id);
            state
                .sessions
                .get(&id)
                .map(|session| matches!(session.state, RawState::Closing | RawState::Closed))
                .unwrap_or(true)
        };
        if !closing {
            self.set_state(&id, RawState::Stopped, None, None).await;
        }
        ended.cancel();
    }

    async fn handle(&self, id: &RawSessionId, event: ProviderEvent) {
        match &event {
            ProviderEvent::SessionStarted { native_id, .. } => {
                let native_id = native_id.clone();
                self.record_raw(id, vec![event]).await;
                self.set_state(id, RawState::Running, Some(native_id), None)
                    .await;
            }
            ProviderEvent::ApprovalRequested { request } => {
                let request = request.clone();
                self.record_raw(id, vec![event]).await;
                self.route_approval(id, request).await;
            }
            ProviderEvent::ApprovalResolved { id: approval, .. } => {
                if let Some(live) = self.state().live.get_mut(id) {
                    live.pending.remove(approval);
                }
                self.record_raw(id, vec![event]).await;
            }
            ProviderEvent::RateLimits { quota } => {
                let quota = quota.clone();
                self.record_raw(id, vec![event]).await;
                self.note_quota(id, quota).await;
            }
            _ => self.record_raw(id, vec![event]).await,
        }
    }

    async fn route_approval(
        &self,
        id: &RawSessionId,
        request: brigadier_providers::ApprovalRequest,
    ) {
        let (session, route) = {
            let mut state = self.state();
            let Some(raw) = state.sessions.get(id).cloned() else {
                return;
            };
            let Some(live) = state.live.get_mut(id) else {
                // A replay: nobody to answer.
                return;
            };
            let mode = match raw.approvals {
                RawApprovals::Delegated => ApprovalMode::Delegated,
                RawApprovals::DeclineAll => ApprovalMode::DeclineAll,
            };
            let route = policy::route(&request, &raw.access, mode);
            if route == Route::AskUser {
                live.pending.insert(request.id.clone());
            }
            (live.session.clone(), route)
        };
        let decision = match route {
            Route::AskUser => return,
            Route::Allow => ApprovalDecision::Allow,
            Route::Deny => ApprovalDecision::Deny {
                message: "Declined by Brigadier: this session may not do that.".into(),
            },
        };
        match session.answer(request.id.clone(), decision.clone()).await {
            Ok(()) => {
                self.record_raw(
                    id,
                    vec![ProviderEvent::ApprovalResolved {
                        id: request.id,
                        decision,
                        decided_by: Decider::Policy,
                    }],
                )
                .await;
            }
            Err(err) => tracing::warn!(session = %id, error = %err, "could not answer an approval"),
        }
    }

    /// Keeps the provider overview's quota current from live rate-limit events.
    async fn note_quota(&self, id: &RawSessionId, quota: brigadier_providers::QuotaSnapshot) {
        let overview = {
            let mut state = self.state();
            if !matches!(
                state.sessions.get(id).map(|session| &session.source),
                Some(RawSource::Live)
            ) {
                return;
            }
            let kind = quota.provider;
            let now = now_ms();
            let Some(overview) = state.overviews.get_mut(&kind) else {
                return;
            };
            overview.quota = Some(quota);
            let overview = overview.clone();
            let last = state.quota_recorded_ms.entry(kind).or_default();
            if now - *last < QUOTA_RECORD_INTERVAL_MS {
                return;
            }
            *last = now;
            overview
        };
        self.record_overview(overview).await;
    }

    async fn record_raw(&self, id: &RawSessionId, events: Vec<ProviderEvent>) {
        if events.is_empty() {
            return;
        }
        let stream = streams::raw_session(id);
        let new = events
            .into_iter()
            .map(|event| {
                new_event(
                    &stream,
                    &DomainEvent::RawEvent {
                        session_id: id.clone(),
                        event,
                    },
                )
            })
            .collect::<Result<Vec<_>>>();
        let stored = match new {
            Ok(new) => self.core.store().append(new).await.map_err(Error::from),
            Err(err) => Err(err),
        };
        if let Err(err) = stored {
            tracing::warn!(session = %id, error = %err, "could not store session events");
        }
    }

    async fn record_artifact(&self, owner: &RawSessionId, artifact: Artifact) -> Result<()> {
        if self
            .state()
            .ledger
            .get(owner)
            .is_some_and(|artifacts| artifacts.contains(&artifact))
        {
            return Ok(());
        }
        let event = DomainEvent::CleanupRecorded {
            owner: owner.clone(),
            artifact: artifact.clone(),
        };
        self.core
            .store()
            .append(vec![new_event(streams::CLEANUP, &event)?])
            .await?;
        self.state()
            .ledger
            .entry(owner.clone())
            .or_default()
            .push(artifact);
        Ok(())
    }

    /// Removes everything recorded for `owner`, and nothing else.
    async fn remove_artifacts(&self, owner: &RawSessionId) {
        let (artifacts, kind) = {
            let state = self.state();
            (
                state.ledger.get(owner).cloned().unwrap_or_default(),
                state.sessions.get(owner).map(|session| session.provider),
            )
        };
        if artifacts.is_empty() {
            return;
        }
        let (processes, files): (Vec<Artifact>, Vec<Artifact>) = artifacts
            .into_iter()
            .partition(|artifact| matches!(artifact, Artifact::Process { .. }));
        let platform = self.platform.clone();
        let _ = tokio::task::spawn_blocking(move || {
            for artifact in processes {
                if let Artifact::Process { pid, started_at_ms } = artifact {
                    cleanup::end_process(&*platform, pid, started_at_ms);
                }
            }
        })
        .await;
        let mut failures = Vec::new();
        if let (Some(kind), false) = (kind, files.is_empty())
            && let Err(err) = self.provider(kind).remove(files).await
        {
            failures.push(err.to_string());
        }
        if !failures.is_empty() {
            tracing::warn!(session = %owner, ?failures, "some session artifacts were not removed");
        }
        let event = DomainEvent::CleanupCompleted {
            owner: owner.clone(),
            failures,
        };
        let stored = async {
            self.core
                .store()
                .append(vec![new_event(streams::CLEANUP, &event)?])
                .await?;
            Ok::<_, Error>(())
        }
        .await;
        match stored {
            Ok(()) => {
                self.state().ledger.remove(owner);
            }
            Err(err) => {
                tracing::warn!(session = %owner, error = %err, "could not record a cleanup")
            }
        }
    }
}

struct RuntimeLedger {
    runtime: Arc<Runtime>,
    owner: RawSessionId,
}

impl Ledger for RuntimeLedger {
    fn record(
        &self,
        artifact: Artifact,
    ) -> brigadier_providers::BoxFuture<'_, brigadier_providers::Result<()>> {
        Box::pin(async move {
            self.runtime
                .record_artifact(&self.owner, artifact)
                .await
                .map_err(|err| brigadier_providers::Error::Ledger(err.to_string()))
        })
    }
}

fn spec_for(session: &RawSession, origin: Origin, record_to: Option<PathBuf>) -> SessionSpec {
    SessionSpec {
        cwd: PathBuf::from(session.cwd.clone().unwrap_or_default()),
        model: session.model.clone(),
        effort: session.effort.clone(),
        origin,
        access: session.access.clone(),
        append_system_prompt: None,
        mcp_servers: serde_json::Map::new(),
        record_to,
    }
}

fn apply_update(
    session: &mut RawSession,
    state: RawState,
    native_id: Option<String>,
    error: Option<String>,
) {
    session.state = state;
    if native_id.is_some() {
        session.native_id = native_id;
    }
    session.error = error;
    session.updated_at_ms = now_ms();
}

fn is_delta(event: &ProviderEvent) -> bool {
    matches!(
        event,
        ProviderEvent::MessageDelta { .. }
            | ProviderEvent::ReasoningDelta { .. }
            | ProviderEvent::CommandOutputDelta { .. }
    )
}

/// Appends a delta to the previous one when both continue the same item.
fn merge_delta(deltas: &mut Vec<ProviderEvent>, event: ProviderEvent) {
    use ProviderEvent::{CommandOutputDelta, MessageDelta, ReasoningDelta};
    match (deltas.last_mut(), event) {
        (
            Some(MessageDelta { item_id, text }),
            MessageDelta {
                item_id: next,
                text: more,
            },
        )
        | (
            Some(ReasoningDelta { item_id, text }),
            ReasoningDelta {
                item_id: next,
                text: more,
            },
        )
        | (
            Some(CommandOutputDelta { item_id, text }),
            CommandOutputDelta {
                item_id: next,
                text: more,
            },
        ) if *item_id == next => text.push_str(&more),
        (_, event) => deltas.push(event),
    }
}

fn new_event(stream: &str, event: &DomainEvent) -> Result<NewEvent> {
    Ok(NewEvent::new(stream, event.kind(), now_ms(), event)?)
}

fn provider_error(err: brigadier_providers::Error) -> Error {
    Error::Provider(err.to_string())
}

fn read_model_cache(dir: &Path) -> Vec<ModelCatalog> {
    ProviderKind::ALL
        .iter()
        .filter_map(|kind| {
            let text = std::fs::read_to_string(dir.join(format!("models-{kind}.json"))).ok()?;
            serde_json::from_str::<ModelCatalog>(&text).ok()
        })
        .collect()
}

fn write_model_cache(dir: &Path, catalog: &ModelCatalog) {
    let path = dir.join(format!("models-{}.json", catalog.provider));
    let written = std::fs::create_dir_all(dir).and_then(|()| {
        let text = serde_json::to_vec_pretty(catalog).map_err(std::io::Error::other)?;
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, text)?;
        std::fs::rename(&partial, &path)
    });
    if let Err(err) = written {
        tracing::warn!(path = %path.display(), error = %err, "could not cache the model list");
    }
}

fn list_fixtures(recordings: &Path) -> Vec<Fixture> {
    let describe = |id: String, text: &str| {
        let recording = Recording::parse(text).ok()?;
        Some(Fixture {
            id,
            title: recording.header.title,
            provider: recording.header.provider,
            cli_version: recording.header.cli_version,
            lines: recording.lines.len() as u32,
        })
    };
    let mut fixtures: Vec<Fixture> = fixtures::BUILTIN
        .iter()
        .filter_map(|(name, text)| describe(format!("builtin:{name}"), text))
        .collect();
    if let Ok(entries) = std::fs::read_dir(recordings) {
        let mut recorded: Vec<Fixture> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                name.ends_with(".jsonl").then_some(())?;
                let text = std::fs::read_to_string(entry.path()).ok()?;
                describe(format!("recording:{name}"), &text)
            })
            .collect();
        recorded.sort_by(|a, b| b.id.cmp(&a.id));
        fixtures.extend(recorded);
    }
    fixtures
}

async fn load_fixture(recordings: &Path, id: &str) -> Result<String> {
    if let Some(name) = id.strip_prefix("builtin:") {
        return fixtures::BUILTIN
            .iter()
            .find(|(builtin, _)| *builtin == name)
            .map(|(_, text)| (*text).to_owned())
            .ok_or_else(|| Error::NotFound(format!("fixture {id}")));
    }
    let name = id
        .strip_prefix("recording:")
        .filter(|name| !name.contains(['/', '\\']) && name.ends_with(".jsonl"))
        .ok_or_else(|| Error::Invalid(format!("{id} is not a fixture id")))?;
    let path = recordings.join(name);
    tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|err| Error::Invalid(err.to_string()))?
        .map_err(|_| Error::NotFound(format!("fixture {id}")))
}
