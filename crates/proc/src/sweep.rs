//! The startup sweep and the synchronous group kill, both pure `std` — no tokio anywhere.
//!
//! The exit hook runs on Tauri's main thread, which is not a tokio worker, and
//! `tauri::async_runtime::block_on` panics from inside a runtime thread
//! (`docs/research/tauri-runtime.md` §7 pitfall 4). So every kill path here is
//! `killpg` + `std::thread::sleep` and nothing else.
//!
//! The rules that are not negotiable, all from `docs/research/orphan-sweep.md`:
//!
//! - Liveness is by group enumeration, never by leader pid: a group outlives its leader (§3).
//! - A record whose start time does not match the live process is **unlinked, never killed** —
//!   deleting a stale file is free, `killpg`ing a stranger's group is the worst failure this
//!   component can have (§5).
//! - `pgid <= 1` is refused outright; `killpg` on it is platform-specific (§1).

use std::path::Path;
use std::time::{Duration, Instant};

use crate::pidfile::{PidDir, PidRecord, PID_DOMAIN};
use crate::proc::{bsd_info, group_alive, group_members, BsdInfo, SZOMB};

/// How often the kill loops re-check whether a group has drained.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// How long to wait after `SIGKILL` before giving up and reporting `still_alive`. A group of
/// `sleep`s died 6.3 ms after `SIGKILL` in measurement 4, so this is pure slack.
const SIGKILL_GRACE: Duration = Duration::from_millis(500);

/// The recommended sweep and exit grace. Not a measurement of `claude`: every grace number in
/// `orphan-sweep.md` comes from `sleep` and `sh`, and the CLI's own `SIGTERM` handling is
/// unverified (§5, "Not checked"). Re-measure before treating it as anything but a starting value.
pub const DEFAULT_GRACE: Duration = Duration::from_millis(400);

/// What [`kill_group_sync`] did to one process group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KillOutcome {
    /// Live, non-zombie members seen before the first signal.
    pub members: usize,
    /// Whether the group survived `SIGTERM` and had to be `SIGKILL`ed.
    pub escalated: bool,
    /// Whether anything was still in the group after the escalation.
    pub still_alive: bool,
    /// Whether the group was refused as unsignallable (`pgid <= 1`, or not representable as a
    /// `pid_t`). Nothing was signalled.
    pub refused: bool,
}

impl KillOutcome {
    const fn refused() -> Self {
        Self { members: 0, escalated: false, still_alive: false, refused: true }
    }
}

/// What the sweep did with one pid file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepOutcome {
    /// The record's session id, or the file's basename when the record could not be parsed.
    pub session_id: String,
    /// The group that was considered. `0` when the record was unusable.
    pub pgid: u32,
    /// What happened.
    pub action: SweepAction,
}

/// The five things that can happen to a pid record at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SweepAction {
    /// The group was ours, was alive, and was signalled. The file was deleted.
    Killed {
        /// Live members seen before the first signal.
        members: usize,
        /// Whether `SIGKILL` was needed.
        escalated: bool,
    },
    /// The group was already empty. The file was deleted.
    AlreadyGone,
    /// The pgid is now somebody else's, or the leader's start time does not match what was
    /// recorded. **Nothing was signalled**; the file was deleted.
    StartTimeMismatch,
    /// Another app instance owns this record and is still running. The file was left alone.
    OwnerAlive,
    /// The file could not be used — a parse failure, a foreign `pid_domain`, or `pgid <= 1`.
    /// Nothing was signalled; the file was deleted.
    Unreadable(String),
}

/// `SIGTERM` the group, wait up to `grace`, then `SIGKILL` whatever is left.
///
/// Refuses `pgid <= 1`. Returns without signalling if the group is already empty.
#[must_use]
pub fn kill_group_sync(pgid: u32, grace: Duration) -> KillOutcome {
    kill_groups_sync(&[pgid], grace).into_iter().next().unwrap_or_else(KillOutcome::refused)
}

/// [`kill_group_sync`] over many groups, with **one** shared grace period rather than one each.
///
/// Every group is `SIGTERM`ed before any of them is waited on, so the whole shutdown costs one
/// grace period no matter how many sessions are live (`docs/research/orphan-sweep.md` §6).
/// Outcomes come back in the same order as `pgids`.
#[must_use]
pub fn kill_groups_sync(pgids: &[u32], grace: Duration) -> Vec<KillOutcome> {
    let mut outcomes: Vec<KillOutcome> = pgids
        .iter()
        .map(|&pgid| {
            if pgid <= 1 || i32::try_from(pgid).is_err() {
                KillOutcome::refused()
            } else {
                let live = live_members(pgid);
                KillOutcome {
                    members: live.len(),
                    escalated: false,
                    still_alive: !live.is_empty(),
                    refused: false,
                }
            }
        })
        .collect();

    let signal_targets: Vec<(usize, u32)> = outcomes
        .iter()
        .enumerate()
        .filter(|(_, o)| !o.refused && o.still_alive)
        .map(|(i, _)| (i, pgids[i]))
        .collect();
    if signal_targets.is_empty() {
        return outcomes;
    }

    for &(_, pgid) in &signal_targets {
        send(pgid, Sig::Term);
    }
    wait_until_drained(&signal_targets, grace);

    let survivors: Vec<(usize, u32)> =
        signal_targets.iter().copied().filter(|&(_, pgid)| group_alive(pgid)).collect();
    for &(idx, pgid) in &survivors {
        tracing::warn!(pgid, "process group survived SIGTERM; escalating to SIGKILL");
        outcomes[idx].escalated = true;
        send(pgid, Sig::Kill);
    }
    if !survivors.is_empty() {
        wait_until_drained(&survivors, SIGKILL_GRACE);
    }

    for &(idx, pgid) in &signal_targets {
        outcomes[idx].still_alive = group_alive(pgid);
    }
    outcomes
}

