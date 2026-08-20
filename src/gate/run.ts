// SPDX-License-Identifier: Apache-2.0
/**
 * Running a verify command that has already been resolved, and turning what
 * happened into one of ruling 52's four outcomes.
 *
 * `verify.ts` answers *does this checker exist?* before anything is spent.
 * This module answers *what did it say?* after a worker has spent something,
 * and the two are separate because their lifetimes are: the lookup happens once
 * at plan validation, and this runs once per item and once more on the merged
 * commit.
 *
 * WHY THIS EXISTS AT ALL, said plainly: ruling 52 requires the operator's
 * verify command to be a BLOCKING CHECK PER ITEM, and until now
 * `PlannedItem.verify` was resolved at admission and then never executed. Only
 * the wave-level `--verify` ran. That is v1's failure with the halves swapped —
 * v1 ran a check and rendered its absence as a pass; this validated a checker
 * and never ran it, so every item's own gate was an `unconfigured` that nobody
 * had configured away. An item could declare `verify: bun test`, have the
 * command resolved on `PATH` before a single worker existed, and integrate
 * without it ever being run.
 *
 * THE FOUR OUTCOMES, USED AS RULING 52 DEFINES THEM, because their REMEDIES
 * differ and that is the whole reason there are four:
 *
 *   pass          exit 0
 *   fail          exit non-zero — the WORKER's to fix, and ruling 24's ladder
 *                 is the mechanism
 *   error         killed, timed out, or could not be started once the process
 *                 existed — the CHECKER broke, so re-run the CHECKER
 *   not-run       the executable was not there — the OPERATOR's environment,
 *                 and no retry by any agent helps
 *   unconfigured  the item declared no verify command. Does NOT block, and
 *                 prints in the same slot at the same size (ruling 52)
 *
 * NO SHELL, ONE PROCESS. `verify.ts` split the command on whitespace and never
 * handed it to `sh -c`; this spawns exactly that argv with `stdin: "ignore"`.
 * Ruling 37: the operator supplied this string, and a supplied string that can
 * start a second process is a capability nobody granted.
 *
 * NO RUN MARKER, AND THAT IS A KNOWN WEAKER GUARANTEE. Ruling 38 wants every
 * process brigadier causes to exist to carry `--brigadier-run=<id>/<item>` in
 * its command line, and this is the one place brigadier deliberately does not:
 * appending an argument to somebody else's command line corrupts it —
 * `bun test --brigadier-run=x` is not `bun test`. So the pid is returned to the
 * caller, the process is killed on its own timeout by the process that started
 * it, and `src/queue/execute.ts` records it as a weaker guarantee rather than
 * letting a reader assume the sweep covers it.
 */

import { INITIAL_OUTCOME, type CheckResult } from "../work/check.ts";
import type { VerifyResolution } from "./verify.ts";

/** How many lines of the checker's own output travel with a non-pass outcome. */
export const VERIFY_TAIL_LINES = 12;

/**
 * How long after the kill the drain is still given, before the wait is
 * abandoned and the pipes are reported as held. Generous on purpose: the common
 * case is a checker that forked nothing, where the streams close the instant the
 * child dies and this is never reached at all.
 */
export const DRAIN_GRACE_MS = 2_000;

export interface VerifyRunSpec {
  /** Already resolved by `resolveVerify`, at plan validation, before any worker. */
  resolution: VerifyResolution;
  /** Where it runs: the item's clone, after the worker has finished with it. */
  cwd: string;
  /** What the check is called in the report. `verify` per item; the gate has its own. */
  name: string;
  qualifier?: string;
  /** Ruling 52's `error`: a checker that never finishes has broken, not failed. */
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Ruling 38's hole, handed back rather than hidden: the pid of a process the
   * sweep cannot match on, so the caller can record it and say so.
   */
  onPid?: (pid: number) => void;
}

/**
 * The value written to the record BEFORE the command runs.
 *
 * Ruling 52's write-ahead. A crash between "started" and "finished" leaves a
 * BLOCKING `not-run` on disk rather than an absent field — there is no code
 * path in this module that produces "no result".
 */
export function initialVerifyCheck(name: string, qualifier?: string): CheckResult {
  return {
    name,
    outcome: INITIAL_OUTCOME,
    ...(qualifier === undefined ? {} : { qualifier }),
    detail: "written before the verify command started; if this is what you are reading, it never finished",
  };
}

/**
 * Ruling 52's `unconfigured`, at full size.
 *
 * A first-time user with no verify command must still get a product that runs,
 * so this does not block — which makes it the value most likely to become v1's
 * bug wearing a different noun. The remedy is not to hide it: it prints in the
 * same slot with the same prominence as a failure, and the detail says what was
 * not checked rather than congratulating anyone.
 */
export function unconfiguredVerify(name: string, qualifier?: string): CheckResult {
  return {
    name,
    outcome: "unconfigured",
    ...(qualifier === undefined ? {} : { qualifier }),
    detail:
      "this item declared no `verify` command, so nothing was run against its work. Ruling 52 " +
      "does not treat that as a failure and does not hide it either: an absent requirement and " +
      "an unmet one are different facts, and the difference in how loudly they print is not one " +
      "of them.",
  };
}

