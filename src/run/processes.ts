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
  "a descendant already reparented to pid 1 has no link back to its marked ancestor, so the ppid closure cannot reach it; only the WORKING DIRECTORY reading can, and only while it is still sitting inside a directory the manifest records",
];

const WINDOWS_LIMIT =
  "UNMEASURED on Windows: no Windows host was available on 2026-08-17, so the PowerShell CIM reader below has never been observed producing a row";

/**
 * Every reader here is BOUNDED, and that is a correctness rule rather than
 * hygiene: `lsof` blocks on an unresponsive mount and `ps` on a wedged kernel
 * queue, and both of these run at START. A sweep that hangs is a brigadier that
 * never starts, which is a worse outcome than a reading that comes back empty
 * with its reason attached — the shape everything downstream already handles.
 *
 * MEASURED against `bun 1.3.14` on macOS 26.5.2 on 2026-08-18: `Bun.spawnSync`
 * honours `timeout`, returning `exitCode: null` and `signalCode: "SIGTERM"`
 * after 802 ms for a `timeout: 800` on `sleep 5`. A null exit code is rendered
 * as `-1` here so that the caller's `code !== 0` branch reports it.
 */
export const READER_TIMEOUT_MS = 10_000;

function defaultRun(argv: readonly string[]): CommandResult {
  const result = Bun.spawnSync([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: READER_TIMEOUT_MS,
  });
  return { code: result.exitCode ?? -1, stdout: new TextDecoder().decode(result.stdout) };
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

/**
 * Every process descended from `roots`, transitively, `roots` included.
 *
 * Ruling 38 requires every process brigadier CAUSES TO EXIST to carry the
 * marker, and brigadier cannot mark a grandchild an agent spawns: an ordinary
 * `sh … &` inside a worker produces an unmarked child that outlives the worker
 * and is reparented to pid 1. So the sweep reclaims the transitive closure of
 * the marked set rather than the marked set, and the ppid column of the SAME
 * reading is what makes the closure computable.
 *
 * What this does not reach, stated: a descendant that was already reparented
 * before the table was read has no link back to its marked ancestor and is
 * invisible here, exactly as it is to `ps`. That is in `SCAN_LIMITS`.
 */
export function descendantsOf(roots: Iterable<number>, rows: readonly ProcessRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  const closure = new Set<number>(roots);
  const queue = [...closure];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    for (const child of children.get(current) ?? []) {
      if (closure.has(child)) continue;
      closure.add(child);
      queue.push(child);
    }
  }
  return closure;
}

/* -------------------------------------------------------------------------
 * The SECOND reading: where each process is standing, and whether a person is
 * standing there with it.
 * ---------------------------------------------------------------------- */

