// SPDX-License-Identifier: Apache-2.0
/**
 * Decision 17's ambient suppression, per vendor, and why it is no longer one
 * mechanism.
 *
 * Ruling 83. Until now there was exactly one lever — point the vendor's config
 * root at a directory brigadier owns, so the user-global instruction files under
 * `$HOME` are not there to be read. That lever works, and on the vendor this
 * project uses most it **takes the credential with it**.
 *
 * MEASURED 2026-08-21 against `claude 2.1.238` and
 * `@agentclientprotocol/claude-agent-acp 0.70.0` on macOS 26.5.2, each row
 * against a control that fires:
 *
 * | subject                                                  | result |
 * | -------------------------------------------------------- | ------ |
 * | bridge, no redirect                                       | `session/prompt` OK — the control |
 * | bridge, `CLAUDE_CONFIG_DIR` at an empty directory          | `session/new` OK, **`session/prompt` `-32000 Authentication required`** |
 * | + `.claude.json` seeded with `oauthAccount`/`userID`/`hasCompletedOnboarding` | the same failure |
 * | + the Keychain item written out as `.credentials.json`     | the same failure |
 * | CLI, redirect + a BYTE COPY of `~/.claude.json` + that file | `Not logged in · Please run /login`, against a no-redirect control that answered and exited 0 |
 *
 * **So seeding is not a mechanism that exists for this vendor on this
 * platform.** The credential is not a file: it is in the login Keychain, which
 * `CLAUDE_CONFIG_DIR` does not move. The only route would be writing a Keychain
 * item, which is outside every directory brigadier owns and is not removed by
 * ruling 26's *delete the directory*. That is the measurement behind ruling 83's
 * first half — **brigadier does not copy credentials** — and it is why that half
 * costs nothing here rather than being a sacrifice.
 *
 * **And the thing the redirect was for can be had without it.** Issue #1
 * recorded, on 2026-08-17, that the bridge passes
 * `--setting-sources=user,project,local` and called it *"a mechanism for
 * decision 17"*. Nobody used it. MEASURED 2026-08-21 through the real bridge,
 * with the argv captured from a shim rather than assumed:
 *
 * | | control (no shim) | subject (shim rewrites to `project,local`) |
 * | --- | --- | --- |
 * | an ACP worker asked to quote its `IMPORTANT` instructions | the operator's `~/.claude/CLAUDE.md` nonce **present** | **absent**, turn completed, no auth failure |
 *
 * So on Claude the lever is the vendor's own argv, reached through the
 * `CLAUDE_CODE_EXECUTABLE` seam ruling 44 already makes load-bearing, and the
 * config root is left alone.
 *
 * **WHAT THIS LEVER DOES NOT COVER, said here rather than discovered.** Dropping
 * the `user` source drops the operator's user-level settings, hooks and memory.
 * It does NOT drop the repository's own `CLAUDE.md`/`AGENTS.md` — that is the
 * `project` source, it is kept deliberately, and it is finding 114's third route
 * which ruling 59 closes with ruling 57's binary refusal rather than with
 * suppression. Nothing here changes that and nothing here may be read as
 * covering it.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LaunchProfile } from "./profiles.ts";

/**
 * The sources that survive. `user` is the one being dropped; `project` and
 * `local` are the repository's own, and a worker working in a repository is
 * supposed to read that repository's conventions.
 */
export const AMBIENT_KEEP_SOURCES = "project,local";

const FLAG = "--setting-sources";

/**
 * Rewrite one argv so the vendor loads no user-global source.
 *
 * **Append-if-absent, rewrite-if-present**, and the first half is the important
 * one: it is what keeps a bridge release that stops passing the flag from
 * silently restoring the operator's globals to every worker. The equals form is
 * the one MEASURED on bridge 0.70.0; the space form is handled because a CLI
 * that accepts one usually accepts the other, and a rewrite that missed it would
 * fail by doing nothing.
 */
