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
 * `cancelled`. And a ceiling line is found by the ANNOUNCEMENT'S OWN IDENTITY
 * rather than by the word `ceiling`, because that word belongs to ruling 58's
 * report-size budget and to the weakened-gap warning as well: see
 * `classifyCeilingLine` for the families of prose that matched it, for the
 * stderr sentence a whitelist of events then MISSED, and for the row that now
 * fails on any ceiling line neither list accounts for.
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
import { itemHead } from "./item-head.ts";

/** Ruling 30's vocabulary. `max` and `ultra` are absent rather than filtered. */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh"] as const;
export type EffortGrade = (typeof EFFORT_ORDER)[number];

/** Ruling 30: hard, across every vendor. Only the operator's own flag moves it. */
export const EFFORT_CEILING: EffortGrade = "high";

/**
 * Ruling 40: a vendor with no measured lever says so, and says it in these words.
 *
 * NOT `bar/lib/checks.ts`'s `NOT-RUN —`, and the 2026-08-19 phrasing census kept
 * the two apart on purpose. This is a value the PRODUCT writes into
 * `effortLever` and this item asserts on the literal; the harness's verdict
 * vocabulary is what the harness writes about its OWN reach. Rewording this
 * string changes what the check asserts.
 */
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
  /** `null` is in the type because JSON has it and `expectedTriple` must tell it from a name. */
  model?: string | null;
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
 * Ruling 29's triple, spelled the way the REPORT must spell it — or the named
 * reason this item has no triple to require.
 *
 * ONE FUNCTION FOR THE EXPECTATION AND FOR THE FAILURE MESSAGE, because on
 * 2026-08-19 they were two and they disagreed with each other AND with the
 * product, three spellings of one member:
 *
 *   the expectation built `` `(${item.agent ?? ""}, ${item.model ?? ""}, …)` `` —
 *   an EMPTY STRING for a missing model, so it asked the report for
 *   `(copilot, , medium …)`;
 *
 *   the failure message rendered `${i.model}` — the five characters `undefined`,
 *   which is amendment §19's own shape being printed by the very file that
 *   exists to reject it;
 *
 *   and the product printed `(copilot, unrouted, medium …)`.
 *
 * `unrouted` IS THE CORRECT ONE, and the product is not the defect here.
 * `src/report/run-report.ts:211` chose it deliberately — *"`default` would read
 * as a value somebody chose. An absent one is an absent one"* — and it is the
 * same rule as ruling 52's, that a missing result must never render as a
 * satisfied requirement. A blank between two commas is a missing thing rendered
 * as nothing at all, which is the one rendering an operator cannot see. The
 * absence is real rather than a gap in the product: `src/queue/execute.ts:758`
 * takes the model from `worker.models[0]` — what the vendor's own ACP session
 * advertised — and a vendor that advertises none leaves nothing to name. Ruling
 * 29 asks that the routing unit be RECORDED as a triple; it does not oblige a
 * vendor to expose a model, and naming what was not routed is how a triple with
 * an absent member stays a triple.
 *
 * `stated()` on the way in, so a record carrying the STRING `"undefined"`, `""`
 * or `null` in `model` is not laundered into `unrouted` — the product renders
 * those literally, they are a defect, and the check must fail on them rather
 * than agreeing with itself.
 *
 * The effort member gets NO such name. `src/report/run-report.ts:211` prints
 * `effort NOT recorded` for an absent one, and mirroring that here would make
 * this check pass for an item that recorded no effort at all — the vacuous pass
 * amendment §19 is the story of. An item with no effort has no triple, and this
 * says so.
 */
export const UNROUTED_MODEL = "unrouted";

export type TripleWanted = { want: string; missing?: undefined } | { want?: undefined; missing: string };

