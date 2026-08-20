// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 71's detection cache — where it lives, what invalidates it, and how a
 * stale one is repaired.
 *
 * The ruling settles the shape and leaves three things open, and this module is
 * where they are answered:
 *
 *   > **no `init` command; detection is lazy on first run and cached as state**
 *   > (decision 18: regenerable, never hand-edited)
 *
 *   > *What is written and where:* under ruling 61's root, three files with
 *   > three lifetimes … **state** (detection cache and run records; regenerable,
 *   > never hand-edited, safe to delete)
 *
 *   > **Deleting state must be a supported repair**, because a cached detection
 *   > is the thing most likely to be wrong after an agent upgrade, which ruling
 *   > 69 makes a routine event.
 *
 * ───────────────────────────── WHERE IT LIVES ─────────────────────────────
 *
 * `<run-root>/detect.json` — a sibling of `r/`, under ruling 61's root, which
 * defaults to `~/.brigadier` and to `%LOCALAPPDATA%\brigadier` on Windows.
 * `src/repo/layout.ts` already refused XDG for this region with a measured
 * reason, and a second location would mean two answers to "where does brigadier
 * keep things".
 *
 * NOT under `r/<run-id>/`. Everything there is scoped to one run and is swept
 * by `src/run/reclaim.ts`; a fact about the machine that a run's cleanup
 * deletes is a fact nothing can cache.
 *
 * ITS OWN FILE, and that is the part ruling 71 does not say. Ruling 71 calls
 * the whole state region safe to delete, and ruling 63 puts an interrupted
 * item's committed clone under the same root — *"not merged and not deleted"*,
 * because finding 92 is a supervisor killed with two workers' real work
 * unrecoverable. So `rm -rf ~/.brigadier` is not a repair anybody should be
 * told to run: it is also the delete that destroys someone's only copy. Giving
 * the cache its own file means the repair for a wrong detection is
 * `rm ~/.brigadier/detect.json`, which touches nothing else — and the broad
 * delete still works, because the file is under the root either way.
 *
 * ────────────────────────── WHAT INVALIDATES IT ──────────────────────────
 *
 * A fingerprint, per agent, and NO CLOCK. Three reasons, and none of them is
 * taste:
 *
 *   The record has no TTL in it. Nothing in 72 rulings, 21 measurement
 *   amendments and 10 owner decisions keys any cache on time. A number invented
 *   here would enter this project as one unsourced sentence, which is exactly
 *   how item 10's two struck start-up clauses entered it.
 *
 *   The record warns against the shape by name. #46's own trap line:
 *   *"`resetsAt` drifts with wall clock — never key a cache on it."*
 *
 *   There is a rule that decides it instead, and it is ruling 63's:
 *   *"a state file records intent and the world records fact, and where the
 *   world can be consulted directly the world wins."* So the question is not
 *   *how old is too old* but *who is allowed to trust this*, which is answered
 *   below.
 *
 * The fingerprint is four facts, all cheap enough to take on every invocation:
 *
 *   `artifact`  which brigadier wrote it — the compile-time stamp plus the
 *               running executable's own size and mtime. An upgrade, or a
 *               rebuild of a dirty tree, empties the cache mechanically rather
 *               than by anyone remembering to bump a version constant. A
 *               discipline nobody enforces is a request (ruling 68).
 *   `profile`   a hash of the WHOLE launch profile as it will be spawned,
 *               override applied. Ruling 69: an overridden bridge "invalidates
 *               every measured fact" in the profile, so changing `bridges.json`
 *               must not leave a result measured against the old coordinate.
 *               The whole object rather than a chosen subset, because a chosen
 *               subset goes stale the day a field is added and nobody notices.
 *   `resolved`  where `Bun.which` finds the command now. Ruling 46: detection
 *               reports the resolved `PATH` entry rather than assuming it is
 *               ours, and an agent that moved on `PATH` is a different agent.
 *   `entry`     that entry's size and mtime. A vendor that upgraded in place is
 *               re-probed without anyone being asked to notice.
 *
 * Plus one field that is not a fingerprint: `probedWorkerShaped` must be true.
 * A `usable` produced under the operator's own config root is not a statement
 * about what a worker can do — that is the whole of finding V1 — so a result
 * from a probe that answered the nearby question is never served from here.
 *
 * THE HOLE, NAMED RATHER THAN LEFT TO BE FOUND: two of six profiles are
 * bridged and resolve to `npx`, whose bytes do not move when
 * `@agentclientprotocol/claude-agent-acp` or `…/codex-acp` publishes a new
 * version. For Claude and Codex the fingerprint therefore cannot see the
 * upgrade ruling 69 calls routine. Nothing on disk changes; only a probe finds
 * out. That is not a defect of the fingerprint, it is the reason the next
 * section exists.
 *
 * ────────────────────────── WHO IS ALLOWED TO TRUST IT ──────────────────────
 *
 * Ruling 63's rule, applied:
 *
 *   `run` — about to clone, spawn and spend — PROBES. It can consult the world,
 *   so it consults the world. Finding V1 is `run` admitting on evidence that was
 *   not the evidence, and a cache would be V1 again with a time axis. Ruling
 *   69's blocking drift gate, which stops write work, is therefore never decided
 *   from a cached version string — which matters most for exactly the two
 *   bridged agents whose upgrades the fingerprint cannot see.
 *
 *   `plan`, `run --dry-run`, `run --estimate` — which spend nothing and create
 *   nothing — SERVE FROM THE CACHE, and say so, with the age of what they
 *   served. This is the cost ruling 71 objected to: those two commands were
 *   sub-second before 2026-08-20 and a detection sweep in front of them is a
 *   silent wait with nothing to show for it. On a warm cache they now spawn no
 *   vendor at all, which restores the property `src/queue/admit.ts` claims for
 *   itself — nothing at admission starts a process.
 *
 *   `detect` — the command whose entire job is this question — PROBES, always,
 *   and rewrites what it found. That makes the repair a command the operator
 *   already has rather than a file path they have to be taught.
 *
 * AND WHO WRITES IT is a different question with a different answer, which is
 * why `sweep` takes two parameters rather than one. Ruling 71 says detection is
 * cached on FIRST RUN, and ruling 53's ordering promise is checkable precisely
 * because a refused or dry run can be verified from the outside by listing the
 * run root and finding it unchanged. A `--dry-run` that wrote a file into the
 * run root would break that — `test/cli-run.test.ts` asserts an untouched run
 * root in three places, one of them after a `--dry-run` — so the commands that
 * create nothing create nothing here either. `run` and `detect` write.
 *
 * The cost of that, stated: on a machine where nobody ever gets past `plan`,
 * nothing ever warms the cache and every `plan` pays the sweep. A cold `plan`
 * therefore prints the one command that would warm it, rather than leaving an
 * operator to find out that the fast path exists.
 *
 * WHAT THAT COSTS, stated rather than discovered: `plan` can promise a run that
 * `run` then refuses, because the cached answer was older than the vendor's
 * credential. The divergence is in the safe direction — the prediction was
 * stale, the run is truthful, and the run prints the vendor's own remedy — but
 * it is a divergence, and an operator will meet it. The printed age and the
 * named repair are the whole mitigation.
 *
 * AND ONE MORE, because ruling 71's accepted costs say *"a first run pays a full
 * detection sweep"* in a way that reads as though later runs do not: under this
 * split every `run` pays it, not only the first. That is a narrower reading of
 * ruling 71 than its own sentence implies, taken deliberately on ruling 63's
 * authority, and it is flagged for the owner in `DETECTION-CACHE.md` rather than
 * absorbed. Widening it later is a one-line change here; narrowing it after a
 * stale cache has admitted a run is not.
 *
 * ───────────────────────────── THE FILE ITSELF ─────────────────────────────
 *
 * One JSON document, written to a temporary name and `rename`d over the real
 * one. Ruling 70 makes the RUN RECORD newline-delimited JSON because finding 92
 * is a process dying without warning and a truncated single document is
 * unparseable in its entirety. That reasoning does not reach here and the
 * difference is worth stating: a run record is the only evidence that work
 * happened, while this file is regenerable by construction, so the failure a
 * torn write would cause costs one detection sweep. `rename` is atomic, so a
 * reader never sees a partial file at all.
 *
 * `~/.brigadier` is SHARED (amendment §15) and there is still no cross-process
 * lock. Two concurrent writers means last-rename-wins, and the loser's entries
 * are simply re-probed next time. Both wrote results measured seconds apart;
 * neither can be wrong in a way the other was right about.
 *
 * A file that cannot be read is regenerated in silence-plus-a-line. It is
 * never described as damage: ruling 71 makes deleting this file a supported
 * repair, and a product that calls its own supported repair a corruption has
 * taught the operator not to perform it.
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { embeddedStamp, serialiseStamp } from "../build/identity.ts";
import type { Detection } from "./detect.ts";
import { applyOverride, type BridgeOverride } from "./drift.ts";
import { PROFILES, type AgentId, type LaunchProfile } from "./profiles.ts";

