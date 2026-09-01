# What actually works — a re-verification

**Researched 2026-08-30**, against the machine this was written on: macOS 26.5.2, claude 2.1.251,
codex-cli 0.150.1, GitHub Copilot CLI 1.0.81, qwen 0.21.13, opencode 1.18.18, gemini 0.55.1,
node v24.18.0, bun 1.3.14. `cursor-agent` is **not installed here**, so every Cursor claim below is
documentation and stays that way.

This document supersedes the 2026-08-28 trio (`BLOCKERS.md`,
`brigadier-transport-research.md`, `brigadier-vendor-hooks-research.md`) wherever they disagree. It
was written under the instruction to trust none of them.

**Tags.** **MEASURED** — observed on this machine on 2026-08-30. **DOC** — first-party documentation
or vendor source, not driven here. **UNKNOWN** — could not be established.

A note on scope: this repository now contains only research notes. Every `src/…` citation in
`BLOCKERS.md` — `plugin/hooks.ts`, `agent/profiles.ts:402`, `agent/detect.ts:157`, the whole C group —
points at code that is not in this tree. Those are re-openable design questions, not known defects,
and section C is unverifiable as written.

---

## The headline

**Three of the four things blocking brigadier were not true, and the fourth has a shipped answer.**

- **A3 is falsified.** `UserPromptSubmit` hook stdout *does* reach the model on claude 2.1.251.
- **A7 is not a threat.** The real cost is ~2× lower than estimated, and Claude Code ships **HTTP
  hooks** that make it ~94× cheaper again.
- **The bridge-first transport premise is falsified.** Five of the six installed vendors speak a
  structured protocol natively. Only Claude Code needs `npx`.
- **B1's proposed fix is the inverse of the one that ships in production elsewhere**, and a narrower
  lever exists.

What did *not* survive contact is the framing. Two mature projects solving overlapping problems —
`pingdotgg/t3code` and `herdrdev/herdr` — both reached conclusions brigadier's notes rule out by
assumption. The most important is that **the strongest wall for Claude Code is not a hook at all.**

---

## 1. The wall, per vendor — measured

| vendor | ingest | action (deny) | output (rewrite) | ownable install location |
|---|---|---|---|---|
| **Claude** 2.1.251 | **MEASURED** | **MEASURED** | DOC — block only | **MEASURED** — `--settings <file-or-JSON>` |
| **Codex** 0.150.1 | DOC | **MEASURED** | DOC — no rewrite | **MEASURED** — `$CODEX_HOME/hooks.json` |
| **Copilot** 1.0.81 | **NO** — SDK-only | **MEASURED** | **NO** | **MEASURED** — `~/.copilot/hooks/*.json` |
| **Gemini** 0.55.1 | **MEASURED** | DOC | **DOC(source)** — the only real one | **MEASURED** — `GEMINI_CLI_SYSTEM_SETTINGS_PATH` |
| **Qwen** 0.21.13 | UNKNOWN — quota 403 | UNKNOWN | UNKNOWN | **MEASURED** — `QWEN_CODE_SYSTEM_SETTINGS_PATH` |
| **OpenCode** 1.18.18 | DOC — **five hooks exist** | DOC | DOC — post-stream | DOC — `plugin/*.ts` |
| **Cursor** (absent) | DOC — block, no rewrite | DOC — **fails open** | **NONE** | DOC only |

**The 2026-08-28 scorecard was optimistic on two of three axes.**

- **Action wall: 7/7 stands** — but **three fail open**: Cursor by default, Copilot on timeout, and
  Codex *silently* when the hook is untrusted.
- **Ingest wall: 5/7, not 6/7.** Copilot's `modifiedPrompt` is SDK-only — it is not reachable from
  the CLI. Cursor's "redaction before the model" is not an ingest wall.
- **Output wall that rewrites user-visible text: 1/7, not "at least 4."** Only Gemini's `AfterModel`.
  Copilot's `modifiedResponse` is subagent→parent, never subagent→user. Claude's and Qwen's `Stop`
  block a turn; they do not rewrite it. Cursor has no output wall at all.

The corrected reading: **the action wall is universal and the ingest wall is nearly so. The output
wall essentially does not exist.** Any part of the design that depends on standing between the
model's prose and the user should be treated as Gemini-only.

Other corrections to the hook matrix, all MEASURED:

