//! Real process groups, real signals, no `claude`.
//!
//! Every test spawns `sleep 30` and friends behind a [`Group`] guard whose `Drop` kills the group,
//! reaps the leader, and then **asserts its own group is empty**, so a leak is attributed to the
//! test that caused it rather than to whichever test happens to run last. The suite's final test
//! is a scoped backstop: it fails only on `sleep 30` processes whose parent chain reaches this
//! test process, and merely reports anything else.

#![cfg(target_os = "macos")]

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use brigadier_proc::pidfile::{now_unix, PidDir, PidRecord, PID_DOMAIN};
use brigadier_proc::proc::{bsd_info, group_alive, group_members, self_info, BsdInfo};
use brigadier_proc::sweep::{kill_group_sync, sweep, SweepAction};
use brigadier_proc::tracker::PidTracker;

const GRACE: Duration = Duration::from_millis(400);

/// The slack `sweep` allows after `SIGKILL` before it gives up, mirrored from
/// `sweep::SIGKILL_GRACE` (private).
const SIGKILL_GRACE: Duration = Duration::from_millis(500);

/// Above macOS's pid ceiling (~99999), so it can never name a live process. Stands in for the app
/// instance that spawned the child and has since died.
const DEAD_OWNER_PID: u32 = 999_997;

/// A spawned process group that always dies with the test.
struct Group {
    child: Child,
    pgid: u32,
    leader: BsdInfo,
}

impl Group {
    /// Spawns `sh -c script` in its own process group and reads back the leader's identity.
    fn spawn(script: &str) -> Self {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.process_group(0);
        let child = cmd.spawn().expect("spawn /bin/sh");
        let pid = child.id();
        let leader = bsd_info(pid).expect("the child we just spawned has no process info");
        assert_eq!(leader.pid, pid);
        assert_eq!(leader.pgid, pid, "process_group(0) should make the child its own leader");
        Self { child, pgid: pid, leader }
    }

    /// A record as a *previous, now-dead* app instance would have written it.
    fn record(&self, dir: &PidDir, session_id: &str, run_id: &str) -> PidRecord {
        let rec = PidRecord {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            pid: self.leader.pid,
            pgid: self.pgid,
            start_tvsec: self.leader.start_tvsec,
            start_tvusec: self.leader.start_tvusec,
            pid_domain: PID_DOMAIN.to_string(),
            owner_pid: DEAD_OWNER_PID,
            owner_start_tvsec: 1,
            owner_start_tvusec: 1,
            binary: "/bin/sh".into(),
            cwd: "/tmp".into(),
            written_at_unix: now_unix(),
        };
        dir.write(&rec).expect("write pid record");
        rec
    }
}

impl Drop for Group {
    /// Kills the group, reaps the leader, and proves the group is gone. This is where a leak is
    /// caught: the check is scoped to the pgid this guard created, so it cannot be confused by a
    /// concurrent test or by a foreign `sleep`.
    fn drop(&mut self) {
        let _ = kill_group_sync(self.pgid, Duration::from_millis(300));
        let _ = self.child.wait();
        // A grandchild reparented to launchd can linger as a zombie for a moment after the kill.
        let drained = eventually(Duration::from_secs(2), || group_members(self.pgid).is_empty());
        if std::thread::panicking() {
            // Panicking inside a `Drop` that is already unwinding aborts the process and hides
            // the real failure, so report instead.
            if !drained {
                eprintln!("LEAKED group {} members {:?}", self.pgid, group_members(self.pgid));
            }
        } else {
            assert!(
                drained,
                "group {} outlived its guard: {:?}",
                self.pgid,
                group_members(self.pgid)
            );
        }
    }
}

fn pid_dir() -> (tempfile::TempDir, PidDir) {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = PidDir::open(tmp.path().join("pids")).expect("open pid dir");
    (tmp, dir)
}

