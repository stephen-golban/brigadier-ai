# Git message checkpoints — implementation and verification

Date: 2026-09-05. Implemented in the isolated checkout `/Users/stephen/.codex/worktrees/0d2f/brigadier-ai`, against HEAD `1e6d2dd` plus the saved application baseline imported from the concurrent checkout. The concurrent checkout was not edited, staged, committed, or pushed. This document describes implementation and disposable-test evidence, not a paid live-provider or power-loss certification.

## Result

**[implemented]** Interactive Claude messages sent through the supervisor now reserve a message UUID, acquire cooperative workspace ownership, verify provider idleness, capture and durably save the pre-image, and only then dispatch the message. The post-image is captured at a verified idle boundary. Incomplete or unattributed activity makes that epoch unavailable for combined rewind. Initial messages from the project-session UI use the same path. One-shot orchestration startup prompts retain a writer lease for their session lifetime but do not claim interactive message checkpoint coverage.

**[implemented]** Editing an earlier checkpointed human message previews the exact cumulative current-to-target file changes. The confirmed operation restores files, cuts native conversation context, archives the discarded messages, saves a fresh pre-image, and sends the edited draft using its reserved identity. The frontend does not issue a second send. An unchanged draft is allowed. A zero-file-change plan does not need a file-change confirmation. Legacy messages, unsupported coverage, conflicts, and Git-state transitions explicitly disable combined rewind; the separate conversation-only flow requires confirmation that file changes remain.

The approved design and underlying experiments remain in [the design](git-message-checkpoints-2026-09-05.md), [primary-source review](git-checkpoint-primary-sources-2026-09-05.md), [implementation primitives](git-checkpoint-implementation-primitives-2026-09-05.md), and [disposable Git experiments](git-checkpoint-experiments-2026-09-05.py).

## Storage and composition

**[implemented]** `crates/core/src/checkpoint/` owns a private bare Git object store under the app data directory, outside the source workspace. It records raw bytes with filters disabled, builds trees through a fresh alternate index, and retains trees under private refs. Capture does not write the source repository's objects, refs, or index and does not invoke its clean/smudge filters or hooks. Git child environment/config, command deadlines, output bounds, object access, and durability settings are explicit.

Capture scans twice and requires stable bytes, metadata, root identity, and Git state. The second pass reuses the first pass's object identity only after comparing the bytes again; no mtime or cross-capture cache is trusted. Supported regular-file ownership, full mode, and extended attributes are preserved. Restore opens parents with descriptor-relative no-follow operations and replaces entire files atomically. Creation refuses clobbering. Removal is a single guarded unlink, never recursive deletion.

For each path, composition splits continuous message transitions at idle external changes, removes continuous segments whose first and last states match, and reverses remaining segments newest first. A current post-state can be restored to its pre-state; an already-restored pre-state is skipped; divergence is a conflict. This preserves unrelated manual edits and staged state, including a net-zero message segment followed by a manual edit. Every discarded root human UUID needs a complete, valid epoch.

**[implemented]** SQLite schema version 9 stores epochs and a separate transaction journal without cascades that could delete recovery data. Critical operations receive acknowledgments only after FULL synchronous commit; ordinary store batches retain their existing behavior. Private Git object/ref durability is requested before publishing corresponding SQLite records. Filesystem, Git, SQLite, provider context, and message dispatch are separate steps, not one atomic transaction.

**[implemented]** Limits fail explicitly: 10,000 covered entries, 32 MiB per file, 512 MiB per snapshot, 5 GiB private-store quota with prospective snapshot headroom, 250,000 object entries, 64 MiB per child output stream, and 30-second Git command deadlines. Resolved archived epochs and completed/rolled-back operations can expire after 30 days; current messages, unresolved recovery, uncategorized history, and saved unsent drafts remain retained. Maintenance runs at most daily. Active retained data can reach the quota and block further captures; it is not silently discarded.

## Ownership and recovery

**[implemented and tested]** Shared locks on strict ancestors and an exclusive lock on the workspace root exclude identical and nested writers across app processes while allowing sibling workspaces. Device/inode keys cover filesystem aliases. All descriptors are explicitly unlocked after the writer is quiescent. Persistent owner-only recovery markers at `$HOME/.brigadier/workspace-locks-v1` block overlapping roots after process exit or reboot. `BRIGADIER_WORKSPACE_LOCK_DIR` is available for isolated tests; cooperating application processes must use the same registry. The registry scan is bounded at 100,000 entries, and active lock-file inodes are never unlinked as a release mechanism.

Model epochs, restores, source-control mutations, app terminals, orchestration Git mutations, verification commands, and worktree cleanup participate in cooperative ownership. An open terminal owns its root until its shell exits, even while idle. Cancellation of an issued app operation does not release ownership before its child exits or is terminated and reaped. Verification cancellation kills the process group. Arbitrary external editors, commands, daemonized descendants, and hostile parent renames remain outside the attribution contract; this is not a filesystem sandbox.

Every path intent is durably journaled before mutation. The recovery UI retains the draft and exposes supported actions:

| Durable phase | Recovery behavior |
| --- | --- |
| `prepared`, `restoring`, `native-refused` | Reverse only journaled path intents with current-state checks; finish the archive record as refused. Divergence blocks recovery rather than overwriting new work. |
| `native-requested` | Native outcome is unknown. Keep the blocker and draft; do not automatically retry the cut or roll back files. |
| `native-confirmed`, `archived` | With a durable confirmed native boundary, finish local archiving, release the blocker, and retain the draft as `rewound-unsent`. Do not repeat the cut or send. |
| `sending` | Dispatch outcome is unknown. Keep the blocker and draft; do not automatically resend. |
| `complete`, `rolled-back`, `rewound-unsent` | Release a leftover marker only for the matching operation. An unsent draft remains available to copy and send explicitly. |

Unknown native/send outcomes require reconciliation; there is no automatic exactly-once claim across provider failure. Recovery records survive deletion of their source session, though the current recovery UI is reached through session history. No automatic provider-outcome reconciliation is implemented.

## Explicit coverage limits

**[implemented]** macOS is the verified restore platform. Other platforms do not silently claim equivalent metadata support. Combined rewind is unavailable for affected symlinks, ACL-bearing paths, hardlinks, unsupported file flags or special permission bits, special files, missing restore parents, and file/directory topology changes. The implementation does not recreate directory topology or its metadata.

Submodules/gitlinks, sparse or conflicted indexes, active Git operations, nested repositories, non-UTF-8 paths, and changes to HEAD, symbolic branch, semantic index, or ignore policy also disable supported combined rewind. Ordinary non-Git directories are supported when the repository probe proves they are not inside a repository.

Coverage includes tracked and untracked source files subject to exclusions. Ignored files are omitted unless explicitly included by the coverage structure; the UI currently uses the default. `.git`, `.brigadier`, dependency/build/cache directories, `.env`/`.env.*` except `.example`, and `.pem`/`.key` are hard exclusions even when tracked. This is an explicit source-file scope, not a promise to capture every secret or every file on disk. A failed pre-capture currently refuses the send rather than silently creating an uncheckpointed turn.

## Verification

**[measured]** Final regression command:

```sh
BRIGADIER_WORKSPACE_LOCK_DIR=/tmp/brigadier-checkpoints-final-locks \
  cargo test -p brigadier-core -p brigadier-store -p brigadier-supervisor -p brigadier --lib --tests
npm test -- --run
npm run tauri build -- --bundles app
```

- Rust: **573 passed, 0 failed, 7 ignored**, across 26 test binaries. Ignored tests were not enabled; no paid model calls were made.
- Frontend: **292 passed**, across 18 files.
- Ten core filesystem integration tests cover raw/binary/CRLF restoration, preserved index/manual edits/mode/xattrs, excluded files and filters, stale plans, symlink refusal, missing parents, ACL refusal, partial rollback, retention, hierarchical ownership, and durable nested recovery blockers.
- Six supervisor fixture tests cover the successful files/context/archive/pre-image/send ordering, native refusal rollback, unknown native outcome, unknown send without replay, partial journal recovery, and known native archive recovery without another cut/send.
- Additional adapter tests cover reserved message dispatch and invalidation by invisible background activity; verification cancellation checks that descendants stop before workspace ownership becomes available.
- The frontend verifies exact changed-path confirmation, single combined dispatch, and explicit legacy fallback.
- The final macOS app bundle is built at `target/release/bundle/macos/brigadier.app`. It was not installed or launched against owner data.

Logs are `/tmp/brigadier-checkpoints-final-tests.log`, `/tmp/brigadier-checkpoints-ui-tests.log`, and `/tmp/brigadier-checkpoints-bundle.log`. The build retains existing Vite large-chunk/import warnings and the existing bundle-identifier warning.

**[measured]** Disposable release benchmark (`cargo run -p brigadier-core --release --example checkpoint_bench`), one run, generated tiny files:

| Files | Raw bytes | First capture | Unchanged second capture |
| ---: | ---: | ---: | ---: |
| 100 | 33,090 | 1,946 ms | 1,634 ms |
| 1,000 | 331,890 | 16,555 ms | 13,186 ms |

These measurements expose material per-file Git-process/durability overhead; they are not real-project percentiles. There is no end-to-end latency target claim. This version prioritizes durable raw snapshots and conservative ownership; further batching requires separate correctness evidence.

**[not checked]** Paid live Claude rewind/send behavior, interactive owner-database migration, app-window visual interaction, power loss, forced process crashes at every journal boundary, adversarial concurrent filesystem mutation, and non-macOS metadata parity. Fixture recovery tests start from durable intermediate phases; they are not power-cut tests.

## Review and integration

The delivered patch is generated against the saved imported application baseline, not raw `git diff HEAD`, which would include unrelated concurrent work. Baseline manifest: `/var/folders/1g/t85z95812fqc1lstp9cvy9mr0000gn/T/brigadier-checkpoint-baseline-aladm245/manifest.json`. Patch applicability and resulting bytes are checked in a disposable reconstructed baseline repository. Apply only to that matching baseline or reconcile later concurrent edits explicitly. No commit, push, merge, installation, or owner database mutation is part of this delivery.
