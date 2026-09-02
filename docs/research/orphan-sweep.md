# Orphan sweep — killing the children the app did not outlive

Scope: the pid file, the startup sweep, and the exit hook that `tauri-runtime.md` §5 recommended
and nothing has implemented. Everything here is macOS/arm64 on darwin 25.5.0, 2026-09-02.
Assumes `tauri-runtime.md` §5 (no `PR_SET_PDEATHSIG`, `tauri-plugin-shell` never kills
Rust-spawned children) and §7 pitfall 4 (`block_on` panics inside a runtime thread).

Tags: **[source]** read in crate/SDK source · **[docs]** vendor documentation ·
**[measured]** run on this machine today · **[asserted]** reasoned, not verified.

## Versions verified

| Thing | Version | How |
|---|---|---|
| `rustc` / `cargo` | 1.98.0 (88d9e12ae 2026-08-18) / 1.98.0 | `rustc --version` **[measured]** |
| `tokio` | 1.53.1 | `Cargo.lock:3921` **[source]** |
| `nix` | 0.31.3, `default-features = false, features = ["signal"]` | `Cargo.lock:2247`, `crates/core/Cargo.toml` **[source]** |
| `libc` | 0.2.189 — already in the lock, transitively | `Cargo.lock:2061` **[source]** |
| `sysinfo` | 0.39.6 (2026-07-09) | crates.io API **[source]** |
| `libproc` | 0.14.11 (2025-10-01) | crates.io API **[source]** |
| `claude` on this machine | 2.1.258, `~/.local/share/claude/versions/2.1.258`, Mach-O arm64 | `which claude`, `file` **[measured]** |
| macOS SDK headers | `MacOSX.sdk/usr/include/sys/proc_info.h`, `sys/proc.h` | Xcode SDK **[source]** |

## 0. What the code already does, and the exact gap

`crates/core/src/claude/process.rs` already gets the hard part right:

- `cmd.process_group(0)` before `spawn()` (`process.rs:188`).
- `terminate()` does `killpg(SIGTERM)` → wait `KILL_GRACE` (2 s) → `killpg(SIGKILL)`
  (`process.rs:221-245`), and a test kills a real group (`process.rs:361`, `a_kill_takes_down_the_process_group`).
- `Spawned.pid` is populated and documented as "also its process-group id".

The gap, all four items **[measured]** by reading the tree:

1. **Nothing consumes `Spawned.pid`.** `grep -n "pid" crates/core/src/claude/adapter.rs` returns
   nothing. The pgid exists for exactly the length of `spawn()` and is then unreachable.
2. **No pid file anywhere.** No `pids/` directory, no writer, no reader.
3. **No exit hook.** `src-tauri/src/lib.rs` is 13 lines: `Builder::default().plugin(opener).run(...)`.
   There is no `RunEvent` match at all, so `RunEvent::Exit` fires and nothing kills anything.
4. **Every kill path is async and routed through a tokio task.** `KillHandle::kill()` only
   `try_send`s to the per-session supervisor task (`process.rs:153`); the actual `killpg` runs
   inside that task and then `.await`s `child.wait()`. On the Tauri main thread at exit, that task
   may never be polled again, and §7 pitfall 4 forbids `block_on` to force it.

So: process-group hygiene, done. Durable record and both sweep paths, absent.

## 1. `process_group(0)`, and the `killpg` signature

- **[source]** `tokio::process::Command` does **not** deref to `std::process::Command`. It holds a
  private `std: StdCommand` and re-exposes the option as an inherent method:
  `pub fn process_group(&mut self, pgroup: i32) -> &mut Command { self.std.process_group(pgroup); self }`,
  gated `#[cfg(unix)]`, at `tokio-1.53.1/src/process/mod.rs:788-792`. It imports
  `std::os::unix::process::CommandExt` at `:256`. **Consequence: you call `.process_group(0)`
  directly on the tokio `Command` and you must *not* import `CommandExt` yourself** — the existing
  code at `process.rs:188` is already correct. Escape hatches if ever needed:
  `as_std()` / `as_std_mut()` at `:323` / `:329`.
- **[docs]** `std::os::unix::process::CommandExt::process_group` is **stable since 1.64.0**
  (docs.rs `std/os/unix/process/trait.CommandExt.html`, `1.64.0 · Source fn process_group`).
  Rust here is 1.98.0, so no MSRV question.
