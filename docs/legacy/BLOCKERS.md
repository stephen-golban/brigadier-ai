> **SUPERSEDED — HISTORY ONLY. DO NOT TREAT ANY CLAIM IN THIS FILE AS INSTRUCTION.**
> Written before the 2026-08-30 verification pass and wrong in roughly 22 places.
> Current, trustworthy sources: `brigadier-verification-research.md` (2026-08-30) for the
> vendor measurements, and `docs/measurements.md` (2026-08-31) for everything measured
> while building. Kept only to show what was believed and how it was corrected.

# Blockers and open research

**What stands between brigadier today and brigadier working across all seven supported vendors.**

Compiled 2026-08-28 from a live install-and-drive session on macOS 26.5.2 against
`v2.0.0-rc.5` (`01d8263`, binary sha256 `aa423c74…`), plus web research into every vendor's hook
surface. Findings marked **MEASURED** were observed on this machine that day. Findings marked
**READ** come from documentation and have not been driven here.

Supported set, decided 2026-08-28: **claude, codex, copilot, qwen, opencode, gemini, cursor.**

---

## A. Blocks the wall on seven vendors

### A1 — The hook floor gate refuses the two events the wall needs

`src/plugin/hooks.ts` permits only `PreCompact`, `UserPromptSubmit`, `SubagentStop` in
`FLOOR_HOOK_EVENTS`, and `eventsAboveFloor()` fails `bun run build` on anything else. **`PreToolUse`**
(the action wall) and **`SessionStart`** (automatic binding) are both measured as accepted by Claude
Code and both sit above the floor.

Raising the floor is a deliberate breaking change, by that file's own measurement: **one unrecognised
event silently discards every hook in the file** — `Hooks (3)` becomes `Hooks (0)`, no warning, no
error, zero exit. Anyone on an older `claude` loses the `PreCompact` nudge that works for them today.

**Unblocked by:** raising `HOOK_FLOOR_CLAUDE_VERSION` together with the new events, in one commit,
with `missingHooks` name-assertion promoted to load-bearing.

### A2 — There is no hook install path for six of the seven

`src/plugin/install.ts` writes two directories, both Claude-shaped. Every other vendor needs a
different target and a different format:

| vendor | target | ownable without breaking ruling 8? |
|---|---|---|
| Claude Code | plugin dir | yes — already done |
| Copilot CLI | `~/.copilot/hooks/`, or `$COPILOT_HOME/hooks/` | yes — a directory, and brigadier already sets that variable |
| OpenCode | plugin dir | yes |
| Cursor CLI | `.cursor/hooks.json` | needs checking — repo-level path |
| Codex | `~/.codex/hooks.json` or `config.toml` | yes, but see A5 |
| Gemini CLI | brigadier-owned file via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` | yes — **System > Workspace > User** |
| Qwen Code | brigadier-owned file via `QWEN_CODE_SYSTEM_SETTINGS_PATH` | yes — **System overrides user and project** |

The Gemini/Qwen route is *stronger* than Claude's, because system settings sit at the top of the
precedence chain and a user cannot override them from their own scope.

**Smaller than it looks:** `gemini hooks migrate` exists as a first-party subcommand — "Migrate hooks
from Claude Code to Gemini CLI". Claude Code's hook format is the de facto standard, so author once
in that shape and translate outward rather than hand-writing seven files.

### A3 — The one vendor already wired does not work

**MEASURED.** Same directory, same question, minutes apart:

- `brigadier claude -p …` → *"Yes, I'm wearing brigadier"*
- bare `claude -p …` → *"No — I'm the plain session assistant"*

The plugin is `✔ loaded` per `claude plugin list`, `brigadier` resolves on PATH, and the hook command
emits its line correctly when run by hand. The line still does not reach the model. `claude plugin
details brigadier` describes both hooks as *"harness-only — no model context cost"*, which is the
leading hypothesis: 2.1.250 may not inject `UserPromptSubmit` stdout as context. The plugin shape was
measured against 2.1.234.

**Caveat:** both probes used `-p`. `UserPromptSubmit` may behave differently there. The interactive
session observed the same day showed no engagement either, which is consistent but not proof.

**Why it is first:** adding six more delivery paths on top of a mechanism that has not been shown to
work multiplies an unverified assumption six ways.

### A4 — `AgentId` is a compiled union, and conflates two facts

```ts
export type AgentId = "claude" | "codex" | "copilot" | "qwen" | "opencode" | "gemini";
export const PROFILES: Record<AgentId, LaunchProfile> = { … };
```

Cursor cannot be added without a type change. Worse, one identifier now carries two independent
facts:

- **drivable** — can brigadier hand this work as a worker? (needs an ACP or subprocess coordinate)
- **wall-able** — can brigadier constrain a session of it? (needs an ownable hook location)

A vendor can be one and not the other. The set stays closed; the *enumeration* should be data.

### A5 — Codex requires a user trust step

**READ.** *"Before a non-managed hook can run, Codex requires you to review and trust the exact hook
definition."* Enterprise-managed hooks bypass this.

This is a setup-flow problem, not a code problem, and it needs an answer better than telling the user
to go trust something.

### A6 — `qwen --safe-mode` disables the wall

**MEASURED** in `qwen --help`: *"Disable all customizations (context files, hooks, extensions)."*
Unfixable, and consistent with hooks being a guardrail rather than a security boundary. It should be
stated, not discovered.

### A7 — Per-tool-call hook cost has never been measured

`PreToolUse` fires on **every** tool use, and the registered hook shells out to a 64 MB compiled
binary. At 80 ms a call and 200 calls a session that is 16 seconds of pure overhead.

**This single measurement could invalidate the action wall entirely.** If a spawned binary is too
slow, the answer is a resident process or a tiny native shim — a different architecture, not a
tweak. It is roughly an hour of work and it governs weeks of it.

---

## B. Blocks driving seven vendors

### B1 — Codex is undrivable under brigadier, on this machine

**MEASURED.** `codex login` succeeds and writes `~/.codex/auth.json`. `brigadier detect` still reports
`codex: -32000 Authentication required`.

Cause is documented in `src/agent/profiles.ts`: brigadier redirects `CODEX_HOME` for ambient
suppression, the OAuth credential lives inside the redirected root, so the worker is genuinely logged
out. Seeding `auth.json` into the redirected root restores login (measured by the project, not
seeded by it).

The documented remedy does not work either: `ambientSuppression: false` was set and codex remained
`unusable`, because `detect` is hard-wired `workerShaped` (`src/agent/detect.ts:157`) and
`src/agent/detect-cache.ts:423` rejects any cache entry not probed that way. So the remedy printed at
`src/cli.ts:1904` is unreachable.

**One change fixes three things.** Point the config-root variables at a **brigadier-owned root** that
contains brigadier's hooks *and* a seeded credential, instead of at a throwaway directory. That
resolves ambient suppression, hook ownership under ruling 8, and this auth defect together.

### B2 — Cursor is not integrated at all

No profile, no coordinate, no `brigadier cursor`. It is in the ACP registry (`cursor-agent acp` runs
it as a protocol server) and has its own blocking hooks (`beforeShellExecution`) — the only candidate
scoring on both axes, which is why it took the seventh slot.

### B3 — Bridged vendors fetch from the network on the spawn path

Open issue #66. `claude` and `codex` launch via `npx -y @agentclientprotocol/…`, so a spawn needs the
network and `detect` reports `claude at …/bin/npx (bridge launcher)`. The ACP Registry's
`distribution` entries — with platform targets and optional SHA-256 checksums — are the route out.

### B4 — There is no liveness signal

A silence watchdog cannot distinguish *thinking hard* from *hung*: both are no frames. That is why a
stalled worker burns its full wall-clock bound before anything notices.

Herdr's status-authority model is the fix, and it becomes free once A1/A2 are done: **lifecycle hooks
> protocol frames > process state > screen scrape**, one authority per agent, hooks authoritative
when installed and reporting `idle`/`working`/`blocked`.

Three details worth copying exactly:

1. **Wait on semantic state, not exit codes.** Claude Code's final `result` event is documented as
   both sometimes *missing* (#1920) and sometimes *followed by a hang* (#25629), so it cannot be the
   sole completion signal.
2. **Prompt-and-wait must be atomic.** Sending then subscribing is a race.
3. **Refuse to prompt a blocked agent.** Input delivered into a UI waiting on something else is
   silently swallowed — this is the "it got lost" failure.

---

## C. Correctness defects observed 2026-08-28

All MEASURED during one install-and-drive session.

| # | defect |
|---|---|
| C1 | `roles.reviewer` is never read; `roles.builder` only selects a planner/researcher. Neither restricts vendors for `run --plan`, though setup's output implies both govern who works |
| C2 | `--estimate` ignores `--review` — `review` appears nowhere in `src/queue/estimate.ts`, so any run with a reviewer is under-counted |
| C3 | The retained-clone detector reported a **concurrently running** run as abandoned and advised discharging it. Acting on that advice deletes a live run's working directories |
| C4 | That advice says *"discharge them explicitly"* — **no `discharge` command exists** |
| C5 | The unpriceable-vendor caveat fires on *admitted* vendors, not vendors that actually ran (opencode was never used and still triggered `LOWER BOUND`) |
| C6 | The ambient-suppression footer prints *"SUPPRESSED in workers by default"* unconditionally, even with `ambientSuppression: false` set |
| C7 | Retained clones reported as `0.06 MB` occupied **7.6 MB** on disk |
| C8 | `package.json` says `2.0.0-rc.4` while tag `v2.0.0-rc.5` points at that commit |
| C9 | `RULING-38-AMENDMENT.md`, cited at `src/agent/profiles.ts:402`, does not exist in the repo |

C3 is the one with teeth: following the printed remedy destroys running work.

---

## D. Project-level

- **No release is published.** The release workflow only creates drafts, and GitHub excludes drafts
  from `/releases/latest`, so `curl | sh` cannot resolve an asset. Building from source is the only
  route.
- **Windows has never been green**, and this matters more now: Codex hooks explicitly support Windows
  (there is a `commandWindows` override), so the wall has Windows behaviour that has never run.
- **The bar is self-reported.** No independent verifier has graded it.

---

## Needs research — measurements not yet taken

Everything about the wall is currently **READ**, not measured. This project's own rule is that
documentation is where wrong coordinates come from — and one third-party page in this research was
wrong about Codex three times in one sentence (claimed experimental, Windows-unsupported and
Bash-only; the primary source says stable, all platforms, and intercepting `apply_patch` and MCP
calls too).

Each of these needs a probe with a **firing negative control**:

1. **Does a `PreToolUse` denial actually stop the tool**, per vendor, and what does the model see
   afterward? Control: a hook that denies nothing, so a working wall is distinguishable from one that
   always passes.
2. **Does ingest-side hook output actually reach the model**, per vendor — the way it was proven for
   Claude Code's `UserPromptSubmit` against 2.1.238, and apparently no longer holds on 2.1.250 (A3).
3. **Does Gemini's `AfterModel` modification reach the user's screen?** This is the only measured
   route to an output-side wall that rewrites rather than blocks.
4. **What does a pre-tool hook cost per call?** (A7 — the measurement that could kill the design.)
5. **Do `~/.copilot/hooks/` and a redirected `COPILOT_HOME` both work, and which wins?**
6. **Do `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and `QWEN_CODE_SYSTEM_SETTINGS_PATH` actually load hooks
   from a brigadier-owned file**, and do they really outrank user settings?
7. **Fetch the ACP registry and diff its coordinates against `profiles.ts`** — do the three that were
   historically wrong agree now?
8. **Per vendor, per transport: what does a hang look like on the wire?** Silence, or a frame that
   never advances?
9. **Does three-phase shutdown (stdin → SIGTERM 1.5 s → SIGKILL 1 s) prevent orphans here?** Control:
   a case that leaks one.
10. **Does `claude -p` exit cleanly on this machine**, or reproduce #25629?

---

## Suggested sequence

1. **A3** — find out why the Claude hook does not reach the model. Everything in A rests on that
   mechanism working once.
2. **A7** — cheap, and it can invalidate the action wall before any of it is built.
3. **B1** — a live defect with a known fix, and the brigadier-owned-root idea closes auth, hook
   ownership and ambient suppression in one change.
4. **A1** — raise the hook floor deliberately, with the version bump and the name assertions.
5. **A2 + A4** — the install matrix and the profile refactor, together, because each needs the other.

C-group defects are independent of all of this and can be fixed at any time. **C3 should be fixed
early regardless of sequence**, because the current behaviour tells the operator to delete running
work.