- Claude Code has **~14 events and five hook *types*** — `command`, `prompt`, `http`, `agent`,
  `mcp_tool` — not six events and one type. The notes describe a much smaller surface than exists.
- **Gemini uses its own event names.** `PreToolUse` gets zero hits in its bundle. The "author once in
  Claude Code shape and translate outward" plan needs a real translation layer, not a copy.
- **OpenCode has five hooks**, including `experimental.chat.messages.transform` — so it is *not* the
  one vendor without an ingest wall.
- The **Copilot npm bundle is 1.0.80**; the live 1.0.81 build moved hooks into Rust. Grepping the npm
  package measures the wrong binary.

---

## 2. A3 — falsified

`BLOCKERS.md` concluded that hook output no longer reaches the model on 2.1.250, and put this first
in the sequence because everything else rests on it. It reaches the model.

**MEASURED**, with a firing negative control, on 2.1.251:

| condition | model's answer to "what is the passphrase?" |
|---|---|
| no hook (control) | *"I don't have one — no passphrase exists in this context."* |
| hook, raw stdout | *"The passphrase is XQ7-VELLUM."* |
| hook, `hookSpecificOutput.additionalContext` | *"XQ7-VELLUM"* |

The hook's own log file confirms it fired in both positive cases, which separates *"the hook never
ran"* from *"the hook ran and its output was dropped"* — the distinction the original investigation
lacked.

Also MEASURED, and stronger than documented: **a `PreToolUse` deny outranks
`--permission-mode bypassPermissions`**, and the model receives `permissionDecisionReason` verbatim.
That is a refusal the model is told about, not a silent drop.

**What remains open:** the *plugin-directory* delivery path specifically was not retested. The
original symptom may still be real and specific to plugin-hosted hooks. But the mechanism is alive,
and the sequencing argument that made A3 the first task no longer holds.

---

## 3. A7 — not a threat, and avoidable entirely

The estimate was 80 ms per call and 16 s per session. **MEASURED**, warm:

| shim | per call |
|---|---|
| `/bin/sh` no-op | 3.4 ms |
| bash script | 6.5 ms |
| 61 MB `bun build --compile` binary | 17.9 ms (~40 ms inside a live session) |
| cold start | ~700 ms |

At 200 calls that is ~3.6–8 s, not 16 s. Real, but not design-invalidating. **The 61 MB binary is the
expensive part, not the spawn** — which is worth knowing before optimising the wrong thing.

**And it is unnecessary. Claude Code ships HTTP hooks, with loopback explicitly allowed.** A resident
brigadier process serving denials over HTTP was measured end-to-end at **0.19 ms per call — ~94×
cheaper, with no cold start.**

That converges with what both prior-art projects do. **Never spawn your own binary per tool call:**

- **t3code** doesn't spawn anything — it uses the Claude Agent SDK's in-process `canUseTool` callback
  (below).
- **herdr** *demoted every spawn-per-event integration it had.* Its Claude hook now fires **once, at
  SessionStart**, and on Unix never spawns the `herdr` binary at all: it shells to an inline
  `python3` heredoc that opens an `AF_UNIX` socket, sets a 500 ms timeout, writes one line, and
  swallows every error (`src/integration/assets/claude/herdr-agent-state.sh:88-99`). The six agents
  that carry full lifecycle authority are **in-process plugins**. herdr actively *removes*
  previously-installed per-tool hooks on upgrade (`*_REMOVED_LIFECYCLE_HOOK_EVENTS`).

So A7's measurement was worth taking, but it was never the decision. Both shipping projects had
already made it: **in-process, or a socket write from a runtime that is already resident. Not a
process spawn.**

---

## 4. The mechanism the notes never considered — the Claude Agent SDK

**This is the most important finding in this document.**

`t3code` writes **no vendor config and installs no hooks anywhere** (verified by grep across
`apps/server/src` and `packages/*/src`). For Claude it drives the user's own binary through
`@anthropic-ai/claude-agent-sdk`'s `query()`, pointed at `pathToClaudeCodeExecutable`, and gets its
action wall from a callback:

```ts
// ClaudeAdapter.ts:4213-4245
const canUseTool: CanUseTool = (toolName, toolInput, cb) => runPromise(canUseToolEffect(...));
// allow with rewritten arguments, or deny with a message the model reads:
{ behavior: "allow", updatedInput: toolInput, updatedPermissions: toSessionPermissionUpdates(...) }
{ behavior: "deny",  message: "User declined tool execution." }
```