/** Sibling of `r/`, under ruling 61's root. Short, for the same budget reason. */
export const DETECT_CACHE_FILE = "detect.json";

/**
 * Bumped by hand ONLY when the meaning of a stored field changes in a way the
 * `artifact` fingerprint would not already catch — which, since `artifact`
 * carries the running executable's own bytes, is never in practice. It exists
 * so that a file from a future format is refused rather than misread.
 */
export const CACHE_FORMAT = 1;

export function detectCachePath(runRoot: string): string {
  return join(runRoot, DETECT_CACHE_FILE);
}

/** The three per-agent facts that must still hold for a stored result to count. */
export interface Fingerprint {
  profile: string;
  resolved: string | null;
  entry: string | null;
}

export interface CachedEntry extends Fingerprint {
  detection: Detection;
  probedAtMs: number;
}

export interface DetectCacheFile {
  format: number;
  /** Which brigadier wrote this. See `artifactFingerprint`. */
  artifact: string;
  agents: Record<string, CachedEntry>;
}

/**
 * Why a stored result was not used. Rendered to the operator on request and
 * asserted on in tests, so each one names a fact rather than a feeling.
 */
export type StaleReason =
  | "no cache file"
  | "the cache format is not this one"
  | "the cache was written by a different brigadier"
  | "no entry for this agent"
  | "the launch profile changed"
  | "the command resolves somewhere else now"
  | "the resolved entry's bytes changed"
  | "it was not probed under a worker-shaped config root";

