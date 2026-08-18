// SPDX-License-Identifier: Apache-2.0
/**
 * The run report, sized for whoever is reading it.
 *
 * Ruling 58's governing asymmetry: progress is free when a human reads it and
 * expensive when a model does. In host-first — decision 25's normal case —
 * brigadier's stdout lands in a model's context window and every byte is a
 * permanent charge against the window its owner is working in. So the host
 * report is HARD-CAPPED at `HOST_REPORT_TOKEN_CEILING`, it is O(items) and
 * never O(work), and there is no `--verbose` in host mode for a caller to reach
 * for.
 *
 * The one property that makes the cap safe, stated so a test can hold it:
 *
 *     THE CAP CAN HIDE A SUCCESS AND CAN NEVER HIDE A FAILURE.
 *
 * `capItems` in `budget.ts` implements it — blocking items are never dropped,
 * even when they alone exceed the budget — and this module never gets to
 * choose. Ruling 52 says the same thing from the other end: under space
 * pressure print fewer ITEMS, never fewer CHECKS, and the compact
 * `(approved by codex)` form is banned outright, so every shown item prints
 * every one of its checks with its qualifier inside the result string.
 *
 * NOTHING HERE HANDS A STRING BACK FOR A CALLER TO PRINT (ruling 65). The
 * public entry point is `writeRunReport`, which takes a `Sink` and returns
 * `void`. That is not a style choice: a `render…(): string` is the exact shape
 * that invites a bypass, because the caller then owns the write and the bytes
 * that reach stdout are whatever the caller does with them. The cap below still
 * composes a whole string internally — it has to, because the budget is
 * measured in tokens of the assembled text — and then hands those COMPOSED
 * bytes to the sink, which is ruling 65's order: compose, then redact the final
 * bytes, then write, once.
 *
 * THE RUN-LEVEL LINES ARE O(1) ON PURPOSE. Ruling 59's refused-delegation line
 * is a count for the whole run rather than a note on an item, and that is
 * load-bearing rather than tidy: a note attached to an item that then passed
 * would be the first thing this cap collapsed. Ruling 63's retained clones are
 * the exception that proves it — they are O(retained), and retained only
 * happens when something went wrong, so the cap never reaches them.
 */

import type { Sink } from "../secrets/sink.ts";
import { blocks, type CheckOutcome } from "../work/check.ts";
import { capItems, estimateTokens, HOST_REPORT_TOKEN_CEILING, isCapped, type Audience, type ItemLine } from "./budget.ts";
import { recordPointer, type RecordCheck, type RecordItem, type RunRecord } from "./record.ts";

/** `pass` is the only affirmative glyph. Nothing else resembles a tick. */
const GLYPH: Record<CheckOutcome, string> = {
  pass: "✓",
  fail: "✗",
  error: "!",
  "not-run": "—",
  unconfigured: "—",
};

/**
 * One check, with its qualifier INSIDE the result string.
 *
 * Ruling 52 bans the compact form that reduced v1's output to
 * `(approved by codex)`: a reader who skims must not be able to read a
 * weakened check as a clean one, and a qualifier in a footnote is a qualifier
 * nobody reads.
 */
export function renderRecordCheck(check: RecordCheck): string {
  const qualifier = check.qualifier === undefined ? "" : ` (${check.qualifier})`;
  return `${GLYPH[check.outcome]} ${check.name}: ${check.outcome}${qualifier}`;
}

export function itemBlocks(item: RecordItem): boolean {
  return item.checks.some((check) => check.blocking && blocks(check.outcome));
}

/** One item, with every one of its checks. There is deliberately no `limit` here. */
export function renderItem(item: RecordItem): string {
  const head = [`${item.id}: ${item.status}`];
  if (item.difficulty !== undefined && item.clampedTo !== undefined) {
    head.push(
      item.difficulty === item.clampedTo
        ? `difficulty: ${item.difficulty}`
        : `difficulty: ${item.difficulty} (clamped to ${item.clampedTo})`,
    );
  }
  if (item.agent !== undefined) {
    // `default` would read as a value somebody chose. An absent one is an
    // absent one — ruling 52's rule about a missing result never rendering as a
    // satisfied requirement, one axis over.
    head.push(`(${item.agent}, ${item.model ?? "unrouted"}, ${item.effort ?? "effort NOT recorded"})`);
  }
  // Ruling 55, beside the item rather than in a footnote: a ladder that ran out
  // and a ladder that never had a second step are different facts, and the one
  // that is the machine's rather than the worker's must not be readable as the
  // other. `src/work/ladder.ts` owns the four strings; this only places one.
  if (item.ladder !== undefined) head.push(item.ladder);
  const lines = [`  ${head.join(" — ")}`];
  for (const check of item.checks) lines.push(`      ${renderRecordCheck(check)}`);
  return lines.join("\n");
}

