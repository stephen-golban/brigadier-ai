# Naming the holder of a workspace lock, and sweeping the registry that leaks

Dated 2026-09-11. Written because this refusal told the owner nothing:

```
Workspace overlaps another running turn, terminal, or restore operation:
lock acquisition failed because the operation would block
```

The mechanism was right — a brigadier terminal was open on that workspace, a terminal holds
`terminal-root-{key}` exclusively for its directory, an AI turn takes `terminal-desc-{key}`
exclusively for its root and `terminal-root-{key}` shared over every ancestor, and they collide by
design (`crates/core/src/checkpoint/lease.rs`). The reporting was useless: no holder, no path, no
lock file, no remedy.

Every claim below is marked **measured** (run or read here today) or **asserted** (someone else's
documentation, taken on trust).

## 1. The kernel will not tell you who holds a `flock`

- **measured, docs read 2026-09-11** — <https://doc.rust-lang.org/std/fs/struct.File.html>:
  `File::try_lock` "corresponds to `flock` with the `LOCK_EX` and `LOCK_NB` flags",
  `try_lock_shared` to `LOCK_SH | LOCK_NB`, `unlock` to `LOCK_UN`. It returns
  `Result<(), TryLockError>` with exactly two variants, `WouldBlock` and `Error(io::Error)`. The
  lock "will be released when this file (along with any other file descriptors/handles duplicated
  or inherited from it) is closed". The page says **nothing** about identifying a holder, and
  nothing about unlinked files.
- **asserted** — <https://man7.org/linux/man-pages/man2/flock.2.html>: "Locks created by flock()
  are associated with an open file description"; `LOCK_NB` yields `EWOULDBLOCK`; the page offers
  no query operation of any kind.
