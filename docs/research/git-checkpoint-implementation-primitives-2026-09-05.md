# Checkpoint implementation primitives: safe Rust and macOS

2026-09-05. Research and disposable tests only; no production edits. This follows the confirmed checkpoint design. **[source]** Core has `#![deny(unsafe_code)]`; its existing Unix `nix=0.31.3` dependency enables only `signal`. **[proposal, selected with implementing agent]** Add nix `fs`/`dir` features, use cached `rustix=1.1.4` with `fs` for descriptor xattrs, reject ACL-bearing/ambiguous paths, and keep file mutation descriptor-relative. No runtime shell or copy helper is required by the selected approach.

## Verified API boundary

Source root read locally: `/Users/stephen/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`. All APIs below are safe public Rust functions; their dependency-internal unsafe implementations do not require unsafe in Brigadier.

| Operation | Exact API and source | Status |
|---|---|---|
| Open anchored child | `nix::fcntl::openat(dirfd: impl AsFd, path: &P, flags: OFlag, mode: Mode) -> Result<OwnedFd>`; `nix-0.31.3/src/fcntl.rs:274` | **[measured]** compiled and executed |
| Open root | `nix::fcntl::open(path, flags, mode) -> Result<OwnedFd>`; `fcntl.rs:246` | **[measured]** |
| Enumerate anchored directory | `nix::dir::Dir::from_fd(OwnedFd) -> Result<Dir>` then `iter()`; `dir.rs:107`. Feature `dir` also enables `fs`. | **[measured]**; avoid deprecated unsafe `Dir::from` |
| Inspect | `nix::sys::stat::{fstat, fstatat}`; `fstatat(&parent, leaf, AtFlags::AT_SYMLINK_NOFOLLOW)`; `sys/stat.rs:248` | **[measured]** symlink classified without following |
| Rename within held parents | `nix::fcntl::renameat(&old_parent, old_leaf, &new_parent, new_leaf)`; `fcntl.rs:425` | **[measured]**; located in `fcntl`, not `unistd` |
| No-clobber create publication | `rustix::fs::renameat_with(&parent, temp, &parent, target, RenameFlags::NOREPLACE)`; `rustix-1.1.4/src/fs/at.rs:296`, Apple flag mapping in `backend/libc/fs/types.rs:527` | **[measured]** existing target rejected; nix `renameat2` is Linux-only |
| Delete anchored entry | `nix::unistd::unlinkat(&parent, leaf, UnlinkatFlags::NoRemoveDir)`; `unistd.rs:1643` | **[measured]**; no recursive cleanup |
| Symlink bytes | `nix::fcntl::readlinkat(&parent, leaf) -> Result<OsString>`; `fcntl.rs:680`; create with `nix::unistd::symlinkat(target, &parent, leaf)`, `unistd.rs:882` | **[measured]** read; **[source]** creation API only |
| Mode | `nix::sys::stat::fchmod(&file, Mode::from_bits_truncate(mode))`; `sys/stat.rs:275` | **[measured]** executable mode persisted |
| Directory creation | `nix::sys::stat::mkdirat(&parent, leaf, mode)`; `sys/stat.rs:470` | **[source]**, not executed here |
| File I/O | `File::from(OwnedFd)`, `write_all`, `set_len`, `sync_all`, `metadata`; retain owned descriptor until publication | **[measured]** conversion/read/write/sync; set_len not needed in fixture |
| Flush | `nix::unistd::fsync(&fd)`; on macOS `nix::fcntl::fcntl(&fd, FcntlArg::F_FULLFSYNC)` | **[measured]** both accepted on fixture directory; full flush accepted on regular file |

