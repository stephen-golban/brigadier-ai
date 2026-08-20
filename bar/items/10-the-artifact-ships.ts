// SPDX-License-Identifier: Apache-2.0
/**
 * Item 10 — The artifact ships, and says what is in it.
 *
 * Rulings 26, 42, 12, 4, 44, 47, 5, 46, 60, 72.
 *
 * This is the item that can be driven hardest today, because most of it is a
 * statement about a file rather than about a run: the licence surface, the
 * marker scan, the size, and whether the thing starts with node absent from
 * `PATH`. All of those are asserted against the artifact's own bytes, which is
 * the point of ruling 47's gate — the module graph is a statement of intent and
 * the binary is what ships.
 *
 * **TWO clauses of this item are STRUCK, and both are struck in the open.** The
 * `≤70 ms cold-start` budget was withdrawn by the owner on 2026-08-19: it was
 * never measured, and it is unreachable at this artifact shape. The `≤10 ms
 * warm-start` budget was withdrawn on 2026-08-20 on the same grounds — it was
 * never measured on this product either. Nothing replaces either of them, no
 * budget has been adjusted to fit a measurement, and the item does not go
 * `SKIPPED` — `BAR.md`'s closing rule makes a `SKIPPED` item block a tag exactly
 * as a `FAIL` does, so both withdrawals are PRINTED as lines in this item's own
 * output and the verdict turns on the halves that remain. `STRUCK_COLD_START`
 * and `STRUCK_WARM_START` below carry the reasons and the numbers, and
 * `judgeArtifact` prints both on every run, pass or fail.
 *
 * **The warm strike withdrew the CLAUSE and not the MEASUREMENT.** The binary is
 * still timed, and the figure is still printed with its full method, its floor
 * correction, its distribution and its provenance — a number that stops being
 * printed is a number nobody will ever revisit. What is gone is the comparison:
 * no threshold is applied to it and no margin is stated beside it. That the
 * measurement was actually TAKEN is itself asserted, so "we no longer gate on
 * the value" cannot quietly become "we no longer time the binary".
 *
 * The instrument matters more than the assertion here, and three of the checks
 * below were rebuilt because the old ones could not fail:
 *
 *   **The hook surface is read from the host, not from brigadier.** `brigadier
 *   plugin hooks` prints a compiled-in string, so it names `PreCompact` whether
 *   or not `install` ever wrote a hook file. `BAR.md` names the real instrument
 *   — `claude plugin details brigadier`, after install — and this item drives it
 *   where `claude` exists, plus the installed `hooks.json` on disk, which is
 *   evidence no self-report can supply.
 *
 *   **Removal is checked, not assumed.** "Installs, runs and is removed cleanly"
 *   is three claims; the third was never driven. The scratch home is listed
 *   before install and after `uninstall`, and the two listings must be equal.
 *
 *   **"node is absent" is asked of the OS.** Stripping `PATH` with the same
 *   predicate that then checks the strip worked proves nothing, so a shell is
 *   asked to resolve `node` on the stripped `PATH` and must fail to find it.
 *
 * Two things this item deliberately does not claim. ChatGPT is a PERMANENT
 * BLANK — a hosted surface has no filesystem — so nothing here should be read as
 * six uniform clients, and the artifact is required to say so itself. And ruling
 * 72 leaves "the documented rebuild path actually reproduces the binary" as a
 * bar item still to be written; §6 requires it and this item does not prove it.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { probeFeature } from "../lib/feature.ts";
import { ensureDir, listTree } from "../lib/fs.ts";
import { combine } from "../lib/halves.ts";
import { baseEnv, exec, pathWithout, spawnFloorMs } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

/**
 * The budget, and the statistic it is a budget on.
 *
 * `MEASUREMENT-SESSION.md` records v1's shipped binary at 63 MB and 10 ms warm.
 * "No worse than the product we are replacing" is a defensible bar and a round
 * number is not — but a budget without a statistic is not a check, it is a coin
 * toss, and three independent measurements of this same artifact disagreed by
 * 60% purely because they used different ones.
 *
 * **Which MB.** This repository's own tooling settles it: `scripts/license-gate.ts`
 * prints `bytes / 1_048_576` and labels it "MB", and `NEXT-SESSION.md` records
 * the current binary as "60.5 MB" — which is 63,479,138 bytes read as MEBIbytes.
 * So 63 MB here means 63 MiB, and the budget is stated in BYTES below so no
 * reader has to infer it. The two readings genuinely disagree about the verdict
 * — 63.48 MB decimal is over a 63 MB decimal budget while 60.54 MiB is under a
 * 63 MiB one — which is exactly why it is written out rather than left implicit.
 *
 * **Which start-up number.** The MINIMUM of a large N, floor-corrected. Three
 * reasons, in the order they matter:
 *
 *   A start-up budget is a claim about the process's intrinsic cost, and
 *   scheduler noise only ever ADDS. The minimum is therefore the least biased
 *   estimator of the thing being budgeted; a median bakes in whatever else the
 *   machine was doing, which differs across the three platforms `BAR.md`
 *   mandates.
 *
 *   MEASURED on 2026-08-17 (darwin 25.5.0 arm64, bun 1.3.14, Python 3.9.6
 *   `subprocess.run`), the minimum is STABLE and small N is not. For a
 *   `bun --compile` binary whose whole program is `process.exit(0)`: min-of-5
 *   **10.01 ms** with a max of **759 ms**, min-of-40 **7.76 ms**, min-of-150
 *   **7.45 ms**. For `dist/brigadier --help`: min-of-5 **12.10 ms**, min-of-40
 *   **12.13 ms**, min-of-150 **12.07 ms**. Forty samples is where the estimate
 *   stops moving, and the first draft's best-of-5 was reading noise.
 *
 *   **Those `dist/brigadier` figures are evidence about N, not about today's
 *   artifact.** They were taken on 2026-08-17 against an EARLIER state of the
 *   binary, and reading them as this artifact's warm cost is a mistake that has
 *   already been made once: a critic used the 12.13/12.07 pair to put the
 *   current warm start near 10.9 ms and to call a contended 14.64 ms reading
 *   inflated. The quiet-machine measurement in `QUIET_WARM_MEASUREMENT` below is
 *   **13.99 ms**. What the 2026-08-17 pair still supports is the choice of
 *   N=40 — the estimate stops moving there — and nothing about the artifact.
 *
 *   That measurement also answers a live objection. A verifier reported that
 *   this check "can only be satisfied by something the product is not allowed to
 *   be", since ruling 5 mandates a `bun --compile` artifact. At best-of-5 that is
 *   true. At min-of-40 the runtime floor is 7.76 ms raw and ~6.5 ms
 *   floor-corrected, against a 10 ms budget — so the budget is satisfiable with
 *   about 3.5 ms of headroom, and the artifact misses it for a real reason
 *   rather than a definitional one.
 *
 * There is deliberately no `COLD_START_BUDGET_MS`. See `STRUCK_COLD_START`.
 *
 * **And since 2026-08-20 there is deliberately no `WARM_START_BUDGET_MS`
 * either.** See `STRUCK_WARM_START`. Everything above about WHICH statistic —
 * the minimum, floor-corrected, at N=40 — still governs, because the item still
 * measures and reports the figure; it simply no longer compares it with
 * anything. The paragraph above arguing that 10 ms was reachable with ~3.5 ms of
 * headroom is left standing on purpose: it was the evidence the clause was
 * argued over, and a strike must not take the evidence about it out of the
 * record.
 */
export const SIZE_BUDGET_BYTES = 63 * 1_048_576;
/**
 * The number that WAS the warm budget, kept only so the strike can name what it
 * struck and so the margins already in the record stay re-derivable.
 *
 * IT GATES NOTHING, and it is deliberately not called a budget. `judgeArtifact`
 * never compares a measured figure with it; `bar/item10-identity.test.ts` drives
 * a figure far outside it and requires the item to pass. Amendment §17's proposed
 * 20 ms was NOT adopted in its place either — nothing was.
 */
export const WITHDRAWN_WARM_BUDGET_MS = 10;
/** Where the minimum stopped moving. See the measurement above. */
export const START_SAMPLES = 40;