/**
 * The one line an operator reads first, computed from the very checks this
 * report is about to print.
 *
 * `src/integrate/report.ts` has a headline too, and it is computed from the
 * WAVE's item outcomes. That is the right input for `renderRun`, which prints
 * waves, and the wrong one here: a `write` item that committed nothing scores
 * `no-change` in a wave, and `no-change` counts as landed — so a run in which
 * two workers wrote two files, committed neither, published no branch and
 * created no deliverable printed *"2 of 2 items landed"* and exited 0.
 * MEASURED on 2026-08-18 against `git 2.50.1`, with a planted ACP agent that
 * writes and does not commit. The repair is that the headline is derived from
 * the SAME data the reader is shown: an item counts as landed when its status
 * is `integrated` and no check of its blocks, and nothing else does.
 *
 * `runChecks` is in the conjunction for ruling 51's reason: a run whose
 * deliverable branch does not exist has not succeeded, whatever its items say.
 */
export interface HeadlineInput {
  items: readonly RecordItem[];
  /** Ruling 52's own section: "every item passed" is not "the merged result passed". */
  mergedResult: readonly RecordCheck[];
  /** Run-level, and they block in exactly the same way. */
  runChecks?: readonly RecordCheck[];
}

function blocking(checks: readonly RecordCheck[]): RecordCheck[] {
  return checks.filter((check) => check.blocking && blocks(check.outcome));
}

export function runHeadline(input: HeadlineInput): string {
  const total = input.items.length;
  if (total === 0) return "nothing to integrate: this run had no items";

  const landedItems = input.items.filter((item) => item.status === "integrated" && !itemBlocks(item));
  const landed = landedItems.length;
  const gateBlocked = blocking(input.mergedResult);
  const runBlocked = blocking(input.runChecks ?? []);

  // COUNTS, NEVER IDENTITIES. The headline is in `fixedLines`' head, which
  // ruling 58's cap never trims, so a clause per item would be an O(items)
  // string in the one part of the report that cannot shrink — and item 11's bar
  // case is a fifty-item run. Nothing is hidden by that: ruling 52 guarantees
  // every blocking item keeps its own line with every one of its checks, which
  // is where the reason belongs.
  const byStatus = new Map<string, number>();
  for (const item of input.items) {
    if (landedItems.includes(item)) continue;
    byStatus.set(item.status, (byStatus.get(item.status) ?? 0) + 1);
  }
  const reasons: string[] = [];
  for (const [status, count] of byStatus) reasons.push(`${count} ${status}`);
  for (const check of runBlocked) reasons.push(`${check.name}: ${check.outcome}`);
  if (gateBlocked.length > 0) {
    reasons.push(`the merged result is ${gateBlocked.map((gate) => gate.outcome).join(", ")}`);
  }

  if (landed === 0) {
    return `NOTHING INTEGRATED — 0 of ${total} items landed on the integration branch; ${reasons.join("; ")}.`;
  }
  if (landed < total || gateBlocked.length > 0 || runBlocked.length > 0) {
    return (
      `PARTIAL INTEGRATION — ${landed} of ${total} items landed; ${reasons.join("; ")}. ` +
      "This is not a success, and it is not a failure: it is the state the run ended in."
    );
  }
  // A VERIFICATION CLAIM IS DERIVED FROM A `pass` THAT HAPPENED, never from the
  // absence of a failure. Ruling 52's exact bug is an absent result rendering as
  // a satisfied requirement, and this is the line people actually read.
  if (input.mergedResult.some((gate) => gate.outcome === "pass")) {
    return `integrated — ${landed} of ${total} items landed, and the merged result was verified`;
  }
  const why =
    input.mergedResult.length === 0
      ? "no integration gate was recorded for this run"
      : `the merged result is ${input.mergedResult.map((gate) => gate.outcome).join(", ")}`;
  return `${landed} of ${total} items landed, and THE MERGED RESULT WAS NOT VERIFIED — ${why}`;
}

