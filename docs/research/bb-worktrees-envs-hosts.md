# get-bb/bb — worktrees, environments, hosts

Detailed subagent report, 2026-09-09, feeding `docs/research/bb.md`. Claims are marked as in that file: read in source = measured; everything else asserted. Nobody ran bb.

---
# bb: worktrees, environments, machines, git (read in source unless marked inferred)

## 1. Worktrees — a plugin, not core

Environments are **plugins** implementing an experimental provider contract; core owns durable
launches, retries, cancellation, retirement and teardown (`packages/plugin-sdk/src/environment-provider.ts`).
First-party providers: `plugins/environment-project-checkout`, `plugins/environment-git-worktree`,
`plugins/environment-personal-workspace`.

- **Creation.** `plugins/environment-git-worktree/host/worktree.ts:575` — reuse path
  `["worktree","add",targetPath,branchName]`; fresh path `:601` `["worktree","add","-B",branchName,targetPath,baseBranch]`,
  run under a metadata lock (`runGitWithWorktreeMetadataLock`) plus a ref-mutation lock for the pre-fetch.
- **Disk layout** (`docs/worktrees.md`, `host/paths.ts`):
  `<BB_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<thread-id>/<repo-name>`. `pathKey`
  must be one segment; repo dir name derived from the source path/URL.
- **Base branch.** `host/base-branch.ts`: `{kind:"default"}` or `{kind:"named",name}`. Default resolution
  prefers `origin/<default>` when local default is `equal`/`local-behind`, else the local default branch.
  Before `worktree add` bb fetches the remote base (`fetchRemoteBaseBranch`, `+refs/heads/x:refs/remotes/origin/x`).
  CLI: `bb thread spawn --new-environment worktree [--base-branch <ref>]`; "`main` is local and `origin/main`
  is remote" (`docs/worktrees.md`); `--base-branch` is rejected without `--new-environment worktree`
  (`apps/cli/src/commands/thread/spawn.ts:132`).
- **Branch name.** `apps/server/src/services/threads/thread-create-helpers.ts:31`:
  `` `${branchPrefix}${slug}-${threadId}` `` (or prefix+threadId when there is no title); slug from the
  generated thread title, `sanitizeGeneratedBranchSlug` (`title-generation.ts:86`, lowercase/dash/truncate).
  `branchPrefix` is a user app setting (`packages/domain/src/app-settings.ts`).
- **`.worktreeinclude`** (gitignore syntax, committed at repo root) copies untracked files from the source
  checkout *after* `worktree add`, *before* setup. Copies only, no symlinks, never overwrites tracked files.
- **Setup/teardown.** `.bb-env-setup.sh` / `.bb-env-teardown.sh` at repo root, run by core (not the plugin)
  only when `create` returned `ownsPath: true`; `env bash <script>`, cwd = new workspace, stdin closed,
  15-min timeout each, stdout/stderr into the provisioning transcript. **Env is sanitized: `NODE_ENV` and all
  `BB_*` removed, and bb injects no `BB_PROJECT_ID`/`BB_ENVIRONMENT_ID`/`BB_SOURCE_PATH`**
  (`packages/templates/src/templates/bb-guide-environments.md`). Non-zero setup exit fails provisioning and the
  worktree is removed; teardown failure never blocks removal.
- **Completion/teardown.** Deleting the last thread removes it immediately; archiving starts a 5-minute
  retirement grace (`retireGraceMs`, default 5 min, `plugin-sdk/src/environment-provider.ts:100`), then teardown:
  run teardown script → SIGTERM/SIGKILL every process whose cwd is inside the worktree (agent, dev servers, your
  own shells) → `git worktree remove --force`. **The branch is kept; the worktree is not merged and not archived.**
- **Merging back.** bb never creates PRs. `packages/host-workspace/src/git-host.ts` shells `gh pr view` for the
  current branch and `gh pr ready|merge --merge|--squash|--rebase` for actions; CLI `bb environment pull-request
  show|ready|draft|merge`. Creating the PR/pushing is left to the agent (inferred from absence of `pr create`).
  `plugins/github` only reads issues/PRs via the user's `gh` session, 5-min cache refresh.

## 2. Environment model

Thread-create env args (`apps/cli/src/commands/thread/spawn.ts:114-172`):
`{type:"project-default"}` | `{type:"host",hostId,workspace}` | `{type:"reuse",environmentId}`, where
workspace ∈ `{unmanaged,path}` | `{managed-worktree,baseBranch}` | `{personal}` — matching
`workspaceProvisionType = "unmanaged" | "managed-worktree" | "personal"` (`packages/domain/src/environment.ts`).
Plus `--environment-provider <id> --environment-inputs <json>` for any plugin provider. The tasks plugin's
`presets.environment_kind` only carries `'project-default' | 'new-worktree'` (prior report). No container/cloud-sandbox
provider exists in-repo; "remote" is expressed as `hostId`, not a kind.

