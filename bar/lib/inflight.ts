// SPDX-License-Identifier: Apache-2.0
/**
 * Watching the run happen, rather than reading its wreckage afterwards.
 *
 * A forger can construct any residue at leisure — a ref, a tree, a record, a
 * directory listing — and the previous harness inferred every one of its
 * isolation and concurrency claims from exactly that. What a forger cannot
 * cheaply fake is a **live process tree**: N clone directories existing at the
 * same moment, each a real git repository with `origin` gone and the base commit
 * present, and N processes carrying ruling 38's marker in their COMMAND LINE.
 *
 * Ruling 38 is explicit that the marker is the command line and never a name
 * pattern, and that is why the sampler below reads `args` rather than `comm`: an
 * environment variable is invisible to a sweep scanning `ps`, and a name pattern
 * matches whatever else happens to be called the same thing.
 *
 * The samples are maxima over the life of the run. "Two clones existed at some
 * instant" is the isolation claim; "two clones existed in total" is not, and the
 * difference is the whole of ruling 19's bounded work queue.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HARNESS_RUN_TIMEOUT_MS,
  STREAM_DRAIN_GRACE_MS,
  TIMEOUT_SIGNAL,
  abandonAfter,
  drain,
  killTree,
  truncationNote,
} from "./proc.ts";
import { readProcessTable } from "./process-table.ts";

/**
 * Ruling 38's marker, as `src/agent/marker.ts` spells it.
 *
 * Written out rather than imported: `bar/` imports nothing from `src/`, because
 * a harness built from the product's own constants cannot notice the product
 * changing one. If this string and the product's ever diverge, that divergence
 * is a finding.
 */
export const RUN_MARKER_FLAG = "--brigadier-run";

/**
 * The marker CARRYING A VALUE, which is what a spawned worker actually has.
 *
 * HARDENED 2026-08-20, after this scanner counted a process that merely MENTIONED
 * the flag. While diagnosing an unrelated failure a shell ran
 * `ps -A -o args= | grep -a -- --brigadier-run`, and that pipeline's own command
 * line contains the bare flag — so `includes(RUN_MARKER_FLAG)` matched it and
 * the check reported `peak processes carrying --brigadier-run: 2` with a
 * `/bin/zsh` command line as its evidence. The item PASSED on the strength of
 * the harness watching itself look. That is v1's marker-file defect one level
 * up: a check that cannot tell the thing from a reference to the thing.
 *
 * BOTH SEPARATORS, and the first attempt at this got it wrong by requiring `=`.
 * `src/run/marker.ts` says why, and the fixture proves it: "the space-separated
 * form is accepted on READ and never produced on write — argv-joining is a
 * property of whatever spawned the process, and a matcher that only understood
 * one form would silently miss a real worker." `bar/fakes/honest.ts` spawns
 * `[vendor, brief, "--brigadier-run", runId]` as two argv entries, so an
 * `=`-only needle failed the POSITIVE CONTROL — the fixture that really clones,
 * spawns, merges and records — on six items at once.
 *
 * So: the flag, a separator that is `=` or whitespace, then at least one
 * non-space character. A trailing bare mention has no value after it and no
 * longer matches. Written as a regex rather than imported from `src/`, per this
 * file's own rule.
 */
export const RUN_MARKER_CARRIED = new RegExp(`(?:^|\\s)${RUN_MARKER_FLAG.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[=\\s][^\\s]+`);

export interface CloneSample {
  path: string;
  isGitRepo: boolean;
  /**
   * Git payload files present INSIDE the clone at sample time.
   *
   * Captured here rather than after the run because a complete run sweeps its
   * clones — so by judgement time the evidence is gone, and the previous item
   * had to fall back on a receipt written by the party that would have planted
   * them.
   */
  payloadsSeen: string[];
  /** Ruling 51: a worker can push through the clone's own `origin`. */
  originRemoved: boolean;
  /**
   * Does this clone start from a SCRATCH BASE rather than from `HEAD`?
   *
   * The previous version looked for a ref literally called `bar-base`, which is
   * my own fixture's name — so it reported `false` against every real
   * implementation and would have stayed false forever. The property that is
   * actually promised is ruling 33's: the base commit carries the owner's
   * uncommitted tracked and untracked work, so it CANNOT equal the operator's
   * `HEAD`. That is checkable without knowing anyone's ref names.
   */
  hasBaseRef: boolean;
  /**
   * The local refs the clone's checkout actually descends from — evidence, so a
   * failure names what WAS in the clone instead of only that a probe said no.
   *
   * `refname@sha`, HEAD's own branch excluded. See `inspectClone` for why this
   * is a list of what was found rather than a lookup of a name we chose.
   */
  baseRefsSeen: string[];
}