/// The live, non-zombie members of `pgid`. A zombie cannot be killed twice, and `bsd_info`
/// already returns `None` for one (`docs/research/orphan-sweep.md` measurement 9), so this is
/// the honest "is there anything to signal" answer.
pub(crate) fn live_members(pgid: u32) -> Vec<BsdInfo> {
    group_members(pgid).into_iter().filter_map(bsd_info).filter(|i| i.status != SZOMB).collect()
}

/// Sleeps in [`POLL_INTERVAL`] steps until every group is empty or `grace` has elapsed.
fn wait_until_drained(targets: &[(usize, u32)], grace: Duration) {
    let deadline = Instant::now() + grace;
    loop {
        if !targets.iter().any(|&(_, pgid)| group_alive(pgid)) {
            return;
        }
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        std::thread::sleep(POLL_INTERVAL.min(deadline - now));
    }
}

#[derive(Clone, Copy)]
enum Sig {
    Term,
    Kill,
}

#[cfg(unix)]
fn send(pgid: u32, sig: Sig) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let Ok(raw) = i32::try_from(pgid) else { return };
    let signal = match sig {
        Sig::Term => Signal::SIGTERM,
        Sig::Kill => Signal::SIGKILL,
    };
    if let Err(e) = killpg(Pid::from_raw(raw), signal) {
        tracing::debug!(pgid, signal = ?signal, error = %e, "killpg failed");
    }
}

#[cfg(not(unix))]
fn send(pgid: u32, _sig: Sig) {
    // No process groups off unix; the Windows job-object equivalent is unresearched
    // (`docs/research/orphan-sweep.md` "Not checked").
    tracing::warn!(pgid, "process-group kill is unimplemented on this platform");
}


/// The identity a pid record claims for its child: the pid, the group it led, and the kernel
/// start time that tells it apart from a recycled pid.
///
/// The sweep and the exit kill both check it against the live process before signalling, so it
/// lives here rather than in either caller (`docs/research/orphan-sweep.md` §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChildIdentity {
    /// The child's pid as recorded at spawn.
    pub(crate) pid: u32,
    /// The process group that was recorded — the thing that actually gets signalled.
    pub(crate) pgid: u32,
    /// Kernel start time of the child, whole seconds.
    pub(crate) start_tvsec: u64,
    /// Kernel start time of the child, microsecond remainder.
    pub(crate) start_tvusec: u64,
}

impl ChildIdentity {
    /// The identity a parsed record claims.
    pub(crate) fn of_record(rec: &PidRecord) -> Self {
        Self {
            pid: rec.pid,
            pgid: rec.pgid,
            start_tvsec: rec.start_tvsec,
            start_tvusec: rec.start_tvusec,
        }
    }
}

/// What pass 1 decided about one pid file.
enum Verdict {
    /// The action is already known and nothing will be signalled.
    Settled(SweepAction),
    /// The group is ours and alive; pass 2 signals it with everyone else's.
    Kill,
}

/// One pid file carried between the sweep's passes.
struct Pending {
    path: std::path::PathBuf,
    session_id: String,
    pgid: u32,
    /// `None` when the file could not be parsed.
    rec: Option<PidRecord>,
    verdict: Verdict,
}

