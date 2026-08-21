// SPDX-License-Identifier: Apache-2.0
/**
 * What a run must leave behind, so that "it ran" is checkable rather than
 * printable.
 *
 * A blind critic wrote a fake brigadier whose entire behaviour was `console.log`
 * plus one hand-written 41-byte ref file, and the first draft of this harness
 * scored it 10 of 13. Every one of those ten checks was a substring of stdout —
 * and stdout is the one thing a liar controls completely. Ruling 62(a) and v1's
 * finding 41 say it in one line: **assert on the escaped bytes, never on a
 * flag.** A printed word is a flag with more characters.
 *
 * The repair is that every item now needs two things at once: an artefact only
 * a working brigadier could have produced, and the absence of the artefact a
 * broken one would leave. A ref that `git fsck` can walk. A blob whose contents
 * are a token this harness generated after the binary was built. A record on
 * disk whose item ids match the commit subjects in that ref. A canary that must
 * exist because work happened, beside one that must not exist because
 * containment held.
 *
 * The SHAPE below began as the harness's proposal and is now the product's
 * published record, transcribed rather than imported — this directory imports
 * nothing from `src/`, so the two are kept in step by hand and by the items
 * failing loudly when they drift. Stated here rather than buried, because an
 * item that quietly invented a format and then reported "refused" would be
 * measuring its own guess. It is one file rather than thirteen literals so that
 * a contract change is one edit.
 *
 * **THAT CLAIM WAS FALSE UNTIL 2026-08-19, and the way it failed is the reason
 * to read it sceptically now.** The drift did not make anything fail loudly. It
 * made three items fail SILENTLY: each one found a field missing here, widened
 * or re-transcribed the shape locally, and carried on — so `qualifier`,
 * `detail`, the four effort fields and `cost.gapWarning` were all readable
 * somewhere under `bar/`, and none of them was readable HERE, which is the only
 * place a fourth item would have looked. Meanwhile `CheckOutcome` listed
 * `skipped`, a value the product has never emitted, and omitted `not-run`,
 * which it writes into every blocking check's slot before the check runs. A
 * local workaround is what drift looks like from inside; nothing in the design
 * makes it loud, and the only thing that keeps this file honest is somebody
 * diffing it against `src/report/record.ts` and `src/work/check.ts` on purpose.
 *
 * EVERY FIELD BELOW IS WHAT THE PRODUCT CLAIMS, NEVER WHAT HAPPENED. The record
 * is read to learn where to look — which sha, which ref, which item — and every
 * claim it makes is then put to `git` by `evidence.ts`. A record that could be
 * believed on its own would make this harness score a forger's JSON.
 */

/** The line a run must print so its record can be found. Nothing else is parsed for paths. */
export const RECORD_LINE = /^\s*run-record:\s*(\S.*?)\s*$/m;

export type ItemStatus =
  /** Merged into the integration branch. */
  | "integrated"
  /** Ran, did not pass its checks, not merged. */
  | "failed"
  /** Never dispatched — a prerequisite did not integrate, or a ceiling stopped it. */
  | "unrun"
  /** Cancelled in flight by a hard ceiling or an interrupt. */
  | "cancelled"
  /** Ruling 63: interrupted with committed work in its clone, kept rather than swept. */
  | "retained";

/**
 * Ruling 52's vocabulary, as `src/work/check.ts` actually declares it.
 *
 * THIS TYPE WAS WRONG UNTIL THE RECONCILIATION PASS, and wrong in the exact way
 * ruling 52 exists to prevent. It listed `skipped` — a value the product has
 * never emitted — and omitted `not-run` and `unconfigured`, which it emits
 * constantly: `not-run` is `INITIAL_OUTCOME`, written into every blocking
 * check's slot BEFORE the check runs, so it is the single most common value in
 * a killed run's record. A harness whose vocabulary could not name it could not
 * see the write-ahead it was built to prove, and would have typed a real
 * outcome as a drift.
 *
 * `blocks()` is `outcome !== "pass" && outcome !== "unconfigured"`. Ruling 52's
 * four are pass/fail/error/not-run, three of which block; `unconfigured` is the
 * fifth and does NOT block, because a first-time user with no verify command
 * must still get a product that runs. It is printed in the same slot with the
 * same prominence all the same — the difference between an unmet requirement
 * and an absent one is real, the difference in how loudly they print is not.
 */
export type CheckOutcome = "pass" | "fail" | "error" | "not-run" | "unconfigured";

/** Ruling 52: `pass` proceeds, `unconfigured` does not block, everything else does. */
export function blocks(outcome: CheckOutcome): boolean {
  return outcome !== "pass" && outcome !== "unconfigured";
}

