> **SUPERSEDED — HISTORY ONLY. DO NOT TREAT ANY CLAIM IN THIS FILE AS INSTRUCTION.**
> Written before the 2026-08-30 verification pass and wrong in roughly 22 places.
> Current, trustworthy sources: `brigadier-verification-research.md` (2026-08-30) for the
> vendor measurements, and `docs/measurements.md` (2026-08-31) for everything measured
> while building. Kept only to show what was believed and how it was corrected.

# Can the ingest and action walls be built on every vendor?

**Researched 2026-08-28. Short answer: yes — and I was wrong to say otherwise.**

Every one of the six vendors brigadier drives now ships a hook system with tool-call interception.
Four of them shipped it during 2026. The wall is not a Claude Code exclusive.

**One thing to be clear about: brigadier's own source was not wrong.** `src/setup/launch.ts` measured
*possession* — the argv flags that inject a system prompt — and correctly found those on Claude Code
alone. Hooks are a different mechanism and were never measured on the other five. The gap was in
what got asked, not in the answer.

---

## The matrix

| vendor | hooks live in | ingest wall | action wall (can deny) | output wall |
|---|---|---|---|---|
| **Claude Code** | brigadier's **own plugin dir** | `UserPromptSubmit` | `PreToolUse` | `Stop` (block only) |
| **Codex CLI** | `~/.codex/hooks.json` or `config.toml` | `UserPromptSubmit` | `PreToolUse` — Bash, `apply_patch` edits, MCP calls | `Stop` |
| **Gemini CLI** | user/project `settings.json` | `BeforeAgent`, `BeforeModel` | `BeforeTool` (deny + modify args) | **`AfterModel` — modifies the response** |
| **Qwen Code** | user/project `settings.json` | `UserPromptSubmit` | `PreToolUse` | `Stop` (block) |
| **Copilot CLI** | **`~/.copilot/hooks/`** or `$COPILOT_HOME/hooks/` | `userPromptSubmitted` → `modifiedPrompt` | `preToolUse` (**fail-closed**) | `agentStop`, `subagentStop` → `modifiedResponse` |
| **OpenCode** | plugin directory | *(none documented)* | `tool.execute.before` (throw to block) | *(none documented)* |
| **Cursor CLI** | `.cursor/hooks.json` | redaction before the model | `beforeShellExecution` | `stop` |

**Action wall: 7 of 7.** Universal across the supported set.
**Ingest wall: 6 of 7.** Everything but OpenCode.
**Output wall: at least 4.**

---

## Correction: the output wall exists

I said standing between the model's prose and the user was impossible today. That was wrong.

- **Gemini CLI `AfterModel`** fires after the LLM response is received and can **modify the response
  chunk**. That is literally the third side of the wall.
- **Copilot `subagentStop`** returns `modifiedResponse`; `agentStop` can block a turn outright.
- **Qwen `Stop`** and **Claude `Stop`** can block a response from concluding, though neither rewrites
  it.

Gemini CLI has the richest surface of any of them — `BeforeModel` can modify the outgoing request or
inject a response, and `BeforeAgent` can discard a user's message entirely.

---

## The real blocker is not capability. It is ruling 8.

brigadier's standing rule is that it never writes into a file another product owns. That rule, not
the hook APIs, decides where this can go:

**Where brigadier can own the file**

- **Claude Code** — plugin directory. Already owned, already used.
- **Copilot CLI** — `~/.copilot/hooks/` is a *directory*, so brigadier drops in its own file without
  editing anyone's. Better still, `COPILOT_HOME` is a documented override, and **brigadier already
  sets that variable** for ambient suppression.
- **OpenCode** — plugin directory, same shape as Claude Code.

**Where it can, via a system-settings path override — SOLVED**

Gemini and Qwen looked unreachable, because hooks may only be defined in `settings.json` and
extension-hosted hooks were proposed as issue #14449 and **closed without shipping**. But both ship
an enterprise mechanism that fits brigadier exactly:

| vendor | variable | precedence |
|---|---|---|
| Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | **System > Workspace > User** |
| Qwen Code | `QWEN_CODE_SYSTEM_SETTINGS_PATH` | **System overrides user and project** |

brigadier points the variable at **its own settings file, in its own directory**, containing its own
hooks. The user's `~/.gemini/settings.json` and `~/.qwen/settings.json` are never read, never written,
never touched. Ruling 8 is intact — brigadier writes only a file it owns.

