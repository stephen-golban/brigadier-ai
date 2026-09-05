# Checkpoint integration research — 2026-09-06

The checkpoint-only patch is `/tmp/brigadier-checkpoint-only.patch`: **38 files, +4,285/−58 lines**, reconstructed from the saved imported baseline, not from raw worktree HEAD. Main can take 35 files through ordinary patch application; three require reconciliation. The most effective measured cold-capture optimization is raw blob-only `git fast-import`, keeping the existing private store, two-pass scan, manifest, alternate index, and durable ref publication.

## Exact delta and verification

Source: `/Users/stephen/.codex/worktrees/0d2f/brigadier-ai`, HEAD `1e6d2dd`. Main inspected at `7f96193`. Verified all **94 SHA-256 entries** in `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-checkpoint-baseline-aladm245/manifest.json` against saved bytes. Reconstructed baseline from source HEAD archive plus those 94 overlay files in a disposable `/tmp` repository. Compared all source tracked and nonignored untracked paths, generated a binary-capable Git patch, reset the disposable repository, applied the patch with `git apply --check` then `git apply`, and compared every changed result byte against source: all matched. No source/main file was edited, staged, committed, or reset.

Machine-readable file list: `/tmp/brigadier-checkpoint-delta.json`. Reconstructed verification repository is recorded there. Prefix A means new checkpoint-only path; M means changed from saved application baseline.

- M `Cargo.lock`
- M `crates/core/Cargo.toml`
- A `crates/core/examples/checkpoint_bench.rs`
- A `crates/core/src/checkpoint/git.rs`
- A `crates/core/src/checkpoint/lease.rs`
- A `crates/core/src/checkpoint/mod.rs`
- A `crates/core/src/checkpoint/plan.rs`
- A `crates/core/src/checkpoint/restore.rs`
- A `crates/core/src/checkpoint/scan.rs`
- M `crates/core/src/claude/adapter.rs`
- M `crates/core/src/lib.rs`
- M `crates/core/src/session.rs`
- A `crates/core/tests/checkpoints.rs`
- M `crates/core/tests/claude_adapter.rs`
- A `crates/store/src/checkpoint.rs`
- M `crates/store/src/lib.rs`
- M `crates/store/src/schema.rs`
- M `crates/store/src/writer.rs`
- M `crates/store/tests/schema.rs`
- A `crates/supervisor/src/checkpoints.rs`
- M `crates/supervisor/src/lib.rs`
- M `crates/supervisor/src/loop_/git.rs`
- M `crates/supervisor/src/verify.rs`
- A `docs/research/git-checkpoint-experiments-2026-09-05.json`
- A `docs/research/git-checkpoint-experiments-2026-09-05.py`
- A `docs/research/git-checkpoint-implementation-2026-09-05.md`
- A `docs/research/git-checkpoint-implementation-primitives-2026-09-05.md`
- A `docs/research/git-checkpoint-primary-sources-2026-09-05.md`
- A `docs/research/git-message-checkpoints-2026-09-05.md`
- M `src-tauri/src/conversation.rs`
- M `src-tauri/src/lib.rs`
- M `src-tauri/src/source_control.rs`
- M `src-tauri/src/terminal.rs`
- M `src-tauri/src/workspace.rs`
- M `src/components/EditMessage.tsx`
- M `src/components/RewindHistory.tsx`
- M `src/components/SessionTools.test.tsx`
- M `src/sessionApi.ts`

## Reconciliation and integration risks

`git apply --check /tmp/brigadier-checkpoint-only.patch` against main failed only these paths:

- `crates/store/src/schema.rs`: append migration 9 after existing migration 8; retain main's installed-v8 compatibility documentation and regression. Change assertions expecting the highest schema to 9, but explicitly construct a database stopped at v8 when testing the v8 migration. Never remove/reorder migration 8.
- `crates/store/tests/schema.rs`: reconcile expected current schema 9, retaining main's installed-schema checks.
- `crates/supervisor/src/lib.rs`: retain main lifecycle RwLock, lifecycle read guards around spawn/resume, and deletion's stop-and-drain protection. Add checkpoint coordinator, consume/event observer, checkpoint-aware send and writer leases without restoring the obsolete baseline delete implementation. `src/components/SessionTools.test.tsx` differs from saved baseline but patch application succeeds; inspect resulting tests rather than overwrite it.