export interface Flight {
  /** The most clones seen to exist AT THE SAME MOMENT. */
  peakConcurrentClones: number;
  /** The most processes carrying the run marker at the same moment. */
  peakMarkedProcesses: number;
  /** Every distinct clone path ever seen, with what it looked like. */
  clonesSeen: Map<string, CloneSample>;
  /** Command lines seen carrying the marker. Evidence, not just a count. */
  markedCommandLines: string[];
  samples: number;
}

const PAYLOAD_PATHS = [join(".git", "hooks", "pre-commit"), join(".git", "hooks", "reference-transaction"), join(".git", "bar-fsmonitor")];

/**
 * Payload files planted inside a clone, read from the filesystem.
 *
 * Separate from the git probes below because it has to run on EVERY sample: a
 * worker plants these while it works, so a clone already judged conforming can
 * still grow one. The git probes cannot say that, and they are the expensive
 * half.
 */
function scanPayloads(path: string, payloadMarker?: string): string[] {
  if (payloadMarker === undefined) return [];
  const payloadsSeen: string[] = [];
  for (const rel of PAYLOAD_PATHS) {
    try {
      if (existsSync(join(path, rel)) && readFileSync(join(path, rel), "utf8").includes(payloadMarker)) {
        payloadsSeen.push(rel);
      }
    } catch {
      // Swept between the listing and the read.
    }
  }
  return payloadsSeen;
}