/// Waits for `f` to hold, up to `limit`. Returns whether it did.
fn eventually(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Every pid `pgrep -f "sleep 30"` reports, split into ours — the parent chain reaches this test
/// process — and everyone else's.
fn sleep_30_pids() -> (Vec<u32>, Vec<u32>) {
    let out = Command::new("/usr/bin/pgrep").args(["-f", "sleep 30"]).output().expect("pgrep");
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut ours = Vec::new();
    let mut foreign = Vec::new();
    for pid in stdout.split_whitespace().filter_map(|p| p.parse::<u32>().ok()) {
        if descends_from_us(pid) {
            ours.push(pid);
        } else {
            foreign.push(pid);
        }
    }
    (ours, foreign)
}

/// Walks `pid`'s parent chain via `bsd_info().ppid` looking for this test process.
///
/// A process reparented to launchd (`ppid 1`) has lost that link, so this under-counts rather
/// than over-counts; the per-test [`Group`] guard is what catches an orphan.
fn descends_from_us(pid: u32) -> bool {
    let me = std::process::id();
    let mut current = pid;
    for _ in 0..64 {
        let Some(info) = bsd_info(current) else { return false };
        if info.ppid == me {
            return true;
        }
        if info.ppid <= 1 {
            return false;
        }
        current = info.ppid;
    }
    false
}

#[test]
fn a_kill_takes_down_the_whole_group() {
    let mut g = Group::spawn("sleep 30 & sleep 30 & wait");
    assert!(
        eventually(Duration::from_secs(5), || group_members(g.pgid).len() >= 3),
        "group {} never reached sh + two sleeps: {:?}",
        g.pgid,
        group_members(g.pgid)
    );

    let started = Instant::now();
    let outcome = kill_group_sync(g.pgid, GRACE);
    let elapsed = started.elapsed();
    eprintln!("MEASURED clean group: {outcome:?} in {:.1} ms", elapsed.as_secs_f64() * 1000.0);

    assert!(!outcome.refused);
    assert!(!outcome.escalated, "a plain sh + sleeps should die on SIGTERM: {outcome:?}");
    assert!(!outcome.still_alive, "{outcome:?}");
    assert!(outcome.members >= 3, "expected sh + two sleeps, saw {}", outcome.members);

    let status = g.child.wait().expect("leader must be reapable");
    assert!(!status.success(), "leader exited cleanly instead of being signalled: {status:?}");
    assert!(group_members(g.pgid).is_empty(), "group {} still has members", g.pgid);
    assert!(!group_alive(g.pgid));
}

#[test]
fn a_sigterm_ignoring_group_is_escalated() {
    let g = Group::spawn("trap '' TERM; sleep 30");
    assert!(eventually(Duration::from_secs(2), || group_members(g.pgid).len() > 1));

    let started = Instant::now();
    let outcome = kill_group_sync(g.pgid, GRACE);
    let elapsed = started.elapsed();
    eprintln!(
        "MEASURED SIGTERM-ignoring group: {outcome:?} in {:.1} ms",
        elapsed.as_secs_f64() * 1000.0
    );

    assert!(outcome.escalated, "the group ignored SIGTERM but was never SIGKILLed: {outcome:?}");
    assert!(!outcome.still_alive, "{outcome:?}");
    assert!(elapsed >= GRACE, "escalated before the grace expired: {elapsed:?}");
    assert!(elapsed < GRACE + Duration::from_millis(400), "escalation took {elapsed:?}");
}

#[test]
fn reserved_process_groups_are_refused() {
    for pgid in [0, 1] {
        let outcome = kill_group_sync(pgid, Duration::from_millis(10));
        assert!(outcome.refused, "pgid {pgid} was not refused: {outcome:?}");
        assert_eq!(outcome.members, 0);
    }
}

/// The sweep pays **one** grace period in total, not one per orphan: two groups that both ignore
/// `SIGTERM` must be swept in about `grace + SIGKILL slack`, not twice that.
#[test]
fn a_sweep_of_two_stubborn_orphans_pays_one_grace_in_total() {
    let (_tmp, dir) = pid_dir();
    let a = Group::spawn("trap '' TERM; sleep 30");
    let b = Group::spawn("trap '' TERM; sleep 30");
    for g in [&a, &b] {
        assert!(
            eventually(Duration::from_secs(2), || group_members(g.pgid).len() > 1),
            "group {} never reached sh + sleep",
            g.pgid
        );
    }
    a.record(&dir, "stubborn-a", "run-old");
    b.record(&dir, "stubborn-b", "run-old");

    let started = Instant::now();
    let outcomes = sweep(&dir, "run-new", GRACE);
    let elapsed = started.elapsed();
    eprintln!(
        "MEASURED sweep of two SIGTERM-ignoring orphans: {:.1} ms ({outcomes:?})",
        elapsed.as_secs_f64() * 1000.0
    );

    assert_eq!(outcomes.len(), 2, "{outcomes:?}");
    for outcome in &outcomes {
        assert!(
            matches!(outcome.action, SweepAction::Killed { escalated: true, .. }),
            "{} -> {:?}",
            outcome.session_id,
            outcome.action
        );
    }
    assert!(!group_alive(a.pgid), "group {} survived the sweep", a.pgid);
    assert!(!group_alive(b.pgid), "group {} survived the sweep", b.pgid);
    assert!(dir.read_all().is_empty(), "swept records were not deleted");

    let budget = (GRACE + SIGKILL_GRACE).mul_f32(1.5);
    assert!(elapsed < budget, "sweep took {elapsed:?}, budget {budget:?}");
    // The regression this guards: one grace *per record* would be ~2 × GRACE here.
    assert!(
        elapsed < GRACE * 2,
        "sweep took {elapsed:?}; that is a per-record grace, not one shared grace"
    );
}

#[test]
fn a_group_outlives_its_leader_and_is_still_swept() {
    let (_tmp, dir) = pid_dir();
    // The leader forks a survivor, lives briefly, then exits. The survivor keeps the pgid.
    let mut g = Group::spawn("sleep 30 & sleep 0.2; exit 0");
    let rec = g.record(&dir, "orphan-1", "run-old");

    let status = g.child.wait().expect("wait for the leader");
    assert!(status.success(), "leader should have exited 0, got {status:?}");
    assert!(
        eventually(Duration::from_secs(2), || bsd_info(rec.pid).is_none()),
        "leader {} never disappeared",
        rec.pid
    );

    let members = group_members(g.pgid);
    assert!(!members.is_empty(), "group {} died with its leader", g.pgid);
    assert!(group_alive(g.pgid), "group {} reported dead while {members:?} remain", g.pgid);

    let outcomes = sweep(&dir, "run-new", GRACE);
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0].session_id, "orphan-1");
    match &outcomes[0].action {
        SweepAction::Killed { members, .. } => assert!(*members >= 1),
        other => panic!("expected Killed, got {other:?}"),
    }
    assert!(!group_alive(g.pgid), "survivor outlived the sweep");
    assert!(dir.read_all().is_empty(), "the swept record was not deleted");
}

