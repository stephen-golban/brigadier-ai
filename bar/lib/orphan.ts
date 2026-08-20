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
 * hidden: this is a second line, not a replacement for the first. `taskkill /T`
 * itself is UNMEASURED — `bar/lib/proc.test.ts`'s three arms that would drive it
 * now fail loudly on that platform rather than returning early (ruling of
 * 2026-08-20, `bar/lib/platform.ts`).
 *
 * The escapee in `bar/fakes/vendor.ts` deliberately does NOT use this. Item 7
 * needs something that really does survive its parent, so that the product's
 * sweep has something real to reclaim.
 */

/** Poll interval. Short enough that a leak is measured in seconds, not minutes. */
const INTERVAL_MS = 1_000;

/**
 * Written once, the moment the guard is armed, so a caller can WAIT for it.
 *
 * Ruling 62 (d) — bound the work, not the clock. `bar/lib/orphan.test.ts` used
 * to kill the parent as soon as the fixture's pid existed, which is true the
 * instant a shell backgrounds a process and long before `bun` has loaded a
 * module. That is a race, and the test lost it on CI while winning it on every
 * quiet machine. It now waits for this line.
 */
export const WATCHING_PREFIX = "watching parent";

export function exitWhenOrphaned(label: string, intervalMs = INTERVAL_MS): void {
  const parent = process.ppid;

  // ALREADY ORPHANED, WHICH IS NOT "NOTHING TO NOTICE".
  //
  // This branch used to `return`, on the reasoning that a parent of 1 at
  // start-up means there is nothing to notice the loss of. That reasoning holds
  // for a process init really started, and NOT ONE of these fixtures is: every
  // caller is spawned by brigadier or by a shell this harness wrote. A ppid of 1
  // here means the process it exists to serve died between the spawn and this
  // line — so the guard was never armed, and the fixture ran forever.
  //
  // MEASURED against `bun 1.3.14` under `oven/bun:1.3.14` on 2026-08-20,
  // `probes/orphan-race.ts`, killing the parent shell at a range of delays after
  // the fixture's pid appeared:
  //
  //     kill at    0 ms   SURVIVED the full 20 s, stderr EMPTY
  //     kill at   30 ms   exited after   999 ms
  //     kill at   80 ms   exited after   931 ms
  //     kill at  150 ms   exited after   884 ms
  //     kill at  400 ms   exited after   651 ms
  //     kill at 2000 ms   exited after    51 ms
  //
  // That is the signature `bar/lib/orphan.test.ts` failed with on CI three times
  // in twelve platform-runs: the FULL bound consumed (20,073 ms and 20,080 ms)
  // rather than a spread of times under it, which is what a merely slow machine
  // produces. It is the same shape as the zombie defect found on 2026-08-20 —
  // the predicate was right and its PRECONDITION was not.
  //
  // POSIX only. Windows has no reparenting, `process.ppid` there is the pid of a
  // parent that may already be dead, and this file's header already records that
  // the whole guard never fires there — so a fixture must not exit on a number
  // that means something else on that platform.
  if (parent <= 1) {
    if (process.platform === "win32") return;
    process.stderr.write(
      `${label}: started with no parent (ppid ${parent}); it died before this guard could be armed, ` +
        "so exiting rather than leaking\n",
    );
    process.exit(0);
  }

  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    process.stderr.write(`${label}: parent ${parent} is gone (now ${process.ppid}); exiting rather than leaking\n`);
    process.exit(0);
  }, intervalMs);
  // Unref'd on purpose: this must not be the reason a process stays alive, only
  // a reason it stops.
  timer.unref();
  // LAST, and after the timer exists: a caller that reads this line has to be
  // able to conclude the guard is armed, so it may not be printed by a path that
  // then fails to arm one.
  process.stderr.write(`${label}: ${WATCHING_PREFIX} ${parent}\n`);
}
