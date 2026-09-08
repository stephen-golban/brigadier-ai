//! Message-owned workspace epochs. See docs/research/git-message-checkpoints-2026-09-05.md.
use super::*;
use brigadier_core::{
    checkpoint::{
        plan_restore, Coverage, Epoch, Limits, RestorePlan, SnapshotStore, WorkspaceLease,
    },
    session::NativeControl,
};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct Runtime {
    pub serial: tokio::sync::Mutex<()>,
    active: Mutex<BTreeMap<SessionId, Active>>,
    last: Mutex<BTreeMap<SessionId, (Epoch, u64)>>,
    maintenance: Mutex<Option<std::time::Instant>>,
}
struct Active {
    epoch: Epoch,
    _lease: WorkspaceLease,
}
fn failure(e: impl std::fmt::Display) -> SupervisorError {
    SupervisorError::InvalidArgument(e.to_string())
}
impl Supervisor {
    pub(crate) async fn seed_worktree(
        &self,
        source: PathBuf,
        target: PathBuf,
    ) -> Result<(), SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.workspace_writable(&source).await?;
        let snapshots = self.snapshots()?;
        tokio::task::spawn_blocking(move || {
            let original = {
                let _lease = WorkspaceLease::writer(&source)?;
                snapshots.capture(&source, Coverage::default())?
            };
            let _lease = WorkspaceLease::writer(&target)?;
            let current = snapshots.capture(&target, Coverage::default())?;
            let plan = brigadier_core::checkpoint::plan_apply(
                &current.files.clone(),
                &original.files,
                current,
            )?;
            snapshots.validate_restore(&plan)?;
            for change in &plan.changes {
                snapshots.apply_change(&plan.current.root, &plan.current.identity, change)?;
            }
            Ok::<_, brigadier_core::checkpoint::Error>(())
        })
        .await
        .map_err(failure)?
        .map_err(failure)
    }
    pub(crate) async fn discard_checkpoints(
        &self,
        id: &SessionId,
        root: Option<&std::path::Path>,
    ) -> Result<(), SupervisorError> {
        lock(&self.inner.checkpoints.active).remove(id);
        lock(&self.inner.checkpoints.last).remove(id);
        for op in self.inner.store.workspace_applies(id.to_string()).await? {
            if matches!(op.phase.as_str(), "applying" | "failed") && op.plan.current.root.is_dir() {
                let lease =
                    WorkspaceLease::recover(&op.plan.current.root, &op.id).map_err(failure)?;
                lease.resolve(&op.id).map_err(failure)?;
            }
        }
        if let Some(root) = root {
            for op in self
                .inner
                .store
                .workspace_rewinds(root.to_string_lossy().into_owned())
                .await?
            {
                if op.session == id.as_str() && root.is_dir() {
                    let lease = WorkspaceLease::recover(root, &op.id).map_err(failure)?;
                    lease.resolve(&op.id).map_err(failure)?;
                }
            }
        }
        self.inner
            .store
            .delete_workspace_checkpoints(id.to_string())
            .await?;
        *lock(&self.inner.checkpoints.maintenance) = None;
        self.checkpoint_maintenance().await
    }
    fn snapshots(&self) -> Result<SnapshotStore, SupervisorError> {
        SnapshotStore::open(
            self.inner.data_dir.join("checkpoints"),
            PathBuf::from("git"),
            Limits::default(),
        )
        .map_err(failure)
    }
    async fn checkpoint_maintenance(&self) -> Result<(), SupervisorError> {
        if lock(&self.inner.checkpoints.maintenance)
            .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(86400))
        {
            return Ok(());
        }
        let keep = self.inner.store.checkpoint_retention().await?;
        let snapshots = self.snapshots()?;
        tokio::task::spawn_blocking(move || snapshots.retain(&keep))
            .await
            .map_err(failure)?
            .map_err(failure)?;
        *lock(&self.inner.checkpoints.maintenance) = Some(std::time::Instant::now());
        Ok(())
    }
    /// Block every app writer while an earlier transaction has an uncertain outcome.
    pub async fn workspace_writable(&self, root: &std::path::Path) -> Result<(), SupervisorError> {
        let root = std::fs::canonicalize(root)
            .map_err(failure)?
            .to_string_lossy()
            .into_owned();
        if self
            .inner
            .store
            .workspace_rewinds(root)
            .await?
            .iter()
            .any(|o| {
                !matches!(
                    o.phase.as_str(),
                    "complete" | "rolled-back" | "rewound-unsent"
                )
            })
        {
            return Err(failure("Workspace has an unresolved restore; review its saved recovery record before writing"));
        }
        Ok(())
    }
    async fn checkpoint_root(&self, id: &SessionId) -> Result<PathBuf, SupervisorError> {
        self.session(id)
            .await?
            .and_then(|r| r.cwd)
            .ok_or(SupervisorError::NoSuchSession)
    }
    async fn barrier(&self, id: &SessionId) -> Result<u64, SupervisorError> {
        self.native_control(id, NativeControl::CheckpointBarrier)
            .await?
            .get("seq")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| failure("Provider lacks a verified checkpoint barrier"))
    }
    async fn capture_at(
        &self,
        root: PathBuf,
    ) -> Result<brigadier_core::checkpoint::Snapshot, SupervisorError> {
        let snapshots = self.snapshots()?;
        tokio::task::spawn_blocking(move || snapshots.capture(&root, Coverage::default()))
            .await
            .map_err(failure)?
            .map_err(failure)
    }
    /// Save the pre-image durably before dispatching the reserved message identity.
    pub(crate) async fn checkpoint_send(
        &self,
        id: &SessionId,
        input: TurnInput,
    ) -> Result<TurnId, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.require_session_available(id)?;
        self.finish_epoch(id, 0).await?;
        self.checkpoint_maintenance().await?;
        let root = self.checkpoint_root(id).await?;
        self.workspace_writable(&root).await?;
        let lease = WorkspaceLease::writer(&root).map_err(failure)?;
        let seq = self.barrier(id).await?;
        let result = async {
            let pre = self.capture_at(root).await?;
            let turn_id = TurnId::new(uuid::Uuid::new_v4().to_string());
            let epoch = Epoch {
                turn_id: turn_id.to_string(),
                pre,
                post: None,
                error: None,
            };
            self.inner
                .store
                .save_workspace_epoch(id.to_string(), epoch.clone())
                .await?;
            self.native_control(
                id,
                NativeControl::CheckpointRelease {
                    seq,
                    turn_id: Some(turn_id.clone()),
                },
            )
            .await?;
            lock(&self.inner.checkpoints.active).insert(
                id.clone(),
                Active {
                    epoch,
                    _lease: lease,
                },
            );

            // Cancellation or transport failure leaves an incomplete epoch and its lease.
            self.commands(id)?
                .send_reserved_turn(turn_id, input)
                .await
                .map_err(error::from_command)
        }
        .await;
        if result.is_err() && !lock(&self.inner.checkpoints.active).contains_key(id) {
            let _ = self.native_control(id, NativeControl::FinishRewind).await;
        }
        result
    }
    // Called under serial. Failed capture leaves the writer lease and incomplete epoch intact.
    async fn finish_epoch(&self, id: &SessionId, event_seq: u64) -> Result<(), SupervisorError> {
        let epoch = lock(&self.inner.checkpoints.active)
            .get(id)
            .map(|a| a.epoch.clone());
        let Some(mut epoch) = epoch else {
            return Ok(());
        };
        let seq = self.barrier(id).await?;
        let result = self.capture_at(epoch.pre.root.clone()).await;
        let release = self
            .native_control(id, NativeControl::CheckpointRelease { seq, turn_id: None })
            .await;
        let post = result?;
        release?;
        epoch.post = Some(post);
        self.inner
            .store
            .save_workspace_epoch(id.to_string(), epoch.clone())
            .await?;
        let active = {
            let mut active = lock(&self.inner.checkpoints.active);
            let finished = active.remove(id);
            if let Some(error) = finished.as_ref().and_then(|a| a.epoch.error.clone()) {
                epoch.error = Some(error);
            }
            lock(&self.inner.checkpoints.last)
                .insert(id.clone(), (epoch.clone(), seq.max(event_seq)));
            finished
        };
        if epoch.error.is_some() {
            self.inner
                .store
                .save_workspace_epoch(id.to_string(), epoch)
                .await?;
        }
        drop(active);
        Ok(())
    }
    /// Exact cumulative inverse, requiring a saved complete epoch for every discarded message.
    pub async fn checkpoint_preview(
        &self,
        id: &SessionId,
        turns: Vec<String>,
    ) -> Result<RestorePlan, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.require_session_available(id)?;
        self.finish_epoch(id, 0).await?;
        let root = self.checkpoint_root(id).await?;
        self.workspace_writable(&root).await?;
        let _lease = WorkspaceLease::acquire(&root).map_err(failure)?;
        let seq = self.barrier(id).await?;
        let result=async {
            let all=self.inner.store.workspace_epochs(id.to_string()).await?;
            let epochs=turns.iter().map(|turn|all.iter().find(|e|&e.turn_id==turn).cloned().ok_or_else(||failure("This message predates workspace checkpoints; combined rewind is unavailable"))).collect::<Result<Vec<_>,_>>()?;
            if epochs.is_empty() {return Err(failure("No checkpointed messages in rewind span"));}
            let current=self.capture_at(root).await?;
            let plan=plan_restore(&epochs,current).map_err(failure)?;
            let snapshots=self.snapshots()?;let check=plan.clone();
            tokio::task::spawn_blocking(move ||snapshots.validate_support(&check)).await.map_err(failure)?.map_err(failure)?;
            Ok(plan)
        }.await;
        let released = self
            .native_control(id, NativeControl::CheckpointRelease { seq, turn_id: None })
            .await;
        released?;
        result
    }
}