**[proposal]** Open directories with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`; walk one validated normal path component at a time. Open an existing regular leaf without `O_TRUNC`, using `O_NOFOLLOW | O_CLOEXEC`, then inspect descriptor type/identity/link count before reading. Create staging leaves with `O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC` and mode 0600. Do not pass a multi-component untrusted relative path to one `openat`: final-component no-follow does not protect its intermediate components. Reject absolute paths, `.`/`..`, separators in leaf names and Git-admin components. Revalidate root/ancestor identities before publication. The workspace lease remains necessary; descriptors do not defeat an arbitrary process moving an already-open directory outside the logical root.

## Bounded xattrs and ACL rejection

**[source + measured]** Cached rustix exposes these APIs on Apple under its `fs` feature (`rustix-1.1.4/src/fs/xattr.rs:90,154,211,254`):

```rust
// With &mut [u8], the returned Buffer::Output is usize.
flistxattr(fd: impl AsFd, list: impl Buffer<u8>) -> io::Result<Buf::Output>
fgetxattr(fd: impl AsFd, name: impl path::Arg, value: impl Buffer<u8>)
    -> io::Result<Buf::Output>
fsetxattr(fd: impl AsFd, name: impl path::Arg, value: &[u8], flags: XattrFlags)
    -> io::Result<()>
fremovexattr(fd: impl AsFd, name: impl path::Arg) -> io::Result<()>
```

These abbreviated signatures describe generic arguments; actual generic parameter names are `Fd`, `Name`, `Buf`. **[measured]** Calls below compile under `#![deny(unsafe_code)]`:

```rust
let needed = rustix::fs::flistxattr(&file, &mut [] as &mut [u8])?;
// Enforce application limit before allocating.
let mut names = vec![0u8; needed];
let used = rustix::fs::flistxattr(&file, names.as_mut_slice())?;
names.truncate(used); // Parse nonempty NUL-separated names as raw OsStr bytes.
let needed = rustix::fs::fgetxattr(&file, key, &mut [] as &mut [u8])?;
let mut value = vec![0u8; needed];
let used = rustix::fs::fgetxattr(&file, key, value.as_mut_slice())?;
value.truncate(used);
rustix::fs::fsetxattr(&temp, key, &value, rustix::fs::XattrFlags::empty())?;
```

**[proposal]** Store a sorted raw-name/raw-value map (binary encoding, not lossy UTF-8). Suggested initial limits: 64 KiB names buffer, 512 names, 256 KiB per value and 1 MiB total xattr bytes per file; all are policy choices, not OS limits. Check every size before allocation and aggregate before accepting the snapshot. A bounded retry may handle `ERANGE` between size query and read; continued change, disappearance, permission denial or oversize yields incomplete/unsupported capability. Never assume an error means “no attrs.” Resource forks can exceed these limits and must then be reported explicitly.

**[measured]** Newly created fixture files automatically carried `com.apple.provenance`; rejecting every xattr would reject ordinary files in this environment. Capturing and applying both that attribute and a custom binary value through rustix file-descriptor APIs succeeded. A plain atomic replacement lost the custom xattr; applying the saved map before rename preserved it. **[proposal]** Reconcile the temporary file's entire map: remove extra automatically created keys absent from the desired map (or reject if removal fails), set desired values, reread and compare, then flush. For creation after an earlier deletion, use historical checkpoint metadata; copying only current-file metadata cannot recover an absent before-image. Include xattr-map digest and supported permission bits in `PathState`/guard equality, so metadata-only changes are not treated as zero work.

