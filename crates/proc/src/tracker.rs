//! The live registry: what to write at spawn, what to delete at exit, and what to kill on quit.
//!
//! Deliberately free of every core type — session ids are `&str`, paths are `&Path` — so the
//! Tauri layer can adapt this to its own `ProcessTracker` trait without this crate depending on
//! the supervisor. The mutex is `std::sync::Mutex`, never tokio's: it is locked from the main
//! thread inside the exit hook (`docs/research/tauri-runtime.md` §7 pitfall 4).

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::pidfile::{now_unix, PidDir, PidRecord, PID_DOMAIN};
use crate::proc::{bsd_info, self_info};
use crate::sweep::{
    kill_groups_sync, live_members, matches_record, ChildIdentity, KillOutcome, SweepAction,
    SweepOutcome,
};

/// Session id → the child's recorded identity, for every child this app launch still owns.
///
/// The whole identity is kept, not just the pgid: the exit kill re-checks it against the live
/// process before signalling, exactly as the startup sweep does. A pgid can be recycled while the
/// app is running — a long-lived app plus a session whose group died is all it takes — and
/// `killpg`ing a stranger's group is the worst failure this component can have
/// (`docs/research/orphan-sweep.md` §5).
pub struct PidTracker {
    dir: PidDir,
    run_id: String,
    live: Mutex<HashMap<String, ChildIdentity>>,
}

impl std::fmt::Debug for PidTracker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PidTracker")
            .field("dir", &self.dir.path())
            .field("run_id", &self.run_id)
            .field("live", &self.live_count())
            .finish()
    }
}

impl PidTracker {
    /// Binds a tracker to a pid directory and this launch's run id.
    pub fn new(dir: PidDir, run_id: impl Into<String>) -> Self {
        Self { dir, run_id: run_id.into(), live: Mutex::new(HashMap::new()) }
    }

    /// The directory records are written to.
    #[must_use]
    pub fn dir(&self) -> &PidDir {
        &self.dir
    }

