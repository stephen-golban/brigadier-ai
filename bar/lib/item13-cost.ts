// SPDX-License-Identifier: Apache-2.0
/**
 * Item 13's deep half: the fields amendment §19 says were declared and never
 * written, and the two ceilings, judged as two EVENTS rather than as two words.
 *
 * Three things in the item this file exists to repair.
 *
 * ONE — THE EFFORT LANDMINE. `effort` was declared in the record, read by the
 * reporter and assigned by nothing, so ruling 29's "triple" was a pair for as
 * long as the record existed and the reporter printed the absence without
 * noticing. It is now derived from (kind, difficulty) per ruling 31, capped at
 * `high` per ruling 30 and applied to each profile's real lever per ruling 40.
 * A check that reads the field and stringifies it CANNOT NOTICE THE REGRESSION:
 * `${undefined}` is the five characters `undefined` and a containment test is
 * satisfied by them. So nothing here trusts the field's presence — the value is
 * required to be a member of a vocabulary, and the requested grade is
 * RECOMPUTED from the two facts ruling 31 derives it from and compared.
 *
 * TWO — WHAT `effortConfirmed` MAY BE. #45 measured that neither vendor's
 * effort setting is confirmable over the protocol, so the field is typed as the
 * literal `false` rather than as a boolean that happens to be false. A harness
 * that only checked "it is not true today" would pass the day it becomes a
 * boolean, which is the day the claim becomes writable.
 *
 * THREE — THE TWO CEILINGS. `/soft/i.test(report) && /hard/i.test(report)` is
 * satisfied by a report that says *"soft and hard ceilings: not implemented"*,
 * and by the weakened-gap warning, which is ONE line carrying both words and
 * the word `cancel` as well. The soft ceiling and the hard one are told apart
 * here by driving the same plan twice with ceilings calibrated to make each of
 * them fire, and asserting on what DIFFERS: one run stops dispatching and
 * leaves items `unrun`, the other cancels work already running and leaves items
 * `cancelled`. The gap warning is excised by the record's own copy of it before
 * anything is read, so the instrument is not fooled by the sentence that
 * describes both ceilings at once.
 *
 * The ceilings are calibrated from a run that already happened rather than
 * picked, and that is not a nicety. THE UNIT IS TOKENS, NOT MONEY
 * (`src/queue/estimate.ts` refuses currency for want of a measured rate), and
 * the item used to pass `--soft-ceiling 0.06 --hard-ceiling 0.14` — a pair that
 * both ceilings cross on the first frame that crosses the wire. Nothing is
 * dispatched, nothing records a triple, no vendor appears in the quota block,
 * and every one of those checks fails for a reason that has nothing to do with
 * the property it names.
 */

import { Checks, excerpt } from "./checks.ts";
import type { RunRecord } from "./contract.ts";

/** Ruling 30's vocabulary. `max` and `ultra` are absent rather than filtered. */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
export type EffortGrade = (typeof EFFORT_ORDER)[number];

/** Ruling 30: hard, across every vendor. Only the operator's own flag moves it. */
export const EFFORT_CEILING: EffortGrade = "high";

/** Ruling 40: a vendor with no measured lever says so, and says it in these words. */
export const NO_LEVER = "none measured";

/**
 * The effort half of the record, DELIBERATELY WEAKER than `RecordCheck`'s
 * sibling in `bar/lib/contract.ts`.
 *
 * The contract now carries all four effort fields — the reconciliation pass put
 * them there, and this interface is no longer covering a gap. It stays because
 * it is a different kind of statement: the contract says what the product
 * PROMISES, and these fields say what this item is willing to BELIEVE about a
 * record it parsed out of untrusted JSON. Typing them `unknown` is what forces
 * every read through `stated()` below, so a product that emitted `null`, a
 * number, or the string `"undefined"` is caught rather than printed. A record
 * that satisfies `RecordItem` satisfies this too, which is the only direction
 * that has to hold.
 */
export interface EffortItem {
  id: string;
  status?: string;
  kind?: string;
  agent?: string;
  model?: string;
  /** The rendered value, qualifier inside. */
  effort?: unknown;
  /** Ruling 31's derivation. The machine-readable half. */
  effortRequested?: unknown;
  /** Ruling 40: the vendor's real lever, or `none measured`. */
  effortLever?: unknown;
  effortDisposition?: unknown;
  /** #45: the literal `false`, and there is no value that may imply otherwise. */
  effortConfirmed?: unknown;
  difficulty?: string;
  clampedTo?: string;
}

