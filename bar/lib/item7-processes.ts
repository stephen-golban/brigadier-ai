// SPDX-License-Identifier: Apache-2.0
/**
 * Reaping what item 7 leaks ON PURPOSE, and CLASSIFYING whatever is left.
 *
 * Item 7 is the only item in this harness whose fixture is REQUIRED to outlive
 * its parent: ruling 38's sweep has nothing to reclaim otherwise. That makes it
 * the one item that can leave a process running on the operator's machine when
 * the product fails — and `bar/run.ts` deletes the item's workdir in a `finally`
 * the moment the item returns, so a leaked descendant loses the directory the
 * next sweep would have found it by. MEASURED on this host on 2026-08-17: two
 * ACP vendor fixtures were found at 98.7% and 100% CPU, reparented to `launchd`,
 * one of them 2h20m old. That is this harness reproducing, inside the item that
 * grades ruling 38, the exact escape class ruling 38 exists for.
 *
 * So this module does three things, and neither of the last two is optional:
 *
 *   IT READS FACTS THE ITEM WOULD OTHERWISE ASSUME, through the one process
 *   table reader in `bar/lib/process-table.ts`. Whether a descendant really
 *   escaped is a question about its `ppid` and its process group, not about the
 *   fixture's intentions. `bar/fakes/vendor.ts` falls back to `nohup` where
 *   `setsid` is absent — macOS ships no `setsid` — and `nohup` does NOT leave
 *   the process group. An item that printed "setsid()" either way would be
 *   describing a mechanism it never checked.
 *
 *   IT REAPS. Every process whose command line names the item's own workdir is
 *   this item's, was caused by this item, and is killed by this item before it
 *   returns — group first so grandchildren go with it, then the pid. What it
 *   found is REPORTED rather than swallowed, because "the harness had to kill
 *   three processes the product left behind" is a finding about the product and
 *   silently tidying it away would destroy the evidence.
 *
 *   IT CLASSIFIES WHAT SURVIVED THE REAP, and that is a check rather than a
 *   sentence. Until 2026-08-19 the survivors of item 7's own SIGKILL were pushed
 *   to `did` — narrative, which stamps nothing — so the harness could leak a
 *   process past its own reap, SAY SO, and still report PASS. An item that
 *   reports a leak without failing on it is an item that will be believed.
 *
 * WHY CLASSIFY RATHER THAN WHITELIST. Some survivors are the product being
 * CORRECT: ruling 63 has `abandon` restore the default handler and re-raise,
 * cleaning up nothing on purpose, so the run item 7 interrupts twice leaves its
 * workers for a later start's sweep — and item 7 starts nothing else under that
 * root. Failing on those would fail the item for the product doing what it was
 * told. But a whitelist goes stale silently, which is a false negative nobody
 * sees. So every survivor must land in a NAMED class carrying its reason, and
 * anything that matches no class is a failing row by construction: a stale
 * whitelist is a silent false negative, a stale blacklist is a loud false
 * positive, and demanding classification makes both loud.
 *
 * The needle is a PATH under a per-item scratch directory, never a name pattern
 * — the same argument `src/run/marker.ts` makes about `ps`: a name pattern
 * matches `bun`, `sh` and `git`, every one of which the operator also runs.
 */

import { commandNamesDir, findProcess, nameProcess, readProcessTable, type ProcessFacts } from "./process-table.ts";

/**
 * Processes whose command line names `needle`.
 *
 * `needle` is the item's own scratch directory, so a match is proof of
 * provenance: nothing else on the machine has that path in its argv. The
 * sweeping process and its ancestors are never returned — a reaper that kills
 * the harness running it has not reaped anything.
 */
export function strays(needle: string, table: readonly ProcessFacts[] = readProcessTable()): ProcessFacts[] {
  const mine = new Set<number>([process.pid]);
  for (let cursor = process.pid, hops = 0; hops < 64; hops++) {
    const row = findProcess(cursor, table);
    if (row === null || row.ppid <= 1) break;
    mine.add(row.ppid);
    cursor = row.ppid;
  }
  return table.filter((row) => row.pid > 1 && !mine.has(row.pid) && row.commandLine.includes(needle));
}