/**
 * The warm start of THIS artifact, taken under the conditions the method asks for.
 *
 * MEASURED 2026-08-19 on darwin 25.5.0, load average 0.76–0.87, no other agents
 * running and nothing else spawning. It is the reference figure because a warm
 * number taken on a busy machine is not this artifact's warm cost — and because
 * the two readings that bracket it were each misused once.
 *
 * **Why the minimum is trustworthy here and not merely conservative.** The
 * distribution is tight: raw p10 15.40 ms, median 15.67 ms, max 16.88 ms against
 * a raw minimum of 15.27 ms — a spread of 1.6 ms across forty samples. That is
 * what a quiet machine looks like, and it means the minimum is estimating the
 * process's intrinsic cost rather than winning a lottery against a long tail.
 *
 * **What contention actually costs, measured rather than guessed.** The same
 * check on a machine running five other agents read 15.43 ms raw / 14.64 ms
 * corrected — **0.65 ms** above this figure, not the several milliseconds it was
 * assumed to be. Note also that the spawn floor itself moved, 0.79 ms contended
 * against 1.28 ms quiet, which is why the check prints the raw number and the
 * correction separately instead of only their difference.
 *
 * **The warm figure has now been recorded three times against three different
 * artifacts, and what changed between them is NOT established:** amendment §8's
 * **11.29 ms**, amendment §17's **16.13 ms**, and this **13.99 ms**. The
 * artifact was not held constant across those three points, and no record ties
 * a figure to a build. So the sequence is not a regression and it is not an
 * improvement — it is three measurements of three things. Anyone tempted to read
 * a trend has to establish what the artifact was at each point first.
 *
 * `marginOverBudgetMs` is kept as HISTORY and is no longer a verdict on
 * anything: it is how far this figure stood from the ≤10 ms clause on the day
 * that clause was still in force. The clause was withdrawn on 2026-08-20 and
 * nothing replaced it, so no margin is printed beside a measured figure any
 * more. The field survives because a strike must not erase the number it struck.
 */
export const QUIET_WARM_MEASUREMENT = {
  measuredOn: "2026-08-19, darwin 25.5.0, load average 0.76–0.87, nothing else running",
  spawnFloorMs: 1.28,
  rawMinMs: 15.27,
  correctedMs: 13.99,
  marginOverBudgetMs: 3.99,
  distribution: "raw p10 15.40 ms, median 15.67 ms, max 16.88 ms against a raw minimum of 15.27 ms",
  priorReadings: "amendment §8 11.29 ms, amendment §17 16.13 ms, this 13.99 ms",
} as const;

/**
 * The withdrawn clause, printed rather than deleted.
 *
 * `BAR.md`'s closing section is the rule this obeys: an item is struck **only in
 * the open** — never quietly disabled, never marked "known failing", and never
 * left `SKIPPED`, because a `SKIPPED` item blocks a tag exactly as a `FAIL`
 * does. A struck clause that left no trace in the output would be the silent
 * scaling-down that section forbids, so the strike is a row in this item's own
 * report, on a pass as well as on a failure, and it names what is now unproven.
 *
 * It is a WITHDRAWAL, not a relaxation. No number here was moved to fit a
 * measurement; the promise is gone and nothing takes its place.
 *
 * `unproven` IS THE WORD, and the 2026-08-19 phrasing census made it the only
 * one. It is not `bar/lib/checks.ts`'s `NOT-RUN —`: these checks RAN and passed,
 * and `unproven` names the edge they do not cover. A check that reached nothing
 * takes the prefix instead.
 */
export const STRUCK_COLD_START = {
  clause: "start-up within the measured budget — the ≤70 ms cold start",
  why:
    "the number was never measured. A full clone of v1 at Release 0.2.1 contains no \"70 ms\", no " +
    '"cold start" and no benchmark script; it enters the record as ONE unsourced sentence at ' +
    "MEASUREMENT-SESSION.md:140, commit 7e6a547, and every later citation — ruling 5's included — " +
    "repeats that line rather than re-deriving it",
  measured:
    "and it is unreachable at this artifact shape. MEASURED as minima of fresh, never-executed copies on " +
    "their FIRST-EVER invocation: a Bun binary whose entire program is `process.exit(0)` cold-starts at " +
    "873 ms, and `dist/brigadier` at 892 ms — brigadier's own code is 0.5% of the artifact and about 19 ms " +
    "of the total. The cost is XProtect's first-execution scan, fitting ~133 ms fixed + 11.3 ms/MB, and six " +
    "copies sharing one cdhash each paid in full: the scan is cached PER FILE, not per signature, so signing " +
    "cannot pre-empt it",
  unproven:
    "this item now asserts NOTHING about start-up on a first run, on any platform. The warm figure below is a " +
    "warm figure and must not be read as a first-run one. The real downloaded-release path is worse than any " +
    "number above: under quarantine the unnotarized 63 MB binary was MEASURED at 6,045 ms and then SIGKILLed — " +
    "blocked rather than slow, and notarization addresses the kill, not the latency",
} as const;

/** The one line a reader has to see. Used in the report, the log and `did`. */
export function struckLine(): string {
  return (
    `STRUCK — "${STRUCK_COLD_START.clause}" is WITHDRAWN by the owner and nothing replaces it. ` +
    `Why: ${STRUCK_COLD_START.why}; ${STRUCK_COLD_START.measured}. ` +
    "The clause is struck, not relaxed — no budget in this item has been adjusted to fit a measurement."
  );
}

/**
 * The SECOND withdrawn clause, printed rather than deleted.
 *
 * Owner's decision, 2026-08-20, under `BAR.md`'s *When an item cannot be met* —
 * the same procedure that struck the cold-start clause on 2026-08-19, on the
 * same grounds: the number was never measured on this product.
 *
 * It is a WITHDRAWAL, not a relaxation. No number was moved to fit a
 * measurement. In particular amendment §17's proposed 20 ms is NOT adopted: a
 * clause withdrawn because its figure has no provenance cannot be repaired by
 * installing a second figure chosen to clear the last reading, and 20 ms against
 * a measured 16.13 ms is exactly that shape. Nothing replaces it.
 *
 * WHAT IS NOT WITHDRAWN IS THE MEASUREMENT. `judgeArtifact` still times the
 * artifact, still prints the method, the floor correction, the distribution and
 * the provenance, and still ASSERTS that a figure was obtained. A number that
 * stops being printed is a number nobody will ever revisit.
 *
 * `unproven` names the promise that goes with a warm figure, and it is a
 * different promise from the cold one. Cold start is about the first run on a
 * machine that has never seen the binary; warm start is about whether brigadier
 * is cheap enough to invoke repeatedly inside a loop. Only the second is at
 * stake here.
 */
export const STRUCK_WARM_START = {
  clause: "start-up within the measured budget — the ≤10 ms warm start",
  why:
    "the number was never measured on this product. It enters this project as ONE unsourced sentence at " +
    'MEASUREMENT-SESSION.md:140, commit 7e6a547, under the heading "Already measured — do not redo" — the same ' +
    "sentence and the same commit that carried the struck 70 ms cold figure. It is v1's number, and v1's history " +
    "contains no benchmark that produces it",
  measured:
    "and what this artifact actually costs is known and recorded rather than inferred. MEASURED 2026-08-19 on " +
    "darwin 25.5.0 at load average 0.76–0.87 with nothing else running: raw min 15.27 ms − a 1.28 ms spawn floor " +
    "= 13.99 ms corrected, distribution raw p10 15.40 / median 15.67 / max 16.88 ms. A run MEASURED 2026-08-19 at " +
    "higher load read 15.01 ms corrected, and contention on this artifact was MEASURED at 0.65 ms, so the gap is " +
    "not noise. The figure has also been recorded against THREE DIFFERENT ARTIFACTS — 11.29 ms, 16.13 ms and " +
    "13.99 ms — and what changed between them was never established, so that sequence is neither a regression nor " +
    "an improvement",
  unproven:
    "this item now asserts NOTHING about how cheap brigadier is to invoke. The promise that goes unproven is that " +
    "brigadier is cheap enough to invoke REPEATEDLY IN A LOOP, which is what a warm figure is about — unproven on " +
    "every platform, not merely unmet. The measured figure is still taken and still printed, so a reader who needs " +
    "that promise has a number to argue with; what they no longer have is anyone's word that it is small enough",
} as const;

/** The one line a reader has to see about the warm clause. Report, log and `did`. */
export function struckWarmLine(): string {
  return (
    `STRUCK — "${STRUCK_WARM_START.clause}" is WITHDRAWN by the owner and nothing replaces it. ` +
    `Why: ${STRUCK_WARM_START.why}; ${STRUCK_WARM_START.measured}. ` +
    "The clause is struck, not relaxed — no budget in this item has been adjusted to fit a measurement, and " +
    "amendment §17's proposed 20 ms is NOT adopted in its place. The MEASUREMENT survives the strike: the figure " +
    "is still taken and still printed, it is simply no longer compared with anything."
  );
}