- **asserted** — POSIX record locks (`fcntl`) *do* name a holder: `F_GETLK` fills `l_pid` with the
  pid of a conflicting lock (<https://man7.org/linux/man-pages/man2/fcntl_locking.2.html>, and
  <https://apenwarr.ca/log/20101213> "fcntl() locks have the handy feature of being able to tell
  you which pid owns a lock, using F_GETLK"). But `flock` and `fcntl` locks do not interact, so
  `F_GETLK` cannot see the locks this registry already takes.

**Consequence.** There are two ways to get holder identity: switch the whole registry to `fcntl`
record locks and read `l_pid`, or have the holder publish a record of itself. The switch is
rejected: `fcntl` locks are owned by the *process*, not the open file description, so they are
released by closing *any* descriptor on the file, they do not exclude two leases inside one
brigadier process (which is exactly the owner's case — the terminal and the turn are the same
process), and `l_pid` alone gives a number, not a kind, a session id, or a path. Rejected on the
documented semantics; **not measured**.

**Decision: the holder writes its own identity.** A `LockOwner` record — `{kind, id, root, pid,
started_at}` — is written **into the lock file itself**, not into a sidecar, by whichever lease
holds that file **exclusively**. Into the file, because a sidecar is a second file to create,
rename, and leak, whereas the record's lifetime is then exactly the lock file's lifetime and the
sweep in §4 collects both at once.

Limits of this, stated plainly:

- A lock taken **shared** writes nothing — several holders share the file and would overwrite each
  other. So an ancestor lease blocked by a *descendant* turn does not find a record in the file
  that refused it. Mitigation: on refusal, after the direct read fails, the loser scans the
  registry for any live record whose root overlaps its own and reports that instead (bounded, §4).
  Nothing covers a workspace blocked only by shared holders that published no record anywhere; it
  is reported as "no owner record", never as a guess.
- The record is written after the lock is taken, so a loser can in principle read a half-written
  record. A parse failure is reported as "no owner record", never as a corrupt holder. **Not
  measured**; the window is two syscalls wide.
- A record is only evidence about the file it sits in when it names the directory that file is
  keyed to. A `SIGKILL`ed exclusive holder leaves its record in a file others may still hold
  shared, and with pid reuse that record would name an unrelated live process as the holder. So
  the reader checks the record's root against the lock file's own name (`terminal-root-`/
  `terminal-desc-` prefix stripped) and falls through to the registry search when they disagree.
- One lease is shared by every terminal tab at a root, so the tab that opened it is usually gone
  before anything is refused. `WorkspaceLease::relabel` re-publishes the record under a tab that is
  still open, and the app calls it whenever a tab opens or closes.
- A recorded pid can be reused by an unrelated process after a crash. The record is only ever read
  on `EWOULDBLOCK`, so something *is* holding the lock; a live pid is corroborated, and a dead one
  is reported as stale rather than as a holder. Pid reuse where a *live* unrelated process inherits
  the number is **not** detected — `started_at` is stored so a future check can compare it against
  the process's own start time. **Not implemented, not measured.**

## 2. Liveness

`nix::sys::signal::kill(pid, None)` sends no signal and reports `ESRCH` for a pid that does not
exist, `EPERM` for one owned by another user (**asserted**, kill(2)). `brigadier-core` is
`#![deny(unsafe_code)]`, so `nix` — already a dependency here for `killpg` and `getuid` — is the
only route to it. Alive means `Ok(())` or `EPERM`; pids `0` and `1` are never treated as holders.

## 3. The unlink/inode race, and why the acquire path re-stats

`flock` locks the **inode**, and the registry sweep in §4 unlinks lock files. So this sequence is
possible: A opens `L`; B locks `L` and unlinks it; A locks the now-orphaned inode; C creates a
fresh `L` and locks it; A and C both believe they own the workspace.

The standard fix — **asserted**, and used by rkt's `pkg/lock`
(<https://github.com/rkt/rkt/pull/3615>) among others — is to compare the `fstat` of the locked
descriptor against a `stat` of the path after locking, and to re-open and retry when they differ.
`take()` in `lease.rs` does exactly that, up to four attempts.

The mirror image also matters and is easy to miss: the sweep holds a dead file exclusively for the
instant before it unlinks it, so a concurrent acquirer can be refused by a lock that belongs to
nobody. That refusal is distinguishable — it carries no owner record — so `take()` retries an
ownerless refusal three times at 3 ms before reporting a conflict. The two retries run on two
different clocks on purpose: re-opening after a mismatch costs nothing and is bounded by a 250 ms
window, while an ownerless refusal sleeps and is bounded by a count, so a sweep cannot push a
genuine shared-holder conflict past three sleeps. A genuine conflict therefore costs ~9 ms once. **Not measured under contention**; argued from the fact that
lock-then-unlink is two adjacent syscalls.

## 4. Retention: what may be deleted, and the bound

The registry is `~/.brigadier/workspace-locks-v1` (override `BRIGADIER_WORKSPACE_LOCK_DIR`), one
file per directory ever locked, previously never swept. **Measured by the owner, 2026-09-11**:
24,655 files, ~24k of them from roughly 200 packaged-app launches by a measurement harness in one
afternoon, plus 53 `.recovery` markers pointing at test tempdirs that no longer exist; 6 entries
were live. Swept by hand; back to 436 by the time this was written.

Rule implemented:

1. **A lock file that can be locked exclusively, non-blocking, is dead** — `flock` releases on
   close and on process death, so nothing holds it. Unlink it *while still holding that lock*, so
   the only process that can be mid-acquisition on the old inode detects the mismatch in §3 and
   retries. Files this lease itself holds are skipped by name.
2. **A `.recovery` marker whose recorded root is proven gone is removed.** Proven means `stat`
   failed with **`NotFound` only**: `EACCES`, `EIO`, `ELOOP` and `ESTALE` all mean "cannot tell",
   and unlinking a durable blocker on a guess loses an unresolved restore for good. A `NotFound`
   whose nearest *existing* ancestor is a mount point (its `st_dev` differs from its parent's) is
   refused too, because an unmounted volume makes every path below it disappear without anything
   having been deleted. There is otherwise nothing left to restore into, and keeping the marker
   only refuses a future directory that reuses the path. A marker
   whose root still exists is **never** removed, whatever its pid says: a durable blocker that
   outlives the process that wrote it is the entire point of the marker
   (`crates/core/tests/checkpoints.rs::durable_recovery_blocks_nested_roots_after_live_lease_exits`).
   The brief's "dead pid plus a bounded age" rule is deliberately **not** implemented — it would
   silently discard an unresolved restore and break that invariant.
3. **A `.tmp` file older than an hour is removed** — the atomic-write scratch of a `block()` that
   died between create and rename.
4. The standalone `sweep_registry()` applies rule 2 as well as rule 1, so a startup sweep collects
   dead markers and not only dead lock files.

The marker branch of the scan has its own budget (512 probes or 50 ms) for the *removal* checks,
but its read and overlap test are **never** skipped and cannot be: missing one marker lets a turn
write into a workspace with an unresolved restore, which is the one thing the marker exists to
prevent. For the same reason the old hard error at 100,000 entries is gone — it refused every
acquisition forever while the sweep removed only 256 files per call, so a flooded registry could
never drain. Past that count the scan now warns and escalates its own sweep to 65,536 probes or
2 s, and the acquisition still succeeds. The scan is then O(entries); that is the deliberate trade,
because the only alternative that keeps marker safety is refusing to work at all.

Bound: **at most 4,096 probes or 150 ms on the first sweep in a process, and at most 256 probes or
25 ms on every sweep after it**, whichever comes first; the enclosing directory scan is capped at
100,000 entries, as it already was. Successive acquisitions make progress because a probe that
succeeds unlinks the file, so the front of the directory is not the same set next time.

**Measured 2026-09-11** (debug build, macOS 25.6, isolated registry seeded with 24,000 dead lock
files, one throwaway test since deleted):

| | |
|---|---|
| first `acquire` in the process, 24k entries | 165 ms |
| every later `acquire`, still 24k entries | 25 ms |
| 24,000 entries drained to 19 | 82 acquisitions, 1.9 s total |
| `acquire` on a drained registry | 368 µs |

So the pathological registry costs a session start 165 ms once and 25 ms a time until it is drained,
and the drain takes 82 session starts. It is bounded, never unbounded, and the steady state after
the leak is paid off is a third of a millisecond.

The failure-path scan of §1 (find a live overlapping record elsewhere) is bounded separately at
2,048 entries or 50 ms and runs only when an acquisition has already failed.

## Test isolation

Every test binary that can reach a lease points `BRIGADIER_WORKSPACE_LOCK_DIR` at a throwaway
directory, because otherwise `cargo test` reads *and now sweeps* the developer's real
`~/.brigadier/workspace-locks-v1`. `WorkspaceLease::isolate_registry_for_tests()` does it for
`brigadier-core` and `brigadier-supervisor`; the app crate has its own
`src-tauri/src/test_support.rs::isolate_workspace_locks()`, and the two must not be mixed inside
one binary — so the core helper now yields to an already-set variable rather than overriding it.

## Not checked

- Nothing here was exercised on Linux or Windows; the tests are `cfg(unix)` and were run on macOS
  only. Windows `LockFileEx` locks are mandatory, and the unlink-while-locked step of the sweep
  will not behave the same there.
- Network filesystems. `flock` over NFS/SMB is unreliable and no attempt is made to detect one.
- The numbers above are a debug build, and were taken with no other process contending for the
  registry. A release build and a contended registry were not measured.
- Pid reuse by a live unrelated process (§1).
- The mount-boundary guard on rule 2 was reasoned from `st_dev`, not exercised against a real
  unmounted volume. Its `EACCES` half is covered by a test; the mount half is not.
- The close-path half of `relabel` is covered by a test; the reuse-path half (a second tab opening
  on a lease another tab took) is only covered indirectly, because which tab a re-label picks is
  `HashMap` order.
- Which test binaries remain unisolated: `crates/supervisor/tests/live_*.rs` and
  `flood_baseline.rs` were left alone.
