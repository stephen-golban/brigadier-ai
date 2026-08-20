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

/**
 * How long a stream is given to close AFTER the process holding it is dead.
 *
 * This is the kernel's flush and nothing else: the reader below is draining
 * continuously, so anything already written is already collected, and what this
 * budget waits for is the last write end being released. A well-behaved tree
 * releases it the instant the last process exits. Two seconds is therefore
 * enormous for the honest case and short enough that the dishonest one — a
 * descendant that escaped the group and still holds the pipe — cannot hold this
 * harness open.
 */
export const STREAM_DRAIN_GRACE_MS = 2_000;

/**
 * Appended to a stream that had to be abandoned, and exported so a caller can
 * test for it rather than pattern-match prose.
 *
 * Ruling 62's evidence standard, applied to the instrument itself: a truncated
 * stream returned silently is INDISTINGUISHABLE from a program that printed
 * nothing, and "printed nothing" is a conclusion several items draw. So the
 * bytes say so in the bytes.
 */
export const STREAM_TRUNCATED_MARKER = "<BAR-STREAM-TRUNCATED";

/**
 * Exported, because `bar/lib/inflight.ts` spawns the binary the same way and
 * must have the SAME bound. Two copies of a timeout rule drift, and the drift is
 * invisible until the day one of them hangs.
 */
export interface Drain {
  /** Resolves when the stream reaches its end, or is torn down. */
  readonly done: Promise<void>;
  /** True once `done` has resolved. False means whatever `text()` returns is partial. */
  settled(): boolean;
  /** Everything decoded SO FAR. Safe to call before `done` resolves. */
  text(): string;
}

/**
 * Read a stream incrementally, so abandoning it still yields what it said.
 *
 * `new Response(stream).text()` is all-or-nothing: abandon it and you get
 * NOTHING, which is the outcome this whole change exists to prevent. Chunks are
 * accumulated as they arrive, so the bound below can stop waiting without
 * throwing away the output that had already crossed the pipe.
 */
export function drain(stream: ReadableStream<Uint8Array>): Drain {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let finished = false;
  const done = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (step.value !== undefined) chunks.push(decoder.decode(step.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch {
      // Torn down under us — it has given us everything it is going to give.
    } finally {
      finished = true;
    }
  })();
  return { done, settled: () => finished, text: () => chunks.join("") };
}

export function truncationNote(name: string, drained: Drain, why: string): string {
  if (drained.settled()) return "";
  return (
    `\n${STREAM_TRUNCATED_MARKER} ${name}: ${drained.text().length} bytes captured, then this stream was ` +
    `ABANDONED ${STREAM_DRAIN_GRACE_MS} ms after ${why}. Something that is not the process this harness ` +
    "spawned still holds the write end of this pipe — an escaped descendant. What is above is PARTIAL, and " +
    "an empty or short stream here is not evidence that the program printed nothing.>"
  );
}

/**
 * The grace, as a CANCELLABLE timer rather than a `Bun.sleep`.
 *
 * A `Bun.sleep` left behind by every healthy call keeps the event loop alive,
 * so a bar run of several hundred invocations would end by sitting on a pile of
 * timers with nothing to wait for. This one is cleared the moment the streams
 * close, which is the ordinary case.
 */
