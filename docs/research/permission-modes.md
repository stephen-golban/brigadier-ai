# `--permission-mode` on 2.1.261, and what a mode must mean to *brigadier*

Written for order R1.1: *the permission mode must select the hook policy, not just the CLI flag.*
`docs/research/approvals.md` §3 measured the flag's vocabulary on **2.1.258**; this file re-measures
it on the install the owner is actually running and then answers the question §3 never asked —
**what a mode should mean to the `PreToolUse` hook**, which runs before the mode is consulted at all.

## 0. Bottom line

1. The CLI's accepted set on 2.1.261 is **unchanged** from 2.1.258: seven values, six listed.
   `PermissionMode::as_cli_flag` in `crates/core/src/driver.rs` still matches it exactly, value for
   value. Nothing in the enum needed changing. **[measured]**
2. A value outside that set is **rejected by commander at argument parsing**, before the process
   does anything — so `PermissionMode::Other(s)` reaching the flag is a hard start failure, not a
   pass-through the CLI degrades on. That was already the enum's documented belief; it is now
   re-measured. **[measured]**
3. **The mode alone cannot stop a prompt, and today nothing else does either.** brigadier registers
   a `PreToolUse` hook that answers `permissionDecision: "ask"` for `Bash`, `Write`, `Edit`,
   `MultiEdit`, `NotebookEdit`, and hooks run **before** the permission mode is consulted
   (`docs/research/approvals.md` §5, documented). So picking `bypassPermissions` and picking
   `default` produced the identical flood of prompts. The picker was a lie. **[documented + source]**
4. Therefore a mode has to select a **hook policy**, not just a flag — and the policy depends on a
   second axis the mode knows nothing about: **whose checkout the child is standing in.**

## 1. Environment

| | |
|---|---|
| binary | `/Users/stephen/.local/share/claude/versions/2.1.261`, via `/Users/stephen/.local/bin/claude` |
| `claude --version` | `2.1.261 (Claude Code)` |
| date | 2026-09-05 |
| machine | darwin 25.5.0 |

## 2. The accepted set — **[measured]**

`claude --help` lists six:

```
--permission-mode <mode>   Permission mode to use for the session
                           (choices: "acceptEdits", "auto",
                           "bypassPermissions", "manual",
                           "dontAsk", "plan")
```

Probed one value at a time with a one-word prompt (`claude --permission-mode <m> -p hi`), reading
whether commander refused the argument:

| value | accepted | note |
|---|---|---|
| `default` | yes | **not listed in `--help`**; the docs make `manual` its alias |
| `manual` | yes | |
| `acceptEdits` | yes | |
| `plan` | yes | the reply announced plan mode unprompted, which is the mode taking effect |
| `auto` | yes | |
| `dontAsk` | yes | |
| `bypassPermissions` | yes | |
| `someFutureMode` | **no** | `error: option '--permission-mode <mode>' argument 'someFutureMode' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.` |

Cost: seven one-word turns on the owner's own subscription. No other spend.

**This is byte-for-byte `PermissionMode::as_cli_flag`'s output set** (`crates/core/src/driver.rs`),
so the CLI has not moved and neither does the enum. `docs/research/approvals.md` §3's measurement
stands at one more version.

### Model aliases — **[documented]**, partially **[measured]**

