> **SUPERSEDED, 2026-08-31.** This is the brief for the previous brigadier — a `brigadier claude`
> wrapper, spending gates, a plan schema, and off-session `claude -p` workers in git clones. All of
> that was stripped out. The product is now a CLAUDE.md block plus two hooks, and the work is done
> by subagents. Kept as history; see `README.md` and `brigadier-guide.md` for what exists.

Build brigadier, Claude-only, from the state this repo is in now, to the definition of done at the
bottom. Work autonomously. Do not stop to ask me things that are already answered here.

---

## 1. What brigadier is

A strict way of working, forced onto the coding agents the user already has. It carries no model and
no account of its own; it uses theirs. It has **no intelligence** and never gets any: it cannot read
code, judge a plan, or tell good work from bad. All thinking belongs to the LLM. brigadier is the
standing orders that LLM works under, plus the mechanical machinery it calls on.

`brigadier-guide.md` in this repo is the product description. Read it first. It is mostly right and
partly stale; section 3 below lists exactly what is stale and how it was settled.

---

## 2. The contract. These are decided. Do not relitigate them.

1. **brigadier is a run loop.** It owns a queue, spawns and supervises worker CLIs, clones per piece,
   merges, and runs the user's verify command. It is not a set of one-shot helpers.

2. **Opt in at launch.** `brigadier claude` starts a guarded session. Plain `claude` stays plain.
   The user can add `alias claude="brigadier claude"` themselves if they want it always on. That
   alias is their choice in their file, never something brigadier writes.

3. **claude owns the terminal.** brigadier guides from behind. Its standards and the shape of the
   flow are injected in front of every prompt, on every turn, not once at launch.

4. **Ruling 8 holds: brigadier writes only inside its own folder.** It never edits
   `~/.claude/settings.json` or any other file another product owns. The guarded session is launched
   with `--settings` pointed at a brigadier-owned file. **Delete `src/install/settings-merge.ts` and
   the bind/unbind commands** — they were written for an approach that was reversed.

5. **Hard refusals, not advice:**
   - Inside a git repo, no write to the user's tree. Not Write, not Edit, not a shell command that
     mutates a file. Work goes to a clone. This is a `PreToolUse` deny.
   - `brigadier run` refuses to spawn a worker without a recorded spending answer.
   - It refuses to run a plan that fails its mechanical checks.
   - It refuses to merge a piece whose reviewer rejected it.
   The model cannot fake any of these, because brigadier performs them.

6. **No mid-session escape.** A guarded session is strict all the way through. There is no phrase
   that lifts the wall. Plain `claude` is one word away if the user wants otherwise.

7. **There is no output wall.** Only Gemini can rewrite what a user sees, and Gemini is out of scope
   here. How the session writes back to the user is instruction, reinforced every turn. Strong, and
   still not a refusal. Say so; never claim otherwise.

8. **The flow.** The user states a goal. The session decides the route and **states which route it
   took** before acting, so the judgement is never silent. Where a codebase analysis would genuinely
   help, it **offers** one rather than assuming — modern models read the tree and `AGENTS.md`
   unprompted, so a separate analysis pass often pays twice for the same understanding. That setting
   is the user's: `ask` (default), `always`, `never`. Every interview put to the user carries a
   **recommended option and a freeform option**, always both.

9. **Money.** Not for the session reading code. Yes for research, for planning, and before workers
   spawn. Two gates: one before planning with a range for planning alone, one after the plan exists
   and the piece count and fan-out width are known. Report ranges of **turns and tokens**. Never
   invent dollar figures.

10. **Runs are detached.** `brigadier run` returns a run id immediately and the work survives a
    closed terminal. The session checks in with `brigadier status <id>` and relays progress. A worker
    question parks the run; `brigadier resume <id> --answer …` restarts it. The user never types
    these — they are plumbing the model calls on their behalf.

11. **The user's repository.** Results land on `refs/brigadier/<run-id>/<piece>`. Their branches are
    never written to. Nothing is deleted. Anything left behind is named with its path. Isolation is
    `git clone --local`, not worktrees.

