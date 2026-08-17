// SPDX-License-Identifier: Apache-2.0
/**
 * Where a run's directories live, and the length budget that constrains them.
 *
 * Ruling 61, completing decisions 7, 13, 15 and 19 — each of which specified
 * clone-per-item, a manifest, marker files and a pool, and none of which said
 * where any of it lives on disk.
 *
 * NOT a temp root, and this is measured rather than cautious. #41 measured the
 * Codex ACP bridge constructing its `workspaceWrite` sandbox with
 * `excludeTmpdirEnvVar: false` and `excludeSlashTmp: false`, so `/tmp` and
 * `$TMPDIR` are writable BY DESIGN — and a worker there wrote into another
 * clone's tracked file. Outside the temp roots the identical write is blocked.
 * The conventional home for scratch directories is precisely the region that
 * makes concurrent workers non-isolated, on the vendor whose sandbox is
 * otherwise the strongest.
 *
 * XDG state directories are deliberately not used. `$XDG_STATE_HOME/...` is
 * longer, Windows has no equivalent, and ruling 12 makes Windows first class —
 * one short shape across three platforms beats XDG conformance here, because
 * the cost of the longer path is measured (below) and the cost of the
 * non-conformance is taste.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Short on purpose: `r` rather than `runs`, a short run id, a bare item number.
 *
 * MEASURED path lengths against #5's budget (macOS/Windows, 2026-08-17):
 *
 *   /Users/stephen/.brigadier/r/a1b2c3/12                         37   (140 left)
 *   C:\Users\stephen\.brigadier\r\a1b2c3\12                       39   (138 left)
 *   C:\Users\stephen\AppData\Local\brigadier\runs\a1b2c3\item-12  60   (117 left)
 *   C:\Users\alexandra.hemmingway\.brigadier\r\a1b2c3\12          52   (125 left)
 *
 * The spread between shortest and longest is 23 characters — 13% of the entire
 * measured budget. That is why the naming is a ruling and not a preference.
 */
export const RUN_DIR = "r";

/**
 * #5 measured a clone target FAILING at 198 characters, with 177 the deepest
 * that worked, consumed from the inside by git's own paths.
 *
 * Honest about what this number is: 177 is a safe clone-target length FOR THE
 * REPOSITORY #5 USED. The 260-character ceiling is consumed by three things at
 * once — the run root, the repository's own longest path, and git's internals —
 * and the measurement does not separate them. So `PATH_MARGIN` below is a
 * stated judgement anchored to #5, not a measured constant.
 */
export const WINDOWS_PATH_CEILING = 260;
export const MEASURED_SAFE_CLONE_TARGET = 177;
export const PATH_MARGIN = 40;

/** Ruling 61. Per-machine configurable; the length check is what guarantees correctness. */
export function defaultRunRoot(env: Record<string, string | undefined> = process.env): string {
  if (process.platform === "win32") {
    const local = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(local, "brigadier");
  }
  return join(homedir(), ".brigadier");
}

export function itemDir(runRoot: string, runId: string, item: number): string {
  return join(runRoot, RUN_DIR, runId, String(item));
}

/**
 * Is this run root inside a temp region the sandbox exempts?
 *
 * Compared against the REAL paths by the caller — ruling 15's `realpath`
 * requirement is load-bearing here rather than decorative, because on macOS
 * `/var` is a symlink to `/private/var` and a lexical comparison of the run
 * root would silently judge against the wrong tree.
 */
export function isTempRooted(realRunRoot: string, realTempDirs: readonly string[]): boolean {
  return realTempDirs.some((tmp) => {
    const normalised = tmp.replace(/[/\\]+$/, "");
    return realRunRoot === normalised || realRunRoot.startsWith(normalised + "/") ||
      realRunRoot.startsWith(normalised + "\\");
  });
}

export interface FitVerdict {
  fits: boolean;
  /** The path that would be created, and would not fit. Named in the refusal. */
  worstPath?: string;
  budget: number;
}

/**
 * Ruling 61's refusal: a run is refused BEFORE anything is cloned if the
 * deepest path it would create will not fit.
 *
 * This is the session's fourth "find out before you spend" — ruling 52 resolves
 * the verify command on PATH before spawning, ruling 53 computes eligibility
 * over the whole ladder at plan validation, ruling 54 sizes fan-out up front.
 * The alternative is what MAX_PATH does naturally: fail partway through a clone
 * with a git error naming a path nobody chose.
 *
 * The refusal names the offending path and the run root, so the remedy — a
 * shorter root — is in the message rather than in a support thread.
 */
export function fitsBudget(
  runRoot: string,
  runId: string,
  item: number,
  longestTrackedPath: string,
): FitVerdict {
  if (process.platform !== "win32") return { fits: true, budget: Infinity };
  const dir = itemDir(runRoot, runId, item);
  const worst = join(dir, longestTrackedPath);
  const budget = WINDOWS_PATH_CEILING - PATH_MARGIN;
  return worst.length <= budget
    ? { fits: true, budget }
    : { fits: false, worstPath: worst, budget };
}
