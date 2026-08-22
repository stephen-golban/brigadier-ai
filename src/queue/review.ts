// SPDX-License-Identifier: Apache-2.0
/**
 * The reviewer: who reads an item's diff, what they are handed, and what a
 * missing verdict costs.
 *
 * Three rulings meet here and each one closes a specific v1 failure.
 *
 * RULING 32 — CROSS-VENDOR IS PREFERRED, NOT REQUIRED. A reviewer of a
 * different vendor is the wanted shape, and the reason is on the record:
 * Anthropic documents models preferring their own output when judging it, so a
 * builder reviewing itself is a weaker check than the same agent reviewing
 * somebody else. But a one-vendor machine is *the common case for a first-time
 * user*, and a product that refuses to start there is a product nobody starts.
 * So review DEGRADES to same-vendor, and the record and the report both say
 * which of the two ran. `crossVendor` is a boolean in the record and
 * `sameVendorReason` is the sentence beside it; the report prints the qualifier
 * INSIDE the result string, never in a footnote (ruling 52).
 *
 * MEASURED on 2026-08-18 against this repository at `gauntlet/build` `0ed0d43`,
 * with `bun 1.3.14` and `git 2.50.1`: `brigadier run --review` exited 1 in
 * 772 ms on a one-vendor `PATH` — not because of the vendor count, but because
 * `--review` was unimplemented and every item carried a blocking
 * `review: not-run`. The refusal was honest about an unbuilt check and it was
 * still a product that could not be run with the flag its own usage advertises.
 *
 * RULING 52 — A REVIEWER THAT PRODUCED NO VERDICT IS `error`, AND `error`
 * BLOCKS. Not `fail`. The two have different remedies and v1 collapsed them:
 * `fail` dispatches the BUILDER to fix a defect that is not in its code, and it
 * spends a rung of ruling 24's ladder doing it. `error` says the CHECKER broke,
 * and the remedy is to re-run the checker — which is why `REVIEWER_RERUNS`
 * exists and why those re-runs are charged to brigadier rather than to the
 * item's ladder. v1 merged its most delicate change on
 * `review: not run (REVIEWER_FAILED)`; here that outcome does not merge.
 *
 * RULING 52's DIFF FRAMING, AND THE ASSUMPTION IT RESTS ON, said out loud. The
 * brief carries `git diff <base>..work` — exact, and free, because the base
 * commit is a fixed reference the record already carries per item (`baseRef`,
 * `baseSha`), so the reviewer's input is re-derivable from the record alone.
 * MEASURED on 2026-08-18 over 119 real commits of v1's own history: the
 * post-state v1 handed its reviewer was 4.8x the diff in aggregate, 3.8x at the
 * median and 301x at the worst commit. That measured the HAYSTACK and not the
 * RECALL. Whether a reviewer given the diff
 * catches more than one given the post-state is a NAMED ASSUMPTION, adopted
 * because the change is free and strictly more information, and bar item 5 is
 * where it is falsified or confirmed in public rather than here.
 *
 * WHAT A REVIEWER IS ASKED TO RETURN, and why it is a machine-readable line
 * rather than prose. The catch rate is published, so it has to be countable;
 * "which defects" has to be identities rather than a count, because a count can
 * be printed by anything and a list of markers generated after the binary was
 * built can only be produced by something that read the diff. Hence
 * `VERDICT {…}` on one line, and `parseVerdict` reading the LAST one in the
 * turn — a model that echoes the template before answering must not have its
 * example read as its answer.
 *
 * AND WHAT BRIGADIER DOES WITH `found`: it keeps only entries that appear
 * VERBATIM IN THE DIFF THE REVIEWER WAS HANDED. That is not distrust of the
 * reviewer's judgement, it is the same rule as everywhere else in this
 * codebase — a claim is recorded when the evidence for it is re-derivable. A
 * marker the diff does not contain was not found in the diff.
 */

import type { ResolvedAgent } from "./admit.ts";
import { rank, type CompetenceRow } from "../router/competence.ts";
import { KNOWN, rows, type Role } from "../router/table.ts";
import type { CheckOutcome, CheckResult } from "../work/check.ts";
import { KIND_CONTRACT, type WorkKind } from "../work/kind.ts";