#[test]
fn a_start_time_mismatch_deletes_the_file_and_kills_nothing() {
    let (_tmp, dir) = pid_dir();
    let g = Group::spawn("sleep 30");
    let rec = PidRecord {
        session_id: "recycled".into(),
        run_id: "run-old".into(),
        pid: g.leader.pid,
        pgid: g.pgid,
        // Forge the start time: this is what a recycled pid looks like.
        start_tvsec: g.leader.start_tvsec.saturating_sub(9_999),
        start_tvusec: g.leader.start_tvusec,
        pid_domain: PID_DOMAIN.to_string(),
        owner_pid: DEAD_OWNER_PID,
        owner_start_tvsec: 1,
        owner_start_tvusec: 1,
        binary: "/bin/sh".into(),
        cwd: "/tmp".into(),
        written_at_unix: now_unix(),
    };
    dir.write(&rec).expect("write");

    let outcomes = sweep(&dir, "run-new", GRACE);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, SweepAction::StartTimeMismatch, "{outcomes:?}");
    assert!(group_alive(g.pgid), "a mismatched record must never be killed");
    assert!(dir.read_all().is_empty(), "a mismatched record must still be deleted");
}

#[test]
fn a_live_owner_from_another_run_is_left_alone() {
    let (_tmp, dir) = pid_dir();
    let owner = self_info().expect("self_info");
    // pgid 999999 is above macOS's pid ceiling (~99999), so it can never name a live group.
    let rec = PidRecord {
        session_id: "other-instance".into(),
        run_id: "run-other".into(),
        pid: 999_999,
        pgid: 999_999,
        start_tvsec: 1,
        start_tvusec: 1,
        pid_domain: PID_DOMAIN.to_string(),
        owner_pid: owner.pid,
        owner_start_tvsec: owner.start_tvsec,
        owner_start_tvusec: owner.start_tvusec,
        binary: "/bin/sh".into(),
        cwd: "/tmp".into(),
        written_at_unix: now_unix(),
    };
    dir.write(&rec).expect("write");

    let outcomes = sweep(&dir, "run-new", GRACE);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, SweepAction::OwnerAlive, "{outcomes:?}");
    assert_eq!(dir.read_all().len(), 1, "another instance's record must survive the sweep");

    // The same record under *our* run id is our own previous run, and is swept.
    let outcomes = sweep(&dir, "run-other", GRACE);
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].action, SweepAction::AlreadyGone, "{outcomes:?}");
    assert!(dir.read_all().is_empty(), "our own previous run's record must be deleted");
}

