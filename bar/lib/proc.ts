// SPDX-License-Identifier: Apache-2.0
/**
 * Running the artifact under test, and running `git` beside it.
 *
 * Two disciplines from `AGENTS.md` are structural here rather than remembered:
 *
 *   Never `cmd | head` and then read `$?` — that is head's exit code. Nothing in
 *   this directory pipes; every invocation captures both streams whole and the
 *   exit status comes from the process object.
 *
 *   Never capture multi-line output into a shell variable. There is no shell:
 *   argv is passed as an array, so nothing is word-split, quoted or globbed on
 *   the way in.
 *
 * `env` REPLACES the environment rather than extending it. Several items plant
 * their ground truth by controlling `PATH` exactly — an agent renamed off it, a
 * decoy binary of the same name at a known absolute path — and a merge would
 * silently reintroduce the real one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunOptions, RunResult } from "../types.ts";

/** Signals a `timeoutMs` expiry rather than a normal exit. */
export const TIMEOUT_SIGNAL = "BAR_TIMEOUT";

/**
 * The subject's own worker deadline, and this harness's, in the only order that
 * can tell a hang from a slow success.
 *
 * MEASURED on this host on 2026-08-18: the harness gave a full `brigadier run`
 * 300 s while the product gives each worker 600 s
 * (`DEFAULT_WORKER_TIMEOUT_MS`). So on every slow or wedged worker the harness
 * SIGKILLed brigadier at 300 s — strictly before brigadier's own deadline could
 * fire — and the run produced no record, no reasons and no transcript. The
 * result was "no `run-record:` path", which is the least informative failure
 * available and is indistinguishable between a deadlocked fixture, a genuinely
 * hung product and a product that was three seconds from finishing. It was in
 * fact a deadlocked fixture (`bar/fakes/vendor.ts`), and six items were graded
 * against the product for it.
 *
 * **The rule: the harness deadline must exceed the subject's own by enough for
 * the subject to finish reporting after its deadline fires.** A harness that
 * kills its subject before the subject can explain itself is not measuring the
 * subject. Set the other way round the harness learns one bit; set this way it
 * gets whatever account the product is able to give, and "the product timed out
 * a worker and said so" becomes a PASS-or-FAIL judgement about behaviour rather
 * than a missing file.
 *
 * This costs wall clock only when something is already broken: a run that
 * finishes returns the moment it finishes, and only a hang runs to the deadline.
 * That is the right trade — the expensive case is the one that must be legible.
 *
 * `SUBJECT_WORKER_TIMEOUT_MS` is a deliberate second copy of a product constant,
 * because `bar/` imports nothing from `src/`. Copies go stale silently unless
 * something asserts on them, so `bar/lib/timeout-order.test.ts` reads the
 * product's own source and fails if the two ever cross.
 */
export const SUBJECT_WORKER_TIMEOUT_MS = 600_000;

/** Room for the subject to time a worker out, unwind, sweep and write a record. */
export const REPORTING_MARGIN_MS = 120_000;

/** Every full `brigadier run` the bar drives is given this. */
export const HARNESS_RUN_TIMEOUT_MS = SUBJECT_WORKER_TIMEOUT_MS + REPORTING_MARGIN_MS;

export async function exec(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error("exec: empty argv");

  const started = performance.now();
  const proc = Bun.spawn([command, ...rest], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // A new session/group, so a timeout can reclaim the WHOLE tree rather than
    // just this one pid. Measured on this host on 2026-08-18: a run of the
    // real binary that this function SIGKILLed on timeout left its own ACP
    // vendor children behind, reparented to init and each pinning a core —
    // `--brigadier-run` markers still in their command lines, no run root left
    // to sweep them from because the item's `finally` had already deleted it.
    // Killing a single pid was never going to catch a child of that pid.
    detached: true,
  });

  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc);
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  return {
    stdout,
    stderr,
    code: timedOut ? null : proc.exitCode,
    signal: timedOut ? TIMEOUT_SIGNAL : proc.signalCode,
    // Two decimals, not whole milliseconds: the start-up budget is 10 ms and the
    // spawn floor is under 1 ms, so rounding to integers would round away the
    // correction that makes the budget honest.
    ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

/**
 * Kill a timed-out invocation's WHOLE process group, not just the pid `exec`
 * holds a handle to.
 *
 * `detached: true` makes that pid a session/group leader, so on POSIX
 * `process.kill(-pid, ...)` reaches every contained descendant in one signal —
 * exactly the group kill ruling 38 describes the product doing to its own
 * workers. It is best-effort: a descendant that has ALREADY escaped its group
 * (item 7's own fixture, deliberately) is untouched by this and is the
 * product's sweep's job, not this harness's.
 */
export function killTree(proc: Bun.Subprocess): void {
  const pid = proc.pid;
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone, or never became a group leader (e.g. it exec'd into
    // something that dropped the session) — either way, the direct kill below
    // is the fallback that still applies.
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Exited between the group kill and this line, which is the outcome we wanted.
  }
}

/**
 * A minimal environment that still lets a compiled binary start.
 *
 * `HOME`, `USER` and the Windows quartet are here for the reason v1 recorded the
 * hard way: every Claude worker failed with `Not logged in` when `USER` was
 * absent, `LOGNAME` did not substitute, and it was found only by bisecting the
 * real binary. A harness that strips the environment down to `PATH` would
 * reproduce that as a mystery.
 */
export function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const keep = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PATHEXT",
    "COMSPEC",
  ];
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["PATH"] = process.env["PATH"] ?? "";
  return { ...env, ...overrides };
}

/**
 * How long this harness takes to spawn and reap a process that does nothing.
 *
 * Without it a start-up budget measures the measuring instrument. MEASURED on
 * darwin 25.5.0 with bun 1.3.14 on 2026-08-17: the floor is ~0.9 ms against
 * `/usr/bin/true` through `Bun.spawn` and ~1.4 ms through Python's
 * `subprocess.run`, against a 14 ms artifact — small, but a tenth of the 10 ms
 * warm budget, which is enough to move a verdict.
 *
 * Best-of-N rather than a mean: this is a floor, and the tail is scheduler
 * noise that belongs to the machine rather than to either process.
 */
export async function spawnFloorMs(samples = 8): Promise<number> {
  const argv =
    process.platform === "win32"
      ? ["cmd", "/c", "exit"]
      : existsSync("/usr/bin/true")
        ? ["/usr/bin/true"]
        : ["/bin/sh", "-c", ":"];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i++) {
    const result = await exec(argv, { timeoutMs: 30_000 });
    best = Math.min(best, result.ms);
  }
  return best;
}

/** Directories on `PATH` that do not contain an executable called `name`. */
export function pathWithout(name: string): string {
  const separator = process.platform === "win32" ? ";" : ":";
  const entries = (process.env["PATH"] ?? "").split(separator).filter((d) => d.length > 0);
  const candidates =
    process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  return entries
    .filter((dir) => !candidates.some((c) => existsInDir(dir, c)))
    .join(separator);
}

function existsInDir(dir: string, name: string): boolean {
  // `Bun.file().size` is 0 for a missing file as well as an empty one, so this
  // asks the filesystem rather than inferring from a length.
  return existsSync(join(dir, name));
}