export interface RecordCheck {
  name: string;
  outcome: CheckOutcome;
  /** Ruling 52: three of the four outcomes block. A blocking check never collapses. */
  blocking: boolean;
  /**
   * Ruling 52: the qualifier lives INSIDE the rendered result and never in a
   * footnote — `review: pass (same-vendor)`.
   *
   * Absent from this file until the reconciliation pass, which is why two items
   * had each widened `RecordCheck` locally to reach it. v1's compact output was
   * truthful in its detail view and false in its summary, and people read
   * summaries; a harness that could not see this field could not catch the
   * product dropping it.
   */
  qualifier?: string;
  /** The checker's own words. On `error` and `not-run` this is the remedy. */
  detail?: string;
}

export interface RecordItem {
  id: string;
  /**
   * The product's OWN identity for an item: a 1-based ordinal.
   *
   * This field is why three items used to read the evidence wrong. The plan's
   * string `id` is the operator's handle; `number` is what brigadier routes,
   * names directories and refs by, and puts in a commit subject
   * (`brigadier: integrate item 3 of run …`). A harness that looked for the
   * string id inside a commit subject was asserting on a RENDERING that the
   * product never promised to contain it — the "assert on a flag" mistake in
   * different clothes — and it was satisfiable by a forger that simply named
   * its commits after the plan.
   */
  number?: number;
  status: ItemStatus;
  /**
   * Ruling 78 added `plan` and `research`. Transcribed here rather than
   * narrowed: a bar item reading a record whose `kind` this type does not admit
   * measures the wrong thing quietly, which is the exact failure `bun run
   * claims` check 3 exists to catch — and it caught this one.
   */
  kind?: "write" | "read-only" | "plan" | "research";
  /**
   * Ruling 29: the routing unit is a triple, recorded per item — and this half
   * of it is the vendor whose PROCESS SPAWNED.
   *
   * Absent when nothing started. `routedAgent` carries what the router chose,
   * and the two are separate fields because "routed to qwen and never started"
   * is not "qwen ran": ruling 32's property is a comparison between a builder's
   * vendor and a reviewer's, so an identity taken from the plan can answer it
   * about a process that never existed.
   */
  agent?: string;
  /** What the router CHOSE, whether or not anything spawned. Never evidence of a run. */
  routedAgent?: string;
  model?: string;
  /**
   * The third axis, rendered with its qualifier INSIDE the value.
   *
   * `high` alone would read as the effort that RAN, and #45 measured that
   * neither vendor's setting is confirmable over the protocol. The four fields
   * below carry the same fact in a form a machine can read without parsing
   * prose, and every one of them was missing from this file until the
   * reconciliation pass — which is why item 13 had transcribed them locally.
   */
  effort?: string;
  /** Ruling 31: derived from (kind, difficulty). Never supplied by the plan. */
  effortRequested?: string;
  /** `session/set_model`, `MAX_THINKING_TOKENS at spawn`, or `none measured`. */
  effortLever?: string;
  /** What brigadier did: set it, sent it, had it accepted, had it refused, or nothing. */
  effortDisposition?: string;
  /**
   * #45, as a field that cannot say otherwise.
   *
   * Typed as the literal `false` exactly as the product types it. "The effort we
   * asked for is the effort that ran" is asserted from vendor-private records or
   * not at all, and brigadier does not have them — so there is no value this may
   * take that would imply it does, and a record that put `true` here is not a
   * record this type can describe.
   */
  effortConfirmed?: false;
  effortDetail?: string;
  /** Ruling 67: printed per item, and only ever downward. */
  difficulty?: string;
  clampedTo?: string;
  /** Ruling 55: the rung it actually got, and whether a second rung existed at all. */
  attempts?: number;
  attemptsAvailable?: number;
  /**
   * The same two numbers as a sentence a reader cannot misread.
   *
   * `attempts: 1, attemptsAvailable: 1` and `attempts: 2, attemptsAvailable: 2`
   * are both "N of N" to a skimmer, and ruling 55's whole point is that a
   * MISSING rung and an EXHAUSTED one are different facts about the machine.
   */
  ladder?: string;
  /** Ruling 32: the reviewer's vendor, which must differ from the builder's where it can. */
  builderAgent?: string;
  reviewerAgent?: string;
  reviewVerdict?: CheckOutcome;
  /**
   * How many times the REVIEWER ran for this item.
   *
   * Deliberately not folded into `attempts`. Ruling 52's budget rule: a builder
   * must not lose a rung of ruling 24's ladder to somebody else's crash.
   */
  reviewerAttempts?: number;
  /**
   * Which planted defect markers this reviewer actually found.
   *
   * Identities, not a count. Ruling 52's named assumption is what item 5
   * converts into a public measurement, and a count can be printed by anything;
   * a list of markers generated after the binary was built cannot.
   */
  caughtDefects?: string[];
  checks?: RecordCheck[];
  /** The commit this item contributed, verifiable with `git cat-file`. */
  commit?: string;
  /** `refs/brigadier/<runId>/item/<number>` — ruling 50's invisible namespace. */
  itemRef?: string;
  /**
   * Ruling 51's left-hand side: what this item's clone STARTED from.
   *
   * Per ITEM rather than per run, because ruling 54 gives wave N+1 a different
   * base from wave 1 — the integration commit wave N published. Without it
   * `git diff <base>..<itemRef>` cannot be recomputed by a reader, which is the
   * whole ownership check.
   */
  baseRef?: string;
  baseSha?: string;
  /** Ruling 63: a retained clone is reported with its path and its bytes. */
  clonePath?: string;
  bytes?: number;
}

