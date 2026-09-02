//! The three kernel queries the sweep needs, and the only `unsafe` in the workspace.
//!
//! Every function here is one syscall with a size-checked return. `bsd_info` costs 164 ns and
//! `group_members` ~95 µs on this machine (`docs/research/orphan-sweep.md` measurements 12 and 13).
//!
//! Two findings from that brief are load-bearing and must not be undone:
//!
//! - A process group outlives its leader, so liveness is decided by enumerating the group, never
//!   by asking whether the leader pid is alive (measurement 10).
//! - `pbi_comm` of a live `claude` is the version-numbered basename (`"2.1.258"`), not `"claude"`,
//!   so a comm check is a trap and is deliberately not offered here (measurement 17).

// The `#[allow(unsafe_code)]` that lets this module exist is on the `mod proc;` line in `lib.rs`,
// next to the crate's `#![deny(unsafe_code)]`, so the exception is visible where the rule is.
// Repeating it here as an inner attribute is a `clippy::duplicated_attributes` error.

/// `p_stat` value for a process that has exited and not yet been reaped —
/// `MacOSX.sdk/usr/include/sys/proc.h:152`.
pub const SZOMB: u32 = 5;

/// One `proc_pidinfo(PROC_PIDTBSDINFO)` answer: liveness, identity and group membership.
///
/// `(start_tvsec, start_tvusec)` is the kernel's process start time to the microsecond. It is the
/// pid-reuse guard: three siblings spawned in the same millisecond differed in the microsecond
/// field, so the pair is an effectively collision-free identity for a pid
/// (`docs/research/orphan-sweep.md` measurement 18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BsdInfo {
    /// The process id this record describes.
    pub pid: u32,
    /// Parent pid. `1` once the process has been reparented to launchd.
    pub ppid: u32,
    /// Process-group id. Equal to `pid` for a child spawned with `process_group(0)`.
    pub pgid: u32,
    /// `p_stat`: `SIDL 1, SRUN 2, SSLEEP 3, SSTOP 4, SZOMB 5`.
    pub status: u32,
    /// Kernel process start time, whole seconds since the epoch.
    pub start_tvsec: u64,
    /// Kernel process start time, the microsecond remainder.
    pub start_tvusec: u64,
}

impl BsdInfo {
    /// Whether this record is the same process as the one whose start time was recorded earlier.
    #[must_use]
    pub fn started_at(&self, tvsec: u64, tvusec: u64) -> bool {
        self.start_tvsec == tvsec && self.start_tvusec == tvusec
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use super::BsdInfo;
    use std::os::raw::{c_int, c_void};

    /// `PROC_PGRP_ONLY` — `MacOSX.sdk/usr/include/sys/proc_info.h:52`. Not exposed by `libc`.
    const PROC_PGRP_ONLY: u32 = 2;

    /// Upper bound on group size when probing for the buffer length fails. `kern.maxprocperuid`
    /// is 4000 on this machine, so a group can never exceed it.
    const MAX_MEMBERS: usize = 4096;

    pub fn bsd_info(pid: u32) -> Option<BsdInfo> {
        let pid = c_int::try_from(pid).ok()?;
        let size = c_int::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
        // SAFETY: `proc_bsdinfo` is a plain-old-data struct of integers and `c_char` arrays, so
        // an all-zero bit pattern is a valid value for it.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        // SAFETY: `buffer` points at one live, correctly aligned `proc_bsdinfo` owned by this
        // frame, and `buffersize` is exactly that object's size, so the kernel cannot write out
        // of bounds. The call has no other side effect and does not retain the pointer.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                std::ptr::addr_of_mut!(info).cast::<c_void>(),
                size,
            )
        };
        // A short or failed return means the pid is gone, is a zombie, or is not ours: measurement
        // 9 recorded `0` with `errno == ESRCH` for a zombie. Either way there is nothing to signal.
        if written != size {
            return None;
        }
        Some(BsdInfo {
            pid: info.pbi_pid,
            ppid: info.pbi_ppid,
            pgid: info.pbi_pgid,
            status: info.pbi_status,
            start_tvsec: info.pbi_start_tvsec,
            start_tvusec: info.pbi_start_tvusec,
        })
    }

    pub fn group_members(pgid: u32) -> Vec<u32> {
        if pgid == 0 {
            return Vec::new();
        }
        let mut capacity = probe_capacity(pgid);
        for _ in 0..4 {
            let mut buf = vec![0_i32; capacity];
            let Some(bytes) = list(pgid, &mut buf) else {
                return Vec::new();
            };
            let count = bytes / std::mem::size_of::<i32>();
            // A full buffer means the answer was probably truncated; grow and ask again.
            if count >= capacity && capacity < MAX_MEMBERS {
                capacity = (capacity * 2).min(MAX_MEMBERS);
                continue;
            }
            buf.truncate(count.min(capacity));
            return buf.into_iter().filter(|p| *p > 0).map(|p| p.unsigned_abs()).collect();
        }
        Vec::new()
    }

    /// `proc_listpids` with a null buffer returns the byte size the answer needs, or `<= 0` if it
    /// declines to say. Converts that to a slot count with headroom for the racing case where a
    /// process joins the group between the two calls.
    fn probe_capacity(pgid: u32) -> usize {
        // SAFETY: a null buffer with size 0 is the documented "how big?" form of this call; the
        // kernel writes nothing.
        let bytes =
            unsafe { libc::proc_listpids(PROC_PGRP_ONLY, pgid, std::ptr::null_mut(), 0) };
        let slots = usize::try_from(bytes).unwrap_or(0) / std::mem::size_of::<i32>();
        slots.saturating_add(16).clamp(32, MAX_MEMBERS)
    }

    /// Returns the number of bytes the kernel wrote into `buf`, or `None` on error.
    fn list(pgid: u32, buf: &mut [i32]) -> Option<usize> {
        let size = c_int::try_from(std::mem::size_of_val(buf)).ok()?;
        // SAFETY: `buf` is a live, correctly aligned `i32` slice owned by the caller and `size`
        // is exactly its length in bytes, so the kernel cannot write past its end. `i32` is the
        // `pid_t` this call fills the buffer with.
        let written =
            unsafe { libc::proc_listpids(PROC_PGRP_ONLY, pgid, buf.as_mut_ptr().cast::<c_void>(), size) };
        usize::try_from(written).ok()
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::BsdInfo;

    /// Unimplemented off macOS: `proc_pidinfo` is Apple-only and the Windows job-object equivalent
    /// is unresearched (`docs/research/orphan-sweep.md` "Not checked"). Returning `None` makes the
    /// sweep a no-op rather than a wrong kill.
    pub fn bsd_info(_pid: u32) -> Option<BsdInfo> {
        None
    }

    /// Unimplemented off macOS; see [`bsd_info`]. An empty group reads as "already gone", so
    /// nothing is ever signalled on these platforms.
    pub fn group_members(_pgid: u32) -> Vec<u32> {
        Vec::new()
    }
}

