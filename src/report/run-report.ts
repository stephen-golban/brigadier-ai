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
 * THE RUN-LEVEL LINES ARE O(1) ON PURPOSE. Ruling 59's refused-delegation line
 * is a count for the whole run rather than a note on an item, and that is
 * load-bearing rather than tidy: a note attached to an item that then passed
 * would be the first thing this cap collapsed. Ruling 63's retained clones are
 * the exception that proves it — they are O(retained), and retained only
 * happens when something went wrong, so the cap never reaches them.
 */

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
    head.push(`(${item.agent}, ${item.model ?? "unrouted"}, ${item.effort ?? "default"})`);
  }
  const lines = [`  ${head.join(" — ")}`];
  for (const check of item.checks) lines.push(`      ${renderRecordCheck(check)}`);
  return lines.join("\n");
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

function fixedLines(input: RunReportInput): { head: string[]; tail: string[] } {
  const { record } = input;
  const head = [
    input.headline,
    recordPointer(input.recordPath),
    `branch ${record.integrationRef} — the deliverable; every other ref brigadier wrote is under refs/brigadier/`,
  ];

  const tail: string[] = ["", "the merged result:"];
  for (const check of input.mergedResult) {
    tail.push(`  ${renderRecordCheck(check)}`);
    if (check.detail !== undefined && check.outcome !== "pass") tail.push(`      ${check.detail}`);
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
export function renderRunReport(input: RunReportInput): string {
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