12. **Claude only.** Workers run through `@anthropic-ai/claude-agent-sdk` against the user's own
    installed binary and their own login. That gives a per-tool-call permission callback in-process,
    so a worker is walled with no hook file and no spawn per call. Codex is second and out of scope.

13. **Fail open on brigadier's own errors.** If brigadier breaks it stands aside rather than bricking
    the CLI. `brigadier doctor` says so out loud.

---

## 3. What in `brigadier-guide.md` is stale, and how it was settled

Rewrite these sections as part of the work.

| stale text | settled as |
|---|---|
| "There is no such thing as a non-brigadier session" | Rewrite. The fear was the model wriggling out mid-session, not the user choosing a plain session. Inside a guarded session the model cannot talk its way out. Starting one is opt-in. |
| The three-sided wall, "before anything reaches you" | Cut the third side. Two sides: ingest and action. |
| Step 4, `alias claude="brigadier claude"` as the binding mechanism | `brigadier claude` is the mechanism. The alias is an optional user preference. |
| The entire "Honest status, as of today" section | Rewrite against what is actually true when you finish. |
| "No writing into other products' config files" | **This one is true and stays.** |

---

## 4. Facts already measured on this machine. Do not re-derive. Do not contradict without re-measuring.

`brigadier-verification-research.md` (2026-08-30) is current and trustworthy. **`BLOCKERS.md`,
`brigadier-transport-research.md` and `brigadier-vendor-hooks-research.md` are superseded and wrong
in ~22 places** — read them only for history, never as instruction.

Measured on claude **2.1.251**, macOS:

- `UserPromptSubmit` hook output reaches the model. Both raw stdout and
  `hookSpecificOutput.additionalContext` work.
- `PreToolUse` with `permissionDecision:"deny"` blocks the tool, and **outranks
  `--permission-mode bypassPermissions`**. The model reads `permissionDecisionReason` verbatim, so a
  refusal is a channel back to the model, not just a veto.
- A hook can **deny but not grant**: `permissionDecision:"allow"` is ignored in a confined session.
- Claude Code has ~14 hook events and five hook types: `command`, `prompt`, `http`, `agent`,
  `mcp_tool`.
- Per tool call, warm: `/bin/sh` no-op 3.4 ms, bash script 6.5 ms, a 61 MB compiled bun binary
  17.9 ms, loopback HTTP to a resident process 0.19 ms. **The binary size is the cost, not the
  spawn.** Cold start ~700 ms.
- `--settings <file-or-JSON>` loads hooks and leaves auth intact. **`CLAUDE_CONFIG_DIR` loads hooks
  but logs the user out** — never set it. Never override `HOME` either; it relocates the macOS
  keychain.
- Claude Code has no native ACP mode. Irrelevant here, because workers use the SDK.

**One fact you must measure before building on it:** does `--settings` *merge* with the user's own
settings or *replace* them? If it replaces, a guarded session would silently lose the user's model
choice, env and their own hooks, and the design needs a different answer. Measure this first.

---

## 5. Where the code is now

Working, tested, keep: `src/wall/protocol.ts`, `src/wall/policy.ts`, `src/wall/hook.ts`,
`src/cli.ts`, `test/policy.test.ts`. Bun + TypeScript, `bun test`, `bun run build` compiles a single
binary. 16 tests pass.

Delete: `src/install/settings-merge.ts`, `test/settings-merge.test.ts`, and the `bind`/`unbind`
commands. Rewrite `src/install/claude.ts` as a generator for brigadier's **own** settings file rather
than a merger into the user's.

Proven end to end against real claude, with firing negative controls, on 2026-08-30:
- action side: `rm -rf doomed` under `bypassPermissions` was denied and the directory survived; the
  control run deleted it.
- ingest side: the walled session quoted a standing rule the control session said it did not have.

Keep that standard of proof. **Every claim you make about behaviour needs a negative control** — a
run that shows the difference between "it works" and "it would have done that anyway."

---

## 6. How to work

**Work like brigadier, on yourself.** You are the conductor, not the workhorse. Your context is a
scarce resource and flooding it is the main way this fails.

- Delegate the reading and the building to subagents. Ask them for conclusions and file paths, not
  file dumps.
