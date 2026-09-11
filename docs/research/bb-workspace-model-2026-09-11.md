# get-bb/bb — the workspace model, measured against brigadier's lock

2026-09-11. Analysis only. Nothing here is a port: no code, no UI, no dependency. The question is what
model lets bb avoid a whole class of failure that brigadier keeps hitting.

## 0. Read only, or read and ran?

**Read and ran.** This is the first time anyone on this project has executed bb. Exactly what was run,
all of it inside `scratchpad/bb/bb-clone`, nothing installed system-wide, no real repository touched:

| # | command | result |
|---|---|---|
| 1 | `git clone --depth 1 https://github.com/get-bb/bb.git` | root SHA **`fa1f44ebe9e5676004b669e48c99b3c7606466b6`**, 100 MB. Every `path:line` below is that SHA. |
| 2 | `pnpm install` filtered to `bb-plugin-environment-git-worktree...`, `bb-plugin-environment-project-checkout...`, `@bb/integration-tests...`, `@bb/app...`, `./plugins/*...`, `./tests/**...` | local to the clone; pnpm's content-addressed store at `~/Library/pnpm/store` was written as a cache (the only write outside the clone). |
| 3 | `node scripts/ensure-native-modules.mjs`; `pnpm run prepare`; `pnpm --filter @get-bb/plugin-sdk run build` | bb's own generators; downloads a prebuilt `better-sqlite3` for Node 24. |
| 4 | `vitest run` in `plugins/environment-git-worktree` | **36 passed / 4 files**, 2.90 s. bb's worktree unit suite against real `git`. |
| 5 | `vitest run tests/integration fake/multi-thread/shared-environment` | **3 passed**, 23.25 s. A real bb server + host daemon + SQLite + fake provider, on a throwaway git repo in `$TMPDIR`. |
| 6 | my own probe, `tests/integration/fake/probe/bb-workspace-probe.test.ts` (written by me, in the clone) | **3 passed**, 55.78 s. Output at `scratchpad/bb/probe2.log`. This is where every **[measured]** below comes from. |

What was **not** run: the Electron desktop shell, the web app UI, the mobile client, any real provider
(Claude/Codex/Cursor), `bb connect`, and multi-machine hosts. Everything observed went through bb's
HTTP API and its real host daemon with a scripted fake provider.

Marking, as in `docs/research/bb.md`: **[measured]** = I ran it and read the output. **[read]** = I read
the code at the cited `path:line` at SHA `fa1f44e`. **[asserted]** = bb's docs or README, not verified.

---

## 1. Bottom line, in six lines

1. bb's unit of isolation is the **environment**, and an environment is a *place*, not a session. Threads
   attach to it; several may attach at once; it outlives all of them by a grace period. **[measured]**
2. For a fresh worktree, collisions are impossible **by construction**: the path key and the branch name
   both contain the thread id, so two tasks can never aim at the same name. No lock is involved. **[measured]**
3. For the user's own checkout, bb takes **no lock to attach** and a lock **only to mutate** — the exact
   asymmetry brigadier does not have. **[read]** `plugins/environment-project-checkout/host/checkout.ts:245-276`
4. Every lock bb does hold **queues** rather than refuses, and the one durable filesystem lock **breaks
   itself after 10 minutes**. **[read]** `packages/environment-provider-host/src/locks.ts:114-212,213-253`
5. Recovery is a **retry onto a new path** (`pathKeys: "per-attempt"`), never a durable blocker on the old
   one. A half-finished attempt cannot block the next one, because the next one does not want its name. **[read]**
6. brigadier's failure is none of those things: at "Work locally" it takes its **strongest, restore-grade,
   non-blocking** lease before doing **zero** work, and an open terminal holds a lock that lease needs.

---

## 2. The seven questions

### 2.1 What is bb's unit of isolation? When is a worktree made, where, and when removed?

The unit is an **environment row** (`environments` table), owned by a project and a host, with
`path`, `branchName`, `baseBranch`, `status`, `managed`, `isWorktree`, `attempt`, `claimPath`,
`ownerThreadId`, `lifecycle{phase,retireAt,teardown}`. **[read]** `packages/db/src/schema.ts:485,501`,
**[measured]** every one of those fields came back from the API in my probe.

It is **not** per task and **not** per branch. bb's own doctrine, shipped to the agent verbatim:
"Environment — where a thread runs. Kinds: project checkout or isolated worktree. **Multiple threads can
share an environment.**" **[read]** `packages/templates/src/generated/templates.generated.ts:82`