export interface Reaping {
  /** What was found still running, named with its pid and its command line. */
  found: ProcessFacts[];
  /** What was still alive after the group kill and the pid kill. */
  survivors: ProcessFacts[];
}

/**
 * Kill everything that names `needle`, group first.
 *
 * The group kill is what reaches a GRANDCHILD: an escapee running
 * `while true; do …; sleep 0.2; done` has a `sleep` child whose own argv names
 * nothing, so a reaper matching command lines alone would leave it. It is
 * guarded against the reaper's own group, because a process group containing
 * this process contains the harness.
 *
 * Two rounds, because the first round's kills can uncover a process that was
 * mid-spawn — the same reason `src/run/sweep.ts` re-scans.
 */
export async function reap(needle: string): Promise<Reaping> {
  const table = readProcessTable();
  const ownGroup = findProcess(process.pid, table)?.pgid ?? 0;
  const found = strays(needle, table);
  const groups = new Set<number>();
  for (const row of found) if (row.pgid > 1 && row.pgid !== ownGroup) groups.add(row.pgid);

  for (let round = 0; round < 2; round++) {
    if (process.platform === "win32") {
      for (const row of round === 0 ? found : strays(needle)) {
        Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(row.pid)], { stdout: "ignore", stderr: "ignore" });
      }
    } else {
      if (round === 0) {
        for (const group of groups) {
          try {
            process.kill(-group, "SIGKILL");
          } catch {
            // Already empty, or not ours to signal. The pid kill below still applies.
          }
        }
      }
      for (const row of round === 0 ? found : strays(needle)) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {
          // Gone between the reading and the signal, which is the outcome wanted.
        }
      }
    }
    await Bun.sleep(300);
  }

  return { found, survivors: strays(needle) };
}

// ───────────────────────── THE SURVIVOR CLASSIFICATION ─────────────────────────

/**
 * One class a surviving process can belong to, declared by the item that knows
 * which of its own directories and run ids mean what.
 *
 * `expected` is the whole judgement and `why` is what makes it auditable. A
 * class with `expected: true` is a statement that the PRODUCT is required to
 * leave this process behind; anything else is a leak somebody now owns.
 *
 * TWO KINDS OF NEEDLE, because a run root is not enough on its own. MEASURED by
 * reading `src/queue/spawn.ts` in the WORKING TREE on 2026-08-19: a worker's
 * argv is `[profile.command, ...profile.args, --brigadier-run=<run-id>/<item>]`
 * and the CLONE is passed as `cwd`, which no `ps` column here reads. So a
 * worker of the run this item abandons carries the harness's own `bin/` shim
 * path and its run id, and names its run ROOT nowhere at all. Classifying on
 * directories alone would file every deliberately-abandoned worker under the
 * harness fixture that launched it and fail item 7 for the product being
 * correct.
 */
export interface SurvivorClass {
  /** Printed beside every process filed here. Short enough to scan a column of. */
  label: string;
  /** Directories whose name in an argv puts a process in this class. */
  paths: string[];
  /** Literal argv fragments — run markers — that put a process in this class. */
  markers: string[];
  /** Is a survivor of this class the product behaving correctly? */
  expected: boolean;
  /** The specific reason, printed with every row so nobody has to read this file. */
  why: string;
}

/** One process, and the class it was filed under. */
export interface ClassifiedSurvivor {
  process: ProcessFacts;
  label: string;
  expected: boolean;
  why: string;
  /**
   * Every OTHER class this process also matched, in declaration order.
   *
   * Printed, because first-match-wins is only auditable if a reader can see what
   * else matched and disagree with the order.
   */
  alsoMatched: string[];
}

/**
 * The label a process gets when it names the item's workdir and NOTHING the item
 * declared.
 *
 * It is never `expected`, and that is the design rather than an oversight: the
 * cost of an unknown class is one edit here, and the cost of assuming it benign
 * is a leak that reports itself and passes.
 */
export const UNRECOGNISED = "UNRECOGNISED — names this item's workdir and none of its declared roots";

const UNRECOGNISED_WHY =
  "no declared class matched this command line. An unrecognised survivor FAILS by construction: a stale " +
  "whitelist is a silent false negative and this row is what makes it loud. Either the process belongs to a " +
  "class this item has not declared yet — declare it, with its reason — or the harness has leaked something " +
  "nobody has accounted for";