/// Do not await adapter controls inside the event consumer: it must keep draining backpressure.
pub(crate) fn observe(inner: &Arc<Inner>, env: &Envelope, generation: u64) {
    if !matches!(
        env.event,
        Event::TurnCompleted { .. }
            | Event::TurnAborted { .. }
            | Event::TurnStarted { .. }
            | Event::SessionExited { .. }
    ) {
        return;
    }
    if lock(&inner.live)
        .get(&env.session_id)
        .is_some_and(|live| live.generation != generation)
    {
        return;
    }
    // Record invalidation synchronously with observation. A later send must not erase evidence
    // just because this event's persistence task has not acquired the coordinator yet.
    let invalidated = if let Event::TurnStarted { turn_id } = &env.event {
        let mut active = lock(&inner.checkpoints.active);
        if let Some(active) = active.get_mut(&env.session_id) {
            if active.epoch.turn_id != turn_id.as_str() {
                active.epoch.error =
                    Some("Unattributed provider continuation makes this epoch incomplete".into());
            }
            None
        } else {
            let mut last = lock(&inner.checkpoints.last);
            last.get_mut(&env.session_id).filter(|(_,seq)|env.seq>*seq).map(|(epoch,_)|{
                epoch.error=Some("Provider started work after the saved boundary; exact attribution is unavailable".into());epoch.clone()
            })
        }
    } else {
        None
    };
    let sup = Supervisor {
        inner: inner.clone(),
    };
    let env = env.clone();
    tokio::spawn(async move {
        let _serial = sup.inner.checkpoints.serial.lock().await;
        let id = &env.session_id;
        if sup.require_session_available(id).is_err()
            || !matches!(sup.session(id).await, Ok(Some(_)))
        {
            return;
        }
        if lock(&sup.inner.live)
            .get(id)
            .is_some_and(|live| live.generation != generation)
        {
            return;
        }
        match &env.event {
            Event::TurnCompleted { .. } => {
                sup.finish_observed_epoch(id, env.seq).await;
            }
            Event::TurnStarted { .. } => {
                if let Some(epoch) = invalidated {
                    let _ = sup
                        .inner
                        .store
                        .save_workspace_epoch(id.to_string(), epoch)
                        .await;
                }
            }
            Event::TurnAborted { .. } => {
                let epoch = {
                    let mut active = lock(&sup.inner.checkpoints.active);
                    active.get_mut(id).map(|a| {
                        a.epoch.error =
                            Some("Writer turn was interrupted; checkpoint is incomplete".into());
                        a.epoch.clone()
                    })
                };
                if let Some(epoch) = epoch {
                    let _ = sup
                        .inner
                        .store
                        .save_workspace_epoch(id.to_string(), epoch)
                        .await;
                }
                sup.finish_observed_epoch(id, env.seq).await;
            }
            Event::SessionExited { .. } => {
                let active = lock(&sup.inner.checkpoints.active).remove(id);
                if let Some(mut active) = active {
                    active.epoch.error =
                        Some("Writer epoch ended without a verified settled boundary".into());
                    let _ = sup
                        .inner
                        .store
                        .save_workspace_epoch(id.to_string(), active.epoch)
                        .await;
                }
            }
            _ => {}
        }
    });
}