/**
 * Ruling 47. `@anthropic-ai/claude-agent-sdk` is proprietary — "© Anthropic PBC.
 * All rights reserved.", no redistribution grant — and the Claude ACP bridge
 * depends on it. It stays out of the binary only because ruling 44's
 * `CLAUDE_CODE_EXECUTABLE` shim keeps it out, so this is a constraint that is
 * currently true by accident and needs a guard against the artifact itself.
 *
 * Listed here rather than imported from `scripts/inventory.ts` on purpose: a
 * verifier drives this harness against a downloaded release with no repository
 * beside it, and a check that needed the build tree could not run there.
 */
export const PROPRIETARY_MARKERS = [
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "© Anthropic PBC. All rights reserved.",
] as const;

/**
 * What `bun --compile` puts in the binary whether anyone lists it or not.
 *
 * Ruling 72's premise, and the reason "names at least one component" is not a
 * check: an attribution that shrank to a single MIT dependency would satisfy a
 * one-line regex while dropping both LGPL libraries the artifact statically
 * links. These three cannot be absent from a `bun --compile` artifact, so they
 * cannot legitimately be absent from its attribution.
 */
export const UNAVOIDABLE_COMPONENTS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "bun", pattern: /\bbun\b/i },
  { label: "JavaScriptCore/WebKit", pattern: /javascriptcore|webkit/i },
  { label: "tinycc", pattern: /tinycc/i },
];

/**
 * The two rows that exist because an instrument did not run.
 *
 * The verdict is spelled into the NAME rather than left to a reader to infer
 * from a detail string, and it is spelled `NOT-RUN` — upper case, like item
 * 12's `ERROR —` and `NOT-RUN —` rows — because the harness's verdict on its
 * own check and the product's literal `not-run` record value are two different
 * facts that a report prints side by side. Lower case in backticks quotes the
 * product; upper case is this harness speaking. Both rows are
 * `expect(..., false, ...)` rather than notes:
 * `Checks.note` stamps `ok: true`, so a note is indistinguishable from a passing
 * assertion in the rendered report and in the halves. Ruling 48 is explicit that
 * a check which did not run is not a check that passed, and neither of these two
 * is a platform impossibility — one needs `claude` installed, the other needs a
 * `node` to strip. A machine that cannot supply either is a machine that cannot
 * grade this item, which is a different sentence from "this item passed".
 */
export const HOST_NOT_RUN =
  "NOT-RUN — the HOST's own view (`claude plugin details brigadier`), which is the instrument BAR.md names (ruling 60)";
export const NODE_STRIP_NOT_RUN =
  "NOT-RUN — there was no `node` on this machine's PATH to strip, so the strip proved nothing (ruling 4)";

/**
 * The build identifier, as the ARTIFACT reports it about itself.
 *
 * WHY THIS IS AN ASSERTION AND NOT A COURTESY. This binary's warm start has been
 * recorded four times — 11.29 ms, 16.13 ms, 13.99 ms and a contended reading —
 * and nothing tied any figure to any artifact. The numbers sit next to each
 * other looking like a series and they are not one: what changed between them
 * was never established, so no trend may be read into them. A number whose
 * subject is unnamed is not a measurement of anything, which is why the item
 * that reports the timings is the item that checks the identifier.
 *
 * Parsed out of `brigadier version`'s stdout rather than imported, because
 * nothing under `bar/` imports from `src/` (see `bar/types.ts`): the harness
 * drives the artifact as a black box, so what is checked is what an operator
 * would actually see.
 *
 * FIELDS ARE ASSERTED BY NAME. `missing` and `malformed` carry the field names,
 * never a count — a count of six is satisfied by the wrong six, and this
 * repository has shipped that mistake before.
 */
export const BUILD_ID_FIELDS = ["commit", "tree", "bun", "bun-revision", "binary-sha256", "binary-bytes"] as const;
export type BuildIdField = (typeof BUILD_ID_FIELDS)[number];

/** What each field has to look like to be that field rather than a placeholder. */
const BUILD_ID_SHAPES: Record<BuildIdField, RegExp> = {
  commit: /^[0-9a-f]{40}$/,
  tree: /^(?:clean|dirty)$/,
  bun: /^\d+\.\d+\.\d+/,
  "bun-revision": /^[0-9a-f]{40}$/,
  "binary-sha256": /^[0-9a-f]{64}$/,
  "binary-bytes": /^\d+$/,
};

export interface ReportedBuildId {
  /** The `BUILD-ID …` line itself, when the artifact printed one. */
  line?: string;
  fields: Partial<Record<BuildIdField, string>>;
  /** Field NAMES the line did not carry. */
  missing: BuildIdField[];
  /** Field names that were present and are not what they claim to be. */
  malformed: string[];
}

export function parseBuildId(text: string): ReportedBuildId {
  const line = text.split("\n").find((l) => l.trimStart().startsWith("BUILD-ID"))?.trim();
  const fields: Partial<Record<BuildIdField, string>> = {};
  const malformed: string[] = [];
  if (line !== undefined) {
    for (const match of line.matchAll(/([a-z0-9-]+)=(\S+)/g)) {
      const name = match[1] as BuildIdField;
      if (!(BUILD_ID_FIELDS as readonly string[]).includes(name)) continue;
      const value = match[2] ?? "";
      if (BUILD_ID_SHAPES[name].test(value)) fields[name] = value;
      else malformed.push(`${name}=${value}`);
    }
  }
  const missing = BUILD_ID_FIELDS.filter((f) => fields[f] === undefined);
  return { ...(line === undefined ? {} : { line }), fields, missing, malformed };
}

/**
 * The one string every figure in this item is printed beside.
 *
 * It says the artifact's name where there is one and says UNIDENTIFIED where
 * there is not — never nothing, because a timing that silently omits its
 * subject is the defect this whole surface exists to remove.
 */
export function attribution(reported: ReportedBuildId): string {
  if (reported.missing.length === 0 && reported.malformed.length === 0 && reported.line !== undefined) {
    return `ARTIFACT: ${reported.line}`;
  }
  return (
    "ARTIFACT: UNIDENTIFIED — " +
    (reported.line === undefined
      ? "`brigadier version` printed no BUILD-ID line at all"
      : `the BUILD-ID line is missing ${reported.missing.join(", ") || "nothing"}` +
        (reported.malformed.length === 0 ? "" : ` and carries malformed ${reported.malformed.join(", ")}`)) +
    ". The figure below therefore names no artifact, and cannot be compared with any other figure"
  );
}

export interface HookFileEvidence {
  /** The installed hook file, as found under the scratch home. `undefined` = none was written. */
  path?: string;
  /** Event names read from it — the `hooks` wrapper if present, else the top level. */
  events: string[];
  /** Why it could not be read, when it could not be. */
  problem?: string;
}

export interface ArtifactObservations {
  licences: { code: number | null; stdout: string; stderr: string };
  full: { code: number | null; stdout: string; stderr: string };
  markersFound: string[];
  sizeBytes: number;
  /** `brigadier version` — the identity the artifact reports about ITSELF. */
  versionProbe: { code: number | null; stdout: string; stderr: string };
  /**
   * sha256 of `ctx.binary`, computed by THIS harness from the file it timed.
   *
   * WHAT COMPARING IT PROVES, AND WHAT IT DOES NOT. It proves the process that
   * printed the identifier is the file this harness timed. It is NOT a witness
   * to the other three fields: the commit, the tree state and the bun are
   * assertions by whoever compiled, and a bare binary carries nothing that can
   * check them. An earlier draft of this comment claimed a stamp carried forward
   * from an earlier build "fails here rather than passing as an identity", and
   * that was false — a patched, re-signed copy of `dist/brigadier` reported the
   * original commit beside the TAMPERED file's own true digest and passed every
   * check below. Detecting a false commit needs a signature over the stamp,
   * which this surface does not have and does not claim.
   *
   * It still earns the comparison. It fails on an absent or broken version
   * surface; on a digest that is hardcoded rather than computed; on a future
   * regression that stamps the digest at compile time, which would then name the
   * PREVIOUS build; and on a report stitched from two binaries, where a figure
   * timed against one artifact is printed beside another's identity. Those are
   * the realistic ways this repository loses attribution, and they are caught.
   */
  binarySha256: string;
  warmMs: number;
  /** What this harness costs to spawn anything at all, subtracted below. */
  spawnFloorMs: number;
  nodeless: { code: number | null; stdout: string; stderr: string };
  nodelessPathRemoved: string[];
  /**
   * Whether a SHELL can still resolve `node`, before and after the strip.
   *
   * Asked of the operating system's own `PATH` search rather than of the same
   * `existsSync` walk that did the stripping — a check built from the predicate
   * it is checking agrees with itself for free.
   */
  nodeOnPath: { before: string; after: string };
  installProbe: string;
  /** Paths that really appeared under a scratch HOME after `install`. */
  installedPaths: string[];
  /** The scratch home's file listing before `install` — the removal baseline. */
  homeBeforeInstall: string[];
  /** And after `uninstall`. Equality with the line above is the removal check. */
  homeAfterUninstall: string[];
  uninstall: { code: number | null; stdout: string; stderr: string };
  /** Directories left behind empty. Reported, deliberately not gated — see below. */
  emptyDirsLeft: string[];
  /** brigadier's own printed hook surface. The weakest of the three instruments. */
  hooksProbe: string;
  /** The `hooks.json` install actually wrote. Evidence no self-report can supply. */
  installedHookFile: HookFileEvidence;
  /** `claude plugin details brigadier`, run against the scratch home. */
  hostDetails: { available: boolean; command: string; code: number | null; output: string };
  poisonedHooksProbe: string;
  poisonedHooksCode: number | null;
  poisonKey: string;
  poisonedPath: string;
}