/**
 * How many times a BROKEN reviewer is re-run before its `error` stands.
 *
 * Ruling 52's budget rule, as a constant with the reason attached: the builder's
 * ladder is charged to the item's budget, and a broken reviewer's re-run is
 * charged to brigadier. A builder must not lose a rung of ruling 24's ladder to
 * somebody else's crash, so nothing in this file may increment an item's
 * `attempts`.
 */
export const REVIEWER_RERUNS = 1;

/**
 * The constant half of a reviewer's brief.
 *
 * Byte-identical for every item, every agent and every run — ruling 16 — and
 * FIRST, because ruling 21 measured a 16.5x prompt-cache lever on a byte-stable
 * prefix. The first line begins with the word `review` deliberately: it is what
 * the brief is, and it is the first thing a model reads.
 */
export const REVIEW_PREFIX = `You are a brigadier reviewer.

review the diff below. You did not write it, you are not being asked to fix it,
and you have no working directory to change: everything you are judging is in
this message.

Report defects in the change itself — logic that does not do what the item asked,
a check that reports success when the thing it checks did not happen, a missing
result rendered as a satisfied requirement, a boundary the change crosses. Do not
report style, and do not report anything you cannot point at in the diff.

Answer with ONE line, last, and nothing after it:

VERDICT {"verdict": "approved", "found": []}

\`verdict\` is "approved" when you found no defect and "rejected" when you found
one or more. \`found\` lists ONE IDENTIFIER PER DEFECT. Where the diff carries an
explicit marker token for a defect, the identifier is that token, copied exactly;
otherwise it is the path and the shortest phrase that names the defect. An
identifier that does not appear in the diff is discarded, so quote rather than
paraphrase.

--- the item ---
`;

/** The item-specific half. Everything that varies lives here and only here. */
export function reviewBriefFor(input: {
  id: string;
  kind: WorkKind;
  paths: readonly string[];
  prompt: string;
  baseRef: string;
  baseSha: string;
  itemRef: string;
  diff: string;
}): string {
  return [
    `id: ${input.id}`,
    `kind: ${input.kind}`,
    `paths the builder declared: ${input.paths.join(", ") || "none"}`,
    "",
    "what the builder was asked to do:",
    input.prompt,
    "",
    `--- git diff ${input.baseSha}..${input.itemRef} ---`,
    `(left-hand side: ${input.baseRef} at ${input.baseSha}; this diff is re-derivable from the run record)`,
    "",
    input.diff.length > 0 ? input.diff : "(the diff is empty: this item changed no tracked file)",
    "--- end diff ---",
    "",
  ].join("\n");
}

export function composeReviewBrief(input: Parameters<typeof reviewBriefFor>[0]): string {
  return `${REVIEW_PREFIX}${reviewBriefFor(input)}`;
}

export interface Verdict {
  verdict: "approved" | "rejected";
  /** Identities, never a count. Filtered against the diff by `caughtIn`. */
  found: string[];
}

/**
 * The first balanced `{…}` after `index`, or `null`.
 *
 * A non-greedy `\{[\s\S]*?\}` stops at the first closing brace, which is wrong
 * the moment a reviewer nests an object inside `found`. Counting braces is not
 * a JSON parser and does not need to be: `JSON.parse` is still the thing that
 * decides, and this only has to hand it the right slice.
 */
function balanced(text: string, index: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(index, i + 1);
    }
  }
  return null;
}

/**
 * The reviewer's verdict, read out of the turn's text.
 *
 * The LAST parseable `VERDICT {…}` wins. A model that restates the template
 * before answering — and they do — must not have its example read as its
 * answer, and taking the last one is the rule that survives that without
 * needing the model to be disciplined.
 *
 * `null` means NO VERDICT, which is ruling 52's `error`. It is deliberately not
 * a lenient parser: "the reviewer said something that might mean approval" is
 * exactly the reading that merged v1's most delicate change.
 */