export function expectedTriple(item: EffortItem): TripleWanted {
  const agent = stated(item.agent);
  if (agent === undefined) {
    return {
      missing:
        `the record names NO agent (${JSON.stringify(item.agent)}) for an item it says was dispatched. An item that ` +
        "took a turn ran on a vendor, and `src/report/run-report.ts` prints the triple only for an item that has one",
    };
  }
  const effort = stated(item.effort);
  if (effort === undefined) {
    return {
      missing:
        `the record's rendered \`effort\` is ${JSON.stringify(item.effort)}, so there is no third member to require ` +
        "in the printed triple. Amendment §19's shape, and it fails here rather than being papered over with the " +
        "product's own `effort NOT recorded` wording",
    };
  }
  // ABSENT IS `unrouted`. STRINGIFIED-ABSENT IS A DEFECT. The two are not the
  // same fact and must not collapse into one: a record that never had a model
  // is a vendor that advertised none, and a record whose `model` holds the five
  // characters `undefined` is amendment §19's shape — which the product renders
  // literally (`item.model ?? "unrouted"` does not fire for a non-empty string),
  // so a harness that laundered it into `unrouted` would disagree with the very
  // report it is reading.
  const model = item.model;
  if (model === undefined || model === null) return { want: `(${agent}, ${UNROUTED_MODEL}, ${effort})` };
  const named = stated(model);
  if (named === undefined) {
    return {
      missing:
        `the record's \`model\` is ${JSON.stringify(model)}: present, and not a name. \`${UNROUTED_MODEL}\` is the ` +
        "product's word for a model NOTHING ROUTED (`src/report/run-report.ts:211`), and a field that stringified an " +
        "absence must not be laundered into it — the product prints those characters as they stand",
    };
  }
  return { want: `(${agent}, ${named}, ${effort})` };
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
  // `dispatched.length > 0` is not decoration. `[].filter(...).length === 0` is
  // `true`, so a run that dispatched nothing satisfied ruling 30's ceiling by
  // having nothing to exceed it — green on a property it never examined.
  checks.expect(
    `no item exceeds ruling 30's \`${EFFORT_CEILING}\` ceiling — this run asked for no edge case`,
    dispatched.length > 0 && overCeiling.length === 0,
    overCeiling.map((i) => `${i.id}=${String(i.effortRequested)}`).join(", ") ||
      (dispatched.length === 0
        ? "NOTHING WAS DISPATCHED, so no item could exceed the ceiling: this row is a NOT-RUN under a plain name, never a pass"
        : `all ${dispatched.length} dispatched item(s) are at or below ${EFFORT_CEILING}`),
  );

  // 4. RULING 40's LEVER, against the vendors the HARNESS planted.
  const leverless = dispatched.filter((item) => o.leverlessVendors.includes(item.agent ?? ""));
  const wrongLever = leverless.filter((item) => stated(item.effortLever) !== NO_LEVER);
  checks.expect(
    `a vendor with no measured effort lever records \`${NO_LEVER}\` (ruling 40)`,
    leverless.length > 0 && wrongLever.length === 0,
    leverless.length === 0
      ? `no dispatched item ran on one of the planted vendors (${o.leverlessVendors.join(", ")}), so ruling 40's ` +
        "absent-lever case was never reached: this row is a NOT-RUN under a plain name, never a pass"
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
  // ON THE ITEM'S OWN LINE, never anywhere in the report. FOUND BY WRITING THE
  // NEGATIVE CONTROL, on 2026-08-19: this asked `report.includes("(qwen,
  // qwen-m, medium …)")`, and every item in this item's plan runs on the same
  // vendor at the same grade — so ONE printed triple satisfied the test for ALL
  // FOUR items, and a product that printed the triple for one item and dropped
  // it for the rest passed. The same whole-report containment defect the audit
  // removed from item 11, reintroduced by its own repair one file over.
  // `itemHead` is the anchored lookup, shared with item 11 so the two cannot
  // drift; its `undefined` is "no line for this item at all", which is a
  // different failure from "the line says the wrong thing" and is rendered as
  // one below.
  // THE EXPECTATION AND THE MESSAGE COME FROM ONE FUNCTION. They were two, and
  // they printed a missing model three different ways between them — see
  // `expectedTriple`. A failure message that names a string the check never
  // looked for sends the reader to the wrong half of the machine.
  const unprinted = dispatched
    .map((item) => ({ item, want: expectedTriple(item), line: itemHead(o.report, item.id)?.text }))
    .filter(({ want, line }) => want.missing !== undefined || line === undefined || !line.includes(want.want));
  checks.expect(
    "the report prints each dispatched item's triple, with the effort inside it (ruling 29)",
    dispatched.length > 0 && unprinted.length === 0,
    unprinted
      .map(({ item, want, line }) =>
        want.missing !== undefined
          ? `${item.id}: NO TRIPLE COULD BE REQUIRED — ${want.missing}`
          : `${item.id}: expected \`${want.want}\` on its own line, found ${
              line === undefined ? "no line for that item at all" : `\`${line.trim()}\``
            }`,
      )
      .join("; ") ||
      (dispatched.length === 0
        ? "NOTHING WAS DISPATCHED, so no triple was printed and none was required — an empty list satisfies " +
          "`every` and this row must not read as ruling 29 holding"
        : `${dispatched.length} triple(s) found, each on its own item's line, each with a NAME in every member — ` +
          `an unrouted model reads \`${UNROUTED_MODEL}\` and never as a blank between two commas`),
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
 *
 * PLURAL because it is both kinds: ONE positive control — a correctly recorded
 * triple the reader must accept — and the negative controls under it, each a
 * shape the reader must reject. A file of only the second proves the reader
 * fails; a file of only the first proves it passes.
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
  // RULING 29'S MISSING MEMBER, HELD TO THE PRODUCT'S OWN NAME FOR IT. The
  // expectation used to be built with `item.model ?? ""` and the failure message
  // with `${item.model}`, so a vendor whose ACP session advertises no model —
  // copilot, measured on 2026-08-19 — was asked for a blank between two commas
  // and told about the word `undefined`, while the report correctly said
  // `unrouted`. Demonstrated here every run: the name is accepted and the blank
  // is not.
  const unrouted: EffortItem = { ...good };
  delete unrouted.model;
  const namedLine = `  control-good: integrated — (qwen, ${UNROUTED_MODEL}, ${String(good.effort)})`;
  checks.expect(
    `the effort reader takes the product's NAME for a model nothing routed (\`${UNROUTED_MODEL}\`) as the triple's second member`,
    control([unrouted], namedLine) === 0 && control([unrouted], "  control-good: integrated — (qwen, , medium (set, NOT confirmed — #45))") > 0,
    `report naming it \`${UNROUTED_MODEL}\`: ${control([unrouted], namedLine)} failure(s); report leaving it blank: ` +
      `${control([unrouted], "  control-good: integrated — (qwen, , medium (set, NOT confirmed — #45))")} failure(s). ` +
      "A missing thing rendered as nothing at all is the one rendering an operator cannot see (ruling 52)",
  );
  checks.expect(
    "and it REJECTS a model field that holds the stringified absence rather than a name",
    control([{ ...good, model: "undefined" }], namedLine) > 0,
    `\`model: "undefined"\` against a report that says \`${UNROUTED_MODEL}\` produced ` +
      `${control([{ ...good, model: "undefined" }], namedLine)} failure(s) — the record's five characters are not ` +
      "a routed model, and must not be laundered into the product's name for an absent one",
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

/**
 * ONE LINE OF A REPORT, CLASSIFIED — an event, deliberately not an event, or
 * NOT RECOGNISED AT ALL, which is a failure rather than a shrug.
 *
 * WHY THIS IS A CLASSIFIER AND NOT A LIST OF EVENTS. `/ceiling/i` over the
 * whole report was the first instrument defect: ruling 58's REPORT-SIZE budget
 * says the word, so a run given no ruling-66 ceiling failed its own negative
 * control on `src/queue/admit.ts`'s admission prose. The repair was a whitelist
 * of event sentences, and a blind critic measured that this TRADED THE DEFECT
 * FOR ITS MIRROR IMAGE: `src/queue/execute.ts:1235` announces the hard ceiling
 * on STDERR — *"HARD CEILING — 37,648 tokens reached. `session/cancel` sent to
 * 3 live worker(s)…"* — and no entry matched it, so a SOFT run that cancelled
 * work already running, and said so in the product's own words, PASSED *and it
 * did NOT report cancelling work that was already running*. The `/cancel/i`
 * reader that was replaced had seen that line.
 *
 * A whitelist's staleness is a false NEGATIVE — the property vanishes and the
 * row stays green. A blacklist's staleness is a false POSITIVE — honest new
 * prose fails the item and a human classifies it. Those are not equally bad,
 * and this repository audited seven items green on something they were not
 * checking. So the word is the NET, both lists are transcriptions, and a line
 * that carries the word and matches neither list is reported by
 * `unrecognisedCeilingLines` and FAILS the run.
 *
 * That is what pins every pattern below. A product that rewords an event fails
 * (the line becomes unrecognised); a product that deletes an event fails (the
 * row that requires it); a product that adds honest new ceiling prose fails
 * until someone classifies it. Nothing here can go stale quietly, and that
 * claim now covers every entry rather than one of four.
 *
 * TRANSCRIBED against the WORKING TREE on 2026-08-19, not against `HEAD`:
 * `src/report/run-report.ts` was being rewritten in the same round and every
 * line number below had moved. `run-report.ts:758` — *"no CHECK was dropped to
 * fit this ceiling, and none can be (ruling 52)"* — did not exist at `HEAD` at
 * all, and a blacklist keyed on ruling 58 would have missed it.
 */
export interface CeilingPattern {
  /** Where it comes from and what it is. Printed when a row fails. */
  what: string;
  re: RegExp;
}

/**
 * RULING 66 ACTING. Four sentences, from two files and two streams.
 *
 * `src/queue/execute.ts:1613`'s run note — *"soft ceiling (3,764 tokens) was
 * reached: …"* — is DELIBERATELY ABSENT. It is pushed into `notes`, `notes`
 * become `writeRunReport`'s `detail` (`src/queue/execute.ts:2108`), and
 * `src/report/run-report.ts:737` drops `detail` whenever `isCapped(audience)`
 * — which `src/report/budget.ts:57` makes true for `host-session`, which
 * `src/cli.ts:609` is the default and which this item never overrides. It
 * cannot reach a report this item reads. A fixture line the product cannot
 * emit is an invention, and its only measurable effect here was to keep
 * `ceilingLines` non-empty and so hide a reworded soft-ceiling sentence.
 */
export const CEILING_EVENTS: readonly CeilingPattern[] = [
  {
    what: "the hard ceiling's cancel notice on stderr (`src/queue/execute.ts:1235`)",
    re: /^\s*HARD CEILING — [\d,]+ tokens reached\./,
  },
  { what: "the hard ceiling in the report (`src/report/run-report.ts:522`)", re: /^\s*HARD CEILING FIRED at /},
  { what: "the soft ceiling in the report (`src/report/run-report.ts:529`)", re: /^\s*soft ceiling reached at / },
  {
    what: "the provenance printed beside a ceiling that fired (`src/report/run-report.ts:539`)",
    re: /^\s*the ceiling is the primary control and the estimate is not\b/,
  },
];

/**
 * PROSE THAT CARRIES THE WORD AND IS NOT RULING 66 ACTING.
 *
 * Every entry names the file it was copied from. Three groups:
 *
 *   A DIFFERENT CEILING ENTIRELY — ruling 58's cap on how many tokens the
 *   REPORT may spend, and ruling 30's cap on EFFORT. Neither is a limit on what
 *   the run may spend and neither can stop an item.
 *
 *   THE CEILING-PAIR WARNING (`src/queue/estimate.ts:171` and `:194`). A
 *   statement about the two numbers the operator handed in, produced BEFORE
 *   anything is spent and printed whether or not either ceiling ever acts. The
 *   CLI writes its lines one per line to stderr (`src/cli.ts:499`) and the
 *   record carries the same lines joined by a space (`src/queue/execute.ts:2069`)
 *   which the report prints as one, so a report holds BOTH renderings — the
 *   reason the earlier excision, which split the report on the record's copy,
 *   removed one and left the other. Every line is matched here, in both forms:
 *   the joined copy matches the head pattern.
 *
 *   PER-ITEM FACTS — a ladder rung not taken, an item that was never
 *   dispatched. Those belong to ONE item and are judged on that item's own line.
 */
export const CEILING_NON_EVENTS: readonly CeilingPattern[] = [
  // Ruling 58's report-size budget. A cap on how many tokens the REPORT may
  // spend — a different ceiling, in a different unit, that can stop no item.
  // `src/report/run-report.ts`'s ruling-52 sentence about what the cap may hide
  // was in this list on 2026-08-19 and is not any more: its owner removed it
  // from the product in the same round, and a blacklist entry for prose nobody
  // writes is a claim about the product that is no longer true.
  { what: "ruling 58's report budget, in the admission block (`src/queue/admit.ts:364`)", re: /ruling 58: the ceiling is on everything this process writes/ },
  // ANCHORED ON THE HEAD, WITH THE WHOLE TAIL FREE. `src/report/run-report.ts:803`
  // is `this report is OVER the <n>-token ` + `ceiling${share} because ${why}.`,
  // and BOTH interpolations changed today: `${why}` is now DERIVED from whether
  // any item actually blocks (it used to assert a reason that was false in a
  // reachable case), and `${share}` is empty unless something else already spent
  // the channel's budget. A pattern keyed on either drifts again next round —
  // this one was keyed on `${why}`'s old wording and did. What cannot move
  // without the sentence becoming a different sentence is the noun phrase that
  // names ruling 58's budget, so that is the anchor and everything after
  // `ceiling` is left alone. Still not the `/ceiling/i` net: the line must open
  // with this exact claim about the REPORT's own size.
  { what: "ruling 58's report budget, when the report is over it (`src/report/run-report.ts:803`)", re: /^\s*this report is OVER the [\d,]+-token ceiling\b/ },
  // Ruling 30's EFFORT ceiling. A cap on how hard a worker thinks, not on spend.
  { what: "ruling 30's effort ceiling (`src/queue/spawn.ts:314`)", re: /Ruling 30's ceiling is not exceeded/ },
  // The ceiling-pair warning, degraded form (`src/queue/estimate.ts:194`).
  { what: "the weakened-pair warning, its head — and its whole joined copy (`src/queue/estimate.ts:194`)", re: /^\s*WEAKENED SOFT CEILING — --soft-ceiling / },
  { what: "the weakened-pair warning, ruling 66's two verbs (`src/queue/estimate.ts:200`)", re: /^\s*Ruling 66: the soft ceiling stops NEW items and lets in-flight ones finish; the hard ceiling\s*$/ },
  { what: "the weakened-pair warning, its hypothetical cancellation (`src/queue/estimate.ts:201`)", re: /^\s*cancels work already running\. With a gap this narrow the hard ceiling may fire anyway and\s*$/ },
  { what: "the weakened-pair warning, the run proceeding (`src/queue/estimate.ts:203`)", re: /^\s*The run PROCEEDS: you asked for a hard ceiling and it is honoured\./ },
  { what: "the weakened-pair warning, the remedy (`src/queue/estimate.ts:204`)", re: /^\s*soft one, and the report names which ceiling actually fired\./ },
  { what: "the weakened-pair warning, the number to raise to (`src/queue/estimate.ts:205`)", re: /^\s*--hard-ceiling above [\d,]+\.\s*$/ },
  // The ceiling-pair REFUSAL (`src/queue/estimate.ts:171`). Nothing is started, so
  // no run of this item can hold it — transcribed anyway, because a pair that
  // refuses is one flag away and an unclassified line fails the run.
  { what: "the refused pair, its head (`src/queue/estimate.ts:171`)", re: /^\s*--soft-ceiling [\d,]+ is at or above --hard-ceiling [\d,]+,/ },
  { what: "the refused pair, ruling 66's two verbs (`src/queue/estimate.ts:173`)", re: /^\s*Ruling 66: the soft ceiling stops NEW items and lets in-flight ones finish; the hard ceiling\s*$/ },
  { what: "the refused pair, its remedy (`src/queue/estimate.ts:176`)", re: /^\s*Remedy: --hard-ceiling must be above --soft-ceiling, and above [\d,]+/ },
  // Per-item facts, judged on the item's own line rather than here.
  { what: "a ladder rung not taken for budget (`src/work/ladder.ts:124`)", re: /attempt \d+ not taken — budget ceiling/ },
  { what: "the per-item never-dispatched qualifier (`src/queue/execute.ts:1880`)", re: /: not-run \(ceiling stopped dispatch\)/ },
  { what: "the per-item never-dispatched remedy (`src/queue/execute.ts:1893`)", re: /Remedy: raise the ceiling, or split the plan\./ },
  { what: "a plan that set `effort` itself (`src/queue/plan.ts:302`)", re: /The only channel that raises the ceiling is the operator's/ },
];

/** Does this line say the word at all? The net, before either list is consulted. */
export function mentionsCeiling(line: string): boolean {
  return /ceiling/i.test(line);
}

/** `event`, `not-an-event`, or `null` for a line nobody has classified. */
export function classifyCeilingLine(line: string): "event" | "not-an-event" | null {
  if (!mentionsCeiling(line)) return "not-an-event";
  if (CEILING_EVENTS.some((p) => p.re.test(line))) return "event";
  if (CEILING_NON_EVENTS.some((p) => p.re.test(line))) return "not-an-event";
  return null;
}

/** Every line on which this run announced that a ceiling ACTED. */
export function ceilingLines(report: string): string[] {
  return report.split("\n").filter((line) => classifyCeilingLine(line) === "event");
}

/**
 * Lines carrying the word that neither list accounts for.
 *
 * Non-empty is a FAILURE, and it is the only thing standing between this
 * instrument and the two ways a transcription rots. It is reported with the
 * line quoted so the reader can classify it in one edit.
 */
export function unrecognisedCeilingLines(report: string): string[] {
  return report.split("\n").filter((line) => classifyCeilingLine(line) === null);
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

  // EVERY LINE CARRYING THE WORD IS ACCOUNTED FOR, ON ALL THREE RUNS.
  //
  // This row is what makes the two lists below trustworthy rather than merely
  // present. A transcription rots in two directions: the product rewords an
  // EVENT and a whitelist goes quietly green, or the product adds honest new
  // prose and a blacklist goes quietly red. Requiring every `ceiling` line to
  // be classified turns BOTH into this row failing with the line quoted, which
  // a reader fixes in one edit. Without it the entries here are pinned by
  // nothing — a blind critic deleted `src/report/run-report.ts`'s provenance
  // sentence from the product outright on 2026-08-19 and no row noticed.
  const unclassified = [o.uncapped, o.soft, o.hard].flatMap((r) =>
    unrecognisedCeilingLines(r.report).map((line) => `${r.what}: ${excerpt(line.trim(), 110)}`),
  );
  checks.expect(
    "every line that says `ceiling` is classified as ruling 66 acting, or as prose that is not (the anti-drift row)",
    unclassified.length === 0,
    unclassified.join(" | ") ||
      `all three runs classified against ${CEILING_EVENTS.length} event pattern(s) and ` +
        `${CEILING_NON_EVENTS.length} non-event pattern(s). An unclassified line fails here rather than being ` +
        "silently counted or silently dropped, which is the only thing that keeps a hand-copied list honest",
  );

  // THE NEGATIVE CONTROL. A ceiling line that printed on every run would be
  // wallpaper, and an operator would stop reading it at exactly the point it
  // started being true.
  const uncappedLines = ceilingLines(o.uncapped.report);
  checks.expect(
    "a run with NO ceilings records neither as hit and prints no ceiling event (the negative control)",
    uncappedCost !== undefined &&
      uncappedCost.softCeilingHit !== true &&
      uncappedCost.hardCeilingHit !== true &&
      uncappedLines.length === 0,
    `record: softCeilingHit=${uncappedCost?.softCeilingHit}, hardCeilingHit=${uncappedCost?.hardCeilingHit}; ` +
      `ceiling EVENTS announced by a report that had no ceilings: ${
        uncappedLines.map((l) => excerpt(l, 80)).join(" | ") || "none"
      }. An event is ruling 66 ACTING — including \`src/queue/execute.ts\`'s stderr cancel notice — never the ` +
      "word `ceiling`, which ruling 58's report budget, ruling 30's effort cap, the per-item never-dispatched " +
      "qualifier and the ceiling-pair warning all carry without being one",
  );

  // THE SOFT CEILING: new dispatch stops, work in flight finishes. Its
  // signature is an item that was never given a directory, and NO cancellation.
  const softItems = o.soft.record?.items ?? [];
  const softStopped = softItems.some((i) => i.status === "unrun");
  const softCancelled = softItems.filter((i) => i.status === "cancelled");
  const softSaid = ceilingLines(o.soft.report);
  checks.expect(
    "the SOFT ceiling stopped new items being DISPATCHED and cancelled nothing (ruling 66)",
    softCost?.softCeilingHit === true &&
      softCost.hardCeilingHit === false &&
      softStopped &&
      softCancelled.length === 0 &&
      softSaid.some((line) => /dispatch/i.test(line)),
    `softCeilingHit=${softCost?.softCeilingHit}, hardCeilingHit=${softCost?.hardCeilingHit}; statuses: ${statuses(o.soft)}; ` +
      `ceiling events: ${softSaid.map((l) => excerpt(l, 100)).join(" | ") || "NONE ANNOUNCED"}` +
      (softCost?.softCeilingHit === true ? "" : `. ${whyNotFired(o.soft, softCost?.softCeiling)}`),
  );
  // NOT VACUOUS OVER AN EMPTY LIST, and that guard is the whole reason the row
  // is written this way: `[].every(...)` is `true`, so a soft run that announced
  // NOTHING would have satisfied "it did not report cancelling" by having
  // reported nothing at all. The soft ceiling fired — the row above says so — so
  // there is an announcement to read, and its absence is this row's failure too.
  //
  // It reads the SAME `ceilingLines` as every other row here, which is the
  // second half of the 2026-08-19 repair: this check used to disagree with the
  // one above it about what a ceiling line is. The row above excised the
  // weakened-gap warning by splitting on the record's copy; this one did not,
  // and matched `/cancel/i` against the warning's own sentence *"cancels work
  // already running. With a gap this narrow the hard ceiling may fire anyway
  // and"* — the product describing a WEAKENING before the run, read as the soft
  // ceiling cancelling work. One reader, one answer.
  const softCancels = softSaid.filter((line) => /cancel/i.test(line));
  checks.expect(
    "and it did NOT report cancelling work that was already running",
    softSaid.length > 0 && softCancels.length === 0,
    softCancels.map((l) => excerpt(l, 120)).join(" | ") ||
      (softSaid.length === 0
        ? "the soft run announced NO ceiling event at all, so there is nothing here that did not mention " +
          "cancellation — `every` over an empty list is `true`, and that is not this property holding"
        : `${softSaid.length} ceiling event(s) in the soft run and not one mentions cancellation, which is the ` +
          "hard ceiling's verb and not this one's"),
  );

  // THE HARD CEILING: work already running is cancelled. Its signature is an
  // item that was in flight and stopped — a different status and a different verb.
  const hardItems = o.hard.record?.items ?? [];
  const hardCancelled = hardItems.filter((i) => i.status === "cancelled");
  const hardSaid = ceilingLines(o.hard.report);
  // BOTH SENTENCES, and that is what pins the stderr pattern. The report line
  // says work was cancelled; `src/queue/execute.ts:1235` says by what mechanism
  // and to how many live workers, and it is the only place the count appears. A
  // row that accepted either would leave the stderr pattern required by nothing,
  // and a pattern nothing requires can be deleted from the product in silence.
  // The FACT, not the sentence: an announcement that names how many live
  // workers were stopped. `src/queue/execute.ts:1235` says `session/cancel` sent
  // to N live worker(s); `bar/fakes/honest.ts` kills the same set and now says
  // so in the same shape. Anchoring on either implementation's wording would
  // measure its prose, and anchoring on nothing would leave the pattern pinned
  // by nothing — which is how the provenance sentence was deletable in silence.
  const hardMechanism = hardSaid.filter((line) => /\bcancel/i.test(line) && /\b\d+ live worker\(s\)/.test(line));
  checks.expect(
    "the HARD ceiling CANCELLED work already running, and says so — in the report AND as it fires (ruling 66)",
    hardCost?.hardCeilingHit === true &&
      hardCancelled.length > 0 &&
      hardSaid.some((line) => /cancel/i.test(line)) &&
      hardMechanism.length > 0,
    `hardCeilingHit=${hardCost?.hardCeilingHit}; statuses: ${statuses(o.hard)}; ` +
      `ceiling events: ${hardSaid.map((l) => excerpt(l, 100)).join(" | ") || "none"}; ` +
      `the \`session/cancel\` notice naming the live workers: ${
        hardMechanism.map((l) => excerpt(l, 100)).join(" | ") || "ABSENT — nothing said what was done to the workers"
      }` +
      (hardCost?.hardCeilingHit === true ? "" : `. ${whyNotFired(o.hard, hardCost?.hardCeiling)}`),
  );

  // PIN FOR THE PROVENANCE SENTENCE. It was required by nothing: a blind critic
  // deleted `src/report/run-report.ts:539` from the product outright on
  // 2026-08-19 and every row here stayed green. Ruling 66's ordering — the
  // ceiling is the primary control and the estimate is not — is a promise to
  // the operator, and a promise printed by no run is not kept. Required on both
  // runs whose ceiling fired, and forbidden on the uncapped one by the negative
  // control above, which is what makes it an event rather than wallpaper.
  const provenance = /^\s*the ceiling is the primary control and the estimate is not\b/;
  const withoutProvenance = [o.soft, o.hard].filter((r) => !ceilingLines(r.report).some((l) => provenance.test(l)));
  checks.expect(
    "a ceiling that FIRED prints ruling 66's ordering: the ceiling is the primary control, the estimate is not",
    withoutProvenance.length === 0,
    withoutProvenance.map((r) => `${r.what}: no provenance line`).join("; ") ||
      "both runs whose ceiling fired printed it, and the run with no ceilings printed neither it nor any other " +
        "ceiling event — #44 measured 427,723 against 28,245 bytes on two identical runs, so no prediction is " +
        "load-bearing enough to be the thing that stops a run",
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

/**
 * The line on which a run says what it ACTUALLY spent, whoever wrote the run.
 *
 * ANCHORED, BECAUSE THE WHOLE REPORT IS NOT AN ANSWER. `report.includes("9,412")`
 * over the whole text is satisfied by a run id, a pid, a byte count or a
 * `--run-root` path that happens to carry those digits — a blind critic induced
 * exactly that on 2026-08-19 and the row went green beside the words `actual
 * not measured`. It is also the `fifty-4` shape: `includes("9,412")` is
 * satisfied by `29,412`, so a report printing a DIFFERENT, larger number proved
 * the smaller one.
 *
 * AND NOT ANCHORED ON BRIGADIER'S SENTENCE, which is the correction of
 * 2026-08-19's second measurement. The first repair matched
 * `/^\s*cost estimate .* – /` — `src/report/run-report.ts:680`, word for word —
 * and `bar/fakes/honest.ts:1605` FAILED IT while printing all three numbers on
 * one line: *"actual 325 tokens against predicted 57,468 – 287,340"*. That
 * fixture is a from-scratch reimplementation and its contract is that it really
 * does the work; failing it for its phrasing measured brigadier's prose rather
 * than the property BAR.md item 13 states, which is that a run *"afterwards
 * prints actual against predicted"*. Both implementations put the three numbers
 * on ONE line and both label it `actual`, so that is the anchor: the label, not
 * the sentence. The two traps above stay shut — the numbers must still be on
 * that line, bounded on both sides.
 */
export function costLines(report: string): string[] {
  return report.split("\n").filter((line) => /\bactual\b/i.test(line));
}

/** `value`, on `line`, not as a fragment of a longer number. */
export function bounded(line: string, value: number): boolean {
  return numberForms(value).some((form) => {
    // The boundary excludes IDENTIFIER characters, not merely digits. `(?<!\d)`
    // alone let `run r-9412` satisfy `9412` — induced and MEASURED green on
    // 2026-08-19 while the same line read `actual not measured`. A spend is a
    // number with whitespace or punctuation-that-is-not-part-of-a-name on each
    // side of it; `r-9412`, `29,412` and `/runs/9412/` are none of those.
    const at = new RegExp(`(?<![\\w,./-])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w,./-])`);
    return at.test(line);
  });
}

export function judgeDeepCost(o: DeepCostObservations): Checks {
  const checks = new Checks();
  const cost = o.record?.cost;

  // ACTUAL AGAINST PREDICTED, asserted on the NUMBERS. `/actual/i` is a word,
  // and a report that says "actual: not measured" contains it.
  const actual = cost?.actual;
  // ONE line must carry all three. Split across two lines they are two
  // unrelated numbers, and "actual against predicted" is a COMPARISON.
  const candidates = costLines(o.report);
  const settled = candidates.find(
    (l) =>
      actual !== undefined &&
      cost?.estimateLow !== undefined &&
      cost?.estimateHigh !== undefined &&
      bounded(l, actual) &&
      bounded(l, cost.estimateLow) &&
      bounded(l, cost.estimateHigh),
  );
  checks.expect(
    "the report prints the actual spend against BOTH ends of the predicted range, as numbers, on one line",
    settled !== undefined,
    settled !== undefined
      ? `the spend line: ${excerpt(settled.trim(), 130)}`
      : `actual ${actual ?? "ABSENT from the record"} against ${cost?.estimateLow ?? "?"} – ${cost?.estimateHigh ?? "?"} ` +
        `${cost?.currency ?? "no unit"}; ${
          candidates.length === 0
            ? "NO LINE IN THE REPORT SAYS `actual` AT ALL"
            : `${candidates.length} line(s) say \`actual\` and none carries all three: ${
                candidates.map((l) => excerpt(l.trim(), 90)).join(" | ")
              }`
        }. Bounded on both sides and on one line: a run id carrying the same digits is not the spend, ` +
        "`29,412` is not `9,412`, and a number without its comparison is not a comparison",
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
  // `(?:×|x)\b` MATCHED NOTHING, ever. `×` is not a word character and neither
  // is the space after it, so there was no boundary between them and `16.5×` —
  // the one multiplier every run prints — never matched. Found on 2026-08-19 by
  // adding the non-vacuity guard below: the row had no subject and had never
  // had one. The lookahead keeps `0x1f` out while letting `3x` in.
  const multipliers = o.report.split("\n").filter((line) => /\d[\d.,]*\s*(?:×|x)(?![a-z0-9])/i.test(line));
  const claimed = o.savingsClaims(o.report);
  // `multipliers.length > 0` is the same guard the ceiling rows carry: a report
  // with no measured multiplier anywhere has nothing that COULD read as a
  // saving, and this row would then be green on a subject that was not there.
  // Ruling 21's 16.5× prompt-cache lever is in every run's lever list, so the
  // subject exists whenever the levers reached the report at all.
  checks.expect(
    "a line carrying a measured multiplier cannot be read as a saving (ruling 70)",
    multipliers.length > 0 && claimed.length === 0,
    `${multipliers.length} line(s) carry a multiplier: ${
      multipliers.map((l) => excerpt(l, 90)).join(" | ") || "NONE — so no line could read as a saving: this row is a NOT-RUN under a plain name, never a pass"
    }; ` +
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
