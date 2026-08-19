// SPDX-License-Identifier: Apache-2.0
/**
 * Item 7 — An interruption leaves nothing behind, including what escaped.
 *
 * Rulings 15, 38, 5, 63.
 *
 * The first draft of this item **could never pass**. It carried a literal
 * `checks.expect(..., false, ...)` and a hardcoded `outcome: "FAIL"` on the live
 * path, and `judgeInterrupt` — exported, unit-tested, carefully written — was
 * called by nothing. An item that cannot pass is indistinguishable from a
 * product that cannot satisfy it, which is the same class of defect as an item
 * that cannot fail.
 *
 * It is now driven for real, in this order:
 *
 *   1. start a run whose second item detaches a descendant. The descendant
 *      appends to a HEARTBEAT file every 200 ms, which is what makes "still
 *      running" observable without asking anyone;
 *   2. wait until a clone exists and the first item has committed real work;
 *   3. `SIGKILL` the orchestrator — not `SIGTERM`, so no handler can tidy up —
 *      and then READ THE PROCESS TABLE for the descendant, because whether it
 *      escaped is a fact about its `ppid`, its process group and its command
 *      line rather than something the fixture may be trusted about;
 *   4. start again, and let ruling 38's sweep run. The heartbeat must STOP
 *      growing: a file that is still being written to is a process that is still
 *      able to act, and no report can make it otherwise;
 *   5. assert ruling 63's other direction — the clone that had COMMITTED work is
 *      still on disk, reported with its path and its bytes, AND STILL HOLDS THE
 *      BYTES. v1's finding 92 is the precedent: an external signal killed a
 *      supervisor, both workers had done real work, and it was unrecoverable;
 *   6. send two `SIGINT`s and check the WAIT STATUS, not a printed line. A
 *      second interrupt during the drain must re-raise the signal rather than
 *      exit with an invented code, so the process is genuinely
 *      signal-terminated;
 *   7. REAP, AND THEN CLASSIFY WHAT SURVIVED THE REAP. This item is the only one
 *      whose fixture must outlive its parent, so it is the only one that can
 *      leave a process on the operator's machine, and `bar/run.ts` deletes the
 *      workdir the moment it returns — taking away the directory the next sweep
 *      would have found it by. What had to be killed is reported, never
 *      swallowed: the harness cleaning up after the product is a finding about
 *      the product. And what SURVIVED the kill is a CHECK rather than a
 *      sentence, because until 2026-08-19 it was a `did` line, and `did` stamps
 *      nothing: the harness could leak a process past its own SIGKILL, say so,
 *      and still report PASS. Not a count, though — ruling 63 REQUIRES the
 *      abandoned run to leave its workers behind. Every survivor is filed under
 *      a named class carrying its reason and anything unrecognised fails; see
 *      `survivorClasses` below.
 *
 * WHAT THIS ITEM DELIBERATELY DOES NOT DEMAND. RECORDED IN `BAR.md`, item 7,
 * under *RECORDED 2026-08-20 — amendment §18* — which is where it now lives and
 * where the reader should be sent. This comment cited "amendment §18" from the
 * day it was written and NO SUCH SECTION EXISTED anywhere in the tree; the owner
 * ruled on 2026-08-20 that a limit only present in the head of the item it
 * limits is not in the open, and had it written into `BAR.md` following that
 * file's own *When an item cannot be met* procedure — which item, why, and what
 * promise is therefore unproven. Nothing about the product or about what this
 * item asserts changed with that ruling. Ruling 38 says
 * every process brigadier causes to exist carries a marker in its COMMAND LINE,
 * and the operator's verify command structurally cannot: appending an argument
 * corrupts it — `bun test --brigadier-run=x` is not `bun test`. It is killed on
 * its own timeout by the process that started it, which is a **strictly weaker**
 * guarantee and fails in exactly the case this item drives, where the starter is
 * SIGKILLed. A check demanding the marker there would fail against a correct
 * product, so this item reports the weakness as a weakness rather than as an
 * absence or as an equivalence.
 *
 * Ruling 38 promoted the sweep from crash recovery to THE containment mechanism
 * precisely because the job object is opt-out by design and brigadier cannot fix
 * it. An item that only killed a well-behaved child would pass on a product that
 * leaks every real one.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { derive, nonce } from "../lib/derive.ts";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir, listTree } from "../lib/fs.ts";
import { cloneDirsUnder, productRunDir } from "../lib/layout.ts";
import { makeRepo, plantSeeds } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { RUN_MARKER_FLAG, isAlive } from "../lib/inflight.ts";
import { classifySurvivors, reap, survivorVerdict, type SurvivorClass } from "../lib/item7-processes.ts";
import { findProcess, nameProcess, readProcessTable, type ProcessFacts } from "../lib/process-table.ts";
import { writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/** One clone directory as it stood after the sweep, with what git says is in it. */
export interface CloneOnDisk {
  path: string;
  hadCommits: boolean;
  bytes: number;
  /**
   * The value read OUT of the clone's committed tree, or null.
   *
   * The whole of ruling 63's second direction. A directory that still EXISTS
   * with the right name satisfies a path check while holding nothing; finding 92
   * is about work being unrecoverable, and work is bytes.
   */
  committedValue: string | null;
}

/**
 * The heartbeat, read four times, because the obvious two-reading version is a
 * race and it fired as one.
 *
 * A descendant ticking every 200 ms will land another tick between "read the
 * size" and "the sweep's `kill` actually arrives", so `after === before` is not
 * the property. The property is in two parts, and each needs its own pair of
 * readings: it kept writing after the orchestrator died (so something really
 * escaped), and it stopped writing after the sweep (so the sweep really reached
 * it). The second is measured across four tick intervals, which a live process
 * cannot sit through silently.
 */