#[test]
fn a_dead_owner_with_a_dead_group_is_just_cleaned_up() {
    let (_tmp, dir) = pid_dir();
    let rec = PidRecord {
        session_id: "long-gone".into(),
        run_id: "run-old".into(),
        pid: 999_998,
        pgid: 999_998,
        start_tvsec: 1,
        start_tvusec: 1,
        pid_domain: PID_DOMAIN.to_string(),
        owner_pid: 999_997,
        owner_start_tvsec: 1,
        owner_start_tvusec: 1,
        binary: "/bin/sh".into(),
        cwd: "/tmp".into(),
        written_at_unix: now_unix(),
    };
    dir.write(&rec).expect("write");
    let outcomes = sweep(&dir, "run-new", GRACE);
    assert_eq!(outcomes[0].action, SweepAction::AlreadyGone, "{outcomes:?}");
    assert!(dir.read_all().is_empty());
}

#[test]
fn unusable_records_are_deleted_without_signalling() {
    let (_tmp, dir) = pid_dir();
    std::fs::write(dir.path().join("corrupt.json"), b"{not json").expect("write junk");

    let owner = self_info().expect("self_info");
    let mut foreign = PidRecord {
        session_id: "foreign".into(),
        run_id: "run-old".into(),
        pid: 999_996,
        pgid: 999_996,
        start_tvsec: 1,
        start_tvusec: 1,
        pid_domain: "linux".into(),
        owner_pid: 999_995,
        owner_start_tvsec: 1,
        owner_start_tvusec: 1,
        binary: "/bin/sh".into(),
        cwd: "/tmp".into(),
        written_at_unix: now_unix(),
    };
    dir.write(&foreign).expect("write foreign");
    foreign.session_id = "reserved-pgid".into();
    foreign.pid_domain = PID_DOMAIN.to_string();
    foreign.pgid = 1;
    foreign.owner_pid = owner.pid;
    foreign.owner_start_tvsec = owner.start_tvsec;
    foreign.owner_start_tvusec = owner.start_tvusec;
    dir.write(&foreign).expect("write reserved");

    let outcomes = sweep(&dir, "run-old", GRACE);
    assert_eq!(outcomes.len(), 3, "{outcomes:?}");
    for outcome in &outcomes {
        assert!(
            matches!(outcome.action, SweepAction::Unreadable(_)),
            "{} -> {:?}",
            outcome.session_id,
            outcome.action
        );
    }
    assert!(dir.read_all().is_empty(), "unusable records must be deleted");
}

#[test]
fn tracker_writes_kills_and_forgets() {
    let (_tmp, dir) = pid_dir();
    let tracker = PidTracker::new(dir.clone(), "run-live");
    let mut g = Group::spawn("sleep 30 & wait");

    tracker
        .track("sess-a", g.leader.pid, Path::new("/bin/sh"), Path::new("/tmp"))
        .expect("track");
    assert_eq!(tracker.live_count(), 1);
    assert_eq!(tracker.pgid_of("sess-a"), Some(g.pgid));
    assert_eq!(dir.read_all().len(), 1);

    let outcomes = tracker.shutdown_sync(GRACE);
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert!(matches!(outcomes[0].action, SweepAction::Killed { .. }), "{outcomes:?}");
    assert_eq!(tracker.live_count(), 0);
    assert!(dir.read_all().is_empty(), "shutdown must delete the record");
    assert!(!group_alive(g.pgid));
    let _ = g.child.wait();
}

