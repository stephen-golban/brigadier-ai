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
 * the transcript this probe assembles: the argv, the exit code, and the bytes on
 * stderr. When the subcommand lands, the same call starts returning `present`
 * and the item's real assertions run without anyone editing this file — which is
 * the property that makes the harness a measuring instrument rather than a
 * to-do list.
 *
 * THE PROBE, AND NOTHING ELSE. Three `BarResult` constructors sat under it —
 * `missingFeature`, `ranAndFailed` and `needsLive` — each wrapping a probe in a
 * pre-worded outcome. Nothing in `bar/`, `scripts/` or `test/` had ever called
 * any of them; every item words its own outcome at the site, where the promise
 * it is failing is in view. They were removed on 2026-08-19 rather than kept as
 * a shape items might one day adopt. The argument above is the part that had to
 * survive, and it is here rather than in a helper nobody reached for.
 */

import type { BarContext, RunOptions, RunResult } from "../types.ts";
import { excerpt } from "./checks.ts";

export interface FeatureProbe {
  /** The subcommand exists AND produced the evidence the caller asked for. */
  present: boolean;
  /**
   * The binary RECOGNISED the subcommand — separate from whether it succeeded.
   *
   * MEASURED on this host on 2026-08-18: item 6 read a `run --review` that
   * exited 1 as "the artifact does not implement this yet", when the exit was a
   * cascade from a fixture defect. The label was wrong in the most expensive
   * direction available: a harness that infers "unbuilt" from a non-zero exit
   * will keep reporting real, observed behaviour as a missing feature, and the
   * reader has no way to tell the two apart from the outcome line. So the two
   * questions are now answered separately — "does this subcommand exist" and
   * "did it do what the item needs" — and an item that has already established
   * existence by other means must judge the failure rather than relabel it.
   */
  recognised: boolean;
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
  // Recognition is about whether the binary KNOWS the subcommand: it neither
  // rejected the name nor fell back to printing its general usage. A command
  // that ran and exited non-zero is recognised — that is a result, not a gap.
  const recognised = !unknown && !usageOnly;
  const evidenced = opts.evidence === undefined ? result.code === 0 && !usageOnly : opts.evidence(result);
  return { present: !unknown && evidenced, recognised, result, transcript };
}