export interface InterruptObservations {
  /** Size when the orchestrator was SIGKILLed. */
  heartbeatAtKill: number;
  /** Size after a settle window. Greater than `atKill` means it outlived its parent. */
  heartbeatBeforeSweep: number;
  /** First reading after the sweep. */
  heartbeatAfterSweep: number;
  /** Read again four tick intervals later. Equal means it has genuinely stopped. */
  heartbeatSettled: number;
  /**
   * The escapee's own pid, and whether it was alive at each stage.
   *
   * File sizes are a proxy and this is the fact. A descendant that quietly died
   * on its own reads exactly like a successful sweep on sizes alone — which it
   * did, and a forger with no sweep at all passed on it.
   */
  escapeePid: number;
  /**
   * The escapee's own row in the process table, read AFTER the orchestrator was
   * killed.
   *
   * Present so that "it escaped" is measured rather than asserted. The fixture
   * asks for `setsid`, and `bar/fakes/vendor.ts` falls back to `nohup` where
   * `setsid` is absent — which is every macOS host. The two differ, and an item
   * that printed the first while running the second would be describing a
   * mechanism it never checked.
   */
  escapee: ProcessFacts | null;
  /** Was the escapee's parent still in the process table? Link 2's other half. */
  escapeeParentAlive: boolean;
  aliveBeforeSweep: boolean;
  aliveAfterSweep: boolean;
  /** Did the run reach the state where a signal means "drain" rather than "die"? */
  interruptInFlight: boolean;
  /** Did the orchestrator SURVIVE the first interrupt long enough to drain? */
  survivedFirstInterrupt: boolean;
  /** Clone paths this item SAW while the interrupted run was live. The denominator. */
  clonesAtKill: string[];
  /** Clone directories of THAT RUN still present after the sweep. */
  survivingClones: CloneOnDisk[];
  /** The derivation only obtainable from inside the clone. */
  expectedCommittedValue: string;
  /** What the next start TOLD the operator: its stdout and its stderr. */
  reportAfterSweep: string;
  /**
   * What the next start WROTE DOWN: every run record under the shared run root.
   *
   * A second home for ruling 63's fourth fact, and not a softening of it.
   * `describeStartSweep`'s `reclaimed pid …` lines travel as the report's
   * `detail`, and `src/report/budget.ts` DROPS `detail` entirely for the
   * `host-session` audience that `src/cli.ts` defaults to — so a pid check
   * against stdout alone fails against a correct product run the ordinary way.
   * `BAR.md` asks that the run manifest say what happened; this is where it says
   * it, and the item drives the second run with `--audience terminal` as well so
   * that a product which only ever writes it to disk is still distinguishable
   * from one that never names the pid at all.
   */
  recordAfterSweep: string;
  /** The wait status of the second interrupt. `signal` must be set, not a code. */
  secondInterrupt: { code: number | null; signal: string | null; timedOut: boolean };
}

/**
 * Does `text` name this pid on a line that is talking about pids?
 *
 * A bare number search would be satisfied by a byte count or a timestamp, and a
 * check a coincidence can pass is not a check. `loose` widens the word to cover
 * a record's field names — `reclaimedPids`, `unconfirmedPids` — which a `\bpid\b`
 * boundary deliberately excludes in prose.
 */
