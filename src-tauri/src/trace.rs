//! Launch signposts: one stderr line per startup stage, behind `BRIGADIER_TRACE=1`.
//!
//! Why this exists. `docs/research/perceived-performance.md` §1.4 measures exec → first
//! contentful paint at **287–295 ms p50** against a 200 ms budget, and attributes ~100 ms of it
//! **by elimination** to the `tauri://localhost` scheme handler plus the brotli inflate — that
//! file's own "Not checked" list says neither was ever timed. `panel-review-2026-09-03.md` §4(c)
//! names a competing candidate that is also unmeasured: `state::build` runs inside `setup`, on
//! the main thread, through `tauri::async_runtime::block_on` (`src-tauri/src/lib.rs:137`). Two
//! hypotheses, no per-stage number between them. This module is the number.
//!
//! What it is not: a profiler. It prints monotonic elapsed milliseconds since the first statement
//! of `main()` at a fixed set of named points, to stderr, one line each. Nothing is aggregated,
//! nothing is written to a file, and with the variable unset every call is a load of a cached
//! `bool` and a return.
//!
//! Three constraints the shape follows from:
//!
//! - **`T0` is `main()` entry, not `posix_spawn`.** The dyld/pre-main segment is invisible from
//!   inside the process and `DYLD_PRINT_STATISTICS` no longer exists in dyld on macOS 26.5
//!   (**measured**, `perceived-performance.md` §5.1). §1.4 puts that segment at ~4.9 ms p50 over
//!   19 runs, measured from outside; nothing here can see it.
//! - **stderr, not `tracing`.** `tracing`'s output is filtered by `RUST_LOG` and formatted with a
//!   wall-clock timestamp whose resolution is the thing being measured. These lines carry their
//!   own monotonic offset and appear whatever `RUST_LOG` says, so a run can be parsed with one
//!   `grep`.
//! - **The page's own stages arrive as epoch milliseconds.** `performance.timeOrigin` is directly
//!   comparable to `SystemTime::now().duration_since(UNIX_EPOCH)` (**measured**, §5.3), so a
//!   frontend stage is converted with [`stage_at_epoch_ms`] against the same `main()` stamp
//!   `report_paint` already subtracts from. That crosses from the monotonic clock to the wall
//!   clock; over a ~300 ms launch the difference is not measurable, but it is a different clock
//!   and is named as such rather than hidden.

use std::sync::OnceLock;
use std::time::Instant;

/// Monotonic zero, stamped by [`arm`] from the first statement of `main()`.
static T0: OnceLock<Instant> = OnceLock::new();

/// `BRIGADIER_TRACE`, read once. The variable is read at the first stage call and never again, so
/// a mid-run `setenv` cannot turn tracing on or off halfway and produce a file with a hole in it.
static ENABLED: OnceLock<bool> = OnceLock::new();

/// The environment variable that turns every line in this module on.
pub(crate) const TRACE_ENV: &str = "BRIGADIER_TRACE";

/// The prefix every line carries, so one `grep brigadier-trace` recovers a whole run.
const PREFIX: &str = "brigadier-trace";

/// Stamp the monotonic zero. Called from [`crate::mark_process_start`], which `main()` calls as
/// its first statement. First write wins, exactly like the epoch stamp beside it.
pub(crate) fn arm() {
    let _ = T0.set(Instant::now());
}

/// Whether `BRIGADIER_TRACE` is set to something affirmative.
///
/// Accepts `1`, `true`, `yes` and `on`; anything else — including the empty string, which is what
/// `BRIGADIER_TRACE=` gives — is off. An unset variable is off, which is the shipped default.
pub(crate) fn enabled() -> bool {
    *ENABLED.get_or_init(|| match std::env::var(TRACE_ENV) {
        Ok(v) => matches!(v.trim(), "1" | "true" | "yes" | "on"),
        Err(_) => false,
    })
}