export function abandonAfter(dead: Promise<unknown>, ms: number): { done: Promise<false>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const done = dead.then(
    () =>
      new Promise<false>((resolve) => {
        // Cancelled before the process even died: never resolve. Nothing awaits
        // this once the race is decided, and a resolved value here would be a
        // truncation verdict about a call that already finished cleanly.
        if (cancelled) return;
        timer = setTimeout(() => resolve(false), ms);
      }),
  );
  return {
    done,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * `detached: true` on POSIX, and NOT on Windows. Both halves are measurements.
 *
 * **POSIX.** A new session/group is what lets `killTree` reclaim the WHOLE tree
 * with one signal rather than the single pid this module holds a handle to.
 * MEASURED on this host on 2026-08-18: a run this function SIGKILLed on timeout
 * left its own ACP vendor children behind, reparented to `launchd`, each pinning
 * a core, `--brigadier-run` markers still in their command lines. Removing it
 * there would reinstate that leak, so it is not removed there.
 *
 * **WINDOWS. It cost every output reading on the leg, and the cause is a
 * CONJUNCTION that no amount of argument would have separated.** VERIFIED
 * against run 32387095326 and re-measured deliberately on `windows-latest` on
 * 2026-08-20 by `bar/lib/capture.test.ts`, which drives the 2x2 plus two
 * synchronous controls against a subject that writes a token to both streams and
 * exits 3:
 *
 *     sync/direct                  exit 3   stdout OK      stderr OK
 *     sync/shim                    exit 3   stdout OK      stderr OK
 *     async/direct/attached        exit 3   stdout OK      stderr OK
 *     async/direct/DETACHED        exit 3   stdout OK      stderr OK
 *     async/SHIM/attached          exit 3   stdout OK      stderr OK
 *     async/SHIM/DETACHED          exit 3   stdout <empty> stderr <empty>
 *
 * **`detached` alone captures. The `.cmd` shim alone captures. Together they
 * lose both streams while the exit code survives intact** — which is exactly the
 * symptom the triage read off the leg, `exit 4; stdout: <empty>; stderr:
 * <empty>`, and could not attribute. Bun reaches a `.cmd` through `cmd.exe`, and
 * a `cmd.exe` created with `DETACHED_PROCESS` does not carry this harness's pipe
 * handles through to the program it runs. Every fixture binary the bar drives is
 * a `.cmd` on Windows — `bar/lib/fs.ts`'s `writeScript` writes one — so every
 * item was graded blind there, and `bar/fakes.test.ts` spent 965,957 ms doing it.
 *
 * **Nothing is lost by dropping it on Windows**, and that is the reason it is
 * safe rather than merely convenient: `killTree`'s Windows arm is
 * `taskkill /T /F /PID`, which walks the PARENT-PID TREE and needs no process
 * group at all. The group is a POSIX mechanism and the flag that creates it buys
 * nothing on the platform that pays for it. Removing it UNCONDITIONALLY would
 * have reinstated the POSIX leak above, which is why this is a branch and not a
 * deletion.
 *
 * **What it costs, stated:** on Windows a spawned child now shares this
 * process's console, so a Ctrl-C delivered to the harness reaches it too. That
 * is a change in interactive behaviour on a platform where this harness is run
 * by CI, and it is written down rather than discovered.
 */
export const DETACH_FOR_GROUP_KILL = process.platform !== "win32";

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
    //
    // DELIBERATELY NOT ON WINDOWS, where combined with a `.cmd` shim it is what
    // loses the subject's output. Both halves are measured; see
    // `DETACH_FOR_GROUP_KILL` for the 2x2 that separated them.
    ...(DETACH_FOR_GROUP_KILL ? { detached: true } : {}),
  });

  // Read from the first instant, and INCREMENTALLY. An unread pipe fills its
  // kernel buffer and blocks the writer, so a harness that waits before reading
  // is a harness that wedges its subject and then measures the wedge.
  const out = drain(proc.stdout);
  const err = drain(proc.stderr);

  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let killedNow: () => void = () => {};
  const killed = new Promise<void>((resolve) => {
    killedNow = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc);
    killedNow();
  }, timeoutMs);

  // THE BOUND, and the reason this function no longer awaits the reads directly.
  //
  // MEASURED as a hang, not reasoned about. `killTree` reclaims the process
  // GROUP, and item 7's own fixture — like any `setsid`/`cmd /c start`
  // descendant, which #43 measured as an ordinary idiom rather than an attack —
  // is deliberately outside it. Such a descendant inherits the write end of
  // these pipes, so the stream never ends, and `await new Response(…).text()`
  // never returns. MEASURED against `bun 1.3.14` on darwin 25.5.0 on
  // 2026-08-19, replaying the old line verbatim against the fixture in
  // `bar/lib/proc.test.ts`: the group kill was delivered at 2 s and the read was
  // STILL BLOCKED at 12 s with the holder alive, while the bounded form below
  // returns on the same fixture in about 4 s. The timeout had already fired, the kill had already been
  // sent, and this function sat there anyway: cleanup downstream of an
  // unbounded wait is cleanup that never runs. Every item reaches this through
  // `ctx.run`.
  //
  // The grace starts only when the process is DEAD — on its own or by the
  // timeout's kill — so a slow but healthy run is never truncated, and a
  // successful run whose child leaked is bounded by the grace rather than by the
  // whole remaining timeout.
  const finished = Promise.all([out.done, err.done, proc.exited]).then(() => true);
  const abandon = abandonAfter(Promise.race([proc.exited.then(() => undefined), killed]), STREAM_DRAIN_GRACE_MS);
  const closed = await Promise.race([finished, abandon.done]);
  clearTimeout(timer);
  abandon.cancel();
  const why = timedOut ? "its timeout reclaimed the process group" : "the process exited";
  if (!closed) {
    // Something outlived the process and is holding a pipe. That is a leak
    // whether or not the run timed out, and the group is this harness's to
    // reclaim — the same call the timeout makes, for the same reason.
    killTree(proc);
    // Bounded too: an `await proc.exited` that cannot complete would reinstate
    // the hang one line below the fix for it.
    const last = abandonAfter(Promise.resolve(), STREAM_DRAIN_GRACE_MS);
    await Promise.race([proc.exited, last.done]);
    last.cancel();
  }

  return {
    stdout: out.text() + truncationNote("stdout", out, why),
    stderr: err.text() + truncationNote("stderr", err, why),
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
 *
 * ON WINDOWS THIS NEEDS NO GROUP AND NEVER DID. `taskkill /T /F /PID` walks the
 * PARENT-PID TREE, so it reclaims descendants whether or not the child leads a
 * group — which is why `DETACH_FOR_GROUP_KILL` can drop the flag there without
 * weakening anything. It is still UNMEASURED on that platform:
 * `bar/lib/proc.test.ts`'s three arms that would drive it fail loudly there
 * rather than returning early (ruling of 2026-08-20, `bar/lib/platform.ts`).
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