This is the same interception point as `PreToolUse`, with three properties hooks do not have:

1. **Zero spawn.** It is a function call. A7 does not exist.
2. **Zero vendor config written.** Ruling 8 is satisfied by construction — there is no file.
3. **It can rewrite tool arguments**, not merely block. The action wall becomes a *modifying* wall.

t3code also sets `destination: "session"` on every permission update, *deliberately rescoped* so that
a user's "always allow" never persists into their own `.claude/settings.local.json`
(`ClaudeAdapter.ts:167-196`). And for ambient suppression it uses `settingSources: ["user",
"project", "local"]` — **choosing which of the user's config layers load**, rather than redirecting a
config root. That is a narrower and safer lever than anything in the current notes.

Notably, t3code **declines to inject a system prompt**: `systemPrompt: { type: "preset", preset:
"claude_code" }`, with no `append` anywhere in the repo. Turn-level context goes in as **prompt
text**. That is the one injection route that cannot silently no-op — which is exactly the failure
mode A3 was investigating.

### The split this forces

The SDK route applies when **brigadier drives the session** — worker mode, fan-out, review. It does
*not* apply to the user's own interactive `claude`, which brigadier does not spawn through the SDK.
So the honest architecture is two mechanisms, not one:

| | mechanism | cost |
|---|---|---|
| **workers brigadier drives** | Agent SDK `canUseTool` + `settingSources` | zero — in-process, no files |
| **the user's bound interactive session** | hooks, **HTTP flavour**, against a resident brigadier | 0.19 ms/call |

Both are now measured to work. Neither requires the 64 MB spawn the notes feared.

---

## 5. Transport — the bridge-first premise is falsified

**MEASURED** — a real ACP `initialize` frame was sent to each installed process and a well-formed
reply came back. Protocol handshake only; no tokens spent.

| vendor | native protocol, no `npx` | launch coordinate | binary distribution | liveness frame |
|---|---|---|---|---|
| **gemini** 0.55.1 | **yes** — ACP | `gemini --acp` | no | `session/update` |
| **qwen** 0.21.13 | **yes** — ACP (**undocumented in `--help`**) | `qwen --acp` | no | `session/update` |
| **copilot** 1.0.81 | **yes** — ACP | `copilot --acp` | no | `session/update` |
| **opencode** 1.18.18 | **yes** — ACP | `opencode acp` | **yes + sha256** | `session/update` |
| **codex** 0.150.1 | **yes** — own JSON-RPC | `codex app-server --stdio` | no | **`thread/status/changed`** |
| **claude** 2.1.251 | **no** — grep for "acp" in help returns nothing | `npx @agentclientprotocol/claude-agent-acp@0.70.0` | no | `session/update` |
| **cursor** (absent) | DOC — `cursor-agent acp` | registry binary | yes, **no checksum** | ACP |

**Claude Code is the only one of the six that still needs a bridge.** The notes' design — everything
through `npx -y @agentclientprotocol/…` — is wrong for five of six.

**B3 (network fetch on the spawn path) is not a blocker.** `npx --offline` resolves from cache:
**MEASURED** 5.02 s cold → 0.85 s warm. Binary distributions were never the route out — only two of
seven have one, and Cursor's carries no checksum.

**Do not use the registry as a launcher.** It is real — HTTP 200, 50,590 bytes, `last-modified` 1.4 h
before fetch, **39 agents** (not the 25+ the notes claim), CI-verified `authMethods`, hourly cron.
But it pins *different versions than are installed here*: gemini 0.57.0 vs 0.55.1, qwen 0.22.3 vs
0.21.13, copilot 1.0.82 vs 1.0.81, opencode 1.18.25 vs 1.18.18. Launching from the registry runs a
build **the user never installed and never authenticated**. Use it as a coordinate reference and a
staleness check; launch what is on `PATH`.

**Wire-format trap:** codex's app-server **omits the `"jsonrpc":"2.0"` member**. A strict JSON-RPC
client library rejects every frame it sends.

**The headless-hang foundation is stale.** All five cited claude-code issues are **closed**. #3187 was
closed by its own reporter saying it worked; #24478 and #24481 are not about stream-json at all. And
none reproduce: **MEASURED**, `claude -p` piped exits **0 in 3.24 s**; `--output-format stream-json`
exits **0 in 3.72 s** with a complete `result` event.

### PTY, priced honestly