const APACHE_BODY = "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION";
const APACHE_APPENDIX = "APPENDIX: How to apply the Apache License";
const LGPL_TITLES = [/GNU LESSER GENERAL PUBLIC LICENSE/i, /GNU LIBRARY GENERAL PUBLIC LICENSE/i];

/**
 * Widely separated landmarks in the LGPL's own body, all of which are required.
 *
 * The check they replace matched a TITLE and any one of three version strings,
 * which a two-line header satisfies — so an artifact that shipped
 * "GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1, February 1999" and no licence
 * at all would have passed a check whose whole subject is §6's unconditional
 * obligation to supply the text. These four are the terms header, the sentence
 * that CREATES the relink obligation, the warranty disclaimer and the closing
 * line: dropping the body loses all four.
 */
const LGPL_LANDMARKS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "the LGPL's own terms header", pattern: /TERMS AND CONDITIONS FOR COPYING, DISTRIBUTION AND MODIFICATION/ },
  { label: "§6's relink sentence", pattern: /complete object files to the recipients/i },
  { label: "the warranty disclaimer", pattern: /NO WARRANTY/ },
  { label: "the closing line", pattern: /END OF TERMS AND CONDITIONS/ },
];

export interface LgplIntegrity {
  titleIndex: number;
  missing: string[];
  /** Characters from the first LGPL title to the last closing line after it. */
  spanChars: number;
}

/**
 * Is the LGPL text actually THERE, or only its heading?
 *
 * `spanChars` is reported rather than gated on its own: the two texts this
 * artifact carries are ~23 KB (v2) and ~26 KB (v2.1), so a span of a few hundred
 * characters is visible in the output without a second magic number.
 */
export function lgplIntegrity(text: string): LgplIntegrity {
  let titleIndex = -1;
  for (const title of LGPL_TITLES) {
    const match = title.exec(text);
    if (match !== null && (titleIndex === -1 || match.index < titleIndex)) titleIndex = match.index;
  }
  if (titleIndex === -1) {
    return { titleIndex: -1, missing: ["the LGPL title itself", ...LGPL_LANDMARKS.map((l) => l.label)], spanChars: 0 };
  }
  const body = text.slice(titleIndex);
  const missing = LGPL_LANDMARKS.filter((landmark) => !landmark.pattern.test(body)).map((l) => l.label);
  const end = body.lastIndexOf("END OF TERMS AND CONDITIONS");
  return { titleIndex, missing, spanChars: end === -1 ? 0 : end + "END OF TERMS AND CONDITIONS".length };
}