- **[docs]** tokio's own doc comment: *"A process group ID of 0 will use the process ID as the PGID."*
  (`mod.rs:772`).
- **[measured]** Confirmed on a live child: `SPAWN pid=26558 pgid=Ok(26558)` — `getpgid(child)`
  equals the child's pid, and the parent's own pgid (26553) is untouched. Repeated for five
  spawns, always equal.
- **[source]** `nix 0.31.3`: `pub fn killpg<T: Into<Option<Signal>>>(pgrp: Pid, signal: T) -> Result<()>`
  at `nix-0.31.3/src/sys/signal.rs:1113`, and `pub fn kill<T: Into<Option<Signal>>>(pid: Pid, signal: T)`
  at `:1092`. Both take `Into<Option<Signal>>`, so **`None` is the zero-signal probe** — the doc
  says *"If `None`, `killpg` will only preform error checking and won't send any signal."*
- **[source]** Feature flags: `signal` alone gates both — `crates/core/Cargo.toml` already declares
  `nix = { version = "0.31.3", default-features = false, features = ["signal"] }`. `getpgid` would
  additionally need `process`; **do not add it** — §2 gets the pgid out of `proc_bsdinfo` for free.
- **[docs]** `killpg(pgrp, …)` with `pgrp <= 1` is platform-specific (nix doc comment, `signal.rs:1106`).
  Guard the pgid: `pgid > 1` or refuse. Nothing in the current code does this.

## 2. Telling our child from a recycled pid

### The primitive

**[source]** `libc 0.2.189` on Apple exposes everything needed, no extra crate:

- `pub fn proc_pidinfo(pid: c_int, flavor: c_int, arg: u64, buffer: *mut c_void, buffersize: c_int) -> c_int`
  — `libc-0.2.189/src/unix/bsd/apple/mod.rs:4992`
- `pub const PROC_PIDTBSDINFO: c_int = 3;` — `:3745`
- `pub struct proc_bsdinfo { … pbi_ppid, pbi_uid, pbi_comm: [c_char; 16], pbi_name: [c_char; 32],
  pbi_pgid, pbi_status, pbi_start_tvsec: u64, pbi_start_tvusec: u64 }` — `:606-629`

One call yields **liveness, start time to the microsecond, the pgid, the ppid, the uid and the
comm**. `pbi_status` is `p_stat`: `SIDL 1, SRUN 2, SSLEEP 3, SSTOP 4, SZOMB 5`
(`MacOSX.sdk/usr/include/sys/proc.h:148-152`) **[source]**.

- **[measured]** 164 ns/call, averaged over 1000 calls (`examples/bench_pidinfo.rs`).
- **[measured]** The `(pbi_start_tvsec, pbi_start_tvusec)` pair on three siblings spawned in the
  same millisecond: `1788330210.704445`, `.707890`, `.708325`. Microsecond resolution is real, so
  the pair is an effectively collision-free identity for a pid.
- **[source]** This is precisely what `sysinfo` does internally —
  `sysinfo-0.39.6/src/unix/apple/macos/process.rs:371-388` (`get_bsd_info`), `:421` (`start_time = info.pbi_start_tvsec`),
  and the reuse check at `:724-731`: `if info.pbi_start_tvsec != p.start_time { … // The owner of this PID changed }`.
  A safe wrapper is available but it is the same syscall.

### Group enumeration, which is the part nothing else gives you

- **[source]** `pub fn proc_listpids(t: u32, typeinfo: u32, buffer: *mut c_void, buffersize: c_int) -> c_int`
  — `libc-0.2.189/src/unix/bsd/apple/mod.rs:4987`. The selector `PROC_PGRP_ONLY = 2` is **not** in
  `libc`; it is `MacOSX.sdk/usr/include/sys/proc_info.h:52` and must be hardcoded (`PROC_ALL_PIDS 1,
  PROC_PGRP_ONLY 2, PROC_TTY_ONLY 3, PROC_UID_ONLY 4, PROC_RUID_ONLY 5, PROC_PPID_ONLY 6`).
- **[measured]** `proc_listpids(PROC_PGRP_ONLY, 51480, …)` → `[51482, 51481, 51480]` in **93 µs**;
  after `kill -9` of the leader 51480, the same call returns `[51482, 51481]` in 98 µs, each still
  reporting `pbi_pgid = 51480`. This is the only API tried here that answers "who is actually left
  in this group", and §5 needs it.

### The comm check is a trap for this binary