**Bun 1.3.14 ships a native PTY** — `Bun.Terminal`, via `Bun.spawn(cmd, {terminal})`, requires
`detached: true` — and it **survives `bun build --compile`**, while `node-pty` fails to compile in,
has no Linux prebuilds on `latest`, and is broken under the Bun runtime. So the single-binary
objection to a PTY transport is dead.

It still ranks third. PTY is the only transport with **no cancel path**, and alt-screen TUIs need a
real terminal emulator to read at all — herdr vendors Ghostty's `libghostty-vt` for exactly this.

---

## 6. Liveness — B4 was right about the problem and wrong about the fix

**Confirmed: no protocol has a heartbeat.** ACP v1, the ACP v2 draft, and the codex app-server schema
all grep clean for `ping|heartbeat|keepalive`. A timestamped live codex turn showed 2.06 s / 1.94 s /
0.99 s gaps with zero frames. **Silence genuinely cannot distinguish thinking from hung.** That
premise survives.

**But B4's stated fix — "lifecycle hooks are authoritative when installed and reporting" — is
contradicted by the project it was taken from.** herdr installs Claude and Codex hooks and **still
refuses them lifecycle authority.** Full-lifecycle authority is a hardcoded allowlist of six —
`pi`, `omp`, `mastracode`, `opencode`, `kilo`, `kimi` (`src/detect/mod.rs:316`) — and Claude and Codex
are not in it. herdr's own documentation says why: those hooks *"do not cover the whole lifecycle.
They can miss permission approval results, escape interrupts, or other transitions."*

The real precedence, from `src/terminal/state.rs:2133`, is a tier deeper than the notes recorded:

1. full-lifecycle hook → screen ignored entirely
2. **a visible screen blocker beats a non-full-lifecycle hook report** — gated on the screen sample
   being no older than the hook report
3. hook report → 4. screen manifest → 5. process detection

**Copy the tiering, not the flat rule.**

**And for codex, the whole question is already answered natively, with no hooks at all.**
`thread/status/changed` carries `idle | active | systemError | notLoaded`, and `active` carries
`activeFlags: waitingOnApproval | waitingOnUserInput`. That *is* the status-authority model, on the
wire, from the vendor. Codex is the **best**-instrumented target in the set, not the worst.

### The mechanisms worth copying exactly

From herdr's `src/api/wait.rs` and `src/app/api/agents.rs`:

- **Atomicity via an event-sequence watermark, not subscribe-then-send.** Capture
  `last_event_sequence = event_hub.current_sequence()` *before* prompting (`:194`), then replay
  `events_after(last_event_sequence)` (`:378`). There is no race window to lose.
- **Refuse to prompt a blocked agent before writing any bytes** — returns `agent_blocked`; the test
  asserts nothing was written *or scheduled*. Also refuses if the agent is no longer the pane's
  foreground process.
- **A two-phase wait, which is the part the notes miss.** `AGENT_PROMPT_EFFECT_TIMEOUT_MS = 5_000`:
  first wait for *any* state change against a `state_change_seq` baseline. If none,
  `agent_prompt_stalled` — a **distinct error from a timeout**, meaning *my input never landed*, not
  *this is taking a while*. Only then wait for a settled status.
- **Identity pinning across the wait** — terminal id, name and agent re-checked every probe;
  `agent_not_running` on close, exit, move or takeover.
- **Fail-safe to `idle`, never to `blocked`,** on an unmatched screen — so it never types into a
  dialog it does not recognise.
- **`done` as an unacknowledged-completion latch** — idle after background work *until the tab is
  focused*. Completion and *acknowledged* completion are different states. The notes have no
  equivalent.

The transport-side complement, since no protocol will tell you: **a state latch, your own timer, and
a two-stage cancel.** On timeout send `session/cancel` / `turn/interrupt`, then start a *second,
shorter* timer. The terminal frame proves liveness; only its absence justifies SIGTERM.

Calibration, from `qwen serve`'s own shipped defaults — it contains an ACP supervisor nobody in the
notes noticed: initialize 10 s, session resume 60 s, permission response 5 min, idle reap 30 min.
Independent convergence on the same 60 s the notes cite from acpx.

herdr's own shutdown discipline is **SIGHUP → SIGTERM → SIGKILL at 250 ms grace each**, 20 ms poll,
targeting the whole terminal *session* by `getsid` match rather than just the child — not the
1500/1000 ms from acpx.

