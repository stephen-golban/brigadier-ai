// SPDX-License-Identifier: Apache-2.0
/**
 * The two markers, which are different mechanisms for different jobs.
 *
 * Ruling 57 and ruling 38. Conflating them breaks one of the two, so they live
 * side by side here with the reason each exists.
 *
 * `BRIGADIER_WORKER` in the ENVIRONMENT makes brigadier's own plugin inert
 * inside a worker. Ruling 57 measured that every other layer is partial: a
 * config-root redirect exists on four of six vendors and not at all on Gemini
 * (#42); `~/.agents/skills/` has no override on ANY host, because ruling 42
 * measured it auto-discovered with no manifest and no install command — the
 * property that makes distribution effortless is the property that makes
 * suppression impossible; a Claude Code hook covers one host; and Agent Plugins
 * 1.0 has no hooks at all, by published charter. So the refusal below is the
 * only layer that holds once a model HAS read the doctrine and HAS decided to
 * delegate, which is v1's finding 114 and its unprovoked reproduction in #14.
 *
 * The RUN MARKER in the process COMMAND LINE is what ruling 38's reclamation
 * sweep matches on, and ruling 38 is explicit that it must be the command line
 * and never a name pattern. An environment variable is invisible to a sweep
 * scanning `ps` output; a command-line marker is invisible to a binary checking
 * `process.env`. Both are required and neither substitutes for the other.
 *
 * UNMEASURED, and named rather than absorbed: whether `BRIGADIER_WORKER`
 * actually reaches the shell an agent runs commands in. brigadier sets it on
 * the agent process; whether every vendor passes its environment through to
 * tool invocations rather than constructing a clean one has not been measured.
 * v1's `USER` finding is precisely a case where environment propagation behaved
 * unlike expectation and was found only by bisecting the real binary. This is
 * the most likely way ruling 57 is wrong, and it is BAR item 9's to settle.
 */

/** Ruling 57. v1's name, reused rather than re-derived. */
export const WORKER_MARKER = "BRIGADIER_WORKER";

/** Ruling 38. Goes in the command line of every process brigadier causes to exist. */
export const RUN_MARKER_FLAG = "--brigadier-run";

/**
 * Is this process running inside a worker?
 *
 * Read before anything else — v1's nudge hook read the marker before reading
 * stdin, and that detail is kept: a guard that has already begun processing
 * input is a guard with a failure mode.
 */
export function isInsideWorker(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[WORKER_MARKER];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * What the refusal says.
 *
 * It names the situation rather than scolding, because the reader is a model
 * that was following instructions it legitimately found on disk. v1's finding
 * 114: a worker given "write two markdown files" instead cloned the repo and
 * ran the orchestrator — twelve minutes, zero files, where the direct edit took
 * two.
 */
export const REFUSAL = `brigadier is already running: this session IS a brigadier worker.

Do the work directly. The task, its acceptance criteria and the paths you own
are in the brief you were given — that brief is the whole job.`;