export function namesPid(text: string, pid: number, loose = false): boolean {
  if (pid <= 0) return false;
  const digits = new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`);
  if (!loose) return text.split("\n").some((line) => /\bpid\b/i.test(line) && digits.test(line));
  // The record is minified NDJSON, where a whole event is ONE line — so "the
  // number appears on a line that also says `pid`" is satisfied by a byte count
  // sharing a line with an EMPTY `reclaimedPids: []`. The number has to be
  // inside a pid-bearing FIELD, and `survivors` is included because that is
  // where a pid the sweep could not confirm dead is recorded.
  for (const field of text.matchAll(/"(\w*pids?|survivors)"\s*:\s*(\[[^\]]*\]|\d+)/gi)) {
    if (digits.test(field[2] ?? "")) return true;
  }
  return false;
}

/**
 * The byte figure the REPORT gives for this path, or null.
 *
 * Ruling 63 says a retained clone is reported *with its path and its bytes*, and
 * the item used to check the path against the report and the bytes against its
 * own `stat` calls — so a product that printed the path and no size at all
 * passed the "with its bytes" half on a number the harness had computed for
 * itself. This reads the number out of the product's own line.
 */
export function reportedBytesFor(report: string, path: string): number | null {
  for (const line of report.split("\n")) {
    if (!line.includes(path)) continue;
    const match = /([\d,]+)\s*bytes/.exec(line);
    if (match?.[1] === undefined) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function judgeInterrupt(o: InterruptObservations): Checks {
  const checks = new Checks();

  // The escaped descendant, asserted on its PID and on the bytes it is or is not
  // still writing. The pid is the decisive one: a descendant that self-terminated
  // reads exactly like a successful sweep on file sizes alone.
  checks.expect(
    "a descendant really escaped and was STILL ALIVE when the sweep started",
    o.escapeePid > 0 && o.aliveBeforeSweep && o.heartbeatBeforeSweep > o.heartbeatAtKill,
    `escapee pid ${o.escapeePid || "NONE PUBLISHED"}; alive before the sweep: ${o.aliveBeforeSweep}; ` +
      `heartbeat ${o.heartbeatAtKill} -> ${o.heartbeatBeforeSweep} bytes across the settle window. ` +
      "Without this, the check below passes on a descendant that died by itself — or never existed",
  );

  // RULING 38'S FIRST TWO LINKS, CUT — which is what makes the third one the
  // thing under test. The marker cannot reach a process an AGENT spawned, and
  // the ppid graph cannot reach one whose parent is gone. A descendant that
  // failed either of these would be reclaimable by a product that implements
  // neither the working-directory link nor a start sweep, and item 7 would pass
  // on it.
  const marked = o.escapee !== null && o.escapee.commandLine.includes(RUN_MARKER_FLAG);
  const orphaned = o.escapee !== null && (o.escapee.ppid <= 1 || !o.escapeeParentAlive);
  const ownSession = o.escapee !== null && o.escapee.pgid > 0 && o.escapee.pgid === o.escapee.pid;
  checks.expect(
    "the descendant defeated ruling 38's first two links: UNMARKED, and off the ppid graph",
    o.escapee !== null && !marked && orphaned,
    o.escapee === null
      ? `pid ${o.escapeePid} was not in the process table when it was read — nothing can be said about how it escaped`
      : `${nameProcess(o.escapee)}; carries ${RUN_MARKER_FLAG}: ${marked} (must be false — brigadier cannot write an ` +
        `agent's child's argv); parent still in the table: ${o.escapeeParentAlive}. ` +
        `Process group: ${o.escapee.pgid || "not reported on this platform"} — ` +
        (ownSession
          ? "it leads its own group, so it left the group the product's fast-path kill targets (setsid)"
          : "it did NOT leave its parent's process group, so a group kill from a LIVE orchestrator would still " +
            "have caught it; what this item measures is therefore the sweep, not the group escape. " +
            "`bar/fakes/vendor.ts` falls back to `nohup` where `setsid` is absent, which is every macOS host"),
  );

  checks.expect(
    "the next start's sweep reclaimed it (ruling 38)",
    !o.aliveAfterSweep && o.heartbeatSettled === o.heartbeatAfterSweep,
    `kill(${o.escapeePid}, 0) after the sweep: ${o.aliveAfterSweep ? "STILL ALIVE" : "gone"}; ` +
      `heartbeat ${o.heartbeatAfterSweep} -> ${o.heartbeatSettled} bytes four tick intervals later`,
  );

  // Ruling 63's fourth fact: the exact pids. A sweep that kills silently leaves
  // an operator with no way to tell it from a sweep that found nothing, and the
  // pid is the only remedy anyone can act on.
  const toldTheOperator = namesPid(o.reportAfterSweep, o.escapeePid);
  const wroteItDown = namesPid(o.recordAfterSweep, o.escapeePid, true);
  checks.expect(
    "the sweep NAMED the pid it reclaimed (ruling 63)",
    o.escapeePid > 0 && (toldTheOperator || wroteItDown),
    `pid ${o.escapeePid}: named on a pid-bearing line of the next start's own output: ${toldTheOperator}; ` +
      `present in the run records on disk: ${wroteItDown}. A sweep that kills silently is indistinguishable ` +
      `from one that found nothing, and the pid is the only remedy an operator can act on. Report said: ${excerpt(o.reportAfterSweep, 200)}`,
  );

  checks.expect(
    "the orchestrator SURVIVED the first interrupt to drain (ruling 63)",
    o.interruptInFlight && o.survivedFirstInterrupt,
    !o.interruptInFlight
      ? "this item never got that run in flight before signalling it — a signal arriving before the first clone " +
        "is defined to exit immediately, so nothing here is a statement about the product. A scheduling failure of this item"
      : o.survivedFirstInterrupt
        ? "still running a beat after the first SIGINT, so there was a drain for a second signal to arrive during"
        : "died on the first signal — which is indistinguishable from having no handler at all, and a binary with none satisfies the re-raise check for free",
  );

  // THE DENOMINATOR. `filter(...).length === 0` over an empty list passes, and
  // the list was empty for nine rounds because this item enumerated a path shape
  // the product does not use. Every clone seen while the run was LIVE must now
  // be accounted for by name.
  // BAR.md's own sentence — "the next start's sweep reclaims it, NO CLONE
  // SURVIVES" — narrowed by ruling 63's seam and by nothing else.
  //
  // The escaper's clone committed nothing and its tree is clean, and the
  // product's own `test/run-kept.test.ts` carries a test named for this exact
  // case — *"NEGATIVE: a clone with no commits and a clean tree is NOT
  // retained"*, whose comment says "the escapee's clone in BAR item 7" and
  // which asserts `existsSync(empty) === false` with `why` containing "holds no
  // work". So DELETION is the product's stated contract here, not a reading of
  // BAR.md this item invented, and the predicate says so.
  //
  // An earlier draft of this check accepted "retained but named in the report",
  // on the argument that `src/run/kept.ts` answers `empty` only on a positive
  // finding from git and every unknown retains. That argument is real but it
  // does not apply to THIS clone: git is on the isolated PATH, the clone is a
  // real repository, and the product's own test fixes the answer. Accepting
  // retention here would have let a product that stopped deleting empty clones
  // altogether pass item 7 — leaving directory reclamation, one of the two
  // halves ruling 63 exists to separate, untested by the item that exists to
  // test it.
  const surviving = new Set(o.survivingClones.map((c) => c.path));
  const deleted = o.clonesAtKill.filter((path) => !surviving.has(path));
  const emptyKept = o.survivingClones.filter((c) => !c.hadCommits);
  checks.expect(
    "every clone this item saw is accounted for, and none WITHOUT committed work survives",
    o.clonesAtKill.length > 0 && emptyKept.length === 0,
    o.clonesAtKill.length === 0
      ? "this item never observed a single clone while the run was live, so it has no denominator and this " +
        "check would pass on an empty listing — a failure of this item, not of the product"
      : `seen while live: ${o.clonesAtKill.join(", ")}; deleted: ${deleted.join(", ") || "NONE"}; ` +
        `still present: ${o.survivingClones.map((c) => `${c.path} commits=${c.hadCommits} bytes=${c.bytes}`).join("; ") || "none"}; ` +
        `kept WITHOUT committed work: ${emptyKept.map((c) => `${c.path} (${o.reportAfterSweep.includes(c.path) ? "named in the report, which is not a licence to keep it" : "not even named in the report"})`).join(", ") || "none"}`,
  );

  // Ruling 63, pointing the other way: a retained directory is inert and holds
  // someone's only copy, so destroying it is the failure here.
  const retained = o.survivingClones.filter((c) => c.hadCommits);
  const named = retained.filter((c) => o.reportAfterSweep.includes(c.path));
  const withBytes = retained.filter((c) => (reportedBytesFor(o.reportAfterSweep, c.path) ?? 0) > 0);
  checks.expect(
    "a clone WITH committed work is retained, reported with path and bytes (ruling 63)",
    retained.length > 0 && named.length === retained.length && withBytes.length === retained.length,
    `retained: ${retained.map((c) => `${c.path} (${c.bytes} bytes on disk)`).join(", ") || "NONE — the only copy of that work was destroyed"}; ` +
      `named in the report: ${named.map((c) => c.path).join(", ") || "none"}; ` +
      `bytes IN THE REPORT for each: ${retained.map((c) => `${c.path}=${reportedBytesFor(o.reportAfterSweep, c.path) ?? "no byte figure on that line"}`).join(", ") || "n/a"}`,
  );

  // …AND IT STILL HOLDS THE WORK. Finding 92 is about work being unrecoverable,
  // and a directory that exists with the right name is not work. The value is a
  // derivation of a nonce that lives only inside the clone, so it cannot be
  // produced by a product that deleted the tree and recreated the path.
  const holding = retained.filter((c) => c.committedValue === o.expectedCommittedValue);
  checks.expect(
    "the retained clone still HOLDS the committed work, byte for byte (finding 92)",
    holding.length > 0,
    `expected ${o.expectedCommittedValue} in the retained clone's committed tree; found ` +
      `${retained.map((c) => `${c.path}=${c.committedValue ?? "nothing readable at HEAD"}`).join(", ") || "no retained clone to read"}`,
  );

  checks.expect(
    "a second interrupt re-raises the signal rather than inventing an exit code",
    !o.secondInterrupt.timedOut && o.secondInterrupt.signal !== null && o.secondInterrupt.code === null,
    o.secondInterrupt.timedOut
      ? "the process was still running when this item's bounded wait expired: it neither drained nor died on two signals"
      : `wait status: code ${o.secondInterrupt.code}, signal ${o.secondInterrupt.signal}`,
  );
  return checks;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function git(clone: string, args: string[]): string {
  const out = Bun.spawnSync(["git", `--git-dir=${join(clone, ".git")}`, ...args], { stdout: "pipe", stderr: "pipe" });
  return out.exitCode === 0 ? new TextDecoder().decode(out.stdout).trim() : "";
}