/// Walks every pid file in `dir`, disposing of each one exactly once.
///
/// A record is swept when its owner is provably dead, or when it carries `current_run_id` — that
/// is our own previous run, whose owner pid may well have been recycled by us. A record owned by
/// a *different*, still-live app instance is left completely alone, which is how two instances
/// share one directory without a lock file (`docs/research/orphan-sweep.md` §4).
///
/// Runs in two passes: every record is judged without signalling, then every group that is ours
/// and alive is killed by a single [`kill_groups_sync`] call. The whole sweep therefore costs
/// **one** grace period, not one per orphan (§6) — which matters because it runs before the first
/// window is shown.
///
/// Every file it acts on is deleted; only [`SweepAction::OwnerAlive`] leaves one behind.
#[must_use]
pub fn sweep(dir: &PidDir, current_run_id: &str, grace: Duration) -> Vec<SweepOutcome> {
    // Pass 1: decide, signalling nothing.
    let mut pending: Vec<Pending> = Vec::new();
    for (path, parsed) in dir.read_all() {
        match parsed {
            Ok(rec) => {
                let verdict = judge(&rec, current_run_id);
                pending.push(Pending {
                    path,
                    session_id: rec.session_id.clone(),
                    pgid: rec.pgid,
                    rec: Some(rec),
                    verdict,
                });
            }
            Err(e) => {
                tracing::warn!(file = %path.display(), error = %e, "unparseable pid file; deleting");
                pending.push(Pending {
                    session_id: stem(&path),
                    path,
                    pgid: 0,
                    rec: None,
                    verdict: Verdict::Settled(SweepAction::Unreadable(e.to_string())),
                });
            }
        }
    }

    // Pass 2: one SIGTERM fan-out and one shared grace for every group we are killing.
    let pgids: Vec<u32> =
        pending.iter().filter(|p| matches!(p.verdict, Verdict::Kill)).map(|p| p.pgid).collect();
    let mut killed = kill_groups_sync(&pgids, grace).into_iter();

    // Pass 3: delete the files and report, in the directory's order.
    let mut outcomes = Vec::with_capacity(pending.len());
    for p in pending {
        let action = match p.verdict {
            Verdict::Settled(action) => action,
            // `kill_groups_sync` returns one outcome per pgid in order, so `next` is `Some` here.
            Verdict::Kill => match killed.next() {
                Some(k) if k.refused => {
                    SweepAction::Unreadable(format!("pgid {} is not signallable", p.pgid))
                }
                Some(k) if k.members == 0 => SweepAction::AlreadyGone,
                Some(k) => SweepAction::Killed { members: k.members, escalated: k.escalated },
                None => SweepAction::Unreadable(format!("no kill outcome for pgid {}", p.pgid)),
            },
        };
        if action != SweepAction::OwnerAlive {
            discard(&p.path);
        }
        tracing::info!(
            session_id = %p.session_id,
            run_id = p.rec.as_ref().map_or("", |r| r.run_id.as_str()),
            pgid = p.pgid,
            binary = p.rec.as_ref().map_or("", |r| r.binary.as_str()),
            cwd = p.rec.as_ref().map_or("", |r| r.cwd.as_str()),
            action = ?action,
            "swept pid record"
        );
        outcomes.push(SweepOutcome { session_id: p.session_id, pgid: p.pgid, action });
    }
    outcomes
}

/// The §5 decision procedure for one parsed record. Reads the kernel; signals nothing and touches
/// no file.
fn judge(rec: &PidRecord, current_run_id: &str) -> Verdict {
    if rec.pid_domain != PID_DOMAIN {
        let msg = format!("pid_domain {:?} is not {PID_DOMAIN:?}", rec.pid_domain);
        return Verdict::Settled(SweepAction::Unreadable(msg));
    }
    if rec.pgid <= 1 {
        return Verdict::Settled(SweepAction::Unreadable(format!(
            "pgid {} is not signallable",
            rec.pgid
        )));
    }
    // A record from our own launch is ours to sweep even though "the owner" (a previous process
    // with the same run id) may share a recycled pid with something live.
    if rec.run_id != current_run_id && owner_alive(rec) {
        return Verdict::Settled(SweepAction::OwnerAlive);
    }

    let members = live_members(rec.pgid);
    if members.is_empty() {
        return Verdict::Settled(SweepAction::AlreadyGone);
    }

    if !matches_record(ChildIdentity::of_record(rec), &members) {
        tracing::warn!(
            pgid = rec.pgid,
            recorded_pid = rec.pid,
            recorded_start = format!("{}.{}", rec.start_tvsec, rec.start_tvusec),
            "pgid recycled; refusing to kill"
        );
        return Verdict::Settled(SweepAction::StartTimeMismatch);
    }

    Verdict::Kill
}

/// Is this group still the one we recorded?
///
/// With the leader alive the answer is exact: same pid, same `(sec, usec)`, same pgid. With the
/// leader gone there is no anchor, and the fallback — every survivor still reports our pgid and
/// none of them predates the record — is a heuristic, not a proof (§5). It is strictly better
/// than killing blind.
///
/// `pub(crate)` because the exit kill in [`crate::tracker`] must apply the identical test before
/// it signals anything: a tracked pgid can be recycled while the app is running, too.
pub(crate) fn matches_record(id: ChildIdentity, members: &[BsdInfo]) -> bool {
    let recorded_start = (id.start_tvsec, id.start_tvusec);
    match bsd_info(id.pid) {
        Some(leader) => {
            leader.started_at(id.start_tvsec, id.start_tvusec) && leader.pgid == id.pgid
        }
        None => members
            .iter()
            .all(|m| m.pgid == id.pgid && (m.start_tvsec, m.start_tvusec) >= recorded_start),
    }
}

/// Whether the app instance that wrote this record is still running, by the same
/// `(pid, sec, usec)` test used on the child.
fn owner_alive(rec: &PidRecord) -> bool {
    bsd_info(rec.owner_pid)
        .is_some_and(|i| i.started_at(rec.owner_start_tvsec, rec.owner_start_tvusec))
}

fn discard(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(file = %path.display(), error = %e, "could not delete pid file");
        }
    }
}

fn stem(path: &Path) -> String {
    path.file_stem().map_or_else(String::new, |s| s.to_string_lossy().into_owned())
}