export async function runVerify(spec: VerifyRunSpec): Promise<CheckResult> {
  const { resolution, name } = spec;
  const qualifier = spec.qualifier === undefined ? {} : { qualifier: spec.qualifier };

  if (resolution.status === "unconfigured") return unconfiguredVerify(name, spec.qualifier);

  if (resolution.status === "missing" || resolution.resolved === null) {
    // Ruling 52's `not-run`: the operator's environment, and no retry helps.
    // Reachable only if `PATH` changed between plan validation and here — which
    // `verify.ts` says out loud is exactly what a pre-flight lookup does not
    // prove.
    return {
      name,
      outcome: "not-run",
      ...qualifier,
      detail:
        resolution.refusal ??
        `\`${resolution.argv.join(" ")}\` names an executable that is not there. Resolved at plan ` +
          "validation and gone by the time it ran, so nothing was checked.",
    };
  }

  const rendered = resolution.argv.join(" ");
  const argv = [resolution.resolved, ...resolution.argv.slice(1)];
  let child;
  try {
    child = Bun.spawn(argv, {
      cwd: spec.cwd,
      // No stdin. A checker that blocks reading a terminal that is not there is
      // a checker that hangs until the timeout, and the timeout renders as
      // `error` — which would be true but useless.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...spec.env },
    });
  } catch (cause) {
    return {
      name,
      outcome: "not-run",
      ...qualifier,
      detail: `\`${rendered}\` could not be started in ${spec.cwd}: ${String(cause)}`,
    };
  }
  spec.onPid?.(child.pid);

  let timedOut = false;
  const timer =
    spec.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, spec.timeoutMs);

  // THE DEADLINE HAS TO BIND THE *WAIT*, NOT ONLY THE CHILD, and until
  // 2026-08-20 it bound only the child.
  //
  // `child.kill` reaches the process brigadier started. A checker that FORKED
  // leaves a grandchild holding the stdout and stderr pipes it inherited, so
  // `new Response(child.stdout).text()` does not resolve until that grandchild
  // exits on its own — and awaiting it was the whole of the wait. The reported
  // outcome was still `error`, correctly; the BOUND was not enforced at all.
  //
  // MEASURED against `bun 1.3.14` on 2026-08-20, `sh -c "sleep 30"` killed at
  // 400 ms, on both platforms:
  //
  //   linux (oven/bun:1.3.14, dash)  `sh` FORKS — `ps` shows `sh -c sleep 30`
  //       AND a separate `sleep 30` beneath it. Killing the `sh` leaves the
  //       `sleep` holding the pipes: the streams resolved after **30,010 ms**
  //       against a 400 ms timeout. A 75× overrun.
  //   darwin 25.5.0                  `sh` EXECS `sleep` — there is no second
  //       process — so the kill reaches everything: **718 ms**.
  //
  // Which is why `test/integrate.test.ts`'s ruling-52 outcomes test timed out on
  // ubuntu-latest and passed here, and why a real verify command — `npm test`,
  // `bun test`, any shell script — would hang brigadier's integration gate for
  // the grandchild's whole lifetime on Linux. Ruling 12 makes that first class.
  //
  // So the drain is raced against the deadline plus a grace. The grandchild is
  // NOT chased here: reclaiming a process that outlived its parent is ruling
  // 38's sweep, which is the containment mechanism precisely because a kill on
  // one pid cannot be it. What this owes the operator instead is to SAY the
  // pipes were still held, so an empty tail is never read as a silent checker.
  const drain = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const drained =
    spec.timeoutMs === undefined
      ? await drain
      : await Promise.race([drain, Bun.sleep(spec.timeoutMs + DRAIN_GRACE_MS).then(() => null)]);
  const pipesHeld = drained === null;
  const [stdout, stderr] = drained ?? ["", ""];
  // Bounded by the SIGKILL above, which the direct child cannot survive.
  const code = await child.exited;
  if (timer !== null) clearTimeout(timer);

  const tail = `${stdout}${stderr}`.trim().split("\n").slice(-VERIFY_TAIL_LINES).join("\n");

  if (timedOut) {
    return {
      name,
      outcome: "error",
      ...qualifier,
      detail:
        `\`${rendered}\` was killed after ${spec.timeoutMs} ms. Ruling 52: a checker that was ` +
        "killed is `error`, not `fail` — the remedy is to re-run the checker, and sending a " +
        `builder to fix a defect that is not in its code burns a rung of ruling 24's ladder.` +
        (pipesHeld
          ? `\nIts output could NOT be read: something it started outlived it and still held the ` +
            `stdout/stderr pipes ${DRAIN_GRACE_MS} ms after the kill, so the tail below is empty ` +
            `because it was UNREADABLE, not because the checker was silent. That process is ruling ` +
            `38's sweep to reclaim, not this one's.`
          : "") +
        `\n${tail}`,
    };
  }
  if (code === 0) {
    return {
      name,
      outcome: "pass",
      ...qualifier,
      detail: `\`${rendered}\` exited 0 in ${spec.cwd}`,
    };
  }
  return {
    name,
    outcome: "fail",
    ...qualifier,
    detail:
      `\`${rendered}\` exited ${code}. This is the WORKER's to fix — ruling 52's \`fail\`, which is ` +
      `why it is not \`error\` — and the item does not reach the integration branch.\n${tail}`,
  };
}
