# Ruling 38 — amendment proposed, 2026-08-20

*Following the 13/32/33/37 precedent: **ruling 38's text stands**. This is the amendment, recorded
separately, so both what was believed and why it changed survive. Marked `[owner]` where a real
judgement remains — the owner ruled on the mechanism on 2026-08-20; the wording clause below is still
a proposal.*

## What ruling 38 says, and which clause is at issue

> **every process brigadier causes to exist must carry a marker in its command line**, or the sweep
> has nothing to match.

And, restated in `src/agent/marker.ts` as the rule the implementation followed:

> The RUN MARKER in the process COMMAND LINE is what ruling 38's reclamation sweep matches on, and
> ruling 38 is explicit that it must be the command line and never a name pattern.

Nothing below weakens the requirement. What is amended is the assumption that the marker's
**placement** is a constant.

## The measurement that forces this

MEASURED on 2026-08-20, macOS 26.5.2 / Darwin 25.5.0 arm64, load1 3.16–4.31, against
Copilot 1.0.80, Qwen 0.21.13, Gemini 0.55.1 and opencode 1.18.18. An ACP server handed a closed stdin
sees EOF and exits 0, so `exit 0` means the argv parsed and the process started; `exit 1` is a parse
refusal before any protocol.

| argv | exit | result |
| --- | --- | --- |
| `copilot --acp --brigadier-run=X` | 1 | `error: unknown option '--brigadier-run=X'` |
| `copilot --acp -- --brigadier-run=X` | 1 | unknown option — **the `--` terminator does not rescue Copilot** |
| `copilot --acp --name '<marker>'` | **0** | accepted |
| `copilot --acp --session-id X` | 1 | `option '--session-id <id>' cannot be used with option '--acp'` |
| `copilot --acp --log-dir <run-dir>` | **0** | accepted |
| `qwen --acp --brigadier-run=X` | 1 | `Unknown arguments: brigadier-run, brigadierRun` |
| `gemini --acp --brigadier-run=X` | 1 | unknown argument |
| `opencode acp --brigadier-run=X` | 1 | exits 1 and prints subcommand help |
| `qwen` / `gemini` / `opencode`, marker after `--` | **0** | accepted |

**Every direct agent profile in the fleet was unstartable.** `src/queue/spawn.ts` appended a bare
marker to every profile and its own comment named the consequence as an accepted cost —
*"a vendor that rejects unknown arguments will fail to start, and it will fail loudly at the
handshake"*. It did fail loudly. Nothing was listening, because no bar item drove a real vendor's
argv.

## The options, with what each costs

**(a) Environment variable, matched from `ps -E`.** — **MEASURED DEAD on the platform the sweep runs
on.** `ps -E` on this macOS does not expose a target process's environment. Tested against an owned
process with an exported variable, in both the default format and `-o pid=,args=`:

```
( export BRIG_X=zzmarkerzz; exec sleep 20 ) &
ps -E -ww -p $P    ->  91311 ??  0:00.00 sleep 20        (no environment shown)
```

An environment marker is invisible to a `ps`-based sweep here. `src/agent/marker.ts` already says so
in prose — *"An environment variable is invisible to a sweep scanning `ps` output"* — and this is the
measurement behind it. Discarded.

**(b) A pid file the sweep reconciles.** Works on every vendor and every OS, including Windows where
argv sweeps are weakest. **Cost:** a pid file outlives its process and pids are recycled, which is
the false-positive class ruling 46's clause was written against — *"Detection must report the resolved
`PATH` entry rather than assume it is ours"* — and amendment §4's *"a marker is identity, not
authority"*. Honest use needs `kill -0` plus a start-time comparison before any signal. Not adopted
now; recorded as the answer if a vendor appears that accepts no argv slot at all.

**(c) Run-scoped cwd.** The worker's cwd is already the clone it must work in, so this would mean
reading every candidate's cwd through `lsof` or `/proc` to match. Expensive, not uniform across
platforms, and it collides with a directory choice ruling 61 already fixed for other reasons. Not
adopted.

**(d) Per-profile marker placement.** **ADOPTED by the owner on 2026-08-20.**

## The amendment