/**
 * A value that is really there, as opposed to one that was stringified on its
 * way out.
 *
 * `undefined` and `null` reach a record as the words `undefined` and `null` the
 * moment anything renders them, and a check that reads the field and prints it
 * cannot tell those from a value. This is the whole of amendment §19's warning
 * in one function.
 */
export function stated(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (/^(undefined|null|nan)$/i.test(text)) return undefined;
  return text;
}

function stepDown(grade: EffortGrade): EffortGrade {
  return EFFORT_ORDER[Math.max(0, EFFORT_ORDER.indexOf(grade) - 1)] ?? grade;
}

/**
 * Ruling 31's derivation, recomputed by the harness from the two facts it is
 * derived from.
 *
 * Transcribed with the same discipline as `contract.ts`: the point of
 * recomputing is that a product which stopped deriving — or started taking the
 * value from the plan, which ruling 31 forbids — produces a number this
 * function does not.
 *
 * `difficulty` is the CLAMPED one where a clamp happened, because that is what
 * the item will actually get, and ruling 49's read-only step-down is applied
 * afterwards: an item nobody diffs, merges or reads back cannot have a more
 * expensive attempt checked, so paying for one buys an unverifiable answer.
 */
export function expectedEffort(kind: string | undefined, difficulty: string | undefined): EffortGrade {
  const base: Record<string, EffortGrade> = { easy: "low", medium: "medium", hard: "high" };
  const asked = base[difficulty ?? "medium"] ?? "medium";
  const stepped = kind === "read-only" ? stepDown(asked) : asked;
  return EFFORT_ORDER.indexOf(stepped) > EFFORT_ORDER.indexOf(EFFORT_CEILING) ? EFFORT_CEILING : stepped;
}

/**
 * The report's own line for one item, anchored at its id.
 *
 * FOUND BY WRITING THE NEGATIVE CONTROL, on 2026-08-19. The triple check below
 * asked `report.includes("(qwen, qwen-m, medium …)")`, and every item in this
 * item's plan runs on the same vendor at the same grade — so ONE printed triple
 * satisfied the test for ALL FOUR items, and a product that printed the triple
 * for one item and dropped it for the rest passed. That is the same
 * whole-report containment defect this audit removed from item 11, reintroduced
 * by its own repair one file over.
 *
 * `undefined` when the report never gives the item a line of its own, which is
 * a different failure from "the line is there and says the wrong thing" and
 * must not render as the same one.
 */
export function itemLine(report: string, id: string): string | undefined {
  const anchor = new RegExp(`^\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s`);
  return report.split("\n").find((line) => anchor.test(line));
}

export interface EffortObservations {
  report: string;
  items: readonly EffortItem[];
  /**
   * The vendors this harness planted, none of which has a measured effort
   * lever.
   *
   * Owned by the harness, never read back out of the record: "the record says
   * the lever is `none measured` for the vendors the record says ran" is a
   * sentence that can be true of a record and false of the world.
   */
  leverlessVendors: readonly string[];
}

