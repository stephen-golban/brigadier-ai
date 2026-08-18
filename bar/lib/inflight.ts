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

/**
 * Ruling 38's marker, as `src/agent/marker.ts` spells it.
 *
 * Written out rather than imported: `bar/` imports nothing from `src/`, because
 * a harness built from the product's own constants cannot notice the product
 * changing one. If this string and the product's ever diverge, that divergence
 * is a finding.
 */
export const RUN_MARKER_FLAG = "--brigadier-run";

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
  /** The scratch base commit is what a clone is supposed to start from. */
  hasBaseRef: boolean;
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

function listProcesses(): string[] {
  const proc =
    process.platform === "win32"
      ? Bun.spawnSync([
          "powershell",
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
        ])
      : Bun.spawnSync(["ps", "-A", "-o", "args="]);
  if (proc.exitCode !== 0) return [];
  return new TextDecoder().decode(proc.stdout).split("\n");
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

function inspectClone(path: string, payloadMarker?: string): CloneSample {
  const gitDir = join(path, ".git");
  const payloadsSeen = scanPayloads(path, payloadMarker);
  if (!existsSync(gitDir)) return { path, isGitRepo: false, originRemoved: false, hasBaseRef: false, payloadsSeen };
  const git = (args: string[]): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync(["git", `--git-dir=${gitDir}`, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout).trim() };
  };
  const remotes = git(["remote"]);
  const base = git(["rev-parse", "--verify", "--quiet", "refs/heads/bar-base"]);
  return {
    path,
    isGitRepo: git(["rev-parse", "--git-dir"]).ok,
    originRemoved: remotes.ok && !remotes.out.split("\n").includes("origin"),
    hasBaseRef: base.ok && base.out.length === 40,
    payloadsSeen,
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
      : inspectClone(path, payloadMarker);
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
        }
      : sample;
    flight.clonesSeen.set(path, merged);
  }

  if (!processes) return;
  const marked = listProcesses().filter((line) => line.includes(RUN_MARKER_FLAG));
  if (marked.length > flight.peakMarkedProcesses) flight.peakMarkedProcesses = marked.length;
  for (const line of marked) {
    const trimmed = line.trim().slice(0, 160);
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
  });

  let running = true;
  const sampler = (async () => {
    // The clone half runs at `intervalMs`; the `ps` half every third turn, so
    // the process table is still read about as often as it used to be while the
    // clones are read three times as often. What forced the split: a clone that
    // was created late in a run and observed EXACTLY ONCE, during its setup,
    // reported `origin-removed=false` for a product that removed the remote a
    // moment later — the sampler's luck rendered as the product's behaviour, and
    // the same single-observation window hid the payload files a worker planted
    // afterwards. Sampling luck must not be able to fail a correct product; a
    // rate that observes every clone several times is what stops it.
    let turn = 0;
    while (running) {
      sampleOnce(options.runRoot, flight, options.payloadMarker, turn % 3 === 0);
      turn += 1;
      await Bun.sleep(options.intervalMs ?? 40);
    }
  })();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? 300_000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);
  running = false;
  await sampler;
  // One last look, so a run that finished between samples is still counted.
  sampleOnce(options.runRoot, flight, options.payloadMarker);

  return {
    stdout,
    stderr,
    code: timedOut ? null : proc.exitCode,
    signal: timedOut ? "BAR_TIMEOUT" : proc.signalCode,
    ms: Math.round((performance.now() - started) * 100) / 100,
    flight,
  };
}

/** Is a process with this pid still alive? Decisive, and not a timing guess. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