/// Milliseconds since `main()` entry, on the monotonic clock.
///
/// `0.0` if [`arm`] never ran, which cannot happen through `main()` or through [`crate::run`];
/// a zero here would mean the stamp was skipped, and every line in the run would be visibly
/// wrong rather than subtly late.
fn elapsed_ms() -> f64 {
    T0.get().map(|t0| t0.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// One stage, timed now.
pub(crate) fn stage(name: &str) {
    if enabled() {
        write_line(name, elapsed_ms(), "");
    }
}

/// One stage, timed now, with a trailing `key=value` detail the reader needs to interpret it.
pub(crate) fn stage_with(name: &str, detail: &str) {
    if enabled() {
        write_line(name, elapsed_ms(), detail);
    }
}

/// One stage whose time came from the page, as epoch milliseconds.
///
/// `process_start_epoch_ms` is the wall-clock twin of [`T0`], so the subtraction lands on the same
/// zero every other line in this module is measured from.
pub(crate) fn stage_at_epoch_ms(name: &str, epoch_ms: f64) {
    if enabled() {
        write_line(name, epoch_ms - crate::process_start_epoch_ms(), "");
    }
}

/// The one place the line format lives.
///
/// `ms=` first and fixed-width-ish so `sort -t= -k2 -n` works, `stage=` second so a run can be
/// pivoted by stage name. Every write is a `let _ =`: an instrument that can fail a launch on a
/// closed stderr is worse than no instrument, which is the same rule `src/paint.ts` states for
/// its own reporting path.
fn write_line(name: &str, ms: f64, detail: &str) {
    use std::io::Write;

    let mut err = std::io::stderr().lock();
    if detail.is_empty() {
        let _ = writeln!(err, "{PREFIX} ms={ms:.3} stage={name}");
    } else {
        let _ = writeln!(err, "{PREFIX} ms={ms:.3} stage={name} {detail}");
    }
}

/* --------------------------------------------------------------- file descriptors */

/// Raise the soft `RLIMIT_NOFILE` toward the hard limit, capped at [`NOFILE_TARGET`].
///
/// **Why.** `panel-review-2026-09-03.md` §4(d): `grep -rnE "setrlimit|rlimit|NOFILE"` over
/// `src-tauri/src` and `crates/*/src` returned nothing, so the limit this process runs under is
/// whatever it inherited. A shell inherits the login shell's, which on this machine is 1,048,576
/// (`ulimit -n`, **measured**); a bundle launched from Finder or `open` inherits launchd's, which
/// is far lower. Every session is a `claude` child with pipes, and the harness is built to run ten
/// of them, so the descriptor budget is not academic.
///
/// **The macOS landmine.** The hard limit here is `unlimited` (`ulimit -Hn`, **measured**), but
/// the kernel still refuses any soft limit above `kern.maxfilesperproc` — 92,160 on this machine
/// (`sysctl`, **measured**) — with `EINVAL`. So the target is capped and, if the capped value is
/// still refused, the candidates below it are tried in turn rather than the whole raise being
/// abandoned. A refusal is a `warn` and never fatal: an app that will not start because it could
/// not raise a limit it was already running under is strictly worse than one that runs with the
/// limit it inherited.
///
/// Uses `nix::sys::resource`, not `libc` directly: `nix` 0.31.3 is already in the tree
/// (`crates/proc/Cargo.toml:27`, `crates/core/Cargo.toml:22`) and this crate is `#![deny(unsafe_code)]`,
/// which rules out calling `libc::setrlimit` here at all. Only the `resource` feature is new.
#[cfg(unix)]
pub(crate) fn raise_file_limit() {
    use nix::sys::resource::{getrlimit, setrlimit, Resource};

    let (soft, hard) = match getrlimit(Resource::RLIMIT_NOFILE) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!(error = %e, "could not read RLIMIT_NOFILE");
            stage_with("rlimit_nofile", "outcome=getrlimit_failed");
            return;
        }
    };
    if soft >= NOFILE_TARGET {
        stage_with("rlimit_nofile", &format!("old={soft} new={soft} hard={hard} outcome=already_high"));
        return;
    }
    // Descending, so a kernel that refuses the cap still gets a raise instead of nothing. Each
    // candidate is clamped to the hard limit and skipped if it would not be an increase.
    for candidate in NOFILE_CANDIDATES {
        let want = (*candidate).min(hard);
        if want <= soft {
            continue;
        }
        if setrlimit(Resource::RLIMIT_NOFILE, want, hard).is_ok() {
            tracing::debug!(old = soft, new = want, hard, "raised RLIMIT_NOFILE");
            stage_with("rlimit_nofile", &format!("old={soft} new={want} hard={hard} outcome=raised"));
            return;
        }
    }
    tracing::warn!(soft, hard, "could not raise RLIMIT_NOFILE; running with the inherited limit");
    stage_with("rlimit_nofile", &format!("old={soft} new={soft} hard={hard} outcome=refused"));
}

/// Nothing to raise on Windows: there is no `RLIMIT_NOFILE`, and the C runtime's `_setmaxstdio`
/// governs only the `FILE*` layer, not sockets or handles. A no-op, named rather than absent.
#[cfg(not(unix))]
pub(crate) fn raise_file_limit() {
    stage_with("rlimit_nofile", "outcome=not_unix");
}

/// The soft limit worth having. 65,536 is under this machine's `kern.maxfilesperproc` of 92,160
/// (**measured**) and far above anything ten `claude` sessions with three pipes each will use;
/// it is a cap on an inherited-limit fix, not a budget anyone should plan against.
#[cfg(unix)]
const NOFILE_TARGET: nix::sys::resource::rlim_t = 65_536;

/// Tried in order, first success wins. The tail exists for kernels or sandboxes whose
/// `maxfilesperproc` sits below the cap; without it an `EINVAL` at 65,536 would leave the process
/// on whatever launchd handed it.
#[cfg(unix)]
const NOFILE_CANDIDATES: &[nix::sys::resource::rlim_t] = &[NOFILE_TARGET, 24_576, 10_240, 4_096];