function inspectClone(path: string, payloadMarker?: string, operatorHead?: string): CloneSample {
  const gitDir = join(path, ".git");
  const payloadsSeen = scanPayloads(path, payloadMarker);
  if (!existsSync(gitDir)) {
    return { path, isGitRepo: false, originRemoved: false, hasBaseRef: false, payloadsSeen, baseRefsSeen: [] };
  }
  const git = (args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(["git", `--git-dir=${gitDir}`, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
  };
  const remotes = git(["remote"]);
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  // THE BASE COMMIT, asked for as a PROPERTY rather than as a name.
  //
  // This probe used to be `rev-parse refs/heads/bar-base`, and `bar-base` is
  // the name `bar/fakes/honest.ts` — the FIXTURE — fetches its base onto. The
  // product fetches onto a name of its own, so the sub-check reported
  // `base=false` for every real clone: a check only the harness's own fake
  // could satisfy, which is the exact inversion of what a bar is for. Naming
  // the product's constant instead would only move the defect, because `bar/`
  // deliberately imports nothing from `src/` and a second copy goes stale
  // silently — as this one already had.
  //
  // Two independent properties, and the `&&` is deliberate:
  //
  //   1. The checkout DESCENDS FROM some other local ref. A clone made from a
  //      base state has one; a directory merely `git init`-ed and committed
  //      into has only the branch HEAD is on. `--merged HEAD` is ancestor-OR-
  //      EQUAL, which matters: between the base fetch and the agent's first
  //      commit the two are the same commit, and a stricter test would report
  //      `false` for a correct clone caught in that window — the sampling-luck
  //      failure this module already fought once.
  //   2. Ruling 33's property, when the caller knows it: the base commit
  //      carries the operator's uncommitted tracked and untracked work, so it
  //      CANNOT equal the operator's `HEAD`. Only item 4 passes `operatorHead`
  //      today, so (1) is what keeps the check honest for the rest — without
  //      it, an undefined `operatorHead` would degrade this to "HEAD resolves",
  //      which a forger satisfies by committing once.
  //
  // MEASURED (git 2.50.1, 2026-08-17) against all three shapes: a clone with
  // `brigadier-base` + `work` yields two candidates both before and after the
  // agent commits; the fixture's `bar-base` + `work` yields two; and `git init`
  // plus one commit yields NONE.
  const merged = git([
    "for-each-ref",
    "--merged",
    "HEAD",
    // `%(HEAD)` renders as `*` for the branch HEAD is on and as a SPACE for
    // every other — so it is bracketed rather than left bare. The `git` helper
    // above trims its whole output, which silently ate the leading space of the
    // first row and dropped that ref from the evidence; a delimiter that cannot
    // be trimmed away is the difference between reading three refs and two.
    "--format=[%(HEAD)]%09%(refname)@%(objectname:short)",
    "refs/heads/",
  ]);
  const baseRefsSeen = merged.ok
    ? merged.out
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((cols) => cols.length === 2 && cols[0] === "[ ]")
        .map((cols) => cols[1] as string)
    : [];
  return {
    path,
    isGitRepo: git(["rev-parse", "--git-dir"]).ok,
    originRemoved: remotes.ok && !remotes.out.split("\n").includes("origin"),
    hasBaseRef:
      head.ok &&
      head.out.length === 40 &&
      baseRefsSeen.length > 0 &&
      (operatorHead === undefined || head.out !== operatorHead),
    payloadsSeen,
    baseRefsSeen,
  };
}

/** Every directory under `root` that looks like a checkout, two levels deep. */
function findClones(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      if (existsSync(join(path, ".git"))) found.push(path);
      else walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * One reading.
 *
 * `processes` exists because the two halves of a sample cost wildly different
 * amounts. The clone half is a directory walk plus, for clones not yet observed
 * conforming, a few `git` calls; the process half is a whole `ps -A` of the
 * machine. Reading the clones must be fast enough to catch a directory that
 * exists for a second, and reading `ps` at that rate would cost more than it
 * measures — a marked process lives for the length of a worker, not for the
 * length of a `git clone`.
 */
export function sampleOnce(
  runRoot: string,
  flight: Flight,
  payloadMarker?: string,
  processes = true,
  operatorHead?: string,
): void {
  flight.samples += 1;

  const clones = findClones(runRoot);
  if (clones.length > flight.peakConcurrentClones) flight.peakConcurrentClones = clones.length;
  for (const path of clones) {
    const existing = flight.clonesSeen.get(path);
    // A clone already observed conforming is not re-probed with `git`, and the
    // reason is the sampler's own speed rather than tidiness. `inspectClone`
    // spawns THREE git processes per clone, so a five-clone run cost fifteen
    // spawns a sample; on a loaded machine that stretched the interval far past
    // its nominal 120 ms, and the LAST clone a run creates was then observed
    // exactly once — during its setup, after the base ref arrived and before
    // `origin` was removed — and that single unlucky instant was reported as
    // "origin-removed=false" for a product that had removed it a moment later.
    // Skipping the probes for clones already proven conforming keeps the check
    // exactly as strict (nothing is assumed about a clone that has not been
    // observed) and buys back the sampling rate that makes a late clone
    // observable more than once. Payloads are still read every sample, because
    // a worker plants those DURING the run.
    const proven =
      existing !== undefined && existing.isGitRepo && existing.originRemoved && existing.hasBaseRef;
    const sample = proven
      ? { ...(existing as CloneSample), payloadsSeen: scanPayloads(path, payloadMarker) }
      : inspectClone(path, payloadMarker, operatorHead);
    // Keep the BEST observation of each clone: a clone is momentarily
    // origin-ful while `git clone` is still running, and judging it on that
    // instant would be measuring the harness's sampling luck.
    const merged: CloneSample = existing
      ? {
          path,
          isGitRepo: existing.isGitRepo || sample.isGitRepo,
          originRemoved: existing.originRemoved || sample.originRemoved,
          hasBaseRef: existing.hasBaseRef || sample.hasBaseRef,
          payloadsSeen: [...new Set([...existing.payloadsSeen, ...sample.payloadsSeen])],
          baseRefsSeen: [...new Set([...existing.baseRefsSeen, ...sample.baseRefsSeen])],
        }
      : sample;
    flight.clonesSeen.set(path, merged);
  }

  if (!processes) return;
  // ONE process-table reader for the whole harness. This filter used to run over
  // a private `listProcesses()` that read `ps -A -o args=`; the structured
  // reader below reads the same `args` column with three numeric ones in front
  // of it. MEASURED on macOS 26.5.2 (Darwin 25.5.0) on 2026-08-19 at load1 1.64:
  // 507 rows either way, every row parsed, args text identical line for line
  // except each `ps`'s own argv, and the longest line grew by exactly the width
  // of the added columns — so nothing is truncated away from the END of a
  // command line, which is where this marker lives.
  // `RUN_MARKER_CARRIED`, not a bare `includes`: a process that merely names the
  // flag is not a process carrying the marker. See the constant for the sighting
  // that forced this, and for why both separators are accepted.
  const marked = readProcessTable().filter((row) => RUN_MARKER_CARRIED.test(row.commandLine));
  if (marked.length > flight.peakMarkedProcesses) flight.peakMarkedProcesses = marked.length;
  for (const row of marked) {
    const trimmed = row.commandLine.trim().slice(0, 160);
    if (trimmed.length > 0 && !flight.markedCommandLines.includes(trimmed)) flight.markedCommandLines.push(trimmed);
  }
}

export function emptyFlight(): Flight {
  return {
    peakConcurrentClones: 0,
    peakMarkedProcesses: 0,
    clonesSeen: new Map(),
    markedCommandLines: [],
    samples: 0,
  };
}

export interface SampledRun {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  ms: number;
  flight: Flight;
  /**
   * Streams that had to be ABANDONED because something still held the write end
   * of the pipe after the process was dead. Named, never a count.
   *
   * Empty on every healthy run. Non-empty means `stdout`/`stderr` above are
   * PARTIAL, and an item reading a short stream as "the binary printed nothing"
   * would be drawing a conclusion about the product from a fact about a leak.
   * The text carries `STREAM_TRUNCATED_MARKER` as well, so a caller that never
   * reads this field still cannot be misled by the bytes.
   */
  truncated: string[];
}

/**
 * Run the binary and watch the filesystem and the process table while it works.
 *
 * The sampling interval is deliberately short. A run that clones, works and
 * merges in 200 ms would otherwise be observed only at its endpoints, and the
 * endpoints are exactly what a forger controls.
 */
export async function runSampled(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    runRoot: string;
    intervalMs?: number;
    /** When set, hook files carrying this marker are recorded per clone. */
    payloadMarker?: string;
    /** The operator repository's HEAD, so a clone's base can be told from it. */
    operatorHead?: string;
  },
): Promise<SampledRun> {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error("runSampled: empty argv");

  const flight = emptyFlight();
  const started = performance.now();
  const proc = Bun.spawn([command, ...rest], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Same defect `bar/lib/proc.ts`'s `exec` had, and the same fix: a new
    // session/group so a timeout can reclaim the WHOLE tree — including any ACP
    // vendor children the real binary spawned — rather than just this one pid.
    detached: true,
  });

  let running = true;
  const sampler = (async () => {
    // BOTH halves run every turn, as of 2026-08-20.
    //
    // The `ps` half used to run every third turn, on the reasoning quoted in
    // `sampleOnce` — "a marked process lives for the length of a worker, not for
    // the length of a `git clone`". That is true of a real vendor and false of
    // this harness's fixture agents, which answer the handshake and exit in tens
    // of milliseconds.
    //
    // MEASURED 2026-08-20: with `run` now performing a detection sweep before
    // its first item (finding V1), items 3, 4, 9 and 12 all reported
    // `peak processes carrying --brigadier-run: 0` while the same runs recorded
    // `qwen --acp -- --brigadier-run=<run>/1` in `record.ndjson` and integrated
    // real commits. The marker was never missing — spawning that exact argv and
    // reading `ps` shows it for all three placements — the sampler was looking
    // one turn in three across a run that had grown several seconds of preamble
    // in which no worker exists.
    //
    // So this check was passing on luck, and the change that removed the luck
    // did not break the product. The sampler's own rule applies to itself:
    // sampling luck must not be able to fail a correct product, and a rate that
    // depends on the run's shape is luck.
    //
    // The cost is one `ps -A` per interval rather than one in three. That is the
    // price of the check meaning what it says; `inspectClone`'s git spawns are
    // the expensive half and they are still skipped for clones already proven.
    while (running) {
      sampleOnce(options.runRoot, flight, options.payloadMarker, true, options.operatorHead);
      await Bun.sleep(options.intervalMs ?? 40);
    }
  })();

  // Read from the first instant and INCREMENTALLY, and stop waiting once the
  // process is dead. Identical to `exec`'s bound and for the identical reason:
  // `killTree` reclaims the process GROUP, an escaped descendant is outside it
  // by construction, and it inherits the write end of these pipes — so the
  // stream never ends and an unbounded read never returns. Here it was worse
  // than in `exec`: `running` stays true while that read is pending, so the
  // sampler kept forking `ps` over the whole machine forever behind the hang.
  const out = drain(proc.stdout);
  const err = drain(proc.stderr);

  let timedOut = false;
  let killedNow: () => void = () => {};
  const killed = new Promise<void>((resolve) => {
    killedNow = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc);
    killedNow();
  }, options.timeoutMs ?? HARNESS_RUN_TIMEOUT_MS);

  const finished = Promise.all([out.done, err.done, proc.exited]).then(() => true);
  const abandon = abandonAfter(Promise.race([proc.exited.then(() => undefined), killed]), STREAM_DRAIN_GRACE_MS);
  const closed = await Promise.race([finished, abandon.done]);
  clearTimeout(timer);
  abandon.cancel();
  if (!closed) {
    killTree(proc);
    const last = abandonAfter(Promise.resolve(), STREAM_DRAIN_GRACE_MS);
    await Promise.race([proc.exited, last.done]);
    last.cancel();
  }
  running = false;
  await sampler;
  // One last look, so a run that finished between samples is still counted.
  sampleOnce(options.runRoot, flight, options.payloadMarker, true, options.operatorHead);

  const truncated: string[] = [];
  if (!out.settled()) truncated.push("stdout");
  if (!err.settled()) truncated.push("stderr");
  const why = timedOut ? "its timeout reclaimed the process group" : "the process exited";

  return {
    stdout: out.text() + truncationNote("stdout", out, why),
    stderr: err.text() + truncationNote("stderr", err, why),
    code: timedOut ? null : proc.exitCode,
    // The constant, not the literal. This file already takes its timeout BOUND
    // from `proc.ts` for the reason stated there — two copies of a rule drift —
    // and the sentinel a caller matches on is the same kind of shared fact.
    signal: timedOut ? TIMEOUT_SIGNAL : proc.signalCode,
    ms: Math.round((performance.now() - started) * 100) / 100,
    flight,
    truncated,
  };
}