Environment row: `id, projectId, hostId, path, isGitRepo, isWorktree, branchName, baseBranch, defaultBranch,
mergeBaseBranch, status(provisioning|ready|error|destroyed), environmentProviderId, lifecycle{phase,retireAt,teardown},
managed, workspaceProvisionType`. cwd = `environment.path` on `environment.hostId`; an agent can move a thread with a
built-in "switch working directory" tool that reuses/creates an environment for the new path and refuses another
project's managed worktree (`apps/server/src/services/threads/thread-environment-directory.ts:35`).

**Two threads can share one environment/worktree — by design** ("a coding thread and a review thread in the same
worktree", bb-guide-environments.md; `tests/integration/fake/multi-thread/shared-environment.test.ts`). Nothing
partitions files; isolation is only of events/transcripts. The only mutex is path *admission* for branch switching:
`workspace_busy` / "Cannot checkout branch while another thread is using this workspace"
(`apps/server/src/services/environments/path-admission.ts`), and project-checkout refuses a switch when the tree is
dirty, mid-merge/rebase, detached or unborn (`plugins/environment-project-checkout/host/checkout.ts:111`).

## 3. Machines / hosts

A "machine" is a **host daemon** (`apps/host-daemon`) that runs thread environments; internal type is `Host`.
It dials **out** to the server over an authenticated, reconnecting WebSocket (`src/server-connection.ts`), so remote
machines need a reachable server (bb connect route or Tailscale Serve). Enrollment via `bb machine join-code` +
`install-machine.sh`; launchd/systemd unit with `--auto-update` (protocol-mismatch self-update, 5 s→5 min backoff).
Per-machine **permission limit** caps any thread's permission mode (default Full Access, UI-only setting).
Placement: `--machine <id-or-name>` on `bb thread spawn` (invalid with `--environment`, since a reused environment
already fixes its machine); project sources are per-machine paths.

**Wire content** (`packages/host-daemon-contract/src/commands.ts`, 2 123 lines of zod): thread.start/turn.submit/stop,
host.read_file/write_file/list_paths (base64|utf8 + sha256), project.inspect/clone, environment.hook.run/cancel,
plugin.host.call, provider.usage, workspace.status/diff/diffFiles/diffPatch/commit/pull_request(+action). So file
contents, diffs and prompts all cross the socket. `bb connect` is a Cloudflare Worker tunnel (`apps/connect`,
`packages/tunnel-client`): the **server** holds the tunnel, exposing `https://<handle>.getbb.app`, session-gated to the
owner's getbb.app account; `bb connect expose <port>` publishes a dev server at `<label>--<port>.getbb.app`.

## 4. Git awareness

Per-environment (not per-thread) diff panel with targets `uncommitted | branch_committed | all | commit`
(`packages/domain/src/thread-git-diff.ts`), merge base = `mergeBaseBranch ?? baseBranch ?? defaultBranch`.
UI: `apps/app/src/components/secondary-panel/git-diff/*`; CLI mirrors it (`bb environment diff|diff-files|diff-file|
diff-patch|status|branches`). **Commit is a button/CLI action with an LLM-written message**:
`apps/server/src/routes/environments.ts:40,671` — `generateCommitMessage(...)`, fallback `"bb: automated commit"`,
refuses when `!workspaceStatus.workingTree.hasUncommittedChanges`. No auto-commit on turn end was found (inferred).
Dirty-tree detection exists for branch switching, not for worktree spawn (a dirty source checkout surfaces as the raw
`git worktree add` error in the transcript, `docs/worktrees.md`).

## 5. Performance of this layer

- Server-side read cache `EnvironmentReadCache` with in-flight dedupe: status TTL **3 s**, pull-request TTL **10 s**
  (`apps/server/src/services/environments/workspace-read-cache.ts:113-139`); invalidated by daemon change events,
  ignoring `metadata-changed`/`thread-storage-changed`.
- FS watching via **@parcel/watcher in a forked subprocess** (`packages/host-watcher/src/parcel-subprocess/*`).
  `workspace-status-watcher.ts:24-36`: debounce **75 ms**, max wait **500 ms**, retry 250 ms→30 s, ignores `.git`,
  `**/node_modules/**`, and every directory `git status --ignored=matching` reports (5 s timeout).
- Fingerprints (`lastLocalFingerprint`, `lastSharedRefsFingerprint`) in `apps/host-daemon/src/watch-manager.ts`
  suppress no-op change pushes; the client re-debounces with `createBufferedEnvironmentInvalidator`
  (debounceMs/maxWaitMs) before invalidating queries.

## Not verified
- `generateCommitMessage` implementation (model, prompt) not read; no auto-commit search beyond routes.
- No `gh pr create` found, but code search was rate-limited mid-sweep — "agent creates the PR" is inferred.
- `apps/server/src/services/threads/thread-environment-placement.ts` (626 lines) only grepped; exact machine
  fallback rules not fully read.
- `worktree-include.ts`, `environment-hooks.ts`, `apps/connect/*` worker internals, mobile pairing crypto not read.
- Nothing run; all behavior is from source and shipped docs.