/**
 * Why a second reading exists at all, and what it is for.
 *
 * `SCAN_LIMITS` above concedes the exact case ruling 38 was promoted to cover.
 * The archetypal escapee — an ordinary `sh … &` inside a worker, or one real
 * `setsid(2)` — is UNMARKED, because brigadier cannot write argv for a process
 * an agent spawns, and it is REPARENTED TO PID 1 the moment the shell that
 * launched it exits. Unmarked severs the command-line match; reparenting severs
 * the ppid closure. Both links are gone within milliseconds, and the sweep then
 * reports `survivors: []` about a process that is still writing to disk.
 *
 * REPRODUCED on this host on 2026-08-18 before this reader existed: a `/bin/sh`
 * loop spawned with `detached: true` from a short-lived launcher came back with
 * `ppid 1`, outlived the sweep of its own run, and the sweep's evidence said
 * `reclaimedPids: [worker, sleep], survivors: []` while the escapee's heartbeat
 * grew from 6 to 11 bytes across the measurement.
 *
 * WHAT IS LEFT WHEN BOTH LINKS ARE CUT. The kernel gives a child three things
 * its parent chose and nothing can take back: its argv, its environment and its
 * WORKING DIRECTORY. argv is already used and does not survive an agent-spawned
 * process. The environment would be ideal — `BRIGADIER_WORKER` is already in
 * every worker's environment and is inherited by every descendant — except that
 * it is not READABLE: MEASURED against `ps` on macOS 26.5.2 (Darwin 25.5.0
 * arm64) on 2026-08-18, `ps -E -p <pid> -o args=` and `ps eww -p <pid>` printed
 * the argv and NO environment for a same-uid child of the calling shell, so the
 * channel exists but cannot be observed from outside the process.
 *
 * The working directory can be. MEASURED on the same host and date:
 * `lsof -w -n -d cwd -F pn` returned exit 0, 1,776 lines, in 134–302 ms, and
 * resolved the cwd of a same-uid `sleep` to its full real path
 * (`/private/tmp/...`, already `realpath`-resolved by lsof).
 *
 * AND WHY THAT IS AUTHORITY RATHER THAN A GUESS. It is ruling 15's shape
 * applied to a process instead of a directory: the directory being matched
 * against is one brigadier RECORDED IN A MANIFEST BEFORE IT CREATED IT. A
 * process standing inside it is standing inside brigadier's own isolation, and
 * nothing else on the machine has a reason to be there. Compare the marker,
 * which is identity only — `start.ts` already refuses to signal a marked
 * process belonging to a run this root has no record of, for that reason.
 *
 * EXCEPT FOR ONE OCCUPANT WHO IS NOT A LEAKED WORKER: the operator. brigadier
 * RETAINS the clones of interrupted runs and PRINTS THEIR PATHS, so `cd`-ing
 * into one to read the work is a thing the product invites. That shell is
 * matched by the working-directory rule and must never be signalled.
 *
 * THE DISCRIMINATOR IS NOT A CONTROLLING TERMINAL ON ITS OWN, and the first
 * version of this reading got that wrong. A controlling terminal belongs to the
 * SESSION, not to the file descriptors, so when the operator starts brigadier
 * from a terminal EVERY worker and every descendant is in that session and
 * reports the same `ttys000` — the guard would have spared the whole tree
 * exactly when brigadier is run the ordinary way. What separates the operator's
 * own work is JOB CONTROL: an interactive shell puts each job it starts in its
 * OWN process group, and non-interactive shells do not.
 *
 * So the rule is a controlling terminal AND `pgid == pid`, and MEASURED on
 * macOS 26.5.2 (Darwin 25.5.0 arm64) on 2026-08-18 with
 * `ps -A -o pid=,pgid=,tty=` it separates the two cases cleanly:
 *
 *   28960 28953 ??       /bin/sh -c while :; do sleep 0.4; done   <- escapee
 *   28963 28963 ttys000  sleep 6                                  <- a person's job
 *
 * The escapee was launched through `sh -c 'nohup … &'` from a non-interactive
 * parent, so it inherited its spawner's process group and leads nothing; the
 * second was the foreground job of a real pty allocated by `script -q
 * /dev/null`, so job control made it a process group leader with the terminal.
 */
export interface WorkspaceReading {
  /** pid → its working directory, as the platform resolved it. */
  readonly cwds: ReadonlyMap<number, string>;
  /**
   * Pids that hold a controlling terminal AND lead their own process group:
   * a person's shell, or a job that person's shell started. Reported, never
   * signalled.
   */
  readonly interactive: ReadonlySet<number>;
  readonly source: string;
  readonly limits: readonly string[];
}

/** MEASURED to resolve a same-uid process's cwd on macOS 26.5.2 on 2026-08-18. */
export const POSIX_CWD_SCAN = ["lsof", "-w", "-n", "-d", "cwd", "-F", "pn"] as const;
/** MEASURED to separate a person's job from an escapee on the same host and date. */
export const POSIX_TTY_SCAN = ["ps", "-A", "-o", "pid=,pgid=,tty="] as const;

/**
 * A reading with nothing in it, and the reason it is empty attached.
 *
 * Never an implicit empty: an empty `cwds` is indistinguishable from a machine
 * where nothing is standing anywhere, and that difference is the one that
 * licenses a recycle.
 */
export function noWorkspaceReading(source: string, why: string): WorkspaceReading {
  return { cwds: new Map(), interactive: new Set(), source, limits: [why] };
}

const WINDOWS_CWD_LIMIT =
  "on Windows there is no working-directory reading: `Win32_Process` exposes no `CurrentDirectory`, so a descendant that escaped the job object AND lost its parent is reachable by neither link. UNMEASURED besides — no Windows host was available on 2026-08-18";