export function judgeEffort(o: EffortObservations): Checks {
  const checks = new Checks();
  const dispatched = o.items.filter((item) => item.status === "integrated" || item.status === "failed");

  // 1. THE TRIPLE, WITH A THIRD MEMBER THAT IS A VALUE. Not "the field is not
  //    `undefined`" — a member of ruling 30's vocabulary.
  const badGrade = dispatched.filter((item) => {
    const grade = stated(item.effortRequested);
    return grade === undefined || !(EFFORT_ORDER as readonly string[]).includes(grade);
  });
  checks.expect(
    "every dispatched item records an effort that is a VALUE, not a stringified absence (ruling 29)",
    dispatched.length > 0 && badGrade.length === 0,
    dispatched.length === 0
      ? "nothing was dispatched, so there is no triple to record — the ceilings, not the triple, are what this measures"
      : `${dispatched.length} dispatched; not one of ${EFFORT_ORDER.join("/")}: ${
          badGrade.map((i) => `${i.id}=${JSON.stringify(i.effortRequested)}`).join(", ") || "none"
        }. \`effort: undefined\` renders as the word \`undefined\`, and amendment §19 is that regression`,
  );

  // 2. RULING 31, RECOMPUTED. A field that is present and wrong is the same
  //    defect as a field that is absent, one step later.
  const misderived = dispatched
    .map((item) => ({ item, want: expectedEffort(item.kind, item.clampedTo ?? item.difficulty) }))
    .filter(({ item, want }) => stated(item.effortRequested) !== want);
  checks.expect(
    "the recorded effort is what ruling 31 DERIVES from (kind, difficulty), never something else",
    dispatched.length > 0 && misderived.length === 0,
    dispatched
      .map(
        (i) =>
          `${i.id}: (${i.kind ?? "no kind"}, ${i.clampedTo ?? i.difficulty ?? "no difficulty"}) -> expected ${expectedEffort(
            i.kind,
            i.clampedTo ?? i.difficulty,
          )}, recorded ${JSON.stringify(i.effortRequested)}`,
      )
      .join("; ") || "nothing dispatched",
  );

  // 3. RULING 30's CEILING. Nothing here asked for `xhigh`, so nothing may have it.
  const overCeiling = dispatched.filter((item) => {
    const grade = stated(item.effortRequested);
    return grade !== undefined && EFFORT_ORDER.indexOf(grade as EffortGrade) > EFFORT_ORDER.indexOf(EFFORT_CEILING);
  });
  checks.expect(
    `no item exceeds ruling 30's \`${EFFORT_CEILING}\` ceiling — this run asked for no edge case`,
    overCeiling.length === 0,
    overCeiling.map((i) => `${i.id}=${String(i.effortRequested)}`).join(", ") ||
      `every dispatched item is at or below ${EFFORT_CEILING}`,
  );

  // 4. RULING 40's LEVER, against the vendors the HARNESS planted.
  const leverless = dispatched.filter((item) => o.leverlessVendors.includes(item.agent ?? ""));
  const wrongLever = leverless.filter((item) => stated(item.effortLever) !== NO_LEVER);
  checks.expect(
    `a vendor with no measured effort lever records \`${NO_LEVER}\` (ruling 40)`,
    leverless.length > 0 && wrongLever.length === 0,
    leverless.length === 0
      ? `no dispatched item ran on one of the planted vendors (${o.leverlessVendors.join(", ")}), so ruling 40's ` +
        "absent-lever case was never reached — which means this run did not measure it"
      : `${leverless.length} item(s) on ${o.leverlessVendors.join("/")}; lever not \`${NO_LEVER}\`: ${
          wrongLever.map((i) => `${i.id}=${JSON.stringify(i.effortLever)}`).join(", ") || "none"
        }. Absent is not zero and it is not default-is-fine`,
  );

  // 5. #45. `false` and nothing else — including nothing.
  const confirmed = dispatched.filter((item) => item.effortConfirmed !== false);
  checks.expect(
    "`effortConfirmed` is the literal `false` on every dispatched item (#45)",
    dispatched.length > 0 && confirmed.length === 0,
    confirmed.map((i) => `${i.id}=${JSON.stringify(i.effortConfirmed)}`).join(", ") ||
      "every dispatched item records `false`, which is the only value #45 leaves available: neither vendor's " +
        "setting is confirmable over the protocol, so there is no way to earn a `true`",
  );

  // 6. AND IT IS PRINTED. Ruling 29's triple is a promise to the operator, not
  //    a field in a file nobody opens.
  // ON THE ITEM'S OWN LINE, never anywhere in the report: every item here runs
  // on the same vendor at the same grade, so a whole-report containment test is
  // satisfied for all of them by one printed triple.
  const unprinted = dispatched.filter((item) => {
    const line = itemLine(o.report, item.id);
    return line === undefined || !line.includes(`(${item.agent ?? ""}, ${item.model ?? ""}, ${String(item.effort ?? "")})`);
  });
  checks.expect(
    "the report prints each dispatched item's triple, with the effort inside it (ruling 29)",
    dispatched.length > 0 && unprinted.length === 0,
    unprinted
      .map(
        (i) =>
          `${i.id}: expected \`(${i.agent}, ${i.model}, ${String(i.effort)})\` on its own line, found ${
            itemLine(o.report, i.id) === undefined ? "no line for that item at all" : `\`${itemLine(o.report, i.id)?.trim()}\``
          }`,
      )
      .join("; ") || `${dispatched.length} triple(s) found, each on its own item's line`,
  );

  return checks;
}