export interface RunReportInput {
  record: RunRecord;
  recordPath: string;
  headline: string;
  /** The merged-result gate, in its own section. Never folded into the item list. */
  mergedResult: readonly RecordCheck[];
  /** Ruling 63: retained clones, with path and bytes. */
  retained?: ReadonlyArray<{ item: number; path: string; bytes: number }>;
  /** Ruling 63: pids brigadier could not confirm dead. Killing them is the only remedy. */
  unconfirmedPids?: readonly number[];
  audience: Audience;
  /** Extra lines a terminal reader gets and a host session does not. */
  detail?: readonly string[];
}

/**
 * Ruling 59, as one run-level line.
 *
 * A count, not a diagnosis. It says how many workers tried; it does not say
 * which sentence in which file persuaded them, because guessing that would mean
 * parsing someone else's conventions file for intent.
 */
export function refusedDelegationLine(count: number): string | null {
  if (count === 0) return null;
  const workers = count === 1 ? "1 worker" : `${count} workers`;
  return `${workers} attempted to delegate and were refused — check the repository's AGENTS.md and the brief (ruling 59).`;
}

/**
 * Ruling 51's deliverable, rendered as it was FOUND.
 *
 * The old line named `record.integrationRef` unconditionally and called it "the
 * deliverable". A run that published nothing therefore printed the name of a
 * branch that did not exist, beside a headline saying its items had landed —
 * and a reader who ran `git switch` on that name got `invalid reference`. The
 * name is what brigadier would write to; `integrationSha` is what `git
 * rev-parse` answered, and only that makes the branch a deliverable.
 */
function branchLine(record: RunRecord): string {
  if (record.integrationSha === undefined) {
    return (
      `NO INTEGRATION BRANCH — ${record.integrationRef} does not resolve in the operator's repository: ` +
      "this run published nothing. Ruling 51's deliverable is a branch `git branch` can see, and a name is not one."
    );
  }
  return (
    `branch ${record.integrationRef} at ${record.integrationSha.slice(0, 12)} — the deliverable, resolved with ` +
    "`git rev-parse`; every other ref brigadier wrote is under refs/brigadier/"
  );
}

/**
 * Ruling 32's run-level half: WHICH review ran, and the catch rate beside it.
 *
 * O(1), which is ruling 58's constraint and also the honest shape — the reviewer
 * choice is a fact about the machine's `PATH`, not about any one item, and a
 * run-level fact attached to an item is the first thing the cap collapses.
 *
 * The two branches are different sentences on purpose. `cross-vendor` and
 * `same-vendor` are not a strong and a weak wording of one outcome; they are two
 * outcomes, and a reader who skims must not be able to read the second as the
 * first. Nothing here renders a weakened check as a pass — that is what the
 * per-item `review:` check line does, with its qualifier inside the result.
 */
export function reviewLines(review: RunRecord["review"]): string[] {
  if (review === undefined) return [];
  const lines = [
    "",
    "review:",
    review.crossVendor
      ? `  CROSS-VENDOR — ${review.reviewerAgent ?? "an unnamed reviewer"} reviewed work built by ` +
        `${review.builderAgent ?? "an unnamed builder"} (ruling 32's preferred shape)`
      : `  SAME-VENDOR — this run's review is WEAKER than the one ruling 32 prefers. ${
          review.sameVendorReason ??
          "No reason was recorded, which is itself a defect: ruling 32 requires the weakening to be STATED."
        }`,
  ];
  if (review.reviewerReruns !== undefined && review.reviewerReruns > 0) {
    lines.push(
      `  ${review.reviewerReruns} reviewer re-run(s), charged to brigadier and NOT to any item's ladder ` +
        "(ruling 52): a broken reviewer is `error`, its remedy is to re-run the reviewer, and a builder " +
        "must not lose a rung of ruling 24's ladder to somebody else's crash.",
    );
  }
  if (review.catchRate !== undefined) lines.push(`  ${review.catchRate}`);
  return lines;
}