/** `p<pid>` sets the current process; `n<path>` is that process's cwd. `f` lines are ignored. */
export function parseCwdRows(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let current: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const kind = line[0];
    if (kind === "p") {
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (kind !== "n" || current === null) continue;
    const path = line.slice(1);
    if (path.length > 0 && !cwds.has(current)) cwds.set(current, path);
  }
  return cwds;
}

/**
 * `<pid> <pgid> <tty>`. A person is a process group LEADER holding a terminal.
 *
 * `??` (macOS), `?` (Linux) and `-` all mean no controlling terminal. The pgid
 * half is what makes this a discriminator rather than a blanket exemption for
 * every process in the operator's session — see `WorkspaceReading`.
 */
export function parseTerminalRows(output: string): Set<number> {
  const held = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const tty = match[3] ?? "";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (tty === "?" || tty === "??" || tty === "-") continue;
    if (pgid !== pid) continue;
    held.add(pid);
  }
  return held;
}

/**
 * Read where every visible process is standing, and who holds a terminal.
 *
 * Two readers rather than one because no single POSIX command reports both, and
 * both are bounded by a timeout: `lsof` can block on an unresponsive mount, and
 * a sweep that hangs is a start that never happens. A reader that fails, times
 * out or is absent produces an EMPTY reading WITH THE REASON — the sweep then
 * degrades to the command-line closure alone, which is what it did before this
 * existed, and says so in its limits rather than silently narrowing.
 */
export function readWorkspaceOccupants(options: ScanOptions = {}): WorkspaceReading {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return noWorkspaceReading("unavailable", WINDOWS_CWD_LIMIT);
  const run = options.run ?? defaultRun;
  const source = `${POSIX_CWD_SCAN.join(" ")} + ${POSIX_TTY_SCAN.join(" ")}`;
  const limits: string[] = [];

  let cwds = new Map<number, string>();
  try {
    const result = run(POSIX_CWD_SCAN);
    // `lsof` exits non-zero when ANY process was inaccessible, which is the
    // normal case for a non-root reading of a shared machine. The rows it did
    // produce are still facts, so the exit code becomes a limit and not a
    // discard — but a reading with no rows at all is reported as nothing read.
    cwds = parseCwdRows(result.stdout);
    if (result.code !== 0) {
      limits.push(
        `\`${POSIX_CWD_SCAN.join(" ")}\` exited ${result.code} and produced ${cwds.size} row(s): ` +
          "processes it could not open are absent from this reading, and a descendant standing in a clone " +
          "may be one of them",
      );
    }
    if (cwds.size === 0) {
      limits.push(
        `\`${POSIX_CWD_SCAN.join(" ")}\` produced NO rows. No working directory here means NOTHING WAS READ, ` +
          "not that nothing is standing in a clone",
      );
    }
  } catch (error) {
    return noWorkspaceReading(
      source,
      `the working-directory reader itself failed: ${(error as Error).message}. Nothing was read, ` +
        "so a reparented descendant inside a clone is invisible to this sweep",
    );
  }

  // A terminal reading that fails is the DANGEROUS direction: without it every
  // occupant looks like a leaked worker, including the operator's own shell. So
  // a failure here empties the whole reading rather than half of it.
  let interactive = new Set<number>();
  try {
    const result = run(POSIX_TTY_SCAN);
    if (result.code !== 0) {
      return noWorkspaceReading(
        source,
        `\`${POSIX_TTY_SCAN.join(" ")}\` exited ${result.code}, so brigadier cannot tell a leaked ` +
          "descendant from the operator's own shell sitting in a retained clone. The whole " +
          "working-directory reading is discarded rather than acted on half-blind",
      );
    }
    interactive = parseTerminalRows(result.stdout);
  } catch (error) {
    return noWorkspaceReading(
      source,
      `the controlling-terminal reader failed: ${(error as Error).message}. Without it the ` +
        "operator's shell inside a retained clone is indistinguishable from a leaked worker, so " +
        "nothing is matched by working directory at all",
    );
  }

  return { cwds, interactive, source, limits };
}