export function parseVerdict(text: string): Verdict | null {
  let found: Verdict | null = null;
  const marker = /VERDICT\s*(?=\{)/g;
  let match = marker.exec(text);
  while (match !== null) {
    const object = balanced(text, match.index + match[0].length);
    if (object !== null) {
      try {
        const parsed = JSON.parse(object) as { verdict?: unknown; found?: unknown };
        if (parsed.verdict === "approved" || parsed.verdict === "rejected") {
          found = {
            verdict: parsed.verdict,
            found: Array.isArray(parsed.found)
              ? parsed.found.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
              : [],
          };
        }
      } catch {
        // Not JSON. A later, well-formed VERDICT still counts.
      }
    }
    match = marker.exec(text);
  }
  return found;
}

/**
 * The smallest thing in a finding that can be looked for in a diff.
 *
 * A path (`src/retry.ts`), a call or member expression (`[...values].sort()`,
 * `AbortSignal.aborted`), a backticked span, or a compound identifier
 * (`camelCase`, `snake_case`, `SCREAMING_CASE`). Deliberately NOT ordinary
 * words: `missing`, `check` and `between` are prose, they appear in any diff of
 * any size, and counting them would make the rate a measurement of vocabulary.
 */
const IDENTIFIER = /`[^`]+`|[\w./-]*\.[a-z]{1,4}\b|[\w.$[\]]*\.\w+\(\)|\b\w+[_.][\w_.$]+\b|\b[a-z]+[A-Z]\w*\b/g;

/**
 * How specific a token has to be before it may count.
 *
 * Six characters, a judgement, and it is what stops `.ts` or `a.b` counting as a
 * reviewer having read a diff. It is stated here rather than inlined because it
 * is the whole distance between this function and a rate that measures nothing.
 */
const IDENTIFIER_FLOOR = 6;

/** Every distinct identifier-shaped token inside one finding. */
export function identifiersIn(finding: string): string[] {
  const out = new Set<string>();
  for (const match of finding.matchAll(IDENTIFIER)) {
    const token = (match[0] ?? "").replace(/`/g, "").trim();
    if (token.length >= IDENTIFIER_FLOOR) out.add(token);
  }
  return [...out];
}

/**
 * The findings that are actually EVIDENCED BY the diff the reviewer was handed.
 *
 * FOUND, not KNOWN. A reviewer that names a defect the diff does not contain has
 * not read the diff, and recording its claim would make the published catch rate
 * a measurement of a reviewer's confidence. **That property is unchanged and is
 * what the negative control below still asserts.**
 *
 * WHAT CHANGED, and it was measured by a verifier rather than reasoned:
 * this required the WHOLE finding to be literal contiguous text in the diff.
 * MEASURED 2026-08-21 by the second independent verifier, driving five planted
 * defects: two were caught by the reviewer, blocked integration, and were named
 * precisely — `src/retry.ts missing between-attempts abort check` and
 * `src/median.ts [...values].sort()`. **Neither sentence is contiguous text in a
 * diff, because no reviewer writes one that is.** So both were discarded, the
 * automated line read `catch rate 0 of 5`, and the verifier had to score the
 * transcript by hand to find the 2 the product had thrown away.
 *
 * A rate that reports zero when the truth is two is worse than no rate: it is
 * the shape `BAR.md` opens on — a check reporting failure for something that did
 * happen, and it was one of the three live defects that verifier named.
 *
 * **So the unit of matching moves from the SENTENCE to the IDENTIFIERS INSIDE
 * IT**, and the strictness moves with it rather than being spent: a finding
 * counts when at least one identifier-shaped token in it appears verbatim in the
 * diff. A reviewer inventing a defect names nothing the diff carries and still
 * counts for nothing.
 */
export function caughtIn(diff: string, reported: readonly string[]): string[] {
  return [
    ...new Set(
      reported.filter((entry) => {
        // The whole finding, first: it is the strictest possible evidence and
        // costs one comparison.
        if (diff.includes(entry)) return true;
        const identifiers = identifiersIn(entry);
        // A finding with no identifier in it at all is prose — "the retry logic
        // looks wrong" — and prose is not evidence of having read a diff.
        return identifiers.length > 0 && identifiers.some((token) => diff.includes(token));
      }),
    ),
  ];
}