The new checkpoint tables deliberately have **no foreign keys** to sessions, and recovery records and epochs survive deletion. `checkpoint_retention()` retains uncategorized epochs and any unresolved operation, so deleted sessions can retain private refs/data indefinitely. This needs explicit integration with the newly approved deletion behavior: stop/drain providers and queued checkpoint jobs, resolve/discard session-owned recovery state as appropriate, purge epochs/rewinds, clear matching durable markers only when the session cannot still mutate files, then prune private refs/objects under the coordinator. Shared-folder deletion must preserve project files. Do not just add CASCADE and leave durable markers blocking the workspace. The persisted marker registry is `~/.brigadier/workspace-locks-v1`, separate from the private object store.

The checkpoint event observer uses detached `tokio::spawn` tasks. Main's deletion currently waits until the provider leaves `live`; that alone is insufficient to prove queued observer tasks finished. Without lifecycle/coordinator synchronization they may write an orphan epoch after deletion (tables have no FK). Similarly `send_turn` launches an owned checkpoint task; deletion must serialize against sends/rewinds as well as spawn/resume. Verify lock ordering to avoid deadlock between lifecycle lock and checkpoint serial mutex.

The coordinator is a single global async mutex, so slow captures currently block other projects' checkpoint sends/finishes too. A 10–17 second capture also holds the provider barrier and workspace lease. Optimize before enabling mandatory capture for every interactive Claude turn. Failed pre-capture currently refuses a send; unsupported source files therefore affect basic chat, not just rewind availability.

Open app terminals own the workspace even while idle. The existing lease implementation rejects ancestor/descendant overlap and uses persistent recovery markers. Test terminal-versus-chat UX, shared folder sessions, workhorse workspaces and deletion together. Dedicated sibling worktrees are compatible with the lock design; children operating inside their parent's workspace conflict by design.

Coverage is intentionally narrower than an arbitrary full-folder backup: symlinks, ACLs, hardlinks, topology transitions, sparse/conflicted indexes and Git state changes can disable combined rewind. `.env` variants, key/certificate files and build/dependency directories are hard-excluded. Preserve existing explicit fallback and coverage messages; don't label all sessions rewindable merely because the module compiled. Source code ownership: `crates/core/src/checkpoint/{scan,lease,restore,plan,git}.rs`, `crates/store/src/checkpoint.rs`, `crates/supervisor/src/checkpoints.rs`.

## Latency findings and measured alternatives

The implementation report recorded 16,555 ms first /13,186 ms unchanged captures for 1,000 tiny files. `scan.rs` calls `hash()` once per first-pass file; the second pass rereads and byte-compares before reusing that OID. `git.rs::hash()` starts one Git process per file, and its generic child helper polls exit at 5 ms intervals while spawning three I/O threads. `blob()` starts two processes per read (size, then contents); restore validation and mutation can both read each blob. Object writes use `core.fsync=all` and `core.fsyncMethod=fsync`.

Disposable local probe, installed **Git 2.50.1 (Apple Git-155)**, 1,000 distinct binary/CRLF/SECRET blobs totaling 357,360 bytes, one sample per mode. OIDs matched independent SHA-1 over Git blob header plus exact bytes, and `cat-file --batch` readbacks matched every raw byte. Hostile attributes (`text eol=lf filter=destructive`) were installed for hash-object modes. These are primitive timings, not full application capture percentiles, and exclude file preparation and metadata scanning.

| Write primitive | Cold new objects | Unchanged repeat |
|---|---:|---:|
| 1,000 individual `hash-object -w --stdin --no-filters`, blocking subprocess wait | 11,553.8 ms | 6,161.4 ms |
| One `hash-object -w --stdin-paths --no-filters`, fsync | 5,759.4 ms | 73.9 ms |
| Same single process, fsyncMethod=batch | 5,760.3 ms | 84.9 ms |
| One raw blob-only `fast-import --quiet --done`, fsync | **29.1 ms** | Not measured |