/**
 * Is a process with this pid still alive? Decisive, and not a timing guess.
 *
 * A ZOMBIE IS NOT ALIVE, AND `kill(pid, 0)` CANNOT TELL YOU THAT. A process that
 * has exited but whose parent has not reaped it keeps its pid in the table and
 * answers signal 0 exactly like a running one. Until 2026-08-20 this function
 * answered `true` for such a process, forever.
 *
 * MEASURED against `bun 1.3.14` on 2026-08-20, `bar/lib/orphan.test.ts` driven
 * on Linux under Docker with the real `bar/fakes/vendor.ts`:
 *
 *   pid 1 does NOT reap (bare container)    the vendor writes "parent … is gone",
 *                                           calls process.exit(0), and this
 *                                           function still reports it alive for
 *                                           the full 20 s bound — test FAILS
 *   pid 1 DOES reap (`docker run --init`)   same vendor, same guard, test PASSES
 *                                           in 1,040 ms
 *
 * The fixture's orphan guard was never the defect; the predicate watching it
 * was. So the process table is consulted whenever signal 0 says the pid exists,
 * and a state of `Z` is reported as gone.
 *
 * On Linux that reading is a file read rather than a spawn, because this is
 * polled — `/proc/<pid>/stat` puts the state in the field after the last `)`,
 * which is parsed from the right precisely because a command name may itself
 * contain a parenthesis.
 *
 * On Windows there are no zombies and no `ps`, so signal 0 remains the whole
 * answer there.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;

  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state = stat.slice(close + 1).trim().charAt(0);
      // An unreadable or unparseable stat line is NOT evidence of death: fall
      // through to signal 0's answer rather than inventing one.
      return state === "" ? true : state !== "Z";
    } catch {
      return false;
    }
  }

  const ps = Bun.spawnSync(["ps", "-o", "state=", "-p", String(pid)]);
  const state = ps.stdout.toString().trim();
  // `ps` produced no row: the pid is not in the table, whatever signal 0 said a
  // moment ago. `ps` failed to run at all: keep signal 0's answer.
  if (ps.exitCode !== 0 && state === "") return false;
  if (state === "") return true;
  return !state.startsWith("Z");
}
