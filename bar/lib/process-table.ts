// SPDX-License-Identifier: Apache-2.0
/**
 * ONE reading of the machine's process table, for every caller under `bar/`.
 *
 * There were two, and they had drifted into the shape this repository keeps
 * catching itself in: `readProcessTable()` in `bar/lib/item7-processes.ts` read
 * `pid`, `ppid`, `pgid` and `args`; `listProcesses()` in `bar/lib/inflight.ts`
 * read `args` alone and returned raw lines. A comment on the first said the
 * second "is the same reader … so a divergence between the two would be
 * visible". **That claim was FALSE when it was written**, in both directions:
 * the two spawned different commands (`ps -A -o args=` against
 * `ps -A -o pid=,ppid=,pgid=,args=`; `ForEach-Object { $_.CommandLine }` against
 * a tab-joined `ProcessId`/`ParentProcessId`/`CommandLine` projection), and
 * nothing anywhere compared their output — so a divergence would have been
 * invisible, which is the opposite of what the comment promised. It is true now
 * because there is only one function, which is the only way a claim of that
 * shape is ever true.
 *
 * MEASURED against `ps` on macOS 26.5.2 (Darwin 25.5.0) on 2026-08-19, at
 * load1 1.64, comparing the two POSIX invocations back to back:
 *
 *   - both printed **507 rows**;
 *   - all 507 rows of the four-column form parsed with the regex below (0
 *     skipped);
 *   - after stripping the three numeric columns the args text was IDENTICAL
 *     line for line, the sole difference being each `ps`'s own argv;
 *   - the longest line grew by exactly 18 characters — the width of the three
 *     added columns — so nothing is truncated to a terminal width when `ps`
 *     writes to a pipe on this host.
 *
 * That last one is the reason the merge is safe rather than merely tidy: had
 * `ps` clamped its output to a width, the added columns would have eaten 18
 * characters off the END of every command line, and the marker
 * `bar/lib/inflight.ts` counts lives at the end of an argv.
 *
 * The needle a caller matches on is always a PATH, never a name pattern — the
 * argument `src/run/marker.ts` makes about `ps`, and the reason `commandNamesDir`
 * exists below: a name pattern matches `bun`, `sh` and `git`, every one of which
 * the operator also runs.
 */

/** One row of the process table. `pgid` is 0 where the platform does not report one. */
export interface ProcessFacts {
  pid: number;
  ppid: number;
  pgid: number;
  commandLine: string;
}

/**
 * Every process on this machine, with the fields the harness judges on.
 *
 * MEASURED against macOS 26.5.2 (Darwin 25.5.0) on 2026-08-19: `ps -A -o
 * pid=,ppid=,pgid=,args=` prints the process group, so "did it leave the group"
 * is answerable rather than assumed. Windows has no process groups of this kind
 * and `Get-CimInstance Win32_Process` has no column for one, so `pgid` is 0
 * there and the checks that depend on it say so instead of inventing a number.
 *
 * A CLAIM THAT STOOD HERE AND WAS WRONG, withdrawn in the open on 2026-08-19
 * rather than reworded. It said that an argv containing a literal NEWLINE makes
 * `ps` print a continuation line which the old string reader returned as a
 * separate entry and this one drops — so that one process could be COUNTED
 * TWICE before the merge and once after — and it called that the only
 * observable difference the merge makes. It was reasoned, not measured, and it
 * is false on this host.
 *
 * MEASURED against `ps` on macOS 26.5.2 (Darwin 25.5.0) with `bun 1.3.14` on
 * 2026-08-19, spawning `/bin/sh -c "sleep 4; :"` with an argv element carrying
 * a literal `\n` and two marker-shaped halves: Darwin's `ps` ESCAPES the
 * newline to the four characters `\012` and prints the whole argv on ONE line.
 * Both projections returned exactly one line for that process, the two readers
 * agreed character for character after the numeric columns, and the marker was
 * counted once either way. There is therefore NO observable difference between
 * the old reader and this one on this host — which is the strongest thing the
 * merge could have turned out to be, and it took a measurement rather than an
 * argument to find out. What remains unmeasured is any platform whose `ps` does
 * not escape control characters; if one exists, this reader drops the
 * continuation and the old one kept it, and that is the shape to look for.
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
 * It has never been executed on any machine — there is no Windows host in this
 * project's loop — and that is written here rather than left for a reader to
 * discover: on Windows every escape fact this module supplies is unverified, and
 * item 7's report says so.
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
 * `pid <cmd>`, trimmed — evidence a reader can act on rather than a count.
 *
 * The limit is 120 by default because most callers print a whole column of
 * these. A caller judging PROVENANCE asks for more: an item's scratch directory
 * under `$TMPDIR` is 85 characters on this host before the run root is even
 * reached, so 120 clips away the very path a classification turned on.
 *
 * IT IS AN OPTIONS OBJECT AND NOT A NUMBER, and that is the whole reason the
 * second parameter looks like this. It WAS `limit = 120`, and two callers say
 * `list.map(nameProcess)` — so `Array.prototype.map` handed the ELEMENT INDEX
 * in as the limit and the first process in every list rendered as `…` and the
 * second as `/…`. It type-checked, because `(row, limit?: number)` is a
 * perfectly good map callback. MEASURED in a live item 7 run on 2026-08-19,
 * where the reaped-process evidence came back as `pid 63885 (ppid 1, pgid
 * 63057): …` — the command line, which is the only actionable part, gone. An
 * object is not assignable from `number`, so the same mistake is now a
 * compile error rather than a report that quietly says nothing.
 */