export interface RunRecord {
  runId: string;
  /** `refs/heads/brigadier/<runId>` — ruling 51, visible to `git branch`, survives cleanup. */
  integrationRef: string;
  /**
   * THE NAME IS NOT THE THING. `integrationRef` is where the deliverable would
   * go; this is what `git rev-parse` answered in the operator's repository.
   *
   * Absent is the machine-readable form of "this run published nothing", and
   * the harness resolves the ref itself rather than believing the number.
   */
  integrationSha?: string;
  /**
   * Ruling 50's scratch base: the commit every wave-1 clone started from.
   *
   * REQUIRED, because the product requires it. `git diff <base.sha>..<itemRef>`
   * is ruling 51's ownership check and ruling 52's reviewer brief, and a record
   * without the left-hand side describes work nobody can re-derive.
   *
   * The optionality here is the one thing in this file that is a claim about
   * this HARNESS rather than about the product: `parseRecord` below does not
   * enforce it, so a forged record can still reach a reader with the field
   * absent. Anything that dereferences it must therefore treat the value as
   * untrusted even though the type says it is there — which is true of every
   * field in this file and is only worth writing down on the required ones.
   */
  base: { ref: string; sha: string };
  /** Ruling 51: checks about the RUN — today, whether the deliverable branch exists. */
  runChecks?: RecordCheck[];
  /** Ruling 61: asserted outside every temp root by `realpath`, never lexically. */
  runRoot: string;
  /** Ruling 54: WHICH of the three filters bound the worker count, not just the number. */
  bindingFilter: string;
  workers: number;
  /** Ruling 59: how many workers tried to delegate to brigadier and were refused. */
  refusedDelegations: number;
  /** Ruling 17: stated out loud on a first run rather than assumed. */
  ambientSuppressed?: string[];
  review?: {
    crossVendor: boolean;
    /** Ruling 32: a weakened check is stated, never rendered as a pass. */
    sameVendorReason?: string;
    /** The vendor that actually reviewed, and the one that built. Ruling 29's triple, one role over. */
    reviewerAgent?: string;
    builderAgent?: string;
    caught?: number;
    planted?: number;
    /** The markers actually found, so the rate can be re-derived rather than believed. */
    caughtDefects?: string[];
    /**
     * The published rate as one line, composed where the numbers are known.
     *
     * PUBLISHED and not gated — review is probabilistic, and a flaky blocking
     * check gets disabled while a published number gets argued with.
     */
    catchRate?: string;
    /** Ruling 52: re-runs of a BROKEN reviewer, charged to brigadier and counted separately. */
    reviewerReruns?: number;
  };
  cost?: {
    currency: string;
    /** Ruling 66: a RANGE, because #44 measured 15× between two identical runs. */
    estimateLow: number;
    estimateHigh: number;
    provenance: string;
    actual?: number;
    softCeiling?: number;
    hardCeiling?: number;
    softCeilingHit?: boolean;
    hardCeilingHit?: boolean;
    /**
     * Ruling 66's structural rule, when the pair the operator gave does not
     * satisfy it.
     *
     * Present only when the gap between the two ceilings is narrower than what
     * one in-flight item can still spend, which makes the SOFT ceiling WEAKENED
     * rather than absent. It is carried in the record rather than said once on
     * stderr, because a weakening the reader of the record cannot see is ruling
     * 52's "a weakened check never renders as a clean one" one level up.
     */
    gapWarning?: string;
    /** Ruling 13: per vendor, never absent and never optimistic. */
    quota: Record<string, "read" | "unreadable" | "unpriceable">;
    /** Ruling 70: levers that were active, phrased so they cannot be read as savings. */
    levers: string[];
    lowerBound: boolean;
  };
  /** On disk in full — the host report carries the path, never the transcript. */
  transcriptsPath?: string;
  items: RecordItem[];
}

export function recordPathFrom(report: string): string | undefined {
  return RECORD_LINE.exec(report)?.[1];
}

/**
 * Parse without trusting. A record that is not an object with an `items` array
 * is not a record, and returning `undefined` here is what makes the item say so
 * rather than crash.
 */
export function parseRecord(text: string): RunRecord | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as RunRecord;
    if (!Array.isArray(record.items)) return undefined;
    if (typeof record.runId !== "string" || typeof record.integrationRef !== "string") return undefined;
    return record;
  } catch {
    return undefined;
  }
}