    /// This launch's run id — pass it to [`crate::sweep::sweep`] so our own previous run's
    /// records are swept rather than mistaken for another instance's.
    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Records a freshly spawned child. Call it immediately after `spawn`, before the first
    /// protocol frame: the window between `fork` and this call is the only unrecoverable one.
    ///
    /// # Errors
    /// [`io::ErrorKind::NotFound`] if `pid` is already gone or this process cannot describe
    /// itself — either way there is no identity to record, and a record without one would be
    /// refused by the sweep anyway.
    ///
    /// [`io::ErrorKind::InvalidInput`] if the child is in **this app's own process group**, which
    /// is what a caller that forgot `process_group(0)` produces. Recording it would make
    /// [`Self::shutdown_sync`] `killpg` the app itself — and on a user quit, the terminal that
    /// launched it. Refusing the record loses orphan recovery for that session; accepting it
    /// loses the app.
    ///
    /// Otherwise, any write failure.
    pub fn track(&self, session_id: &str, pid: u32, binary: &Path, cwd: &Path) -> io::Result<()> {
        let child = bsd_info(pid).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, format!("pid {pid} has no process info"))
        })?;
        let owner = self_info().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "this process has no process info")
        })?;
        if child.pgid == owner.pgid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "pid {pid} is in this app's own process group {}; spawn it with \
                     process_group(0) or the exit kill would signal the app itself",
                    owner.pgid
                ),
            ));
        }
        let rec = PidRecord {
            session_id: session_id.to_string(),
            run_id: self.run_id.clone(),
            pid,
            pgid: child.pgid,
            start_tvsec: child.start_tvsec,
            start_tvusec: child.start_tvusec,
            pid_domain: PID_DOMAIN.to_string(),
            owner_pid: owner.pid,
            owner_start_tvsec: owner.start_tvsec,
            owner_start_tvusec: owner.start_tvusec,
            binary: binary.display().to_string(),
            cwd: cwd.display().to_string(),
            written_at_unix: now_unix(),
        };
        self.dir.write(&rec)?;
        self.lock().insert(session_id.to_string(), ChildIdentity::of_record(&rec));
        Ok(())
    }

    /// Forgets a session and deletes its record. Idempotent; a session that was never tracked is
    /// not an error. Failures are logged rather than returned — every caller is a terminal event
    /// handler that has nothing useful to do with the error.
    pub fn untrack(&self, session_id: &str) {
        self.lock().remove(session_id);
        if let Err(e) = self.dir.remove(session_id) {
            tracing::warn!(session_id, error = %e, "could not delete pid file");
        }
    }

    /// How many sessions are currently tracked.
    #[must_use]
    pub fn live_count(&self) -> usize {
        self.lock().len()
    }

    /// The process-group id recorded for a session, if it is tracked.
    #[must_use]
    pub fn pgid_of(&self, session_id: &str) -> Option<u32> {
        self.lock().get(session_id).map(|id| id.pgid)
    }

    /// Test hook: overwrites the identity recorded for a live session, so a suite can simulate a
    /// recycled pid without waiting for the kernel to recycle one. Returns `false` if the session
    /// is not tracked. Not part of the supported API; the app never calls it.
    #[doc(hidden)]
    pub fn set_identity_for_tests(
        &self,
        session_id: &str,
        pid: u32,
        pgid: u32,
        start_tvsec: u64,
        start_tvusec: u64,
    ) -> bool {
        match self.lock().get_mut(session_id) {
            Some(id) => {
                *id = ChildIdentity { pid, pgid, start_tvsec, start_tvusec };
                true
            }
            None => false,
        }
    }

    /// Kills every tracked group and deletes its record. Synchronous, main-thread safe, and it
    /// costs **one** grace period in total rather than one per session: every group is `SIGTERM`ed
    /// before any of them is waited on.
    ///
    /// Identity is re-checked before anything is signalled, with the same predicate the startup
    /// sweep uses (`sweep::matches_record`). A group whose live members are no longer the child we
    /// recorded is reported as [`SweepAction::StartTimeMismatch`] and **never signalled**; its
    /// record is still deleted, because a record we can no longer trust is worse than none.
    ///
    /// The record is deleted after the kill, not before — if the app dies mid-shutdown the record
    /// must still be there for the next launch's sweep.
    pub fn shutdown_sync(&self, grace: Duration) -> Vec<SweepOutcome> {
        let mut tracked: Vec<(String, ChildIdentity)> = self.lock().drain().collect();
        tracked.sort_by(|a, b| a.0.cmp(&b.0));
        if tracked.is_empty() {
            return Vec::new();
        }

        // Pass 1: decide, signalling nothing.
        let decided: Vec<(String, ChildIdentity, Option<SweepAction>)> = tracked
            .into_iter()
            .map(|(session_id, id)| {
                let settled = settle(&session_id, id);
                (session_id, id, settled)
            })
            .collect();

        // Pass 2: one SIGTERM fan-out and one shared grace for the groups that are still ours.
        let pgids: Vec<u32> = decided
            .iter()
            .filter(|(_, _, settled)| settled.is_none())
            .map(|(_, id, _)| id.pgid)
            .collect();
        let mut killed = kill_groups_sync(&pgids, grace).into_iter();

        // Pass 3: delete the records and report.
        let mut outcomes = Vec::with_capacity(decided.len());
        for (session_id, id, settled) in decided {
            let kill: Option<KillOutcome> = if settled.is_some() { None } else { killed.next() };
            let action = match (settled, kill) {
                (Some(action), _) => action,
                (None, Some(k)) if k.refused => {
                    SweepAction::Unreadable(format!("pgid {} is not signallable", id.pgid))
                }
                (None, Some(k)) if k.members == 0 => SweepAction::AlreadyGone,
                (None, Some(k)) => {
                    SweepAction::Killed { members: k.members, escalated: k.escalated }
                }
                // `kill_groups_sync` returns one outcome per pgid in order, so this is unreachable.
                (None, None) => {
                    SweepAction::Unreadable(format!("no kill outcome for pgid {}", id.pgid))
                }
            };
            if let Err(e) = self.dir.remove(&session_id) {
                tracing::warn!(session_id, error = %e, "could not delete pid file");
            }
            tracing::info!(
                session_id,
                pgid = id.pgid,
                action = ?action,
                still_alive = ?kill.map(|k| k.still_alive),
                "shutdown kill"
            );
            outcomes.push(SweepOutcome { session_id, pgid: id.pgid, action });
        }
        outcomes
    }

    /// A poisoned mutex is not a reason to abort a shutdown: the map is a plain
    /// `HashMap<String, ChildIdentity>` with no invariant a panicking thread could have broken.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ChildIdentity>> {
        self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The pre-signal decision for one tracked session: `Some(action)` when nothing may be signalled,
/// `None` when the group is ours and alive and belongs in the kill fan-out.
fn settle(session_id: &str, id: ChildIdentity) -> Option<SweepAction> {
    if id.pgid <= 1 {
        return Some(SweepAction::Unreadable(format!("pgid {} is not signallable", id.pgid)));
    }
    let members = live_members(id.pgid);
    if members.is_empty() {
        return Some(SweepAction::AlreadyGone);
    }
    if !matches_record(id, &members) {
        tracing::warn!(
            session_id,
            pgid = id.pgid,
            recorded_pid = id.pid,
            recorded_start = format!("{}.{}", id.start_tvsec, id.start_tvusec),
            "tracked pgid is no longer the child we spawned; refusing to kill at exit"
        );
        return Some(SweepAction::StartTimeMismatch);
    }
    None
}