- Run independent subagents in parallel in one message.
- Keep your own turns short. One line per fact. A path or a number beats an adjective.
- Never paste a plan into your own output. Write it to a file and name the path.

**Spawning real sessions.** This machine runs Supacode, and its CLI is on PATH. Every session exports
`SUPACODE_WORKTREE_ID`, `SUPACODE_TAB_ID`, `SUPACODE_SURFACE_ID`, `SUPACODE_ROOT_PATH`,
`SUPACODE_SOCKET_PATH`.

```
supacode tab new --background --input "<command>"   # spawn a session running <command>
supacode tab list                                    # list tabs in this worktree
supacode tab close --tab <id>                        # kill one
supacode repo worktree-new                           # new worktree in a repo
supacode worktree list | status | delete
supacode surface list | split | close
```
Run `supacode help <subcommand> <verb>` for exact flags before using one.

**Its limit, which shapes how you use it:** there is no way to read a tab's output back. A spawned
session is fire-and-forget. So anything you spawn must write its results to a file you then read.
Use it for long-running or genuinely parallel work, not for anything whose answer you need
immediately. For work you need an answer from, use subagents instead.

**Loop until done.** Use the `/gauntlet` skill to drive iteration toward the bar in section 7. It
interviews the owner up front — everything it would ask is answered in this document, so answer from
here rather than stopping. If gauntlet does not fit the shape of this work, say so in one line and
loop manually instead: build, verify with a negative control, fix, repeat.

**Hard limits on autonomy:**
- Never write to `~/.claude/settings.json` or any other product's config file.
- Never commit or push without being asked.
- Never publish anything anywhere.
- Test against temp directories and `--settings`, never against the user's real config.
- Live probes against `claude` spend the user's tokens. Keep prompts tiny, one probe per question,
  never loop a probe.

---

## 7. The bar

brigadier is done, for this milestone, when all of these are true and demonstrated:

1. `brigadier claude` opens a guarded claude session, passing through every argument the user gave.
   Plain `claude` is unaffected, proven by a control run.
2. The guarded session opens under brigadier's standards without the user asking, on every turn, not
   only the first. Proven with a negative control.
3. Inside a git repo, the guarded session cannot write to the user's tree. Write, Edit and mutating
   shell commands are all refused, the model is told why, and the refusal holds under
   `--permission-mode bypassPermissions`. Proven with a negative control.
4. Outside a git repo, ordinary editing is untouched.
5. The user states a goal in English and the session states which route it took before acting.
6. A codebase analysis is offered rather than assumed, honouring an `ask` / `always` / `never`
   setting stored in brigadier's own folder.
7. Interviews put to the user always carry a recommended option and a freeform option.
8. A plan is written off-session by a worker, comes back as a file, and the user is given one line
   naming its path.
9. brigadier checks that plan mechanically and refuses to run an invalid one: two pieces claiming the
   same file, circular dependencies, a verify command that does not exist. All problems reported at
   once, nothing cloned, nothing spent.
10. Both spending gates fire, in the right order, reporting ranges of turns and tokens and no dollars.
11. `brigadier run` is detached, returns a run id, survives a closed terminal, and reports progress
    through `brigadier status`.
12. Each piece gets its own `git clone --local`, one worker inside each, workers driven through the
    Agent SDK with the permission callback attached.
13. Independent pieces run in parallel. Width is min(independent pieces, memory cap, configured cap).
14. A worker question parks the run, reaches the user in the same conversation, and
    `brigadier resume` continues it.
15. Results land on `refs/brigadier/<run-id>/<piece>`. The user's tree is byte-for-byte identical
    afterwards, uncommitted changes included. Prove this with a hash before and after.
16. The verify command runs on the merged result, not on pieces in isolation. A repo with no tests is
    normal and nothing nags about it.
17. Same-vendor review reports itself as the weaker thing it is.
18. `brigadier doctor` names what brigadier did not protect the user from, including that hooks are a
    guardrail rather than a security boundary and that the rules judge the tools they judge.
19. `bun test` passes and `bun run build` produces a working single binary.
20. `brigadier-guide.md` is rewritten so every claim in it is true of what you built.

Stop when all twenty hold and you have shown the evidence for each. Then report in one line per item
what is true, and separately name anything you could not do and why.