function fixedLines(input: RunReportInput): { head: string[]; tail: string[] } {
  const { record } = input;
  const head = [
    input.headline,
    recordPointer(input.recordPath),
    // O(1), and it is the other end of every diff in this run: an item's work is
    // `git diff <base sha>..<item ref>`, which is ruling 51's ownership check and
    // ruling 52's reviewer brief. Without it neither is re-derivable afterwards.
    `base ${record.base.ref} at ${record.base.sha.slice(0, 12)} — every item's diff is <base>..<its ref>`,
    branchLine(record),
  ];

  const tail: string[] = ["", "the merged result:"];
  for (const check of input.mergedResult) {
    tail.push(`  ${renderRecordCheck(check)}`);
    if (check.detail !== undefined && check.outcome !== "pass") tail.push(`      ${check.detail}`);
  }

  const runChecks = record.runChecks ?? [];
  if (runChecks.length > 0) {
    tail.push("", "the run:");
    for (const check of runChecks) {
      tail.push(`  ${renderRecordCheck(check)}`);
      if (check.detail !== undefined && check.outcome !== "pass") tail.push(`      ${check.detail}`);
    }
  }

  for (const clone of input.retained ?? []) {
    tail.push(
      `retained clone item ${clone.item}: ${clone.path} (${clone.bytes} bytes) — not merged, not ` +
        "reviewed, not deleted. It may hold the only copy of that work; `brigadier run` will not " +
        "reclaim it until it is discharged (ruling 63).",
    );
  }
  if ((input.unconfirmedPids ?? []).length > 0) {
    tail.push(
      `could not confirm dead: pid ${(input.unconfirmedPids ?? []).join(", ")} — killing them is the only remedy (ruling 63).`,
    );
  }

  for (const line of reviewLines(record.review)) tail.push(line);

  const refused = refusedDelegationLine(record.refusedDelegations);
  if (refused !== null) tail.push(refused);

  const cost = record.cost;
  if (cost !== undefined) {
    tail.push(
      `cost estimate ${cost.estimateLow.toLocaleString("en-US")} – ${cost.estimateHigh.toLocaleString("en-US")} ` +
        `${cost.currency}${cost.actual === undefined ? "" : `; actual ${cost.actual.toLocaleString("en-US")}`}` +
        `${cost.lowerBound ? " — a LOWER BOUND: a vendor in this run is unpriceable (ruling 70)" : ""}`,
    );
    for (const lever of cost.levers) tail.push(`  lever active: ${lever}`);
    tail.push(
      "  brigadier makes no claim to have saved anything: those are levers that were active, not " +
        "a measurement of what this run would otherwise have cost (ruling 70).",
    );
  }
  return { head, tail };
}

/**
 * Render, capping only where the audience pays for it.
 *
 * The cap is applied by REMOVING PASSING ITEMS, one budget at a time, and the
 * loop stops at the blocking set rather than continuing into it — which is the
 * whole of ruling 52 in three lines of arithmetic.
 */
function composeRunReport(input: RunReportInput): string {
  const { head, tail } = fixedLines(input);
  const lines: ItemLine[] = input.record.items.map((item, index) => ({
    index,
    blocking: itemBlocks(item) || item.status !== "integrated",
    line: renderItem(item),
  }));

  const detail = isCapped(input.audience) ? [] : [...(input.detail ?? [])];
  const assemble = (shown: ItemLine[], collapsed: number): string => {
    const body = shown.map((line) => line.line);
    if (collapsed > 0) {
      body.push(
        `  ${collapsed} passing item(s) collapsed to this count — the cap can hide a success and ` +
          "can never hide a failure (ruling 58)",
      );
    }
    return [...head, ...body, ...tail, ...detail].join("\n");
  };

  if (!isCapped(input.audience)) {
    return assemble(lines, 0);
  }

  const blocking = lines.filter((line) => line.blocking).length;
  for (let budget = lines.length; budget >= Math.max(1, blocking); budget--) {
    const capped = capItems(lines, budget);
    const text = assemble(capped.shown, capped.collapsed);
    if (estimateTokens(text) <= HOST_REPORT_TOKEN_CEILING) return text;
  }
  // Every passing item is already gone and the blocking ones are what is left.
  // Ruling 52 has no exception for space: the report goes over budget rather
  // than dropping a failure, and it says so where the reader will see it.
  const capped = capItems(lines, Math.max(1, blocking));
  return `${assemble(capped.shown, capped.collapsed)}\nthis report is OVER the ${HOST_REPORT_TOKEN_CEILING}-token budget because every remaining item carries a blocking check, and ruling 52 has no exception for space.`;
}

/**
 * Write the report — the only exported way to produce one.
 *
 * Ruling 65's rule 2, and the reason this returns `void`: stdout is a persisted
 * artifact. In decision 25's host-first path it lands in a model's context
 * window and stays there, so the report is exactly the stream the ruling
 * covers, and the only writer that may put it there is the sink. The
 * composition happens first and in full — the cap is arithmetic over the
 * assembled text — and the sink redacts what is actually going out.
 */
export function writeRunReport(input: RunReportInput, sink: Sink): void {
  sink.outLine(composeRunReport(input));
}