/**
 * The clones this run created, at the path the PRODUCT writes them to.
 *
 * This function enumerated `<run-root>/<dir>/clones/<n>` for nine rounds. The
 * product writes `<run-root>/r/<run-id>/<n>` — ruling 61's deliberately short
 * shape — so it always returned `[]`, and one path bug produced two symptoms
 * that both read as product failures: `retained.length === 0` rendered as
 * *"NONE — the only copy of that work was destroyed"*, accusing the product of
 * reproducing finding 92 while `sweepAtStart` was retaining correctly, and the
 * same emptiness gated readiness below, which is where item 7's *"the kill
 * landed too early"* disclaimer came from.
 *
 * The shape now comes from `bar/lib/layout.ts`, which reads the product's own
 * source as TEXT — `bar/` still imports nothing from `src/` — and
 * `bar/lib/layout.test.ts` fails if the two ever diverge, with the old shape as
 * its negative control.
 *
 * `runIds` is the second correction and it is not cosmetic. The interrupted run
 * and the run that SWEEPS it share a run root by construction — that is how the
 * sweep sees it — so an unfiltered enumeration returns the sweeping run's own
 * clone too, and the retention check then demands that a live run's clone be
 * reported as retained from an earlier run. It cannot be, and the product would
 * have been failed for it.
 */
function clonesUnder(runsRoot: string, keptFile: string, runIds?: ReadonlySet<string>): CloneOnDisk[] {
  const found: CloneOnDisk[] = [];
  for (const clone of cloneDirsUnder(runsRoot)) {
    if (runIds !== undefined && !runIds.has(clone.runId)) continue;
    const bytes = listTree(clone.path).reduce((sum, rel) => sum + fileSize(join(clone.path, rel)), 0);
    // "Had commits" is decided by reading the object store, not by a marker.
    const headSha = git(clone.path, ["rev-parse", "HEAD"]);
    // The clone's base is on a fixed local branch — `src/repo/refs.ts` calls it
    // `brigadier-base`, and the honest fixture uses `bar-base`. Whichever
    // resolves is the left-hand side; work is HEAD having moved off it.
    const baseSha = [git(clone.path, ["rev-parse", "brigadier-base"]), git(clone.path, ["rev-parse", "bar-base"])].find(
      (sha) => sha.length === 40,
    );
    const committed = git(clone.path, ["show", `HEAD:${keptFile}`]);
    found.push({
      path: clone.path,
      // A clone whose base ref has not arrived yet is NOT a clone that has done
      // work. The `?? ""` this used to carry made "no base resolved" compare
      // unequal to HEAD, so a directory caught between `git clone` and the base
      // fetch read as committed work — and that reading gated the kill.
      hadCommits: headSha.length === 40 && baseSha !== undefined && headSha !== baseSha,
      bytes,
      committedValue: committed.length > 0 ? committed.trim() : null,
    });
  }
  return found;
}

function runIdsUnder(runsRoot: string): Set<string> {
  return new Set(cloneDirsUnder(runsRoot).map((clone) => clone.runId));
}

/**
 * Cheap readiness: does ANY clone under this root hold a commit off its base?
 *
 * Separate from `clonesUnder` because this one runs in a poll loop. The full
 * enumeration spawns four `git` processes per clone per call, and a harness that
 * spends more machine than the thing it is watching is measuring itself.
 */
function committedWorkExists(runsRoot: string): boolean {
  for (const clone of cloneDirsUnder(runsRoot)) {
    const head = git(clone.path, ["rev-parse", "HEAD"]);
    if (head.length !== 40) continue;
    const base = [git(clone.path, ["rev-parse", "brigadier-base"]), git(clone.path, ["rev-parse", "bar-base"])].find(
      (sha) => sha.length === 40,
    );
    if (base !== undefined && base !== head) return true;
  }
  return false;
}

/**
 * Every run RECORD under this root, as text.
 *
 * Clone directories are skipped by name — they are bare item numbers, ruling
 * 61's short shape — because walking them means walking a whole checkout and a
 * `.git`, and nothing in there is a record.
 */
function recordsUnder(runsRoot: string): string {
  const root = join(runsRoot, productRunDir());
  const skip = (name: string): boolean => /^[0-9]+$/.test(name) || name === ".git" || name === "transcripts";
  let text = "";
  for (const rel of listTree(root, skip)) {
    if (!/record/i.test(rel)) continue;
    const path = join(root, rel);
    if (fileSize(path) > 4 * 1024 * 1024) continue;
    try {
      text += `${readFileSync(path, "utf8")}\n`;
    } catch {
      // Deleted between the listing and the read, which is a run tidying up.
    }
  }
  return text;
}

