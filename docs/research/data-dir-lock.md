# Locking the data directory against a second app instance

Question: `Store::open` runs `settle_stale_sessions` unscoped, so a second app instance on the
same data directory marks the first instance's live sessions `failed`. Decision taken by the
owner: **refuse the second instance**. This brief settles how the lock is taken.

## What was checked

- **Toolchain (measured, 2026-09-02)**: `rustc --version` in this repo prints
  `rustc 1.98.0 (88d9e12ae 2026-08-18)`; `cargo 1.98.0`.
- **std API (measured, docs read 2026-09-02)**: <https://doc.rust-lang.org/std/fs/struct.File.html>
  documents `File::lock`, `File::try_lock`, `File::lock_shared`, `File::try_lock_shared` and
  `File::unlock`, all **stable since 1.89.0**. Signatures:
  `pub fn try_lock(&self) -> Result<(), TryLockError>` where `TryLockError` is
  `WouldBlock | Error(std::io::Error)`; `lock`/`unlock` return `io::Result<()>`.
- **Platform semantics (asserted by std's own docs, not measured here)**: on Unix — macOS
  included — `try_lock` "currently corresponds to the `flock` function with the `LOCK_EX` flag",
  i.e. an **advisory** lock owned by the open file description and **released when the file is
  closed**, therefore also when the process exits or is killed. No stale lock file to clean up,
  which is exactly the property a crash-safe single-instance guard needs.
- **Behaviour in this repo (measured)**: `crates/store/src/lib.rs::a_second_store_on_the_same_data_dir_is_refused`
  opens two `Store`s on one temp dir in one process and gets `Error::Locked` on the second, then
  succeeds after the first is dropped. So flock's per-open-file-description ownership does give
  us mutual exclusion even *within* one process, not only across processes.

## Decision

Use **`std::fs::File::try_lock`**. No new dependency, no version to pin, no supply chain.

- `fs4` and `fd-lock` were **not** evaluated in depth: with std stable at 1.89 and this toolchain
  at 1.98, a crate would only add deps for an API the standard library already ships. Recorded as
  a decision by elimination, not as a comparison — if the minimum supported Rust ever drops below
  1.89, revisit and re-read the docs.rs pages then.

## Implementation

- `brigadier_store::DataDirLock::acquire(root)` opens (creating) `<root>/brigadier.lock` and calls
  `try_lock`. `WouldBlock` → `Error::Locked { path }`; any other error → `Error::Io`.
- `Store::open` acquires it **before** `expire_pending_approvals` / `settle_stale_sessions`, and
  holds the `File` in the `Store` for the store's lifetime. Dropping the `Store` (or the process
  dying) releases it.
- `src-tauri/src/error.rs` maps `Error::Locked` to the IPC code **`data_dir_locked`**; startup in
  `src-tauri/src/state.rs` already reports failures through `AppState::failed` rather than
  panicking, so the window opens and every command answers with that code.

## Not checked

- Cross-process behaviour (two OS processes) was not tested; only the in-process pair above.
- Network filesystems. `flock` over NFS/SMB is unreliable, and the data dir here is
  `~/Library/Application Support`, which is local; no attempt was made to detect a networked home.
- Windows/Linux: std documents Windows locks as mandatory rather than advisory. Only macOS was
  exercised.