---

## 7. B1 — the config-root problem, corrected twice

**The narrowest lever exists and is documented in the tool itself.** `codex exec --ignore-user-config`
states verbatim that **auth still uses `CODEX_HOME`**. So ambient suppression no longer requires
redirecting the config root, and the defect the notes describe is avoidable rather than fixable.

Two caveats, both found by measurement:

- **`--ignore-user-config` does not suppress `$CODEX_HOME/AGENTS.md`**, which is leaking into workers
  on this machine today.
- **It deletes the `[hooks.state]` trust hashes**, which makes A5's trust step bite. The escape hatch
  is `--dangerously-bypass-hook-trust`, and it becomes *necessary* in combination.

**If a config root must be owned anyway** — for hooks, or to kill that `AGENTS.md` — the shipped
answer is a **shadow home**, and it is the inverse of what `BLOCKERS.md` proposes. From t3code's
`CodexHomeLayout.ts`: `CODEX_HOME` points at an overlay directory, and every entry of the real
`~/.codex` is **symlinked back into it** — `sessions`, `skills`, `plugins`, `cache`, `worktrees`,
`config.toml` — while `PRIVATE_ENTRY_NAMES = {auth.json, models_cache.json}` stay **real files** in
the overlay. Symlinking `auth.json` raises a hard error there, deliberately, because t3code *wants*
each instance to be a separate account.

**brigadier wants the opposite** — the same account, one login. So brigadier's variant is a
**write-through symlink for `auth.json`**: codex saves it with a truncating open, so a symlink writes
through and token refresh stays coherent. **A seeded copy, which `BLOCKERS.md` proposes, goes stale
at the next refresh.** Same structure, opposite decision on one entry, for a clearly stated reason.

**A new trap on the one vendor that already works:** `CLAUDE_CONFIG_DIR` loads hooks **but logs you
out** — it recreates B1 on Claude Code. Use **`--settings <file-or-JSON>`** instead, which was
measured to load hooks without disturbing credentials.

And a hard rule from t3code's own comment (`ClaudeHome.ts:29-33`): **never override `HOME`.** It
relocates the macOS login keychain lookup, and the spawned CLI reports "Not logged in."

---

## 8. Ruling 8, reconsidered

Ruling 8 — *never write into a file another product owns* — is what forces brigadier toward
system-settings-path redirection, and that redirection is what caused B1. It is worth asking what it
buys.

**The leading multiplexer does not observe it.** herdr writes a `hooks.SessionStart` entry directly
into the user's `~/.claude/settings.json`. It manages the real risk — clobbering — with engineering
rather than abstinence (`src/integration/claude_settings.rs:189-278`):

- a **CST-preserving jsonc rewrite** that keeps the user's comments and formatting
- **duplicate-key rejection**
- **verify-before-write**: the result is checked against an independently computed value
- **surgical uninstall** matching herdr's exact command strings
- **`HERDR_INTEGRATION_VERSION=N`** drift markers, and `# >>> herdr` marker blocks for TOML vendors
- no backups — the safety net is the verification, not a copy