> **38a. [owner] Ruling 38's marker is required on the command line of every process brigadier causes
> to exist, and its PLACEMENT is a per-vendor measured coordinate rather than a constant.** A profile
> declares where its marker goes: appended bare (bridged launchers, which forward unknown argv), after
> a `--` terminator (Qwen, Gemini, opencode), or as the value of a flag the vendor already accepts
> (Copilot's `--name`). MEASURED 2026-08-20 against the four versions tabled above.
>
> **The "never a name pattern" clause is clarified, not weakened.** It governs MATCHING: the sweep
> greps argv for a token brigadier put there, rather than guessing from a program name in the way
> `pgrep node` would. Carrying that token as a flag's value leaves the matcher untouched —
> `src/run/marker.ts`'s regex anchors on whitespace, so `--name --brigadier-run=r/1` matches with no
> sweep code changed. Whoever reads ruling 38 next should not have to re-derive that Copilot's
> `--name` is a transport for the marker rather than a substitute for it.
>
> **Accepted costs, stated:**
>
> - **One more per-vendor coordinate in the table `src/agent/profiles.ts` calls a standing hazard.**
>   It goes stale exactly as the others do. A vendor that removes `--name`, or begins validating
>   arguments after `--`, breaks the spawn — loudly, at the handshake, which is where ruling 38 was
>   always willing to fail.
> - **On Copilot the marker occupies a vendor-semantic slot.** It becomes the session's name and will
>   appear in Copilot's own logs and interface. brigadier is writing into a field that means something
>   to someone else's product.
> - **The staleness is only visible if something drives real vendors.** That is the actual lesson of
>   2026-08-20, and it is why this amendment ships with `BAR.md` item 14 rather than alone. Without a
>   real-agent leg this ruling would be re-broken by the next vendor release and read green.

## The second question this measurement opened, and it is NOT ruled on

Ruling 57 makes the config-root redirect the secondary containment layer, existing *"on 4 of 6"*
vendors. Two facts measured on 2026-08-20 bear on it, and neither is decided here.

**`CODEX_CONFIG` was never a config root.** MEASURED against `@agentclientprotocol/codex-acp` 1.6.2:
it is *"a JSON object merged into the Codex session config"* (README line 54), read at
`dist/index.js:32869` as `JSON.parse(configString)`. Handing it a directory path throws
`SyntaxError: Unexpected token '/'` before `initialize` — the verifier's finding V3. The bridge reads
eight environment variables and `CODEX_HOME` is not among them. The real coordinate is `CODEX_HOME`
on codex-cli 0.147.0, measured with a negative control, and the profile table now names it.

**The redirect logs some workers out, and the pattern is not uniform.** MEASURED the same day, each
with a negative control:

| subject | redirected config root | result |
| --- | --- | --- |
| `claude` CLI 2.1.233 | `CLAUDE_CONFIG_DIR` | exit 1, `Not logged in · Please run /login` |
| `claude-agent-acp` 0.70.0 (this profile) | `CLAUDE_CONFIG_DIR` | **`usable`** — handshake and session both |
| `codex-acp` 1.6.2 | `CODEX_HOME` | `unusable` — `session/new: -32000 Authentication required` |
| `codex` CLI, `auth.json` seeded into the redirected root | `CODEX_HOME` | exit 0, `Logged in using ChatGPT` |
| Copilot 1.0.80 | `COPILOT_HOME` | `usable` |
| opencode 1.18.18 | `OPENCODE_CONFIG_DIR` | `usable` |
| Qwen 0.21.13 | `QWEN_HOME` | `unusable` — `Authentication required` |

**Recorded because the inference ran the other way first.** "The redirect logs every worker out" was
generalised from the `claude` CLI and from Codex, and the measurement refused it — the Claude
*bridge* is unaffected. AGENTS.md's rule applies and was nearly broken: do not generalise from one
sample, two agents both directions before writing a rule.

So the open question for the owner is narrow: **on Codex and Qwen, a worker under ruling 57's redirect
cannot authenticate.** Seeding `auth.json` alone into the redirected root is measured to fix Codex.
Seeding is not implemented here, because copying an operator's credential into a run-scoped directory
a worker can write to is a decision about a credential boundary and belongs to the owner, not to this
change. Until it is ruled on, those two vendors report `unusable` at detection with the vendor's own
remedy text, and `run` declines to admit them — which is honest, and is a smaller fleet.

## What changed in the tree under this amendment

- `src/agent/profiles.ts` — `MarkerPlacement` type, `markedArgv`, a placement on each of the six
  profiles, and the corrected `CODEX_HOME` coordinate.
- `src/queue/spawn.ts` — `spawnMarkedAgent` uses `markedArgv`; the comment that called the defect an
  accepted cost is corrected.
- `src/cli.ts` — `brigadier agents` prints `marker` and `configroot`, so the release bar can check the
  artifact's own declaration against real vendors instead of a constant in the harness.
- `BAR.md` item 14 and `bar/items/14-real-fleet-starts.ts` — the real-agent leg, with a demonstrated
  negative that spawns a real vendor with the broken form and requires it to fail.