`claude --help` on `--model`: *"Provide an alias for the latest model (e.g. 'fable', 'opus', or
'sonnet') or a model's full name (e.g. 'claude-fable-5')."* `strings` over the 2.1.261 binary shows
`opus`, `sonnet`, `haiku` adjacent in one table and `fable` nearby. `haiku` is therefore taken as a
valid alias **[asserted from the binary's own table, not exercised]** — no turn was spent proving
it, and `ModelTier::as_slug` already emits exactly these three.

## 3. The thing §3 did not cover: a mode has to reach the hook

`crates/core/src/claude/hook.rs`'s own module doc, and `docs/research/approvals.md` §5:

> hooks run **before** deny rules, ask rules, the permission mode and allow rules

So the evaluation order is `PreToolUse hook → deny → ask → mode → allow`. An `"ask"` from the hook
is decided *before* `bypassPermissions` is ever read. The consequence, seen by the owner on his
first real run: a planner call explored a repository with ~20 `Bash` commands and prompted for
every one of them, in a run whose mode he could have set to anything.

A permission picker that cannot stop the prompts is a lie in the UI, and `docs/vision.md` §9 makes
the approvals surface *"the one screen the owner has to be able to trust."*

## 4. The second axis: where the child is standing

Mapping mode → policy on its own opens a hole, and it is worth naming because the naive table is
the obvious thing to write.

**The lead and planner calls do not run in a worktree.** `crates/supervisor/src/loop_/call.rs`'s
`CallCwd::ProjectRoot` puts the child in the owner's own checkout. Today that is safe only by
accident: `AskGatedTools` gates every writing tool, so a judgement call that reached for `Edit`
would prompt. A naive `bypass-permissions → AllowAll` removes that gate **for a child running
directly in the owner's repository**.

That is not what `docs/vision.md` authorizes. §8 pre-authorizes a worker *"inside their own
worktree"*, and §11 is explicit that the isolation **is** the worktree and there is no sandbox
behind it. A mode picked in a run dock is a statement about what **workers** may do inside a
throwaway checkout. It is not consent to let an unattended judgement call write the owner's tree.

So the policy is a function of two things:

| scope | what it is | what can be thrown away |
|---|---|---|
| `Interactive { root }` | a session the operator started and is watching, in a fresh worktree | the worktree |
| `Worker { root }` | a loop-dispatched work order, unattended, in its own worktree | the worktree |
| `Judgement` | planner, lead, review — in the **project root** | nothing |

## 5. The mapping, as built

`brigadier_core::claude::hook::policy_for(mode, scope)`.

### `Interactive { root }` — a human is watching

| mode | policy | why |
|---|---|---|
| `default`, `manual` | `AskGatedTools` | today's behaviour, unchanged |
| `accept-edits` | `AcceptEditsInside(root)` | edits whose target resolves inside the session's cwd are allowed; `Bash` still asks. That is what the mode's name promises and no more |
| `plan` | `AllowAll` | plan mode does not write |
| `auto`, `dont-ask`, `bypass-permissions`, anything unmodelled | `AllowAll` | the operator asked for no harness gate and is sitting in front of the window; the CLI's own mode then decides |

`AllowAll` answers `{}` — *no opinion*, not *allow*. Under `plan` the CLI still refuses writes; under
`bypassPermissions` it does not. That is the mode doing its own job, which is the point.

### `Worker { root }` — nobody is watching

`WorkerWall(root)` in **every** mode. The mode does not reach it.

The wall's guards are about **leaving the worktree** — a `git -C /elsewhere`, an absolute path
outside the root, a nested `claude`. Nothing the owner selects in a control labelled *permission
mode* is a request to let an unattended child write outside the checkout brigadier cut for it. And
an unattended worker has no human to answer a prompt, so relaxing toward `AskGatedTools` would hang
the run rather than loosen it (`crates/core/src/claude/hook.rs`, `WorkerWall`'s own rationale).

### `Judgement` — the owner's own checkout

| mode | policy |
|---|---|
| `default`, `manual` | `AskGatedTools` — today's behaviour, unchanged |
| everything else | `ReadOnlyWall` |

`ReadOnlyWall` never pre-authorizes a write. Reads and inspection flow with no opinion; every
`Write`/`Edit`/`MultiEdit`/`NotebookEdit`, every `Bash` line the classifier calls mutating or cannot
classify, and every unclassifiable line **asks**; a nested `claude` is denied.

This is the shape that actually fixes what the owner hit. His twenty prompts were exploration —
`ls`, `grep`, `cat`, `git log` — which `ReadOnlyWall` lets through. The prompts that remain are the
ones that would change his repository, and a planner told *"read whatever you need to; write
nothing"* should never raise one.

**A permissive mode therefore relaxes reads in the project root and never relaxes writes.** A future
reader will see the asymmetry against the `Interactive` row and want to simplify it. The sentence to
keep: the mode governs what a **worker** may do inside a worktree that can be thrown away; a
judgement call runs in the owner's repository, where there is nothing to throw away.

## 6. What was not checked

- The hook policies are proved by unit tests over their `HookJsonOutput`, not against a live child.
  No live run was made to observe `ReadOnlyWall` letting an `ls` through and stopping a `Write` —
  that costs a real session and the mechanism (`permissionDecision: "ask"` producing a
  `can_use_tool`) is already measured in `docs/research/approvals.md` §12.
- `haiku` as a `--model` alias was read out of the binary's string table, not exercised.
- `--permission-mode auto` is **billable on API accounts** (`approvals.md` §1(b)); nothing here
  changes that, and nothing here selects it.
- The `dontAsk` mode's exact boundary against `bypassPermissions` is the CLI's business and was not
  probed; both map to the same brigadier policy in every scope, so the distinction cannot matter
  here.

## 7. Sources

- `claude --help` and one-value-at-a-time argument probes on 2.1.261 — **[measured]**, §2.
- `strings` over the 2.1.261 binary for the model alias table — **[measured]**, §2.
- `docs/research/approvals.md` §3 (the 2.1.258 measurement), §5 (hook evaluation order,
  documented), §1(b) (the built-in read-only Bash set), §12 (a live `ask` producing `can_use_tool`).
- `docs/vision.md` §8 (worker pre-authorization is *inside their own worktree*), §9 (the approvals
  surface must be trustworthy), §11 (the worktree **is** the isolation).
- `crates/core/src/claude/hook.rs`, `crates/core/src/driver.rs`,
  `crates/supervisor/src/loop_/call.rs` — **[source]**.