And the mechanism that makes it safe to leave installed: **env-gated inert hooks.** herdr's hooks
exit immediately unless `HERDR_ENV=1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are all present. A
globally-installed hook is a **no-op in the user's ordinary sessions**, and only wakes up inside the
harness.

That last idea is worth taking regardless of what happens to ruling 8, because it removes the main
argument *for* it: the fear that an installed hook changes the user's plain CLI. It doesn't have to.

This is a decision for you, not a finding. But the current position is not free, and the cost has now
been paid once, visibly, as B1.

---

## 9. The two prior-art projects, in one paragraph each

**`pingdotgg/t3code`** — v0.0.36, HEAD today, 16 authors across 30 commits. A TypeScript monorepo: a
local server plus web, desktop and mobile clients that drive the user's *already-installed,
already-authenticated* CLIs. Not a terminal tool. **Four transports, chosen per vendor:** Claude via
the Agent SDK, Codex via app-server JSON-RPC, Cursor and Grok via ACP, OpenCode via a local HTTP
server that closes 30 s after its last borrower. Installs nothing into vendor config.

**`herdrdev/herdr`** — v0.8.2, HEAD today, 55 releases in five months. One Rust binary; a
tmux-shaped multiplexer with a resident server. **PTY only** — `portable-pty` pinned and vendored,
Ghostty's `libghostty-vt` for VT parsing. It owns the CLIs' *terminals* and observes them; it never
wraps them. It doesn't even spawn agents — `agent start` **types a shell command into an idle shell
pane**, and prompting is keystroke injection with a 300 ms delay before Enter, bracketed-paste only
if the child enabled DECSET 2004, and a synthetic focus-gained event first for Copilot. Live server
upgrades pass PTY master fds over `SCM_RIGHTS`.

**Nobody picks one transport.** Between them these two projects use five. The transport research's
"ACP primary, subprocess fallback" framing is a false binary; the answer is per-vendor, and the
supervision layer is what is shared.

**Neither proxies the model API.** `ANTHROPIC_BASE_URL` appears in t3code only as a *user-facing*
env var for OpenRouter and Claude-Code-Router setups, never as t3code's own interception layer. An
API-proxy wall is **unexplored, not validated prior art** — do not treat it as the stronger route on
the strength of these two.

### On the closed set

The notes' claim is **correct**, with more nuance than recorded. herdr's `Agent` is a compiled
23-variant Rust enum with hardcoded labels, executables and aliases, and its docs confirm a new agent
needs a binary update. But **detection rules are data**: a local override at
`~/.config/herdr/agent-detection/<agent>.toml` always wins, over a cached OTA manifest from
`herdr.dev`, over a bundled default — versioned, 256 KiB capped, engine-gated, traversal-validated,
hot-reloaded. And there are **two real escape hatches**: `HERDR_AGENT=<agent>` read from the child's
`environ`, and `pane.report_agent` over the socket with a free-form `source`, which lets anything
push state for a pane without a rebuild.

**A4 has a shipped answer.** t3code splits the identifier brigadier conflates
(`packages/contracts/src/providerInstance.ts`): `ProviderDriverKind` is *"intentionally an **open**
branded slug, not a closed literal union"* — an unknown driver **must parse successfully** and is
marked *unavailable* at runtime rather than crashing — and `ProviderInstanceId` is a user-defined
slug that threads, sessions and bindings reference instead. Instances are plain data, so a user
creates `codex_work` and `codex_personal` with independent env and homes, **with no rebuild**. The
open slug is deliberate: forks, branches and PRs leave persisted state referencing drivers a given
build has never heard of.

**And `HERDR_AGENT`-style env stamping applies directly:** since brigadier launches the CLI, it can
stamp its own identity into the child environment and read it back — strictly more reliable than
sniffing argv through sandbox wrappers.

---

## 10. Claims from 2026-08-28 that are now falsified or stale

| # | claim | status |
|---|---|---|
| A3 | `UserPromptSubmit` output no longer reaches the model | **false** on 2.1.251, with negative control |
| A7 | per-call hook cost could invalidate the wall | **~2× overstated**; HTTP hooks make it moot at 0.19 ms |
| A1 | one unrecognised event silently discards every hook in the file | **stale** — sibling hooks fired fine |
| A5 | Codex requires a user trust step | **real, but it fails silently open** — no prompt, no warning, tool ran. `--dangerously-bypass-hook-trust` exists |
| B1 | `CODEX_HOME` redirect is required for ambient suppression | **false** — `--ignore-user-config` exists and keeps auth on `CODEX_HOME` |
| B1 | seed a copy of `auth.json` into the owned root | **wrong shape** — copies go stale at refresh; symlink writes through |
| B3 | binary distributions are the route out of the npx fetch | **false** — `npx --offline` works; only 2 of 7 ship binaries |
| B4 | hooks are authoritative for liveness when installed | **contradicted by herdr**, which installs Claude/Codex hooks and denies them authority |
| — | claude and codex must be driven through npx bridges | **false for 5 of 6**; only Claude needs one |
| — | the five claude-code hang issues | **all closed**; none reproduce here |
| — | OpenCode has no ingest hook | **false** — five hooks, incl. `experimental.chat.messages.transform` |
| — | Copilot has an ingest wall and an output wall | **both false** — `modifiedPrompt` is SDK-only, `modifiedResponse` is subagent→parent |
| — | Cursor does ingest redaction, and `stop` is an output wall | **both false**; Cursor has no output wall |
| — | "output wall: at least 4" | **1** — Gemini `AfterModel` only |
| — | ACP registry has 25+ agents | **39** |
| — | Claude Code has 6 hook events, one type | **~14 events, five types** |
| — | author hooks in Claude Code shape and translate outward | Gemini's event names don't overlap at all — needs a real translator |
| — | `gemini hooks migrate` makes the work smaller | unverified as a load-bearing plan |

**New traps not in the notes:** `CLAUDE_CONFIG_DIR` loads hooks **but logs you out**; overriding
`HOME` breaks the macOS keychain; codex omits `"jsonrpc":"2.0"`; `--ignore-user-config` deletes the
hook trust state; `$CODEX_HOME/AGENTS.md` is not suppressed and leaks into workers today; the Copilot
npm bundle is a version behind the live Rust binary.

---

## 11. Still unverified

Stated plainly, because this document's whole point is not repeating the last one's confidence.

- **Qwen's wall, entirely** — a quota 403 blocked every session probe. The install path was measured
  and a hook did fire; nothing downstream of that was observed.
- **Cursor, entirely** — not installed here, and deliberately not installed.
- **Gemini's `AfterModel`** end-to-end to the user's screen — the one route to a rewriting output
  wall, still unproven.
- **Claude's plugin-directory hook path** — the original A3 symptom may be specific to it.
- **`CLAUDE_CODE_MANAGED_SETTINGS_PATH`** — never fired in testing.
- **Windows, anywhere.** Still never green, and Codex's `commandWindows` override means the wall has
  Windows behaviour that has never run.
- **Whether `--settings` survives a `claude` upgrade** as an install path.
- **Orphan reaping under the three-phase shutdown**, with a control case that leaks one.

---

## 12. Revised sequence

The old sequence began with A3 and A7 because both could invalidate the design. Both are resolved, so
it changes completely.

1. **Decide ruling 8**, because it determines everything below it. The redirection route costs a
   config-root problem per vendor; the direct-write route costs a CST merge and an uninstall path,
   and buys env-gated inert hooks. This is the only genuinely open question left.
2. **Adopt the two-mechanism wall.** Agent SDK `canUseTool` for workers brigadier drives; HTTP hooks
   against a resident process for bound interactive sessions. Neither spawns per call.
3. **Rewrite the transport table to native-first.** Five of six launch directly; only Claude keeps a
   bridge, warmed via `npx --offline`. Handle codex's missing `jsonrpc` member.
4. **Take codex's `thread/status/changed` as the liveness reference implementation**, then build the
   state latch, two-stage cancel and `agent_prompt_stalled`-vs-`timeout` distinction around it.
5. **Fix codex ambient suppression** with `--ignore-user-config` plus explicit `AGENTS.md` handling
   plus `--dangerously-bypass-hook-trust`; use the shadow home with a write-through `auth.json`
   symlink only if a root must be owned.
6. **Split `AgentId`** into an open driver slug and a user-defined instance id, per t3code.
7. **Correct the guide.** The output wall is one vendor, not four, and the ingest wall is five of
   seven. `brigadier-guide.md` currently promises a three-sided wall on every CLI.

---

## Sources

**Measured on this machine, 2026-08-30** — hook probes with firing negative controls; per-call timing
of `/bin/sh`, bash, a 61 MB `bun build --compile` binary, and loopback HTTP; ACP `initialize`
handshakes against gemini, qwen, copilot, opencode and codex; `claude -p` and `--output-format
stream-json` exit timing; `npx --offline` cold/warm; registry fetch.

**First-party** — [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
· [agentclientprotocol.com](https://agentclientprotocol.com/) ·
[openai/codex](https://github.com/openai/codex) and its generated protocol schema ·
[Codex hooks](https://developers.openai.com/codex/hooks) ·
[Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference) ·
[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) ·
[Qwen Code hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) ·
[OpenCode plugins](https://opencode.ai/docs/plugins/) ·
[Cursor hooks](https://cursor.com/docs/hooks) · shipped bundles of all six installed CLIs.

**Prior art, read as source** — [pingdotgg/t3code](https://github.com/pingdotgg/t3code) ·
[herdrdev/herdr](https://github.com/herdrdev/herdr) · [herdr docs](https://herdr.dev/docs/).

Supporting detail, with per-claim citations, is in the session scratchpad:
`findings-hooks.md` (830 lines) and `findings-transport.md` (824 lines, with the raw `registry.json`
and probe scripts alongside). The prior-art agent's report was blocked from writing to disk and
survives only in this session's transcript; its substance is folded into sections 4, 6, 8 and 9
above.