/// One `proc_pidinfo(PROC_PIDTBSDINFO)` on `pid`.
///
/// `None` means "nothing to signal": the pid is free, it is a zombie (measurement 9 — the call
/// returns 0 with `ESRCH` while `kill(pid, 0)` still says `Ok`), or the platform is not macOS.
#[must_use]
pub fn bsd_info(pid: u32) -> Option<BsdInfo> {
    sys::bsd_info(pid)
}

/// Every pid currently in process group `pgid`, via `proc_listpids(PROC_PGRP_ONLY)`.
///
/// This is the only call that answers "who is actually left in this group". The leader's own pid
/// may be absent — a group outlives its leader (measurement 10) — so an empty result, not a dead
/// leader, is what "the group is gone" means. Returns empty off macOS.
#[must_use]
pub fn group_members(pgid: u32) -> Vec<u32> {
    sys::group_members(pgid)
}

/// [`bsd_info`] for the calling process. Used to stamp the owning app's identity into every pid
/// record, so a second instance can tell "the owner is still running" from "the owner is dead".
#[must_use]
pub fn self_info() -> Option<BsdInfo> {
    bsd_info(std::process::id())
}

/// Whether the group still contains a process worth signalling.
///
/// Zombies are excluded: [`bsd_info`] returns `None` for them, and a zombie cannot be killed
/// twice. An empty or all-zombie group is dead.
#[must_use]
pub fn group_alive(pgid: u32) -> bool {
    if pgid <= 1 {
        return false;
    }
    group_members(pgid)
        .into_iter()
        .filter_map(bsd_info)
        .any(|i| i.status != SZOMB)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_pid_reports_a_recent_start_time() {
        let Some(info) = bsd_info(std::process::id()) else {
            panic!("bsd_info on our own pid returned None");
        };
        assert_eq!(info.pid, std::process::id());
        assert_ne!(info.pgid, 0, "our own pgid must be non-zero");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before the epoch")
            .as_secs();
        assert!(info.start_tvsec <= now, "start {} is in the future", info.start_tvsec);
        assert!(now - info.start_tvsec < 3600, "start {} is over an hour old", info.start_tvsec);
        assert_eq!(self_info(), Some(info));
    }

    #[test]
    fn an_impossible_pid_has_no_info() {
        assert_eq!(bsd_info(u32::MAX - 1), None);
    }

    #[test]
    fn our_own_group_contains_us() {
        let Some(info) = self_info() else { panic!("self_info returned None") };
        assert!(
            group_members(info.pgid).contains(&std::process::id()),
            "group {} did not contain our own pid",
            info.pgid
        );
        assert!(group_alive(info.pgid));
    }

    #[test]
    fn reserved_pgids_are_never_alive() {
        assert!(!group_alive(0));
        assert!(!group_alive(1));
    }
}