export function judgeArtifact(o: ArtifactObservations): Checks {
  const checks = new Checks();
  const full = o.full.stdout;
  // Parsed first, because every number this item prints is printed beside it.
  const reported = parseBuildId(o.versionProbe.stdout);
  const cite = attribution(reported);

  // ── the struck clause, first, so it cannot be scrolled past ────────────────
  // Printed on a PASS as well as a failure. A withdrawn promise that only shows
  // up when something else breaks is a withdrawn promise nobody reads.
  checks.note("STRUCK CLAUSE — this item asserts no cold-start budget, and none is promised", struckLine());
  checks.note(
    "what the struck clause leaves unproven",
    `${STRUCK_COLD_START.unproven}. AND NONE OF THOSE COLD FIGURES NAMES AN ARTIFACT: 873 ms, 892 ms and the ` +
      "6,045 ms quarantined reading were taken against binaries that carried no build identifier, so they are " +
      `attributable to a date and a machine and to nothing else. This run's subject, by contrast — ${cite}`,
  );
  // The second strike, 2026-08-20. Printed on a PASS as well as a failure, for
  // the same reason as the first, and printed here rather than beside the
  // measurement so a reader meets the withdrawal before meeting the number.
  checks.note("STRUCK CLAUSE — this item asserts no warm-start budget, and none is promised", struckWarmLine());
  checks.note(
    "what the struck warm clause leaves unproven",
    `${STRUCK_WARM_START.unproven}. The figure this run measured is below, printed beside the artifact it belongs ` +
      `to — ${cite}`,
  );

  // Ruling 47 / Apache-2.0 §4(a): the obligation is to whoever RECEIVES the
  // work, and under ruling 26 that is routinely a bare binary from a tap or a
  // plugin directory with no repository beside it.
  checks.expect(
    "`brigadier licenses` exits 0 and names the licence",
    o.licences.code === 0 && /Apache-2\.0/.test(o.licences.stdout),
    `exit ${o.licences.code}; stdout: ${excerpt(o.licences.stdout, 240)}`,
  );
  checks.expect(
    "attribution names at least one third-party component with a version",
    /\n\s+\S+\s+\d+\.\d+\S*\s+—\s+/.test(o.licences.stdout),
    `component lines found: ${excerpt(o.licences.stdout.split("\n").filter((l) => /—/.test(l)).join(" | "), 240)}`,
  );
  // "Full attribution", asserted as full. See UNAVOIDABLE_COMPONENTS.
  const unlisted = UNAVOIDABLE_COMPONENTS.filter((c) => !c.pattern.test(o.licences.stdout)).map((c) => c.label);
  checks.expect(
    "attribution names every component `bun --compile` puts in the binary regardless",
    unlisted.length === 0,
    unlisted.length === 0
      ? `all three named in \`brigadier licenses\`: ${UNAVOIDABLE_COMPONENTS.map((c) => c.label).join(", ")}`
      : `ABSENT from the attribution: ${unlisted.join(", ")} — these are statically linked into every ` +
        "`bun --compile` artifact, so an attribution without them is not full",
  );
  checks.expect(
    "`--full` carries the complete Apache-2.0 text",
    full.includes(APACHE_BODY) && full.includes(APACHE_APPENDIX),
    `--full is ${full.length} bytes; ${APACHE_BODY}: ${full.includes(APACHE_BODY)}; appendix: ${full.includes(APACHE_APPENDIX)}`,
  );

  // Ruling 72. §6 makes supplying the Library's own licence unconditional, and
  // MEASURED on 2026-08-17: Bun's shipped binary carries 875 hits for
  // "JavaScriptCore" and 0 for "GNU Lesser/Library General Public", so nothing
  // upstream discharges it for us.
  const lgpl = lgplIntegrity(full);
  checks.expect(
    "`--full` carries the LGPL text itself (ruling 72)",
    lgpl.titleIndex !== -1 && lgpl.missing.length === 0,
    lgpl.titleIndex === -1
      ? `searched ${full.length} bytes of --full: no LGPL title at all`
      : `title at byte ${lgpl.titleIndex} of ${full.length}; ${lgpl.spanChars - lgpl.titleIndex} characters from it to the ` +
        `closing line; missing landmarks: ${lgpl.missing.length === 0 ? "none" : lgpl.missing.join(", ")}. ` +
        "A title and a version string are not the text — §6's obligation is the body, so the body's own landmarks are required",
  );
  checks.expect(
    "the relink recipe is present, as commands rather than a citation",
    /git clone/i.test(full) && /github\.com\/oven-sh\/webkit/i.test(full) && /github\.com\/oven-sh\/tinycc/i.test(full),
    `\`git clone\`: ${/git clone/i.test(full)}; oven-sh/WebKit: ${/github\.com\/oven-sh\/webkit/i.test(full)}; ` +
      `oven-sh/tinycc: ${/github\.com\/oven-sh\/tinycc/i.test(full)}. A recipe a reader cannot run is a mention`,
  );
  // The pin must be attached to the library it pins. A bare 40-hex anywhere in
  // the text is not evidence: the first draft of this check passed on
  // `532c8b70b9142c17e07737ab6d3da68d7500cbca`, which is a commit in a URL about
  // Tigerbeetle's IO code and pins nothing about WebKit at all.
  const webkitPin = pinNear(full, "webkit");
  const tinyccPin = pinNear(full, "tinycc");
  checks.expect(
    "WebKit's and tinycc's corresponding source is reachable, PINNED (ruling 72)",
    webkitPin !== undefined && tinyccPin !== undefined,
    `WebKit pin: ${webkitPin ?? "ABSENT"}; tinycc pin: ${tinyccPin ?? "ABSENT"} — a pin must be a 40-hex revision or a tagged reference on the same line as the library it pins`,
  );

  // Ruling 47's marker scan, on the artifact rather than the module graph.
  checks.expect(
    "the binary carries no proprietary marker",
    o.markersFound.length === 0,
    o.markersFound.length === 0
      ? `scanned ${o.sizeBytes} bytes for ${PROPRIETARY_MARKERS.length} markers, none found`
      : `found ${o.markersFound.map((m) => JSON.stringify(m)).join(", ")}`,
  );

  // NOT "the measured budget". Amendment §16 established that 63 MB was never
  // measured on anything: it enters this project as ONE unsourced sentence at
  // `MEASUREMENT-SESSION.md:140`, commit `7e6a547`, under the heading "Already
  // measured — do not redo, but do dispute if you find otherwise", and v1's
  // entire history at Release 0.2.1 contains no "63 MB". That is the SAME
  // sentence and the SAME provenance behind the ≤70 ms and ≤10 ms clauses the
  // owner struck in the open (§23, §24). This clause was not struck with them,
  // so it still gates — but it may not call itself measured while doing so.
  //
  // AND ON LINUX IT IS UNREACHABLE, which §23's own argument settles rather than
  // this file. MEASURED against `bun 1.3.14` on 2026-08-20, a compiled program
  // whose entire source is `process.exit(0)`:
  //     darwin arm64                       63,446,114 bytes  (60.51 MiB)
  //     linux x64 (oven/bun:1.3.14)        93,694,096 bytes  (89.35 MiB)
  // The Linux FLOOR is 27.6 MB over the 63 MiB budget before brigadier
  // contributes a byte. §16's sentence about the struck cold-start clause holds
  // here word for word: there is no version of brigadier that fits, because
  // `process.exit(0)` does not. Whether the clause is struck like its two
  // siblings is the OWNER'S, exactly as §23 and §24 were.
  checks.expect(
    `binary within the 63 MiB budget of ${SIZE_BUDGET_BYTES} bytes`,
    o.sizeBytes <= SIZE_BUDGET_BYTES,
    `${o.sizeBytes} bytes = ${(o.sizeBytes / 1_048_576).toFixed(2)} MiB = ${(o.sizeBytes / 1_000_000).toFixed(2)} MB decimal. ` +
      `Budget is 63 MiB (${SIZE_BUDGET_BYTES} bytes): this repository's own license-gate prints bytes/1048576 and calls it "MB", ` +
      "so v1's 63 MB reads as 63 MiB. Both readings are printed because they disagree about the verdict. " +
      "PROVENANCE: the figure is UNSOURCED (amendment §16) — the same unsourced sentence behind the struck " +
      "cold- and warm-start clauses. On linux the empty-program floor alone is 93,694,096 bytes (MEASURED 2026-08-20)",
  );

  // ── which artifact is this? ───────────────────────────────────────────────
  // Before any timing, because a figure whose subject is unnamed is not a
  // measurement of anything. Two checks, and neither is a note: the first says
  // the artifact carries an identifier, the second says the identifier is THIS
  // artifact's. The second is the one that cannot be faked, because the harness
  // recomputes the digest from the file it timed.
  checks.expect(
    "the artifact carries a build identifier — commit, tree state, compiling bun, and its own sha256",
    o.versionProbe.code === 0 && reported.missing.length === 0 && reported.malformed.length === 0,
    `\`brigadier version\` exited ${o.versionProbe.code}. ` +
      (reported.line === undefined
        ? `NO BUILD-ID line was printed. stdout: ${excerpt(o.versionProbe.stdout, 240)}; stderr: ${excerpt(o.versionProbe.stderr, 160)}`
        : `line: ${reported.line}. ` +
          `Missing field(s): ${reported.missing.length === 0 ? "none" : reported.missing.join(", ")}. ` +
          `Malformed field(s): ${reported.malformed.length === 0 ? "none" : reported.malformed.join(", ")}. ` +
          `Fields are named rather than counted — six fields of the wrong six is not this check passing`),
  );
  checks.expect(
    "the build identifier names the artifact that was actually timed",
    reported.fields["binary-sha256"] !== undefined && reported.fields["binary-sha256"] === o.binarySha256,
    `the artifact reports binary-sha256=${reported.fields["binary-sha256"] ?? "ABSENT"}; this harness hashed the ` +
      `file it timed and got ${o.binarySha256}. ` +
      (reported.fields["binary-sha256"] === o.binarySha256
        ? "They agree, so every figure below was timed against the file that printed that line — which is what this " +
          "check proves and the LIMIT of what it proves: the commit and the tree state are assertions by whoever " +
          "compiled, and a patched binary reports its own true digest beside whatever commit was stamped into it."
        : "They DISAGREE, so the line above describes a different file from the one that was timed — a report stitched " +
          "from two binaries, a hardcoded digest, or a digest stamped at compile time naming the previous build. " +
          "A figure attributed to another artifact's identifier is worse than one attributed to nothing."),
  );
  checks.expect(
    "the identifier states whether the tree it was built from was clean",
    reported.fields["tree"] !== undefined,
    reported.fields["tree"] === undefined
      ? "no `tree` field — whether the commit determines these bytes is unknown, which is the whole question a commit is cited to answer"
      : `tree=${reported.fields["tree"]} at commit ${reported.fields["commit"] ?? "unknown"}. ` +
        (reported.fields["tree"] === "dirty"
          ? "DIRTY: the commit does NOT determine these bytes, this build cannot be reproduced from it, and only the sha256 above " +
            "identifies it. Reported rather than gated — a dirty build is attributable, it is simply not reproducible"
          : "clean: the commit determines these bytes, so this artifact can be rebuilt and the rebuild can be compared byte for byte"),
  );

  // The harness's own spawn cost is still subtracted, because a figure that
  // includes a millisecond of this file is not the artifact's figure. Both the
  // raw and the corrected numbers are printed so the correction can be argued
  // with rather than taken on trust.
  //
  // WHAT THIS ROW ASSERTS, now that the ≤10 ms clause is struck: that a warm
  // figure was actually OBTAINED. It compares it with nothing. The strike
  // removed the budget, not the measurement — but "we no longer gate on the
  // value" must not be allowed to become "we no longer time the binary", so the
  // measurement itself is a gate and can go red. A timing loop that produced no
  // usable sample leaves `warmMs` at +Infinity, and this row is what catches it.
  //
  // It is an `expect` and NOT a `note`, deliberately. `note` stamps `ok: true`
  // and contributes nothing to any verdict, and this item shipped a blocking
  // condition dressed as a note once already (see `HOST_NOT_RUN`). The two
  // STRUCK rows above are notes because a withdrawn clause genuinely gates
  // nothing and `note` is the only leader `render` will not print as `ok  `;
  // this row is the gate that stops the strike from costing the measurement.
  const warmNet = Math.round((o.warmMs - o.spawnFloorMs) * 100) / 100;
  const warmMeasured =
    Number.isFinite(o.warmMs) &&
    o.warmMs > 0 &&
    Number.isFinite(o.spawnFloorMs) &&
    o.spawnFloorMs >= 0 &&
    warmNet > 0;
  checks.expect(
    `warm start is MEASURED and REPORTED (minimum of ${START_SAMPLES}, floor-corrected) — the ≤${WITHDRAWN_WARM_BUDGET_MS} ms clause is STRUCK, so the figure gates nothing`,
    warmMeasured,
    warmMeasured
      ? `${cite}. ` +
        `METHOD: minimum of ${START_SAMPLES} invocations, floor-corrected — ${o.warmMs} ms raw − ${o.spawnFloorMs} ms spawn floor = ${warmNet} ms. ` +
        `NO THRESHOLD IS APPLIED TO THAT NUMBER AND NO MARGIN IS PRINTED BESIDE IT: the ≤${WITHDRAWN_WARM_BUDGET_MS} ms warm clause was WITHDRAWN by the owner on 2026-08-20 ` +
        "(see the STRUCK rows above), amendment §17's proposed 20 ms was not adopted in its place, and nothing else was — so there is nothing left to state a margin against. " +
        `The statistic is still the MINIMUM because scheduler noise only adds, and N=${START_SAMPLES} because that is where it stopped moving ` +
        "(the 2026-08-17 series min-of-5 12.10 ms / min-of-40 12.13 ms / min-of-150 12.07 ms is evidence about N and was taken against an EARLIER artifact — " +
        "it is not this binary's warm cost, and reading it as one already produced a wrong correction once). " +
        `REFERENCE, taken under the conditions the method asks for — MEASURED ${QUIET_WARM_MEASUREMENT.measuredOn}: ` +
        `raw min ${QUIET_WARM_MEASUREMENT.rawMinMs} ms − ${QUIET_WARM_MEASUREMENT.spawnFloorMs} ms floor = ${QUIET_WARM_MEASUREMENT.correctedMs} ms, ` +
        `distribution ${QUIET_WARM_MEASUREMENT.distribution} — ` +
        "a spread that narrow is why the minimum is a trustworthy estimator here and not merely a conservative one. " +
        "READ THE FIGURE WITH THE MACHINE: a minimum is robust to noise but not immune to it, and the number above was taken on whatever machine ran the bar. " +
        "MEASURED, rather than assumed: contention cost 0.65 ms on this artifact (14.64 ms on a machine running five other agents against 13.99 ms quiet), " +
        "so two readings a few tenths apart are not the same reading, and two several milliseconds apart are not explained by contention either"
      : `ERROR — no warm figure was obtained, so there is nothing to report: raw ${o.warmMs} ms, spawn floor ${o.spawnFloorMs} ms, corrected ${warmNet} ms. ` +
        `${cite}. The ≤${WITHDRAWN_WARM_BUDGET_MS} ms clause is struck and the MEASUREMENT is not: an item that quietly stopped timing the binary would leave ` +
        "nobody anything to revisit, which is the whole reason the strike kept the number. This is a failure of this harness or of the machine it ran on, " +
        "not a statement about the product",
  );
  // The number has a history, and the history does not support a trend.
  checks.note(
    "the warm figure has been recorded three times, against three different artifacts",
    `${QUIET_WARM_MEASUREMENT.priorReadings}. What changed between those three points is NOT established: the artifact was not held ` +
      "constant and no record ties a figure to a build, so the sequence is neither a regression nor an improvement — it is three measurements " +
      "of three things. Establish what the artifact was at each point before reading a direction into it. " +
      "THE HISTORY IS NOT RETROACTIVELY REPAIRABLE and no attempt is made to repair it: those binaries no longer exist, and none of them " +
      `carried an identifier, so no sha256 can be recovered for any of them. What the check above changes is the NEXT reading — ${cite} — ` +
      "and a fifth figure recorded against a named artifact can be compared with a sixth. Nothing here makes the four earlier ones comparable",
  );
  checks.note(
    "the headroom measurement the withdrawn clause was argued over, kept",
    "MEASURED on 2026-08-17: a `bun --compile` binary whose whole program is `process.exit(0)` starts in 7.76 ms (min-of-40) raw, ~6.5 ms floor-corrected. " +
      "It was taken to answer a verifier who held that the ≤10 ms clause could only be satisfied by something ruling 5 does not permit the product to be — it could be, " +
      "with about 3.5 ms of headroom, so the artifact missed that clause for a real reason rather than a definitional one. " +
      "Kept now that the clause is struck, because it is the runtime floor any FUTURE warm claim would have to be read against, and because a strike must not take the " +
      "evidence that was argued over out of the record",
  );
  checks.note(
    "PROPOSAL, not adopted — amendment §17's warm budget",
    "amendment §17 PROPOSES warm ≤ 20 ms and measures 16.13 ms as achievable (floor-corrected, minimum of N=40). " +
      "The owner has NOT adopted it, and the 2026-08-20 strike did not adopt it either. That is the point of the strike rather than an oversight: " +
      "a clause withdrawn because its figure has no provenance cannot be repaired by installing a second figure picked to clear the last reading, " +
      "and 20 ms against a measured 16.13 ms is exactly that shape. So it gates nothing, nothing replaces the withdrawn clause, and no budget in this " +
      "item was ever adjusted to fit a measurement",
  );

  // Ruling 4: the bridges are vendored, and the binary must start where node is
  // not installed at all.
  if (o.nodeOnPath.before === "") {
    // `after === ""` is satisfied for free where there was never a `node`, so
    // the strip would read green having removed nothing. That is the same
    // disguise as an unconsulted host: the instrument did not run.
    checks.expect(
      NODE_STRIP_NOT_RUN,
      false,
      "a shell resolved `node` to nothing BEFORE the strip, so `after` is empty for free and " +
        "`pathWithout` was never exercised. The run below is nodeless either way, but whether the STRIP works is unproven — " +
        "install node on the machine grading this item, which is what every CI runner already does",
    );
  } else {
    checks.expect(
      "node is genuinely unreachable on the stripped PATH",
      o.nodeOnPath.after === "",
      `a shell asked to resolve \`node\` found ${o.nodeOnPath.before} before the strip ` +
        `and ${o.nodeOnPath.after === "" ? "nothing" : `${o.nodeOnPath.after} — the strip did not work`} after it. ` +
        `${o.nodelessPathRemoved.length} PATH entries were removed. ` +
        "Asked of the OS's own PATH search, not of the walk that did the stripping: a check built from the predicate it is checking agrees with itself for free",
    );
  }
  checks.expect(
    "runs with node absent from PATH (ruling 4)",
    o.nodeless.code === 0 && o.nodeless.stdout.length > 0,
    `exit ${o.nodeless.code}; stdout ${o.nodeless.stdout.length} bytes; stderr: ${excerpt(o.nodeless.stderr, 160)}`,
  );
  checks.expect(
    "and produces the SAME output it produces with node present",
    o.nodeless.stdout === o.licences.stdout,
    o.nodeless.stdout === o.licences.stdout
      ? `both runs printed the same ${o.licences.stdout.length} bytes — no silent degradation`
      : `nodeless output differs: ${o.licences.stdout.length} bytes with node, ${o.nodeless.stdout.length} without. ` +
        `Nodeless: ${excerpt(o.nodeless.stdout, 200)}`,
  );

  // Ruling 42, on the paths that really appeared rather than on the sentence
  // the binary printed about itself.
  checks.expect(
    "install reaches ruling 42's cross-vendor discovery path, named",
    /~\/\.agents\/skills\/|\.agents[/\\]skills/.test(o.installProbe) &&
      o.installedPaths.some((p) => /\.agents[/\\]skills/.test(p)),
    `install output: ${excerpt(o.installProbe, 200)}; paths that actually appeared under HOME: ${o.installedPaths.join(", ") || "NONE"}`,
  );
  // Ruling 42 MEASURED that Claude Code does not discover `~/.agents/skills/` at
  // all, so one root is not "each host's real discovery path" — it is one host's.
  checks.expect(
    "and Claude Code's own root, which does not see the cross-vendor one (ruling 42)",
    o.installedPaths.some((p) => /\.claude[/\\]skills/.test(p)),
    `paths under HOME: ${o.installedPaths.join(", ") || "NONE"}. ` +
      "MEASURED against `claude 2.1.234`: a directory planted under ~/.agents/skills/ was NOT found at all, so both roots are required",
  );
  checks.expect(
    "install puts no `bin/` on PATH outside Claude Code (ruling 42)",
    !o.installedPaths.some((p) => /(^|[/\\])bin[/\\]/.test(p)),
    `paths that appeared: ${o.installedPaths.join(", ") || "none"}`,
  );
  // `BAR.md`: the item must not imply six uniform clients. Asserted on what the
  // ARTIFACT says, because a caveat that lives only in this harness is a caveat
  // no user of the binary ever reads.
  checks.expect(
    "install does not imply six uniform clients — ChatGPT is named as a permanent blank",
    /chatgpt/i.test(o.installProbe) && /qwen/i.test(o.installProbe),
    `ChatGPT named: ${/chatgpt/i.test(o.installProbe)}; Qwen (the MEASURED counterexample to ~/.agents/skills/ discovery) named: ${/qwen/i.test(o.installProbe)}. ` +
      "A hosted surface has no filesystem, and a broad convention is not a universal one",
  );

  // "Installs, runs and is removed cleanly" is three claims. This is the third.
  const residue = o.homeAfterUninstall.filter((p) => !o.homeBeforeInstall.includes(p));
  const wrongly = o.homeBeforeInstall.filter((p) => !o.homeAfterUninstall.includes(p));
  checks.expect(
    "`uninstall` removes every file install wrote, and nothing else (ruling 26)",
    o.uninstall.code === 0 && residue.length === 0 && wrongly.length === 0,
    `exit ${o.uninstall.code}; ${o.installedPaths.length} files were written by install; ` +
      `left behind after uninstall: ${residue.join(", ") || "none"}; ` +
      `of the operator's own files, destroyed: ${wrongly.join(", ") || "none"}. ` +
      `stderr: ${excerpt(o.uninstall.stderr, 160)}`,
  );
  checks.note(
    "empty directories left behind",
    o.emptyDirsLeft.length === 0
      ? "none"
      : `${o.emptyDirsLeft.join(", ")} — reported, deliberately NOT a failure: these are shared parents ` +
        "(`~/.claude/skills/`, `~/.agents/skills/`) and removing a directory other products also install into would be the ruling 8 violation this item exists to prevent",
  );

  // Ruling 60, asserted BY NAME and against the HOST. "Did not print `unknown
  // command`" is not an assertion about anything, and neither is brigadier's own
  // printed surface: `.lsp.json` was measured reporting `LSP servers (1)` for
  // `{"notARealKey": 1}`, which is why ruling 60 asks for the name.
  const hookFile = o.installedHookFile;
  checks.expect(
    "install wrote a hooks.json that NAMES `PreCompact` (ruling 60)",
    hookFile.path !== undefined && hookFile.events.includes("PreCompact"),
    hookFile.path === undefined
      ? `no hooks.json appeared under the scratch HOME at all${hookFile.problem === undefined ? "" : ` — ${hookFile.problem}`}`
      : `${hookFile.path} names ${hookFile.events.join(", ") || "no events"}${hookFile.problem === undefined ? "" : ` (${hookFile.problem})`}. ` +
        "Read off the disk rather than from the binary's own printed surface, which is a compiled-in string and names PreCompact whether or not install wrote anything",
  );
  checks.expect(
    "the hook file is inside a directory brigadier owns (rulings 8, 27)",
    hookFile.path !== undefined && /skills[/\\]brigadier[/\\]/.test(hookFile.path),
    `hook file: ${hookFile.path ?? "NONE"} — a hook written into a file another product owns is ruling 8's violation, not a hook surface`,
  );
  if (o.hostDetails.available) {
    checks.expect(
      "the HOST names `PreCompact` after install (ruling 60, BAR.md's own instrument)",
      /\bPreCompact\b/.test(o.hostDetails.output),
      `\`${o.hostDetails.command}\` exit ${o.hostDetails.code}: ${excerpt(o.hostDetails.output, 300)} — ` +
        'asserted by NAME, because a count is evidence of nothing: `{"notARealKey": 1}` was measured reporting `LSP servers (1)`',
    );
  } else {
    // NOT a note. A `note` renders `ok`, and an `ok` here would mean the one
    // instrument `BAR.md` names for the hook floor never executed while the item
    // reported PASS — a SKIPPED wearing a note's clothes, on the CI leg the
    // document calls authoritative. Ruling 48: a check that did not run is not a
    // check that passed. `claude` is installable on all three runners, so this
    // is a missing dependency, not a platform impossibility.
    checks.expect(
      HOST_NOT_RUN,
      false,
      `\`claude\` is not on this machine's PATH, so \`${o.hostDetails.command}\` did not run. ` +
        "This BLOCKS rather than passing quietly: it is not a legal skip, because nothing about this machine makes it impossible — " +
        "install `claude` on the runner (`.github/workflows/gates.yml` does). " +
        "Precisely what is and is not proven without it: the file half above DID run and DOES prove install wrote a hook file naming " +
        "`PreCompact` inside a directory brigadier owns. What is unproven is the other half — that the HOST LOADS it — and those two are " +
        "not the same claim, which is why they are not collapsed into one row",
    );
  }
  checks.expect(
    "brigadier's own printed hook surface names `PreCompact`",
    /\bPreCompact\b/.test(o.hooksProbe),
    `hook output: ${excerpt(o.hooksProbe, 200)}. This is a SELF-REPORT and the weakest of the three instruments here — ` +
      "it is a compiled-in string, so it cannot fail because install broke. The two checks above are the ones that can",
  );
  checks.expect(
    "a hooks.json carrying one unrecognised event is REPORTED, not silently discarded (ruling 60)",
    o.poisonedHooksProbe.includes(o.poisonKey) &&
      o.poisonedHooksProbe.includes(o.poisonedPath) &&
      /(discard|ignored|unrecognis|unrecogniz|unknown event|invalid)/i.test(o.poisonedHooksProbe),
    `planted an unrecognised event ${JSON.stringify(o.poisonKey)} beside valid hooks in ${o.poisonedPath}; ` +
      `output: ${excerpt(o.poisonedHooksProbe, 240)}. ` +
      "The key AND the file must both be named: `this file has a problem` sends a reader to a file where every line looks like every other line",
  );
  checks.expect(
    "and the poisoned file makes the check EXIT NON-ZERO",
    o.poisonedHooksCode !== null && o.poisonedHooksCode !== 0,
    `exit ${o.poisonedHooksCode}. MEASURED against \`claude 2.1.233\` and \`2.1.234\`: the host exits 0, prints nothing and discards every hook in the file. ` +
      "A report that exits 0 too is a report no script can act on, so the exit code is asserted separately from the words",
  );

  checks.note(
    "scope",
    "ChatGPT is a permanent blank — a hosted surface has no filesystem — so nothing here implies six uniform clients. And ruling 72 leaves 'the documented rebuild path reproduces the binary' as a bar item still to be written; this item does not prove it",
  );

  return checks;
}

