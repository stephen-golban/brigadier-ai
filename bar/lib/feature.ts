// SPDX-License-Identifier: Apache-2.0
/**
 * "Does the artifact even have this yet?" — asked of the artifact, not assumed.
 *
 * Most of `BAR.md`'s thirteen items describe a product that is not built. The
 * temptation is to mark those items `SKIPPED`, and it has to be refused: ruling
 * 48 makes a `SKIPPED` item block a tag exactly as a `FAIL` does *because* a
 * check that did not run is not a check that passed, and an item that reports
 * `SKIPPED` for "the feature does not exist" would be reporting the release-bar
 * equivalent of a `test.skip`.
 *
 * So an item whose subcommand is missing returns `FAIL`, and the failure carries
 * the transcript: the argv, the exit code, and the bytes on stderr. When the
 * subcommand lands, the same call starts returning `present` and the item's real
 * assertions run without anyone editing this file — which is the property that
 * makes the harness a measuring instrument rather than a to-do list.
 *
 * The one legal `SKIPPED` is below it: an item that genuinely needs vendor
 * credentials, on a run without `--live`. It is reachable only AFTER the feature
 * probe passes, so "unbuilt" can never wear "uncredentialed" as a disguise.
 */

import type { BarContext, BarResult, RunOptions, RunResult } from "../types.ts";
import { excerpt } from "./checks.ts";

export interface FeatureProbe {
  present: boolean;
  result: RunResult;
  /** The argv, exit code and streams, ready to paste into a bug report. */
  transcript: string;
}

/**
 * Run the binary and decide whether the subcommand exists.
 *
 * The decision is made on what the binary actually did, not on a list of known
 * subcommands kept here — a list would go stale silently, which is the exact
 * failure class `scripts/claims.ts` exists to catch elsewhere.
 */
export async function probeFeature(
  ctx: BarContext,
  args: string[],
  opts: RunOptions & { evidence?: (result: RunResult) => boolean } = {},
): Promise<FeatureProbe> {
  const result = await ctx.run(args, opts);
  const transcript =
    `ran \`brigadier ${args.join(" ")}\`; exit ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}` +
    `; stdout: ${excerpt(result.stdout, 200)}; stderr: ${excerpt(result.stderr, 200)}`;
  // A feature is "present" only if there is POSITIVE evidence for it. The
  // previous version decided on the absence of the string "unknown command",
  // which made a binary that printed something plausible and exited 0 convert
  // "the feature does not exist" into a SKIPPED — the exact disguise this file
  // says it prevents. Offline, a printer collected seven of them.
  const unknown = /unknown command/i.test(result.stderr) || /unknown command/i.test(result.stdout);
  const usageOnly = /^\s*brigadier\b[\s\S]*\bbrigadier (detect|agents|licenses)\b/.test(result.stdout);
  const evidenced = opts.evidence === undefined ? result.code === 0 && !usageOnly : opts.evidence(result);
  return { present: !unknown && evidenced, result, transcript };
}

/** The `FAIL` an item returns when the artifact does not implement it yet. */
export function missingFeature(did: string, probe: FeatureProbe, promise: string): BarResult {
  return {
    outcome: "FAIL",
    did,
    observed: probe.transcript,
    reason: `the artifact does not implement this yet — ${promise}. Reported FAIL rather than SKIPPED: ruling 48 makes an unrun check block, and "the feature is missing" is not one of the two legal causes of a skip`,
  };
}

/**
 * The one legal skip: real vendor agents are required and `--live` was not passed.
 *
 * The wording matters and is not decoration. A skip here says only that THIS
 * harness did not drive the feature; it is not a statement that the feature
 * exists, and a reader who takes it as one has been misled by the instrument.
 */
export function needsLive(did: string, observed: string, what: string): BarResult {
  return {
    outcome: "SKIPPED",
    did,
    observed,
    reason:
      `requires real vendor agents (${what}) and --live was not passed. This BLOCKS exactly as a FAIL does — ruling 48. ` +
      "It is NOT evidence that the feature works, or that it exists: nothing was driven",
  };
}