/**
 * The instrument, put to a case it must fail and a case it must pass, EVERY
 * RUN.
 *
 * This is not a unit test that lives somewhere else and might not have been
 * run. Amendment §19's field was absent for as long as the record existed
 * because everything that looked at it printed what it found; the cheapest
 * insurance against repeating that is for the item itself to demonstrate, in
 * its own output, that its reader rejects the shape that got through last time.
 */
export function effortInstrumentControls(): Checks {
  const checks = new Checks();
  const good: EffortItem = {
    id: "control-good",
    status: "integrated",
    kind: "write",
    agent: "qwen",
    model: "m",
    effort: "medium (set, NOT confirmed — #45)",
    effortRequested: "medium",
    effortLever: NO_LEVER,
    effortConfirmed: false,
  };
  const report = `  control-good: integrated — (qwen, m, ${String(good.effort)})`;
  const control = (items: EffortItem[], text = report): number =>
    judgeEffort({ report: text, items, leverlessVendors: ["qwen"] }).failures.length;

  checks.expect(
    "the effort reader ACCEPTS a correctly recorded triple (the positive control)",
    control([good]) === 0,
    `a fully recorded item produced ${control([good])} failure(s); a reader that fails everything is not a reader`,
  );
  const absent: EffortItem = { ...good };
  delete absent.effort;
  delete absent.effortRequested;
  checks.expect(
    "the effort reader REJECTS amendment §19's shape: the field declared and never assigned",
    control([absent]) > 0,
    `an item with no \`effort\` and no \`effortRequested\` produced ${control([absent])} failure(s)`,
  );
  checks.expect(
    "the effort reader REJECTS the stringified absence — the word `undefined` in the field",
    control([{ ...good, effortRequested: "undefined", effort: "undefined" }]) > 0,
    `\`effortRequested: "undefined"\` produced ${control([{ ...good, effortRequested: "undefined" }])} failure(s); a ` +
      "check that stringifies the field prints these nine characters and passes",
  );
  checks.expect(
    "the effort reader REJECTS a confirmation #45 says nobody can earn",
    control([{ ...good, effortConfirmed: true }]) > 0,
    `\`effortConfirmed: true\` produced ${control([{ ...good, effortConfirmed: true }])} failure(s)`,
  );
  checks.expect(
    "ruling 31's derivation is recomputed, not copied: (write, hard)→high, (read-only, hard)→medium, (write, easy)→low",
    expectedEffort("write", "hard") === "high" &&
      expectedEffort("read-only", "hard") === "medium" &&
      expectedEffort("write", "easy") === "low" &&
      expectedEffort("write", undefined) === "medium",
    `write/hard=${expectedEffort("write", "hard")}, read-only/hard=${expectedEffort("read-only", "hard")}, ` +
      `write/easy=${expectedEffort("write", "easy")}, write/undeclared=${expectedEffort("write", undefined)}`,
  );
  return checks;
}

// ---------------------------------------------------------------- ceilings

type Cost = NonNullable<RunRecord["cost"]> & { gapWarning?: string };

/** Every line about a ceiling, with the weakened-gap warning taken out first. */
export function ceilingLines(report: string, record: RunRecord | undefined): string[] {
  const warning = (record?.cost as Cost | undefined)?.gapWarning;
  const text = typeof warning === "string" && warning.length > 0 ? report.split(warning).join(" ") : report;
  return text.split("\n").filter((line) => /ceiling/i.test(line));
}

export interface OneRun {
  what: string;
  report: string;
  record: RunRecord | undefined;
  exitCode: number | null;
}

/**
 * WHAT THIS FILE TAKES ON TRUST, stated because the alternative is a reader
 * assuming otherwise.
 *
 * The calibration number is the product's own `cost.actual`, measured by the
 * same wire-byte counter that `Spend` compares against the ceilings. Nothing
 * here corroborates that counter from outside — no independent byte count, no
 * vendor accounting (#46 measured three of six agents emitting no usage at
 * all). So the ACCOUNTING is taken on trust and the ENFORCEMENT BEHAVIOUR is
 * genuinely observed: whether items were dispatched, whether running work was
 * cancelled, and which of the two the report described are answered from item
 * statuses and git-confirmed integrations, none of which the counter touches.
 * A product that miscounted bytes but honoured its ceilings passes this; a
 * product that counted perfectly and ignored them fails.
 */