/**
 * A pinned revision on the same line as the library it pins.
 *
 * "Same line" is the whole point: ruling 72 asks that the corresponding source
 * be reachable from the same place as the binary, PINNED, and a revision that
 * belongs to some other component is not a pin — it is a coincidence that
 * happens to be forty characters of hex.
 */
export function pinNear(text: string, library: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.toLowerCase().includes(library.toLowerCase())) continue;
    const sha = /\b[0-9a-f]{40}\b/.exec(line);
    if (sha) return sha[0];
    const tagged = /(?:@|#|\btag[:=]\s*|\bpinned to\s+)v?\d+[\w.-]*/i.exec(line);
    if (tagged) return tagged[0];
  }
  return undefined;
}

export function scanForMarkers(bytes: Buffer): string[] {
  const found: string[] = [];
  for (const marker of PROPRIETARY_MARKERS) {
    if (bytes.indexOf(Buffer.from(marker, "utf8")) !== -1 || bytes.indexOf(Buffer.from(marker, "latin1")) !== -1) {
      found.push(marker);
    }
  }
  return found;
}

/**
 * Event names out of a `hooks.json`, in both shapes that exist.
 *
 * A plugin's `hooks/hooks.json` wraps its events in a `hooks` object; a
 * standalone file in a config directory is a bare event map. Reading only one
 * shape would report an installed hook file as empty, which is the instrument
 * failure this item is otherwise about.
 */