/**
 * The classes a process still running when this item returns may belong to, in
 * FIRST-MATCH order.
 *
 * Exported because `bar/lib/item7-processes.test.ts` — the negative control —
 * plants real processes and drives THIS table. A guard tested against a
 * re-implementation of its own classes is not tested.
 *
 * WHY THE MARKERS AND NOT JUST THE ROOTS. Verified against the WORKING TREE on
 * 2026-08-19: `src/queue/spawn.ts` builds a worker's argv as
 * `[profile.command, ...profile.args, runMarkerArg(runId, item)]` and passes the
 * CLONE as `cwd`, and `src/run/marker.ts:64` renders that marker as
 * `--brigadier-run=<run-id>/<item>` — the `=` form is the only one it ever
 * WRITES, by its own comment. So a worker names its run id in its argv and its
 * run ROOT nowhere: the shim it was launched through
 * (`bar/lib/fixtures.ts` plants `<workdir>/bin/<vendor>`) is the only path it
 * carries. Classify on directories alone and every deliberately-abandoned
 * worker lands under the harness's own `bin/` and fails this item for the
 * product doing exactly what ruling 63 requires.
 *
 * The order is the judgement: run identity first, because it is the specific
 * provenance, and the directories after it as the fallback that catches what
 * carries no marker at all — the escapee, whose whole point is that nothing can
 * mark it.
 *
 * AND THE ONE EXPECTED CLASS MATCHES ON THE MARKER ALONE. It carried
 * `paths: [abandonedRoot]` too until a blind critic drove it on 2026-08-19 and
 * showed what that bought: a `while true; do date >> <root>/runs-3/…; sleep
 * 0.2; done` escapee — the exact unmarked, orphaned descendant class ruling 38
 * exists for — came back EXPECTED, and so did an ORCHESTRATOR still alive under
 * `--run-root …/runs-3`, which ruling 63 requires to re-raise and DIE. The path
 * needle could not have earned that excuse honestly either, because the
 * paragraph above is the argument that abandoned WORKERS name the run root
 * nowhere at all. A whitelist that only ever widens is the failure mode this
 * whole design is chosen against, so the excuse is now exactly as wide as the
 * evidence for it: a live run marker for a run this item abandoned. Anything
 * else under that root is named as its own class and stays loud.
 */
export function survivorClasses(scope: {
  /** The run root a later start SWEPT, and the run ids seen under it. */
  sweptRoot: string;
  sweptRunIds: ReadonlySet<string>;
  /** The run root this item interrupted twice and deliberately left unswept. */
  abandonedRoot: string;
  abandonedRunIds: ReadonlySet<string>;
  /** The planted fleet this harness put on the run's PATH. */
  fixtureBin: string;
  /** Where the escapee fixture writes its heartbeat and its pid. */
  observe: string;
}): SurvivorClass[] {
  const marker = (id: string): string => `${RUN_MARKER_FLAG}=${id}/`;
  return [
    {
      label: "a WORKER of the run this item ABANDONED, by its own run marker",
      // Markers only. See the note above: a path needle here excused an escaped
      // descendant and a surviving orchestrator, and bought no coverage for the
      // obligation it cites, because a worker never names its run root.
      paths: [],
      markers: [...scope.abandonedRunIds].map(marker),
      expected: true,
      why:
        "ruling 63: `abandon` restores the default handler and re-raises, cleaning up NOTHING on purpose, so " +
        "this run's WORKERS are left for a later start's sweep — and this item starts nothing else under this " +
        "root, so no later start exists. The product is behaving exactly as required and failing here would " +
        "fail the item for it. The marker is what makes this a worker of THAT run rather than anything else " +
        "that happens to sit under the same directory",
    },
    {
      label: "under the ABANDONED run root but carrying NO marker of that run",
      paths: [scope.abandonedRoot],
      markers: [],
      expected: false,
      why:
        "ruling 63 excuses that run's WORKERS, and nothing else. An unmarked process under this root is either " +
        "an escaped descendant — unmarked and off the ppid graph, the exact class ruling 38's sweep exists for " +
        "— or the orchestrator itself, which ruling 63 requires to re-raise and DIE rather than outlive its own " +
        "drain. Neither is excused, and neither is left to fall through to UNRECOGNISED without a reason",
    },
    {
      label: "the SWEPT run root (runs)",
      paths: [scope.sweptRoot],
      markers: [...scope.sweptRunIds].map(marker),
      expected: false,
      why:
        "a later start DID run over this root, and ruling 38's sweep reclaims processes always. Anything from " +
        "here that outlived both that sweep and this harness's own SIGKILL is a process nothing will ever " +
        "reclaim: `bar/run.ts` deletes this workdir the moment the item returns, taking away the directory the " +
        "next sweep would have found it by",
    },
    {
      label: "a harness fixture on the planted PATH (bin/)",
      paths: [scope.fixtureBin],
      markers: [],
      expected: false,
      why:
        "the HARNESS caused this one — `bar/lib/fixtures.ts` plants these shims — and it carries no run marker " +
        "tying it to either root, so no sweep of either would match it either. It survived this item's own " +
        "SIGKILL and is now the operator's",
    },
    {
      label: "the escapee's own observation files (observe/)",
      paths: [scope.observe],
      markers: [],
      expected: false,
      why:
        "this is the escaped descendant itself, or something writing its heartbeat: unmarked and off the ppid " +
        "graph by construction, which is the whole class ruling 38's sweep exists for. Still running after the " +
        "sweep AND after this item's SIGKILL means nothing reclaimed it",
    },
  ];
}

/** Wait for a process to exit, BOUNDED. An unbounded wait on a signalled process is a hang. */
async function exitedWithin(proc: { exited: Promise<number> }, ms: number): Promise<boolean> {
  return await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
}

