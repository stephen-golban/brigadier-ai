> **SUPERSEDED — HISTORY ONLY. DO NOT TREAT ANY CLAIM IN THIS FILE AS INSTRUCTION.**
> Written before the 2026-08-30 verification pass and wrong in roughly 22 places.
> Current, trustworthy sources: `brigadier-verification-research.md` (2026-08-30) for the
> vendor measurements, and `docs/measurements.md` (2026-08-31) for everything measured
> while building. Kept only to show what was believed and how it was corrected.

# How to drive every CLI, reliably

**Researched 2026-08-28.** The question: what is the most reliable way to drive an open-ended set of
coding CLIs, given that `codex-plugin-cc` worked but hung, got lost, and took ages.

---

## The headline

**Both transports hang. Neither one is the answer on its own.** Reliability does not come from
choosing ACP over subprocess or the reverse — it comes from the **supervision layer above whichever
transport you pick**. Every serious implementation that works has one; `codex-plugin-cc` does not,
which is why it behaved the way it did for you.

The good news is that the supervision model brigadier already has is closer to correct than the
reference implementation the ecosystem has converged on.

---

## 1. Headless subprocess hangs, and it is well documented

Driving `claude -p "…"` is the universal transport — measured on your machine, all six installed
CLIs have a headless mode. It is also the least reliable one.

Open and recurring bugs in Claude Code alone:

| issue | symptom |
|---|---|
| [#25629](https://github.com/anthropics/claude-code/issues/25629) | hangs indefinitely **after** emitting the final `result` event; stdout never closes; needs SIGKILL. Closed as duplicate — i.e. it is a known class, not a one-off |
| [#1920](https://github.com/anthropics/claude-code/issues/1920) | final result event intermittently **missing** — so waiting for it is not safe either |
| [#24478](https://github.com/anthropics/claude-code/issues/24478) | CLI freezes and becomes unresponsive |
| [#24481](https://github.com/anthropics/claude-code/issues/24481) | hangs on simple queries, macOS M1, v2.1.37 |
| [#7497](https://github.com/anthropics/claude-code/issues/7497) | process hangs when reading the InputStream from headless execution |
| [#3187](https://github.com/anthropics/claude-code/issues/3187) | stream-json input hangs on the **second** message |

Plus two behavioural traps: the resume dialog **silently stalls with no timeout and no error**, and
headless mode is materially slower than interactive.

Suspected root causes named on the issues: stdout not flushed or closed after the result event, no
explicit `process.exit()`, pending timers or promises keeping the loop alive, and **MCP servers
keeping the process alive**.

That last one matters for brigadier — a worker with MCP servers configured may never exit.

---

## 2. ACP hangs too

ACP is the better protocol, but it is not a hang-free one:

- [zed#52151](https://github.com/zed-industries/zed/issues/52151) — *"ACP agents frequently hang with
  no output"*, reported across multiple machines.
- [zed#56734](https://github.com/zed-industries/zed/issues/56734) — external ACP tool calls hang
  indefinitely **with no auto-recovery**: the agent never sends the `session/update` that would move
  the call out of `InProgress`.
- Cursor's ACP mode hard-times-out MCP `tools/call` at ~60 s with **no way to configure it**.
- Gemini's ACP mode hangs during OAuth prompts and on subprocess startup.

And the one that should interest you most:

> **Claude ACP adapters exhibit a known stall during session creation**, with a 60-second timeout
> configurable via `ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS`.

That is the same failure, at the same protocol step (`session/new`), bounded at the same 60 seconds
that `DEFAULT_DETECT_TIMEOUT_MS` already uses. Somebody else hit brigadier's exact problem and
reached brigadier's exact answer independently. That is about as good a confirmation of a design
decision as this ecosystem offers.

---

## 3. Why `codex-plugin-cc` behaved the way it did

It wraps the **Codex app-server**: a long-lived, bidirectional JSON-RPC 2.0 process over
newline-delimited stdio, with thread/turn lifecycle and approvals.

A long-lived server is the right shape — it avoids per-invocation startup cost, which is why it felt
fast when it worked. But a long-lived server with **nothing supervising it** is precisely the thing
that "gets lost": a stalled turn has nothing above it to notice, no watchdog on silence, no
wall-clock bound, no cancel path, and no reaper. Your three symptoms — hangs, lost sessions, taking
ages — are the three failure modes of an unsupervised long-lived process, in order.

The fix is not a different transport. It is a supervisor.

---

## 4. The reference supervisor: `openclaw/acpx`

This is the closest prior art to what brigadier needs, and it is worth copying from deliberately.
Concrete mechanisms:

**Three-phase termination**, to prevent orphans:
1. close stdin — some agents treat stdin closure as the shutdown signal (100 ms grace)
2. `SIGTERM`, then wait — `AGENT_CLOSE_TERM_GRACE_MS` = **1500 ms**
3. `SIGKILL`, then wait — `AGENT_CLOSE_KILL_GRACE_MS` = **1000 ms**

**Per-agent timeout classes**, not one global number: `GeminiAcpStartupTimeoutError`,
`ClaudeAcpSessionCreateTimeoutError`. Different agents stall at different steps, and a single timeout
cannot say which.

**Exit diagnosis**, via `AgentLifecycleSnapshot` / `AgentExitInfo`, distinguishing **process exit**
from **stdio closure** from **connection failure** — and `recordAgentExit()` specifically flags an
unexpected termination *during an active prompt*.

**Per-agent quirks are unavoidable**: `qodercli` needs 750 ms extra cleanup; Copilot support is
verified by inspecting `--help` output; Qoder needs `--max-turns` forwarded. This is direct
confirmation that a per-vendor profile table is not over-engineering — everyone who does this ends up
with one.

**Notable absence, and brigadier's edge:** acpx has **no watchdog, no automatic restart, and no
health polling.** brigadier already has a watchdog bounding *silence between frames* under a
wall-clock wrapper — including the documented trap that a 120 s silence bound inside a 60 s wrapper
can never fire. That is ahead of the reference implementation.

**OpenClaw's architectural principle**, which is the right one:

> Run the risky, slow, failure-prone work in an external harness process that the supervisor watches,
> rather than doing it inline.

Plus `runtime.ttlMinutes` to auto-reap sessions that outlive their lifetime, and explicit operator
verbs — `cancel`, `close`, `status`.

And the line worth keeping: raising a timeout is *"a prayer with a deadline."*

---

## 5. The ACP Registry is the coordinate upstream

The set stays closed (see section 6), but the *coordinates* inside it no longer need to be
hand-maintained. There is now a **machine-readable, CI-verified, hourly-updated registry of ACP
agents**:

```
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

**Schema** — per agent: `id`, `name`, `version`, `description`, `repository`, `website`, `authors`,
`license`, `icon`, and `distribution`.

**Distribution types**: `binary` (platform-targeted archives, with **optional SHA-256 checksums**),
`npx`, and `uvx`.

**Platform targets**: `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`,
`windows-aarch64`, `windows-x86_64`.

**Guarantees**: every listed agent is **CI-verified to return valid `authMethods` in the ACP
handshake**, and versions are refreshed **hourly** by cron across npm, PyPI and GitHub releases.

That is brigadier's `PROFILES` table — `command`, `args`, per-platform, with provenance — maintained
externally, verified continuously, and never stale. It directly answers the failure that motivated
hardcoding six profiles in the first place: *three of six coordinates in circulation were wrong, and
a stale one fails as a hang.*

It also carries SHA-256 checksums, which is the missing half of the supply-chain story in
`STATUS.md`.

### Who is in it

Claude Code, Codex CLI, GitHub Copilot CLI, Gemini CLI, OpenCode, Qwen Code, **Cursor**, **Cline**,
**KiloCode**, Kiro, Goose, Junie, Kimi, Amp, Droid, iFlow, Grok Build, Mistral Vibe — 25+ as of March
2026.

Of the CLIs you named: **Cursor speaks ACP** (`cursor-agent acp` runs it as a protocol server),
**Cline** and **Kilo Code** are both listed. **OpenClaw is not an agent at all** — it is an ACP
*client*, i.e. a competitor doing what brigadier does. **Hermes** has open work on a generalized ACP
client for multi-agent CLI orchestration. `pi` and `omp` I could not confirm.

---

## 6. What this adds up to

**Transport: ACP primary, subprocess fallback.**

ACP gives structured turns, a cancel path, streaming updates, and permission negotiation — everything
a supervisor needs to tell "working" from "stuck". Headless `-p` gives none of that: you get bytes on
stdout and a process that may or may not exit. Use it only for CLIs with no ACP mode, and expect to
supervise it harder, not less.

**Vendor set: closed at seven — DECIDED 2026-08-28.**

claude, codex, copilot, qwen, opencode, gemini, **cursor**. Closed, because herdr — Rust-native,
purpose-built, with a remote manifest channel already shipping — still requires a binary update to
add an agent. If a dedicated competitor cannot make it open, the per-vendor table is irreducible.

What still changes:

1. seed the coordinates from the **ACP Registry** — all seven are listed, CI-verified, refreshed
   hourly. It is the upstream for `command`/`args`/platform targets.
2. keep `profiles.ts` for what the registry does not carry — lane policy, capabilities, measured
   caveats, hook locations
3. make the set **data rather than a compiled union**, so the eighth vendor is a data change
4. probe everything, trust nothing

The set stays closed. The type-level enumeration does not need to be what closes it.

**Reliability: one supervision layer, identical across transports.**

- watchdog on **silence between frames**, under a strictly larger wall-clock bound *(brigadier has
  this; acpx does not)*
- per-step timeout classes, so a startup stall and a session-creation stall are distinguishable
  *(acpx has this; brigadier has one bound)*
- three-phase shutdown: stdin → SIGTERM (1.5 s) → SIGKILL (1 s), never a bare kill
- exit diagnosis: process exit vs stdio closure vs connection failure, and whether it happened
  mid-prompt
- TTL reaping for whole runs, not just turns
- never wait on the final result event as the sole completion signal — it is documented as sometimes
  **missing** and sometimes **followed by a hang**
- failover on failure rather than retry-in-place *(brigadier has this — cold vendors)*

---

## 6a. Herdr solves the problem brigadier cannot currently solve

[Herdr](https://github.com/herdrdev/herdr) is a Rust background daemon and terminal multiplexer built
for running many coding agents at once. It uses a **third transport** neither section above covers:
**PTYs** — it drives each agent's real interactive TUI inside a pane, rather than ACP or headless
`-p`. That alone dodges every headless exit bug in section 1, and gets the interactive speed path
that users report headless mode lacks.

But the transport is not the interesting part. **The state model is.**

### The signal brigadier is missing

A silence watchdog cannot tell *thinking hard* from *hung*. Both look identical: no frames. That is
the fundamental limit of brigadier's current liveness detection, and it is why a stalled worker burns
its whole wall-clock bound before anything notices.

Herdr resolves it with a **status authority precedence — one authority per pane**:

| priority | mechanism | what it gives |
|---|---|---|
| 1 | **lifecycle hooks** — authoritative when installed and actively reporting | `idle`, `working`, `blocked`, **and session identity** |
| 2 | **screen manifests** — TOML rules over the live bottom-buffer snapshot, matching terminal titles, OSC progress sequences and screen patterns | inferred state; only marks `blocked` on a known approval/question/permission UI |
| 3 | **process detection** — which agent binary is running in the pane | which ruleset applies at all |

Manifests live at `~/.config/herdr/agent-detection/<agent>.toml`, are overridable locally, and are
refreshed from a remote source with caching (`[update] manifest_check = false` to disable).
`herdr agent explain <target>` debugs a misclassification.

### The connection worth acting on

**The agents with lifecycle-hook integrations are: Pi, OMP, Kimi Code CLI, OpenCode, Kilo Code CLI,
MastraCode, Claude Code.**

So the same hook surface researched for the *wall* is also the best available *liveness signal*, and
it is already the authoritative one in the most mature implementation of this idea. brigadier is
planning to install hooks anyway. **One hook install buys both: refusal on the action side, and
`working`/`blocked`/`idle` telemetry that makes a hang detectable in seconds rather than at the
timeout.**

That is the strongest argument yet for doing the hook work, and it did not come from the hook
research — it came from here.

### Three design details worth copying exactly

**1. Wait on semantic state, not exit codes.** `agent.wait` observes `idle`/`working`/`blocked`/
`done`, explicitly *"rather than command exit codes"*. Given that Claude Code's final `result` event
is documented as both sometimes missing and sometimes followed by a hang, an out-of-band state signal
is strictly more trustworthy than the transport's own completion marker.

**2. Prompt-and-wait must be atomic.** `agent.wait` *"submits the prompt and begins waiting
atomically, avoiding race conditions between separate calls."* Sending a prompt and then subscribing
is a race — the agent can transition before the subscription lands. brigadier's worker path should
not have that seam.

**3. Refuse to prompt a blocked agent.** `agent.prompt` returns `agent_blocked` **without sending the
input** if the agent is already blocked. That is precisely the "it got lost" failure: input delivered
into a UI that was waiting on something else, silently swallowed.

### The socket API, for reference

NDJSON over a Unix domain socket — **and a named pipe on Windows**, which matters given ruling 12.
Discovery precedence: `--session` flag → `HERDR_SOCKET_PATH` → `HERDR_SESSION` →
`~/.config/herdr/herdr.sock`. Full schema from `herdr api schema`.

Methods are dotted: `agent.list/get/read/send/start/rename/focus`, `pane.*`, `tab.*`, `workspace.*`,
`layout.*`, **`worktree.*`**. Events are pushed, not polled — `events.subscribe` with filters like
`{"type": "pane.agent_status_changed", "pane_id": "w1:p1", "agent_status": "blocked"}`, plus
`pane.output_matched`, `pane.exited`, and one-shot `events.wait`.

### Herdr has the same closed-set problem

Worth knowing before treating it as the answer to open-endedness:

> Completely new agent support **still requires a Herdr binary update** for process detection, labels,
> and integration behaviour. Remote manifest updates can only patch existing detection rules, not add
> entirely new agents.

A well-resourced Rust-native competitor, with a remote manifest channel already built, still cannot
add a vendor without shipping a binary. That is strong evidence the per-vendor knowledge table is
**irreducible**, not a shortcut brigadier took. It also shows where brigadier can do better: registry
+ user-declared entries are strictly more open than remote manifests that can only patch known rules.

### Positioning

These are complementary, not the same product:

| | |
|---|---|
| **herdr** | the *substrate* — persistence across disconnection, panes, PTY supervision, liveness state, worktrees |
| **brigadier** | the *discipline and orchestration* — standards wall, per-item isolation, routing, cross-vendor review, merge, verify |

There is a real option to run brigadier **on** herdr's socket API and get cross-agent liveness for
free. The cost is a dependency on a third-party background daemon, which contradicts brigadier's
"one binary, nothing installed, no heavy runtime" property. The cheaper move is to **take the status
authority model** — hooks > protocol frames > process state > screen scrape — which is free, needs no
dependency, and is the part that actually solves the hang problem.

One divergence worth noting: the ecosystem convention is **git worktrees** (herdr, Claude Squad,
cli-agent-orchestrator). brigadier uses `git clone --local`, which is stronger isolation — worktrees
share an object store and a repository, so one agent can disturb another's.

---

## 7. What must be measured before building

Everything above is documentation, which is where wrong coordinates come from.

1. Fetch the registry and compare its coordinates against `profiles.ts` — do the three that were
   wrong agree now?
2. Per vendor, per transport: what does a hang actually look like on the wire? Silence, or a frame
   that never advances?
3. Does the three-phase shutdown actually prevent orphans here, with a negative control that leaks
   one?
4. Subprocess fallback: does `claude -p` exit cleanly on this machine, or reproduce #25629?
5. What does the ACP session-creation stall cost in practice — how often, and on which vendors?

---

## Sources

- [ACP Registry](https://agentclientprotocol.com/get-started/registry) · [registry repo](https://github.com/agentclientprotocol/registry) · [FORMAT.md](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md) · [Zed: the ACP Registry is live](https://zed.dev/blog/acp-registry) · [JetBrains: ACP agent registry](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/)
- [Agent Client Protocol — introduction](https://agentclientprotocol.com/get-started/introduction) · [JetBrains ACP](https://www.jetbrains.com/acp/)
- [Cursor CLI — ACP](https://cursor.com/docs/cli/acp) · [Cursor as an ACP agent (Zed)](https://zed.dev/acp/agent/cursor)
- [OpenClaw — ACP agents](https://docs.openclaw.ai/tools/acp-agents) · [acpx agent process management](https://deepwiki.com/openclaw/acpx/5.2-agent-process-management) · [Using ACP with OpenClaw to prevent agent hangs](https://www.bighatgroup.com/blog/using-acp-with-openclaw-to-prevent-agent-hangs/)
- [Codex app-server guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/) · [Codex app-server JSON-RPC protocol](https://codex.danielvaughan.com/2026/03/28/codex-app-server-json-rpc-protocol/) · [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- [Claude Code #25629](https://github.com/anthropics/claude-code/issues/25629) · [#7497](https://github.com/anthropics/claude-code/issues/7497) · [#3187](https://github.com/anthropics/claude-code/issues/3187)
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) · [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [herdr](https://github.com/herdrdev/herdr) · [herdr docs](https://herdr.dev/docs/) · [agents & status authority](https://herdr.dev/docs/agents/) · [socket API](https://herdr.dev/docs/socket-api/) · [Better Stack: herdr agent-state awareness](https://betterstack.com/community/guides/ai/herdr-ai-agent/)