/** Does this command line carry any of the class's needles? */
export function matchesClass(commandLine: string, klass: SurvivorClass): boolean {
  return (
    klass.paths.some((path) => commandNamesDir(commandLine, path)) ||
    klass.markers.some((marker) => marker.length > 0 && commandLine.includes(marker))
  );
}

/**
 * File every survivor under a declared class, or under `UNRECOGNISED`.
 *
 * FIRST MATCH WINS, so `classes` is a routing table and its ORDER is part of the
 * judgement: the specific provenance — the run marker naming the run this item
 * abandoned — has to come before the general one — the harness `bin/` directory
 * every worker's argv also carries. Whatever else matched is carried on the row
 * and printed, so the order can be audited rather than trusted.
 */
export function classifySurvivors(
  survivors: readonly ProcessFacts[],
  classes: readonly SurvivorClass[],
): ClassifiedSurvivor[] {
  return survivors.map((row) => {
    const matched = classes.filter((klass) => matchesClass(row.commandLine, klass));
    const first = matched[0];
    if (first === undefined) {
      return { process: row, label: UNRECOGNISED, expected: false, why: UNRECOGNISED_WHY, alsoMatched: [] };
    }
    return {
      process: row,
      label: first.label,
      expected: first.expected,
      why: first.why,
      alsoMatched: matched.slice(1).map((klass) => klass.label),
    };
  });
}

/** The survivors this item refuses to excuse. The failing set. */
export function unexpectedSurvivors(rows: readonly ClassifiedSurvivor[]): ClassifiedSurvivor[] {
  return rows.filter((row) => !row.expected);
}

/**
 * The verdict, as a check row a caller hands straight to `Checks.expect`.
 *
 * Returned rather than pushed so that the negative control can drive the exact
 * predicate the item drives, over real processes, without reconstructing it —
 * a guard tested through a re-implementation of itself is not tested.
 */
export function survivorVerdict(
  rows: readonly ClassifiedSurvivor[],
  classes: readonly SurvivorClass[],
): { name: string; ok: boolean; detail: string } {
  const unexpected = unexpectedSurvivors(rows);
  return {
    name: "every process still running after the reap is an EXPECTED survivor, by class (ruling 63)",
    ok: unexpected.length === 0,
    detail: describeSurvivors(rows, classes),
  };
}

/**
 * Which processes, from which root, and why each was filed there — so the
 * classification can be audited without reading this source.
 */
export function describeSurvivors(
  rows: readonly ClassifiedSurvivor[],
  classes: readonly SurvivorClass[],
): string {
  // ONE FACT PER LINE, on purpose. Ruling 58's cap clips a report line at its
  // WIDTH, so a classification packed onto one long line loses whichever class
  // happened to be printed last — and the class a reader needs is the one that
  // decided the verdict. Every class and every survivor gets its own line, and
  // each row's rationale gets a line of its own beneath it, so a clip can only
  // ever cost the tail of a sentence rather than a whole class.
  const declared = classes
    .map(
      (klass, index) =>
        `  ${index + 1}) ${klass.expected ? "EXPECTED" : "UNEXPECTED"} [${klass.label}] matches ` +
        `${[...klass.paths.map((p) => `path ${p}`), ...klass.markers.map((m) => `argv ${m}`)].join(" or ") || "nothing"}`,
    )
    .join("\n");
  const header =
    `Classes declared, in first-match order — anything matching none of them is ${UNRECOGNISED}:\n${declared}`;
  if (rows.length === 0) {
    return `no process on this machine still named this item's workdir after the reap.\n${header}`;
  }
  const unexpected = unexpectedSurvivors(rows);
  const listing = rows
    .map(
      (row) =>
        `${row.expected ? "EXPECTED" : "UNEXPECTED"} [${row.label}] ${nameProcess(row.process, { limit: 240 })}` +
        (row.alsoMatched.length > 0 ? `\n    also matched, and NOT decisive: ${row.alsoMatched.join(", ")}` : "") +
        `\n    filed there because: ${row.why}`,
    )
    .join("\n");
  return (
    `${rows.length} process(es) survived this item's own SIGKILL reap, ${unexpected.length} of them UNEXPECTED.\n` +
    `${header}\n${listing}`
  );
}
