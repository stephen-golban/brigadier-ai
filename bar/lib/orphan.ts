// SPDX-License-Identifier: Apache-2.0
/**
 * A fixture that does not outlive the run it belongs to.
 *
 * MEASURED on this host on 2026-08-17: two ACP vendor fixtures were found still
 * running at 98.7% and 100% CPU, `--brigadier-run` markers still in their
 * command lines, reparented to `launchd` after the harness reaped their
 * parents. `bar/lib/proc.ts` now spawns into its own process group and kills
 * the group, which closes the case where the harness is the one doing the
 * killing — but it cannot close every case, because the harness is not always
 * the killer. Item 7 SIGKILLs the orchestrator ON PURPOSE, and a fixture whose
 * only exit condition is "my stdin reached EOF" is at the mercy of whether the
 * dying parent's pipe was the last handle on it.
 *
 * So a fixture also watches for its own orphaning. On POSIX an orphan is
 * reparented, so a `ppid` that is no longer the one the process started under
 * is decisive: the process this fixture exists to serve is gone, and there is
 * nothing left for it to answer. MEASURED against bun 1.3.14 on 2026-08-18:
 * `process.ppid` re-reads `getppid()` on every access, going 6944 -> 1 within
 * one poll of the parent shell exiting.
 *
 * Windows has no reparenting, so the check never fires there and the group kill
 * (`taskkill /T`) remains the whole mechanism. That is stated rather than
 * hidden: this is a second line, not a replacement for the first.
 *
 * The escapee in `bar/fakes/vendor.ts` deliberately does NOT use this. Item 7
 * needs something that really does survive its parent, so that the product's
 * sweep has something real to reclaim.
 */

/** Poll interval. Short enough that a leak is measured in seconds, not minutes. */
const INTERVAL_MS = 1_000;

export function exitWhenOrphaned(label: string, intervalMs = INTERVAL_MS): void {
  const parent = process.ppid;
  // A parent of 1 at start-up means there is nothing to notice the loss of.
  if (parent <= 1) return;
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    process.stderr.write(`${label}: parent ${parent} is gone (now ${process.ppid}); exiting rather than leaking\n`);
    process.exit(0);
  }, intervalMs);
  // Unref'd on purpose: this must not be the reason a process stays alive, only
  // a reason it stops.
  timer.unref();
}