/** At most this many unverified findings are repeated, and at most this many characters each. */
const UNVERIFIED_SHOWN = 3;
const UNVERIFIED_CHARS = 120;

/**
 * What the reviewer said that the diff does not carry: kept OUT of the count and
 * kept IN the record.
 *
 * `caughtIn` above is deliberately strict, and it stays that way — a reviewer
 * naming a defect the diff does not contain has not read the diff, and counting
 * its claim would make the published rate a measurement of confidence. But
 * DISCARDING the claim is a different decision from NOT COUNTING it, and this
 * project had been making both with one line.
 *
 * MEASURED 2026-08-21 by the second independent verifier: two items were blocked
 * on `rejected` verdicts naming `src/retry.ts missing between-attempts abort
 * check` and `src/median.ts [...values].sort()`, both precise and both correct.
 * The operator was told the reviewer named ZERO defects. A blocking verdict whose
 * reason is dropped leaves ruling 24's second rung no better informed than its
 * first, which is the retry spending money to repeat the attempt it just made.
 *
 * Bounded rather than unbounded, because ruling 58 caps the host report and a
 * reviewer's prose is the least predictable thing in it. The count is exact; the
 * quotation is truncated and says so. `OWNER-QUESTIONS.md` #16.
 */
export function unverifiedFindings(caught: readonly string[], reported: readonly string[]): string {
  const counted = new Set(caught);
  const rest = [...new Set(reported.filter((entry) => !counted.has(entry)))];
  if (rest.length === 0) return "";
  const shown = rest
    .slice(0, UNVERIFIED_SHOWN)
    .map((entry) => (entry.length > UNVERIFIED_CHARS ? `${entry.slice(0, UNVERIFIED_CHARS)}…` : entry))
    .map((entry) => `"${entry}"`);
  const more = rest.length > shown.length ? ` (+${rest.length - shown.length} more)` : "";
  return (
    `It also reported ${rest.length} finding(s) the diff does not carry verbatim, NOT counted above and ` +
    `repeated here because a blocking verdict whose reason is discarded leaves the second rung no better ` +
    `informed than the first: ${shown.join("; ")}${more}. `
  );
}

export interface ReviewerChoice {
  /** `null` when nothing on this machine can review. */
  agent: ResolvedAgent | null;
  /** Ruling 32's preferred shape. False is a weakened check, never a missing one. */
  crossVendor: boolean;
  /** Set whenever `crossVendor` is false. Never empty when it is set. */
  sameVendorReason?: string;
}

/**
 * Why a same-vendor review is weaker, in one sentence, on the record.
 *
 * The reason travels with the degradation rather than living in a design
 * document, because the record is what a reader has.
 */
export const SELF_REVIEW_BIAS =
  "Anthropic documents models preferring their own output when judging it, so a builder's own " +
  "vendor reviewing its work is a weaker check than a different vendor reviewing it";

/**
 * Who reviews this item's diff.
 *
 * Ruling 32's preference, made concrete: a vendor that is NOT the builder's
 * first, ranked by the reviewer half of the competence table (ruling 68 — an
 * unranked agent is eligible and sorts last, never silently excluded). Only when
 * there is no such vendor does the builder's own vendor review its own work, and
 * that outcome carries its reason rather than looking like the preferred one.
 */
export function chooseReviewer(
  agents: readonly ResolvedAgent[],
  builder: string | null,
): ReviewerChoice {
  if (agents.length === 0) {
    return {
      agent: null,
      crossVendor: false,
      sameVendorReason:
        "no agent resolved on PATH, so there is nothing to review with. This is not a same-vendor " +
        "review, it is no review at all, and the check that carries it blocks (ruling 52).",
    };
  }

  const ranked = rankReviewers(agents);
  const other = ranked.find((agent) => agent.id !== builder);
  if (other !== undefined) return { agent: other, crossVendor: true };

  const only = ranked[0] as ResolvedAgent;
  return {
    agent: only,
    crossVendor: false,
    sameVendorReason:
      `only ${only.id} is drivable on this machine, so the reviewer is the builder's own vendor. ` +
      `Ruling 32 prefers cross-vendor review and does not require it — ${SELF_REVIEW_BIAS}, so this ` +
      "check ran WEAKENED and is recorded as weakened. It is not a pass with a caveat and it is not " +
      "a reason to refuse the run: a single-vendor machine is the common case for a first-time user.",
  };
}