- **[measured]** `pbi_comm` / `pbi_name` for five live `claude` processes:
  `"2.1.252"`, `"2.1.258"`, `"2.1.251"`, `"2.1.257"`, `"2.1.258"` — the **version-numbered
  executable basename** under `~/.local/share/claude/versions/`, not `"claude"`. `ps -o command=`
  shows `claude` because argv[0] is set, but `p_comm` comes from the exec'd file.
- **[asserted]** So a comm second-signal must never assert `== "claude"`; it changes on every CLI
  auto-update. Either compare argv[0] (a second syscall, `KERN_PROCARGS2`) or drop the check. The
  `(sec, usec)` start pair is already exact; comm adds nothing. Recommend: skip it.

### The alternatives, and why not

| | new crates | cost/call | notes |
|---|---|---|---|
| `libc` direct | **0** (0.2.189 already in the lock) | **164 ns** **[measured]** | needs `unsafe`; gives pgid + µs start + group enumeration |
| `sysinfo` 0.39.6 (`default-features=false, features=["system"]`) | **+18** (34 → 52 packages) **[measured]** | 61–95 µs for `ProcessesToUpdate::Some(&[pid])`, 4.2–4.5 ms for `All` + `ProcessRefreshKind::nothing()`, 7.1–8.8 ms for `All` + `everything()` over 696 processes **[measured]** | safe; `Process::start_time() -> u64` is **seconds only** (`common/system.rs:1893`), losing the µs field; **no group enumeration**; drags the whole `windows`/`ntapi`/`objc2` family into `Cargo.lock` **[measured]** |
| `libproc` 0.14.11 | +several, incl. a **`bindgen ^0.72.1` build-dependency** **[source]** (crates.io deps API) | not measured | last release 2025-10-01, ~11 months stale; a `bindgen` build-dep means libclang at build time for a shipped desktop app. Disqualifying. |
| shell out to `ps -o lstart=` | 0 | **2.7–2.8 ms** **[measured]** | fork+exec per pid; locale/TZ-formatted string; but see the zombie note in §3 |

**Recommendation: `libc` direct, in one small `#[allow(unsafe_code)]` module.** `crates/core/src/lib.rs:7`
is `#![deny(unsafe_code)]` **[measured]**, which is why `nix` was chosen for `killpg` in the first
place (the `Cargo.toml` comment says so). There is no safe wrapper for `proc_listpids(PROC_PGRP_ONLY)`
in any of the three crates, so the choice is really "one `unsafe` module" versus "no group
enumeration". Isolate it: `crates/core/src/proc.rs`, `#![allow(unsafe_code)]` on the module, three
functions (`bsd_info(pid) -> Option<BsdInfo>`, `group_members(pgid) -> Vec<i32>`, and nothing else),
each a single syscall with a size-checked return.

Pin nothing new. `libc = "0.2"` is already resolved at 0.2.189.

## 3. Liveness: `kill(pid, 0)`, zombies, `killpg(pgid, 0)`

