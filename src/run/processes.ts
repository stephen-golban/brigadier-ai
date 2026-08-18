// SPDX-License-Identifier: Apache-2.0
/**
 * The process table, and the two questions the sweep asks of it: what is running
 * that carries our marker, and is this pid still alive.
 *
 * WHY THIS EXISTS AT ALL — ruling 38, MEASURED at #43. Bun's Windows job object
 * is created with `JOB_OBJECT_LIMIT_BREAKAWAY_OK` **and**
 * `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` (`LIMIT_FLAGS=0x00003C00`, read from
 * inside the job), so `cmd /c start` escapes it — an ordinary idiom, not an
 * attack — as do `Win32_Process.Create` and `schtasks`, the last two because a
 * *system service* creates the process and it was therefore never in the job at
 * all. On POSIX a single `setsid()` puts a descendant in a new session and
 * `kill(-pgid)` no longer reaches it. brigadier cannot fix any of this, because
 * Bun creates the job. So the group kill is the fast path and THIS is the
 * containment mechanism.
 *
 * MEASURED against `bun 1.3.14` on macOS 26.5.2 (Darwin 25.5.0 arm64) on
 * 2026-08-17, with `python3 os.getsid`: a child spawned through
 * `node:child_process` with `detached: true` came back with
 * `sid == pgid == pid`, while its sibling spawned without the flag shared the
 * parent's session and process group. `detached` is a real `setsid(2)` on this
 * runtime, which is what `test/sweep-escape.test.ts` uses — macOS ships no
 * `setsid(1)`.
 *
 * MEASURED on the same host and date: `ps -A -o pid=,ppid=,args=` renders the
 * full argv including a `--brigadier-run=` marker and did not truncate a
 * 1,942-character line; `-ww` changed nothing. The Windows reader below is
 * **UNMEASURED** — there is no Windows host in this session — and it says so in
 * the table's own `limits`, because a sweep that silently returns an empty table
 * on a platform is indistinguishable from a machine with nothing to reclaim.
 */

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** The full command line as the platform renders it. Ruling 38's matching surface. */
  readonly commandLine: string;
}

/**
 * A reading of the process table, with what it could not see attached to it.
 *
 * `limits` is not decoration. Everything downstream of this — including the
 * `survivors: []` that `assertReclaimed` accepts — is only as complete as this
 * table, and the honest statement of that belongs on the reading rather than in
 * a comment somebody has to go and find.
 */
export interface ProcessTable {
  readonly rows: readonly ProcessRow[];
  /** How it was read: the argv, or `injected` in a test. Named in refusals and reports. */
  readonly source: string;
  readonly scannedAt: number;
  readonly limits: readonly string[];
}

export interface CommandResult {
  code: number;
  stdout: string;
}

export interface ScanOptions {
  run?: (argv: readonly string[]) => CommandResult;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** `ps` on POSIX. MEASURED to carry the full argv on macOS 26.5.2, 2026-08-17. */
export const POSIX_SCAN = ["ps", "-A", "-o", "pid=,ppid=,args="] as const;

/**
 * PowerShell CIM on Windows, and deliberately not `wmic`: `wmic` is deprecated
 * and absent from recent Windows images, and ruling 12 makes Windows first
 * class, so the reader has to be one that will still exist. UNMEASURED.
 */
export const WINDOWS_SCAN = [
  "powershell",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
] as const;

/**
 * The limits of any reading of a process table, stated once and carried
 * everywhere the reading goes.
 *
 * These are the reasons the sweep never claims to have found every process.
 */
export const SCAN_LIMITS: readonly string[] = [
  "a process that rewrote its own argv after exec, or exec'd something without the marker, does not match — ruling 38's marker lives in the process's own memory",
  "a process owned by another user is listed but not signalable: it becomes a survivor, never a silent success",
  "only this machine and this pid namespace are visible; a container or a remote host is not",
];

const WINDOWS_LIMIT =
  "UNMEASURED on Windows: no Windows host was available on 2026-08-17, so the PowerShell CIM reader below has never been observed producing a row";

function defaultRun(argv: readonly string[]): CommandResult {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
}

/** `<pid> <ppid> <the rest, verbatim>`. Both readers are shaped to produce this. */
const ROW = /^\s*(\d+)\s+(\d+)\s+(.*)$/;

export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = ROW.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const commandLine = match[3] ?? "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, commandLine });
  }
  return rows;
}

/**
 * Read the process table.
 *
 * A reader that fails is reported as a reading with no rows and a limit saying
 * so — never as an empty machine. The difference matters: "nothing matched"
 * would let a caller recycle a directory whose worker is still writing to it.
 */
export function scanProcessTable(options: ScanOptions = {}): ProcessTable {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const now = options.now ?? Date.now;
  const argv = platform === "win32" ? WINDOWS_SCAN : POSIX_SCAN;
  const limits = [...SCAN_LIMITS, ...(platform === "win32" ? [WINDOWS_LIMIT] : [])];

  let result: CommandResult;
  try {
    result = run(argv);
  } catch (error) {
    return {
      rows: [],
      source: argv.join(" "),
      scannedAt: now(),
      limits: [...limits, `the reader itself failed: ${(error as Error).message}. No row here means NOTHING WAS READ.`],
    };
  }
  if (result.code !== 0) {
    return {
      rows: [],
      source: argv.join(" "),
      scannedAt: now(),
      limits: [...limits, `the reader exited ${result.code}. No row here means NOTHING WAS READ.`],
    };
  }
  return { rows: parseProcessRows(result.stdout), source: argv.join(" "), scannedAt: now(), limits };
}

/**
 * Ask the kernel, not the caller.
 *
 * Signal 0 delivers nothing and reports whether the pid exists. `EPERM` means it
 * exists and belongs to somebody else, which is ALIVE — the mistake in the other
 * direction reports a running process as reclaimed. This is the same predicate
 * `assertReclaimed` applies to every pid the sweep claims, deliberately: the
 * consumer re-derives the fact rather than believing the report.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type SignalResult = "sent" | "gone" | "denied";

/** Signal one pid. Never throws: each outcome is a different fact about the world. */
export function signalPid(pid: number, signal: NodeJS.Signals): SignalResult {
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "denied";
  }
}

/**
 * Every pid between `pid` and the root of the tree, `pid` included.
 *
 * The sweep needs this because of a failure mode with no second chance: the
 * orchestrator's own command line carries the run marker, and so does the shell
 * that launched it if the operator typed the marker. A sweep that matched itself
 * would kill the process performing the sweep, and on Windows a job-object kill
 * of its own tree would take the operator's terminal with it.
 *
 * A cycle in the table (which should be impossible, and which a corrupt reading
 * can still produce) terminates the walk rather than hanging it.
 */
export function ancestorsOf(pid: number, rows: readonly ProcessRow[]): Set<number> {
  const parent = new Map<number, number>();
  for (const row of rows) parent.set(row.pid, row.ppid);
  const chain = new Set<number>([pid]);
  let current = pid;
  for (;;) {
    const next = parent.get(current);
    if (next === undefined || next <= 0 || chain.has(next)) return chain;
    chain.add(next);
    current = next;
  }
}
