// SPDX-License-Identifier: Apache-2.0
/**
 * Resolving a verify command BEFORE a single worker exists.
 *
 * Ruling 52 draws a line that v1 could not: a check that FAILED and a checker
 * that was never there are different facts with different remedies, and the
 * second one is knowable without spending anything. So this module answers one
 * question — *is the executable this command names actually on `PATH`, in the
 * environment the checker will run in?* — and it is called at plan validation,
 * before the base state is built, before a clone exists, before an agent is
 * spawned.
 *
 * Three properties are deliberate rather than incidental.
 *
 * **No shell.** The command is split on whitespace and the first token is
 * looked up. brigadier never hands a string to `sh -c`, so `verify: "rm -rf /
 * ; make test"` is a command called `rm` with five arguments rather than two
 * commands — and ruling 37 is the reason: the operator supplies this string,
 * and a supplied string that can start a second process is a capability nobody
 * granted. The cost is stated rather than hidden: pipelines and shell
 * redirection do not work, and a plan that needs them must name a script.
 *
 * **A path is checked as a path.** `./verify.sh` and `/usr/local/bin/check` are
 * not `PATH` lookups, and `Bun.which` does not resolve them. Treating a missing
 * script as "not on PATH" would send the operator to fix their `PATH` for a
 * file that simply is not there.
 *
 * **`unconfigured` is not a refusal.** Ruling 52 is explicit that a first-time
 * user with no verify command must still get a product that runs, so an absent
 * command resolves to `unconfigured` and is printed at full size beside the
 * blocking outcomes rather than omitted.
 *
 * WHAT THIS DOES NOT PROVE, and it is the honest boundary of a pre-flight
 * lookup: that the executable will still be there when the check runs, that it
 * is the same file, or that it will succeed. `PATH` can change under us and a
 * script can be replaced. The lookup removes one failure mode — a checker that
 * was never installed — and claims nothing about the rest.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type VerifyStatus =
  /** The executable was found. `resolved` is the entry that was found. */
  | "resolved"
  /** There is no verify command. Ruling 52: prints, does not block. */
  | "unconfigured"
  /** Named an executable nothing on this machine provides. Ruling 52's `not-run`. */
  | "missing";

export interface VerifyResolution {
  status: VerifyStatus;
  /** The command as argv, never as a shell string. Empty when unconfigured. */
  argv: readonly string[];
  /** The entry actually found, so a report can name it (ruling 46's habit). */
  resolved: string | null;
  /**
   * The remedy, in the operator's terms. Present only on `missing`, and it
   * names the token that failed rather than the whole command — a refusal that
   * says "your verify command is wrong" is arithmetic wearing prose.
   */
  refusal: string | null;
}

/**
 * argv from a plan's `verify` string.
 *
 * Whitespace only. There is no quoting layer here on purpose: a quoting layer
 * is a shell with fewer features, and the one thing a caller would reach for it
 * to do — a path with a space — is better served by pointing at a script.
 */
export function splitCommand(text: string): string[] {
  return text.split(/\s+/).filter((token) => token.length > 0);
}

/** Does this token name a location rather than a `PATH` entry? */
function isPathLike(token: string): boolean {
  return token.includes("/") || token.includes("\\") || isAbsolute(token);
}

function executableAt(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one verify command.
 *
 * `cwd` is where a relative path is resolved from, and it is the operator's
 * repository rather than brigadier's working directory: a plan that says
 * `./scripts/check` means the repository's script, and resolving it against
 * whatever directory the operator happened to be in would find a different file
 * or none at all.
 */
export function resolveVerify(
  command: string | undefined | null,
  cwd: string = process.cwd(),
): VerifyResolution {
  if (command === undefined || command === null || command.trim() === "") {
    return { status: "unconfigured", argv: [], resolved: null, refusal: null };
  }

  const argv = splitCommand(command);
  const head = argv[0];
  if (head === undefined) {
    return { status: "unconfigured", argv: [], resolved: null, refusal: null };
  }

  if (isPathLike(head)) {
    const path = isAbsolute(head) ? head : resolve(cwd, head);
    if (executableAt(path)) {
      return { status: "resolved", argv, resolved: path, refusal: null };
    }
    return {
      status: "missing",
      argv,
      resolved: null,
      refusal:
        `the verify command \`${command}\` names ${head}, and ${path} is not an executable ` +
        "file. This is a path rather than a PATH lookup, so the remedy is the file: create " +
        "it, or `chmod +x` it. Ruling 52 resolves this before a single worker exists, because " +
        "a clone spent to discover a missing checker is a clone spent learning something a " +
        "lookup already knew.",
    };
  }

  const found = Bun.which(head);
  if (found !== null) {
    return { status: "resolved", argv, resolved: found, refusal: null };
  }
  return {
    status: "missing",
    argv,
    resolved: null,
    refusal:
      `the verify command \`${command}\` starts with \`${head}\`, and nothing called ` +
      `\`${head}\` is on PATH in the environment this check would run in. Install it, or ` +
      "correct the spelling in the plan. Ruling 52: resolved at plan validation, before a " +
      "single worker exists — this is the operator's environment rather than any worker's " +
      "code, and no retry by any agent helps.",
  };
}