- **[measured]** `kill(1, 0)` → **`EPERM`** (launchd, root-owned): the process exists and is not
  ours. `kill(99998, 0)` → **`ESRCH`**. `kill(self, 0)` → `Ok`.
  So the correct predicate is `Ok(_) | Err(EPERM) => alive`, `Err(ESRCH) => gone`. This is exactly
  what `sysinfo` does (`macos/process.rs:359-368`: *"If errno is equal to ESCHR, it means the
  process is dead"*) **[source]**.
- **[measured]** `killpg(pgid, None)` is a valid group-liveness probe and it is the *only* correct
  one. Test: leader `sh` exited, one `sleep 300` left in the group →
  `kill(leader, 0)` = **ESRCH**, `proc_pidinfo(leader)` = **None**, but
  `killpg(pgid, 0)` = **Ok** and `killpg(pgid, SIGTERM)` killed the survivor.
  **A sweep that gates on leader liveness leaks orphans.** This is the single most important
  finding here and it is not in `tauri-runtime.md` §5.
- **[measured]** Zombies. A child that exited while its parent is alive and unreaping:
  `kill(pid, 0)` → **`Ok` (alive)**, but `proc_pidinfo(pid, PROC_PIDTBSDINFO)` returns **0 with
  errno 3 (ESRCH)** — and so does `PROC_PIDT_SHORTBSDINFO`. `ps -o stat=` shows `Z <defunct>` and
  `ps -o lstart=` **still prints a start time** (rc=0). After `wait()`, `kill(pid,0)` → `ESRCH`.
  So `kill(0)` and `proc_pidinfo` disagree on zombies, in opposite directions from `ps`. Treat
  "`kill(0)` says alive but `proc_pidinfo` returns nothing" as **already dead** — there is nothing
  to signal.
- **[measured]** Reparenting and reaping confirmed: a child spawned with `process_group(0)` whose
  parent exits immediately shows `PPID 1` in `ps` and keeps its pgid. When such a reparented child
  then exits, launchd reaps it — the pid vanishes (`ps` rc=1, `kill(0)` = ESRCH) with **no lingering
  zombie**. So the startup sweep never meets a zombie of its own making; only the in-process exit
  path can.
- **[measured]** pid space on this machine: `kern.maxproc = 6000`, `kern.maxprocperuid = 4000`,
  707 live processes, current pids in the 26k–59k range. macOS pids wrap around ~99999.
  **[asserted]** Reuse therefore needs tens of thousands of process creations — plausible over a
  day of dev work, so the start-time guard is not theatre, but it is not a hair-trigger either.

## 4. Pid file design

### What Claude Code itself does — read on this machine **[measured]**

`~/.claude/sessions/` holds **one `<pid>.json` per running session**, plus a sibling
`<pid>.<sha256>.key` at mode `0600` (the `.json` is `0644`). A live record, verbatim:

```json
{"pid":37440,"sessionId":"34a08605-…","cwd":"/Users/stephen/Development/iBeep",
 "startedAt":1788270421648,"procStart":"Tue Sep  1 13:47:00 2026","version":"2.1.252",
 "peerProtocol":1,"peerFeatures":["notify_idle",…],"kind":"interactive","entrypoint":"cli",
 "pidDomain":"darwin","messagingSocketPath":"/tmp/cc-socks/37440.sock","name":"ibeep-f6",
 "nameSource":"derived","status":"busy","updatedAt":1788329793519,"statusUpdatedAt":1788329793519}
```

Four things worth copying, and one to skip:

1. **`procStart` is a separate, OS-sourced start time, distinct from the wall-clock `startedAt`.**
   Cross-checked: `startedAt` 1788270421648 ms = `Tue Sep 1 16:47:01 2026` local (EEST) =
   `13:47:01 UTC`; `procStart` reads `"Tue Sep  1 13:47:00 2026"` — same instant, **rendered in
   UTC**, and one second earlier because it is the kernel's process start, not `Date.now()`.
   `ps -o lstart= -p 37440` prints `Tue Sep  1 16:47:00 2026` (local), so **`procStart` is not a
   `ps` shell-out**. The pattern — record the kernel's start time beside your own timestamp, and
   render it timezone-independently — is exactly the reuse guard §2 argues for. Copy it, but store
   `(sec, usec)` integers rather than a formatted string; a string forces a date parser or a
   locale/TZ dependency for nothing.
2. **`pidDomain: "darwin"`** namespaces the pid so a record written under a different kernel
   (container, VM, restored backup) can never be matched. One cheap field, copy it.
3. **One small file per *live* process, deleted on exit** — not an append log, not age-swept.
   `persistence.md` §1 already records the docs' framing: *"used to detect concurrent sessions and
   crashes"*. Copy the shape.
4. **`status` + `updatedAt` heartbeat.** Useful for a stale-but-alive diagnosis; optional for us.
5. Skip the `.key` / socket half — that is Claude Code's peer-messaging channel, not lifecycle.

### Ours

- **One file per session**, `<session_id>.json`, in `app_local_data_dir()/pids/`. `persistence.md`
  §5 already settled `app_local_data_dir()` for machine-local state and notes **[docs]** the
  `PathResolver` helpers are not documented to create the directory — `create_dir_all` first.
  One-file-per-session over one-file-for-all: a crashed write corrupts one session's record, not
  all of them; deletion on session end is an `unlink`, not a read-modify-write race between the
  session task and the exit hook.
- **Atomic write**: serialize → write `<session_id>.json.tmp` → `sync_all()` → `rename()`.
  **[measured]** used in the experiment; `rename(2)` within a directory is atomic on APFS.
  **[asserted]** No fsync of the directory: the worst case is a lost record for a session started
  in the last few hundred ms before a power cut, and that child died with the machine anyway.
- **Record**:
  `session_id, run_id, pid, pgid, start_tvsec, start_tvusec, pid_domain:"darwin", binary, cwd,
   owner_pid, owner_start_tvsec, owner_start_tvusec, written_at_unix`.
  `binary` and `cwd` are for the log line, not for matching (§2: comm is the version string, and a
  worktree cwd can be deleted under us).
- **Delete** on: `SessionExited` of any reason, a successful `Kill`, a successful `EndSession`, and
  at the end of a sweep that handled the record. Deleting is idempotent; ignore `ENOENT`.
- **Two app instances.** `run_id` alone cannot scope the sweep — it tells you a record is from
  another run, not whether that run is *still going*. Record the **owning app's pid and start
  time** and sweep only records whose owner is provably dead, by the same `(pid, sec, usec)` test
  used on the child. Instance B then sees instance A's files, finds A alive, and leaves them
  alone — with no lock file and no coordination. Keep `run_id` as well: `persistence.md` §6 already
  mints one per launch for pending-approval expiry, and it is the field you want in the log line.

## 5. The startup sweep

```
for each pids/*.json:
  rec = parse(file); on parse failure -> log, unlink, continue
  if rec.pid_domain != "darwin"                  -> log, unlink, continue      # foreign kernel
  if rec.pgid <= 1                               -> log, unlink, continue      # killpg guard, §1
  if owner_still_alive(rec)                      -> leave the file alone, continue   # §4, other instance
  if !killpg(rec.pgid, None).is_ok_or_eperm()    -> unlink, continue           # ESRCH: group gone
  members = proc_listpids(PROC_PGRP_ONLY, rec.pgid)
  leader  = bsd_info(rec.pid)
  matched = match leader {
      Some(i) => i.start == (rec.start_tvsec, rec.start_tvusec) && i.pbi_pgid == rec.pgid,
      None    => members.iter().all(|m| bsd_info(m).pbi_pgid == rec.pgid
                                     && (m.start_tvsec, m.start_tvusec) >= rec.start)   # leader already gone
  }
  if !matched -> log "pgid {} recycled, refusing to kill", unlink, continue
  killpg(rec.pgid, SIGTERM)
  poll killpg(rec.pgid, None) every 10 ms up to N ms
  if still alive: killpg(rec.pgid, SIGKILL); poll up to 500 ms
  log { session_id, run_id, pgid, members_before, signal_used, elapsed_ms, still_alive }
  unlink
```

Three points the naive version gets wrong:

- **Gate on `killpg(pgid, 0)`, not on the leader.** §3 measured a group that outlived its leader.
- **When the leader is gone, the start-time guard has no anchor** — that is the honest weak spot.
  The fallback above (every surviving member still reports our pgid, and none started before we
  recorded it) is a heuristic, not a proof; a freshly recycled pgid would also pass it. It is,
  however, strictly better than killing blind, and the window is small: it requires our leader to
  have died, our grandchildren to have survived it, *and* the pid to have wrapped ~50k values into
  a new group leader, all before the next app launch. **[asserted]**
- **A pid file whose record does not match is unlinked, never killed.** Deleting a stale file is
  free; `killpg`ing a stranger's process group is the worst failure this component can have.

**N (the SIGTERM→SIGKILL grace).** Measured, on this machine:

- A group of `sh` + two `sleep 300` grandchildren: whole group gone **12.5 ms** after `killpg(SIGTERM)`.
- A leader that ignores SIGTERM (`trap "" TERM`): survived the full 2000 ms grace, then died
  **6.3 ms** after `killpg(SIGKILL)`.
- A single `sleep 300` orphan (parent SIGKILLed): gone **12.5 ms** after SIGTERM.

**[asserted]** `claude`'s own SIGTERM handling is **unverified** — testing it means running a real
session, which costs API money, and the task forbade it. What is known: `process.rs:KILL_GRACE`
is 2 s, citing `agent-sdk.md` §10 (the SDK waits 2000 ms after EOF before SIGTERM). Recommend
**N = 2000 ms for an interactive kill** (unchanged) and **N = 400 ms for the startup sweep** — at
startup these processes are already orphans with no stdout reader, nothing is waiting on a clean
flush, and 400 ms × several stale sessions is dead time in front of the user's first window.
Escalate to SIGKILL and move on. Re-measure N against a real session before treating 400 ms as
anything other than a starting value.

## 6. The exit path

- **[source]** `tauri-runtime.md` §5: `RunEvent::ExitRequested { code, api }` fires first (`code`
  is `None` for a user quit, `Some(_)` via `AppHandle::exit`/`restart`), and `api.prevent_exit()`
  can hold the app open; `RunEvent::Exit` is last. `tauri-2.11.5/src/app.rs:220-231`.
- **[source]** §7 pitfall 4: `tauri::async_runtime::block_on` is `Handle::block_on` and **panics
  when called from a thread already inside a tokio runtime**. The `RunEvent` callback runs on the
  main thread, which is not a tokio worker — but it is also not somewhere to park for seconds.
- **[measured]** `killpg` is a bare syscall with no runtime dependency. The whole synchronous
  shutdown is `nix::sys::signal::killpg` + `std::thread::sleep` and touches nothing async.

Recommended shape, two layers:

```rust
// Registered at spawn, removed on SessionExited. std::sync::Mutex, never tokio's — this is
// locked from the main thread at exit.
pub struct Supervisor { live: std::sync::Mutex<HashMap<SessionId, PgroupRecord>> }

impl Supervisor {
    /// Main-thread, no tokio, no allocation-heavy work. Total wall time is one grace period,
    /// not one per session.
    pub fn shutdown_sync(&self, grace: Duration) {
        let groups: Vec<PgroupRecord> = self.live.lock().unwrap().values().cloned().collect();
        for g in &groups { let _ = killpg(Pid::from_raw(g.pgid), Signal::SIGTERM); }  // fan out first
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline
            && groups.iter().any(|g| killpg(Pid::from_raw(g.pgid), None).is_ok()) {
            std::thread::sleep(Duration::from_millis(10));
        }
        for g in &groups {
            if killpg(Pid::from_raw(g.pgid), None).is_ok() {
                let _ = killpg(Pid::from_raw(g.pgid), Signal::SIGKILL);
            }
            let _ = std::fs::remove_file(pid_file(&g.session_id));   // best effort
        }
    }
}
```

- **SIGTERM every group before waiting on any of them.** Wall time is then one grace period total,
  not N × grace. With the §5 numbers, ~15 ms in the common case.
- Hook it on **`RunEvent::Exit`**, and defensively on `ExitRequested` — `tauri-runtime.md` §5 says
  the same. **[asserted]** The nicer primary path is `ExitRequested` → `api.prevent_exit()` →
  spawn an async graceful shutdown (close each child's stdin; `claude-direct-spike.md` scenario 1
  measured a clean `exit 0` in **571 ms** that way) → `app.exit(0)`; `shutdown_sync` on
  `RunEvent::Exit` is then only the backstop for the paths that skip it. Cap the graceful phase at
  ~1.5 s or a hung session holds the quit.
- **Unlink the pid file after the kill, not before.** If the app dies mid-shutdown, the record must
  still be there for the next launch's sweep.
- **[measured]** `kill_on_drop(true)` (already set at `process.rs:170`) does not help here and does
  not hurt: it only runs if the `Child` is dropped by a live process, and it kills the direct child,
  not the group.

## 7. Force-quit, and grandchildren

- **[measured]** SIGKILL of the parent while it held the tokio `Child` with `kill_on_drop(true)`:
  the child survived, reparented to `PPID 1`, kept its pgid, and was still running 500 ms later
  (`36791 1 36791 SN sleep 300`). The next run's sweep matched its start time and killed it in
  12.5 ms. **Force-quit orphans children; the startup sweep is the only recovery.** As planned.
- **[measured]** `killpg` reaches grandchildren that stay in the group: `sh` (26558) plus two
  `sleep 300` (26560, 26561), all `PGID 26558`, whole group dead 12.5 ms after one `killpg(SIGTERM)`.
- **[measured]** **A grandchild that calls `setsid(2)` escapes.** A Python grandchild doing
  `os.setsid()` moved to `PGID 26563` (its own, `SESS` leader, `STAT Ss`) while its sibling stayed
  at `PGID 26562`. `killpg(26562, SIGTERM)` killed the leader and the sibling; the setsid'd process
  survived and had to be `kill -9`ed by pid. This is **measured, not asserted** — `tauri-runtime.md`
  did not state it.
- **[asserted]** Consequence for `claude`: its Bash-tool subprocesses and stdio MCP servers are
  ordinary `fork`/`exec` children and stay in the group, so `killpg` covers them. Anything that
  daemonizes itself — an MCP server that `setsid`s, or a user's own `nohup`/`disown` inside a Bash
  tool call — is out of reach of `killpg` and out of reach of the sweep, because we never recorded
  its pgid. Not fixable at this layer; `proc_listpids(PROC_PPID_ONLY)` walking is the only
  escalation and it loses the race against a re-parented daemon. Log it, do not chase it.
- **[measured]** Interactive `claude` processes are each their own process-group leader already
  (five sampled, all `PID == PGID`) — that is the shell's job control, not the CLI's doing, but it
  means `process_group(0)` is not fighting anything the CLI expects.

## Recommended design

**Crates to pin: none.** `libc = "0.2"` (already at 0.2.189 in `Cargo.lock`, zero new packages) and
the existing `nix = "0.31.3"` with `features = ["signal"]` — do **not** add `sysinfo` (+18 packages
and no group enumeration), `libproc` (bindgen build-dep) or a `ps` shell-out (2.8 ms per pid).

```rust
// crates/core/src/proc.rs  — the only place unsafe is allowed in this crate
#![allow(unsafe_code)]
pub struct BsdInfo { pub ppid: u32, pub pgid: u32, pub status: u32,
                     pub start_tvsec: u64, pub start_tvusec: u64 }
pub fn bsd_info(pid: i32) -> Option<BsdInfo>;          // proc_pidinfo(PROC_PIDTBSDINFO), 164 ns
pub fn group_members(pgid: u32) -> Vec<i32>;           // proc_listpids(PROC_PGRP_ONLY=2), ~95 µs

// crates/core/src/pidfile.rs
#[derive(Serialize, Deserialize)]
pub struct PidRecord {
    pub session_id: String, pub run_id: String,
    pub pid: i32, pub pgid: i32,
    pub start_tvsec: u64, pub start_tvusec: u64,
    pub pid_domain: &'static str,            // "darwin"
    pub owner_pid: i32, pub owner_start_tvsec: u64, pub owner_start_tvusec: u64,
    pub binary: String, pub cwd: String, pub written_at_unix: u64,
}
pub fn write_atomic(dir: &Path, rec: &PidRecord) -> io::Result<()>;   // tmp + sync_all + rename
pub fn remove(dir: &Path, session_id: &str);                          // ignore ENOENT
pub fn sweep(dir: &Path, grace: Duration) -> Vec<SweepOutcome>;       // §5 algorithm
```

Wiring, in order:

1. `process.rs::spawn` returns `pid` already. Have the adapter (or the layer above it) call
   `proc::bsd_info(pid)` **immediately after spawn** and `pidfile::write_atomic` before the first
   frame is written. The window between `fork` and the pid file is the only unrecoverable one; keep
   it to two syscalls.
2. Register `PgroupRecord { session_id, pgid }` in `Supervisor.live: std::sync::Mutex<HashMap<…>>`.
   Deregister and `pidfile::remove` on every terminal event (`SessionExited` of any reason).
3. `Builder::setup` → `pidfile::sweep(dir, Duration::from_millis(400))` before the window shows.
   It is a handful of syscalls per record; do not spawn a task for it.
4. `.on_run_event(|_, e| match e { RunEvent::ExitRequested{..} => graceful, RunEvent::Exit =>
   supervisor.shutdown_sync(Duration::from_millis(400)), _ => {} })` — `src-tauri/src/lib.rs`
   currently has no `on_run_event` at all.
5. Refuse `pgid <= 1` everywhere, and never kill on a start-time mismatch — unlink and log.

## Measured

All on darwin 25.5.0 / arm64, 2026-09-02, with a purpose-built Rust binary at
`/private/tmp/claude-501/-Users-stephen-Development-brigadier-ai/4f51c909-c13d-4519-8972-519fe73618a3/scratchpad/orphan/`
(tokio 1.53.1, nix 0.31.3, libc 0.2.189, sysinfo 0.39.6). No `claude` session was run.

| # | What | Result |
|---|---|---|
| 1 | `process_group(0)` on `tokio::process::Command`, 5 spawns | child `pgid == pid` every time; parent pgid untouched |
| 2 | parent `exit(0)` without reaping, child alive | child reparented to `PPID 1`, pgid preserved, still running |
| 3 | `killpg(SIGTERM)` on `sh` + 2 `sleep 300` grandchildren | whole group gone in **12.5 ms** |
| 4 | `killpg(SIGTERM)` on `sh -c 'trap "" TERM; sleep 300'` | survived 2000 ms grace; SIGKILL killed it in **6.3 ms** |
| 5 | grandchild calling `os.setsid()` | escaped to its own pgid; **survived `killpg` of the parent group**; needed `kill -9` by pid |
| 6 | forged `start_time_unix` in the pid file (pid reuse simulation) | sweep printed `RECYCLED recorded=… live=…`, refused to kill, unlinked the file |
| 7 | `kill(1,0)` / `kill(99998,0)` / `kill(self,0)` | `EPERM` / `ESRCH` / `Ok` |
| 8 | reparented child exits | launchd reaps it; `ps` rc=1, `kill(0)` = `ESRCH`, **no zombie** |
| 9 | zombie with a live parent | `kill(0)` = `Ok`; `proc_pidinfo` **both flavours return 0, errno 3**; `ps -o lstart=` still prints a time |
| 10 | leader killed, one group member left | `kill(leader,0)` = `ESRCH`, `proc_pidinfo(leader)` = `None`, **`killpg(pgid,0)` = `Ok`**, `killpg(pgid,TERM)` killed the survivor |
| 11 | SIGKILL of the parent holding the child with `kill_on_drop(true)` | child survived, `PPID 1`, pgid intact; next-run sweep killed it in 12.5 ms |
| 12 | `proc_pidinfo(PROC_PIDTBSDINFO)` | **164 ns/call** (1000 iterations) |
| 13 | `proc_listpids(PROC_PGRP_ONLY, pgid)` | **93 µs** with leader, **98 µs** after leader death; returns members + their `pbi_pgid` |
| 14 | sysinfo 0.39.6, 3 runs, 696 processes | `Some(&[pid])` + `nothing()`: **61–95 µs**; `All`+`nothing()`: **4.2–4.5 ms**; `All`+`everything()`: **7.1–8.8 ms**; `System::new()` 17–20 µs |
| 15 | `ps -o lstart= -p <pid>` from Rust | **2.7–2.8 ms** |
| 16 | sysinfo `default-features=false, features=["system"]` lock cost | **34 → 52 packages** (+18, incl. `windows*`, `ntapi`, `objc2-*`, `syn`) |
| 17 | `pbi_comm` of 5 live `claude` processes | `"2.1.252"`, `"2.1.258"`, `"2.1.251"`, `"2.1.257"`, `"2.1.258"` — version basenames, not `"claude"` |
| 18 | `(pbi_start_tvsec, pbi_start_tvusec)` of 3 same-instant siblings | `…210.704445`, `…210.707890`, `…210.708325` — µs resolution real |
| 19 | Claude Code `procStart` vs `ps -o lstart=` vs `startedAt` | `procStart` is the same instant **rendered in UTC**, 1 s before `startedAt`; not a `ps` shell-out |
| 20 | pid space | `kern.maxproc=6000`, `kern.maxprocperuid=4000`, 707 live processes |

## Not checked

- **`claude`'s own SIGTERM behaviour is entirely unverified.** Whether it traps SIGTERM, how long
  it takes to flush its transcript, and whether it leaves anything behind on SIGKILL. Every grace
  number here comes from `sleep` and `sh`. The 400 ms sweep grace is a starting value, not a
  measurement.
- Whether `claude` ever spawns a grandchild that `setsid`s. The escape is measured with a Python
  stand-in; the claim that MCP stdio servers stay in the group is **asserted**.
- No Tauri code was written or run. `RunEvent::Exit` ordering, `prevent_exit()` behaviour and
  whether the main thread tolerates a 400 ms sleep during quit are all read-from-source, not tested.
  `src-tauri/src/lib.rs` is still the 13-line stub.
- `app_local_data_dir()` was not called; `persistence.md`'s open question about whether it creates
  the directory is still open.
- The two-instance scoping rule (owner pid + start time) was reasoned, not exercised — no two app
  instances were run against a shared `pids/` directory.
- `KERN_PROC/KERN_PROC_PID` `sysctl` and `kp_proc.p_starttime` were not tried; `proc_pidinfo`
  answered everything, so the `sysctl` path is untested and unneeded.
- Windows and Linux: `process_group`/`killpg`/`proc_pidinfo` are all unix or Apple-only. The
  Windows job-object equivalent remains unresearched, as `tauri-runtime.md` also notes.
- No test of the sweep under a genuinely recycled pid — reuse was simulated by forging the recorded
  start time, which exercises the comparison but not a real wraparound.
- The `unsafe` module was not written into `crates/core`; it exists only as scratchpad examples.
  `cargo check` on the real crate with `libc` added was not run.
