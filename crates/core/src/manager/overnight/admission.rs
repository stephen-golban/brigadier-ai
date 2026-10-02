//! Worker admission for overnight runs (PLAN.md §10.7).
//!
//! "max N workers" caps how many of a run's tasks execute at once: a run task takes a slot
//! when a turn of its worker starts (a new session, a resumed or restarted one, a fresh
//! session after a hand-off or fallback, a message or Continue to an idle worker) and gives
//! it back when the turn ends without another following, or the session ends. A worker that
//! reported and waits for its checks holds none, so its checks can run under max 1. Queued
//! tasks, the orchestrator and a worker's own sub-agents hold none. Sessions without a run
//! are never capped.
//!
//! Checks build and test: a run's verifier also takes the daemon-wide build lease, so one
//! such check builds at a time, and every run worker runs at low OS priority (the spawn's
//! `low_priority`), so its builds yield to the user's own work.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::super::SessionManager;
use crate::model::{OvernightRunId, TaskId};
use crate::work::{Task, TaskKind};
use crate::{Error, Result};

/// How long a waiting task sleeps between looks when no slot is freed meanwhile (a lowered
/// cap or an ended run is noticed this way too).
const RECHECK: Duration = Duration::from_secs(20);

pub(crate) struct Admission {
    /// The tasks of each run executing now.
    held: std::sync::Mutex<HashMap<OvernightRunId, HashSet<TaskId>>>,
    /// Signalled whenever a slot or the build lease is given back.
    freed: Notify,
    build: Arc<Semaphore>,
    /// The task holding the build lease, with it.
    building: std::sync::Mutex<Option<(TaskId, OwnedSemaphorePermit)>>,
}

impl Default for Admission {
    fn default() -> Self {
        Self {
            held: Default::default(),
            freed: Notify::new(),
            build: Arc::new(Semaphore::new(1)),
            building: Default::default(),
        }
    }
}

/// Whether a run task may execute now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Slot {
    /// Not a run task, or it holds a slot now.
    Admitted,
    /// Its run has this many executing already.
    Full { cap: u32 },
}

impl Admission {
    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<OvernightRunId, HashSet<TaskId>>> {
        self.held.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl SessionManager {
    /// Takes a slot for `task` if its run has one free (or it holds one already). A task of
    /// a run that is over may not start.
    pub(crate) fn try_admit_run_task(&self, task: &Task) -> Result<Slot> {
        let Some(context) = &task.run else {
            return Ok(Slot::Admitted);
        };
        let active = self
            .overnight
            .active
            .get(&task.conversation_id)
            .filter(|active| active.id == context.run_id)
            .ok_or_else(|| {
                Error::Invalid(format!(
                    "task-{} worked for an overnight run that has ended; nothing more of it starts.",
                    task.number
                ))
            })?;
        let mut held = self.overnight.admission.held();
        let tasks = held.entry(context.run_id.clone()).or_default();
        if tasks.contains(&task.id) {
            return Ok(Slot::Admitted);
        }
        match active.max_workers {
            Some(cap) if tasks.len() >= cap as usize => Ok(Slot::Full { cap }),
            _ => {
                tasks.insert(task.id.clone());
                Ok(Slot::Admitted)
            }
        }
    }

    /// Waits until `task` may execute (a slot of its run, and the build lease for a run's
    /// verifier), showing why it waits meanwhile. Fails when the task ends or its run is over
    /// while it waits.
    pub(crate) async fn admit_run_task(&self, task: &Task) -> Result<()> {
        if task.run.is_none() {
            return Ok(());
        }
        let mut waited = false;
        loop {
            let freed = self.overnight.admission.freed.notified();
            match self.try_admit_run_task(task)? {
                Slot::Admitted => break,
                Slot::Full { cap } => {
                    if !waited {
                        waited = true;
                        self.set_task_blocked(
                            &task.id,
                            Some(format!(
                                "Waiting for a free worker: the run works with at most {cap} at once."
                            )),
                        )
                        .await;
                    }
                    let _ = tokio::time::timeout(RECHECK, freed).await;
                    self.still_wanted(task).await?;
                }
            }
        }
        if task.kind == TaskKind::Verify && !self.holds_build_lease(&task.id) {
            let lease = self.overnight.admission.build.clone();
            let permit = match lease.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    waited = true;
                    self.set_task_blocked(
                        &task.id,
                        Some("Waiting for another check's build and tests to finish.".into()),
                    )
                    .await;
                    loop {
                        if let Ok(Ok(permit)) =
                            tokio::time::timeout(RECHECK, lease.clone().acquire_owned()).await
                        {
                            break permit;
                        }
                        if let Err(err) = self.still_wanted(task).await {
                            self.release_run_task(&task.id);
                            return Err(err);
                        }
                    }
                }
            };
            *self
                .overnight
                .admission
                .building
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some((task.id.clone(), permit));
        }
        if waited {
            self.set_task_blocked(&task.id, None).await;
        }
        Ok(())
    }

    /// Gives back what `task_id` held: its run's slot and the build lease.
    pub(crate) fn release_run_task(&self, task_id: &TaskId) {
        let admission = &self.overnight.admission;
        let mut released = false;
        for tasks in admission.held().values_mut() {
            released |= tasks.remove(task_id);
        }
        {
            let mut building = admission.building.lock().unwrap_or_else(|p| p.into_inner());
            if building.as_ref().is_some_and(|(id, _)| id == task_id) {
                *building = None;
                released = true;
            }
        }
        if released {
            admission.freed.notify_waiters();
        }
    }

    /// Gives back a run task's slot when no turn of its worker runs (a call that took it
    /// started none).
    pub(crate) async fn release_if_idle(&self, task: &Task) {
        if task.run.is_none() {
            return;
        }
        let busy = match self.existing_task_live(&task.id) {
            Some(live) => live.busy().await,
            None => false,
        };
        if !busy {
            self.release_run_task(&task.id);
        }
    }

    fn holds_build_lease(&self, task_id: &TaskId) -> bool {
        self.overnight
            .admission
            .building
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .is_some_and(|(id, _)| id == task_id)
    }

    /// Fails when the task waiting for a slot ended meanwhile (stopped), or its run is over.
    async fn still_wanted(&self, task: &Task) -> Result<()> {
        let now = self.task_by_id(&task.conversation_id, &task.id).await?;
        if now.state.is_final() {
            return Err(Error::Invalid(format!("task-{} has ended", task.number)));
        }
        let over = self
            .overnight
            .active
            .get(&task.conversation_id)
            .is_none_or(|active| task.run.as_ref().is_none_or(|run| run.run_id != active.id));
        if over {
            return Err(Error::Invalid(format!(
                "task-{} worked for an overnight run that has ended; nothing more of it starts.",
                task.number
            )));
        }
        Ok(())
    }
}
