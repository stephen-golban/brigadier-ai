// SPDX-License-Identifier: Apache-2.0
/**
 * Reading the process table for item 7, and reaping what item 7 leaks ON PURPOSE.
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
 * So this module does two things, and the second is not optional:
 *
 *   IT READS FACTS THE ITEM WOULD OTHERWISE ASSUME. Whether a descendant really
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
 * The needle is a PATH under a per-item scratch directory, never a name pattern
 * — the same argument `src/run/marker.ts` makes about `ps`: a name pattern
 * matches `bun`, `sh` and `git`, every one of which the operator also runs.
 */

/** One row of the process table. `pgid` is 0 where the platform does not report one. */
export interface ProcessFacts {
  pid: number;
  ppid: number;
  pgid: number;
  commandLine: string;
}

/**
 * Every process on this machine, with the three fields item 7 judges on.
 *
 * MEASURED against macOS 26.5.2 (Darwin 25.5.0) on 2026-08-19: `ps -A -o
 * pid=,ppid=,pgid=,args=` prints the process group, so "did it leave the group"
 * is answerable rather than assumed. Windows has no process groups of this kind
 * and `Get-CimInstance Win32_Process` has no column for one, so `pgid` is 0
 * there and the checks that depend on it say so instead of inventing a number.
 */
export function readProcessTable(): ProcessFacts[] {
  if (process.platform === "win32") return readWindowsTable();
  const proc = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return [];
  const rows: ProcessFacts[] = [];
  for (const line of new TextDecoder().decode(proc.stdout).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      commandLine: (match[4] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * The Windows reading, and the one thing it is NOT.
 *
 * `Get-CimInstance Win32_Process` is the same reader `bar/lib/inflight.ts` uses,
 * so a divergence between the two would be visible. It has never been executed
 * on any machine — there is no Windows host in this project's loop — and that is
 * written here rather than left for a reader to discover: on Windows this
 * module's escape facts are unverified, and the item's report says so.
 */
function readWindowsTable(): ProcessFacts[] {
  const proc = Bun.spawnSync(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return [];
  const rows: ProcessFacts[] = [];
  for (const line of new TextDecoder().decode(proc.stdout).split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, pgid: 0, commandLine: cols.slice(2).join("\t").trim() });
  }
  return rows;
}

export function findProcess(pid: number, table: readonly ProcessFacts[]): ProcessFacts | null {
  return table.find((row) => row.pid === pid) ?? null;
}

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

/** `pid <cmd>`, trimmed — evidence a reader can act on rather than a count. */
export function nameProcess(row: ProcessFacts): string {
  return `pid ${row.pid} (ppid ${row.ppid}, pgid ${row.pgid || "n/a"}): ${row.commandLine.slice(0, 120)}`;
}