impl Supervisor {
    // Trailing provider frames can invalidate a capture after turn completion.
    // Retry the entire strict barrier/capture/release; never publish a rejected snapshot.
    async fn finish_observed_epoch(&self, id: &SessionId, seq: u64) {
        for attempt in 0..3 {
            match self.finish_epoch(id, seq).await {
                Ok(()) => return,
                Err(SupervisorError::Command(brigadier_core::session::CommandError::Rejected(_)))
                    if attempt < 2 => {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                Err(error) => {
                    tracing::warn!(session = %id, %error, "Completed turn checkpoint remains incomplete");
                    return;
                }
            }
        }
    }

    /// Files first, native cut second, then one checkpointed edited send. Every uncertain step
    /// leaves a durable operation which blocks further workspace writers.
    pub async fn checkpoint_rewind_send(
        &self,
        mut op: brigadier_store::checkpoint::WorkspaceRewind,
        input: TurnInput,
    ) -> Result<TurnId, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        if op.draft.trim().is_empty() || op.draft.len() > 256 * 1024 {
            return Err(failure("Edited draft must contain 1–262144 bytes"));
        }
        let id = SessionId::new(&op.session);
        self.require_session_available(&id)?;
        self.finish_epoch(&id, 0).await?;
        let root = self.checkpoint_root(&id).await?;
        self.workspace_writable(&root).await?;
        if std::fs::canonicalize(root).map_err(failure)? != op.plan.current.root {
            return Err(failure("Rewind workspace changed"));
        }
        let lease = WorkspaceLease::acquire(&op.plan.current.root).map_err(failure)?;
        let seq = self.barrier(&id).await?;
        let snapshots = self.snapshots()?;
        let validation = {
            let store = snapshots.clone();
            let plan = op.plan.clone();
            tokio::task::spawn_blocking(move || store.validate_restore(&plan))
                .await
                .map_err(failure)?
        };
        if let Err(e) = validation {
            let _ = self
                .native_control(&id, NativeControl::CheckpointRelease { seq, turn_id: None })
                .await;
            return Err(failure(e));
        }
        // Retain the planned target as well as current recovery files before pruning can run.
        let store = snapshots.clone();
        let target = op.plan.target.clone();
        let reference = op.id.clone();
        let current = op.plan.current.clone();
        let retained = tokio::task::spawn_blocking(move || {
            store.retain_snapshot(&current)?;
            store.publish(&target, &reference)
        })
        .await
        .map_err(failure)?;
        if let Err(e) = retained {
            let _ = self.native_control(&id, NativeControl::FinishRewind).await;
            return Err(failure(e));
        }
        op.phase = "prepared".into();
        if let Err(e) = self.inner.store.save_workspace_rewind(op.clone()).await {
            let _ = self.native_control(&id, NativeControl::FinishRewind).await;
            return Err(e.into());
        }
        lease.block(&op.id).map_err(failure)?;
        let restored = async {
            for i in 0..op.plan.changes.len() {
                op.phase = "restoring".into();
                op.paths_started = i + 1;
                self.inner.store.save_workspace_rewind(op.clone()).await?;
                let store = snapshots.clone();
                let root = op.plan.current.root.clone();
                let identity = op.plan.current.identity.clone();
                let change = op.plan.changes[i].clone();
                tokio::task::spawn_blocking(move || store.apply_change(&root, &identity, &change))
                    .await
                    .map_err(failure)?
                    .map_err(failure)?;
            }
            let observed = self.capture_at(op.plan.current.root.clone()).await?;
            if observed.files != op.plan.target || observed.git != op.plan.current.git {
                return Err(failure("Workspace changed during restoration"));
            }
            self.native_control(&id, NativeControl::CheckpointVerify { seq })
                .await?;
            self.inner
                .store
                .prepare_rewind(op.id.clone(), op.session.clone(), op.target_id.clone())
                .await?;
            Ok::<_, SupervisorError>(())
        }
        .await;
        if let Err(e) = restored {
            op.error = Some(e.to_string());
            self.rollback_checkpoint(&mut op, &snapshots).await?;
            self.inner.store.finish_rewind(op.id.clone(), None).await?;
            lease.resolve(&op.id).map_err(failure)?;
            let _ = self.native_control(&id, NativeControl::FinishRewind).await;
            return Err(e);
        }
        op.phase = "native-requested".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        let reply = self
            .native_control(
                &id,
                NativeControl::RewindConversation {
                    target_uuid: op.target_uuid.clone(),
                    last_seen_uuid: op.latest_uuid.clone(),
                },
            )
            .await
            .map_err(|e| {
                failure(format!(
                    "Rewind outcome unconfirmed; workspace paused. Recovery {}: {e}",
                    op.id
                ))
            })?;
        if reply.get("rewound").and_then(serde_json::Value::as_bool) == Some(false) {
            op.error = Some(reply.to_string());
            // Save proof of refusal before rollback, so a crash can safely resume it.
            op.phase = "native-refused".into();
            self.inner.store.save_workspace_rewind(op.clone()).await?;
            self.rollback_checkpoint(&mut op, &snapshots).await?;
            self.inner.store.finish_rewind(op.id.clone(), None).await?;
            lease.resolve(&op.id).map_err(failure)?;
            self.native_control(&id, NativeControl::FinishRewind)
                .await?;
            return Err(failure(
                "Provider refused rewind; files and conversation were preserved",
            ));
        }
        if reply.get("rewound").and_then(serde_json::Value::as_bool) != Some(true)
            || reply
                .get("targetMessageUuid")
                .and_then(serde_json::Value::as_str)
                != Some(&op.target_uuid)
        {
            return Err(failure(format!(
                "Native rewind outcome unconfirmed; recovery {} retained",
                op.id
            )));
        }
        op.through_seq = reply
            .get("brigadier_seq")
            .and_then(serde_json::Value::as_u64);
        let through = op
            .through_seq
            .ok_or_else(|| failure("Native rewind omitted its cursor; workspace paused"))?;
        op.phase = "native-confirmed".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        self.inner
            .store
            .finish_rewind(op.id.clone(), Some(through))
            .await?;
        op.phase = "archived".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        let pre = self.capture_at(op.plan.current.root.clone()).await?;
        let turn = TurnId::new(uuid::Uuid::new_v4().to_string());
        let epoch = Epoch {
            turn_id: turn.to_string(),
            pre,
            post: None,
            error: None,
        };
        self.inner
            .store
            .save_workspace_epoch(op.session.clone(), epoch.clone())
            .await?;
        op.new_turn = Some(turn.to_string());
        op.phase = "sending".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        self.native_control(
            &id,
            NativeControl::CheckpointRelease {
                seq: through,
                turn_id: Some(turn.clone()),
            },
        )
        .await?;
        lock(&self.inner.checkpoints.active).insert(
            id.clone(),
            Active {
                epoch,
                _lease: lease,
            },
        );

        self.commands(&id)?
            .send_reserved_turn(turn.clone(), input)
            .await
            .map_err(error::from_command)?;
        op.phase = "complete".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        if let Some(active) = lock(&self.inner.checkpoints.active).get(&id) {
            active._lease.resolve(&op.id).map_err(failure)?;
        }
        Ok(turn)
    }
    async fn rollback_checkpoint(
        &self,
        op: &mut brigadier_store::checkpoint::WorkspaceRewind,
        snapshots: &SnapshotStore,
    ) -> Result<(), SupervisorError> {
        for change in op.plan.changes[..op.paths_started].iter().rev() {
            let inverse = brigadier_core::checkpoint::Change {
                path: change.path.clone(),
                before: change.after.clone(),
                after: change.before.clone(),
            };
            let store = snapshots.clone();
            let root = op.plan.current.root.clone();
            let identity = op.plan.current.identity.clone();
            tokio::task::spawn_blocking(move || store.apply_change(&root, &identity, &inverse))
                .await
                .map_err(failure)?
                .map_err(failure)?;
        }
        op.phase = "rolled-back".into();
        self.inner.store.save_workspace_rewind(op.clone()).await?;
        Ok(())
    }
    /// Recovery can reverse only filesystem work with proof that no native cut may have happened.
    pub async fn checkpoint_recover(
        &self,
        root: PathBuf,
        operation: String,
    ) -> Result<(), SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        let root = std::fs::canonicalize(root).map_err(failure)?;
        let lease = WorkspaceLease::recover(&root, &operation).map_err(failure)?;
        let mut op = self
            .inner
            .store
            .workspace_rewinds(root.to_string_lossy().into_owned())
            .await?
            .into_iter()
            .find(|o| o.id == operation)
            .ok_or_else(|| failure("Unknown recovery operation"))?;
        if matches!(op.phase.as_str(), "native-confirmed" | "archived") {
            let through = op
                .through_seq
                .ok_or_else(|| failure("Confirmed rewind is missing its archive cursor"))?;
            self.inner
                .store
                .finish_rewind(op.id.clone(), Some(through))
                .await?;
            // There is durable proof of the native cut, and no send intent. Preserve the draft
            // for an explicit new send after resuming; never repeat the native mutation.
            op.phase = "rewound-unsent".into();
            self.inner.store.save_workspace_rewind(op.clone()).await?;
        }
        if matches!(
            op.phase.as_str(),
            "complete" | "rolled-back" | "rewound-unsent"
        ) {
            if op.phase == "rolled-back" {
                self.inner.store.finish_rewind(op.id.clone(), None).await?;
            }
            lease.resolve(&operation).map_err(failure)?;
            if self.is_live(&SessionId::new(&op.session)) {
                self.native_control(&SessionId::new(op.session), NativeControl::FinishRewind)
                    .await?;
            }
            return Ok(());
        }
        if !matches!(
            op.phase.as_str(),
            "prepared" | "restoring" | "native-refused"
        ) {
            return Err(failure(
                "Provider or send outcome requires reconciliation; automatic retry is unsafe",
            ));
        }
        self.rollback_checkpoint(&mut op, &self.snapshots()?)
            .await?;
        self.inner.store.finish_rewind(op.id.clone(), None).await?;
        lease.resolve(&op.id).map_err(failure)?;
        if self.is_live(&SessionId::new(&op.session)) {
            self.native_control(&SessionId::new(op.session), NativeControl::FinishRewind)
                .await?;
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use brigadier_core::{
        event::ItemKind,
        session::{Command, CommandError, SessionHandle},
    };
    use brigadier_store::{chat::ChatItem, checkpoint::WorkspaceRewind, Store};
    use serde_json::json;
    #[derive(Clone, Copy)]
    enum Reply {
        Success,
        InvalidatedCapture,
        Refused,
        Unknown,
        SendUnknown,
    }
    struct Rig {
        _dir: tempfile::TempDir,
        store: Store,
        sup: Supervisor,
        root: PathBuf,
        actor: tokio::task::JoinHandle<()>,
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            self.actor.abort();
        }
    }
    impl Rig {
        async fn new(reply: Reply) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("workspace");
            std::fs::create_dir(&root).unwrap();
            let store = Store::open(&dir.path().join("data")).unwrap();
            let sup = Supervisor::new(SupervisorConfig::new(
                store.handle().clone(),
                store.run_id(),
                dir.path().join("data"),
                Arc::new(crate::sink::VecSink::new()),
            ));
            let id = SessionId::new("s");
            let mut row = SessionRow::new(id.clone());
            row.cwd = Some(root.clone());
            row.driver_kind = Some(DriverKind::new("claude-code"));
            store.handle().upsert_session(row).await.unwrap();
            let (handle, mut backend) =
                SessionHandle::channel(id.clone(), InstanceId::new("fixture"), 32);
            lock(&sup.inner.live).insert(
                id,
                LiveSession {
                    _writer_lease: None,
                    project_id: "p".into(),
                    commands: handle.commands,
                    approvals: handle.approvals,
                    pid: None,
                    generation: 0,
                    task: None,
                },
            );
            let db = store.handle().clone();
            let path = root.clone();
            let actor = tokio::spawn(async move {
                let mut invalidated = false;
                while let Some(command) = backend.commands.recv().await {
                    match command {
                        Command::Native { request, ack } => {
                            let response = match request {
                                NativeControl::CheckpointBarrier => Ok(json!({"seq":10})),
                                NativeControl::CheckpointRelease { turn_id: None, .. }
                                    if matches!(reply, Reply::InvalidatedCapture) && !invalidated => {
                                        invalidated = true;
                                        std::fs::write(path.join("file"), b"after invalidation").unwrap();
                                        Err(CommandError::Rejected("Provider advanced during workspace capture".into()))
                                    }
                                NativeControl::RewindConversation { target_uuid, .. } => {
                                    assert_eq!(
                                        std::fs::read(path.join("file")).unwrap(),
                                        b"before",
                                        "files must be restored before native cut"
                                    );
                                    assert!(db
                                        .workspace_rewinds(path.to_string_lossy().into_owned())
                                        .await
                                        .unwrap()
                                        .iter()
                                        .any(|o| o.phase == "native-requested"));
                                    match reply {
                                        Reply::Refused => Ok(json!({"rewound":false})),
                                        Reply::Unknown => Err(CommandError::Closed),
                                        _ => Ok(
                                            json!({"rewound":true,"targetMessageUuid":target_uuid,"brigadier_seq":10}),
                                        ),
                                    }
                                }
                                _ => Ok(serde_json::Value::Null),
                            };
                            let _ = ack.send(response);
                        }
                        Command::SendTurn {
                            turn_id,
                            input,
                            ack,
                        } => {
                            let epochs = db.workspace_epochs("s".into()).await.unwrap();
                            let epoch = epochs
                                .iter()
                                .find(|e| e.turn_id == turn_id.as_str())
                                .expect("pre-image must commit before send");
                            assert!(epoch.post.is_none());
                            assert_eq!(input.text, "edited");
                            let ops = db
                                .workspace_rewinds(path.to_string_lossy().into_owned())
                                .await
                                .unwrap();
                            if !ops.is_empty() {
                                assert_eq!(ops.last().unwrap().phase, "sending");
                                assert!(db.chat_items("s".into(), 0).await.unwrap().is_empty());
                            }
                            let _ = ack.send(if matches!(reply, Reply::SendUnknown) {
                                Err(CommandError::Closed)
                            } else {
                                Ok(())
                            });
                        }
                        _ => panic!("unexpected fixture command"),
                    }
                }
            });
            Self {
                _dir: dir,
                store,
                sup,
                root,
                actor,
            }
        }
        async fn operation(&self) -> WorkspaceRewind {
            std::fs::write(self.root.join("file"), b"before").unwrap();
            let pre = self.sup.capture_at(self.root.clone()).await.unwrap();
            std::fs::write(self.root.join("file"), b"after").unwrap();
            let post = self.sup.capture_at(self.root.clone()).await.unwrap();
            let epoch = Epoch {
                turn_id: "old".into(),
                pre,
                post: Some(post.clone()),
                error: None,
            };
            self.store
                .handle()
                .save_workspace_epoch("s".into(), epoch.clone())
                .await
                .unwrap();
            self.store
                .handle()
                .chat_item(ChatItem {
                    session_id: "s".into(),
                    id: "old".into(),
                    seq: 1,
                    at: 0,
                    kind: ItemKind::UserText,
                    body: "original".into(),
                    parent_id: None,
                    provider_uuid: Some("old".into()),
                })
                .await
                .unwrap();
            WorkspaceRewind {
                id: uuid::Uuid::new_v4().to_string(),
                session: "s".into(),
                workspace: post.root.to_string_lossy().into_owned(),
                phase: "preview".into(),
                plan: plan_restore(&[epoch], post).unwrap(),
                draft: "edited".into(),
                target_id: "old".into(),
                target_uuid: "old".into(),
                latest_uuid: "old".into(),
                through_seq: None,
                paths_started: 0,
                new_turn: None,
                error: None,
            }
        }
    }
    #[tokio::test]
    async fn terminal_capture_retries_with_a_fresh_snapshot_without_another_send() {
        let r = Rig::new(Reply::InvalidatedCapture).await;
        std::fs::write(r.root.join("file"), b"before").unwrap();
        let id = SessionId::new("s");
        let turn = r.sup.checkpoint_send(&id, TurnInput::text("edited")).await.unwrap();
        std::fs::write(r.root.join("file"), b"first capture").unwrap();
        let _serial = r.sup.inner.checkpoints.serial.lock().await;
        r.sup.finish_observed_epoch(&id, 10).await;
        let epochs = r.store.handle().workspace_epochs("s".into()).await.unwrap();
        let epoch = epochs.iter().find(|e| e.turn_id == turn.as_str()).unwrap();
        let post = epoch.post.as_ref().expect("completion must settle without another send");
        let current = r.sup.capture_at(r.root.clone()).await.unwrap();
        assert_eq!(post.tree, current.tree, "rejected capture must not be reused");
        assert_eq!(std::fs::read(r.root.join("file")).unwrap(), b"after invalidation");
        assert!(!lock(&r.sup.inner.checkpoints.active).contains_key(&id));
    }

    #[tokio::test]
    async fn combined_success_orders_files_native_archive_and_checkpointed_send() {
        let r = Rig::new(Reply::Success).await;
        let op = r.operation().await;
        let turn = r
            .sup
            .checkpoint_rewind_send(op, TurnInput::text("edited"))
            .await
            .unwrap();
        let records = r
            .store
            .handle()
            .workspace_rewinds(r.root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(records[0].phase, "complete");
        assert_eq!(records[0].new_turn, Some(turn.to_string()));
        assert_eq!(records[0].draft, "edited");
        assert_eq!(std::fs::read(r.root.join("file")).unwrap(), b"before");
    }
    #[tokio::test]
    async fn explicit_refusal_rolls_back_and_preserves_history() {
        let r = Rig::new(Reply::Refused).await;
        let op = r.operation().await;
        assert!(r
            .sup
            .checkpoint_rewind_send(op, TurnInput::text("edited"))
            .await
            .is_err());
        assert_eq!(std::fs::read(r.root.join("file")).unwrap(), b"after");
        assert_eq!(
            r.store
                .handle()
                .chat_items("s".into(), 0)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(WorkspaceLease::acquire(&r.root).is_ok());
    }
    #[tokio::test]
    async fn unknown_native_outcome_keeps_recovery_and_blocks_all_writers() {
        let r = Rig::new(Reply::Unknown).await;
        let op = r.operation().await;
        let id = op.id.clone();
        assert!(r
            .sup
            .checkpoint_rewind_send(op, TurnInput::text("edited"))
            .await
            .is_err());
        assert_eq!(std::fs::read(r.root.join("file")).unwrap(), b"before");
        assert!(r.sup.workspace_writable(&r.root).await.is_err());
        assert!(WorkspaceLease::acquire(&r.root).is_err());
        assert!(r
            .sup
            .checkpoint_recover(r.root.clone(), id.clone())
            .await
            .is_err());
        // Fixture cleanup only; production never clears an unknown native outcome.
        WorkspaceLease::recover(&r.root, &id)
            .unwrap()
            .resolve(&id)
            .unwrap();
    }
    #[tokio::test]
    async fn unknown_send_is_never_repeated() {
        let r = Rig::new(Reply::SendUnknown).await;
        let op = r.operation().await;
        let id = op.id.clone();
        assert!(r
            .sup
            .checkpoint_rewind_send(op, TurnInput::text("edited"))
            .await
            .is_err());
        let ops = r
            .store
            .handle()
            .workspace_rewinds(r.root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(ops[0].phase, "sending");
        assert!(ops[0].new_turn.is_some());
        assert!(r
            .sup
            .send_turn(&SessionId::new("s"), "edited")
            .await
            .is_err());
        if let Some(active) = lock(&r.sup.inner.checkpoints.active).get(&SessionId::new("s")) {
            active._lease.resolve(&id).unwrap();
        };
    }
    #[tokio::test]
    async fn confirmed_native_recovery_archives_without_repeating_a_cut_or_send() {
        let r = Rig::new(Reply::Success).await;
        let mut op = r.operation().await;
        let lease = WorkspaceLease::acquire(&r.root).unwrap();
        lease.block(&op.id).unwrap();
        r.store
            .handle()
            .prepare_rewind(op.id.clone(), op.session.clone(), op.target_id.clone())
            .await
            .unwrap();
        op.phase = "native-confirmed".into();
        op.through_seq = Some(10);
        r.store
            .handle()
            .save_workspace_rewind(op.clone())
            .await
            .unwrap();
        drop(lease);
        r.sup
            .checkpoint_recover(r.root.clone(), op.id)
            .await
            .unwrap();
        assert!(r
            .store
            .handle()
            .chat_items("s".into(), 0)
            .await
            .unwrap()
            .is_empty());
        let records = r
            .store
            .handle()
            .workspace_rewinds(r.root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(records[0].phase, "rewound-unsent");
        assert_eq!(records[0].draft, "edited");
        assert!(WorkspaceLease::acquire(&r.root).is_ok());
        assert!(r.sup.workspace_writable(&r.root).await.is_ok());
    }

    #[tokio::test]
    async fn recovery_reverses_only_journaled_filesystem_intents() {
        let r = Rig::new(Reply::Success).await;
        let mut op = r.operation().await;
        let lease = WorkspaceLease::acquire(&r.root).unwrap();
        lease.block(&op.id).unwrap();
        op.phase = "restoring".into();
        op.paths_started = 1;
        r.store
            .handle()
            .save_workspace_rewind(op.clone())
            .await
            .unwrap();
        r.sup
            .snapshots()
            .unwrap()
            .apply_change(&r.root, &op.plan.current.identity, &op.plan.changes[0])
            .unwrap();
        drop(lease);
        r.sup
            .checkpoint_recover(r.root.clone(), op.id)
            .await
            .unwrap();
        assert_eq!(std::fs::read(r.root.join("file")).unwrap(), b"after");
        assert!(WorkspaceLease::acquire(&r.root).is_ok());
    }
}

/// Recorded changes in one completed writing turn.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChanges {
    /// Native/local turn identity.
    pub turn_id: String,
    /// Paths and exact raw tree counts.
    pub files: Vec<FileChange>,
}
/// One path's textual additions and deletions.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path.
    pub path: String,
    /// Added lines.
    pub added: u64,
    /// Removed lines.
    pub deleted: u64,
    /// Binary files have no line counts.
    pub binary: bool,
}
/// Session-scoped recorded changes, excluding inherited project edits.
#[derive(serde::Serialize)]
pub struct SessionChanges {
    /// Cumulative delta through the last settled turn.
    pub files: Vec<FileChange>,
    /// Separate exact deltas for finished turns.
    pub turns: Vec<TurnChanges>,
}
impl Supervisor {
    /// Read counts only from saved complete boundaries, never fabricate from project Git totals.
    pub async fn session_changes(&self, id: &SessionId) -> Result<SessionChanges, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        let epochs = self
            .inner
            .store
            .visible_workspace_epochs(id.to_string())
            .await?;
        let snapshots = self.snapshots()?;
        tokio::task::spawn_blocking(move || {
            let stats = |before: &str, after: &str| -> Result<Vec<FileChange>, SupervisorError> {
                Ok(snapshots
                    .changes(before, after)
                    .map_err(failure)?
                    .into_iter()
                    .map(|(path, added, deleted, binary)| FileChange {
                        path,
                        added,
                        deleted,
                        binary,
                    })
                    .collect())
            };
            let mut turns = Vec::new();
            for epoch in &epochs {
                if let Some(post) = epoch.post.as_ref().filter(|_| epoch.error.is_none()) {
                    turns.push(TurnChanges {
                        turn_id: epoch.turn_id.clone(),
                        files: stats(&epoch.pre.tree, &post.tree)?,
                    });
                }
            }
            let files = match (
                epochs.first(),
                epochs.iter().rev().find_map(|e| e.post.as_ref()),
            ) {
                (Some(first), Some(last)) => stats(&first.pre.tree, &last.tree)?,
                _ => Vec::new(),
            };
            Ok(SessionChanges { files, turns })
        })
        .await
        .map_err(failure)?
    }
    /// Read a path's saved per-turn or cumulative session diff.
    pub async fn session_diff(
        &self,
        id: &SessionId,
        turn: Option<String>,
        path: String,
    ) -> Result<String, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        let epochs = self
            .inner
            .store
            .visible_workspace_epochs(id.to_string())
            .await?;
        let before = match &turn {
            Some(turn) => epochs.iter().find(|e| &e.turn_id == turn),
            None => epochs.first(),
        }
        .ok_or_else(|| failure("No recorded changes"))?
        .pre
        .tree
        .clone();
        let after = match &turn {
            Some(turn) => epochs
                .iter()
                .find(|e| &e.turn_id == turn)
                .and_then(|e| e.post.as_ref()),
            None => epochs.iter().rev().find_map(|e| e.post.as_ref()),
        }
        .ok_or_else(|| failure("Turn has not finished checkpointing"))?
        .tree
        .clone();
        let snapshots = self.snapshots()?;
        tokio::task::spawn_blocking(move || snapshots.diff(&before, &after, &path))
            .await
            .map_err(failure)?
            .map_err(failure)
    }
    /// Freeze a reviewable delta onto the original project. No project files change here.
    pub async fn preview_apply(
        &self,
        id: &SessionId,
    ) -> Result<brigadier_store::checkpoint::WorkspaceApply, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.require_session_available(id)?;
        let record = self
            .session(id)
            .await?
            .ok_or(SupervisorError::NoSuchSession)?;
        let source = record
            .worktree_path
            .ok_or_else(|| failure("This session already works in the project folder"))?;
        let project = self
            .project(
                record
                    .project_id
                    .as_deref()
                    .ok_or(SupervisorError::NoSuchProject)?,
            )
            .await?
            .ok_or(SupervisorError::NoSuchProject)?;
        let base = self
            .inner
            .store
            .workspace_epochs(id.to_string())
            .await?
            .first()
            .map(|e| e.pre.files.clone())
            .ok_or_else(|| failure("This session predates saved file baselines"))?;
        let snapshots = self.snapshots()?;
        // The original project is the worktree's ancestor, so one lease covers both captures.
        let lease = WorkspaceLease::acquire(&project.root_path).map_err(failure)?;
        let (source, plan) = tokio::task::spawn_blocking(move || {
            let source = snapshots.capture(&source, Coverage::default())?;
            let current = snapshots.capture(&project.root_path, Coverage::default())?;
            let plan = brigadier_core::checkpoint::plan_apply(&base, &source.files, current)?;
            snapshots.validate_support(&plan)?;
            Ok::<_, brigadier_core::checkpoint::Error>((source, plan))
        })
        .await
        .map_err(failure)?
        .map_err(failure)?;
        let op = brigadier_store::checkpoint::WorkspaceApply {
            id: uuid::Uuid::new_v4().to_string(),
            session: id.to_string(),
            source,
            plan,
            phase: "preview".into(),
            paths_started: 0,
            error: None,
        };
        self.inner.store.save_workspace_apply(op.clone()).await?;
        drop(lease);
        Ok(op)
    }
    /// Apply a confirmed preview, or finish that same journal after an interrupted apply.
    pub async fn apply_to_project(
        &self,
        id: &SessionId,
        ticket: String,
    ) -> Result<(), SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.require_session_available(id)?;
        let mut op = self
            .inner
            .store
            .workspace_applies(id.to_string())
            .await?
            .into_iter()
            .find(|o| o.id == ticket)
            .ok_or_else(|| failure("Apply preview expired"))?;
        if op.phase == "complete" {
            return WorkspaceLease::recover(&op.plan.current.root, &op.id)
                .map_err(failure)?
                .resolve(&op.id)
                .map_err(failure);
        }
        if !op.plan.conflicts.is_empty() {
            return Err(failure(format!(
                "Project changes conflict: {}",
                op.plan.conflicts.join(", ")
            )));
        }
        let fresh = op.phase == "preview";
        let lease = WorkspaceLease::recover(&op.plan.current.root, &op.id).map_err(failure)?;
        let snapshots = self.snapshots()?;
        if fresh {
            let check = op.clone();
            let snap = snapshots.clone();
            tokio::task::spawn_blocking(move || {
                if snap
                    .capture(&check.source.root, check.source.coverage.clone())?
                    .files
                    != check.source.files
                {
                    return Err(brigadier_core::checkpoint::Error::Unavailable(
                        "Session files changed; refresh the preview".into(),
                    ));
                }
                snap.validate_restore(&check.plan)
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            op.phase = "applying".into();
            self.inner.store.save_workspace_apply(op.clone()).await?;
        } else {
            let check = op.clone();
            let snap = snapshots.clone();
            tokio::task::spawn_blocking(move || {
                let current = snap.capture(
                    &check.plan.current.root,
                    check.plan.current.coverage.clone(),
                )?;
                if current.identity != check.plan.current.identity
                    || current.git != check.plan.current.git
                {
                    return Err(brigadier_core::checkpoint::Error::Unavailable(
                        "Project Git state changed during recovery".into(),
                    ));
                }
                Ok::<_, brigadier_core::checkpoint::Error>(())
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
        }
        lease.block(&op.id).map_err(failure)?;
        let result = async {
            for (index, change) in op.plan.changes.clone().into_iter().enumerate() {
                op.paths_started = index + 1;
                self.inner.store.save_workspace_apply(op.clone()).await?;
                let snap = snapshots.clone();
                let root = op.plan.current.root.clone();
                let identity = op.plan.current.identity.clone();
                tokio::task::spawn_blocking(move || snap.apply_change(&root, &identity, &change))
                    .await
                    .map_err(failure)?
                    .map_err(failure)?;
            }
            Ok::<_, SupervisorError>(())
        }
        .await;
        match result {
            Ok(()) => {
                lease.resolve(&op.id).map_err(failure)?;
                op.phase = "complete".into();
                op.error = None;
                self.inner.store.save_workspace_apply(op.clone()).await?;
                Ok(())
            }
            Err(e) => {
                op.phase = "failed".into();
                op.error = Some(e.to_string());
                self.inner.store.save_workspace_apply(op).await?;
                Err(e)
            }
        }
    }
}
impl Supervisor {
    /// File-only undo of a recorded turn, guarded against later manual or agent edits.
    pub async fn preview_undo(
        &self,
        id: &SessionId,
        turn: String,
    ) -> Result<brigadier_store::checkpoint::WorkspaceApply, SupervisorError> {
        let _serial = self.inner.checkpoints.serial.lock().await;
        self.require_session_available(id)?;
        let root = self.checkpoint_root(id).await?;
        let _lease = WorkspaceLease::acquire(&root).map_err(failure)?;
        let epoch = self
            .inner
            .store
            .workspace_epochs(id.to_string())
            .await?
            .into_iter()
            .find(|e| e.turn_id == turn)
            .ok_or_else(|| failure("Turn checkpoint unavailable"))?;
        let current = self.capture_at(root).await?;
        let plan = plan_restore(&[epoch], current.clone()).map_err(failure)?;
        let snapshots = self.snapshots()?;
        let check = plan.clone();
        tokio::task::spawn_blocking(move || snapshots.validate_support(&check))
            .await
            .map_err(failure)?
            .map_err(failure)?;
        let op = brigadier_store::checkpoint::WorkspaceApply {
            id: uuid::Uuid::new_v4().to_string(),
            session: id.to_string(),
            source: current,
            plan,
            phase: "preview".into(),
            paths_started: 0,
            error: None,
        };
        self.inner.store.save_workspace_apply(op.clone()).await?;
        Ok(op)
    }
}