export interface CacheRead {
  served: Detection[];
  /** Ages of the served entries, by id, in milliseconds. */
  ageMs: Map<AgentId, number>;
  stale: { id: AgentId; why: StaleReason }[];
  /**
   * Every stored entry that must survive the next write: the ones this
   * invocation did not ask about, and the ones it asked about and found valid.
   *
   * Without the first, `brigadier detect claude` would delete the five agents it
   * never probed. Without the second, a run that served four agents from the
   * cache and probed two would write back only the two.
   */
  carried: Map<AgentId, CachedEntry>;
}

/**
 * Which brigadier wrote a cache file.
 *
 * The compile-time stamp names the build; the running executable's own size and
 * mtime name the FILE, which is what makes this mechanical rather than a
 * convention. A dirty tree rebuilt twice carries one stamp and two mtimes, so a
 * developer changing detection's logic does not get yesterday's answers — and
 * an operator upgrading brigadier pays exactly one sweep.
 *
 * Never the sha256: `src/build/identity.ts` is explicit that hashing tens of
 * megabytes costs far more than this binary's entire start-up, and this runs on
 * every invocation.
 */
export function artifactFingerprint(execPath: string = process.execPath): string {
  const { stamp } = embeddedStamp();
  return `${stamp === null ? "unstamped" : serialiseStamp(stamp)} exec=${bytesOf(execPath)}`;
}

/**
 * `<size>:<mtime>`, or a constant when the path cannot be stat'd at all.
 *
 * Never throws. `throwIfNoEntry: false` covers a missing file and nothing else —
 * a permission error still throws — and a detection sweep must not be the thing
 * that ends a run because a directory above an agent became unreadable.
 */