export function hookEventsIn(text: string): { events: string[]; problem?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { events: [], problem: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { events: [], problem: "top level is not an object, so no event names can be read from it" };
  }
  const record = parsed as Record<string, unknown>;
  const wrapped = record["hooks"];
  if (typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped)) {
    return { events: Object.keys(wrapped as Record<string, unknown>) };
  }
  return { events: Object.keys(record) };
}

/**
 * The topmost directories under `root` that hold no file anywhere beneath them.
 *
 * `files` is the same listing the removal check compares, so this cannot
 * disagree with it. Reported rather than gated: see the note in `judgeArtifact`.
 */
export function emptyDirectories(root: string, files: readonly string[]): string[] {
  const empty: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (!info.isDirectory()) continue;
      const child = rel === "" ? entry : `${rel}/${entry}`;
      if (files.some((f) => f.startsWith(`${child}/`))) walk(path, child);
      else empty.push(child);
    }
  };
  walk(root, "");
  return empty.sort();
}

/** Ask the operating system, through a shell, whether `node` resolves on a PATH. */
async function resolveNode(path: string): Promise<string> {
  const argv =
    process.platform === "win32" ? ["cmd", "/c", "where node"] : ["/bin/sh", "-c", "command -v node"];
  const result = await exec(argv, { env: baseEnv({ PATH: path }), timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim().split("\n")[0]?.trim() ?? "" : "";
}

const item: BarItem = {
  id: 10,
  title: "The artifact ships, and says what is in it",
  rulings: [26, 42, 12, 4, 44, 47, 5, 46, 60, 72],
  requiresLive: false,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    // BOTH strikes are announced as the item runs, not only in the report it
    // returns. A reader watching the output must see each withdrawal.
    ctx.log(struckLine());
    did.push(struckLine());
    ctx.log(struckWarmLine());
    did.push(struckWarmLine());

    // Warm timing first, before anything else in this item touches the binary.
    // STILL TIMED THOUGH ITS CLAUSE IS STRUCK: the withdrawal was of the budget,
    // not of the measurement, and a figure that stops being taken is a figure
    // nobody can ever revisit. There is no cold measurement here, because the
    // cold clause is struck AND re-measuring a settled number costs minutes and
    // proves nothing new — that is the difference between the two strikes.
    let warm = Number.POSITIVE_INFINITY;
    for (let i = 0; i < START_SAMPLES; i++) {
      const run = await ctx.run(["--help"], { timeoutMs: 30_000 });
      warm = Math.min(warm, run.ms);
    }
    const floor = await spawnFloorMs();
    did.push(
      `timed \`brigadier --help\` ${START_SAMPLES} times and took the MINIMUM, and calibrated this harness's own spawn cost at ${floor} ms`,
    );

    const licences = await ctx.run(["licenses"], { timeoutMs: 30_000 });
    const full = await ctx.run(["licenses", "--full"], { timeoutMs: 60_000 });
    did.push("ran `brigadier licenses` and `brigadier licenses --full`");

    const bytes = readFileSync(ctx.binary);
    const markersFound = scanForMarkers(bytes);
    did.push(`scanned ${bytes.byteLength} bytes of the artifact for ${PROPRIETARY_MARKERS.length} proprietary markers`);

    // Which artifact was that? Asked of the binary AFTER the timing loop, so the
    // question does not warm a page cache the timing then benefits from, and the
    // answer is checked against a digest this harness computes from the same
    // bytes it just read — the artifact's own claim is not the evidence.
    const versionProbe = await ctx.run(["version"], { timeoutMs: 60_000 });
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const binarySha256 = hasher.digest("hex");
    const reportedId = parseBuildId(versionProbe.stdout);
    ctx.log(attribution(reportedId));
    did.push(
      `ran \`brigadier version\` and hashed the ${bytes.byteLength} bytes this harness timed: sha256 ${binarySha256}. ` +
        `${attribution(reportedId)}`,
    );

    const separator = process.platform === "win32" ? ";" : ":";
    const strippedPath = pathWithout("node");
    const before = (process.env["PATH"] ?? "").split(separator).filter((d) => d.length > 0);
    const after = new Set(strippedPath.split(separator));
    const removed = before.filter((d) => !after.has(d));
    // The strip is verified by the OS before it is trusted.
    const nodeBefore = await resolveNode(process.env["PATH"] ?? "");
    const nodeAfter = await resolveNode(strippedPath);
    ctx.log(`re-running with ${removed.length} PATH entries removed; a shell now resolves node to ${nodeAfter || "nothing"}`);
    const nodeless = await ctx.run(["licenses"], { env: baseEnv({ PATH: strippedPath }), timeoutMs: 30_000 });
    did.push(
      "ran `brigadier licenses` with a PATH from which every directory containing a `node` was removed, " +
        `and asked a shell to confirm it: node resolved to ${nodeBefore || "nothing"} before and ${nodeAfter || "nothing"} after`,
    );

    // ── home A: install, then removal. Nothing else touches this home, so the
    // before/after listings are a statement about brigadier alone.
    const installHome = ensureDir(join(ctx.workdir, "install-home"));
    const homeBeforeInstall = listTree(installHome);
    const install = await probeFeature(ctx, ["install"], {
      env: baseEnv({ HOME: installHome }),
      timeoutMs: 60_000,
    });
    const installedPaths = listTree(installHome);
    const uninstall = await ctx.run(["uninstall"], { env: baseEnv({ HOME: installHome }), timeoutMs: 60_000 });
    const homeAfterUninstall = listTree(installHome);
    const emptyDirsLeft = emptyDirectories(installHome, homeAfterUninstall);
    did.push(
      `installed into a scratch HOME (${installedPaths.length} files appeared), then ran \`brigadier uninstall\` and ` +
        `re-listed it (${homeAfterUninstall.length} files left, ${emptyDirsLeft.length} empty directories)`,
    );

    // ── home B: install, ask the HOST what it sees, then poison a hooks.json.
    const hooksHome = ensureDir(join(ctx.workdir, "hooks-home"));
    await ctx.run(["install"], { env: baseEnv({ HOME: hooksHome }), timeoutMs: 60_000 });
    const hooksPaths = listTree(hooksHome);
    const hookFile = readInstalledHookFile(hooksHome, hooksPaths);

    // `BAR.md`'s own instrument: after install, `claude plugin details brigadier`
    // names PreCompact. It reads the scratch HOME, so nothing of the operator's
    // is consulted or changed.
    const claude = Bun.which("claude");
    const hostDetails =
      claude === null
        ? { available: false, command: "claude plugin details brigadier", code: null as number | null, output: "" }
        : await (async () => {
            const result = await exec([claude, "plugin", "details", "brigadier"], {
              env: baseEnv({ HOME: hooksHome }),
              timeoutMs: 60_000,
            });
            return {
              available: true,
              command: "claude plugin details brigadier",
              code: result.code,
              output: `${result.stdout}${result.stderr}`,
            };
          })();
    did.push(
      hostDetails.available
        ? `asked the HOST itself: \`claude plugin details brigadier\` against the scratch HOME, exit ${hostDetails.code}`
        : "`claude` is not on PATH here, so the host's own view could not be consulted — recorded as unproven rather than passed over",
    );

    // Ruling 60's negative: one unrecognised event beside valid hooks.
    const poisonKey = `notARealEvent-${Math.random().toString(36).slice(2, 8)}`;
    const poisonedPath = join(ensureDir(join(hooksHome, ".claude")), "hooks.json");
    writeFileSync(
      poisonedPath,
      JSON.stringify({ PreCompact: [{ command: "echo ok" }], [poisonKey]: [{ command: "echo no" }] }, null, 2),
    );
    const hooks = await probeFeature(ctx, ["plugin", "hooks"], {
      env: baseEnv({ HOME: hooksHome }),
      timeoutMs: 30_000,
    });
    const poisoned = await ctx.run(["plugin", "hooks", "--check"], {
      env: baseEnv({ HOME: hooksHome }),
      timeoutMs: 30_000,
    });
    did.push(
      `planted a hooks.json carrying one unrecognised event ${JSON.stringify(poisonKey)} at ${poisonedPath} and ran \`brigadier plugin hooks --check\``,
    );

    const checks = judgeArtifact({
      licences: { code: licences.code, stdout: licences.stdout, stderr: licences.stderr },
      full: { code: full.code, stdout: full.stdout, stderr: full.stderr },
      markersFound,
      sizeBytes: statSync(ctx.binary).size,
      versionProbe: { code: versionProbe.code, stdout: versionProbe.stdout, stderr: versionProbe.stderr },
      binarySha256,
      warmMs: warm,
      spawnFloorMs: floor,
      nodeless: { code: nodeless.code, stdout: nodeless.stdout, stderr: nodeless.stderr },
      nodelessPathRemoved: removed,
      nodeOnPath: { before: nodeBefore, after: nodeAfter },
      installProbe: `${install.result.stdout}${install.result.stderr}`,
      installedPaths,
      homeBeforeInstall,
      homeAfterUninstall,
      uninstall: { code: uninstall.code, stdout: uninstall.stdout, stderr: uninstall.stderr },
      emptyDirsLeft,
      hooksProbe: `${hooks.result.stdout}${hooks.result.stderr}`,
      installedHookFile: hookFile,
      hostDetails,
      poisonedHooksProbe: `${poisoned.stdout}${poisoned.stderr}`,
      poisonedHooksCode: poisoned.code,
      poisonKey,
      poisonedPath,
    });

    // Every assertion in this item is about a file on disk or a process that
    // needs no account, so the whole item runs on `BAR.md`'s authoritative CI
    // leg rather than waiting for a credentialed machine.
    return combine(did, checks, { kind: "none" });
  },
};

/**
 * The hook file install wrote, FOUND rather than assumed.
 *
 * The path is discovered from the listing of the scratch home instead of being
 * hard-coded here, so "install stopped writing a hook file" shows up as absence
 * rather than as a harness that reads a path nobody writes any more.
 */
function readInstalledHookFile(home: string, paths: readonly string[]): HookFileEvidence {
  const candidates = paths.filter((p) => p.endsWith("hooks/hooks.json"));
  const first = candidates[0];
  if (first === undefined) return { events: [] };
  let text: string;
  try {
    text = readFileSync(join(home, first), "utf8");
  } catch (error) {
    return { path: first, events: [], problem: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = hookEventsIn(text);
  const notes = [
    ...(parsed.problem === undefined ? [] : [parsed.problem]),
    ...(candidates.length > 1 ? [`${candidates.length} hook files were written: ${candidates.join(", ")}`] : []),
  ];
  return {
    path: first,
    events: parsed.events,
    ...(notes.length === 0 ? {} : { problem: notes.join("; ") }),
  };
}

export default item;
