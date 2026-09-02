//! brigadier-proc: process-group liveness, pid files, and the orphan sweep.
//!
//! A force-quit orphans every `claude` the app had running: the child reparents to launchd, keeps
//! its process group, and goes on burning tokens. `kill_on_drop` does not help — it only fires if
//! the `Child` is dropped by a live process, and it kills the direct child rather than the group
//! (`docs/research/orphan-sweep.md` measurements 11 and §6). The startup sweep is the only
//! recovery, and it needs a durable record written at spawn time.
//!
//! Three pieces, in the order they run:
//!
//! 1. [`tracker::PidTracker::track`] writes one [`pidfile::PidRecord`] per session at spawn.
//! 2. [`sweep::sweep`] runs at startup, before the window shows, and kills what the last run left.
//! 3. [`tracker::PidTracker::shutdown_sync`] runs in the Tauri exit hook, on the main thread, with
//!    no tokio.
//!
//! This is the only crate in the workspace that is not `#![deny(unsafe_code)]` end to end: [`proc`]
//! carries three `libc` calls because no safe crate exposes
//! `proc_listpids(PROC_PGRP_ONLY)`, and group enumeration is the whole design
//! (`docs/research/orphan-sweep.md` §2). Everything outside that module is safe.
//!
//! Everything here is macOS-only in substance. Off macOS the [`proc`] queries return `None` and
//! empty, which makes the sweep a no-op rather than a wrong kill; the Windows job-object
//! equivalent is unresearched.

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod pidfile;
#[allow(unsafe_code)]
pub mod proc;
pub mod sweep;
pub mod tracker;

pub use pidfile::{PidDir, PidRecord, PID_DOMAIN};
pub use proc::{bsd_info, group_alive, group_members, self_info, BsdInfo};
pub use sweep::{kill_group_sync, kill_groups_sync, sweep, KillOutcome, SweepAction, SweepOutcome, DEFAULT_GRACE};
pub use tracker::PidTracker;