export function rewriteSettingSources(argv: readonly string[]): string[] {
  const out: string[] = [];
  let found = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith(`${FLAG}=`)) {
      out.push(`${FLAG}=${AMBIENT_KEEP_SOURCES}`);
      found = true;
      continue;
    }
    if (arg === FLAG) {
      out.push(`${FLAG}=${AMBIENT_KEEP_SOURCES}`);
      // Its value, which is being replaced rather than kept.
      index += 1;
      found = true;
      continue;
    }
    out.push(arg);
  }
  if (!found) out.push(`${FLAG}=${AMBIENT_KEEP_SOURCES}`);
  return out;
}

/**
 * The shim, as text, with its target embedded rather than read from the
 * environment.
 *
 * Embedded because the shim is generated per run inside a directory brigadier
 * owns and swept with it: a self-contained file an operator can read is worth
 * more than one whose behaviour depends on what else is set. POSIX `sh` rather
 * than `bash` — `bash` is not guaranteed on every host, and this needs nothing
 * a shell without arrays cannot do.
 */
export function ambientShimScript(target: string): string {
  return [
    "#!/bin/sh",
    "# Generated by brigadier (ruling 83). Suppresses the operator's user-global",
    "# instruction files for ONE worker by rewriting the vendor's own argv, so the",
    "# credential — which does not live in the config root — is left where it is.",
    "found=0",
    "n=$#",
    "i=0",
    "while [ $i -lt $n ]; do",
    '  a="$1"; shift',
    '  case "$a" in',
    `    ${FLAG}=*) a="${FLAG}=${AMBIENT_KEEP_SOURCES}"; found=1 ;;`,
    // The space form: replace the flag and drop the value that follows it.
    `    ${FLAG}) a="${FLAG}=${AMBIENT_KEEP_SOURCES}"; found=1; shift; i=$((i+1)) ;;`,
    "  esac",
    '  set -- "$@" "$a"',
    "  i=$((i+1))",
    "done",
    `[ "$found" -eq 1 ] || set -- "$@" "${FLAG}=${AMBIENT_KEEP_SOURCES}"`,
    `exec ${JSON.stringify(target)} "$@"`,
    "",
  ].join("\n");
}

/** Write the shim where the run can reach it, and hand back its path. */
export function writeAmbientShim(path: string, target: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ambientShimScript(target));
  // Executable by its owner and nobody else. It is a file that decides what a
  // metered process runs.
  chmodSync(path, 0o700);
  return path;
}

/**
 * How ambient suppression is actually reached for one spawn.
 *
 * `configRoot` is what the caller should pass to `buildEnvironment`, `env` is
 * what it should add, and `note` is what the run record says. All three come
 * from one place because a run that suppressed nothing while recording that it
 * had is, to every reader and every bar item, a run that suppressed everything.
 */
export interface AmbientPlan {
  readonly configRoot?: string;
  readonly env: Record<string, string>;
  readonly note: string;
}

/** Which lever a vendor actually gets, and the sentence the run record carries. */
export interface AmbientDecision {
  readonly lever: "argv-shim" | "config-root" | "none";
  readonly note: string;
}

export interface AmbientConditions {
  /** The operator's setting. False means no lever is pulled at all. */
  readonly suppress: boolean;
  /** `process.platform`, injected so a test can drive win32 from darwin. */
  readonly platform: NodeJS.Platform;
  /** Whether a real vendor binary was found for the shim to exec. */
  readonly hasTarget: boolean;
}

/**
 * The decision, with nothing written and nothing spawned.
 *
 * Pure on purpose: the run report has to be able to say what each vendor got
 * WITHOUT having spawned it, and two functions computing that separately is how
 * a report starts describing a run that did not happen.
 */