export interface CeilingObservations {
  /** No ceilings at all. The negative control: neither line may print. */
  uncapped: OneRun;
  /** Calibrated so the SOFT ceiling stops dispatch and the hard one does not fire. */
  soft: OneRun;
  /** Calibrated so the HARD ceiling fires while items are running. */
  hard: OneRun;
}

function statuses(run: OneRun): string {
  return (run.record?.items ?? []).map((i) => `${i.id}=${i.status}`).join(", ") || "no record";
}

/**
 * Which of the two things happened when a ceiling did not fire, said in words
 * rather than left to the reader.
 *
 * #44 measured 15× between two identical runs, and this item calibrates run 2
 * and run 3 from what run 1 spent. So a ceiling that did not fire has two
 * possible causes with opposite remedies — THE CEILING WAS NOT ENFORCED, which
 * is a product defect, or THE CEILING WAS NEVER REACHED, which is this run
 * spending less than the one it was calibrated from — and a message that
 * conflates them sends the reader to the wrong half. The numbers separate
 * them: a run whose own `actual` is at or above its ceiling and did not fire
 * was not enforced; one below it never got there.
 */
function whyNotFired(run: OneRun, ceiling: number | undefined): string {
  const spent = run.record?.cost?.actual;
  if (ceiling === undefined) return "no ceiling of this kind was given to that run";
  if (spent === undefined) return `the run recorded no spend at all, so neither reading is available (ceiling ${ceiling})`;
  return spent >= ceiling
    ? `NOT ENFORCED: the run spent ${spent} against a ceiling of ${ceiling} and the ceiling did not fire`
    : `NEVER REACHED: the run spent ${spent}, under its ${ceiling} ceiling — this is the calibration missing, not the ` +
      "product ignoring a ceiling. #44 measured 15× between two identical runs, and the number this pair was " +
      "calibrated from came from an earlier one";
}