And it is a **stronger** wall than Claude Code's plugin hooks, because system settings sit at the
*top* of the precedence chain: a user cannot override them from their own scope. Qwen's own docs say
so directly — *"users cannot shrink the denylist from their own scope."*

The variable is set by brigadier's launcher shim, which is the mechanism brigadier already has. Note
that Gemini's own enterprise documentation independently recommends exactly this: *"deploy a wrapper
script or alias that ensures the environment variable is always set."*

**Where friction remains**

- **Codex CLI** — hooks live at `~/.codex/hooks.json` (or `config.toml`), plus repo-level equivalents.
  **Non-managed hooks require explicit review and trust before they run.** Managed hooks deployed by
  enterprise policy bypass that. So Codex is wall-able but costs the user a one-time trust step,
  unless the managed path is usable.

### The idea worth taking seriously

The config-root variables brigadier *already manipulates* for ambient suppression — `COPILOT_HOME`,
`CODEX_HOME`, `QWEN_HOME`, `OPENCODE_CONFIG_DIR` — are the same lever that would let brigadier own a
hooks directory.

Today brigadier points them at a throwaway directory to suppress ambient instruction files, and that
is exactly what logs Codex out, because the credential lives in the root being redirected.

Point them instead at a **brigadier-owned root** that contains brigadier's hooks *and* a seeded
credential, and three separate problems collapse into one mechanism:

1. ambient suppression — the root is brigadier's, so nothing of the user's is in it
2. hook ownership — brigadier's hooks are in a directory brigadier owns, ruling 8 intact
3. the Codex logout — the credential is seeded rather than hidden

That is one change addressing the ambient lever, the wall, and the open Codex authentication defect
at once.

---

## Caveats that matter

**CORRECTED 2026-08-28 — three claims here were wrong.** A third-party page reported Codex hooks as
experimental, disabled by default, Windows-unsupported, and Bash-only. The **primary source**
(`developers.openai.com/codex/hooks`, which 308-redirects to `learn.chatgpt.com/docs/hooks`) says the
opposite on every count:

- hooks are **enabled by default across platforms, including Windows** — there is even a
  `commandWindows` field for a Windows-specific command override
- they are **stable**, not experimental
- `PreToolUse` intercepts **Bash, file edits performed through `apply_patch`, MCP tool calls, and
  other local function tools** — including Write and Edit

This is a live demonstration of this repository's own rule: *do not trust a coordinate copied from
documentation; check the registry.* The wrong source was a blog, and it was wrong three times in one
sentence.

**Copilot's failure semantics are the strongest, and asymmetric.** Exit 2 always denies, *even if the
hook's stdout says allow*. Crashes and other non-zero exits also deny. But **timeouts fail open**.
That asymmetry is worth designing around rather than discovering.

**Copilot loads repo hooks too.** `.github/hooks/*.json` is read from the working directory
automatically. That means a cloned repository can ship hooks — worth knowing when brigadier is
cloning other people's projects into worker clones.

**Nothing here is a complete boundary.** Codex's own documentation says as much: hooks are a
guardrail, because the agent can often reach the same outcome through another tool path. A wall with
one door open is a wall with one door open.

---

## What must be measured before any of this is designed on

None of the above is a measurement on this machine. It is documentation, and this project's own rule
is that documentation is where wrong coordinates come from. Each of these needs a probe with a firing
negative control:

1. Does a denial **actually stop the tool**, per vendor, and what does the model see afterward?
2. Does ingest-side output **actually reach the model**, per vendor — the way it was proven for
   Claude Code's `UserPromptSubmit`?
3. Does Gemini's `AfterModel` modification **actually reach the user's screen**?
4. What does a pre-tool hook **cost per call**? It fires on every tool use, and shelling out to a
   64 MB binary hundreds of times per session may be the thing that decides the design.
5. Do Copilot's `~/.copilot/hooks/` and a redirected `COPILOT_HOME` both work, and which wins?

---

## The vendor set: closed at seven — DECIDED 2026-08-28

**claude, codex, copilot, qwen, opencode, gemini, cursor.**

