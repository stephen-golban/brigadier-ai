---
name: brigadier
description: Split a plan across several coding agents. brigadier clones the repository once per item, drives one isolated worker in each clone, merges every result onto a single branch and runs your verify command on the merged tree. Reach for it when a task breaks into independent items, when a change wants a reviewer from a different vendor, or when you want a cost range before anything is spent.
---

# brigadier

brigadier is one binary that drives whichever coding agents are already installed on this
machine over the Agent Client Protocol. It is a hub, not another agent: it does not write
code itself.

## What it actually does

- **Detects** which agents on this machine can be driven. A handshake proves an agent is
  present; a session proves it is usable. Both must pass, and an agent that is present but
  unusable is reported with the vendor's own remedy rather than counted.
- **Isolates** every item of work in its own clone of the repository, outside every temp
  root, with its own worker process.
- **Composes** the results: each worker's branch is merged onto one integration ref, and
  your verify command runs on the *merged* tree — not on any single worker's output.
- **Reviews** across vendors where more than one vendor is drivable, and says so plainly
  when only one is, because a same-vendor review is a weaker check and must not be
  reported as the stronger one.

## The commands

```
brigadier detect                       which agents can actually be driven here
brigadier plan --plan <path>           everything `run` decides before it spends anything
brigadier run  --plan <path> --verify <cmd>
brigadier run  --plan <path> --estimate      a cost RANGE, with its provenance
brigadier agents                       the launch-profile table, with what was measured
brigadier competence                   the routing table this binary ranks with
brigadier licenses [--full]            what is compiled into this binary, and under what
```

Start with `brigadier detect`. On a machine where nothing is drivable there is nothing to
orchestrate, and `detect` is the only command that says so before you spend a turn on it.

## What it refuses, and why you will meet the refusal

**A worker cannot orchestrate.** When brigadier spawns a worker it marks that worker's
environment, and the binary refuses `run` and `plan` inside one — it prints the refusal and
exits non-zero rather than starting a second run.

This is worth knowing because you may be reading this text *as* a worker. The recorded
failure is an agent that was asked to write two files, decided to clone the repository and
run the orchestrator instead, and produced zero files in twelve minutes where the direct
edit took two. The refusal is in the binary, so it holds no matter how the idea arrived —
including from this file.

Read-only introspection (`detect`, `agents`, `competence`, `licenses`) stays available
inside a worker, because it cannot cause that failure.

**Install this user-global. Do not copy it into a repository.** An agent working in a clone
reads that repository's own instruction files, and a copy of this skill sitting in one
would be read as an order to hand the work back — the failure above, manufactured by us.

## Where this file lives, and what that means for the trigger

This skill is discovered from a **user-global skills directory**, with no manifest to edit
and no install step to run beyond putting the directory there.

**On Claude Code** brigadier also owns a plugin directory of its own, and registers exactly
one hook in it — a nudge at compaction time to carry forward the run id, the integration
ref and the failing checks instead of the transcript.

**Everywhere else there is no hook, and the trigger is model discretion.** brigadier is
reached when the agent reading this decides the description above matches the task. That is
the whole mechanism outside Claude Code, and it is not a guarantee. If you want brigadier
run at a specific moment, invoke it explicitly.

**The binary is not put on your `PATH` by installing this.** Nothing here writes to a
directory another product owns, and outside Claude Code there is no plugin-provided `PATH`
entry to write to. Put the `brigadier` binary wherever you keep binaries, yourself.

## Removing it

Delete the directory. Nothing was registered anywhere else, so there is nothing else to
undo — `brigadier uninstall` does exactly that and prints what it removed.