export function judgeCeilings(o: CeilingObservations): Checks {
  const checks = new Checks();
  const softCost = o.soft.record?.cost;
  const hardCost = o.hard.record?.cost;
  const uncappedCost = o.uncapped.record?.cost;

  // THE NEGATIVE CONTROL. A ceiling line that printed on every run would be
  // wallpaper, and an operator would stop reading it at exactly the point it
  // started being true.
  const uncappedLines = ceilingLines(o.uncapped.report, o.uncapped.record);
  checks.expect(
    "a run with NO ceilings records neither as hit and prints no ceiling event (the negative control)",
    uncappedCost !== undefined &&
      uncappedCost.softCeilingHit !== true &&
      uncappedCost.hardCeilingHit !== true &&
      uncappedLines.length === 0,
    `record: softCeilingHit=${uncappedCost?.softCeilingHit}, hardCeilingHit=${uncappedCost?.hardCeilingHit}; ` +
      `ceiling lines in a report that had no ceilings: ${uncappedLines.map((l) => excerpt(l, 80)).join(" | ") || "none"}`,
  );

  // THE SOFT CEILING: new dispatch stops, work in flight finishes. Its
  // signature is an item that was never given a directory, and NO cancellation.
  const softItems = o.soft.record?.items ?? [];
  const softStopped = softItems.some((i) => i.status === "unrun");
  const softCancelled = softItems.filter((i) => i.status === "cancelled");
  const softSaid = ceilingLines(o.soft.report, o.soft.record);
  checks.expect(
    "the SOFT ceiling stopped new items being DISPATCHED and cancelled nothing (ruling 66)",
    softCost?.softCeilingHit === true &&
      softCost.hardCeilingHit === false &&
      softStopped &&
      softCancelled.length === 0 &&
      softSaid.some((line) => /dispatch/i.test(line)),
    `softCeilingHit=${softCost?.softCeilingHit}, hardCeilingHit=${softCost?.hardCeilingHit}; statuses: ${statuses(o.soft)}; ` +
      `ceiling lines (the weakened-gap warning excised): ${softSaid.map((l) => excerpt(l, 100)).join(" | ") || "none"}` +
      (softCost?.softCeilingHit === true ? "" : `. ${whyNotFired(o.soft, softCost?.softCeiling)}`),
  );
  checks.expect(
    "and it did NOT report cancelling work that was already running",
    softSaid.every((line) => !/cancel/i.test(line)),
    softSaid.filter((line) => /cancel/i.test(line)).map((l) => excerpt(l, 120)).join(" | ") ||
      "no ceiling line in the soft run mentions cancellation, which is the hard ceiling's verb and not this one's",
  );

  // THE HARD CEILING: work already running is cancelled. Its signature is an
  // item that was in flight and stopped — a different status and a different verb.
  const hardItems = o.hard.record?.items ?? [];
  const hardCancelled = hardItems.filter((i) => i.status === "cancelled");
  const hardSaid = ceilingLines(o.hard.report, o.hard.record);
  checks.expect(
    "the HARD ceiling CANCELLED work already running, and says so (ruling 66)",
    hardCost?.hardCeilingHit === true && hardCancelled.length > 0 && hardSaid.some((line) => /cancel/i.test(line)),
    `hardCeilingHit=${hardCost?.hardCeilingHit}; statuses: ${statuses(o.hard)}; ` +
      `ceiling lines: ${hardSaid.map((l) => excerpt(l, 100)).join(" | ") || "none"}` +
      (hardCost?.hardCeilingHit === true ? "" : `. ${whyNotFired(o.hard, hardCost?.hardCeiling)}`),
  );

  // AND THE TWO ARE TOLD APART. Asserted as a difference between two runs
  // rather than as two words in one report, because `/soft/ && /hard/` is
  // satisfied by "soft and hard ceilings: not implemented".
  const onlyHard = hardSaid.filter((line) => !softSaid.includes(line));
  const onlySoft = softSaid.filter((line) => !hardSaid.includes(line));
  checks.expect(
    "the report DISTINGUISHES the two: the same plan under each ceiling reads differently",
    onlyHard.length > 0 &&
      (o.soft.record?.items ?? []).some((i) => i.status === "unrun") &&
      hardCancelled.length > 0,
    `lines the hard run printed and the soft one did not: ${onlyHard.map((l) => excerpt(l, 90)).join(" | ") || "NONE"}; ` +
      `lines only the soft run printed: ${onlySoft.map((l) => excerpt(l, 90)).join(" | ") || "none"}. ` +
      "An operator has to be able to tell an item that was never started from one that was killed halfway",
  );

  return checks;
}

// ------------------------------------------------------- quota and levers

export interface DeepCostObservations {
  report: string;
  record: RunRecord | undefined;
  /** The vendors the harness planted on this run's PATH. Owned, not read back. */
  plantedVendors: readonly string[];
  /** Ruling 70's detector, passed in so there is one copy of it. */
  savingsClaims: (report: string) => string[];
}

/** Both renderings of a number, because the product writes one and JSON holds the other. */
function numberForms(value: number): string[] {
  return [...new Set([String(value), value.toLocaleString("en-US")])];
}