/**
 * Read a captured stream, BOUNDED, and say so when it could not be read.
 *
 * A pipe closes when the LAST holder of its write end exits, and this item's
 * whole subject is processes that outlive the one it spawned. A leaked worker
 * still holding the orchestrator's stderr would make an ordinary
 * `await new Response(stream).text()` never resolve — the item would hang
 * forever with every observation already in hand, which is the worst available
 * failure: no result, no evidence, and an operator waiting.
 */
async function streamWithin(text: Promise<string>, ms: number): Promise<string> {
  return await Promise.race([
    text,
    Bun.sleep(ms).then(
      () => "<the stream never closed: something is still holding the write end of this pipe open>",
    ),
  ]);
}

const item: BarItem = {
  id: 7,
  title: "An interruption leaves nothing behind — including what escaped",
  rulings: [15, 38, 5, 63],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];
    let live: LiveHalf = { kind: "skipped", why: "the item did not reach its live half" };
    // Hoisted so the reaping `finally` can add to it. Nothing else writes here:
    // this item's assertions all need a live run, and the one thing that can be
    // said without one is that the harness left no process behind.
    const credentialFree = noCredentialFreeChecks();

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));
    // Both hoisted OUT of the live branch, because the `finally` classifies every
    // surviving process by the run it came from and a name that exists only
    // inside the `try` is a name the reaper cannot judge on. `sweptRunIds` is
    // filled while the first run is still live: after the sweep its clones are
    // gone, and with them the only place its run id was written down.
    const interruptRoot = join(ctx.workdir, "runs-3");
    const sweptRunIds = new Set<string>();

    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const committerSeed = nonce("committer-seed");
    await plantSeeds(repo, [{ path: "seeds/committer.seed", value: committerSeed, placement: "committed" }]);
    const observe = ensureDir(join(ctx.workdir, "observe"));
    const heartbeat = join(observe, "heartbeat.log");
    const pidFile = join(observe, "escapee.pid");
    const keptFile = "kept.txt";
    const keptValue = derive(committerSeed, "committer");

    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "escaper",
          kind: "write",
          paths: ["escaper.txt"],
          prompt: "detach a long-lived descendant",
          directive: { do: "escape-process", heartbeat, pidFile },
        },
        {
          id: "committer",
          kind: "write",
          paths: [keptFile],
          prompt: "do real work and then hang",
          directive: { do: "commit-then-hang", read: "seeds/committer.seed", path: keptFile, salt: "committer" },
        },
      ],
    });
    did.push(
      `wrote a plan at ${planPath}: one item detaches a descendant (${process.platform === "win32" ? "cmd /c start — #43 measured BREAKAWAY_OK and SILENT_BREAKAWAY_OK on Bun's job object" : "setsid where the host has it, nohup where it does not — which mechanism actually ran is READ back from the process table below, never assumed"}) ` +
        `writing a heartbeat to ${heartbeat}; the other commits real work and hangs`,
    );

    try {
      // Probe first: an artifact with no `run` cannot be interrupted.
      //
      // INSIDE the `try`, since 2026-08-19. It sat outside it, so a throw here —
      // and it spawns the binary, which is the throwing kind of work — skipped
      // the reap in the `finally` entirely, leaving whatever it had started on
      // the operator's machine with the workdir about to be deleted out from
      // under it. Found by a blind critic; pre-existing rather than introduced
      // by this round's change, and fixed here because this is the file that
      // owns the reap.
      const probe = await probeFeature(
        ctx,
        ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--dry-run"],
        { env, timeoutMs: 60_000 },
      );
      did.push(probe.transcript);

      if (!probe.present) {
        live = {
          kind: "missing",
          probe,
          promise:
            "there is no run to interrupt: no clone is created, no descendant escapes, and no sweep exists to reclaim one",
        };
      } else if (!ctx.live) {
        live = {
          kind: "skipped",
          why:
            "this item SIGKILLs a run in flight and deliberately leaves an escaped descendant running on the machine, " +
            "so it is driven only under --live. Stated plainly because it is not the usual cause: the fleet here is " +
            "PLANTED (`bar/lib/fixtures.ts`), so nothing this item does spends a vendor token",
        };
      } else {
        // 1-3. Start for real, let it get going, then SIGKILL the orchestrator.
        const victim = Bun.spawn([ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
          cwd: ctx.workdir,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        // Drained CONCURRENTLY, from the moment it starts. A piped stream nobody
        // reads fills its kernel buffer and blocks the writer, so an unread pipe
        // is this harness wedging the product and then measuring the wedge.
        const victimOut = new Response(victim.stdout).text().catch(() => "<stdout could not be read>");
        const victimErr = new Response(victim.stderr).text().catch(() => "<stderr could not be read>");

        const ready = (): boolean => fileSize(heartbeat) > 0 && committedWorkExists(runs);
        const alive = (): boolean => victim.exitCode === null && victim.signalCode === null;
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && alive() && !ready()) await Bun.sleep(500);
        // Readiness is WAITED FOR rather than assumed. A blocking item that fails
        // because the kill landed early is flaky, and ruling 48 names a flaky
        // blocking item as the thing that gets disabled.
        const wasReady = ready();
        const clonesAtKill = clonesUnder(runs, keptFile);
        const runIds = runIdsUnder(runs);
        for (const id of runIds) sweptRunIds.add(id);

        victim.kill("SIGKILL");
        await exitedWithin(victim, 10_000);
        const heartbeatAtKill = fileSize(heartbeat);
        did.push(
          `SIGKILLed the orchestrator (pid ${victim.pid}) after waiting ${wasReady ? "until" : "WITHOUT reaching"} the state this item needs: ` +
            `heartbeat ${heartbeatAtKill} bytes, clones ${clonesAtKill.map((c) => `${c.path.split("/").pop()}=${c.hadCommits}`).join(",") || "none"}. ` +
            (wasReady
              ? ""
              : "The kill landed too early, so the checks below are measuring a run that had not got going — a scheduling failure of this item, not of the product"),
        );

        await Bun.sleep(800); // an unreclaimed descendant keeps writing through this
        const heartbeatBeforeSweep = fileSize(heartbeat);
        const escapeePid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
        const aliveBeforeSweep = escapeePid > 0 && isAlive(escapeePid);
        // HOW it escaped, read rather than believed: the command line (is it
        // marked?), the ppid (is it still on the graph?) and the process group.
        const table = readProcessTable();
        const escapee = escapeePid > 0 ? findProcess(escapeePid, table) : null;
        const escapeeParentAlive = escapee !== null && escapee.ppid > 1 && findProcess(escapee.ppid, table) !== null;
        did.push(
          escapee === null
            ? `the escapee (pid ${escapeePid || "none published"}) was not in the process table after the kill`
            : `the escapee is ${nameProcess(escapee)}; parent still in the table: ${escapeeParentAlive}`,
        );

        // 4. The next start sweeps.
        const secondRepo = join(ctx.workdir, "repo-2");
        await makeRepo(secondRepo, { "README.md": "base\n" });
        await plantSeeds(secondRepo, [{ path: "seeds/after.seed", value: nonce("after-seed"), placement: "committed" }]);
        const secondPlanPath = writePlan(
          ctx.workdir,
          {
            version: 1,
            items: [
              {
                id: "after",
                kind: "write",
                paths: ["after.txt"],
                prompt: "x",
                directive: { do: "derive-write", read: "seeds/after.seed", path: "after.txt", salt: "after" },
              },
            ],
          },
          "after.json",
        );
        // `--audience terminal` on purpose: `host-session` is the default and
        // ruling 58's cap DROPS the report's `detail`, which is where
        // `describeStartSweep`'s `reclaimed pid …` lines travel. Asking for the
        // uncapped report is asking the product to say what it did, not asking
        // it to do something different.
        const sweep = await ctx.run(
          ["run", "--plan", secondPlanPath, "--repo", secondRepo, "--run-root", runs, "--audience", "terminal"],
          { env, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
        );
        // Two readings, four tick intervals apart, so a live descendant cannot
        // hide in the gap between the sweep's `kill` and the measurement.
        await Bun.sleep(400);
        const heartbeatAfterSweep = fileSize(heartbeat);
        await Bun.sleep(900);
        const heartbeatSettled = fileSize(heartbeat);
        const aliveAfterSweep = escapeePid > 0 && isAlive(escapeePid);
        did.push(
          `started again; the sweep ran at start. Heartbeat: ${heartbeatAtKill} bytes at the kill, ${heartbeatBeforeSweep} before the sweep, ` +
            `${heartbeatAfterSweep} just after, ${heartbeatSettled} four tick intervals later`,
        );

        // 6. Two interrupts, and the WAIT STATUS is what is read.
        const interruptRepo = join(ctx.workdir, "repo-3");
        await makeRepo(interruptRepo, { "README.md": "base\n" });
        await plantSeeds(interruptRepo, [{ path: "seeds/hang.seed", value: nonce("hang-seed"), placement: "committed" }]);
        const interruptPlan = writePlan(
          ctx.workdir,
          {
            version: 1,
            items: [
              // AN ESCAPEE UNDER THE ABANDONED ROOT TOO, and it is not decoration.
              // The survivor classification excuses the workers of this run and
              // nothing else, and the case that has to be DRIVEN rather than
              // reasoned about is the one a blind critic found on 2026-08-19: an
              // unmarked, orphaned descendant sitting under the very root whose
              // workers are excused. Without this item nothing ever plants one
              // there, and the class that refuses to excuse it is never
              // exercised against a real process — which is the difference
              // between a guard and a comment.
              {
                id: "escaper-abandoned",
                kind: "write",
                paths: ["escaper-abandoned.txt"],
                prompt: "detach a long-lived descendant under the run that will be abandoned",
                directive: {
                  do: "escape-process",
                  heartbeat: join(observe, "heartbeat-abandoned.log"),
                  pidFile: join(observe, "escapee-abandoned.pid"),
                },
              },
              {
                id: "hang",
                kind: "write",
                paths: ["hang.txt"],
                prompt: "x",
                directive: { do: "commit-then-hang", read: "seeds/hang.seed", path: "hang.txt", salt: "hang" },
              },
            ],
          },
          "interrupt.json",
        );
        const interruptee = Bun.spawn(
          [ctx.binary, "run", "--plan", interruptPlan, "--repo", interruptRepo, "--run-root", interruptRoot],
          { cwd: ctx.workdir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        const interrupteeOut = new Response(interruptee.stdout).text().catch(() => "<stdout could not be read>");
        const interrupteeErr = new Response(interruptee.stderr).text().catch(() => "<stderr could not be read>");
        // IN FLIGHT, not merely started. `src/run/interrupt.ts` defines a signal
        // arriving before the first clone as "exit immediately with the signal's
        // status" — correct behaviour that is indistinguishable, from outside,
        // from having no handler at all. Signalling too early would fail a
        // correct product on this item's own impatience.
        const interruptDeadline = Date.now() + 90_000;
        while (
          Date.now() < interruptDeadline &&
          interruptee.exitCode === null &&
          interruptee.signalCode === null &&
          !committedWorkExists(interruptRoot)
        ) {
          await Bun.sleep(500);
        }
        const interruptInFlight = committedWorkExists(interruptRoot);
        interruptee.kill("SIGINT");
        // A binary with no handler dies here. Surviving the window is what makes
        // the re-raise below a statement about a drain rather than about nothing.
        await Bun.sleep(700);
        const survivedFirstInterrupt = interruptee.exitCode === null && interruptee.signalCode === null;
        interruptee.kill("SIGINT");
        // BOUNDED. A product that ignores both signals would otherwise hang this
        // item forever, and an item that hangs is an item that gets disabled.
        const secondExited = await exitedWithin(interruptee, 60_000);
        if (!secondExited) interruptee.kill("SIGKILL");
        const secondInterrupt = {
          code: interruptee.exitCode,
          signal: interruptee.signalCode,
          timedOut: !secondExited,
        };
        did.push(
          `sent two SIGINTs to a run ${interruptInFlight ? "IN FLIGHT" : "that had not reached a clone yet"} and read the wait status: ` +
            `code ${secondInterrupt.code}, signal ${secondInterrupt.signal}${secondInterrupt.timedOut ? " (still running when the bounded wait expired; SIGKILLed)" : ""}`,
        );

        const report = `${sweep.stdout}${sweep.stderr}`;
        const survivingClones = clonesUnder(runs, keptFile, runIds);
        const checks = judgeInterrupt({
          escapeePid,
          escapee,
          escapeeParentAlive,
          aliveBeforeSweep,
          aliveAfterSweep,
          interruptInFlight,
          survivedFirstInterrupt,
          heartbeatAtKill,
          heartbeatBeforeSweep,
          heartbeatAfterSweep,
          heartbeatSettled,
          clonesAtKill: clonesAtKill.map((c) => c.path),
          survivingClones,
          expectedCommittedValue: keptValue,
          reportAfterSweep: report,
          recordAfterSweep: recordsUnder(runs),
          secondInterrupt,
        });
        checks.note(
          "what was observed",
          `sweep report: ${excerpt(report, 300)}; the interrupted run printed: ` +
            `${excerpt(`${await streamWithin(interrupteeOut, 5_000)}${await streamWithin(interrupteeErr, 5_000)}`, 200)}; ` +
            `the killed run printed: ${excerpt(`${await streamWithin(victimOut, 5_000)}${await streamWithin(victimErr, 5_000)}`, 200)}`,
        );
        // Reported as a WEAKER guarantee rather than as an absence or an
        // equivalence. Nothing above demands the marker on an operator's verify
        // command, because appending an argument to somebody else's command line
        // corrupts it, and a check that demanded it would fail against a correct
        // product. The hole itself is RECORDED IN `BAR.md`, item 7, under
        // *RECORDED 2026-08-20 — amendment §18*; this row is the item saying the
        // same thing in its own output, so a reader of the report does not have
        // to go and find it.
        checks.note(
          "ruling 38's one hole (recorded in BAR.md, item 7 — RECORDED 2026-08-20)",
          "an operator's verify command is spawned WITHOUT the command-line marker — `bun test --brigadier-run=x` is not " +
            "`bun test` — so the sweep cannot match it. It is killed on its own timeout BY THE PROCESS THAT STARTED IT, " +
            "which is strictly weaker than the sweep and fails in exactly the case this item drives: a SIGKILLed " +
            "orchestrator kills nothing on any timeout. What remains for such a process is the working-directory link, " +
            "and only while the run root is still there. This item's plan carries no verify command, so nothing above " +
            "measures that path; it is named here rather than left for a reader to discover, and it is written down in " +
            "`BAR.md` under item 7 rather than only in this harness's own head — it was cited for rounds as `amendment §18`, " +
            "a section that existed nowhere, until the owner had it recorded on 2026-08-20",
        );
        live = { kind: "ran", checks };
      }
    } finally {
      // 7. REAP, whatever happened above. `bar/run.ts` deletes this workdir the
      // moment the item returns, which takes away the very directory the next
      // sweep would have found a leak by. Anything still naming this workdir was
      // caused by this item and is this item's to kill.
      const reaped = await reap(ctx.workdir);
      did.push(
        reaped.found.length === 0
          ? "reaped nothing: no process on this machine still named this item's workdir"
          : `the harness reaped ${reaped.found.length} process(es) still naming this workdir: ` +
            `${reaped.found.map((row) => nameProcess(row)).join(" | ")}${reaped.survivors.length > 0 ? `; STILL ALIVE after SIGKILL: ${reaped.survivors.map((row) => nameProcess(row)).join(" | ")}` : ""}. ` +
            "Some of these are the product behaving as ruling 63 says it must: `abandon` restores the default handler " +
            "and re-raises, and cleans up nothing on purpose, so the run this item interrupted twice leaves its workers " +
            "for a later start's sweep — and there is no later start under `runs-3`. Anything from the SWEPT run root is " +
            "a different matter, and the checks above are where that is judged",
      );
      // AND THEN JUDGE WHAT SURVIVED THE REAP, as a CHECK.
      //
      // This was a `did` line until 2026-08-19 — `STILL RUNNING after the reap:
      // …` — and `did` is narrative: it stamps nothing. So the harness could
      // leak a process past its own SIGKILL, SAY SO in the item's own output,
      // and still report PASS. An item that reports a leak without failing on it
      // is an item that will be believed.
      //
      // It is a CLASSIFICATION rather than a count, because
      // `remaining.length > 0` is the wrong predicate in the other direction:
      // ruling 63 REQUIRES the abandoned run to leave its workers behind, and
      // failing on those would fail this item for the product being correct.
      // Every survivor is filed under a named class carrying its reason, and
      // anything unrecognised is a failing row — a stale whitelist is a silent
      // false negative, a stale blacklist is a loud false positive, and
      // demanding classification makes both loud.
      for (const id of runIdsUnder(runs)) sweptRunIds.add(id);
      const classes = survivorClasses({
        sweptRoot: runs,
        sweptRunIds,
        abandonedRoot: interruptRoot,
        abandonedRunIds: runIdsUnder(interruptRoot),
        fixtureBin: binDir,
        observe,
      });
      // `reaped.survivors` rather than a fresh scan: it is the SAME reading the
      // `did` line above reports, so the narrative and the verdict cannot
      // disagree about what was left, and the machine is not asked for a second
      // whole `ps` a few milliseconds later.
      const classified = classifySurvivors(reaped.survivors, classes);
      const verdict = survivorVerdict(classified, classes);
      if (live.kind === "ran") {
        live.checks.expect(verdict.name, verdict.ok, verdict.detail);
      } else if (!verdict.ok) {
        // The live half never ran, so there is no live check to carry this — and
        // an unexpected process left behind by an item that did not even reach
        // its subject is the INSTRUMENT leaking, which blocks under its own
        // name rather than as a verdict about the product.
        credentialFree.expect(
          `ERROR — the harness left a process running and this item never reached its live half: ${verdict.name}`,
          false,
          verdict.detail,
        );
      }
      did.push(
        `classified ${classified.length} process(es) still naming this workdir after the reap; ` +
          `${classified.filter((row) => !row.expected).length} UNEXPECTED. The verdict is a CHECK, not this line`,
      );
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