/** The reviewer half of the competence table, applied to what is actually on PATH. */
export function rankReviewers(agents: readonly ResolvedAgent[]): ResolvedAgent[] {
  const role: Role = "reviewer";
  const order = rank(
    rows().filter((row) => row.role === role),
    KNOWN,
  ).map((row: CompetenceRow) => row.agent);
  return [...agents].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
  });
}

export interface ReviewOutcome {
  outcome: CheckOutcome;
  crossVendor: boolean;
  sameVendorReason?: string;
  reviewer: string | null;
  /** Charged to brigadier, never to the item's ladder (ruling 52). */
  reviewerAttempts: number;
  caught: string[];
  detail: string;
  qualifier: string;
}

/** A `read-only` item has no diff, so ruling 32's rule has nothing to apply to. */
export function reviewApplies(kind: WorkKind): boolean {
  return KIND_CONTRACT[kind].crossVendorReview;
}

/**
 * The check a `read-only` item gets.
 *
 * `unconfigured` rather than `not-run`: ruling 52 separates "never configured,
 * so there is no check" from "never started". Nothing was skipped here — there
 * is no diff to review, by the definition of the kind — and it prints in the
 * same slot with the same prominence either way.
 */
export function notReviewable(kind: WorkKind): CheckResult {
  return {
    name: "review",
    outcome: "unconfigured",
    qualifier: `${kind}: nothing to review`,
    detail:
      "ruling 49 never diffs, merges or reads back a read-only item's directory, so there is no " +
      "diff for a reviewer to be handed. Ruling 32's cross-vendor rule is a `write`-only rule.",
  };
}

/** Ruling 52: the qualifier lives INSIDE the result string, never in a footnote. */
export function reviewQualifier(choice: { crossVendor: boolean }, reviewer: string | null, builder: string | null): string {
  if (reviewer === null) return "no reviewer";
  return choice.crossVendor
    ? `cross-vendor: ${reviewer} reviewed ${builder ?? "an unnamed builder"}`
    : `SAME-VENDOR: ${reviewer} reviewed its own vendor's work`;
}

/**
 * The published rate, as a line the report prints whether or not it is good.
 *
 * v1's measured baseline is printed beside it on purpose. A rate with nothing to
 * compare it against is a number; a rate beside the number it replaced is an
 * argument somebody can have.
 */
export const V1_CATCH_BASELINE = "0 of 3";

export function catchRateLine(caught: number, planted: number | undefined): string {
  if (planted === undefined) {
    return (
      `reviewers reported ${caught} defect(s) present in the diffs they were handed. No --planted ` +
      "count was given, so there is no rate: a catch rate needs a denominator somebody else chose."
    );
  }
  return (
    `catch rate ${caught} of ${planted} — defects the reviewers named AND that appear in the diff ` +
    `they were handed, against ${planted} planted. v1's measured baseline is ${V1_CATCH_BASELINE}. ` +
    "Published, not gated: review is probabilistic, a flaky blocking check gets disabled, and a " +
    "published number gets argued with. " +
    // WHAT THE NUMERATOR IS, printed with it rather than known by its author.
    // `caughtIn` keeps DISTINCT identifiers that appear verbatim in the diff; it
    // does not match them to the planted list, and nothing here can. So a
    // reviewer quoting three lines of one defect counts three, a reviewer
    // describing a real defect in prose the diff does not carry counts zero,
    // and the numerator is not bounded by the denominator. The reader needs
    // that sentence attached to the digits, because the digits are what gets
    // quoted: a bar-harness run published `0 of 5` on 2026-08-19 that was a
    // fact about which vendor a fixture was configured on.
    `The numerator counts DISTINCT identifiers the reviewers quoted that the diff really contains; it is ` +
    `not matched to the ${planted} planted defects, so it can exceed them, and a defect named only in prose ` +
    "the diff does not carry is discarded. Whether a finding is one of the planted defects is a judgement, " +
    "and it belongs to whoever planted them."
  );
}