The set is deliberately closed. The evidence for closing it is that
[herdr](https://github.com/herdrdev/herdr) — Rust-native, purpose-built, with a remote manifest
update channel already shipping — still states that *"completely new agent support requires a Herdr
binary update"*, and that remote manifests *"can only patch existing detection rules, not add
entirely new agents."* If a dedicated competitor cannot make the set open, the per-vendor knowledge
table is irreducible rather than a shortcut.

Cursor earns the seventh slot because it is the only candidate scoring on **both** axes below: listed
in the ACP registry (`cursor-agent acp` runs it as a protocol server) *and* carrying its own blocking
hooks (`beforeShellExecution`).

Ruled out: **OpenClaw** is an ACP *client*, not an agent — a competitor, not a target.
**Antigravity** has no CLI.

The one thing worth keeping from the open-set argument: **closed does not have to mean compiled-in.**
Today the set is closed in the *type system*:

```ts
export type AgentId = "claude" | "codex" | "copilot" | "qwen" | "opencode" | "gemini";
export const PROFILES: Record<AgentId, LaunchProfile> = { … };
```

Adding a vendor is a code change and a rebuild. `brigadier cursor` is an unknown command.

### Two axes the current design conflates

`AgentId` currently means two unrelated things at once, and separating them is most of the fix:

| | question | what it needs |
|---|---|---|
| **Drivable** | can brigadier hand this vendor work as a worker? | a launch coordinate it can speak ACP over |
| **Wall-able** | can brigadier constrain a *session* of this vendor? | a hooks location it can own, and event names |

These are independent. Cursor is very likely **wall-able but not drivable**. A future ACP agent could
be **drivable but not wall-able**. A machine with only Cursor still deserves a working brigadier —
every session walled — even if nothing can be fanned out to it.

### What can be discovered, and what cannot

Worth being honest about the limit, because "just scan the PC" doesn't reach all of it:

**Discoverable by scanning**
- which vendor binaries exist on `PATH`
- whether one completes an ACP handshake, and whether a session opens
- whether a hooks file is *accepted* — the probe technique already written for Claude Code
  (`probes/plugin-manifests.sh`): plant one event alone, read back what the vendor reports, with
  invented event names as the firing negative control

**Not discoverable**
- that Claude is driven through `npx @agentclientprotocol/claude-agent-acp` rather than by running
  `claude`. No scan produces that.
- where a given vendor keeps its hooks.

So an irreducible knowledge table remains. The fix is not to delete it — it is to stop letting it be
the **limit**.

### The shape that follows

**1. The table becomes data, not types.** Measurement discipline is preserved by citations in the
data, not by a compiled-in union. A shipped entry carries its measured version and ticket exactly as
now; nothing about the rigour changes.

**2. Adding the eighth vendor stays a data change.** Not a type change, not necessarily a release.
The set is curated and finite; the mechanism for extending it should not be the type checker.

**3. Seed the coordinates from the ACP registry.** The seven are all listed there, and it is
CI-verified and refreshed hourly. Treat it as the upstream for `command`/`args`/platform targets, and
keep `profiles.ts` for what the registry does not carry: lane policy, capabilities, measured caveats.

**4. The wall is probed per vendor, not assumed.** Which events a vendor accepts is exactly the kind
of fact that goes stale — and one third-party page in this very document was wrong about Codex three
times in one sentence. The matrix above is a starting hypothesis, not a configuration.

### The single-vendor case already works in principle

Nothing needs inventing for a one-vendor machine. Fan-out width is `min(independent items, RAM cap,
configured cap)` and is explicitly **not** capped by vendor count — three items on a Claude-only
machine get three Claude workers. Cross-vendor review degrades to same-vendor and **reports itself as
the weaker thing it is**, which was observed in a real run today.

So a machine with only one of the seven is already a supported machine, not a degraded one.

### Two findings that make the work smaller

**`gemini hooks migrate` — "Migrate hooks from Claude Code to Gemini CLI".** A first-party subcommand,
present on this machine. Google shipped a converter *from* Claude Code's hook format, which makes that
format the de facto standard. brigadier can author its hook definition once, in Claude Code shape, and
translate outward — rather than maintaining seven hand-written hook files.

**`qwen --safe-mode` disables all customisations — context files, hooks, extensions.** An honest hole
in any hook-based wall: the user can switch it off. Worth stating plainly rather than discovering, and
consistent with the position that hooks are a guardrail rather than a security boundary.

---

## Sources

- [Codex hooks — OpenAI Developers](https://developers.openai.com/codex/hooks)
- [Codex CLI hooks reference — PreToolUse/PostToolUse](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference)
- [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/)
- [Gemini CLI — writing hooks](https://geminicli.com/docs/hooks/writing-hooks/)
- [Gemini CLI issue #14449 — hook support in extensions](https://github.com/google-gemini/gemini-cli/issues/14449)
- [Qwen Code hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Using hooks with GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor 1.7 adds hooks for agent lifecycle control — InfoQ](https://www.infoq.com/news/2025/10/cursor-hooks/)