Three first-party providers, each a plugin behind one experimental contract
(`packages/plugin-sdk/src/environment-provider.ts:100-102`): `environment-project-checkout` (attach the
user's own directory), `environment-git-worktree` (make a new one), `environment-personal-workspace`.
Core owns launch, retry, cancel, retire, teardown; the plugin owns only create/remove. **[read]**

**When a worktree is created:** only when the thread asks for one — app picker "Worktree", or
`bb thread spawn --new-environment worktree`. **[read]** `apps/cli/src/commands/thread/spawn.ts:114-172`.
The default with no flags is `{type:"unmanaged", path:null}` — the project's own checkout. **[read]** `:152-163`

**Where:** `<BB_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<pathKey>/<repo-name>`,
`pathKey = "<threadId>-<attempt>"`. **[measured]**

```
.../daemon-data/plugins/environment-git-worktree/host-data/worktrees/thr_j6qnfzkwhz-1/test-project
.../daemon-data/plugins/environment-git-worktree/host-data/worktrees/thr_x4d8aeusws-1/test-project
```

The command is `git worktree add -B <branch> <targetPath> <baseBranch>` (or `add <targetPath> <branch>`
when reusing an existing branch), after fetching the remote base. **[read]**
`plugins/environment-git-worktree/host/worktree.ts:573-606,617`

**When it is removed:** *not* when the last thread is deleted. bb's own docs say deleting removes it "right
away" — **that is wrong for the shipped code.** **[measured]** Deleting the only thread on a worktree put
the environment into `lifecycle.phase:"retiring"` with a `retireAt` timestamp, and **37 s later the
directory, the `git worktree list` entry and the branch were all still there**:

```
C after ~2000ms  : pathExists=true env={"status":"ready","lifecycle":{"phase":"retiring","retireAt":...}}
C after ~37000ms : pathExists=true env={"status":"ready","lifecycle":{"phase":"retiring","retireAt":...}}
```

The grace is the provider's `retireGraceMs`, defaulting to **300 000 ms** — five minutes — for the worktree
plugin. **[read]** `packages/plugin-sdk/src/internal/host-policy.ts:2417`. Project-checkout sets
`retireGraceMs: null`, i.e. it never retires: it is your directory, there is nothing to remove. **[read]**
`plugins/environment-project-checkout/server.ts:147`

Removal order, when the grace elapses: `.bb-env-teardown.sh` (15-min timeout, **[read]**
`apps/server/src/services/environments/environment-hooks.ts:6`) → SIGTERM/SIGKILL **every process whose cwd
is inside the worktree**, including your own shells (**[read]** `worktree.ts:681`,
`experimental_killProcessesWithCwdUnder`) → `git worktree remove --force` (**[read]** `worktree.ts:700-710`).
**The branch is kept, not merged, not deleted.** **[measured]** — both probe branches survived every removal
path I exercised.

### 2.2 How does it stop two things writing the same tree? Does it lock at all?

**For a fresh worktree: it does not lock, because it cannot collide.** I created two threads with the
*same title* against the same project and the same default base branch. Both succeeded; nothing waited;
nothing was refused. **[measured]**

```
A.env branch = bb/alpha-task-thr_j6qnfzkwhz   path = .../worktrees/thr_j6qnfzkwhz-1/test-project
B.env branch = bb/alpha-task-thr_x4d8aeusws   path = .../worktrees/thr_x4d8aeusws-1/test-project
```

The thread id is in *both* names — branch `${branchPrefix}${slug}-${threadId}` (**[read]**
`apps/server/src/services/threads/thread-create-helpers.ts:37`) and path key `${threadId}-${attempt}`
(**[read]** `apps/server/src/services/threads/thread-environment-placement.ts:757-762`). Two tasks cannot
aim at the same tree, so there is nothing to serialise.

**For a shared tree: it locks almost nothing, and what it does lock, queues.** bb has exactly four
mechanisms, and it is worth being precise about how weak each one is:

| mechanism | shape | on conflict | durable? |
|---|---|---|---|
| `withProcessLocalQueuedLocks` | in-memory `Map<string, Promise<void>>` per key, inside one process | **queues**; 5-min timeout | no |
| `withGitRefMutationLock` | `mkdir <commonDir>/bb-ref-mutation.lock` + process-local queue | polls every **100 ms**, waits up to **5 min**, and **force-removes a lock dir older than 10 min** | yes, but self-healing |
| `withWorktreeMetadataLock` | process-local queue keyed on the resolved git common dir | **queues** | no |
| `environments.claimPath` | a DB column, unique per (host, path) among non-destroyed rows | 409 with a named reason | yes, cleared on destroy |

**[read]** `packages/environment-provider-host/src/locks.ts:13,34-35,114-212,213-253,258-296`;
`packages/db/src/data/environments.ts:585-601`

Three properties of that table matter more than its contents. First, **the default answer to contention is
to wait, not to fail** — `runInProcessQueue` chains onto the previous promise. Second, **the only lock
that survives a crash removes itself** after `GIT_REF_FS_LOCK_STALE_MS = 10 * 60_000`. Third, **the durable
claim is a database row a human can see in the UI**, not an opaque file in a dotfolder.

`claimPath` is taken by exactly one caller: the project-checkout provider, at create.
**[read]** `plugins/environment-project-checkout/server.ts:186`. The worktree provider never claims a
path at all — it doesn't need one.

**What genuinely prevents two agents interleaving writes in a shared tree: nothing.** This is deliberate.
I ran bb's own `shared-environment` integration test: two threads in one unmanaged checkout, both sent a
delayed turn at the same instant, both went `active` concurrently, both completed. **[measured]** The only
isolation asserted is that their *events* do not cross-contaminate. **[read]**
`tests/integration/fake/multi-thread/shared-environment.test.ts:60-112`

### 2.3 What happens at "work locally, on the current branch" — the mode that failed here?

bb offers it, and it is the **default**. bb's picker even uses brigadier's exact label: the trigger reads
`` `Current (${state.currentBranch})` `` — `Current (main)`. **[read]**
`plugins/environment-project-checkout/app.tsx:180-184`. That label maps to `CheckoutIntent = "current"`,
which sends `branch: null`. **[read]** `:186-192`

And `branch: null` is the whole answer:

```ts
// plugins/environment-project-checkout/host/checkout.ts:245-276  (@fa1f44e)
export async function attachCheckout(args: AttachCheckoutArgs): Promise<AttachedCheckout> {
  throwIfProvisionAborted(args.signal);
  if (!(await pathExists(args.path))) { throw new WorkspaceError("path_not_found", …); }
  const isGitRepo = await detectGitRepo(args.path, options);
  if (args.branch !== null) {                       // ← the ONLY gate
    if (!isGitRepo) { throw new WorkspaceError("not_git_repo", …); }
    await switchBranch({ ...args, branch: args.branch });
  }
  if (!isGitRepo) { return { path: args.path, branchName: null }; }
  const ref = await getCheckoutRef(args.path, options);
  return { path: args.path, branchName: … };
}
```

**Work locally on the current branch takes no lock, performs no git mutation, and reads one ref.**
`tryWithCheckoutMutationLock` lives inside `switchBranch` (`:142`), and every refusal —
`checkout_dirty`, `checkout_detached`, `checkout_unborn`, `checkout_in_progress_operation` — lives inside
`assertSwitchable` (`:56-116`), which `switchBranch` alone calls. A dirty tree does not block attaching.
A rebase in progress does not block attaching. A detached HEAD does not block attaching.

Measured, end to end, against a live bb server: a **second** thread targeting the same local checkout with
no branch was **accepted and silently joined the first thread's environment**. **[measured]**

```
first.env  id=env_7mzbesd3vp path=.../repos/test-project branch=main managed=false isWorktree=false
second     -> created status=idle envId=env_7mzbesd3vp sameEnvAsFirst=true
```

That dedupe is `bindEnvironmentPath` (**[read]** `packages/db/src/data/environments.ts:604-614`): the
provisional row is discarded and the existing environment adopted, in one immediate transaction.

A **third** thread asking for the same path *with a branch switch* while the first was live was refused —
with a named code and a sentence that says what is wrong and who is holding it. **[measured]**

```
409 {"code":"environment_provider_rejected",
     "message":"Cannot checkout branch while another thread is using this workspace",
     "details":{"environmentProviderId":"project-checkout"}}
```

**[read]** `apps/server/src/services/environments/path-admission.ts:5,25`;
`plugins/environment-project-checkout/server.ts:20-21,150-206`

### 2.4 How does a terminal relate to a task's workspace?

A bb terminal is "a persistent PTY session scoped to a thread, environment, or machine path". **[read]**
`packages/templates/src/generated/templates.generated.ts:82`. In code, a terminal target is either an
`environmentId` (cwd = that environment's path) or a bare `cwd` with `environmentId: null`. **[read]**
`apps/host-daemon/src/terminals/terminal-manager.ts:681-693`

When it is bound to an environment it calls `runtimeManager.markTerminalActive(environmentId, terminalId)`
(**[read]** `terminal-manager.ts:614-616`), and that does exactly one thing:

```ts
// apps/host-daemon/src/runtime-manager.ts:433-439  (@fa1f44e)
markTerminalActive(environmentId, terminalId)   { this.entries.get(environmentId)?.terminals.add(terminalId); }
markTerminalInactive(environmentId, terminalId) { this.entries.get(environmentId)?.terminals.delete(terminalId); }
```

The set is read in one place — `entryHasActiveRuntimeWork`, `:604-609` — which decides whether the
*provider process* may be reaped for idleness. **A terminal is a keep-alive pin, not a lock.** It cannot
block a turn, a checkout, a provisioning or a removal. It is not registered against any path, only against
an environment id.

Can a shell and an agent share a tree? Yes, and **nothing prevents interleaved writes.** The only place a
terminal and the workspace lifecycle meet is destructive and runs the other way: on teardown bb kills every
process whose cwd is under the worktree — the user's own shells included — and its docs say so plainly:
"move your own shells out of the worktree first if you want to keep them". **[asserted]** `docs/worktrees.md`;
**[read]** `worktree.ts:681`. Separately, `closeEnvironmentTerminals` closes the terminals of an environment
that is going away. **[read]** `terminal-manager.ts:509-522`

### 2.5 Crash, half-finished operation, resume. Can recovery block a new run?

There is a recovery concept and it is **a state machine over database rows**, resumed by a periodic sweep:
"An environment row exists before its provider creates the workspace… `environment-engine.ts` owns that
walk, cancellation, cleanup, and retirement, using one operation registry. **The periodic sweep resumes the
same walk after a restart.**" **[asserted]** `docs/environment-provisioning.md`; the sweep is real —
`sweepProviderLifecycles` is a registered periodic job, **[read]**
`apps/server/src/services/system/periodic-sweeps.ts:477-482`, `environment-engine.ts:832-845`.

The mechanism that makes this class of bug small is one line of policy:

```ts
// plugins/environment-git-worktree/server.ts:44
policy: { pathKeys: "per-attempt" },
```

which drives, in placement:

```ts
// apps/server/src/services/threads/thread-environment-placement.ts:757-762
const attempt = (row?.attempt ?? previous?.attempt ?? 0) + 1;
const pathKey = policy.pathKeys === "per-attempt" || context.environment !== null
  ? `${context.thread.id}-${attempt}` : context.thread.id;
```

**A failed or half-finished attempt does not have to be cleaned up before the retry, because the retry
wants a different name.** There is no such thing as a stale blocker on the path the next run needs.

And where debris *is* in the way, the next attempt clears it rather than reporting it: if the branch is
still checked out in a worktree **under bb's own worktrees root**, bb force-removes it — unless it is
dirty, in which case the error names the path and the remedy in one sentence: "Branch X is still checked
out at <path> by an earlier attempt, and that worktree has uncommitted changes, so it was left alone.
Remove it to retry." **[read]** `plugins/environment-git-worktree/host/worktree.ts:155-205`. Note the
`isPathInside(ownWorktreesRoot, holder)` guard at `:167`: bb never force-removes a worktree it did not make.

**Can recovery block a new run?** Only in one narrowly-scoped case, and only for the same path: a
project-checkout environment whose cleanup failed keeps its `claimPath` until removal succeeds
(**[asserted]** `docs/environment-provisioning.md`, consistent with `environments.ts:595-601`), and a
removal that fails is retried every `REMOVE_RETRY_MS = 60_000` (**[read]** `environment-engine.ts:309,688,707`).
It cannot block a *different* path, it cannot block a worktree run, it is a visible row rather than a file,
and it retries itself out of existence. Nothing in bb survives a reboot as a blocker.

### 2.6 What does the user choose, and what is inferred?

**Chosen:** the provider (project checkout / worktree / personal), and, within it, an intent —
`current` | `checkout <branch>` | `new branch from <base>`. For a worktree the user may name a base branch;
`--base-branch` without `--new-environment worktree` is a hard error. **[read]** `spawn.ts:130-133`.
Notably the CLI offers **no branch option at all for the local checkout** — from the shell you can work
locally, but only where you already are. **[read]** `spawn.ts:152-172`

**Inferred:** the branch name (`${prefix}${slugified-generated-title}-${threadId}`, prefix a user setting)
**[read]** `thread-create-helpers.ts:37`, `thread-environment-placement.ts:550`; the base branch when not
named, preferring `origin/<default>` when the local default is equal-or-behind; the worktree path; the
attempt number; the machine; and whether an existing environment at that path should be adopted instead of
a new one created (**[measured]**, §2.3).

### 2.7 What stops the lock registry or the worktree pool growing forever?

- Worktrees are removed when the last thread stops using the environment, after the grace. **[read]**
  `environment-engine.ts:769-812`; **[measured]** the retiring phase and `retireAt`.
- A failed removal retries on a 60 s deadline rather than leaking or blocking. **[read]** `:688,707`
- Leftovers from an earlier attempt are force-removed by the next attempt. **[read]** `worktree.ts:155-205`
- **There is no lock registry to grow.** Process-local locks die with the process. The one filesystem lock
  is a single `mkdir` inside the repo's own `.git` common dir, removed in a `finally`, and force-removed by
  anyone who finds it older than 10 minutes. **[read]** `locks.ts:230-232,240-244,275-281`
- The `claimPath` is a column on a row that is already garbage-collected with the environment.

What **does** grow without bound: **branches**. Every managed worktree leaves its branch behind, and I
measured that: after deleting a thread and archiving another, `bb/alpha-task-thr_…` and
`bb/teardown-task-thr_…` were still in `git branch -a`. **[measured]** bb's docs frame this as a feature
("work you committed to it survives the worktree") **[asserted]**, and nothing in this brief contradicts
it — but at one branch per task it is unbounded, and there is no reaper for it in the code I read.

---

## 3. Confirming or correcting `docs/research/bb.md` and `bb-worktrees-envs-hosts.md`

Both files were written by subagents reading GitHub code search, and both say plainly that nobody ran bb.
They hold up well. Fourteen claims checked; ten held exactly, three need a correction, one is confirmed but
understated.

| # | prior claim | verdict |
|---|---|---|
| 1 | Environments are plugins against an experimental contract; core owns launch/retry/cancel/retire/teardown; first-party are project-checkout, git-worktree, personal-workspace | **Holds.** **[read]** `packages/plugin-sdk/src/environment-provider.ts:100-102`; three plugin dirs present. |
| 2 | Creation is `["worktree","add","-B",branchName,targetPath,baseBranch]` at `worktree.ts:601`, reuse path at `:575`, under a metadata lock plus a ref-mutation lock for the pre-fetch | **Holds, with the line drifted.** At `fa1f44e` the fresh path is built at `:597-606` and run at `:617`; the reuse path is still exactly `:575`. **[read]** |
| 3 | Layout `…/host-data/worktrees/<thread-id>/<repo-name>` | **Correction.** The path key is `<thread-id>-<attempt>`, not `<thread-id>`, because the worktree plugin declares `pathKeys: "per-attempt"`. **[measured]** `…/worktrees/thr_j6qnfzkwhz-1/test-project`; **[read]** `server.ts:44`, `thread-environment-placement.ts:757-762`. bb's own `docs/worktrees.md` carries the same stale simplification, which is presumably where the prior report got it. The difference is not cosmetic — it is the whole recovery story (§2.5). |
| 4 | Naming `` `${branchPrefix}${slug}-${threadId}` ``, slug from the generated title | **Holds.** **[measured]** title "alpha task" → `bb/alpha-task-thr_j6qnfzkwhz`; **[read]** `thread-create-helpers.ts:37`. Default prefix is `bb/`. |
| 5 | `--base-branch` is rejected without `--new-environment worktree` at `spawn.ts:132` | **Holds**, now at `:130-133`. **[read]** |
| 6 | Hooks `.bb-env-setup.sh` / `.bb-env-teardown.sh`, run by core only when `create` returned `ownsPath: true`, 15-min timeout each | **Holds.** **[read]** `environment-hooks.ts:6` (`15 * 60 * 1000`), `environment-lifecycle-script.ts:21`; **[asserted]** the `ownsPath` policy, from `docs/worktrees.md`. Consistent with project-checkout returning `ownsPath: false` at `server.ts:235`. **[read]** |
| 7 | Retirement: deleting the last thread removes it at once; archiving starts a 5-minute grace | **Correction.** **[measured]** `deleteThread` also went to `lifecycle.phase:"retiring"` with a `retireAt`, and the worktree, its git entry and its branch were all still present 37 s later. Archiving behaved the same way. The 5-minute figure is right (`retireGraceMs` default `300_000`, **[read]** `host-policy.ts:2417`); the "at once" is not. Caveat: I did not wait out a full grace period, so I have not *seen* a removal complete — only that it had not happened at t+37 s. |
| 8 | Teardown → SIGTERM/SIGKILL every process whose cwd is inside the worktree → `git worktree remove --force`; the branch is kept | **Holds** at read level. **[read]** `worktree.ts:681` (`experimental_killProcessesWithCwdUnder`), `:700-710` (`remove --force`); **[measured]** for the branch — it survived. |
| 9 | Two threads can share one worktree by design; nothing partitions files; only events and transcripts are isolated | **Holds, and understated.** **[measured]** I ran bb's `shared-environment.test.ts`: two threads in one checkout go `active` **concurrently** and both complete a turn. And sharing is not only opt-in via explicit `reuse` — **[measured]** a second thread that merely names the same local path is silently folded into the first thread's environment (§2.3). |
| 10 | The one mutex is path admission for branch switching: `workspace_busy`, "Cannot checkout branch while another thread is using this workspace" | **Holds, and now measured live.** **[measured]** 409 `environment_provider_rejected` with that exact sentence, refused at create. **[read]** `path-admission.ts:5,25`; the provider's own copy at `project-checkout/server.ts:20-21`. |
| 11 | project-checkout refuses a switch when the tree is dirty, mid-merge/rebase, detached or unborn (`checkout.ts:111`) | **Holds**, now `assertSwitchable` at `:56-116`. **Important qualifier the prior report does not draw out:** every one of those refusals is inside the *switch* path, so none of them fires when the user works locally on the current branch. **[read]** |
| 12 | Environment row carries `status(provisioning\|ready\|error\|destroyed)`, `lifecycle{phase,retireAt,teardown}`, `managed`, `workspaceProvisionType` | **Holds.** **[measured]** every one of those came back over the API. **[read]** `schema.ts:485,501`. The prior report omits `claimPath` and `attempt`, which are the two fields that matter most for this question. |
| 13 | bb never creates a PR; `gh pr view` / `gh pr ready\|merge` only — marked *asserted* because the search was rate-limited | **Not re-checked.** Out of scope here; still asserted. |
| 14 | `thread-environment-placement.ts` (626 lines) grepped only; machine fallback rules unknown | **Still partly true.** I read its path-key and branch-prefix sections (`:550,757-775`); machine fallback remains unread. |

Two things neither prior file contains, and both are load-bearing:

- **The shape of bb's locks.** `packages/environment-provider-host/src/locks.ts` appears in neither
  document. It is the file that decides bb queues instead of refusing, and self-heals after 10 minutes.
- **`attachCheckout` taking no lock at all when `branch === null`.** Both documents describe the *switch*
  mutex and stop there, which leaves the impression that bb guards a local checkout. It does not.

---

## 4. What failed here, and where

Reproduced at read level only; I did not re-run the app (other workers are building in this worktree).

**Every brigadier `path:line` in this section and in §5 is pinned to commit `462c6bf`**, which was HEAD when
this worktree was read. `crates/core/src/checkpoint/lease.rs` is being rewritten by a concurrent worker in
this same worktree — `git diff --stat` shows +334/−71 against `462c6bf` as of this writing — so its current
line numbers will not match. Use `git show 462c6bf:<path>` to follow any citation below.
`composer_workspaces.rs`, `commands.rs` and `crates/core/tests/checkpoints.rs` were unmodified when read.

The owner chose **Work locally** + **Current (main)** on `/Users/stephen/Development/brigadier-ai` with a
brigadier **terminal** open on that same directory, and setup failed with:

> Workspace overlaps another running turn, terminal, or restore operation: lock acquisition failed because
> the operation would block

That string is produced in exactly one place, `crates/core/src/checkpoint/lease.rs:123`, and the `{e}` half
is `std::fs::File::try_lock`'s `WouldBlock` — a **non-blocking** attempt that fails instantly rather than
waiting. The chain:

1. `isolated == Some(false)` — "Work locally" — is the only branch that calls `prepare_checkout`.
   `src-tauri/src/commands.rs:526-534`
2. `prepare_checkout` unconditionally takes `WorkspaceLease::acquire(&path)` — `Mode::Exclusive`, the
   restore-grade lease — before it does anything.
   `src-tauri/src/composer_workspaces.rs:188-190`
3. It then calls `checkout(&path, base, new_branch)`, and with "Current (main)" both are `None`, so the very
   first statement returns: **not one git write happens under that lease.**
   `src-tauri/src/composer_workspaces.rs:202-204`
4. `Mode::Exclusive` takes `terminal-root-{key}` **shared** at every ancestor; `Mode::Terminal` holds
   `terminal-root-{key}` **exclusive** at its own root. They conflict by construction.
   `crates/core/src/checkpoint/lease.rs:130-142`
5. brigadier's own test suite asserts precisely this pair — with a terminal held at `root`,
   `WorkspaceLease::writer(&root).is_ok()` but `WorkspaceLease::acquire(&root).is_err()`.
   `crates/core/tests/checkpoints.rs:446-452`

So the mechanism did what it was written to do. The defect is that the **strength of the lease was chosen
by the code path rather than by the work**, and the work was nothing.

Two aggravating properties of the same file, both by design and both worth naming because they are the
second half of the owner's experience:

- The message names three possible holders ("another running turn, terminal, or restore operation") and
  identifies none of them, no path, no session, no pid — even though the lease knows the directory it
  failed on and the registry knows every file name. `lease.rs:123`
- A `.recovery` marker is deliberately durable: it survives reboot and temp cleanup, it blocks any
  overlapping root forever with "Workspace requires recovery {uuid}", and only an exact
  `WorkspaceLease::recover(root, same-uuid)` clears it. `lease.rs:72-74,148-184,200-245`. That is the
  opposite end of the spectrum from bb's 10-minute self-breaking `mkdir` lock.

The owner also reports the resulting session got stuck and could not be archived. **Not verified** — I did
not reproduce it, and `prepare_checkout` errors before `start_project_session_selected`, so the row it got
stuck on is not identified here.

---

## 5. Structural differences that matter

Each line: the difference, then the principle, then the bb evidence. No patches, no code.

1. **brigadier picks lock strength by code path; bb picks it by mutation.** brigadier's "Work locally" takes
   its most exclusive lease and then performs no git write at all
   (`composer_workspaces.rs:188-190`, `:202-204`), where bb's `attachCheckout` locks only inside
   `switchBranch` and returns after one `getCheckoutRef` when `branch === null`
   (`checkout.ts:245-276`, `:142`). **Principle: an operation that mutates nothing must acquire nothing.**
   This one difference is sufficient to cause the reported failure on its own.

2. **brigadier's terminal gate is symmetric; bb's is absent.** brigadier deliberately makes a shell and a
   destructive operation exclude each other in both directions (`lease.rs:130-142`, asserted at
   `checkpoints.rs:446-464`), and then routes an ordinary local session start through the destructive side.
   bb's terminal is a keep-alive pin on a runtime and holds no lock on any path
   (`runtime-manager.ts:433-439`, `:604-609`). **Principle: a shell may be a reason to refuse destruction,
   and must never be a reason to refuse attachment.** Second cause of the reported failure.

3. **brigadier refuses; bb waits.** `try_lock` is non-blocking and turns any overlap into an immediate
   error (`lease.rs:118-123`), while bb's contention primitive chains onto the previous holder's promise
   with a five-minute ceiling (`locks.ts:114-212`). **Principle: contention that will clear on its own is a
   queue, not an error; only contention that cannot clear is an error.**

4. **brigadier's durable blocker is permanent; bb's is self-healing.** A `.recovery` marker blocks every
   overlapping root until an exact-uuid recovery clears it, explicitly across reboots
   (`lease.rs:72-74,168-183`); bb's only durable lock is force-removed by anyone who finds it older than ten
   minutes (`locks.ts:214,240-244`). **Principle: any durable blocker must carry its own expiry, or it is a
   permanent outage waiting for a crash.**

5. **brigadier's error names a mechanism; bb's names a holder and a remedy.** `lease.rs:123` reports three
   candidate causes and no identity; bb answers 409 `workspace_busy` / "Cannot checkout branch while another
   thread is using this workspace" (`path-admission.ts:5,25`, **[measured]** in the wire response) and, for
   a stale worktree, "Branch X is still checked out at <path> by an earlier attempt… Remove it to retry"
   (`worktree.ts:176-180`). **Principle: a refusal must name who holds it and what the user can do, because
   a refusal the user cannot act on is an outage.**

6. **brigadier recovers onto the blocked path; bb retries onto a new one.** brigadier's recovery identity is
   the root plus the operation uuid, so the retry needs exactly the resource the failure poisoned
   (`lease.rs:37-39,173-177`); bb's worktree provider declares `pathKeys: "per-attempt"` so attempt *n+1*
   never wants attempt *n*'s name (`server.ts:44`, `thread-environment-placement.ts:757-762`, **[measured]**
   `thr_…-1`). **Principle: a retry should not depend on cleaning up what failed; give each attempt a fresh
   name and reclaim the old one lazily.**

7. **brigadier treats a workspace as an exclusive session resource; bb treats it as a shared place.**
   brigadier refuses a second live session on a checkout up front (`composer_workspaces.rs:183-187`,
   "Another active task is using this checkout"); bb folds the second thread into the first's environment
   and lets both run turns concurrently (**[measured]**, §2.3, and its own doctrine "Multiple threads can
   share an environment"). brigadier's exclusivity is *correct for its product* — disjoint path ownership
   per work order is the reason parallel workers are safe (`docs/vision.md` §7, `loop_/action.rs`), and bb's
   answer to interleaved writes is that there isn't one. **Principle: keep exclusivity where two writers
   would actually corrupt each other, and state it as a product rule about writers — never as a lock on a
   directory that a reader, a shell, or a no-op setup step can trip.**

8. **brigadier's lock keys are global and hierarchical; bb's are per-resource.** Every brigadier lease takes
   locks on *every ancestor* of the root out of one per-user registry at `~/.brigadier/workspace-locks-v1`
   (`lease.rs:56-59,107-145`), so an operation on a parent directory contends with an unrelated operation on
   a child; bb's keys are a git common dir, a resolved checkout path, or an environment row, and siblings
   never meet. **Principle: a lock's blast radius should be the resource it protects, and ancestor-wide
   exclusion should be reserved for operations that really do rewrite the tree.**

None of this argues brigadier's lease is wrong. It argues that four decisions inside it — non-blocking,
hierarchical, permanent, and anonymous — are each defensible for a *restore*, and that a local session
start was routed through the restore path. Difference 1 is the cause; difference 2 supplies the specific
holder; differences 3–5 are why a transient overlap became a dead end instead of a two-second wait.

---

## 6. Not checked

- **bb's desktop app, web UI and mobile client were never launched.** Everything measured went through the
  HTTP API and the host daemon; every UI claim (`Current (main)`, the environment picker) is **[read]** from
  `app.tsx`, not seen rendered.
- **No real provider ran.** All turns were bb's scripted fake provider. Nothing here says how Claude Code or
  Codex behaves inside a bb environment.
- **No multi-machine, no `bb connect`, no tunnel.** Single local host daemon only.
- **I never waited out a full 5-minute retirement**, so I have not observed a worktree actually being
  removed, the teardown script running, or `killProcessesWithCwdUnder` firing. The removal path is
  **[read]** only.
- **The `claimPath`-retained-after-failed-cleanup case was not reproduced.** It is **[asserted]** from
  `docs/environment-provisioning.md` and inferred from `environments.ts:595-601`.
- **`environment-engine.ts` (1,700+ lines) was not read in full** — only the retirement, sweep, claim and
  retry sections.
- **`thread-environment-placement.ts` machine-fallback rules unread**, as in the prior brief.
- **bb's `withGitRefMutationLock` staleness break was not exercised.** The 10-minute constant is **[read]**;
  I did not simulate a stale lock dir.
- **bb's branch growth has no measured ceiling.** I observed branches surviving; I did not search release
  notes or settings for a branch reaper.
- **On the brigadier side I ran nothing.** No cargo, no vite, no tauri build, per the work order. The root
  cause is read from `composer_workspaces.rs`, `commands.rs`, `lease.rs` and `crates/core/tests/checkpoints.rs`,
  not reproduced in a window. The "session became unarchivable" half of the owner's report is unverified.
- **Whether brigadier's `Mode::Writer` path has the same defect was checked and is negative**: `writer`
  takes no `terminal-*` lock (`lease.rs:143`), so an ordinary AI turn is not affected — only the
  `Mode::Exclusive` setup call is. Not re-run, read only.
- pnpm's shared store under `~/Library/pnpm/store` received cached tarballs; nothing else outside the
  scratchpad clone was written.