export function ambientDecision(profile: LaunchProfile, conditions: AmbientConditions): AmbientDecision {
  const lever = profile.ambientLever;
  const hasConfigRoot = profile.configRootEnv !== undefined;

  if (!conditions.suppress) {
    return {
      lever: "none",
      note: `${profile.id}: ambient instructions NOT suppressed — the operator set \`ambientSuppression: false\``,
    };
  }

  if (lever?.kind === "argv-shim") {
    // Ruling 83 is measured on darwin against one bridge version. A `.sh` shim
    // does not run on Windows and nothing there has been driven, so that
    // platform keeps the behaviour it already had rather than gaining an
    // unmeasured one.
    if (conditions.platform === "win32") {
      return fallback(
        profile,
        hasConfigRoot,
        `${profile.id}: the argv lever (ruling 83) is UNMEASURED on win32, so the config-root redirect is used there`,
      );
    }
    if (!conditions.hasTarget) {
      return fallback(
        profile,
        hasConfigRoot,
        `${profile.id}: no ${lever.binary} binary was found for the argv shim to exec, so the config-root redirect is ` +
          "used instead — which is MEASURED to cost this vendor its credential at the metered call (ruling 83)",
      );
    }
    return {
      lever: "argv-shim",
      note:
        `${profile.id}: user-global sources dropped via ${FLAG}=${AMBIENT_KEEP_SOURCES}, injected through ` +
        `${lever.variable} (ruling 83). The config root is NOT redirected, because redirecting it was measured to ` +
        "fail the metered call. The repository's own project files still reach the worker.",
    };
  }

  if (hasConfigRoot) {
    return {
      lever: "config-root",
      note: `${profile.id}: the config root is redirected into brigadier's own state directory (${profile.configRootEnv}, decision 17)`,
    };
  }

  return {
    lever: "none",
    note:
      `${profile.id}: NO ambient lever exists — this launch profile declares neither an argv shim nor a config-root ` +
      "variable, so a user-global instruction file under $HOME is still readable by it. Stated rather than assumed " +
      "away: a suppression that did not happen must not be recorded as one.",
  };
}

function fallback(profile: LaunchProfile, hasConfigRoot: boolean, note: string): AmbientDecision {
  return hasConfigRoot ? { lever: "config-root", note } : { lever: "none", note };
}

export interface AmbientInputs {
  /** The operator's setting. False means no lever is pulled at all. */
  readonly suppress: boolean;
  /** A directory brigadier owns, for the redirect. */
  readonly ownedDir: string;
  /** Where the shim goes. Outside the worker's clone — see `spawn.ts`. */
  readonly shimPath: string;
  /** `process.platform`, injected so a test can drive win32 from darwin. */
  readonly platform: NodeJS.Platform;
  /** The real vendor binary the shim should exec. */
  readonly resolveTarget: () => string | null;
  /** Injected so a test does not write to disk. */
  readonly write?: (path: string, target: string) => string;
}

/** The decision, carried out: the shim written, the environment built. */
export function planAmbient(profile: LaunchProfile, inputs: AmbientInputs): AmbientPlan {
  const target = profile.ambientLever?.kind === "argv-shim" ? inputs.resolveTarget() : null;
  const decision = ambientDecision(profile, {
    suppress: inputs.suppress,
    platform: inputs.platform,
    hasTarget: target !== null,
  });

  if (decision.lever === "argv-shim" && target !== null && profile.ambientLever?.kind === "argv-shim") {
    const write = inputs.write ?? writeAmbientShim;
    return {
      // `configRoot` is deliberately absent. The whole of ruling 83 is that this
      // vendor's config root is left where the operator's credential expects it.
      env: { [profile.ambientLever.variable]: write(inputs.shimPath, target) },
      note: decision.note,
    };
  }
  if (decision.lever === "config-root") {
    return { configRoot: inputs.ownedDir, env: {}, note: decision.note };
  }
  return { env: {}, note: decision.note };
}

/** Where a run's Claude shim lives: beside the item directories, never inside one. */
export function ambientShimPath(runRoot: string, runId: string): string {
  return join(runRoot, "r", runId, "claude-exec-shim.sh");
}