Batched raw readback of all 1,000 blobs took 70.6–76.4 ms. Script: `/tmp/brigadier-checkpoint-batch-probe.py`; results including fast-import measurement: `/tmp/brigadier-checkpoint-batch-results.json`. Probe workspace is recorded in results. Fast-import verification was an additional inline disposable experiment, not a change to implementation.

## Concrete optimization recommendation

**Preferred:** add `hash_many()` using a single blob-only `fast-import --quiet --done` process, sending already captured bytes with length-delimited `data N` records and numbered marks; request `get-mark :N` for each. Never put source paths or user strings into the command grammar. Require successful process exit and all validated OIDs before publishing the alternate-index tree/ref. Keep `core.fsync=all` and `core.fsyncMethod=fsync`, existing no-remote/private-store/environment isolation, deadlines and concurrently drained pipes. The import emits blobs only, so no source branch or commit operations are involved. Existing raw `hash()` remains suitable for an occasional single-path current-state check. [Git fast-import reference](https://git-scm.com/docs/git-fast-import)

Restructure capture to collect first-pass bytes and metadata, batch write the bytes, install the returned OIDs into the first manifest/transient contents map, then rerun the unchanged second-pass byte and metadata validation. Preserve snapshot/file quotas. Do not create a 512 MiB payload and then clone it again inside the current generic output helper; stream framing/bytes through a bounded writer or pass owned data once. Validate count, OID format, object type and blob length; errors must prevent tree/ref/SQLite publication. Keep temporary unreferenced objects subject to coordinated maintenance.

**Smaller intermediate change:** use `hash-object --stdin-paths --no-filters` over private numeric temporary filenames populated from the captured buffers. This removes per-file child startup and polling while preserving original byte observations. Directly batching mutable workspace paths would introduce a new unchecked observation. The tool accepts newline paths (and Git C quoting); numeric private filenames avoid filename parsing entirely. Filters and EOL normalization are explicitly bypassed by `--no-filters`. [Git hash-object reference](https://git-scm.com/docs/git-hash-object)

Do not expect `fsyncMethod=batch` alone to fix cold writes. Git documents loose-object batching semantics and expected macOS APFS/HFS+ safety, but command participation matters. [Git configuration reference](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsyncMethod) In upstream Git v2.50.1, `hash-object.c` does not call `begin_odb_transaction`; `bulk-checkin.c` falls back to full per-object fsync without an active bulk object directory. This source reading explains the measured absence of speedup; Apple's installed build was exercised directly but its exact downstream source was not inspected. [hash-object v2.50.1 source](https://raw.githubusercontent.com/git/git/v2.50.1/builtin/hash-object.c), [bulk-checkin v2.50.1 source](https://raw.githubusercontent.com/git/git/v2.50.1/bulk-checkin.c)

For restore readback, one `cat-file --batch` process gives `OID type size` header followed by exactly `size` content bytes and a framing newline. Parse by byte count, require `blob`, enforce per-file and aggregate limits before allocation, and omit filters/textconv/follow-symlinks. Passing only validated hex OIDs avoids path ambiguity. Stream per object or bounded groups; current generic 64 MiB total-output cap is smaller than the 512 MiB snapshot cap and cannot simply receive a whole snapshot. [Git cat-file reference](https://git-scm.com/docs/git-cat-file)

Required validation for an implementation: rerun raw-byte, filters, CRLF/binary, stale two-pass capture, staged/manual changes, metadata/ACL refusal, interrupted/failed import, deadline, object count/size bounds, restore conflict and recovery tests; then rerun release full-capture benchmark for cold, unchanged and small-change snapshots. The 29.1 ms primitive timing is not a claim that full application capture takes 29.1 ms. Durability was requested and Git documented behavior checked; no power-loss test was performed.