function bytesOf(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat === undefined ? "unstattable" : `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "unstattable";
  }
}

/**
 * A hash of the whole profile, key order normalised.
 *
 * The whole object and not a chosen subset. A subset is a second list of what
 * matters about a launch profile, and `src/agent/profiles.ts` already calls
 * itself a standing hazard; the day a field is added, the subset is wrong and
 * silent. The cost of hashing everything is a prose edit to a `caveats` string
 * invalidating the cache — which costs one sweep, on a build that changed the
 * `artifact` fingerprint anyway.
 */
export function profileFingerprint(profile: LaunchProfile): string {
  return createHash("sha256").update(stableJson(profile)).digest("hex").slice(0, 32);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** The resolved entry's bytes, or `null` when nothing resolved. */
export function entryFingerprint(resolved: string | null): string | null {
  return resolved === null ? null : bytesOf(resolved);
}

/**
 * What the machine looks like right now, for the agents asked about.
 *
 * `which` is a parameter for the same reason `agentsOnPath` takes one: a test
 * that cannot move an agent on `PATH` cannot demonstrate that moving it
 * invalidates the entry, and a guard with no demonstrated negative looks
 * identical to a working one (ruling 62 (b)).
 */
export function fingerprintsNow(
  ids: readonly AgentId[],
  overrides: readonly BridgeOverride[] = [],
  which: (command: string) => string | null = (command) => Bun.which(command),
): Map<AgentId, Fingerprint> {
  const now = new Map<AgentId, Fingerprint>();
  for (const id of ids) {
    const profile = applyOverride(PROFILES[id], overrides);
    const resolved = which(profile.command);
    now.set(id, {
      profile: profileFingerprint(profile),
      resolved,
      entry: entryFingerprint(resolved),
    });
  }
  return now;
}

/**
 * Read a cache file. A missing or unreadable file is a result, never an error:
 * this file is regenerable by construction.
 *
 * `problem` is set only when a file EXISTED and could not be used, because an
 * operator who has one believes it is in force — the same distinction
 * `loadOverrides` draws, for the same reason.
 */
export function readDetectCache(path: string): { file: DetectCacheFile | null; problem?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { file: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file: null, problem: `${path} could not be read (${String(error)}) and was regenerated` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { file: null, problem: `${path} is not a cache file and was regenerated` };
  }
  const file = parsed as Partial<DetectCacheFile>;
  if (typeof file.artifact !== "string" || typeof file.agents !== "object" || file.agents === null) {
    return { file: null, problem: `${path} is missing its fingerprint and was regenerated` };
  }
  return { file: { format: Number(file.format), artifact: file.artifact, agents: file.agents } };
}

/**
 * Which of `ids` the cache can answer, and why it cannot answer the rest.
 *
 * PURE. It takes the file, the current fingerprints and the clock as arguments
 * and touches nothing, so every invalidation axis has a test that changes one
 * fact and asserts the reason.
 */
export function planFromCache(
  ids: readonly AgentId[],
  file: DetectCacheFile | null,
  now: ReadonlyMap<AgentId, Fingerprint>,
  artifact: string,
  nowMs: number,
): CacheRead {
  const served: Detection[] = [];
  const ageMs = new Map<AgentId, number>();
  const stale: { id: AgentId; why: StaleReason }[] = [];
  const carried = new Map<AgentId, CachedEntry>();

  const wholeFile: StaleReason | null =
    file === null
      ? "no cache file"
      : file.format !== CACHE_FORMAT
        ? "the cache format is not this one"
        : file.artifact !== artifact
          ? "the cache was written by a different brigadier"
          : null;

  if (wholeFile !== null) {
    for (const id of ids) stale.push({ id, why: wholeFile });
    return { served, ageMs, stale, carried };
  }

  const asked = new Set(ids);
  for (const [id, entry] of Object.entries(file!.agents)) {
    if (asked.has(id as AgentId)) continue;
    // Not asked about, so not judged. `brigadier detect claude` must not wipe
    // the five agents it did not probe.
    carried.set(id as AgentId, entry);
  }

  for (const id of ids) {
    const entry = file!.agents[id];
    const current = now.get(id);
    if (entry === undefined || current === undefined) {
      stale.push({ id, why: "no entry for this agent" });
      continue;
    }
    const why = reasonStale(entry, current);
    if (why !== null) {
      stale.push({ id, why });
      continue;
    }
    served.push(entry.detection);
    carried.set(id, entry);
    ageMs.set(id, Math.max(0, nowMs - entry.probedAtMs));
  }

  return { served, ageMs, stale, carried };
}

function reasonStale(entry: CachedEntry, current: Fingerprint): StaleReason | null {
  if (entry.profile !== current.profile) return "the launch profile changed";
  if (entry.resolved !== current.resolved) return "the command resolves somewhere else now";
  if (entry.entry !== current.entry) return "the resolved entry's bytes changed";
  // Finding V1, as a gate rather than a recorded field. `probedWorkerShaped`
  // was written in three places and read in none; this is the read.
  if (entry.detection.probedWorkerShaped !== true) {
    return "it was not probed under a worker-shaped config root";
  }
  return null;
}

/**
 * Whoever is allowed to put bytes on disk. `Sink.write`'s exact contract:
 * compose first, redact the final bytes, then write.
 *
 * INJECTED RATHER THAN IMPORTED, and that is ruling 65's rule rather than a
 * testing convenience. `src/secrets/audit.ts` ratchets every write primitive
 * outside `src/secrets/sink.ts` against a baseline that may only shrink, and a
 * new `writeFileSync` here would have been new debt on the list that exists to
 * retire it. `test/secrets-audit.test.ts` caught exactly that on 2026-08-20.
 *
 * A detection result carries the VENDOR's own error text, which brigadier did
 * not compose and has not read. Putting it through the sink is not ceremony:
 * that is a stream out of brigadier, and ruling 65 has one sink for all of them.
 */
export interface CacheWriter {
  write(path: string, contents: string): void;
}

/**
 * Write the results of a fresh probe, keeping entries this invocation did not
 * ask about.
 *
 * ATOMIC: the sink writes a temporary name and this renames it over the real
 * one, so a reader never sees a partial file and a torn write leaves the last
 * good answer in place. `rename` is not a write primitive, which is why the
 * atomicity survives the injection above.
 *
 * Never throws. A run must not fail because a cache could not be written — the
 * cache is an optimisation and the sweep it replaces still ran. The caller gets
 * the problem back and says so once.
 */
export function writeDetectCache(
  writer: CacheWriter,
  path: string,
  probed: readonly Detection[],
  now: ReadonlyMap<AgentId, Fingerprint>,
  artifact: string,
  nowMs: number,
  carried: ReadonlyMap<AgentId, CachedEntry> = new Map(),
): { problem?: string } {
  const agents: Record<string, CachedEntry> = {};
  for (const [id, entry] of carried) agents[id] = entry;
  for (const detection of probed) {
    const fingerprint = now.get(detection.id);
    // A result whose fingerprint was never taken cannot be validated later, so
    // it is not stored. Storing it would mean storing something that can only
    // ever read as stale.
    if (fingerprint === undefined) continue;
    agents[detection.id] = { ...fingerprint, detection, probedAtMs: nowMs };
  }
  const file: DetectCacheFile = { format: CACHE_FORMAT, artifact, agents };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writer.write(temporary, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temporary, path);
    return {};
  } catch (error) {
    return { problem: `detection was not cached: ${String(error)}` };
  }
}

/**
 * `12s`, `4m`, `3h`, `2d` — the age of a served result.
 *
 * Printed rather than compared. Nothing in this module decides anything from an
 * age; the operator does, which is the difference between a number that informs
 * and a threshold nobody sourced.
 */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The one line an admission that used the cache prints.
 *
 * It says four things, and each is here because leaving it out makes the line a
 * lie by omission: how many answers are CACHED rather than freshly probed, HOW
 * OLD the oldest of them is, how many vendors were spawned anyway, and what the
 * repair is. `BAR.md`'s standing rule is that a weakened check must never
 * render as a pass; a cached detection is a weaker answer than a probe and must
 * not render as one.
 *
 * Returns `null` when nothing was served, because a run that probed everything
 * has nothing to disclose and a line saying "0 from cache" is noise on every
 * first invocation.
 */
export function describeCacheUse(
  served: readonly Detection[],
  ageMs: ReadonlyMap<AgentId, number>,
  probed: number,
  path: string,
): string | null {
  if (served.length === 0) return null;
  const oldest = Math.max(0, ...served.map((d) => ageMs.get(d.id) ?? 0));
  const alsoProbed = probed === 0
    ? "no vendor was spawned"
    : `${probed} whose fingerprint had changed ${probed === 1 ? "was" : "were"} re-probed`;
  return (
    `detection: ${served.length} agent(s) from cache, oldest measured ${formatAge(oldest)} ago — ` +
    `${alsoProbed} (ruling 71).\n  \`brigadier run\` re-probes before it spends. To re-probe now: ` +
    `\`brigadier detect\`, or delete ${path}.`
  );
}
