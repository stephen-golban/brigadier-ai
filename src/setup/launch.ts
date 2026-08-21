// SPDX-License-Identifier: Apache-2.0
/**
 * `brigadier claude` — the shim's other half, and the honest edge of it.
 *
 * Ruling 77 established that `claude --brigadier` cannot exist: MEASURED against
 * `claude 2.1.238` on 2026-08-21, it exits 1 with `error: unknown option
 * '--brigadier'`, against a `claude --help` control that exits 0. The vendor owns
 * its argv. So brigadier launches the vendor instead of the vendor launching
 * brigadier, and the injection rides on flags the vendor already publishes.
 *
 * MEASURED the same day with a firing negative control — an invented flag
 * reports `unknown option` while a real one reports `argument missing`:
 *
 *   --append-system-prompt-file <file>   exists
 *   --system-prompt-file <file>          exists
 *   --plugin-dir <path>                  exists  ("for this session only")
 *   --settings <file-or-json>            exists
 *   --brigadier-nonexistent              unknown option
 *
 * **Two of those are used and the choice between them matters.**
 * `--append-system-prompt-file` APPENDS; `--system-prompt-file` REPLACES. Using
 * the replacing one would delete Claude Code's own system prompt — every tool
 * instruction, every safety property, everything the vendor put there — and
 * substitute ours. brigadier is a hub that drives other people's agents (ruling
 * 9's whole reason for existing), and a hub that lobotomises its workers is a
 * competitor wearing a hub's name.
 *
 * `--plugin-dir` loads brigadier's plugin **for that session only**, so
 * possession works even where nothing was installed into `~/.claude/`. That is
 * D1's *"forceable per session regardless of the setting"* — a per-session flag
 * is precisely what that sentence describes, and it is stronger than ruling 8
 * requires rather than a concession to it.
 *
 * WHY ONLY CLAUDE CODE, said plainly rather than discovered. All four mechanisms
 * are measured on Claude Code and **none on the other five**. `PRODUCT.md` cuts
 * cross-vendor possession from v0.1 for exactly that reason, and the honest
 * behaviour for the other five is to launch them untouched and say once that the
 * trigger there is model discretion — which is what the shipped `SKILL.md` has
 * always said. Pretending otherwise would be a product claim with no measurement
 * under it, which is the thing this whole repository is arranged to prevent.
 */

import { join } from "node:path";
import { ALL_AGENT_IDS, type AgentId } from "../agent/profiles.ts";

/** Where the doctrine the shim injects is kept. Under ruling 61's root, never a temp dir. */
export function doctrinePath(root: string): string {
  return join(root, "possession.md");
}

/**
 * The vendors brigadier can possess at launch, and the ones it can only host.
 *
 * A list of one, and it is a list rather than a constant so the day a second is
 * measured, adding it is a data change beside the measurement that earned it.
 */
export const POSSESSABLE: readonly AgentId[] = ["claude"];

export interface LaunchPlan {
  /** The vendor's real binary, resolved on `PATH` — never brigadier's shim. */
  readonly command: string;
  readonly args: readonly string[];
  /** True when possession flags were added; false when the vendor is launched untouched. */
  readonly possessed: boolean;
  /** One line for stderr where possession is not available. Never on the possessed path. */
  readonly notice?: string;
}

export interface LaunchInput {
  readonly agent: AgentId;
  readonly userArgs: readonly string[];
  /** The vendor binary's absolute path, already resolved by the caller. */
  readonly binary: string;
  readonly pluginDirectory: string;
  readonly doctrine: string;
  readonly enabled: boolean;
}

/**
 * What to exec, decided before anything is spawned.
 *
 * **Injection flags go FIRST and the operator's arguments last.** Anything the
 * person typed must be able to win, because they are present and we are a
 * default — and because a shim that silently overrides an explicit flag is a
 * shim nobody can debug. It also means `brigadier claude --system-prompt-file
 * mine.md` does what the operator plainly meant.
 */
export function planLaunch(input: LaunchInput): LaunchPlan {
  if (!POSSESSABLE.includes(input.agent)) {
    return {
      command: input.binary,
      args: [...input.userArgs],
      possessed: false,
      notice:
        `brigadier: launching ${input.agent} untouched — possession is measured on Claude Code and ` +
        "nowhere else, so the trigger here is model discretion (the skill still applies).",
    };
  }
  if (!input.enabled) {
    return {
      command: input.binary,
      args: [...input.userArgs],
      possessed: false,
      notice: "brigadier: possession is turned off in config — launching claude untouched.",
    };
  }
  return {
    command: input.binary,
    args: [
      "--plugin-dir",
      input.pluginDirectory,
      // APPEND, never replace. See the module comment: replacing deletes the
      // vendor's own system prompt, and driving somebody else's agent means
      // leaving their agent intact.
      "--append-system-prompt-file",
      input.doctrine,
      ...input.userArgs,
    ],
    possessed: true,
  };
}

/**
 * brigadier's own flags, which must never reach the vendor's argv.
 *
 * FOUND by driving it: `brigadier claude --version --home /x --run-root /y`
 * forwarded `--home` and `--run-root` straight to `claude`, which owns its argv
 * and rejects an unknown option with exit 1 (MEASURED 2026-08-21 on
 * `claude 2.1.238`). It only looked fine because `--version` short-circuits
 * before argument validation — the probe passed for a reason unrelated to the
 * thing it was testing, which is the shape of a check that cannot fail.
 *
 * Each takes a value, so both the flag and the token after it are dropped.
 */
const BRIGADIER_LAUNCH_FLAGS: readonly string[] = ["--home", "--run-root"];

/**
 * The operator's arguments, with brigadier's own removed.
 *
 * Everything else passes through untouched, including flags brigadier has never
 * heard of: the vendor's argv is the vendor's, and a launcher that filters it to
 * a known list would break every flag the vendor adds after we last looked.
 */
export function vendorArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (BRIGADIER_LAUNCH_FLAGS.includes(arg)) {
      // Skip its value too — but only if there IS one that is not itself a flag,
      // so a trailing `--home` does not silently eat the vendor's next argument.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Is this argument a vendor brigadier knows how to launch? */
export function isAgentName(name: string | undefined): name is AgentId {
  return name !== undefined && (ALL_AGENT_IDS as readonly string[]).includes(name);
}

/**
 * The vendor's INTERACTIVE binary name — which is not what `profiles.ts` holds.
 *
 * A trap worth naming, because the wrong answer typechecks. `PROFILES[agent]`
 * carries the **ACP bridge** coordinate: for `claude` and `codex` that is
 * `npx`, because both are reached through a vendored bridge (ruling 4, ruling
 * 44). Launching `npx` when a person typed `brigadier claude` would start the
 * bridge's stdio protocol against a human, which produces a hang rather than an
 * error — the same failure shape ruling 69 records for a stale coordinate.
 *
 * The interactive CLI is the agent id itself, resolved on `PATH`. That is a
 * different fact about the same vendor, and it lives here rather than being
 * borrowed from a table that means something else.
 */
export function binaryNameFor(agent: AgentId): string {
  return agent;
}