**[superseded proposal]** The initial `/bin/ls -lde` ACL gate is rejected. Apple source calls `acl_get_link_np` and treats a null result as no ACL without reporting that getter failure; `@` also takes precedence over `+` when xattrs exist. Successful exit, empty stderr and the expected line count therefore cannot prove ACL absence. [Apple ls.c](https://raw.githubusercontent.com/apple-oss-distributions/file_cmds/main/ls/ls.c), [print.c](https://raw.githubusercontent.com/apple-oss-distributions/file_cmds/main/ls/print.c). This is a source-identified failure path; an installed fixture denying `readsecurity` failed visibly at metadata acquisition, so it did not reproduce a silent false negative.

**[source + measured, replacement v1]** Add `exacl = { version = "0.13.0", default-features = false }` on macOS. Its safe public API is `getfacl<P: AsRef<Path>, O: Into<Option<AclOption>>>(path, options) -> io::Result<Vec<AclEntry>>`. Use `exacl::getfacl(path, exacl::AclOption::SYMLINK_ACL)?`; accept only an empty vector and reject every nonempty vector or error. It supports files/directories and queries the final symlink itself. On macOS its entries are extended ACLs, so an empty vector is the desired supported state. **Version 0.13.0 has no `NUMERIC_ACL` flag**; that option exists on newer upstream main. [Tagged public API](https://raw.githubusercontent.com/byllyfish/exacl/v0.13.0/src/lib.rs), [tagged options](https://raw.githubusercontent.com/byllyfish/exacl/v0.13.0/src/acl.rs).

**[source]** The Apple implementation propagates `acl_get_link_np` errors, except `ENOENT` with an existing path is converted to an empty ACL for macOS's no-ACL behavior. Entry decoding errors propagate; its iterator treats nonzero `acl_get_entry` as end-of-list, so do not claim validation of arbitrary malformed native ACL objects. [Tagged macOS implementation](https://raw.githubusercontent.com/byllyfish/exacl/v0.13.0/src/util/util_macos.rs), [iteration implementation](https://raw.githubusercontent.com/byllyfish/exacl/v0.13.0/src/util/util_common.rs). **[limit]** This is a read-only path API, not descriptor-relative: retain supported quiescence and root/ancestor/leaf identity revalidation. It does not defeat adversarial concurrent parent swaps. Check relevant directories and staged files for inherited ACLs too. Core needs no unsafe code or runtime shell.

**[measured]** Exact exacl 0.13.0 compiled in a disposable `#![deny(unsafe_code)]` crate. `SYMLINK_ACL` returned zero entries for ordinary file/directory, one for a file with an ACL, zero for a link pointing at that ACL file, zero for a dangling link, `NotFound` for a missing path and `PermissionDenied` for a file denying `readsecurity`. Fixture source: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-exacl-probe-gsufat2m/src/main.rs`; data: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-exacl-cases-1cq022le`.

**[proposal]** Reject hardlinked regular files (`nlink != 1`), nonordinary mode bits/flags, unsupported ownership, special files and unsupported directory topology before apply. Preserve full supported permission bits in metadata rather than turning an existing 0600 file into Git's 0644 tree mode. Symlink bytes can be captured safely, but symlink xattrs cannot be read through an ordinary no-follow regular-file descriptor; keep affected symlink restore capability unavailable until its metadata handling is implemented and tested. Any parent newly created by restore needs an explicit directory-metadata/inheritance policy; v1 can reject plans requiring unsupported parent creation.

## Git durability settings verified on 2.50.1

**[documented]** `core.fsync` selects hardened components; `all` includes objects, refs, index and derived metadata. `core.fsyncMethod=fsync` requests flushing; macOS defaults to weaker `writeout-only`. Explicitly set both in the private command runner. [Git config 2.50 documentation](https://git-scm.com/docs/git-config/2.50.0), independently matched against installed `man git-config`.

**[measured]** With `-c core.fsync=all -c core.fsyncMethod=fsync`, installed Apple Git accepted `hash-object -w --no-filters --stdin`, `read-tree --empty`, `update-index -z --index-info`, `write-tree`, and `update-ref refs/checkpoints/test TREE`. Trace2 recorded hardware-flush counts of 1, 1, 1, 2, 1 respectively. Tree remained readable. This proves settings activated the flush path, not survival of a power-loss test.

**[source]** Upstream Git v2.50.1 implements its Apple hardware-flush path with `fcntl(fd, F_FULLFSYNC)` in [wrapper.c](https://raw.githubusercontent.com/git/git/v2.50.1/wrapper.c). Installed `man fcntl` distinguishes drive cache flush from ordinary fsync and documents hardware caveats. **[measured]** Safe nix `F_FULLFSYNC` returned `Ok(0)` for fixture regular file and directory; directory fsync returned `Ok(())`.

**[proposal]** Flush data/metadata before publishing and flush parent directories after rename/delete; then flush the journal before advancing durable phase. Retained refs precede complete SQLite checkpoint metadata. Git command completion does not jointly commit the store, SQLite and working files. Directory creation/ref directory publication and startup recovery still need fault injection. Do not claim device-independent power-loss guarantees from these tests. `core.fsync=all` is the correctness-first setting; temporary-index flush overhead can be tuned only after separate evidence.

## Disposable evidence and rejected shortcuts

- **[measured]** Safe Rust fixture: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-safe-fs-rust-rph71fhg`; `Cargo.toml` uses exact nix 0.31.3 (`fs`,`dir`) and rustix 1.1.4 (`fs`), compiled offline. Final `fixture5` run: xattr zero-size queries PASS; descriptor xattr capture/copy roundtrip PASS; no-replace collision PASS; binary/tab/newline pathname roundtrip PASS; symlink directory open refused; descriptor enumeration and deletion PASS; file/directory full flush calls accepted. Test source is `src/main.rs` in that temporary directory. These tests used only disposable files.
- **[measured]** ACL fixture: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-metadata-probe-ellfny7z`. `ls -lde FILE` showed ACL; passing FILE as stdin and inspecting `/dev/fd/0` hid the ACL and reported different mode. Passing the parent directory as stdin then addressing `/dev/fd/0/file` failed ENOENT; `cd /dev/fd/0` failed “Not a directory.” **Do not use fdesc paths as an ACL or traversable-directory workaround.**
- **[documented + measured]** Installed `/bin/cp -p` preserves ACL/xattrs; the fixture copy did so. Its manual says UID/GID preservation failures may leave exit status zero; `-P` is ignored without `-R`. A disposable safe Rust helper using child-only `nix::unistd::fchdir(stdin)` then `CommandExt::exec` could run anchored relative cp and preserve ACLs. **Rejected for selected v1:** no copy/helper/shell dependency; use ACL rejection and descriptor xattr capture instead.
- **[measured]** Git fixture: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-git-fsync-6s_29bye`; `trace.json` records installed Git hardware-flush counters. Tree `c38470251e596e9c4a05bd05f427e117c94d6eaa` is retained under fixture `refs/checkpoints/test`.

**[unchecked]** No production restore, provider call, live-project mutation, fault-injection crash or power-loss test occurred. Remaining implementation gates: structured ACL error handling and parent coverage, xattr deletion/permission failures and quotas, symlink metadata policy, inherited directory metadata, hardlinks/file flags, journal recovery around each operation, and full filesystem durability verification. The primitives above do not justify silently weakening these gates.

## Lock lifetime and concurrent subprocesses

**[documented + source]** Unix `File::try_lock` uses `flock(LOCK_EX | LOCK_NB)`; `unlock` uses `LOCK_UN`. A lock survives closing one descriptor while a duplicate or fork-inherited descriptor remains. Explicit unlock releases the shared lock immediately. `O_CLOEXEC` only closes the inherited descriptor at exec, leaving a pre-exec inheritance interval. Rust opens files with `O_CLOEXEC`; subprocess implementation can use spawn or fork. [Rust File documentation](https://doc.rust-lang.org/std/fs/struct.File.html), [Rust 1.98 Unix filesystem source](https://raw.githubusercontent.com/rust-lang/rust/1.98.0/library/std/src/sys/fs/unix.rs), [Rust process source](https://raw.githubusercontent.com/rust-lang/rust/1.98.0/library/std/src/sys/process/unix/unix.rs), [Apple flock](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html), [Apple execve](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/execve.2.html).

**[measured]** A disposable fork fixture verified CLOEXEC, paused the child before exec, and showed parent close alone leaves a new lock attempt blocked until child exec; explicit `LOCK_UN` allowed immediate acquisition while the child remained paused. A separate safe std-only Rust fixture confirmed `try_clone` keeps the lock after original drop, and explicit `File::unlock` releases it. Eight threads each used their own lock pathname, with 100 acquire → `/usr/bin/true`.output → release iterations. Close only produced **219/800** transient `WouldBlock` acquisitions, maximum observed wait **457 µs**, elapsed **119 ms**. Explicit unlock produced **0/800**, elapsed **117 ms**. These are one stress sample, not proof of a particular application's failure cause. Source: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-flock-rust-j722s7pe/main.rs`.

**[proposal]** Explicitly unlock the lease in Drop or a release method; cover post-lock early returns with the same guard. Drop should not panic on unlock failure; surface diagnostics. Keep the stable lock file inode, rather than unlinking to release. A bounded 50–100 ms retry of only `WouldBlock` is safe if actual lock success remains required, but is unnecessary for the demonstrated inherited-description case after explicit unlock and may hide genuine overlap. Any retry must use a deadline and nonblocking async waits; other errors fail immediately.

**[limit]** Explicit unlock is correct only after the operation's own workspace writer is quiescent. Tokio defaults to allowing a child to continue when its handle/future is dropped; cancellation of `.output()` is not proof that the child stopped. Keep ownership until confirmed process exit or completed termination/reaping. `kill_on_drop` alone does not supply synchronous confirmed cleanup. [Tokio process documentation](https://docs.rs/tokio/1.53.1/tokio/process/index.html) (also verified in cached `tokio-1.53.1/src/process/mod.rs:199`).

## Avoid duplicate flushing and rejected ACL batching

**[source]** Rust 1.98's Apple `File::sync_all` reaches `fcntl(F_FULLFSYNC)` directly. A second nix `F_FULLFSYNC` after successful `sync_all` duplicates that request; retain ordinary error propagation and parent-directory durability requirements. This is verified against the installed compiler version and its [tagged filesystem source](https://raw.githubusercontent.com/rust-lang/rust/1.98.0/library/std/src/sys/fs/unix.rs).

**[measured, rejected optimization]** Direct `/bin/ls -lde` batches of 32 absolute newline-free paths produced 32 lines/no total for ordinary files, including a directory; one ACL produced 33 lines; a missing path caused nonzero exit/stderr; a newline path produced ambiguous extra lines. In one 256-file sample, 256 per-file processes took 632.929 ms versus 22.755 ms for eight batches. These measurements explain the latency pressure but do **not** rescue the unsafe ACL-absence inference described above. The selected structured exacl gate removes those subprocesses entirely. Fixture: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-acl-batch-ql_eg4t6`.

## Hierarchical workspace exclusion

**[source]** Rust 1.98 exposes safe `File::try_lock_shared` and `File::unlock` (stable since 1.89). Shared locks on each strict canonical ancestor plus an exclusive lock on the workspace root exclude parent/child writers while allowing sibling workspaces. Each lease opens independent descriptors; all acquired locks are explicitly released on failure and drop. Keys use filesystem device/inode identity. [Tagged Rust File API](https://raw.githubusercontent.com/rust-lang/rust/1.98.0/library/std/src/fs.rs).

**[measured]** The research subagent's disposable Rust fixture passed same-root, parent/child, sibling concurrency, and failure-cleanup checks. Production integration tests additionally pass symlink aliases and durable parent/child recovery blockers after the live lease exits. Exact-root-only pending markers were insufficient and were replaced by an overlap scan of structured recovery markers.

**[implementation]** The shared registry is persistent at `$HOME/.brigadier/workspace-locks-v1`, outside temporary storage so reboot cleanup does not erase recovery blockers. Tests explicitly redirect `BRIGADIER_WORKSPACE_LOCK_DIR` to disposable storage; cooperating application processes must share the same registry. It is owner-only, bounded to 100,000 directory entries per acquisition, and lock files are never unlinked while another process might hold their inode. Recovery markers contain the canonical root, root/ancestor identities, and operation UUID, and are flushed before file mutation. Absent/replaced roots retain conservative path overlap blocking; identity-based matching is used only while the recorded root still has its recorded identity. This is cooperative exclusion, not a sandbox against arbitrary external writers or adversarial ancestor renames.