export function judgeDeepCost(o: DeepCostObservations): Checks {
  const checks = new Checks();
  const cost = o.record?.cost;

  // ACTUAL AGAINST PREDICTED, asserted on the NUMBERS. `/actual/i` is a word,
  // and a report that says "actual: not measured" contains it.
  const actual = cost?.actual;
  const printed = (value: number | undefined): boolean =>
    value !== undefined && numberForms(value).some((form) => o.report.includes(form));
  checks.expect(
    "the report prints the actual spend and both ends of the predicted range, as numbers",
    actual !== undefined && printed(actual) && printed(cost?.estimateLow) && printed(cost?.estimateHigh),
    `actual ${actual ?? "ABSENT from the record"} printed: ${printed(actual)}; range ${cost?.estimateLow ?? "?"} – ` +
      `${cost?.estimateHigh ?? "?"} printed: ${printed(cost?.estimateLow)}/${printed(cost?.estimateHigh)} ` +
      `(${cost?.currency ?? "no unit"})`,
  );
  // The comparison itself, which the deleted `/actual/i` row carried: a run
  // that spent more than its own upper bound has an estimate that predicted
  // nothing. Only the upper end is a bound — a ceiling that stopped the run
  // early legitimately lands under `estimateLow`, and requiring otherwise would
  // fail the enforcement this item exists to prove.
  checks.expect(
    "the actual spend is at or below the predicted UPPER bound (ruling 66)",
    actual !== undefined && cost?.estimateHigh !== undefined && actual >= 0 && actual <= cost.estimateHigh,
    `actual ${actual ?? "ABSENT"} against an upper bound of ${cost?.estimateHigh ?? "?"} ${cost?.currency ?? ""}. ` +
      "Below the lower end is not a defect here: a ceiling that stopped dispatch early is the run costing less than " +
      "a plan-shaped prediction, which is ruling 66 working",
  );

  // QUOTA FOR EVERY VENDOR THE HARNESS PUT ON PATH — not for the vendors the
  // record chose to mention. Ruling 13: never absent, never optimistic.
  const quota = cost?.quota ?? {};
  const legal = ["read", "unreadable", "unpriceable"];
  const missing = o.plantedVendors.filter((vendor) => !legal.includes(quota[vendor] ?? ""));
  checks.expect(
    "quota is reported for every vendor this run could have used, as read / unreadable / unpriceable",
    o.plantedVendors.length > 0 && missing.length === 0,
    `planted on PATH: ${o.plantedVendors.join(", ")}; quota block: ${JSON.stringify(quota)}; ` +
      `absent or not one of the three: ${missing.join(", ") || "none"}`,
  );
  // #42: opencode was PLANTED by this harness, so the branch is exercised
  // rather than skipped past. The previous form — `!used.includes("opencode")
  // || …` — was true on every run this item has ever driven, because opencode
  // was never in the fleet.
  const usedOpencode = o.plantedVendors.includes("opencode");
  checks.expect(
    "opencode is `unpriceable` and the run's total is a LOWER BOUND (#42)",
    usedOpencode && quota["opencode"] === "unpriceable" && cost?.lowerBound === true,
    `opencode planted: ${usedOpencode}; quota: ${quota["opencode"] ?? "ABSENT"}; lowerBound: ${cost?.lowerBound}. ` +
      "#42 measured opencode reaching a model with NO credential at all through its own gateway, so a successful " +
      "turn proves nothing about which account was billed",
  );

  // RULING 70. The levers are named, every one of them reaches the report, and
  // no line that carries a measured multiplier reads as a saving.
  const levers = cost?.levers ?? [];
  const unprinted = levers.filter((lever) => !o.report.includes(lever));
  checks.expect(
    "every lever the record lists is printed in the report, by name (ruling 70)",
    levers.length > 0 && unprinted.length === 0,
    levers.length === 0
      ? "the record lists NO lever, so `the levers that were active are listed` is satisfied by an empty list — " +
        "which is the count-shaped hole this check exists to close"
      : `${levers.length} lever(s): ${levers.map((l) => excerpt(l, 70)).join(" | ")}; absent from the report: ${
          unprinted.map((l) => excerpt(l, 70)).join(" | ") || "none"
        }`,
  );
  const multipliers = o.report.split("\n").filter((line) => /\d+(?:\.\d+)?\s*(?:×|x)\b/.test(line));
  const claimed = o.savingsClaims(o.report);
  checks.expect(
    "a line carrying a measured multiplier cannot be read as a saving (ruling 70)",
    claimed.length === 0,
    `${multipliers.length} line(s) carry a multiplier: ${multipliers.map((l) => excerpt(l, 90)).join(" | ") || "none"}; ` +
      `lines that read as a savings claim: ${claimed.map((l) => excerpt(l, 90)).join(" | ") || "none"}. ` +
      '"the 16.5× cache lever was active" must never be readable as "this run saved 16.5×"',
  );
  const disclaimer = o.report.split("\n").some((line) => /no claim|makes no claim|claims nothing/i.test(line));
  checks.expect(
    "the levers are printed beside an explicit disclaimer, in the same block (ruling 70)",
    disclaimer,
    disclaimer
      ? "a line in the report states that no saving is being claimed"
      : "NO line disclaims a saving, so the lever list stands alone — which is the sentence ruling 70 is about",
  );

  return checks;
}