export function nameProcess(row: ProcessFacts, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 120;
  const command = row.commandLine.length > limit ? `${row.commandLine.slice(0, limit)}…` : row.commandLine;
  return `pid ${row.pid} (ppid ${row.ppid}, pgid ${row.pgid || "n/a"}): ${command}`;
}

/**
 * What may follow a path in an argv without being part of it: a separator, or
 * the end of the word.
 *
 * The whole reason this is not `commandLine.includes(dir)`: two of item 7's own
 * run roots are `<workdir>/runs` and `<workdir>/runs-3`, and a plain substring
 * test says every process under the SECOND is also under the first. That is not
 * a hypothetical — it is the exact pair the survivor classification partitions
 * on, and getting it wrong would file a deliberately-abandoned worker under the
 * swept root, or the reverse.
 *
 * It is an ALLOW-list of terminators rather than a deny-list of name
 * characters, because a deny-list has to guess which bytes a filename may
 * contain and POSIX's answer is "all of them but `/`". A first draft said "any
 * character that cannot continue a name", and a critic pointed out on
 * 2026-08-19 that it therefore matched `runs~3`, `runs+3` and `runs:3` against
 * `runs`. Every extra terminator is a possible FALSE match; there is no such
 * thing as a missing one that is not simply a needle nobody writes.
 */
const ENDS_A_PATH = /[/\\\s"'`]/;

/**
 * What may precede a path in an argv without being part of it.
 *
 * Without a LEFT boundary, `/w/runs` matches inside `/a/w/runs` — a different
 * directory that merely ends the same way. Same critic, same date.
 */
const STARTS_A_PATH = /[\s"'`=:,(]/;

/**
 * Does this command line name `dir` — the directory itself, or anything under it?
 *
 * A match requires `dir` to be a whole path component run: bounded on the left
 * by the start of the string or a shell/argv delimiter, and on the right by a
 * separator or the end of the word. `runs-3` therefore does not match `runs`,
 * `runs` does not match `runs-3`, and neither matches `runsomething`,
 * `runs~3` or `/a/w/runs` when the needle is `/w/runs`.
 */
export function commandNamesDir(commandLine: string, dir: string): boolean {
  if (dir.length === 0) return false;
  for (let from = 0; ; ) {
    const at = commandLine.indexOf(dir, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : commandLine[at - 1];
    const after = commandLine[at + dir.length];
    const leftOk = before === undefined || STARTS_A_PATH.test(before);
    const rightOk = after === undefined || ENDS_A_PATH.test(after);
    if (leftOk && rightOk) return true;
    from = at + 1;
  }
}