/// The exit kill applies the same identity check the sweep does: a tracked pgid whose start time
/// no longer matches belongs to somebody else now and must never be signalled.
#[test]
fn shutdown_refuses_a_group_whose_identity_no_longer_matches() {
    let (_tmp, dir) = pid_dir();
    let tracker = PidTracker::new(dir.clone(), "run-live");
    let g = Group::spawn("sleep 30");

    tracker
        .track("sess-recycled", g.leader.pid, Path::new("/bin/sh"), Path::new("/tmp"))
        .expect("track");
    // Forge the stored start time: this is what a pgid recycled under a live app looks like.
    assert!(
        tracker.set_identity_for_tests(
            "sess-recycled",
            g.leader.pid,
            g.pgid,
            g.leader.start_tvsec.saturating_sub(9_999),
            g.leader.start_tvusec,
        ),
        "the session should have been tracked"
    );

    let outcomes = tracker.shutdown_sync(GRACE);
    assert_eq!(outcomes.len(), 1, "{outcomes:?}");
    assert_eq!(outcomes[0].action, SweepAction::StartTimeMismatch, "{outcomes:?}");
    assert!(group_alive(g.pgid), "a mismatched record must never be signalled at exit");
    assert!(dir.read_all().is_empty(), "the record must still be deleted");
    assert_eq!(tracker.live_count(), 0);
    // `g`'s guard kills the group it created.
}

/// A child that inherited the app's own process group can never be recorded: `shutdown_sync`
/// would `killpg` the app itself.
#[test]
fn tracking_a_child_in_our_own_group_is_refused() {
    let (_tmp, dir) = pid_dir();
    let tracker = PidTracker::new(dir.clone(), "run-live");
    let mut child = Command::new("/bin/sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn /bin/sleep");
    let pid = child.id();
    let info = bsd_info(pid).expect("the child we just spawned has no process info");
    let me = self_info().expect("self_info");
    let result = tracker.track("sess-same-group", pid, Path::new("/bin/sleep"), Path::new("/tmp"));
    // Kill before asserting: a failed assertion must not leak the child.
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(info.pgid, me.pgid, "a child spawned without process_group(0) should share ours");
    let err = result.expect_err("a child in our own process group must be refused");
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{err}");
    assert_eq!(tracker.live_count(), 0);
    assert!(dir.read_all().is_empty(), "a refused child must leave no record");
}

#[test]
fn untrack_removes_the_record_without_killing() {
    let (_tmp, dir) = pid_dir();
    let tracker = PidTracker::new(dir.clone(), "run-live");
    let g = Group::spawn("sleep 30");

    tracker
        .track("sess-b", g.leader.pid, Path::new("/bin/sh"), Path::new("/tmp"))
        .expect("track");
    tracker.untrack("sess-b");
    assert_eq!(tracker.live_count(), 0);
    assert!(dir.read_all().is_empty());
    assert!(group_alive(g.pgid), "untrack must not kill anything");
    tracker.untrack("sess-b"); // idempotent
    assert!(tracker.shutdown_sync(GRACE).is_empty());
}

#[test]
fn tracking_a_dead_pid_is_an_error_not_a_bogus_record() {
    let (_tmp, dir) = pid_dir();
    let tracker = PidTracker::new(dir.clone(), "run-live");
    let err = tracker
        .track("sess-c", u32::MAX - 1, Path::new("/bin/sh"), Path::new("/tmp"))
        .expect_err("a dead pid must not produce a record");
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    assert!(dir.read_all().is_empty());
}

/// Named to start last; a scoped backstop, not the suite's real leak check — that lives in each
/// [`Group`] guard's `Drop`, which is per-pgid and immune to test order.
///
/// This one fails only on a `sleep 30` whose parent chain reaches *this* process, and waits for
/// the concurrently running tests to drain rather than for a fixed delay. Anything else — a
/// foreign `sleep 30`, or one of ours already reparented to launchd — is reported, never failed,
/// which is what the old version's comment promised and its assertion did not do.
#[test]
fn zz_no_descendant_sleep_leaked() {
    let mut ours = Vec::new();
    let drained = eventually(Duration::from_secs(15), || {
        ours = sleep_30_pids().0;
        ours.is_empty()
    });
    let (still_ours, foreign) = sleep_30_pids();
    eprintln!("PGREP 'sleep 30': ours={still_ours:?} foreign={foreign:?}");
    for pid in &foreign {
        if let Some(info) = bsd_info(*pid) {
            eprintln!(
                "FOREIGN (reported, not failed) pid={pid} ppid={} pgid={}",
                info.ppid, info.pgid
            );
        }
    }
    assert!(drained, "this suite's own `sleep 30` descendants survived it: {ours:?}");
}
